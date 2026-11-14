// nexor/src/payments/payment.service.ts

import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common'
import { clipFailureReason } from './clip-failure-reason'
import { supabase } from '../lib/supabase.client'
import { CurrencyService } from '../currency/currency.service'
import { WalletService } from '../wallets/wallet.service'
import { AccountRouterService } from '../orchestrator/router/account-router.service'
import { DEFAULT_FEE_SETTINGS, calculateSaleFees, getEffectiveSellerFees, saleFeePct } from '../shared/fee.calculator'
import { sellerMayOperate } from '../orchestrator/whop/whop-linked.service'
import { ownAccountCommissionPct, resolveOwnSale } from '../orchestrator/seller-provider/seller-provider-accounts.service'
import {
    OwnProvider,
    isOwnProviderAccountId,
    isPaypalOwnAccountId,
    isStripeOwnAccountId,
    paypalCaptureMismatch,
} from '../orchestrator/seller-provider/seller-provider-accounts'
import { applyAccountMethods, parseLinkProviders, slotOfMethod } from '../orchestrator/routing/seller-routing'
import { PoolEntry, SellerRoutingService, RoutingSalePick, normalizeRoutingKey } from '../orchestrator/routing/seller-routing.service'
import { ownAccountCommissionUsdCents, ownAccountFeeLines } from '../orchestrator/routing/seller-routing'
import { PaypalProvider } from '../orchestrator/providers/paypal.provider'
import { validateMbwayPhone } from '../utils/mbway.validator'
import { RetrieveResponse } from '../orchestrator/providers/provider.types'
import { CardCryptoService } from '../crypto/card-crypto.service'
import { WebhookService } from '../webhooks/webhook.service'
import { ClipAccountsService } from '../orchestrator/clip/clip-accounts.service'
import { ClipProvider } from '../orchestrator/providers/clip.provider'
import { SpeiReceiptService } from '../orchestrator/clip/spei-receipt.service'
import { AffiliateCommissionService } from '../affiliates/affiliate-commission.service'
import { StorageService } from '../lib/storage.service'
import { WhopProvider, type WhopMembershipState } from '../orchestrator/providers/whop.provider'
import { customerSubscriptionView, isSubscriptionTransaction } from './customer-subscription'
import { SLASH_CURRENCIES } from '../orchestrator/providers/slash.provider'
import { MethodRoutingService } from '../orchestrator/method-routing/method-routing.service'
import { DIRECT_PROVIDERS } from '../orchestrator/method-routing/method-routing'
import { ErroKontino, KONTINO_METODOS, criarCobranca, ehMetodoKontino, kontinoConfigurado, respostaAoCheckout, toKontinoOwnAccountId, type MetodoKontino } from '../orchestrator/kontino/kontino'
import { kontinoPelaContaDoSeller } from '../orchestrator/kontino/kontino-seller'

export interface ExternalFeeInput {
    recipient_id: string
    pct?: number
    amount_cents?: number
    metadata?: any
}

// ─── Wallet refs das plataformas ──────────────────────────────────────────────
//
// WHITE  → Koopfy recebe o platform_fee
// GRAY / HIGH → Nexor recebe o platform_fee

const KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF
    ?? (() => { throw new Error('KOOPFY_PLATFORM_WALLET_REF env var is required') })()

// 🐞 Detalhe de erro no corpo da resposta só em dev/local (ou PAY_DEBUG=1).
const PAY_DEBUG =
    process.env.NODE_ENV !== 'production' || process.env.PAY_DEBUG === '1'

// Rox Pay só aceita liquidar nestas moedas — fora daqui nem chega a chamar a API.
const ROX_PAY_ALLOWED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'RON', 'JPY'])

// ─── Settlement payload pro Nexflow ──────────────────────────────────────────

interface SettlementRecipient {
    wallet_reference: string
    role: 'seller' | 'platform' | 'external_partner' | 'affiliate'
    amount_cents: number
    fee_type?: 'platform_fee' | 'external_fee'
    fee_pct?: number
}

interface SettlementPayload {
    strategy: 'amount'
    total_net_cents: number
    exchange: {
        fx_rate: number
        fx_fee_cents: number
        amount_usd_gross_cents: number
        amount_usd_net_cents: number
    }
    recipients: SettlementRecipient[]
}

// Minutos que uma reserva de CARTÃO sobrevive sem virar cobrança.
const CARD_HOLD_TTL_MIN = Number(process.env.CLIP_CARD_HOLD_TTL_MIN ?? 25)

// Resumo do erro do provider guardado na transação: código, tipo, mensagem e o
// que foi enviado — nunca o corpo inteiro, que pode trazer dado do comprador.
function summarizeProviderError(data: unknown): Record<string, unknown> | null {
    if (!data || typeof data !== 'object') return null
    const raw = data as Record<string, any>
    const error = (raw.whop_error ?? raw.error ?? raw) as Record<string, any>
    const text = (value: unknown) =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined
    const summary: Record<string, unknown> = {
        at: new Date().toISOString(),
        code: text(error?.code) ?? text(raw.decline_code),
        type: text(error?.type),
        param: text(error?.param),
        message: text(error?.message) ?? text(raw.failure_message),
        httpStatus: typeof raw.http_status === 'number' ? raw.http_status : undefined,
        request: raw.request && typeof raw.request === 'object' ? raw.request : undefined,
    }
    for (const key of Object.keys(summary)) {
        if (summary[key] === undefined) delete summary[key]
    }
    return Object.keys(summary).length > 1 ? summary : null
}

// Conta Stripe do seller sem leitura dos métodos (chave restrita): do cadastro
// só passa o que a Stripe cobra no checkout embedado.
const STRIPE_FALLBACK_METHODS = new Set(['credit_card', 'debit_card', 'card', 'apple_pay', 'google_pay'])

@Injectable()
export class PaymentService {

    constructor(
        private readonly currencyService: CurrencyService,
        private readonly walletService: WalletService,
        private readonly accountRouter: AccountRouterService,
        private readonly cardCrypto: CardCryptoService,
        // Reuso do pipeline de PAID p/ aprovação síncrona do provider 'simulator'.
        private readonly webhookService: WebhookService,
        private readonly clipAccounts: ClipAccountsService,
        private readonly storage: StorageService,
        private readonly speiReceipts: SpeiReceiptService,
        private readonly affiliateCommissions: AffiliateCommissionService,
        // Roteamento de contas próprias (várias Whop/Stripe/PayPal por seller).
        // Opcional só para os testes que montam o serviço à mão; sem ele (ou
        // com o roteamento desligado) a venda segue exatamente como antes.
        @Optional() private readonly sellerRouting?: SellerRoutingService,
        // Provedor por método (CRM › Roteamento por método). Opcional pelo mesmo
        // motivo: sem ele, vale o provider_default do seller.
        @Optional() private readonly methodRouting?: MethodRoutingService,
    ) { }

    private static readonly REDIRECT_PROVIDERS = new Set(['viva'])

    // Checkout embedado: o comprador ainda NÃO inseriu dados de pagamento quando
    // respondemos — só abrimos o iframe. O checkout usa esse sinal pra adiar a
    // criação do pedido até haver engajamento real (ver processSplitAwarePayment).
    // Slash entra aqui pelo mesmo motivo: o intent é criado quando o comprador
    // chega ao pagamento, antes de ele digitar o cartão.
    private static readonly HOSTED_AWAITING_PROVIDERS = new Set(['rox_pay', 'whop', 'slash'])

    // ─── createPayment ────────────────────────────────────────────────────────

