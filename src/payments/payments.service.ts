// nexor/src/payments/payment.service.ts

import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { CurrencyService } from '../currency/currency.service'
import { WalletService } from '../wallets/wallet.service'
import { AccountRouterService } from '../orchestrator/router/account-router.service'
import { getSellerFees, calculateFees } from '../shared/fee.calculator'
import { validateMbwayPhone } from '../utils/mbway.validator'
import { RetrieveResponse } from '../orchestrator/providers/viva.provider'

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
//
const NEXOR_PLATFORM_WALLET_REF = process.env.NEXOR_PLATFORM_WALLET_REF
    ?? (() => { throw new Error('NEXOR_PLATFORM_WALLET_REF env var is required') })()

const KOOPFY_PLATFORM_WALLET_REF = process.env.KOOPFY_PLATFORM_WALLET_REF
    ?? (() => { throw new Error('KOOPFY_PLATFORM_WALLET_REF env var is required') })()

// ─── Resolve qual wallet recebe o platform_fee ────────────────────────────────

type RiskLevel = 'WHITE' | 'GRAY' | 'HIGH' | string


function resolvePlatformWallet(riskLevel: RiskLevel): {
    walletRef: string
    role: 'platform'
    partner: 'nexor' | 'koopfy'
} {
    if (riskLevel === 'WHITE') {
        return {
            walletRef: KOOPFY_PLATFORM_WALLET_REF,
            role: 'platform',
            partner: 'koopfy',
        }
    }
    // GRAY, HIGH ou qualquer outro → Nexor
    return {
        walletRef: NEXOR_PLATFORM_WALLET_REF,
        role: 'platform',
        partner: 'nexor',
    }
}

// ─── Settlement payload pro Nexflow ──────────────────────────────────────────

interface SettlementRecipient {
    wallet_reference: string
    role: 'seller' | 'platform' | 'external_partner' | 'affiliate'
    amount_cents: number
    fee_type?: 'platform_fee' | 'external_fee'
    fee_pct?: number
    partner?: string
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

@Injectable()
export class PaymentService {

    constructor(
        private readonly currencyService: CurrencyService,
        private readonly walletService: WalletService,
        private readonly accountRouter: AccountRouterService,
    ) { }

    private static readonly REDIRECT_PROVIDERS = new Set(['viva'])

    private resolvePlatformWalletRef(partner: string): string {
        if (partner === 'koopfy') return KOOPFY_PLATFORM_WALLET_REF
        return NEXOR_PLATFORM_WALLET_REF
    }

    // ─── createPayment ────────────────────────────────────────────────────────