    async createPayment(dto: any) {
        let session: any = null

        // 🐞 DEBUG TEMPORÁRIO — timing (remover depois).
        const __t0 = Date.now()
        const __mark = (label: string) => console.log(`[timing] ${label}: ${Date.now() - __t0}ms`)
        __mark('createPayment início')

        dto.method = dto.method === 'credit_card' ? 'card' : dto.method;

        // 🔐 Resolve o instrumento: decifra o envelope do cartão OU mapeia o token
        //    da carteira → dto.payment_data (consumido pelo provider Sentinel).
        this.resolvePaymentInstrument(dto)
        __mark('resolvePaymentInstrument')

        const seller = await this.getSellerById(dto.sellerId)
        __mark('getSellerById')

        if (!seller) throw new BadRequestException('Seller not found')
        const effectiveSellerId = seller.id

        // ─── Guards ────────────────────────────────────────────────────────────

        // Sem aprovação da Koopfy, só cobra quem está no modo conta externa com a
        // conta Whop dele conectada — ver sellerMayOperate.
        if (!(await sellerMayOperate(seller))) {
            const messages: Record<string, string> = {
                pending_review: 'Sua conta está em análise. Aguarde a aprovação da equipe.',
                suspended: 'Sua conta está suspensa. Entre em contato com o suporte.',
                rejected: 'Sua conta foi rejeitada. Entre em contato com o suporte.',
            }
            throw new ForbiddenException(messages[seller.status] ?? 'Conta não autorizada.')
        }

        // Vertical da oferta (ECOMMERCE | INFO | NUTRA). Decide QUAL titular
        // recebe o pagamento — ver LAYER 1c no AccountRouterService. Sem isto,
        // nutra cai na mesma conta do e-commerce e contamina o histórico dela.
        let offerSegment: string | null = null

        if (dto.offerId) {
            const { data: offer } = await supabase
                .from('offers').select('id, status, name, segment')
                .eq('id', dto.offerId).eq('seller_id', effectiveSellerId).maybeSingle()
            if (!offer) throw new BadRequestException('Oferta não encontrada.')
            offerSegment = offer.segment ?? null
            if (offer.status !== 'approved') {
                const msgs: Record<string, string> = {
                    pending_review: `A oferta "${offer.name}" ainda está em análise.`,
                    rejected: `A oferta "${offer.name}" foi rejeitada.`,
                    suspended: `A oferta "${offer.name}" está suspensa.`,
                }
                throw new ForbiddenException(msgs[offer.status] ?? `Oferta "${offer.name}" não aprovada.`)
            }
        }
        __mark('offer check')

        // ─── Upsell de um clique (Whop) ────────────────────────────────────────
        // Cobra o meio de pagamento salvo na compra-mãe, na MESMA conta Whop: o
        // cartão salvo pertence ao membro daquela company e não é cobrável por
        // outra. Validado aqui, no servidor — o checkout só informa o id.
        const upsellParent = dto.upsell?.parentTransactionId
            ? await this.requireUpsellParent(effectiveSellerId, String(dto.upsell.parentTransactionId))
            : null

        if (dto.method === 'mbway') {
            // No fluxo hosted (Sentinel) o telefone é confirmado na própria página
            // do MB Way — só validamos quando o checkout já enviou um número.
            const phone = dto.paymentData?.phone ?? dto.payment_data?.phone ?? null
            if (phone) {
                const mbway = validateMbwayPhone(phone)
                if (!mbway.valid) throw new BadRequestException(mbway.reason ?? 'Número de telefone inválido para MB Way.')
                if (!dto.paymentData) dto.paymentData = {}
                dto.paymentData.phone = mbway.normalized
            }
        }

        // ─── FX ────────────────────────────────────────────────────────────────

        const amount = Math.round(Number(dto.amount))
        dto.amount = amount;
        // ⚠️ `session` é sempre null aqui — o fallback `session.currency` antigo
        // estourava NullPointer p/ qualquer request sem dto.currency. O checkout
        // sempre manda currency; guardamos contra ausência com erro claro.
        const currency = dto.currency
        if (!currency) throw new BadRequestException('currency is required')

        // ─── Provedor por método (payment_method_routes) ─────────────────────────
        // A plataforma decide quem cobra cada método (ex.: Pix/SPEI → Kontino,
        // cartão → Kaja). Com regra, a cabeça da cadeia substitui o antigo
        // seller.provider_default em TODA decisão abaixo; sem regra, nada muda.
        // Upsell segue a compra-mãe (conta já decidida).
        const methodRoute = !upsellParent && this.methodRouting
            ? await this.methodRouting.resolve({
                method: dto.method,
                country: dto.billing_address?.country ?? dto.customer?.country ?? (dto.method === 'mbway' ? 'PT' : null),
                currency: String(currency),
                sellerId: effectiveSellerId,
            }).catch((err: any) => {
                console.error('[PaymentService] roteamento por método indisponível, seguindo sem regra:', err?.message)
                return null
            })
            : null
        const routedByMethod = Boolean(methodRoute?.ruleId)
        if (routedByMethod && methodRoute!.chain.length === 0) {
            console.error(
                `[PaymentService] 🚨 ${dto.method}: nenhum provedor disponível na regra ${methodRoute!.ruleId} — `
                + methodRoute!.skipped.map(sk => `${sk.provider} (${sk.reason})`).join(', '),
            )
            throw new BadRequestException({
                code: 'METHOD_UNAVAILABLE',
                message: 'Este método de pagamento está indisponível no momento. Selecione outro.',
            })
        }
        let effectiveProvider = routedByMethod
            ? methodRoute!.chain[0] as string
            : this.normalizeProviderName(seller?.provider_default)

        // ─── Conta Kontino ativa do próprio seller ────────────────────────────
        // Sem regra da plataforma para o método, Pix (BRL) e SPEI (MXN) saem pela
        // conta Kontino do seller assim que ela está aprovada; o provedor de antes
        // vira a reserva (falha técnica ou valor fora da faixa da Kontino). Regra
        // explícita em payment_method_routes continua mandando.
        let kontinoReserva: string | null = null
        const pelaContaKontino = kontinoPelaContaDoSeller({
            routedByMethod,
            upsell: Boolean(upsellParent),
            contaKontino: seller?.config?.kontino_account_id,
            configurado: kontinoConfigurado(),
            metodo: dto.method,
            moeda: String(currency),
            metodosDoSeller: seller?.enabled_methods,
            provedorAtual: effectiveProvider,
        })
        if (pelaContaKontino) {
            kontinoReserva = pelaContaKontino.reserva
            effectiveProvider = 'kontino'
        }

        // Coinflow opera em USD/cripto — não processa BRL. Barra AQUI (antes do FX,
        // do insert da transação e da chamada ao provider) p/ não gerar pagamento
        // em BRL no provider e devolver uma mensagem clara ao cliente.
        if (effectiveProvider === 'coinflow'
            && String(currency).toUpperCase() === 'BRL') {
            throw new BadRequestException({
                code: 'CURRENCY_NOT_SUPPORTED',
                message: 'Não aceitamos transações em BRL para este método de pagamento. Selecione outra moeda.',
            })
        }

        // Rox Pay: trava de moeda ANTES do FX/transação/chamada ao provider —
        // fora da allowlist nem gera requisição.
        if (effectiveProvider === 'rox_pay'
            && !ROX_PAY_ALLOWED_CURRENCIES.has(String(currency).toUpperCase())) {
            throw new BadRequestException({
                code: 'CURRENCY_NOT_SUPPORTED',
                message: 'Não aceitamos transações nesta moeda para este método de pagamento. Selecione outra moeda.',
            })
        }

        // Slash: a API só aceita USD e EUR.
        if (effectiveProvider === 'slash'
            && !SLASH_CURRENCIES.has(String(currency).toUpperCase())) {
            throw new BadRequestException({
                code: 'CURRENCY_NOT_SUPPORTED',
                message: 'Não aceitamos transações nesta moeda para este método de pagamento. Selecione outra moeda.',
            })
        }
        // Slash: o instrumento (cartão, Apple Pay, Google Pay) é escolhido
        // dentro do formulário deles. O método que vem do checkout é o que
        // estava selecionado na tela (pode ser Pix, se o seller tiver marcado) —
        // e um método que a conta Slash não atende tiraria a conta do roteamento.
        if (effectiveProvider === 'slash') dto.method = 'card'

        // Slash só faz cobrança avulsa: sem cartão salvo, a assinatura morreria
        // no primeiro ciclo depois de o comprador pagar a entrada.
        if (effectiveProvider === 'slash'
            && isSubscriptionTransaction(dto.metadata)) {
            throw new BadRequestException({
                code: 'SUBSCRIPTION_NOT_SUPPORTED',
                message: 'Assinaturas não estão disponíveis neste meio de pagamento.',
            })
        }

        const fx = await this.currencyService.convertToUSD(amount / 100, currency)
        __mark('convertToUSD')
        // Taxas do seller (seller_fees, padrão em fee.calculator): todas sobre o
        // bruto em USD; a de conversão só quando a venda não é em USD.
        // Conta PRÓPRIA do seller (Whop, Stripe ou PayPal dele): o dinheiro nem
        // passa pela Koopfy, então não há taxa de plataforma nem reserva a
        // cobrar aqui. A comissão da Koopfy (commission_pct do CRM, ou 3%) vai
        // para o checkout como débito em dólar, cobrado no cartão do seller
        // (ver ownAccount abaixo).
        //
        // Upsell de um clique cobra na conta da compra-mãe: quem decide é ela,
        // não a conexão de hoje (o seller pode ter trocado Whop por Stripe).
        //
        // Roteamento de contas ligado: a conta sai da sessão do comprador
        // (metadata.routing_key = id da checkout session), escolhida no
        // /payments/config — ver SellerRoutingService.resolveForSale. Conta
        // da sessão que deixou de ser elegível responde 409 ROUTING_REASSIGNED
        // ANTES de criar a transação (o checkout recarrega as formas de
        // pagamento). Desligado: null, e segue o caminho de sempre.
        const buyerCountry = dto.billing_address?.country ?? dto.customer?.country
            ?? (dto.method === 'mbway' ? 'PT' : null)
        const routingSale: RoutingSalePick | null = !upsellParent && this.sellerRouting
            ? await this.sellerRouting.resolveForSale(effectiveSellerId, {
                method: dto.method,
                routingKey: normalizeRoutingKey(dto.metadata?.routing_key ?? dto.routing_key),
                ctx: {
                    country: buyerCountry,
                    currency: String(currency).toUpperCase(),
                    amountUsdCents: Math.round(fx.grossUSD * 100),
                },
                orderRef: dto.metadata?.order_number ?? dto.metadata?.orderId ?? null,
                providerAccountId: dto.providerAccountId ?? null,
                idempotencyKey: dto.idempotencyKey ?? null,
                // Já lido com o seller: a escolha por slot não relê o cadastro.
                sellerMethods: Array.isArray(seller?.enabled_methods) ? seller.enabled_methods : null,
            })
            : null
        const routedOwn = routingSale?.kind === 'account' ? routingSale : null
        const ownSale: { provider: OwnProvider; commissionPct: number } | null = upsellParent
            ? (isOwnProviderAccountId(upsellParent.provider_account_id)
                ? {
                    provider: ownProviderOfAccountId(upsellParent.provider_account_id),
                    commissionPct: await ownAccountCommissionPct(effectiveSellerId),
                }
                : null)
            : routedOwn
                ? { provider: routedOwn.provider, commissionPct: await ownAccountCommissionPct(effectiveSellerId) }
                : await resolveOwnSale({
                    sellerId: effectiveSellerId,
                    providerDefault: effectiveProvider,
                    method: dto.method,
                })
        const ownAccountPct = ownSale?.commissionPct ?? null
        const onOwnAccount = ownSale !== null
        // Taxa de roteamento (% sobre o bruto em USD) somada à comissão quando
        // o roteamento está ligado; 0 desligado. Upsell herda a regra de hoje.
        const routingFeePct = !ownSale ? 0
            : routedOwn ? routedOwn.feePct
                : upsellParent && this.sellerRouting ? await this.sellerRouting.feeForSale(effectiveSellerId)
                    : 0

        // Sem aprovação da Koopfy, só vende o que sai pela conta dele. Seller
        // em análise com só o PayPal próprio conectado passa no sellerMayOperate,
        // mas o cartão dele iria para o pool da Koopfy — isso não.
        if (seller.status !== 'active' && !onOwnAccount) {
            throw new ForbiddenException('Sua conta está em análise. Aguarde a aprovação da equipe.')
        }
        const sellerFees = onOwnAccount
            ? {
                ...DEFAULT_FEE_SETTINGS,
                fxFeePct: 0,
                checkoutFeePct: 0,
                processingFeePct: 0,
                orchestrationFeePct: 0,
                feeFixedUsd: 0,
                reservePercentage: 0,
            }
            : await getEffectiveSellerFees(effectiveSellerId)
        const currencyConverted = String(currency).toUpperCase() !== 'USD'
        const saleFees = calculateSaleFees(Math.round(fx.grossUSD * 100), sellerFees, { currencyConverted })
        __mark('calculateSaleFees')
        const grossUSDcents = saleFees.grossCents
        // Venda na conta do seller: o checkout acumula esta comissão (USD) em
        // billing_debits. Vai gravada na transação para retentativas e renovações.
        // Com o roteamento: comissão = bruto × (commission_pct + routing_fee_pct).
        const ownAccount = ownSale
            ? {
                provider: ownSale.provider,
                commission_pct: ownAccountPct,
                routing_fee_pct: routingFeePct,
                commission_usd_cents: ownAccountCommissionUsdCents(grossUSDcents, ownAccountPct as number, routingFeePct),
                // Uma linha por taxa (checkout e roteamento), para o extrato.
                ...ownAccountFeeLines(grossUSDcents, ownAccountPct as number, routingFeePct),
            }
            : null
        const fxFeeUSDcents = saleFees.fxFeeCents
        const netUSDcents = grossUSDcents - fxFeeUSDcents
        const fxFinalRate = currencyConverted ? fx.fxMarketRate * (1 - sellerFees.fxFeePct / 100) : 1

        // ─── External fee ──────────────────────────────────────────────────────

        const externalFee = await this.resolveExternalFee(dto.external_fee, netUSDcents, effectiveSellerId)
        __mark('resolveExternalFee')

        // ─── Idempotência ──────────────────────────────────────────────────────

        let transaction: any = null
        if (dto.idempotencyKey) {
            const { data: existing } = await supabase
                .from('transactions').select('*')
                .eq('seller_id', effectiveSellerId)
                .eq('idempotency_key', dto.idempotencyKey).maybeSingle()
            __mark('idempotency check')
            if (existing) {
                // Conta própria em fluxo client (Stripe/PayPal do seller): o
                // intent/order já existe e o que o navegador precisa ficou
                // gravado (metadata.client_flow). Devolver evita criar outro.
                if (existing.status === 'pending' && existing.provider_transaction_id && existing.metadata?.client_flow) {
                    return this.formatResponse(existing)
                }
                // ⚠️ Providers de EMBED (Whop) não podem sair por estes atalhos.
                //
                // formatResponse devolve a linha do banco, e o par planId/sessionId
                // NÃO é persistido em transactions — só existe na resposta do
                // provider. Retornar aqui entregaria uma resposta sem `embed`, e o
                // loader.js não teria o que montar: o comprador veria o skeleton
                // pra sempre, sem erro em lugar nenhum.
                //
                // Hoje a condição do meio nem dispara (provider_gateway_id nunca é
                // gravado no pay), mas o dia em que passar a ser, o sintoma seria
                // exatamente esse — silencioso e difícil de rastrear.
                const isEmbedProvider = effectiveProvider === 'whop'

                if (!isEmbedProvider) {
                    if (existing.status === 'approved') return this.formatResponse(existing)
                    if (existing.status === 'pending' && existing.provider_gateway_id) return this.formatResponse(existing)
                    // `stripe_attempts_blocked`: trava de recusas da Stripe (decline-guard.ts).
                    if (existing.status === 'failed' && (existing.retry_blocked || existing.metadata?.stripe_attempts_blocked)) return this.formatResponse(existing)
                } else if (existing.status === 'approved') {
                    // Já pago: aí sim devolve — não há embed a montar, e recriar a
                    // sessão cobraria de novo.
                    return this.formatResponse(existing)
                }
                transaction = existing

                // Slash: o checkout cria o intent quando o comprador chega ao
                // pagamento e refaz a chamada quando o total ou os dados mudam
                // (frete, cupom, nome corrigido). A chave de idempotência é a do
                // pedido, então a transação é a mesma — e precisa refletir o
                // valor que o intent novo vai cobrar. Sem isto a transação ficava
                // com o valor da primeira chamada e o crédito do seller sairia
                // errado.
                if (effectiveProvider === 'slash'
                    && ['pending', 'requires_action'].includes(existing.status)) {
                    const { data: refreshed, error: refreshError } = await supabase
                        .from('transactions')
                        .update({
                            amount, currency,
                            amount_usd_net_cents: netUSDcents,
                            amount_usd_gross_cents: grossUSDcents,
                            fx_fee_cents: fxFeeUSDcents,
                            fx_rate: fxFinalRate,
                            customer_name: dto.customer?.name ?? existing.customer_name,
                            customer_email: dto.customer?.email ?? existing.customer_email,
                            customer_phone: dto.customer?.phone || existing.customer_phone,
                            customer_country: dto.billing_address?.country ?? dto.customer?.country ?? existing.customer_country,
                            metadata: dto.metadata ?? existing.metadata ?? {},
                        })
                        .eq('id', existing.id)
                        .in('status', ['pending', 'requires_action'])
                        .select().maybeSingle()
                    if (refreshError) console.error('[PaymentService] Slash: transação não atualizada:', refreshError.message)
                    if (refreshed) transaction = refreshed
                }
            }
        }

        // ─── Cria transação ────────────────────────────────────────────────────

        if (!transaction) {
            const { data: created, error } = await supabase
                .from('transactions')
                .insert({
                    seller_id: effectiveSellerId,
                    offer_id: dto.offerId ?? null,
                    amount, currency,
                    method: dto?.method || 'smart',
                    amount_usd_net_cents: netUSDcents,
                    amount_usd_gross_cents: grossUSDcents,
                    fx_fee_cents: fxFeeUSDcents,
                    fx_rate: fxFinalRate,
                    status: 'pending',
                    provider_status: null,
                    customer_name: dto.customer?.name,
                    customer_email: dto.customer?.email,
                    customer_phone: dto.customer?.phone || 'N/A',
                    customer_document: dto.customer?.document || 'N/A',
                    // MB Way é método português: se o país não veio no request,
                    // assume PT (senão a dash mostra o país como cadeado/vazio).
                    customer_country: dto.billing_address?.country ?? dto.customer?.country
                        ?? (dto.method === 'mbway' ? 'PT' : null),
                    payment_last4: dto.payment_data?.cardNumber?.slice(-4),
                    payment_brand: dto.payment_data?.cardBrand,
                    ip: dto.context?.ip,
                    user_agent: dto.context?.userAgent,
                    device_id: dto.context?.deviceId,
                    session_id: dto.context?.sessionId ?? dto.sessionId ?? null,
                    idempotency_key: dto.idempotencyKey,
                    // order_number (humano) — usado como order_id na Sentinel e p/ o
                    // webhook casar a transação por external_reference.
                    external_reference: dto.metadata?.order_number ?? dto.metadata?.orderId ?? null,
                    // Mantém o contexto comercial para relatórios de produto,
                    // plano e recorrência sem criar um produto espelho no provider.
                    metadata: ownAccount ? { ...(dto.metadata ?? {}), own_account: ownAccount } : (dto.metadata ?? {}),
                    postback_url: dto.postback_url,
                    risk_level: seller.risk_level,
                    webhook_sent: false,
                    webhook_status: 'pending',
                    webhook_attempts: 0,
                    created_at: new Date().toISOString(),
                    // 🔥 Registra qual plataforma recebeu o split
                    external_fee_cents: externalFee?.amount_cents ?? null,
                    external_fee_pct: externalFee?.pct ?? null,
                    external_fee_recipient_id: externalFee?.recipient_id ?? null,
                })
                .select().single()

            if (error || !created) {
                console.error('[PaymentService] Transaction creation error:', error)
                throw new BadRequestException('Transaction creation failed')
            }
            transaction = created
        }
        __mark('transaction insert')

        // ── Kontino Connect: SPEI e Pix com confirmação automática ─────────────
        // Cada cobrança tem a própria CLABE (ou código Pix) e o Kontino avisa o
        // pagamento por webhook assinado (/webhook/kontino): sem comprovante.
        if (effectiveProvider === 'kontino' && ehMetodoKontino(dto.method)) {
            // Reserva da regra (ex.: SPEI → Clip, Pix → Approvebly): falha técnica
            // do Kontino passa para ela em vez de recusar o comprador.
            const nextProvider = routedByMethod ? (methodRoute!.chain[1] ?? null) : kontinoReserva
            const contaKontino = String(seller.config?.kontino_account_id ?? '').trim()
            // Sem conta Kontino do seller o Kontino não entra: cobrar em nome dele
            // na conta da Koopfy é "nesting" (recusado pela BlindPay).
            const kontino = contaKontino
                ? await this.cobrarPeloKontino(seller, dto, transaction, amount, String(currency), {
                    fallbackTo: nextProvider, contaKontino, comissaoUsdCents: saleFees.platformFeeCents,
                    // Ligada pela conta do seller (sem regra): valor fora da faixa da
                    // Kontino volta para o provedor de antes em vez de recusar.
                    fallbackOnRange: !routedByMethod,
                })
                : null
            if (kontino) return kontino
            if (!contaKontino && !nextProvider) {
                throw new BadRequestException('Pagamento indisponível no momento. Selecione outro método.')
            }
            console.error(`[PaymentService] ⚠️ FAILOVER por método: kontino → ${nextProvider} (tx=${transaction.id}${contaKontino ? '' : ', seller sem conta Kontino'})`)
            effectiveProvider = nextProvider as string
        }

        // ── Clip SPEI: cria a transação e reserva a CLABE no mesmo clique ──
        // Não passa por ClipProvider: SPEI é transferência manual. A resposta
        // abre o modal de instruções e a transação permanece pending até o
        // comprovante ser analisado.
        if (effectiveProvider === 'clip' && dto.method === 'spei') {
            if (String(currency).toUpperCase() !== 'MXN') {
                throw new BadRequestException('SPEI está disponível apenas em MXN.')
            }
            const riskLevel = String(seller.risk_level ?? '').toUpperCase()
            if (riskLevel !== 'WHITE' && riskLevel !== 'GRAY') {
                throw new ForbiddenException('Nível de risco inválido para SPEI.')
            }
            const enabled = new Set((seller.enabled_methods ?? []).map((m: any) => String(m).toLowerCase()))
            if (!enabled.has('spei')) throw new ForbiddenException('SPEI não está habilitado para este seller.')

            const hold = await this.clipAccounts.holdSpei({
                amountMinor: amount,
                sellerId: effectiveSellerId,
                country: String(seller.country ?? 'MX').toUpperCase(),
                riskLevel: riskLevel as 'WHITE' | 'GRAY',
                externalReference: transaction.id,
            })
            if (!hold) {
                // Zero linhas tem seis causas e todas chegavam como a mesma
                // frase. Pergunta o MOTIVO antes de falhar — só neste caminho,
                // sem custo no fluxo normal.
                const motivo = await this.clipAccounts.diagnosticarSpei({
                    amountMinor: amount,
                    country: String(seller.country ?? 'MX').toUpperCase(),
                    riskLevel,
                    currency: String(currency).toUpperCase(),
                }).catch(() => 'diagnóstico indisponível')

                console.error(
                    `[PaymentService] SPEI sem conta elegível — seller=${effectiveSellerId} `
                    + `valor=${amount} país=${seller.country ?? 'MX'} risco=${riskLevel} :: ${motivo}`,
                )

                await supabase.from('transactions').update({
                    status: 'failed', failure_code: 'SPEI_CAPACITY_EXHAUSTED',
                    // Grava o motivo NA TRANSAÇÃO: sem isso, investigar depois
                    // exige achar a linha certa no log do servidor.
                    failure_message: `Nenhuma conta SPEI elegível. ${motivo}`.slice(0, 500),
                    failed_at: new Date().toISOString(),
                }).eq('id', transaction.id)

                throw new BadRequestException('Pagamento por SPEI indisponível no momento.')
            }

            // Uma consulta a mais no caminho do SPEI, para ter o prazo autoritativo.
            const reserva = await this.clipAccounts.getReservation(hold.reservation_id)

            const { data: speiTransaction, error: speiUpdateError } = await supabase
              .from('transactions').update({
                status: 'pending',
                provider: 'clip',
                provider_account_id: hold.account_id,
                provider_status: 'awaiting_proof',
                failure_code: null,
                failure_message: null,
                failed_at: null,
                // Este caminho retorna antes do update que grava as taxas das
                // outras vendas. Sem elas a aprovação do comprovante parava no
                // crédito da carteira (valor nulo) e o checkout nunca era
                // avisado: pedido aprovado no pay e pendente na loja.
                fee: saleFees.platformFeeCents,
                chargeback_protection_fee: 0,
                net_amount: Math.max(0, saleFees.netCents - (externalFee?.amount_cents ?? 0)),
                reserve_amount: saleFees.reserveCents,
                available_at: saleFees.availableAt.toISOString(),
                reserve_until: saleFees.reserveUntil.toISOString(),
                metadata: {
                    ...(transaction.metadata ?? {}),
                    spei_reservation_id: hold.reservation_id,
                    spei_charge_minor: hold.charge_minor,
                    spei_proof_status: 'not_uploaded',
                },
              })
              .eq('id', transaction.id)
              .select('id, status, provider_status, failure_code')
              .single()

            if (speiUpdateError || !speiTransaction) {
                console.error('[PaymentService] falha ao restaurar transação SPEI:', {
                    transactionId: transaction.id,
                    error: speiUpdateError?.message,
                })
                throw new Error('Não foi possível atualizar o status da transação SPEI.')
            }
            supabase.from('transactions').update({ fee_breakdown: saleFees.breakdown }).eq('id', transaction.id)
                .then(({ error }) => { if (error) console.error('[PaymentService] fee_breakdown (spei):', error.message) })

            if (speiTransaction.status !== 'pending' || speiTransaction.failure_code) {
                console.error('[PaymentService] transação SPEI permaneceu inconsistente:', speiTransaction)
                throw new Error('Status da transação SPEI permaneceu inconsistente.')
            }

            return {
                success: true,
                status: 'pending',
                transactionId: transaction.id,
                provider: 'clip',
                spei: {
                    reservationId: hold.reservation_id,
                    clabe: hold.clabe,
                    banco: hold.banco,
                    beneficiario: hold.beneficiario,
                    chargeMinor: hold.charge_minor,
                    // Prazo REAL da reserva, lido do banco em vez de recalculado
                    // a partir do TTL: duplicar a constante aqui faria a tela
                    // prometer um prazo que o banco não honra no dia em que uma
                    // das duas mudasse. O comprador precisa saber que a conta
                    // está apartada e até quando — e essa informação é
                    // verdadeira, não urgência fabricada.
                    expiresAt: reserva?.expires_at ?? null,
                },
            }
        }

        // ─── Provider (fixo por seller.provider_default) ────────────────────────
        // Resolvido ANTES das taxas porque o cross-border depende do país da conta.
        // `let` porque o failover pode trocar o PSP — e o que vem depois
        // (taxas, credenciais por seller, resposta ao front) tem que enxergar o
        // provider REALMENTE usado, não o preferido. Calcular a taxa da Coinflow
        // num pagamento que saiu pela Stripe é o tipo de erro que só aparece na
        // conciliação do fim do mês.
        let providerName = effectiveProvider
        const preferredProvider = providerName
        const customerCountry = buyerCountry

        // Cadeia de failover cross-PSP. Antes disto, pool preferido vazio =
        // pagamento morto; agora ele cai para o próximo PSP da cadeia do método
        // (ver failover.config.ts). A stickiness por pedido vem ANTES da cadeia:
        // pedido já iniciado num titular volta para ele, sempre.
        // Upsell não passa pelo router: a conta é a da compra-mãe (ver acima).
        // Venda de conta própria vai direto para ela — sem failover nem sticky
        // (ver resolveOwnRoute): no pool da Koopfy sairia sem taxa.
        // Roteamento de contas: a conta já foi escolhida acima (sessão).
        const routed = upsellParent ? null : routedOwn ? {
            account: routedOwn.entry.account as any,
            provider: routedOwn.provider as string,
            degraded: false,
            attempted: [routedOwn.provider as string],
        } : ownSale ? await this.accountRouter.resolveOwnRoute(
            effectiveSellerId,
            ownSale.provider,
        ) : await this.accountRouter.resolveWithFailover({
            sellerId: effectiveSellerId,
            preferredProvider: providerName,
            // Com regra por método, a cadeia é a da regra (a partir do provedor
            // efetivo, sem os que cobram direto, como o Kontino); sem regra, a
            // cadeia fixa de failover.config.ts.
            chain: routedByMethod
                ? methodRoute!.chain
                    .slice(Math.max(0, methodRoute!.chain.indexOf(effectiveProvider as any)))
                    .filter(p => !DIRECT_PROVIDERS.has(p))
                : undefined,
            method: dto.method,
            customerCountry: customerCountry ?? undefined,
            // Isolamento entre titulares: a oferta define a vertical, o seller
            // define o nível de risco. Conta que declara `segments` só recebe o
            // que declarou.
            segment: offerSegment,
            riskLevel: seller.risk_level ?? null,
            // Ticket em USD cents — mesma unidade dos tetos min/max_ticket e do
            // account_daily_metrics.volume. Mandar `amount` (moeda da transação)
            // aqui compararia real com dólar sem erro nenhum aparecer.
            amountUsdCents: netUSDcents,
            // Stickiness: toda tentativa do MESMO pedido cai na MESMA conta.
            // Crítico com titulares independentes (Whop, Stripe): reembolso
            // partido entre duas contas não tem solução — o saldo está em
            // entidades jurídicas diferentes.
            orderRef: transaction.external_reference ?? null,
        })
        __mark('resolveWithFailover')

        let account = routed?.account ?? null

        // ── Clip: a conta vem da RESERVA, não do router e não do cliente ────
        //
        // ⚠️ ESTE BLOCO É O QUE FAZ O TETO EXISTIR.
        // O token da Clip nasce preso à public key com que o iframe foi montado
        // e só é cobrável pelo secret da MESMA conta — então a conta já foi
        // decidida (e o teto já foi debitado) lá no /payments/clip/route.
        //
        // Lemos a conta da RESERVA no banco, nunca do `accountId` que o browser
        // mandou. Confiar no cliente aqui deixaria o próprio comprador escolher
        // em qual conta cobrar, e um teto que o cobrado escolhe não é teto.
        let clipReservation: any = null
        const clipResId = dto.payment_data?.clipReservationId
        if (clipResId) {
            clipReservation = await this.clipAccounts.getReservation(clipResId)

            if (!clipReservation) {
                throw new BadRequestException('Reserva de pagamento inválida. Recarregue o checkout.')
            }
            if (clipReservation.seller_id !== effectiveSellerId) {
                throw new ForbiddenException('Esta reserva não pertence ao seller autenticado.')
            }
            if (clipReservation.method !== 'card' || dto.method !== 'card') {
                throw new BadRequestException('Método da reserva não corresponde ao pagamento.')
            }
            if (Number(clipReservation.amount_minor) !== Number(dto.amount)) {
                throw new BadRequestException('Valor da reserva não corresponde ao pagamento. Recarregue o checkout.')
            }
            if (String(clipReservation.currency).toUpperCase() !== String(dto.currency).toUpperCase()) {
                throw new BadRequestException('Moeda da reserva não corresponde ao pagamento.')
            }
            if (String(clipReservation.risk_level).toUpperCase() !== String(seller.risk_level).toUpperCase()) {
                throw new ForbiddenException('Nível de risco da reserva não corresponde ao seller.')
            }
            // Reserva vencida/liberada = o espaço já voltou para o pool. Cobrar
            // agora passaria por cima do teto sem nada registrado.
            if (clipReservation.state !== 'held' || Date.parse(clipReservation.expires_at) <= Date.now()) {
                throw new BadRequestException('Reserva de pagamento expirada. Recarregue o checkout.')
            }
            const reserved = await this.accountRouter.resolveAccountById(clipReservation.account_id)
            if (!reserved) {
                throw new BadRequestException('Conta de pagamento indisponível. Tente novamente.')
            }
            account = reserved
            providerName = 'clip'
        }

        // Upsell na Clip: não há cartão salvo, há tokens extras gerados na
        // compra (ver loadUpsellParent). Cada cobrança consome um, na conta que
        // montou o formulário — a da compra-mãe.
        let clipUpsell: { reservationId: string | null } | null = null
        if (upsellParent) {
            const parentProvider = this.normalizeProviderName(upsellParent.provider)
            if (parentProvider === 'clip') {
                // A Clip só cobra em peso; o upsell herda a moeda da compra.
                if (String(dto.currency).toUpperCase() !== 'MXN') {
                    throw new BadRequestException({
                        message: 'Upsell indisponível nesta moeda.',
                        error: 'CURRENCY_NOT_SUPPORTED',
                    })
                }
                const taken = await this.clipAccounts.takeUpsellToken(upsellParent.id, transaction.id)
                if (!taken || taken.accountId !== upsellParent.provider_account_id) {
                    await supabase.from('transactions').update({
                        status: 'failed', failure_code: 'UPSELL_NO_SAVED_PAYMENT_METHOD',
                        failure_message: 'Prazo do upsell de um clique encerrado.',
                        failed_at: new Date().toISOString(),
                    }).eq('id', transaction.id)
                    throw new BadRequestException({
                        message: 'Upsell indisponível para esta compra.',
                        error: 'UPSELL_NO_SAVED_PAYMENT_METHOD',
                    })
                }
                dto.payment_data = {
                    ...(dto.payment_data ?? {}),
                    clipToken: taken.token,
                    clipSessionId: taken.sessionId,
                }
                clipUpsell = { reservationId: taken.reservationId }
            }
            const parentAccount = await this.accountRouter.resolveAccountById(upsellParent.provider_account_id)
            if (!parentAccount) {
                throw new BadRequestException('Conta de pagamento da compra original indisponível.')
            }
            account = parentAccount
            providerName = parentProvider === 'clip' ? 'clip' : 'whop'
        }

        if (routed && !clipReservation) {
            providerName = routed.provider

            if (routed.degraded) {
                // Degradação em silêncio é como se descobre semanas depois que o
                // provider preferido está fora do ar desde sempre.
                console.error(
                    `[PaymentService] ⚠️ FAILOVER ativo: preferido=${preferredProvider} `
                    + `→ usado=${routed.provider}/${routed.account.id} `
                    + `(tentados: ${routed.attempted.join(' → ')}) seller=${effectiveSellerId}`,
                )
            }
        }

        if (!account) {
            // O router filtra por seis critérios diferentes e todos terminavam
            // nesta mesma frase. Pergunta o MOTIVO antes de falhar — só neste
            // caminho, sem custo no fluxo normal.
            let motivo = 'motivo não identificado'
            try {
                motivo = await this.accountRouter.explainEmptyPool({
                    provider: preferredProvider,
                    amountUsdCents: netUSDcents,
                    segment: offerSegment,
                    riskLevel: seller.risk_level ?? null,
                })
            } catch (err: any) {
                console.error('[PaymentService] explainEmptyPool falhou:', err?.message)
            }

            console.error(
                `[PaymentService] 🚨 roteamento sem conta em NENHUM PSP da cadeia `
                + `(method=${dto.method ?? 'any'}, preferido=${preferredProvider}) `
                + `seller=${effectiveSellerId}. Motivo do preferido: ${motivo}`,
            )

            const nowFail = new Date().toISOString()
            await supabase.from('transactions').update({
                status: 'failed',
                failure_message: `Nenhuma conta ${providerName} disponível: ${motivo}`,
                failed_at: nowFail,
                processed_at: nowFail,
            }).eq('id', transaction.id)

            throw new BadRequestException(
                `Nenhuma conta de pagamento (${providerName}) disponível para este seller.`
                // Detalhe só fora de produção: a mensagem chega ao comprador no
                // checkout, e "teto diário atingido" não é assunto dele.
                + (PAY_DEBUG ? ` [${motivo}]` : ''),
            )
        }

        // Taxas zeradas (venda de conta própria) só valem numa conta própria.
        // Qualquer desvio (reserva Clip, compra-mãe em outra conta) cobraria na
        // Koopfy sem taxa e creditaria uma carteira: melhor recusar.
        if (ownAccount && !isOwnProviderAccountId(account.id)) {
            const nowFail = new Date().toISOString()
            await supabase.from('transactions').update({
                status: 'failed',
                failure_message: `Venda de conta própria (${ownAccount.provider}) roteada para ${account.id}`,
                failed_at: nowFail,
                processed_at: nowFail,
            }).eq('id', transaction.id)
            throw new BadRequestException('Conta de pagamento do vendedor indisponível para este pedido.')
        }

        // ─── Taxas ─────────────────────────────────────────────────────────────
        // Já calculadas junto da conversão (saleFees): checkout + processamento +
        // orquestração + fixa, e a reserva sobre o que sobra.
        const platformFeeCents = saleFees.platformFeeCents
        const reserveAmountCents = saleFees.reserveCents
        const externalFeeCents = externalFee?.amount_cents ?? 0
        const baseNetCents = saleFees.netCents
        const sellerNetCents = baseNetCents - externalFeeCents

        if (sellerNetCents < 0) {
            throw new BadRequestException(
                `External fee (${externalFeeCents}) exceeds seller net amount (${baseNetCents})`,
            )
        }

        // 🔥 Monta settlement usando a plataforma correta para o risk_level
        const settlement: SettlementPayload = this.buildSettlement({
            sellerWalletRef: effectiveSellerId,
            sellerNetCents,
            platformFeeCents,
            platformWalletRef: KOOPFY_PLATFORM_WALLET_REF,
            externalFeeCents,
            externalWalletRef: externalFee?.recipient_id ?? null,
            externalFeePct: externalFee?.pct ?? null,
            netUSDcents,
            grossUSDcents,
            fxFeeUSDcents,
            fxFinalRate,
            sellerFeePct: saleFeePct(sellerFees),
            // Reserve é retido (não distribuído agora) — entra na sanity check
            // pra fechar net = seller + platform + external + reserve.
            reserveCents: reserveAmountCents,
        })

        // ─── Provider já resolvido acima (account) ──────────────────────────────
        const enrichedDto = {
            ...dto,
            settlement,
            // WhopProvider.charge cobra off-session quando isto vem preenchido.
            ...(upsellParent && !clipUpsell ? {
                offSession: {
                    memberId: upsellParent.metadata.whop_member_id,
                    paymentMethodId: upsellParent.metadata.whop_payment_method_id,
                    parentTransactionId: upsellParent.id,
                },
            } : {}),
        }

        // ─── Credenciais por MID (Sentinel) ─────────────────────────────────────
        // Se o seller tem um MID configurado, recupera as credenciais daquele MID
        // e sobrescreve as do env. Sem MID → usa o default in-project/env.
        let credentialsOverride: any = undefined
        if (providerName === 'setinel_gate' && seller.provider_mid) {
            const midCreds = await this.accountRouter.getSentinelMidCredentials(seller.provider_mid)
            if (!midCreds) {
                const nowFail = new Date().toISOString()
                await supabase.from('transactions').update({
                    status: 'failed',
                    failure_message: `MID Sentinel "${seller.provider_mid}" sem credenciais ativas`,
                    failed_at: nowFail,
                    processed_at: nowFail,
                }).eq('id', transaction.id)
                throw new BadRequestException(`MID Sentinel não configurado ou inativo para este seller.`)
            }
            credentialsOverride = midCreds
        }

        // ─── Merchant ID por seller (Coinflow) ──────────────────────────────────
        // Guardado em config.coinflow_merchant_id (provider_mid tem FK p/ os MIDs
        // do Sentinel). Vira o {merchantId} do path /api/checkout/card/{merchantId}.
        if (providerName === 'coinflow') {
            const cfMid = seller.config?.coinflow_merchant_id ?? seller.provider_mid ?? null
            if (cfMid) credentialsOverride = { ...(credentialsOverride ?? {}), mid: cfMid }
        }

        // ─── Store Reference por seller (Rox Pay) ───────────────────────────────
        // Guardado em config.rox_pay_store_reference (criada manualmente no painel
        // da Rox Pay). Vira o `StoreReference` do payments/link — sem isso, cai na
        // store default da company (ou nenhuma, se não houver default).
        if (providerName === 'rox_pay') {
            const storeReference = seller.config?.rox_pay_store_reference ?? null
            if (storeReference) credentialsOverride = { ...(credentialsOverride ?? {}), storeReference }
        }

        let result: any = null
        let lastError: any = null

        __mark('pré-executeWithProvider (fee calc etc)')

        try {
            result = await this.accountRouter.executeWithProvider({
                providerAccountId: account.id,
                dto: enrichedDto,
                transactionId: transaction.id,
                credentialsOverride,
            })
            __mark('executeWithProvider (provider.charge completo)')
            // Fire-and-forget: log de auditoria, nunca lido antes de responder —
            // não precisa bloquear o cliente esperando o iframe aparecer.
            supabase.from('transaction_attempts').insert({
                transaction_id: transaction.id,
                provider_account_id: account.id,
                status: result.status,
            }).then(({ error }) => {
                if (error) console.error('[PaymentService] transaction_attempts insert:', error)
            })
            __mark('transaction_attempts insert (disparado)')
        } catch (err: any) {
            lastError = err
            supabase.from('transaction_attempts').insert({
                transaction_id: transaction.id,
                provider_account_id: account.id,
                status: 'error', error: err.message,
            }).then(({ error }) => {
                if (error) console.error('[PaymentService] transaction_attempts insert (erro):', error)
            })
        }

        // ─── Falha total ───────────────────────────────────────────────────────
        if (!result?.success) {
            const now = new Date().toISOString()
            // A mensagem do provider costuma ser genérica ("could not process
            // this payment request"). O detalhe que explica a recusa fica aqui,
            // na transação — antes vivia só no log do container, fora do alcance
            // de quem está testando.
            const providerError = summarizeProviderError(result?.data)
            await supabase.from('transactions').update({
                status: 'failed',
                provider_status: result?.providerStatus ?? null,
                failure_code: result?.failureCode ?? lastError?.code ?? null,
                failure_message: result?.failureMessage ?? lastError?.message ?? null,
                error_message: lastError?.message ?? null,
                failed_at: now,
                processed_at: now,
                ...(providerError
                    ? { metadata: { ...(transaction.metadata ?? {}), provider_error: providerError } }
                    : {}),
            }).eq('id', transaction.id)

            await this.registerKpi({
                sellerId: effectiveSellerId,
                method: dto.method ?? 'smart',
                amount: netUSDcents,
                fee: 0,
                status: 'failed',
            })
            // Throw com mensagem REAL no corpo (BadRequestException serializa
            // `message` no JSON → o checkout lê via err.response.data.message).
            // Um `throw lastError` cru viraria 500 "Internal server error"
            // genérico e o checkout nunca veria a causa.
            // Clip recusada: devolve o espaço AGORA em vez de esperar o TTL.
            // Segurar teto de 3h por uma venda que já morreu é capacidade
            // perdida no exato horário em que ela vale mais.
            if (clipReservation) {
                void this.clipAccounts.release(clipReservation.id, 'declined')
            }

            const reason =
                result?.failureMessage
                ?? lastError?.message
                ?? 'Provider failed to create order'
            throw new BadRequestException({
                message: reason,
                error: result?.failureCode ?? lastError?.code ?? 'PROVIDER_FAILED',
                ...(PAY_DEBUG ? {
                    provider: providerName,
                    provider_status: result?.providerStatus ?? null,
                    // Corpo REAL da resposta do provider (ex.: erro detalhado da Coinflow).
                    provider_data: result?.data ?? null,
                    raw: lastError?.message ?? null,
                    stack: lastError?.stack ?? null,
                } : {}),
            })
        }

        // ─── Clip: reserva → captura ───────────────────────────────────────────
        //
        // Migra o espaço de "reservado" para "capturado" no contador do dia. A
        // folga dos upsells CONTINUA segurada de propósito: os upsells one-click
        // re-tokenizam o mesmo SDK e caem obrigatoriamente nesta mesma conta.
        // Quem devolve o que sobrar é o gw_finalize (fim do fluxo) ou o TTL.
        //
        // ⚠️ Idempotente pelo clip_payment_id (unique em gw_captures): o webhook
        // vai chamar isto de novo para o mesmo pagamento, e a segunda chamada
        // não pode contar duas vezes.
        //
        // Em 'pending' (3DS) NÃO capturamos: o dinheiro ainda não existe. A
        // reserva segue em pé e o desfecho chega pelo webhook.
        // Tokens extras da compra para o upsell de um clique. Gravados ANTES de
        // responder: o checkout leva o comprador ao funil logo em seguida, e a
        // primeira coisa que a página pergunta é se a oferta pode ser cobrada.
        // Também em 3DS pendente — o token vale 15 min e a compra pode fechar.
        let clipUpsellTokensStored = 0
        const clipUpsellTokens: string[] = dto.payment_data?.clipUpsellTokens ?? []
        if (clipReservation && result.success && clipUpsellTokens.length) {
            clipUpsellTokensStored = await this.clipAccounts.storeUpsellTokens({
                transactionId: transaction.id,
                sellerId: effectiveSellerId,
                accountId: clipReservation.account_id,
                reservationId: clipReservation.id,
                sessionId: dto.payment_data?.clipSessionId ?? null,
                tokens: clipUpsellTokens,
            })
        }

        // A reserva vai na transação: a confirmação depois do 3DS (ver
        // confirmAtProvider) precisa dela para capturar no teto.
        if (clipReservation || clipUpsell) {
            const clipMeta = {
                ...(transaction.metadata ?? {}),
                clip_reservation_id: clipReservation?.id ?? clipUpsell?.reservationId ?? null,
                ...(clipUpsell ? { clip_upsell_of: upsellParent?.id ?? null } : {}),
                ...(clipUpsellTokensStored ? { clip_upsell_tokens: clipUpsellTokensStored } : {}),
            }
            transaction.metadata = clipMeta
            const { error } = await supabase.from('transactions').update({ metadata: clipMeta }).eq('id', transaction.id)
            if (error) console.error('[PaymentService] metadata Clip:', error.message)
        }

        if (clipReservation && result.success && String(result.status).toLowerCase() !== 'pending') {
            void this.clipAccounts.capture({
                reservationId: clipReservation.id,
                // Valor da RESERVA, na unidade dela (centavos de MXN) — não o
                // `amount` da transação, que pode estar em outra moeda.
                amountMinor: clipReservation.amount_minor,
                clipPaymentId: result.providerTransactionId ?? null,
                kind: 'base',
                source: 'payments.create',
            }).then(() => {
                // Com tokens de upsell a folga da reserva FICA: os upsells caem
                // nesta conta e capturam contra ela. Sobra devolvida pelo TTL.
                //
                // Sem tokens (funil sem oferta, ou o checkout não conseguiu
                // gerá-los), devolve agora: segurar folga que nunca vai ser
                // usada é teto parado — com ticket de ~1.500 MXN, ~30% do dia.
                if (clipUpsellTokensStored > 0) return
                return this.clipAccounts.finalize(clipReservation.id)
            })
        }

        // Upsell aprovado: entra no teto pela reserva da compra-mãe. Sem
        // reserva (expirou), o gw_capture não tem onde contar — fica no log.
        if (clipUpsell?.reservationId && result.success && String(result.status).toLowerCase() !== 'pending') {
            void this.clipAccounts.capture({
                reservationId: clipUpsell.reservationId,
                amountMinor: Math.round(Number(dto.amount)),
                clipPaymentId: result.providerTransactionId ?? null,
                kind: `upsell:${transaction.id}`,
                source: 'payments.create',
            })
        }

        // ─── Atualiza transação ────────────────────────────────────────────────
        const now = new Date().toISOString()
        // Aprovação IMEDIATA (ex.: provider 'simulator'): o provider devolve
        // 'approved'/'captured' de forma síncrona. Providers reais nunca fazem isso
        // (confirmam por webhook). Gravamos como 'pending' e logo abaixo rodamos o
        // pipeline de PAID (que faz pending→approved + credita a wallet) reusando o
        // handleWebhookProvider — sem disparar postback (o checkout marca o pedido
        // pago de forma síncrona, evitando o race do postback antes do pedido existir).
        // Clip aprova na hora: `paid` na resposta é dinheiro capturado, e ela
        // não manda webhook (decisão do dono). Sem isto a venda ficava pendente
        // para sempre e o checkout mostrava "recusado" a quem foi cobrado.
        const isImmediateApproval = ['approved', 'captured', 'succeeded']
            .includes(String(result.status).toLowerCase())
            || (providerName === 'clip' && String(result.status).toLowerCase() === 'paid')
        // MB Way é hosted (requires_action + redirectUrl), mas queremos que conte
        // como PENDENTE e apareça em dash-pay/checkout na hora — sem depender do
        // webhook sale_in_progress. Só o cartão fica em 'requires_action' (não conta
        // até o cliente inserir os dados). O redirectUrl segue na resposta em ambos,
        // então o iframe/redirect abre normalmente.
        const finalStatus = (result.status === 'requires_action' && dto.method !== 'mbway')
            ? 'requires_action'
            : 'pending'

        // Fluxo client na conta própria (Stripe/PayPal do seller): o que o
        // navegador precisa para confirmar fica na transação, para um retry do
        // mesmo pedido devolver o MESMO intent/order (ver idempotência acima).
        const clientFlow = ownAccount && result.data?.flow === 'client'
            ? {
                ...(result.clientSecret ? { client_secret: result.clientSecret } : {}),
                ...(result.data?.publishableKey ? { publishable_key: result.data.publishableKey } : {}),
                ...(result.data?.paypalOrderId ? { paypal_order_id: result.data.paypalOrderId } : {}),
                ...(result.data?.paypalOrderId && result.data?.clientId ? { paypal_client_id: result.data.clientId } : {}),
            }
            : null

        const updateQuery = supabase.from('transactions').update({
            ...(clientFlow ? {
                metadata: {
                    ...(transaction.metadata ?? {}),
                    ...(ownAccount ? { own_account: ownAccount } : {}),
                    client_flow: clientFlow,
                },
            } : {}),
            status: finalStatus,
            provider_status: result.providerStatus ?? result.status,
            provider: result.provider ?? providerName,
            provider_account_id: result.accountId ?? account.id,
            provider_transaction_id: result.providerTransactionId ?? null,
            failure_code: result.failureCode ?? null,
            failure_message: result.failureMessage ?? null,
            fee: platformFeeCents,
            chargeback_protection_fee: 0,
            net_amount: sellerNetCents,
            reserve_amount: reserveAmountCents,
            available_at: saleFees.availableAt.toISOString(),
            reserve_until: saleFees.reserveUntil.toISOString(),
            processed_at: now,
        }).eq('id', transaction.id)

        // Detalhe por tipo de taxa, em gravação separada: se a coluna ainda não
        // existir (migration pendente), não derruba o update que credita o seller.
        supabase.from('transactions').update({ fee_breakdown: saleFees.breakdown }).eq('id', transaction.id)
            .then(({ error }) => { if (error) console.error('[PaymentService] fee_breakdown:', error.message) })

        // Aprovação imediata (simulator) precisa do update já persistido, porque
        // handleWebhookProvider (logo abaixo) RELÊ a transação do banco — sem
        // await, leria a linha ainda desatualizada. Nos demais casos (hosted:
        // Rox Pay, Sentinel, etc.) o frontend só precisa do checkout_url — que já
        // está em `result`, não depende dessa gravação — então não bloqueia.
        if (isImmediateApproval) {
            const { error } = await updateQuery
            if (error) console.error('[PaymentService] update error:', error)
        } else {
            updateQuery.then(({ error }) => {
                if (error) console.error('[PaymentService] update error:', error)
            })
        }
        __mark('update final da transação (disparado)')


        // ─── KPIs ──────────────────────────────────────────────────────────────
        // Hosted/redirect (requires_action): o cliente ainda NÃO inseriu os dados
        // de pagamento — só abriu o iframe/redirect. NÃO contamos aqui; a transação
        // só "conta" quando o cliente paga de fato (o webhook registra o KPI na
        // aprovação/recusa). Assim, quem abre e abandona não vira transação contada.
        if (finalStatus !== 'requires_action') {
            await this.registerKpi({
                sellerId: effectiveSellerId,
                method: dto.method,
                amount: netUSDcents,
                fee: platformFeeCents,
                status: 'pending',
            })
        }


        // Aprovação imediata (simulator): roda o pipeline de PAID reusando o webhook
        // — transição pending→approved + crédito na wallet + markPaid — porém SEM
        // disparar o postback (skipDispatch); o checkout marca o pedido pago síncrono.
        if (isImmediateApproval) {
            await this.webhookService.handleWebhookProvider(
                { reference: transaction.id, status: 'PAID', type: 'TRANSACTION' },
                { skipDispatch: true },
            )
            return withRouting(withOwnAccount(this.buildResponse(result, transaction.id, 'approved', PaymentService.HOSTED_AWAITING_PROVIDERS.has(providerName)), ownAccount), routedOwn)
        }

        __mark('createPayment fim (antes de retornar)')
        return withRouting(withOwnAccount(this.buildResponse(result, transaction.id, finalStatus, PaymentService.HOSTED_AWAITING_PROVIDERS.has(providerName)), ownAccount), routedOwn)
    }

    // ─── Build settlement ─────────────────────────────────────────────────────

    private buildSettlement(args: {
        sellerWalletRef: string
        sellerNetCents: number
        platformFeeCents: number
        platformWalletRef: string      // 🔥 Koopfy ou Nexor dependendo do risk_level
        externalFeeCents: number
        externalWalletRef: string | null
        externalFeePct: number | null
        netUSDcents: number
        grossUSDcents: number
        fxFeeUSDcents: number
        fxFinalRate: number
        sellerFeePct: number
        reserveCents?: number
    }): SettlementPayload {
        const {
            sellerWalletRef, sellerNetCents,
            platformFeeCents, platformWalletRef,
            externalFeeCents, externalWalletRef, externalFeePct,
            netUSDcents, grossUSDcents, fxFeeUSDcents, fxFinalRate, sellerFeePct,
            reserveCents = 0,
        } = args

        const recipients: SettlementRecipient[] = [
            // 1. Seller — recebe o net
            {
                wallet_reference: sellerWalletRef,
                role: 'seller',
                amount_cents: sellerNetCents,
            },
            // 2. Plataforma — Koopfy (WHITE) ou Nexor (GRAY/HIGH)
            {
                wallet_reference: platformWalletRef,
                role: 'platform',
                amount_cents: platformFeeCents,
                fee_type: 'platform_fee',
                fee_pct: sellerFeePct,
            },
        ]

        // 3. Parceiro externo — recebe external_fee (se houver)
        if (externalFeeCents > 0 && externalWalletRef) {
            recipients.push({
                wallet_reference: externalWalletRef,
                role: 'external_partner',
                amount_cents: externalFeeCents,
                fee_type: 'external_fee',
                ...(externalFeePct != null ? { fee_pct: externalFeePct } : {}),
            })
        }

        // Sanity check: a distribuição (seller+platform+external) + o reserve
        // retido tem que fechar com o net. O reserve NÃO é recipient (fica
        // retido e volta pro seller depois), por isso entra só aqui.
        const sum = recipients.reduce((s, r) => s + r.amount_cents, 0)
        if (sum + reserveCents !== netUSDcents) {
            console.warn(
                `[buildSettlement] Sum mismatch: ${sum} + reserve ${reserveCents} ` +
                `!= ${netUSDcents}. seller=${sellerNetCents} platform=${platformFeeCents} ` +
                `external=${externalFeeCents}`,
            )
        }

        return {
            strategy: 'amount',
            total_net_cents: netUSDcents,
            exchange: {
                fx_rate: fxFinalRate,
                fx_fee_cents: fxFeeUSDcents,
                amount_usd_gross_cents: grossUSDcents,
                amount_usd_net_cents: netUSDcents,
            },
            recipients,
        }
    }