    async createPayment(dto: any) {
        let session: any = null
        let seller: any = null
        let candidates: any[] = []


        dto.method = dto.method === 'credit_card' ? 'card' : dto.method;

        if (dto.sessionId) {
            const { data, error } = await supabase
                .from('checkout_sessions').select('*').eq('id', dto.sessionId).single()
            if (error || !data) throw new BadRequestException('Invalid session')

            session = data

            console.log(session)

            await supabase.from('checkout_sessions')
                .update({ status: 'completed', consumed_at: new Date().toISOString() })
                .eq('id', session.id)

            seller = await this.getSellerById(session.seller_id)


            const routing = session.routing?.[dto.method]
            //if (!routing) throw new BadRequestException('Method not available in this session')

            candidates = [
                { id: routing.provider_account_id },
                ...(routing.candidates || []).map((c: any) => ({ id: c.id })),
            ]


        } else {
            seller = await this.getSellerById(dto.sellerId)
            const ctx = {
                sellerId: dto.sellerId, method: dto.method,
                amount: dto.amount, currency: dto.currency,
                country: dto.customer?.country, riskLevel: seller?.risk_level,
            }
            candidates = await this.accountRouter.getCandidateAccounts(ctx)
            if (!candidates.length) throw new BadRequestException('No provider available')
        }

        if (!seller) throw new BadRequestException('Seller not found')
        const effectiveSellerId = seller.id

        // 🔥 Resolve plataforma receptora do split baseado no risk_level
        const platformWallet = resolvePlatformWallet(seller.risk_level)

        // ─── Guards ────────────────────────────────────────────────────────────

        if (seller.status !== 'active') {
            const messages: Record<string, string> = {
                pending_review: 'Sua conta está em análise. Aguarde a aprovação da equipe.',
                suspended: 'Sua conta está suspensa. Entre em contato com o suporte.',
                rejected: 'Sua conta foi rejeitada. Entre em contato com o suporte.',
            }
            throw new ForbiddenException(messages[seller.status] ?? 'Conta não autorizada.')
        }

        if (dto.offerId) {
            const { data: offer } = await supabase
                .from('offers').select('id, status, name')
                .eq('id', dto.offerId).eq('seller_id', effectiveSellerId).maybeSingle()
            if (!offer) throw new BadRequestException('Oferta não encontrada.')
            if (offer.status !== 'approved') {
                const msgs: Record<string, string> = {
                    pending_review: `A oferta "${offer.name}" ainda está em análise.`,
                    rejected: `A oferta "${offer.name}" foi rejeitada.`,
                    suspended: `A oferta "${offer.name}" está suspensa.`,
                }
                throw new ForbiddenException(msgs[offer.status] ?? `Oferta "${offer.name}" não aprovada.`)
            }
        }

        if (dto.method === 'mbway') {
            const phone = dto.paymentData?.phone ?? dto.payment_data?.phone ?? dto.customer?.phone ?? null
            const mbway = validateMbwayPhone(phone)
            if (!mbway.valid) throw new BadRequestException(mbway.reason ?? 'Número de telefone inválido para MB Way.')
            if (!dto.paymentData) dto.paymentData = {}
            dto.paymentData.phone = mbway.normalized
        }

        // ─── FX ────────────────────────────────────────────────────────────────

        const amount = Math.round(Number(dto.amount))
        dto.amount = amount;
        const currency = dto.currency ?? session.currency
        const fx = await this.currencyService.convertToUSDWithFee(amount / 100, currency)
        const grossUSDcents = Math.round(fx.grossUSD * 100)
        const fxFeeUSDcents = Math.round(fx.feeUSD * 100)
        const netUSDcents = Math.round(fx.netUSD * 100)
        const fxFinalRate = fx.fxFinalRate

        // ─── External fee ──────────────────────────────────────────────────────

        const externalFee = await this.resolveExternalFee(dto.external_fee, netUSDcents, effectiveSellerId)

        // ─── Idempotência ──────────────────────────────────────────────────────

        let transaction: any = null
        if (dto.idempotencyKey) {
            const { data: existing } = await supabase
                .from('transactions').select('*')
                .eq('seller_id', effectiveSellerId)
                .eq('idempotency_key', dto.idempotencyKey).maybeSingle()
            if (existing) {
                if (existing.status === 'approved') return this.formatResponse(existing)
                if (existing.status === 'pending' && existing.provider_gateway_id) return this.formatResponse(existing)
                if (existing.status === 'failed' && existing.retry_blocked) return this.formatResponse(existing)
                transaction = existing
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
                    customer_country: dto.billing_address?.country ?? dto.customer?.country,
                    payment_last4: dto.payment_data?.cardNumber?.slice(-4),
                    payment_brand: dto.payment_data?.cardBrand,
                    ip: dto.context?.ip,
                    user_agent: dto.context?.userAgent,
                    device_id: dto.context?.deviceId,
                    session_id: dto.context?.sessionId ?? dto.sessionId ?? null,
                    idempotency_key: dto.idempotencyKey,
                    external_reference: dto.metadata?.orderId ?? null,
                    postback_url: dto.postback_url,
                    risk_level: seller.risk_level,
                    webhook_sent: false,
                    webhook_status: 'pending',
                    webhook_attempts: 0,
                    created_at: new Date().toISOString(),
                    // 🔥 Registra qual plataforma recebeu o split
                    platform_partner: platformWallet.partner,
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

        // ─── Calcula taxas ─────────────────────────────────────────────────────

        const sellerFees = await getSellerFees(effectiveSellerId)
        const baseFee = sellerFees
            ? calculateFees(netUSDcents / 100, sellerFees, {paymentMethod: dto.method})
            : this.defaultFeeResult(netUSDcents)

        const platformFeeCents = Math.round(baseFee.platformFee * 100)
        const reserveAmountCents = Math.round(baseFee.reserveAmount * 100)
        const externalFeeCents = externalFee?.amount_cents ?? 0
        const baseNetCents = Math.round(baseFee.netAmount * 100)
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
            platformWalletRef: platformWallet.walletRef,  // 🔥 Koopfy ou Nexor
            platformPartner: platformWallet.partner,
            externalFeeCents,
            externalWalletRef: externalFee?.recipient_id ?? null,
            externalFeePct: externalFee?.pct ?? null,
            netUSDcents,
            grossUSDcents,
            fxFeeUSDcents,
            fxFinalRate,
            sellerFeePct: sellerFees?.feePercentage ?? 9.99,
        })

        console.log(settlement)

        // ─── Provider ──────────────────────────────────────────────────────────

        const firstAccount = candidates[0]
        const providerName = this.normalizeProviderName(firstAccount?.provider)
        const isRedirect = PaymentService.REDIRECT_PROVIDERS.has(providerName)
        const enrichedDto = { ...dto, settlement }

        let result: any = null
        let lastError: any = null

        if (isRedirect) {
            try {
                result = await this.accountRouter.executeWithProvider({
                    providerAccountId: candidates[0].id,
                    dto: enrichedDto, transactionId: transaction.id,
                })
                await supabase.from('transaction_attempts').insert({
                    transaction_id: transaction.id,
                    provider_account_id: candidates[0].id,
                    status: result.status,
                })
            } catch (err: any) {
                lastError = err
                await supabase.from('transaction_attempts').insert({
                    transaction_id: transaction.id,
                    provider_account_id: candidates[0].id,
                    status: 'error', error: err.message,
                })
            }
        } else {
            for (const candidate of candidates) {
                try {
                    result = await this.accountRouter.executeWithProvider({
                        providerAccountId: candidate.id,
                        dto: enrichedDto, transactionId: transaction.id,
                    })
                    await supabase.from('transaction_attempts').insert({
                        transaction_id: transaction.id,
                        provider_account_id: candidate.id,
                        status: result.status,
                    })
                    if (result.success || result.status === 'declined') break
                } catch (err: any) {
                    lastError = err
                    await supabase.from('transaction_attempts').insert({
                        transaction_id: transaction.id,
                        provider_account_id: candidate.id,
                        status: 'error', error: err.message,
                    })
                }
            }
        }

        // ─── Falha total ───────────────────────────────────────────────────────
        if (!result?.success) {
            const now = new Date().toISOString()
            await supabase.from('transactions').update({
                status: 'failed',
                provider_status: result?.providerStatus ?? null,
                failure_code: result?.failureCode ?? lastError?.code ?? null,
                failure_message: result?.failureMessage ?? lastError?.message ?? null,
                error_message: lastError?.message ?? null,
                failed_at: now,
                processed_at: now,
            }).eq('id', transaction.id)

            await this.registerKpi({
                sellerId: effectiveSellerId,
                method: dto.method ?? 'smart',
                amount: netUSDcents,
                fee: 0,
                status: 'failed',
            })
            throw lastError ?? new BadRequestException('Provider failed to create order')
        }

        // ─── Atualiza transação ────────────────────────────────────────────────
        const now = new Date().toISOString()
        const finalStatus = result.status === 'requires_action'
            ? 'requires_action'
            : 'pending'

        const { error } = await supabase.from('transactions').update({
            status: finalStatus,
            provider_status: result.providerStatus ?? result.status,
            provider: result.provider ?? providerName,
            provider_account_id: result.accountId ?? candidates[0].id,
            provider_transaction_id: result.transactionId ?? null,
            failure_code: result.failureCode ?? null,
            failure_message: result.failureMessage ?? null,
            fee: platformFeeCents,
            net_amount: sellerNetCents,
            reserve_amount: reserveAmountCents,
            available_at: baseFee.availableAt.toISOString(),
            reserve_until: baseFee.reserveUntil.toISOString(),
            processed_at: now,
        }).eq('id', transaction.id)

        if (error) console.error('[PaymentService] update error:', error)


        // ─── KPIs ──────────────────────────────────────────────────────────────

        await this.registerKpi({
            sellerId: effectiveSellerId,
            method: dto.method,
            amount: netUSDcents,
            fee: platformFeeCents,
            status: 'pending',
        })


        return this.buildResponse(result, transaction.id, finalStatus)
    }