    // ─── Resolve external_fee ─────────────────────────────────────────────────

    private async resolveExternalFee(
        input: ExternalFeeInput | undefined,
        netUSDcents: number,
        mainSellerId: string,
    ): Promise<{ amount_cents: number; pct: number | null; recipient_id: string } | null> {
        if (!input) return null

        const hasPct = typeof input.pct === 'number'
        const hasAmt = typeof input.amount_cents === 'number'

        if (hasPct === hasAmt) throw new BadRequestException('external_fee: must have exactly one of pct or amount_cents')
        if (!input.recipient_id) throw new BadRequestException('external_fee.recipient_id is required')
        if (input.recipient_id === mainSellerId) throw new BadRequestException('external_fee.recipient_id cannot be the same as the seller')

        const { data: recipient } = await supabase
            .from('seller_profiles').select('id, status').eq('id', input.recipient_id).maybeSingle()

        if (!recipient) throw new BadRequestException(`external_fee.recipient_id ${input.recipient_id} not found`)

        let amount_cents: number
        let pct: number | null = null

        if (hasPct) {
            if (input.pct! <= 0 || input.pct! >= 100) throw new BadRequestException('external_fee.pct must be > 0 and < 100')
            amount_cents = Math.floor(netUSDcents * input.pct! / 100)
            pct = input.pct!
        } else {
            if (input.amount_cents! <= 0 || !Number.isInteger(input.amount_cents!)) throw new BadRequestException('external_fee.amount_cents must be positive integer')
            if (input.amount_cents! >= netUSDcents) throw new BadRequestException(`external_fee.amount_cents (${input.amount_cents}) must be less than transaction net (${netUSDcents})`)
            amount_cents = input.amount_cents!
        }

        return { amount_cents, pct, recipient_id: input.recipient_id }
    }

    // ─── markApproved ─────────────────────────────────────────────────────────

    async markApproved(tx: any, retrieve: RetrieveResponse) {
        const now = new Date().toISOString()

        const { data: updated } = await supabase
            .from('transactions')
            .update({
                status: 'approved',
                provider_status: retrieve.raw?.StatusId ?? 'F',
                provider_transaction_id: retrieve.providerTransactionId ?? tx.provider_transaction_id,
                method: retrieve.method ?? tx.method ?? 'smart',
                approved_at: now,
                processed_at: now,
            })
            .eq('id', tx.id)
            .eq('status', 'pending')
            .select().maybeSingle()

        if (!updated) {
            const { data: fresh } = await supabase.from('transactions').select('*').eq('id', tx.id).single()
            return this.formatResponse(fresh ?? tx)
        }

        if (updated.net_amount && updated.fee != null) {
            // Se o seller foi indicado, parte do fee é do afiliado. Sai de
            // DENTRO da fatia da plataforma: o net do seller não muda.
            const affiliatePlan = await this.affiliateCommissions.planFor(
                updated.seller_id,
                updated.fee,
                new Date(updated.available_at),
            )

            const affiliateCents = affiliatePlan?.commissionCents ?? 0
            const platformFeeCents = updated.fee - affiliateCents

            await this.walletService.creditPending({
                sellerId: updated.seller_id,
                transactionId: updated.id,
                amount: updated.net_amount,
                fee: updated.fee,
                reserveAmount: updated.reserve_amount ?? 0,
                availableAt: new Date(updated.available_at),
                reserveUntil: new Date(updated.reserve_until),
                externalFee: updated.external_fee_cents
                    ? { amount: updated.external_fee_cents, recipientId: updated.external_fee_recipient_id }
                    : null,
                // 🔥 NOVO
                platformFee: platformFeeCents > 0
                    ? {
                        amount: platformFeeCents,
                        walletRef: this.resolvePlatformWalletRef(updated.platform_partner),
                        partner: updated.platform_partner,
                    }
                    : null,
                affiliateCommission: affiliatePlan
                    ? {
                        amount: affiliatePlan.commissionCents,
                        affiliateSellerId: affiliatePlan.affiliateSellerId,
                        availableAt: affiliatePlan.availableAt,
                    }
                    : null,
            })

            if (affiliatePlan) {
                await this.affiliateCommissions.record({
                    transactionId: updated.id,
                    affiliateSellerId: affiliatePlan.affiliateSellerId,
                    sourceSellerId: updated.seller_id,
                    platformFeeCents: updated.fee,
                    plan: affiliatePlan,
                })
            }
        }

        await this.registerKpi({
            sellerId: updated.seller_id, method: updated.method,
            amount: updated.amount_usd_net_cents ?? 0,
            fee: updated.fee ?? 0,
            status: 'approved',
        })

        if (updated.external_fee_cents && updated.external_fee_recipient_id) {
            await this.registerKpi({
                sellerId: updated.external_fee_recipient_id,
                method: 'external_fee',
                amount: updated.external_fee_cents,
                fee: 0,
                status: 'approved',
            }).catch(err => console.error('[PaymentService] external_fee KPI error:', err))
        }

        return this.formatResponse(updated)
    }

    async markFailed(tx: any, retrieve: RetrieveResponse) {
        const now = new Date().toISOString()

        const { data: updated } = await supabase
            .from('transactions')
            .update({
                status: 'failed',
                provider_status: retrieve.raw?.StatusId ?? 'D',
                failed_at: now,
                processed_at: now,
                failure_message: 'Payment declined by provider',
            })
            .eq('id', tx.id)
            .eq('status', 'pending')
            .select().maybeSingle()

        if (!updated) {
            const { data: fresh } = await supabase.from('transactions').select('*').eq('id', tx.id).single()
            return this.formatResponse(fresh ?? tx)
        }

        return this.formatResponse(updated)
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────
    private buildResponse(result: any, transactionId: string, status: string, hostedAwaiting = false) {
        // success é true SÓ quando a transação está aprovada/concluída.
        // requires_action, pending, processing NÃO são sucesso final —
        // o frontend precisa fazer algo (3DS, mostrar QR/boleto, esperar webhook).
        const isFinalSuccess = status === 'approved' || status === 'succeeded'

        const body: any = {
            success: isFinalSuccess,
            status,
            transactionId,
        }

        // Flag explícita pro frontend não precisar adivinhar pelo status string
        if (status === 'requires_action') {
            body.requires_action = true
        }

        if (result.gateway_id) body.gateway_id = result.gateway_id
        if (result.checkout_url) body.checkout_url = result.checkout_url
        if (result.client_secret) body.client_secret = result.client_secret
        if (result.clientSecret) body.client_secret = result.clientSecret  // compat camelCase
        // Par do client_secret: a pk da MESMA conta (Stripe do seller ou do pool).
        if (result.data?.publishableKey) body.publishable_key = result.data.publishableKey
        // PayPal (conta do seller): os botões aprovam esta order; a captura vem
        // em POST /payments/:id/paypal/capture.
        if (result.data?.paypalOrderId) {
            body.paypal_order_id = result.data.paypalOrderId
            if (result.data?.clientId) body.paypal_client_id = result.data.clientId
        }
        body.provider = 'koopfy'  // a Waylinx fala com a Koopfy (provider externo é sempre koopfy)
        // Sinal explícito (sem vazar qual provider é de verdade) pro checkout saber
        // que deve adiar a criação do pedido até o webhook de engajamento real —
        // hoje só true pro Rox Pay (checkout embedded, ver processSplitAwarePayment).
        if (hostedAwaiting) body.hosted_awaiting = true
        if (result.reference && result.entity) {
            body.reference = result.reference
            body.entity = result.entity
        }
        if (result.redirectUrl) body.redirectUrl = result.redirectUrl
        // Whop: o loader.js precisa de planId + sessionId (o checkout_url sozinho
        // só serve pra redirect, não pro embed).
        if (result.data?.embed) body.embed = result.data.embed
        if (result.referenceData) body.referenceData = result.referenceData
        if (result.next_action) body.next_action = result.next_action
        if (result.data?.card) body.card = result.data.card  // { last4, network, eci }

        console.log('[buildResponse] →', JSON.stringify(body))
        return body
    }

    private formatResponse(tx: any, extra: Record<string, any> = {}) {
        return {
            success: tx.status === 'approved',
            status: tx.status,
            transactionId: tx.id,
            gateway_id: tx.provider_gateway_id ?? undefined,
            checkout_url: tx.provider_checkout_url ?? undefined,
            provider: tx.provider ?? undefined,
            // Idempotência hit (retry) precisa do mesmo sinal que buildResponse manda
            // na primeira vez — senão um retry faz o checkout criar o pedido cedo demais.
            ...(PaymentService.HOSTED_AWAITING_PROVIDERS.has(tx.provider) ? { hosted_awaiting: true } : {}),
            ...(tx.metadata?.own_account ? { own_account: tx.metadata.own_account } : {}),
            // Retry idempotente de conta própria em fluxo client: o mesmo
            // intent/order da primeira resposta (ver createPayment).
            ...(tx.metadata?.client_flow?.client_secret ? { client_secret: tx.metadata.client_flow.client_secret } : {}),
            ...(tx.metadata?.client_flow?.publishable_key ? { publishable_key: tx.metadata.client_flow.publishable_key } : {}),
            ...(tx.metadata?.client_flow?.paypal_order_id ? { paypal_order_id: tx.metadata.client_flow.paypal_order_id } : {}),
            ...(tx.metadata?.client_flow?.paypal_client_id ? { paypal_client_id: tx.metadata.client_flow.paypal_client_id } : {}),
            ...extra,
        }
    }

    // Wallet ref da plataforma que recebe o platform_fee.
    // Modelo atual: plataforma única (Koopfy). O parâmetro `partner` é mantido
    // para compatibilidade caso volte o split Koopfy/Nexor por risk_level.
    private resolvePlatformWalletRef(_partner?: string | null): string {
        return KOOPFY_PLATFORM_WALLET_REF
    }

    // ─── Clip: reserva a conta ANTES de o formulário de cartão existir ────────
    //
    // ⚠️ ESTE ENDPOINT É O QUE TORNA O TETO REAL, E A ORDEM IMPORTA.
    // O SDK da Clip monta o iframe com a PUBLIC KEY, e o token que sai dali só
    // é cobrável pelo SECRET DA MESMA CONTA. Ou seja: a conta tem que estar
    // decidida antes de o comprador ver o campo de cartão. Rotear no
    // createPayment seria tarde — o token já chegaria amarrado.
    //
    // Devolve UMA conta. Nunca a lista, nunca o secret.
    async clipRoute(sellerId: string, body: {
        method?: string
        amount?: number          // CENTAVOS
        external_reference?: string
        // ⚠️ DECLARADOS PELA ORIGEM DO PEDIDO, quando existe uma.
        // No embed, o backend do seller informa país e moeda ao criar a sessão
        // — isso é FATO, e vence a inferência por IP ou o cadastro do seller.
        // O checkout hospedado não passa nada e continua caindo no seller.
        country?: string
        currency?: string
    }) {
        const amountMinor = Math.round(Number(body?.amount))
        if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
            throw new BadRequestException('amount (em centavos de MXN) é obrigatório.')
        }

        const method = (body?.method ?? 'card').toLowerCase()
        const externalReference = body?.external_reference ?? null

        const seller = await this.getSellerById(sellerId)
        if (!seller || seller.status !== 'active') {
            throw new ForbiddenException('Seller não está ativo para receber pagamentos.')
        }
        if (this.normalizeProviderName(seller.provider_default) !== 'clip') {
            throw new ForbiddenException('Provider Clip não está configurado para este seller.')
        }

        const riskLevel = String(seller.risk_level ?? '').toUpperCase()
        if (riskLevel !== 'WHITE' && riskLevel !== 'GRAY') {
            throw new ForbiddenException('Nível de risco do seller inválido para roteamento Clip.')
        }

        const enabled = new Set(
            (seller.enabled_methods ?? []).map((m: any) =>
                String(m).toLowerCase() === 'credit_card' ? 'card' : String(m).toLowerCase(),
            ),
        )
        if (!enabled.has(method)) {
            throw new ForbiddenException(`Método ${method} não está habilitado para este seller.`)
        }

        // Clip é uma operação mexicana. Sellers antigos podem não ter country
        // preenchido; nesse caso MX preserva compatibilidade. A conta ainda é
        // filtrada no Postgres pelo mesmo país, sem fallback para outro país.
        // Precedência: o que a origem declarou → cadastro do seller → MX.
        // Sellers antigos não têm country, e sem o último degrau eles parariam
        // de rotear de um dia para o outro.
        const country = String(body?.country ?? seller.country ?? 'MX').toUpperCase()
        const currency = String(body?.currency ?? 'MXN').toUpperCase()

        if (method === 'spei') {
            const hold = await this.clipAccounts.holdSpei({
                amountMinor, externalReference, sellerId, country, currency,
                riskLevel: riskLevel as 'WHITE' | 'GRAY',
            })
            // Sem capacidade NÃO é erro transitório: é o teto funcionando. Um
            // 503 aqui faria o front dar retry e martelar um pool cheio.
            if (!hold) return { available: false, method: 'spei' as const }

            return {
                available: true,
                method: 'spei' as const,
                reservation_id: hold.reservation_id,
                account_id: hold.account_id,
                clabe: hold.clabe,
                banco: hold.banco,
                beneficiario: hold.beneficiario,
                // ⚠️ O VALOR A COBRAR É ESTE, não o que o front calculou.
                // Os centavos são únicos por pedido (ver gw_hold_spei): sem
                // API, o valor no extrato é a ÚNICA chave de conciliação, e
                // dois pedidos do mesmo valor na mesma CLABE no mesmo dia são
                // indistinguíveis para sempre.
                charge_minor: hold.charge_minor,
            }
        }

        if (method !== 'card') {
            throw new BadRequestException(`Método Clip não suportado: ${method}.`)
        }

        // ⚠️ TTL CURTO NO CARTÃO — 3h era herança do SPEI e está errado aqui.
        // O SPEI precisa de horas: o comprador sai para o app do banco. O cartão
        // é preenchido na mesma sessão, em minutos. Com 3h, cada checkout aberto
        // e abandonado imobilizava (valor + folga de upsell) por meio turno, e
        // sete abandonos matavam o teto do dia sem uma venda sequer.
        const hold = await this.clipAccounts.holdCard({
            amountMinor, externalReference, sellerId, country, currency,
            riskLevel: riskLevel as 'WHITE' | 'GRAY',
            ttlMinutes: CARD_HOLD_TTL_MIN,
        })
        if (!hold) return { available: false, method: 'card' as const }

        return {
            available: true,
            method: 'card' as const,
            reservation_id: hold.reservation_id,
            account_id: hold.account_id,
            // Pública por design — é o que monta o iframe. O secret nunca sai
            // do servidor.
            public_key: hold.public_key,
        }
    }

    // ─── SPEI: comprovante enviado pelo comprador ─────────────────────────────
    //
    // ⚠️ ISTO NÃO CONFIRMA QUE O DINHEIRO CHEGOU. Confirma que uma IMAGEM é
    // consistente com a reserva. Não existe confirmação de verdade neste fluxo:
    // o SPEI aqui é transferência direta para uma CLABE, sem webhook e sem
    // endpoint de saldo. Quem descobre a fraude é a deriva no saque
    // (gw_spei_withdraw), não este endpoint.
    //
    // Três desfechos, e o do meio é o que mais importa:
    //   approved → reserva capturada, pedido pago
    //   review   → vai para fila humana. NÃO é recusa; é "não tenho certeza".
    //   rejected → contradiz a reserva de forma dura (não é comprovante, ou o
    //              valor não bate)
    async speiReceipt(sellerId: string, body: {
        reservation_id?: string
        // Caminho no bucket privado. Aceita `file_url` pelo nome antigo.
        file_ref?: string
        file_url?: string
        file_type?: string
    }) {
        const ref = body?.file_ref ?? body?.file_url
        if (!body?.reservation_id || !ref) {
            throw new BadRequestException('reservation_id e file_ref são obrigatórios.')
        }

        const r = await this.speiReceipts.validate({
            reservationId: body.reservation_id,
            fileRef: ref,
            fileType: body.file_type,
        })

        // ⚠️ A resposta ao COMPRADOR não carrega `checks` nem `reasons`.
        // Dizer "o valor não bateu: esperava 1.247,63, li 1.247,00" ensina
        // exatamente o que ajustar na próxima tentativa. O detalhe fica no
        // banco, para quem revisa; o comprador recebe só o estado.
        return {
            status: r.verdict === 'approved' ? 'paid'
                : r.verdict === 'rejected' ? 'rejected'
                    : 'in_review',
            receipt_id: r.receiptId ?? null,
        }
    }

    /**
     * Devolve o espaço de uma reserva que não vai virar cobrança.
     *
     * ⚠️ SEM ISTO O TETO VAZA. Cada abertura do checkout reserva
     * (valor + folga de upsell); o front chama esta rota ao trocar de valor, ao
     * sair da tela ou ao trocar de método. Sem ela o espaço só voltava no TTL,
     * e um punhado de carrinhos abandonados esgotava o teto do dia sem UMA
     * venda — foi exatamente o que aconteceu.
     *
     * Idempotente e silenciosa em reserva já resolvida: quem chama é o browser,
     * que repete e desiste no meio.
     */
    async clipRelease(sellerId: string, reservationId?: string) {
        if (!reservationId) return { released: false }

        const reserva = await this.clipAccounts.getReservation(reservationId)
        // ⚠️ Confere o dono. Sem isto qualquer um libera a reserva de qualquer
        // seller tendo só o id — e o teto passa a furar pelo lado oposto.
        if (!reserva || reserva.seller_id !== sellerId) return { released: false }
        // Capturada é dinheiro que entrou: nunca devolve espaço.
        if (reserva.state !== 'held') return { released: false }

        // Cobrança no meio do 3DS: a página vai para o banco e avisa "saí" do
        // mesmo jeito que um carrinho abandonado. Devolver o espaço aqui tira
        // do teto uma venda que ainda pode aprovar. Quem resolve esta reserva é
        // o desfecho da cobrança (captura, recusa) ou o TTL.
        const { data: emVoo } = await supabase.from('transactions')
            .select('id')
            .eq('seller_id', sellerId).eq('status', 'pending')
            .eq('metadata->>clip_reservation_id', reservationId)
            .not('provider_transaction_id', 'is', null)
            .limit(1)
        if (emVoo?.length) return { released: false }

        await this.clipAccounts.release(reservationId, 'checkout-abandonou')
        return { released: true }
    }

    /** Cobrança local pelo Kontino Connect (SPEI em MXN, Pix em BRL). */
    /**
     * Provedor do formulário de cartão pela regra de método. `routed: false` =
     * sem regra (vale o provider_default). Com regra e nenhuma conta, provider
     * null: o checkout não oferece cartão em vez de montar um formulário que
     * não cobra.
     */
    private async cardProviderByMethod(
        sellerId: string,
        opts: { country?: string | null; currency?: string | null },
    ): Promise<{ routed: boolean; provider: string | null }> {
        if (!this.methodRouting) return { routed: false, provider: null }
        const route = await this.methodRouting.resolve({
            method: 'card', country: opts.country ?? null, currency: opts.currency ?? null, sellerId,
        }).catch(() => null)
        if (!route?.ruleId) return { routed: false, provider: null }
        for (const candidate of route.chain.filter(p => !DIRECT_PROVIDERS.has(p))) {
            const account = await this.accountRouter.getAccountByProvider({ sellerId, provider: candidate }).catch(() => null)
            if (account) return { routed: true, provider: candidate }
        }
        console.error(`[PaymentService] cartão sem provedor com conta para o seller ${sellerId} na regra ${route.ruleId}`)
        return { routed: true, provider: null }
    }

    /**
     * Cobra pelo Kontino. Com `fallbackTo`, uma falha TÉCNICA (não de regra do
     * trilho, como valor fora da faixa) devolve null e a transação volta a ficar
     * livre para o próximo provedor da regra.
     */
    private async cobrarPeloKontino(seller: any, dto: any, transaction: any, amountMinor: number, currency: string, opts: { fallbackTo?: string | null; contaKontino: string; comissaoUsdCents: number; fallbackOnRange?: boolean }) {
        const metodo = dto.method as MetodoKontino
        if (currency.toUpperCase() !== KONTINO_METODOS[metodo].moeda) {
            throw new BadRequestException(`${metodo === 'spei' ? 'SPEI' : 'Pix'} está disponível apenas em ${KONTINO_METODOS[metodo].moeda}.`)
        }
        const enabled = new Set((seller.enabled_methods ?? []).map((m: any) => String(m).toLowerCase()))
        if (!enabled.has(metodo)) throw new ForbiddenException(`${metodo === 'spei' ? 'SPEI' : 'Pix'} não está habilitado para este seller.`)
        if (!kontinoConfigurado()) throw new BadRequestException('Pagamento indisponível no momento. Selecione outro método.')

        try {
            const cobranca = await criarCobranca({
                transactionId: transaction.id,
                metodo,
                valorMinor: amountMinor,
                moeda: currency,
                referencia: dto.metadata?.order_number ?? dto.metadata?.orderId ?? null,
                comprador: { nome: dto.customer?.name, email: dto.customer?.email, documento: dto.customer?.document },
                contaConectada: opts.contaKontino,
                comissaoUsdCents: opts.comissaoUsdCents,
            })
            await supabase.from('transactions').update({
                provider: 'kontino',
                // Conta do próprio seller: a venda não entra na carteira da Koopfy;
                // a comissão (fee) sai da conta dele como application fee.
                provider_account_id: toKontinoOwnAccountId(opts.contaKontino),
                fee: opts.comissaoUsdCents,
                provider_transaction_id: cobranca.id,
                provider_status: cobranca.status,
                status: 'pending',
                metadata: { ...(transaction.metadata ?? {}), kontino_collection_id: cobranca.id, kontino_expires_at: cobranca.expires_at },
                updated_at: new Date().toISOString(),
            }).eq('id', transaction.id)
            return respostaAoCheckout(transaction.id, cobranca, amountMinor)
        } catch (e: any) {
            if (opts.fallbackTo && (opts.fallbackOnRange || !(e instanceof ErroKontino && e.code === 'amount_out_of_range'))) {
                console.error(`[PaymentService] Kontino falhou tx=${transaction.id}, seguindo para ${opts.fallbackTo}:`, e?.message ?? e)
                await supabase.from('transactions').update({
                    metadata: { ...(transaction.metadata ?? {}), kontino_fallback: { to: opts.fallbackTo, reason: String(e?.message ?? e).slice(0, 300) } },
                    updated_at: new Date().toISOString(),
                }).eq('id', transaction.id)
                return null
            }
            const motivo = e instanceof ErroKontino ? `${e.code}: ${e.message}` : String(e?.message ?? e)
            console.error(`[PaymentService] Kontino recusou a cobrança tx=${transaction.id}:`, motivo)
            await supabase.from('transactions').update({
                provider: 'kontino', status: 'failed', provider_status: 'failed',
                failure_code: e instanceof ErroKontino ? `KONTINO_${e.code}`.toUpperCase().slice(0, 60) : 'KONTINO_ERROR',
                failure_message: motivo.slice(0, 500), updated_at: new Date().toISOString(),
            }).eq('id', transaction.id)
            // Fora da faixa do trilho (ex.: menos de US$ 10) a mensagem do Kontino é útil para o comprador.
            if (e instanceof ErroKontino && e.code === 'amount_out_of_range') throw new BadRequestException(e.message)
            throw new BadRequestException('Pagamento indisponível no momento. Selecione outro método.')
        }
    }

    private normalizeProviderName(provider: any): string {
        if (!provider) return 'unknown'
        const raw = typeof provider === 'string'
            ? provider
            : (provider.constructor?.name ?? String(provider))
        return raw.toLowerCase().replace(/provider$/, '')
    }