    // ─── Build settlement ─────────────────────────────────────────────────────

    private buildSettlement(args: {
        sellerWalletRef: string
        sellerNetCents: number
        platformFeeCents: number
        platformWalletRef: string      // 🔥 Koopfy ou Nexor dependendo do risk_level
        platformPartner: string      // 'koopfy' | 'nexor'
        externalFeeCents: number
        externalWalletRef: string | null
        externalFeePct: number | null
        netUSDcents: number
        grossUSDcents: number
        fxFeeUSDcents: number
        fxFinalRate: number
        sellerFeePct: number
    }): SettlementPayload {
        const {
            sellerWalletRef, sellerNetCents,
            platformFeeCents, platformWalletRef, platformPartner,
            externalFeeCents, externalWalletRef, externalFeePct,
            netUSDcents, grossUSDcents, fxFeeUSDcents, fxFinalRate, sellerFeePct,
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
                partner: platformPartner,   // 🔥 identifica quem recebeu
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

        // Sanity check
        const sum = recipients.reduce((s, r) => s + r.amount_cents, 0)
        if (sum !== netUSDcents) {
            console.warn(
                `[buildSettlement] Sum mismatch: ${sum} != ${netUSDcents}. ` +
                `seller=${sellerNetCents} platform=${platformFeeCents} ` +
                `external=${externalFeeCents} partner=${platformPartner}`,
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
                platformFee: updated.fee > 0
                    ? {
                        amount: updated.fee,
                        walletRef: this.resolvePlatformWalletRef(updated.platform_partner),
                        partner: updated.platform_partner,
                    }
                    : null,
            })
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
    private buildResponse(result: any, transactionId: string, status: string) {
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
        if (result.provider) body.provider = result.provider
        if (result.reference && result.entity) {
            body.reference = result.reference
            body.entity = result.entity
        }
        if (result.redirectUrl) body.redirectUrl = result.redirectUrl
        if (result.referenceData) body.referenceData = result.referenceData
        if (result.next_action) body.next_action = result.next_action

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
            ...extra,
        }
    }

    private normalizeProviderName(provider: any): string {
        if (!provider) return 'unknown'
        const raw = typeof provider === 'string'
            ? provider
            : (provider.constructor?.name ?? String(provider))
        return raw.toLowerCase().replace(/provider$/, '')
    }

    async getSellerById(id: string) {
        const { data } = await supabase
            .from('seller_profiles')
            .select('id, status, risk_level, enabled_methods, config, metadata, user_id')
            .eq('id', id).single()
        return data
    }

    private defaultFeeResult(netUSDcents: number) {
        return calculateFees(netUSDcents / 100, {
            sellerId: '', riskLevel: 'WHITE' as const,
            feePercentage: 9.99, feeFixedUsd: 0.30,
            settlementDays: 3, reservePercentage: 5.00,
            reserveHoldDays: 90, anticipationFeePct: 4.99,
        })
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