    // ─── Config de pagamento p/ o checkout (fluxo unificado Koopfy) ────────────
    //
    // Consumido pelo backend checkout (autenticado com a sk_live_ do seller) p/
    // montar o checkout do comprador: conta ativa?, provider configurado e
    // métodos habilitados no dash-pay. Não retorna segredos.
    async getPaymentConfig(
        sellerId: string,
        // Roteamento de contas: chave da sessão do comprador (id da checkout
        // session) e, quando o checkout já sabe, país/moeda para os filtros.
        // `linkProviders` (CSV de shopify,digistore24): quais contas por link
        // podem concorrer ao cartão; sem ele, só Shopify (como antes).
        routingOpts: { routingKey?: string | null; country?: string | null; currency?: string | null; link?: string | null; linkProviders?: string | null } = {},
    ) {
        const { data: seller } = await supabase
            .from('seller_profiles')
            .select('status, provider_default, enabled_methods, provider_mid, config')
            .eq('id', sellerId)
            .maybeSingle()

        if (!seller) {
            return { active: false, provider: null, methods: [], providerConfig: null }
        }

        // Stripe PRÓPRIA do seller cobrando: o cartão sai por ela, qualquer que
        // seja o provider_default (o mesmo que createPayment decide em
        // resolveOwnSale). A pk é a da conta dele — par do client_secret.
        const ownStripe = await this.accountRouter.getOwnAccount(sellerId, 'stripe').catch((err: any) => {
            console.error('[PaymentService] getPaymentConfig: Stripe própria indisponível:', err?.message)
            return null
        })
        // PayPal PRÓPRIO: só o método `paypal`, em paralelo ao provider do cartão.
        const ownPaypal = await this.accountRouter.getOwnAccount(sellerId, 'paypal').catch((err: any) => {
            console.error('[PaymentService] getPaymentConfig: PayPal próprio indisponível:', err?.message)
            return null
        })

        // Provedor por método: com regra para cartão, o formulário é o do
        // primeiro provedor da cadeia que tem conta para este seller — a mesma
        // ordem que createPayment percorre. Sem regra, o provider_default.
        const cardByMethod = ownStripe ? null : await this.cardProviderByMethod(sellerId, routingOpts)
        const provider = ownStripe
            ? 'stripe'
            : cardByMethod?.routed
                ? cardByMethod.provider
                : seller.provider_default
                    ? this.normalizeProviderName(seller.provider_default)
                    : null

        // MID por seller: Sentinel usa provider_mid; Coinflow usa o merchantId
        // guardado em config.coinflow_merchant_id (provider_mid tem FK p/ Sentinel).
        const mid = provider === 'coinflow'
            ? (seller.config?.coinflow_merchant_id ?? null)
            : seller.provider_mid

        // Stripe é POOL: a publishable_key é por titular e só existe depois de
        // rotear. Resolvemos uma conta candidata aqui só para o front conseguir
        // pré-carregar o stripe.js — a chave que VALE é a que volta junto do
        // client_secret em createPayment, porque o par tem que ser da mesma
        // conta. Ver StripeProvider.charge.
        let stripeAccount: any = ownStripe
        if (provider === 'stripe' && !stripeAccount) {
            try {
                stripeAccount = await this.accountRouter.getAccountByProvider({
                    sellerId,
                    provider: 'stripe',
                })
            } catch (err: any) {
                console.error('[PaymentService] getPaymentConfig: pool Stripe indisponível:', err?.message)
            }
        }

        // Whop Elements (Payments/PaymentRequest) é montado no navegador com o id
        // da conta (biz_). Não é segredo — é o mesmo id que aparece no checkout
        // hospedado da Whop. Sem ele o checkout fica no embed antigo.
        let whopAccount: any = null
        if (provider === 'whop') {
            try {
                whopAccount = await this.accountRouter.getAccountByProvider({
                    sellerId,
                    provider: 'whop',
                })
            } catch (err: any) {
                console.error('[PaymentService] getPaymentConfig: conta Whop indisponível:', err?.message)
            }
        }

        // Seller em análise só vende pela conta dele: sem conta própria de
        // cartão (Stripe, ou Whop sendo a Whop o provider dele), os métodos da
        // Koopfy ficam de fora e sobra o PayPal próprio (campo `paypal`).
        const approved = seller.status === 'active'
        // Stripe do seller: a lista é a dos métodos LIGADOS NA CONTA DELE. A
        // lista do cadastro (enabled_methods) é a do provedor da Koopfy e
        // trazia SPEI, iDEAL, MB Way para uma conta que não tem nenhum deles.
        const sellerMethods: string[] = seller.enabled_methods ?? []
        const stripeMethods = async (account: any): Promise<string[]> => {
            const read = await this.accountRouter.ownStripeMethods(account).catch(() => null)
            if (read) return read
            const kept = sellerMethods.filter(method => STRIPE_FALLBACK_METHODS.has(String(method)))
            return kept.length ? kept : ['credit_card', 'apple_pay', 'google_pay']
        }
        const ownCard = Boolean(ownStripe)
            || (provider === 'whop' && Boolean(await this.accountRouter.getOwnAccount(sellerId, 'whop').catch(() => null)))

        const legacy = {
            active: await sellerMayOperate({ id: sellerId, status: seller.status }),
            provider, // ex.: 'setinel_gate' | 'approvebly' | 'coinflow' | 'stripe'
            methods: ownStripe ? await stripeMethods(ownStripe) : approved || ownCard ? sellerMethods : [],
            providerConfig: provider
                ? this.buildProviderPublicConfig(provider, mid, seller.config, stripeAccount, whopAccount)
                : null,
            // PayPal do seller: o checkout monta os botões com este client-id.
            // Público — é o mesmo id que o SDK do PayPal carrega no navegador.
            paypal: ownPaypal ? paypalPublicConfig(ownPaypal) : null,
        }

        // ── Roteamento de contas ──
        // Ligado: a conta de cartão (Whop ou Stripe) e a de PayPal são as da
        // SESSÃO do comprador, escolhidas (ou reaproveitadas) agora e gravadas
        // em routing_assignments. O formulário é montado com a credencial
        // pública DESSA conta; o createPayment com a mesma chave cobra nela.
        const pick = this.sellerRouting
            ? await this.sellerRouting.resolveForConfig(sellerId, normalizeRoutingKey(routingOpts.routingKey), {
                country: routingOpts.country ?? null,
                currency: routingOpts.currency ?? null,
                // Contas por link (lojas Shopify): só quando o checkout avisa que
                // a oferta cabe no checkout da Shopify ('allow') ou foi vinculada
                // a ela ('only'). Checkout antigo não manda → nunca por link.
                link: routingOpts.link === 'allow' || routingOpts.link === 'only' ? routingOpts.link : 'deny',
                linkProviders: parseLinkProviders(routingOpts.linkProviders),
            }, { sellerMethods }).catch((err: any) => {
                console.error('[PaymentService] getPaymentConfig: roteamento indisponível:', err?.message)
                return null
            })
            : null
        if (!pick) return { ...legacy, routing: { enabled: false } }

        // Conta de cada slot (cartão e carteiras, PayPal, Pix…), com a mesma
        // credencial pública que os campos antigos levam para esse provedor.
        // Checkout novo monta cada método com a conta do seu slot; o antigo
        // segue nos campos de sempre, calculados pelo slot do cartão.
        const slotEntries: Array<[string, PoolEntry]> = pick.slots
            ? [...pick.slots]
            : ([['card', pick.card], ['paypal', pick.paypal]] as Array<[string, PoolEntry | null]>)
                .filter((item): item is [string, PoolEntry] => Boolean(item[1]))
        const slots = slotEntries
            .map(([slot, entry]) => this.routingSlotConfig(slot, entry, seller.config))
            .filter((item): item is NonNullable<typeof item> => item !== null)

        const routing = {
            enabled: true,
            key: pick.routingKey,
            cardAccountId: pick.card?.id ?? null,
            cardProvider: pick.card?.provider ?? null,
            paypalAccountId: pick.paypal?.id ?? null,
            slots,
        }
        const paypal = pick.paypalAccounts > 0
            ? (pick.paypal?.account ? paypalPublicConfig(pick.paypal.account) : null)
            : legacy.paypal

        // Conta por link (loja Shopify, Digistore24): o cartão desta sessão é
        // pago fora (checkout da loja / formulário Digistore). O backend do
        // checkout cria o pedido nela; nada de formulário aqui. Os outros
        // slots seguem em routing.slots.
        const linkPick = this.sellerRouting?.linkPickOf(pick) ?? null
        if (linkPick) {
            const linkProvider = linkPick.provider === 'digistore24' ? 'digistore24' : 'shopify_payments'
            return {
                ...legacy,
                provider: linkProvider,
                methods: [],
                providerConfig: { provider: linkProvider, cardFlow: 'link' as const, providerAccountId: linkPick.accountId, linkRef: linkPick.linkRef },
                paypal: null,
                routing: { ...routing, cardProvider: linkPick.provider },
            }
        }

        // Sem conta de cartão conectada no roteamento: o cartão segue como antes.
        if (pick.cardAccounts === 0) return { ...legacy, paypal, routing }

        // Contas de cartão conectadas mas nenhuma elegível agora (pausa, teto,
        // filtro): sem cartão nesta sessão — nunca cai no pool da Koopfy.
        const card = pick.card?.account ?? null
        const cardProvider = card ? pick.card!.provider : null
        return {
            ...legacy,
            provider: cardProvider,
            // Métodos que o seller deixou ligados nesta conta (roteamento › métodos).
            methods: !card ? [] : applyAccountMethods(cardProvider === 'stripe' ? await stripeMethods(card) : sellerMethods, pick.card?.config),
            providerConfig: card
                ? this.buildProviderPublicConfig(
                    cardProvider as string,
                    null,
                    seller.config,
                    cardProvider === 'stripe' ? card : null,
                    cardProvider === 'whop' ? card : null,
                )
                : null,
            paypal,
            routing,
        }
    }

    /**
     * Um item de routing.slots: a conta do slot, os métodos dela NESTE slot
     * (grafia do pay, ex.: card → credit_card/apple_pay/google_pay) e a
     * credencial pública no formato de hoje para o provedor.
     */
    private routingSlotConfig(slot: string, entry: PoolEntry, sellerConfig: any) {
        if (entry.provider === 'shopify' || entry.provider === 'digistore24') {
            if (!entry.linkRef) return null
            const provider = entry.provider === 'digistore24' ? 'digistore24' : 'shopify_payments'
            return {
                slot,
                accountId: entry.id,
                provider,
                methods: ['credit_card'],
                providerConfig: { provider, cardFlow: 'link' as const, providerAccountId: entry.id, linkRef: entry.linkRef },
            }
        }
        const account = entry.account
        if (!account) return null
        const methods = (entry.methods ?? []).filter(method => slotOfMethod(method) === slot)
        if (entry.provider === 'paypal') {
            return { slot, accountId: entry.id, provider: 'paypal', methods: methods.length ? methods : ['paypal'], providerConfig: paypalPublicConfig(account) }
        }
        return {
            slot,
            accountId: entry.id,
            provider: entry.provider,
            methods,
            providerConfig: this.buildProviderPublicConfig(
                entry.provider,
                null,
                sellerConfig,
                entry.provider === 'stripe' ? account : null,
                entry.provider === 'whop' ? account : null,
            ),
        }
    }

    // Minta uma session key da Coinflow p/ o cliente (Apple/Google Pay no client).
    // A apiKey é secreta (env) — por isso isto roda no servidor, não no front.
    async mintCoinflowSession(sellerId: string, userId: string): Promise<{ sessionKey: string; merchantId: string; env: string }> {
        const { data: seller } = await supabase
            .from('seller_profiles')
            .select('config')
            .eq('id', sellerId)
            .maybeSingle()

        const merchantId = seller?.config?.coinflow_merchant_id ?? process.env.COINFLOW_MERCHANT_ID ?? null
        const apiUrl = process.env.COINFLOW_API_URL ?? 'https://api.coinflow.cash'
        const apiKey = process.env.COINFLOW_API_KEY
        const env = process.env.COINFLOW_ENV ?? 'sandbox'

        if (!apiKey || !merchantId) {
            throw new BadRequestException('Coinflow não configurado (COINFLOW_API_KEY / merchantId).')
        }

        try {
            const res = await fetch(`${apiUrl}/api/auth/session-key`, {
                method: 'GET',
                headers: { Authorization: apiKey, 'x-coinflow-auth-user-id': String(userId) },
            })
            const json: any = await res.json().catch(() => ({}))
            if (!res.ok || !json?.key) {
                throw new BadRequestException('Falha ao gerar session da Coinflow.')
            }
            return { sessionKey: json.key, merchantId, env }
        } catch (e: any) {
            if (e instanceof BadRequestException) throw e
            throw new BadRequestException('Falha ao gerar session da Coinflow: ' + (e?.message ?? 'erro'))
        }
    }

    // Bits PÚBLICOS por provider p/ o storefront renderizar a UI de cartão.
    // `cardFlow` é o essencial: 'elements' (Stripe Elements) vs 'redirect'
    // (bloco/redirect, ex.: Sentinel). publishableKey/scriptUrl vêm de env quando
    // configurados (nunca segredos).
    private buildProviderPublicConfig(
        provider: string,
        mid?: string | null,
        sellerConfig?: any,
        stripeAccount?: any,
        whopAccount?: any,
    ) {
        switch (provider) {
            case 'rox_pay':
                // Default: embedded (iframe da Rox Pay, checkout hospedado). Opt-in
                // por seller (config.rox_pay_card_flow = 'native') pro modo campos
                // próprios (sem iframe) — ver rox-pay.provider.ts chargeNative().
                // Experimental: sem 3DS e escopo PCI mais pesado (ver notas lá).
                if (sellerConfig?.rox_pay_card_flow === 'native') {
                    const cardEncryption = this.cardCrypto.getPublicKeyInfo()
                    return {
                        provider,
                        cardFlow: 'local' as const,
                        ...(cardEncryption ? { cardEncryption } : {}),
                    }
                }
                return { provider, cardFlow: 'redirect' as const }
            case 'stripe':
                // ⚠️ NÃO cai mais em process.env.STRIPE_PUBLISHABLE_KEY. Com pool de
                // titulares, uma pk global é a chave de OUTRA conta — e o confirm
                // falha com um erro que não diz isso. Sem conta no pool, devolve
                // null e o front espera a chave que vem com o client_secret.
                return {
                    provider,
                    cardFlow: 'elements' as const,
                    publishableKey: stripeAccount?.config?.publishable_key ?? null,
                    // O front usa para conferir que a chave do preview e a do
                    // client_secret são da mesma conta antes de montar o Element.
                    providerAccountId: stripeAccount?.id ?? null,
                }
            case 'setinel_gate':
                return {
                    provider,
                    cardFlow: 'redirect' as const,
                    scriptUrl: process.env.SENTINEL_SCRIPT_URL ?? null,
                }
            case 'coinflow':
                // Cartão tokenizado no CLIENT pelo SDK da Coinflow (Card Form /
                // CoinflowPurchase). O front precisa do merchantId + env (sandbox/prod).
                return {
                    provider,
                    cardFlow: 'coinflow' as const,
                    // merchantId por seller (provider_mid), com fallback do ambiente.
                    merchantId: mid ?? process.env.COINFLOW_MERCHANT_ID ?? null,
                    env: (process.env.COINFLOW_ENV ?? 'prod') as 'prod' | 'sandbox',
                }
            case 'whop':
                // Checkout embedado da Whop (loader.js + <div data-whop-checkout-*>).
                // Não há chave pública: o que identifica a compra é o par
                // planId/sessionId devolvido por createPayment em `embed`.
                return {
                    provider,
                    cardFlow: 'whop' as const,
                    scriptUrl: process.env.WHOP_CHECKOUT_SCRIPT_URL
                        ?? 'https://js.whop.com/static/checkout/loader.js',
                    // biz_ da conta — o Whop Elements (Payments) monta com ele.
                    accountId: whopAccount?.config?.company_id ?? null,
                }
            case 'clip':
                // Clip MX — Checkout Transparente. O SDK da Clip monta um iframe
                // de cartão no browser usando a PUBLIC KEY, tokeniza, e nós
                // cobramos no servidor com o secret da MESMA conta.
                //
                // ⚠️ A public_key NÃO vem de env, e nem sequer vem daqui de
                // forma definitiva. Ela é da conta que a RESERVA escolheu, e a
                // reserva acontece em POST /payments/clip/route — antes de o
                // formulário existir. O que devolvemos aqui é só o suficiente
                // para o front carregar o SDK; a chave que VALE é a que volta
                // do route, junto do reservation_id.
                //
                // Mandar uma chave "preferida" daqui seria o mesmo erro que a
                // Stripe já cometeu com STRIPE_PUBLISHABLE_KEY: token gerado
                // com a chave de uma conta e cobrado com o secret de outra
                // falha com um erro que não diz isso.
                return {
                    provider,
                    cardFlow: 'clip' as const,
                    // Nome comercial opcional mostrado como beneficiário no
                    // SPEI. Sem valor, o checkout usa o nome do workspace.
                    speiBeneficiaryName: String(sellerConfig?.spei_beneficiary_name ?? '').trim() || null,
                    scriptUrl: process.env.CLIP_SDK_URL
                        ?? 'https://sdk.clip.mx/js/clip-sdk.js',
                    // O front chama este endpoint para reservar a conta e
                    // receber { reservation_id, public_key }.
                    routeUrl: '/payments/clip/route',
                }
            case 'slash':
                // Payment Elements da Slash (@slashfi/elements-react). Não há
                // chave pública: o formulário monta com o clientSecret que volta
                // de createPayment, um por intent.
                return { provider, cardFlow: 'slash' as const }
            case 'simulator':
                // Form LOCAL de cartão (número/validade/cvv) — sem redirect/elements.
                return { provider, cardFlow: 'local' as const }
            default:
                return { provider, cardFlow: 'redirect' as const }
        }
    }

    // ─── Resolve o instrumento de pagamento ───────────────────────────────────
    // - card  + card_encrypted → decifra o envelope (RSA+AES-GCM) e cross-check.
    // - apple_pay/google_pay   → token cru da carteira (Sentinel decifra).
    // Resultado normalizado em dto.payment_data (mesma forma da rota de teste).
    private resolvePaymentInstrument(dto: any) {
        const method = dto.method

        // ── Clip (MX): token do SDK + reserva. Checado ANTES da Coinflow porque
        //    os dois são "token de cartão no client" e a ordem define quem
        //    ganha quando um payload traz os dois (não deveria, mas trazer um
        //    campo órfão é barato e cair no provider errado é caro).
        if (dto.clip?.token) {
            dto.payment_data = {
                ...(dto.payment_data ?? {}),
                clipToken: dto.clip.token,
                clipSessionId: dto.clip.sessionId ?? null,
                clipReservationId: dto.clip.reservationId ?? null,
                // Upsell de um clique: tokens extras do MESMO formulário, gerados
                // no momento da compra (a Clip não guarda cartão). Ver
                // ClipAccountsService.storeUpsellTokens.
                clipUpsellTokens: Array.isArray(dto.clip.upsellTokens)
                    ? dto.clip.upsellTokens
                        .filter((t: unknown) => typeof t === 'string' && t.length > 0 && t.length < 200)
                        .slice(0, ClipAccountsService.MAX_UPSELL_TOKENS)
                    : [],
            }
            return
        }

        // ── Coinflow (cartão OU wallet) — checa ANTES do wallet-token do Sentinel,
        //    senão um apple_pay/google_pay da Coinflow cairia no fluxo do Sentinel.
        //    • token       → CardForm (cartão novo)
        //    • paymentId   → Apple/Google Pay já cobrado pelo botão (skip-charge)
        if (dto.coinflow?.token || dto.coinflow?.paymentId) {
            dto.payment_data = {
                ...(dto.payment_data ?? {}),
                coinflowToken: dto.coinflow.token ?? null,
                coinflowPaymentId: dto.coinflow.paymentId ?? null,
                expMonth: dto.coinflow.expMonth,
                expYear: dto.coinflow.expYear,
                coinflowProtectionHeaders: dto.coinflow.protectionHeaders ?? null,
            }
            return
        }

        // ── Carteiras (Apple/Google Pay) ──
        // Sentinel agora é HOSTED (payment_method google_pay/apple_pay → hosted_url):
        // NÃO precisa de token — o cliente paga na página hosted. Se vier um token
        // (fluxo legado), repassa; senão segue sem instrumento (o provider cria a
        // sessão hosted). Coinflow (token/paymentId) já foi tratado acima.
        if (method === 'apple_pay' || method === 'google_pay') {
            const token = dto.wallet?.payment_token ?? dto.payment_data?.walletToken
            if (token) dto.payment_data = { ...(dto.payment_data ?? {}), walletToken: token }
            return
        }

        // ── Coinflow: token do CardForm (tokenizado no client) + exp + headers
        //    de proteção (Chargeback Protection) ──
        if (dto.coinflow?.token) {
            dto.payment_data = {
                ...(dto.payment_data ?? {}),
                coinflowToken: dto.coinflow.token,
                expMonth: dto.coinflow.expMonth,
                expYear: dto.coinflow.expYear,
                coinflowProtectionHeaders: dto.coinflow.protectionHeaders ?? null,
            }
            return
        }

        // ── Cartão cifrado (envelope) ──
        if (dto.card_encrypted) {
            const card = this.cardCrypto.decryptCardEnvelope(dto.card_encrypted)

            // Cross-check anti-tamper com os metadados em claro (dto.card)
            const meta = dto.card ?? {}
            const last4 = String(card.number).slice(-4)
            if (meta.last4 && String(meta.last4) !== last4) {
                throw new BadRequestException({ code: 'TAMPER', message: 'card.last4 não confere' })
            }
            if (meta.brand && card.brand && String(meta.brand).toLowerCase() !== String(card.brand).toLowerCase()) {
                throw new BadRequestException({ code: 'TAMPER', message: 'card.brand não confere' })
            }

            dto.payment_data = {
                ...(dto.payment_data ?? {}),
                cardNumber: card.number,
                cvv: card.cvv,
                expMonth: card.expiryMonth,
                expYear: card.expiryYear,
                cardBrand: card.brand ?? meta.brand,
            }

            if (card.document && !dto.customer?.document) {
                dto.customer = { ...(dto.customer ?? {}), document: card.document }
            }
        }
        // Sem card_encrypted: mantém dto.payment_data como veio (rota de teste/legado).
    }

    async uploadSpeiProof(sellerId: string, transactionId: string, input: any) {
        const { data: tx, error } = await supabase.from('transactions')
            .select('id, seller_id, method, status, amount, currency, metadata')
            .eq('id', transactionId).eq('seller_id', sellerId).single()
        if (error || !tx) throw new BadRequestException('Transação não encontrada.')
        if (tx.method !== 'spei' || tx.status !== 'pending') {
            throw new BadRequestException('Esta transação não aceita comprovante SPEI.')
        }
        if (!tx.metadata?.spei_reservation_id) throw new BadRequestException('Reserva SPEI ausente.')

        const path = await this.storage.uploadSpeiReceipt({
            sellerId, transactionId, base64: String(input?.base64 ?? ''), mime: String(input?.mime ?? ''),
        })
        const uploadedAt = new Date().toISOString()
        const metadata = {
            ...(tx.metadata ?? {}), spei_proof_path: path,
            spei_proof_mime: input?.mime, spei_proof_name: input?.fileName ?? null,
            spei_proof_status: 'pending_analysis', spei_proof_uploaded_at: uploadedAt,
        }
        await supabase.from('transactions').update({ provider_status: 'proof_under_review', metadata })
            .eq('id', transactionId).eq('seller_id', sellerId)

        // Dispara o validador interno de imagem. A resposta do upload não fica
        // presa ao tempo do modelo; o checkout acompanha a decisão por polling.
        // Qualquer falha é convertida em revisão manual dentro de
        // analyzeSpeiProof — `pending_analysis` nunca pode ser estado terminal.
        void this.analyzeSpeiProof({ ...tx, metadata }).catch((e) =>
            console.error('[SPEI proof analyzer]', e?.message ?? e))
        return { success: true, transactionId, status: 'pending_analysis' }
    }

    async getSpeiProofStatus(sellerId: string, transactionId: string) {
        const { data: tx } = await supabase.from('transactions')
            .select('id, status, provider_status, metadata').eq('id', transactionId).eq('seller_id', sellerId).single()
        if (!tx) throw new BadRequestException('Transação não encontrada.')
        return {
            transactionId: tx.id, status: tx.status, providerStatus: tx.provider_status,
            proofStatus: tx.metadata?.spei_proof_status ?? 'not_uploaded',
        }
    }

    // Janela do upsell pós-compra: passado disto a oferta de um clique já não é
    // pós-compra, e cobrar sem o comprador na página vira risco de chargeback.
    private static readonly UPSELL_WINDOW_MS = 60 * 60 * 1000
    /** Última consulta ao provedor por transação (ver confirmAtProvider). */
    private static readonly providerPulls = new Map<string, number>()
    private static readonly PROVIDER_PULL_INTERVAL_MS = 2_000
    private static readonly CLIP_RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000
    private static readonly CLIP_RECONCILE_GRACE_MS = 60 * 1000
    private static readonly CLIP_RECONCILE_BATCH = 50

    /**
     * Compra-mãe apta a upsell de um clique: Whop (cartão salvo, até 1 h) ou
     * Clip (token extra da compra ainda válido), aprovada.
     */
    private async loadUpsellParent(sellerId: string, transactionId: string) {
        const { data: parent } = await supabase.from('transactions')
            .select('id, seller_id, provider, provider_account_id, status, approved_at, metadata')
            .eq('id', transactionId).eq('seller_id', sellerId).maybeSingle()

        if (!parent) return { parent: null, reason: 'not_found' }
        const provider = this.normalizeProviderName(parent.provider)
        if (provider !== 'whop' && provider !== 'clip') return { parent: null, reason: 'unsupported_provider' }
        if (parent.status !== 'approved') return { parent: null, reason: 'not_approved' }
        if (!parent.provider_account_id) return { parent: null, reason: 'no_account' }

        // Clip: não há cartão salvo — vale enquanto sobrar token extra da
        // compra (~15 min). A janela de 1 h não se aplica: quem manda é o token.
        if (provider === 'clip') {
            const available = await this.clipAccounts.availableUpsellTokens(parent.id)
            return available > 0
                ? { parent, reason: null }
                : { parent: null, reason: 'no_saved_payment_method' }
        }
        if (!parent.metadata?.whop_member_id || !parent.metadata?.whop_payment_method_id) {
            // Pix, cripto e afins não ficam salvos; e compra feita sem
            // setup-future-usage no embed também não.
            return { parent: null, reason: 'no_saved_payment_method' }
        }
        const approvedAt = parent.approved_at ? Date.parse(parent.approved_at) : NaN
        if (!Number.isFinite(approvedAt) || Date.now() - approvedAt > PaymentService.UPSELL_WINDOW_MS) {
            return { parent: null, reason: 'window_expired' }
        }
        // A lista de métodos da Whop diz se o cartão é cobrável off-session, mas
        // ela NÃO decide: em produção respondeu "não" para cartão que a compra
        // tinha acabado de salvar, e toda oferta virou "não está mais
        // disponível". Fica como sinal no log; quem decide é a cobrança.
        void this.savedMethodChargeable(parent)
        return { parent, reason: null }
    }

    /**
     * Cartão salvo da compra-mãe cobrável off-session, pela lista de métodos da
     * Whop. Hoje é só observação: a consulta respondeu "não" para cartão recém
     * salvo e derrubou ofertas legítimas, então ela não bloqueia mais nada.
     * Ligar com WHOP_UPSELL_METHOD_CHECK=true só depois de conferir, no log,
     * que ela concorda com a realidade.
     */
    private async savedMethodChargeable(parent: any): Promise<boolean | null> {
        try {
            if (process.env.WHOP_UPSELL_METHOD_CHECK !== 'true') return null
            const account: any = await this.accountRouter.resolveAccountById(parent.provider_account_id)
            if (!account?.apiKey) return null
            return await new WhopProvider().isSavedMethodChargeable({
                apiUrl: account.api_url,
                apiKey: account.apiKey,
                memberId: String(parent.metadata.whop_member_id),
                paymentMethodId: String(parent.metadata.whop_payment_method_id),
            })
        } catch (err: any) {
            console.error('[PaymentService] upsell: método salvo:', err?.message ?? err)
            return null
        }
    }

    async checkUpsellEligibility(sellerId: string, transactionId: string) {
        const { parent, reason } = await this.loadUpsellParent(sellerId, transactionId)
        return { eligible: Boolean(parent), reason }
    }

    private async requireUpsellParent(sellerId: string, transactionId: string) {
        const { parent, reason } = await this.loadUpsellParent(sellerId, transactionId)
        if (!parent) {
            throw new BadRequestException({
                message: 'Upsell indisponível para esta compra.',
                error: `UPSELL_${String(reason).toUpperCase()}`,
            })
        }
        return parent
    }

    async getTransactionStatus(sellerId: string, transactionId: string) {
        const columns = 'id, status, provider_status, provider_transaction_id, failure_message, metadata, amount, currency, payment_brand, payment_last4, provider, provider_account_id'
        let { data } = await supabase.from('transactions')
            .select(columns)
            .eq('id', transactionId).eq('seller_id', sellerId).single()
        if (!data) throw new BadRequestException('Transação não encontrada.')

        // Quem está esperando é o comprador, na tela de resultado. Em vez de
        // aguardar o aviso da Whop chegar (fila + entrega + retentativa, ~13 s
        // medidos, e às vezes entrega que falha), perguntamos à fonte e
        // aplicamos pelo mesmo caminho do webhook. O webhook continua valendo:
        // isto só deixa de depender de ele ser o ÚNICO caminho.
        if (await this.confirmAtProvider(data)) {
            const refreshed = await supabase.from('transactions')
                .select(columns)
                .eq('id', transactionId).eq('seller_id', sellerId).single()
            if (refreshed.data) data = refreshed.data
        }
        // Bandeira informada pelo processador (webhook da Whop) — o checkout grava
        // no pedido. 'unknown' é o que o checkout mandou sem saber: não serve.
        const brand = String(data.metadata?.whop_card_brand ?? data.payment_brand ?? '').toLowerCase()
        const last4 = String(data.metadata?.whop_card_last4 ?? data.payment_last4 ?? '').replace(/\D/g, '').slice(-4)
        const card = brand && brand !== 'unknown'
            ? { brand, last4: last4 || null, methodType: data.metadata?.whop_payment_method_type ?? null }
            : null
        return {
            transactionId: data.id, status: data.status, providerStatus: data.provider_status,
            providerTransactionId: data.provider_transaction_id,
            proofStatus: data.metadata?.spei_proof_status ?? null,
            failureMessage: data.failure_message ?? null,
            // Cobrança off-session desafiada pelo banco: link da Whop para o
            // comprador autenticar (3DS). Gravado pelo webhook.
            recoveryUrl: data.metadata?.whop_recovery_url ?? null,
            // Disputa aberta na Whop (webhook dispute.*). O checkout só aceita o
            // aviso payment.disputed se isto existir.
            // Stripe grava em stripe_dispute (charge.dispute.*) — mesmo aviso.
            disputeStatus: data.metadata?.whop_dispute?.status
                ?? data.metadata?.stripe_dispute?.status
                ?? data.metadata?.paypal_dispute?.status
                ?? null,
            // Nome da cobrança (Whop). O checkout usa quando o pedido não tem nome
            // — produto digital só coleta e-mail no formulário da loja.
            customerName: data.metadata?.whop_billing_name ?? null,
            card,
            // Renovação de assinatura: transação filha. O checkout só cria o pedido
            // de renovação se isto apontar para a compra do pedido original.
            renewalOf: data.metadata?.renewal_of_transaction_id ?? null,
            renewalCycle: data.metadata?.renewal_cycle ?? null,
            amount: data.amount ?? null,
            currency: data.currency ?? null,
        }
    }

    // ─── PayPal (conta do seller): captura depois da aprovação do comprador ──
    //
    // Os botões do PayPal só APROVAM a order; a captura é aqui, no servidor,
    // com a credencial do seller. COMPLETED aprova pela MESMA via idempotente
    // do webhook (handleWebhookProvider), que dispara o postback normal — se o
    // webhook PAYMENT.CAPTURE.COMPLETED chegar antes ou depois, só um aprova.
    //
    // Resposta: formatResponse (status approved | pending). Recusa e estado
    // inválido viram 4xx com código, nunca 5xx (o checkout mostra a mensagem).
    async capturePaypalOrder(sellerId: string, transactionId: string) {
        const { data: tx } = await supabase.from('transactions')
            .select('*').eq('id', transactionId).eq('seller_id', sellerId).maybeSingle()
        if (!tx) throw new NotFoundException({ error: 'TRANSACTION_NOT_FOUND', message: 'Transação não encontrada.' })

        if (this.normalizeProviderName(tx.provider) !== 'paypal' || !isPaypalOwnAccountId(tx.provider_account_id)) {
            throw new ConflictException({ error: 'NOT_PAYPAL', message: 'Esta transação não é um pagamento PayPal.' })
        }
        if (tx.status === 'approved') return this.formatResponse(tx)
        if (['refunded', 'chargeback'].includes(String(tx.status))) {
            throw new ConflictException({ error: 'INVALID_STATE', status: tx.status, message: 'Este pagamento não pode mais ser capturado.' })
        }
        const orderId = tx.provider_transaction_id ?? tx.metadata?.client_flow?.paypal_order_id
        if (!orderId) {
            throw new ConflictException({ error: 'ORDER_NOT_CREATED', message: 'O pagamento PayPal ainda não foi criado.' })
        }

        // Conta resolvida pela TRANSAÇÃO, nunca pelo pedido do navegador: a
        // order só é capturável pela credencial do app que a criou.
        const account: any = await this.accountRouter.resolveAccountById(tx.provider_account_id)
        if (!account?.apiKey || !account?.apiSecret) {
            throw new ConflictException({ error: 'ACCOUNT_UNAVAILABLE', message: 'Conta PayPal do vendedor indisponível.' })
        }

        const outcome = await new PaypalProvider().capture({ providerConfig: account, orderId, transactionId: tx.id })

        if (outcome.outcome === 'declined') {
            // INSTRUMENT_DECLINED: o comprador pode trocar a forma de pagamento
            // na mesma order (actions.restart) — a transação segue pendente.
            if (!outcome.retryable) {
                await this.webhookService.handleWebhookProvider({
                    reference: tx.id,
                    status: 'FAILED',
                    type: 'TRANSACTION',
                    failure_code: outcome.code,
                    failure_message: outcome.message,
                })
            }
            throw new BadRequestException({
                error: outcome.code,
                message: outcome.message,
                status: outcome.retryable ? 'pending' : 'failed',
                retryable: outcome.retryable,
                transactionId: tx.id,
            })
        }

        const metadata = {
            ...(tx.metadata ?? {}),
            paypal_order_id: orderId,
            ...(outcome.captureId ? { paypal_capture_id: outcome.captureId } : {}),
        }
        await supabase.from('transactions').update({ metadata, provider_status: outcome.outcome === 'paid' ? 'captured' : 'capture_pending' })
            .eq('id', tx.id)

        if (outcome.outcome === 'paid') {
            // Nunca aprova sem conferir: captura de OUTRA transação (custom_id)
            // ou de outro valor fica pendente para conciliação, com alarme.
            const mismatch = paypalCaptureMismatch(tx, outcome)
            if (mismatch) {
                console.error(`[PaymentService] 🚨 PayPal: captura ${outcome.captureId} não confere com ${tx.id}: ${mismatch}`)
            } else {
                await this.webhookService.handleWebhookProvider({ reference: tx.id, status: 'PAID', type: 'TRANSACTION' })
            }
        }

        const { data: fresh } = await supabase.from('transactions').select('*').eq('id', tx.id).single()
        return this.formatResponse(fresh ?? { ...tx, metadata })
    }

    /**
     * Pergunta o pagamento à Whop e aplica o resultado, se ela já decidiu.
     * Devolve true quando algo mudou — aí quem chamou relê a transação.
     *
     * Só vale para transação ainda indefinida e com pagamento criado no
     * provedor. Uma consulta por transação a cada 2 s: a tela do comprador
     * pergunta de 3 em 3 segundos e várias abas não podem virar várias
     * chamadas à Whop.
     */
    /**
     * Clip depois do 3DS: a cobrança voltou `pending` com o desafio do banco e
     * a Clip não manda webhook. Quem pergunta o status (tela de resultado,
     * página do funil) confirma aqui, na fonte, e o teto é capturado.
     */
    private async confirmClipAtProvider(tx: any): Promise<boolean> {
        if (tx.status !== 'pending' || !tx.provider_transaction_id || !tx.provider_account_id) return false

        const last = PaymentService.providerPulls.get(tx.id) ?? 0
        if (Date.now() - last < PaymentService.PROVIDER_PULL_INTERVAL_MS) return false
        PaymentService.providerPulls.set(tx.id, Date.now())

        try {
            const account: any = await this.accountRouter.resolveAccountById(tx.provider_account_id)
            if (!account?.apiKey) return false
            const r = await new ClipProvider().retrieve({
                providerTransactionId: tx.provider_transaction_id,
                providerConfig: { id: account.id, apiKey: account.apiKey, config: account.config },
            })
            const mapped = r.status === 'paid' ? 'PAID' : r.status === 'failed' ? 'FAILED' : null
            if (!mapped) return false

            const reservationId = tx.metadata?.clip_reservation_id
            if (mapped === 'PAID' && reservationId) {
                const reservation = await this.clipAccounts.getReservation(reservationId)
                const isUpsell = !!tx.metadata?.clip_upsell_of
                void this.clipAccounts.capture({
                    reservationId,
                    amountMinor: isUpsell ? Math.round(Number(tx.amount)) : Number(reservation?.amount_minor ?? tx.amount),
                    clipPaymentId: tx.provider_transaction_id,
                    kind: isUpsell ? `upsell:${tx.id}` : 'base',
                    source: 'clip-status',
                })
            } else if (mapped === 'FAILED' && reservationId && !tx.metadata?.clip_upsell_of) {
                void this.clipAccounts.release(reservationId, 'declined')
            }

            // Motivo da recusa vindo da Clip (ex.: CA-AUT01 = 3DS não concluído).
            // Antes ia vazio e a única forma de saber era perguntar à Clip.
            const detail = r.raw?.status_detail ?? {}
            const failure = mapped === 'FAILED' ? clipFailureReason(detail.code, detail.message) : null

            await this.webhookService.handleWebhookProvider({
                reference: tx.id,
                status: mapped,
                type: 'TRANSACTION',
                ...(failure ?? {}),
            })
            return true
        } catch (err: any) {
            console.error('[PaymentService] confirmação Clip na fonte:', err?.message ?? err)
            return false
        }
    }

    /**
     * Cartões Clip que ficaram no 3DS e ninguém voltou para perguntar.
     *
     * A confirmação acima só roda quando a tela do comprador consulta o status.
     * Quem fecha a aba no banco (ou cai fora depois de aprovar) deixava o
     * pedido pendente para sempre, com o dinheiro já na Clip. Esta varredura
     * faz a mesma pergunta pelo servidor — ver ClipReconcilerService.
     *
     * Só olha a janela em que o desfecho ainda pode chegar; depois dela a
     * cobrança que continua `pending` na Clip é desafio abandonado.
     */
    async reconcilePendingClip(now = new Date()) {
        const since = new Date(now.getTime() - PaymentService.CLIP_RECONCILE_WINDOW_MS).toISOString()
        // A tela do comprador pergunta de 3 em 3 s; o primeiro minuto é dela.
        const until = new Date(now.getTime() - PaymentService.CLIP_RECONCILE_GRACE_MS).toISOString()
        const { data, error } = await supabase.from('transactions')
            .select('id, status, provider, provider_transaction_id, provider_account_id, metadata, amount')
            .eq('provider', 'clip').eq('status', 'pending')
            .not('provider_transaction_id', 'is', null)
            .gte('processed_at', since).lte('processed_at', until)
            .order('processed_at', { ascending: true })
            .limit(PaymentService.CLIP_RECONCILE_BATCH)
        if (error) {
            console.error('[PaymentService] varredura Clip:', error.message)
            return { checked: 0, resolved: 0 }
        }

        let resolved = 0
        for (const tx of data ?? []) {
            if (await this.confirmClipAtProvider(tx)) resolved += 1
        }
        return { checked: data?.length ?? 0, resolved }
    }

    /**
     * Webhook da Clip (POST /webhook/clip). Ela manda, sim — e o 404 fazia ela
     * repetir de hora em hora. O corpo NÃO é confiável (sem assinatura que a
     * gente conheça): só tiramos dele o id do pagamento e perguntamos à Clip,
     * pelo mesmo caminho da varredura. Um id que não casa é ignorado.
     */
    async handleClipWebhook(body: any) {
        const ids = [body?.id, body?.payment_id, body?.paymentId, body?.data?.id, body?.data?.payment_id,
            body?.payment?.id, body?.resource?.id]
            .filter((v): v is string => typeof v === 'string' && /^[\w-]{6,80}$/.test(v))
        console.log(`[ClipWebhook] evento=${body?.event ?? body?.type ?? body?.event_type ?? '-'} `
            + `status=${body?.status ?? body?.data?.status ?? '-'} ids=${ids.length} chaves=${Object.keys(body ?? {}).join(',')}`)
        if (!ids.length) return { received: true }

        const { data } = await supabase.from('transactions')
            .select('id, status, provider, provider_transaction_id, provider_account_id, metadata, amount')
            .eq('provider', 'clip').in('provider_transaction_id', [...new Set(ids)])
            .limit(5)
        for (const tx of data ?? []) await this.confirmClipAtProvider(tx)
        return { received: true }
    }

    private async confirmAtProvider(tx: any): Promise<boolean> {
        if (!tx || ['approved', 'refunded', 'chargeback'].includes(String(tx.status))) return false
        if (this.normalizeProviderName(tx.provider) === 'clip') return this.confirmClipAtProvider(tx)
        if (this.normalizeProviderName(tx.provider) !== 'whop') return false
        const paymentId = tx.metadata?.whop_payment_id
        if (typeof paymentId !== 'string' || !paymentId) return false

        const last = PaymentService.providerPulls.get(tx.id) ?? 0
        if (Date.now() - last < PaymentService.PROVIDER_PULL_INTERVAL_MS) return false
        PaymentService.providerPulls.set(tx.id, Date.now())

        try {
            const account: any = await this.accountRouter.resolveAccountById(tx.provider_account_id)
            if (!account?.apiKey) return false
            const { status } = await new WhopProvider().getPaymentStatus(paymentId, account)
            const mapped = String(status ?? '').toLowerCase() === 'paid'
                ? 'PAID'
                : ['failed', 'uncollectible', 'void'].includes(String(status ?? '').toLowerCase())
                    ? 'FAILED'
                    : null
            if (!mapped) return false

            await this.webhookService.handleWebhookProvider({
                reference: tx.id,
                status: mapped,
                type: 'TRANSACTION',
            })
            return true
        } catch (err: any) {
            // A consulta é um atalho, não uma dependência: falhou, o comprador
            // continua esperando o webhook como antes.
            console.error('[PaymentService] confirmação na fonte:', err?.message ?? err)
            return false
        }
    }

    // ─── Assinatura do comprador (área do cliente) ───────────────────────────
    //
    // O checkout confere que o pedido é do comprador logado; aqui a transação
    // ainda é filtrada pelo vendedor dono da chave. Regras em customer-subscription.ts.

    async getCustomerSubscription(sellerId: string, transactionId: string) {
        const ctx = await this.loadWhopSubscription(sellerId, transactionId)
        return { subscription: ctx ? customerSubscriptionView(ctx.membership, ctx.tx.metadata) : null }
    }

    async cancelCustomerSubscription(sellerId: string, transactionId: string) {
        const ctx = await this.requireWhopSubscription(sellerId, transactionId)
        const current = customerSubscriptionView(ctx.membership, ctx.tx.metadata)
        // Clique duplo ou outra aba: já está agendado, não é erro.
        if (current.status === 'canceling') return { subscription: current }
        if (!current.canCancel) {
            const installments = current.installments !== null
            throw new BadRequestException({
                message: installments
                    ? 'Plano parcelado: o cancelamento é feito pelo suporte.'
                    : 'Esta assinatura não pode ser cancelada.',
                code: installments ? 'SUBSCRIPTION_INSTALLMENTS' : 'SUBSCRIPTION_NOT_CANCELLABLE',
            })
        }
        const membership = await this.callWhopMembership(() =>
            ctx.whop.cancelMembershipAtPeriodEnd(ctx.membership.id, ctx.account))
        await this.mirrorWhopMembership(ctx, membership)
        return { subscription: customerSubscriptionView(membership, ctx.tx.metadata) }
    }

    async reactivateCustomerSubscription(sellerId: string, transactionId: string) {
        const ctx = await this.requireWhopSubscription(sellerId, transactionId)
        const current = customerSubscriptionView(ctx.membership, ctx.tx.metadata)
        if (current.status === 'active' || current.status === 'trialing') return { subscription: current }
        if (!current.canReactivate) {
            throw new BadRequestException({
                message: 'Esta assinatura não pode ser reativada.',
                code: 'SUBSCRIPTION_NOT_REACTIVATABLE',
            })
        }
        const membership = await this.callWhopMembership(() =>
            ctx.whop.uncancelMembership(ctx.membership.id, ctx.account))
        await this.mirrorWhopMembership(ctx, membership)
        return { subscription: customerSubscriptionView(membership, ctx.tx.metadata) }
    }

    private async requireWhopSubscription(sellerId: string, transactionId: string) {
        const ctx = await this.loadWhopSubscription(sellerId, transactionId)
        if (!ctx) {
            throw new BadRequestException({
                message: 'Assinatura não encontrada para esta compra.',
                code: 'SUBSCRIPTION_NOT_FOUND',
            })
        }
        return ctx
    }

    private async loadWhopSubscription(sellerId: string, transactionId: string) {
        const { data: tx } = await supabase.from('transactions')
            .select('id, provider, provider_account_id, metadata')
            .eq('id', transactionId).eq('seller_id', sellerId).maybeSingle()
        if (!tx) throw new BadRequestException('Transação não encontrada.')
        if (this.normalizeProviderName(tx.provider) !== 'whop' || !isSubscriptionTransaction(tx.metadata)) {
            return null
        }

        // Espelho gravado pelo webhook membership.* — pode faltar (evento não
        // assinado na conta, ou ainda não chegou).
        const { data: row } = await supabase.from('whop_subscriptions')
            .select('whop_membership_id, whop_account_id')
            .eq('koopfy_transaction_id', tx.id)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        const accountId = row?.whop_account_id ?? tx.provider_account_id
        const account: any = accountId ? await this.accountRouter.resolveAccountById(accountId) : null
        if (!account?.apiKey) {
            console.error(`[PaymentService] assinatura ${tx.id}: conta Whop ${accountId ?? '-'} indisponível`)
            throw new ServiceUnavailableException({
                message: 'Assinatura indisponível no momento.',
                code: 'SUBSCRIPTION_UNAVAILABLE',
            })
        }

        const whop = new WhopProvider()
        let membershipId: string | null = row?.whop_membership_id ?? null
        // Sem o espelho: o payment da compra aponta a membership.
        if (!membershipId && tx.metadata?.whop_payment_id) {
            const { raw } = await this.callWhopMembership(() =>
                whop.getPaymentStatus(String(tx.metadata.whop_payment_id), account))
            membershipId = raw?.membership?.id ?? raw?.membership_id ?? null
        }
        if (!membershipId) return null

        const membership = await this.callWhopMembership(() => whop.getMembership(String(membershipId), account))
        return { tx, account, whop, membership }
    }

    private async callWhopMembership<T>(call: () => Promise<T>): Promise<T> {
        try {
            return await call()
        } catch (err: any) {
            console.error('[PaymentService] Whop membership:', err?.message)
            throw new ServiceUnavailableException({
                message: 'Assinatura indisponível no momento.',
                code: 'SUBSCRIPTION_UNAVAILABLE',
            })
        }
    }

    // Espelho local; a Whop segue sendo a fonte. Falhar aqui não desfaz o que a
    // Whop já aceitou.
    private async mirrorWhopMembership(
        ctx: { tx: { id: string }; account: { id: string } },
        membership: WhopMembershipState,
    ) {
        const { error } = await supabase.from('whop_subscriptions').upsert({
            whop_membership_id: membership.id,
            whop_account_id: ctx.account.id,
            koopfy_transaction_id: ctx.tx.id,
            status: membership.status ?? 'active',
            cancel_at_period_end: membership.cancelAtPeriodEnd,
            current_period_end: membership.renewalPeriodEnd,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'whop_membership_id' })
        if (error) console.warn('[PaymentService] whop_subscriptions não atualizada:', error.message)
    }

    private async analyzeSpeiProof(tx: any) {
        try {
            const result = await this.speiReceipts.validate({
                reservationId: tx.metadata.spei_reservation_id,
                fileRef: tx.metadata.spei_proof_path,
                fileType: tx.metadata.spei_proof_mime,
            })
            const decision = result.verdict === 'approved' ? 'approved'
                : result.verdict === 'rejected' ? 'rejected'
                    : 'manual_review'
            const { data: current } = await supabase.from('transactions').select('metadata, status')
                .eq('id', tx.id).single()
            if (!current || current.status !== 'pending') return

            // Os detalhes sensíveis permanecem em gw_spei_receipts. Aqui fica
            // só o necessário para o checkout e o CRM acompanharem o estado.
            const metadata = {
                ...(current.metadata ?? {}),
                spei_proof_status: decision,
                spei_proof_analysis: {
                    verdict: result.verdict,
                    confidence: result.confidence,
                    receiptId: result.receiptId ?? null,
                },
                spei_proof_analyzed_at: new Date().toISOString(),
            }
            if (decision === 'approved') {
                // validate() já captura a reserva atomicamente por
                // gw_spei_confirm_receipt. Aqui executamos os efeitos da venda:
                // status, wallet, KPI e postback.
                await supabase.from('transactions').update({ metadata })
                    .eq('id', tx.id).eq('status', 'pending')
                await this.webhookService.handleWebhookProvider({
                    reference: tx.id, status: 'PAID', type: 'TRANSACTION',
                })
            } else {
                await supabase.from('transactions').update({
                    provider_status: decision === 'rejected' ? 'proof_rejected' : 'proof_manual_review', metadata,
                }).eq('id', tx.id).eq('status', 'pending')
            }
        } catch (e: any) {
            // Falha de configuração, provider de IA ou migration ausente não
            // pode deixar o comprador num spinner eterno. Preserva o pedido e
            // encaminha para a fila humana.
            console.error('[SPEI proof analyzer]', e?.message ?? e)
            const { data: current } = await supabase.from('transactions').select('metadata, status')
                .eq('id', tx.id).single()
            if (!current || current.status !== 'pending') return
            await supabase.from('transactions').update({
                provider_status: 'proof_manual_review',
                metadata: {
                    ...(current.metadata ?? {}),
                    spei_proof_status: 'manual_review',
                    spei_proof_analyzed_at: new Date().toISOString(),
                },
            }).eq('id', tx.id).eq('status', 'pending')
        }
    }

    async getSellerById(id: string) {
        const { data } = await supabase
            .from('seller_profiles')
            .select('id, status, risk_level, enabled_methods, config, metadata, user_id, provider_default, provider_mid, country')
            .eq('id', id).single()
        return data
    }

    async registerKpi(data: { sellerId: string; method: string; amount: number; fee: number; status: string }) {
        const { error } = await supabase.rpc('increment_kpi_safe', {
            p_seller_id: data.sellerId, p_method: data.method || 'smart',
            p_amount: data.amount, p_fee: data.fee, p_status: data.status,
        })
        if (error) console.error('[PaymentService] KPI error:', error)
    }

    async uploadToNexor(
        input: any,
    ): Promise<any> {
        const { payment_id, tracking_number, tracking_carrier, tracking_url } = input;

        if (!payment_id) {
            return { success: false, message: 'Nexor: gatewayPaymentId (payment_id) ausente.' };
        }

        // objeto de tracking gravado na transação
        const trackingPayload = {
            status: 'synced',
            number: tracking_number,
            carrier: tracking_carrier || null,
            url: tracking_url,
            synced_at: new Date().toISOString(),
        };

        try {
            const { data, error } = await supabase
                .from('transactions')
                .update({ tracking: trackingPayload })
                .eq('id', payment_id)
                .select('id');

            if (error) {
                console.error(`[nexor] erro ao atualizar transaction: ${error.message}`);
                return { success: false, message: error.message };
            }

            // nenhuma transação encontrada para esse payment_id
            if (!data || data.length === 0) {
                console.warn(
                    `[nexor] nenhuma transaction com payment_id=${payment_id}`,
                );
                return {
                    success: false,
                    message: `Transação não encontrada (payment_id=${payment_id}).`,
                };
            }

            console.log(
                `[nexor] tracking atualizado em ${data.length} transaction(s) ` +
                `para payment_id=${payment_id}`,
            );
            return { success: true, raw: data };
        } catch (e: any) {
            console.error(`[nexor] upload falhou: ${e?.message ?? e}`);
            return { success: false, message: e?.message ?? 'erro desconhecido' };
        }
    }
}

/**
 * Venda na conta PRÓPRIA do seller: o checkout grava em payment_info e acumula
 * a comissão (USD) em billing_debits, cobrada no cartão dele.
 */
/** Provedor de uma conta própria pelo prefixo do id no roteador. */
function ownProviderOfAccountId(id: string): OwnProvider {
    if (isStripeOwnAccountId(id)) return 'stripe'
    if (isPaypalOwnAccountId(id)) return 'paypal'
    return 'whop'
}

/** Botões do PayPal: client id (público) e modo da conta. */
function paypalPublicConfig(account: any) {
    return {
        clientId: account.apiKey ?? account.config?.client_id ?? null,
        mode: account.config?.mode === 'test' ? 'test' as const : 'live' as const,
        charging: true,
    }
}

/** Venda roteada: o checkout confere a conta usada com a que montou o formulário. */
function withRouting<T extends Record<string, any>>(body: T, routed: { entry: { id: string }; provider: string } | null): T {
    return routed ? { ...body, routing: { enabled: true, account_id: routed.entry.id, provider: routed.provider } } : body
}

function withOwnAccount<T extends Record<string, any>>(body: T, ownAccount: Record<string, any> | null): T {
    return ownAccount ? { ...body, own_account: ownAccount } : body
}
