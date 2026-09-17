// ============================================================
// BACKEND SERVICES — dashboard modules
// Transactions | Wallet | Disputes | Transfers | PaymentMethods | Settings
// ============================================================

import { Injectable, BadRequestException, ConflictException, NotFoundException, UnauthorizedException, InternalServerErrorException, ServiceUnavailableException, Logger, Optional } from '@nestjs/common'
import { formatBusinessDate } from '../../shared/business-time'
import { WhopPayoutDestinationsService } from '../../orchestrator/whop/whop-payout-destinations.service'
import { supabase } from '../../lib/supabase.client'
import * as bcrypt from 'bcrypt';
import { generateKey, hashKey } from '../../utils/apikeys.utils';
import * as crypto from 'crypto';
import { notifySellerPayout } from '../../utils/seller-mail';
import { calculatePayoutFees, getEffectiveSellerFees, payoutCurrencyForMethod, publicFeeBreakdown, saleFeePct } from '../../shared/fee.calculator';
import {
  BLOCKED_METHODS,
  IDEMPOTENCY_KEY_PATTERN,
  MIN_WITHDRAW_USD,
  RequestPayoutDto,
  RequestPayoutResult,
  UnifiedPayoutResult,
  VALID_METHODS,
} from '../dto/request-payout.dto';

// Hash estável do que define o saque. Reusar a mesma chave com outro valor,
// método ou destino é recusado pelo banco em vez de devolver o saque anterior.
/**
 * Status do saque como o seller entende. `approved` e `processing` são saques
 * andando (aprovado, enviando para a conta) — não falhas.
 */
export function payoutStatusForSeller(status: string | null | undefined): string {
  if (status === 'completed') return 'paid'
  if (status === 'pending') return 'pending'
  if (status === 'approved' || status === 'processing') return 'processing'
  if (status === 'rejected') return 'rejected'
  return 'failed'
}

/** Conta de destino para o histórico — só a parte mascarada. */
export function describePayoutAccount(metadata: any): string | null {
  const d = metadata?.destination ?? {}
  const tail = (value: unknown) => {
    const text = String(value ?? '').replace(/\s/g, '')
    return text.length > 4 ? `••••${text.slice(-4)}` : text || null
  }
  if (d.whopPayoutMethodId) {
    return [d.bankName ?? d.whopMethodName, d.accountReference].filter(Boolean).join(' ') || null
  }
  if (d.achAccountNumber) return [d.bankName, tail(d.achAccountNumber)].filter(Boolean).join(' ')
  if (d.iban) return [d.bankName, tail(d.iban)].filter(Boolean).join(' ')
  if (d.pixKey) return `Pix ${tail(d.pixKey)}`
  return null
}

export function payoutRequestHash(
  amountCents: number,
  method: string,
  destination: Record<string, string>,
): string {
  const sortedDestination = Object.fromEntries(
    Object.entries(destination).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ amountCents, method, destination: sortedDestination }))
    .digest('hex')
}
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StorageService } from '../../lib/storage.service';
import { syncInstagram } from './profile-sync';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Converte centavos inteiros → dólares com 2 casas decimais */
const fromCents = (v: number | null | undefined): number =>
  Number((Number(v ?? 0) / 100).toFixed(2))

function paginate(page = 1, pageSize = 20) {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  return { from, to }
}

function paginatedResponse<T>(data: T[], total: number, page: number, pageSize: number) {
  return { data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

// ============================================================
// TRANSACTIONS SERVICE
// ============================================================

@Injectable()
export class TransactionsService {
  constructor(private readonly storage: StorageService) {}

  async list(sellerId: string, params: {
    page?: number; pageSize?: number
    status?: string; method?: string
    search?: string; dateFrom?: string; dateTo?: string
  }) {
    const { page = 1, pageSize = 20, status, method, search, dateFrom, dateTo } = params
    const { from, to } = paginate(page, pageSize)

    let q = supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      // Esconde 'requires_action' (hosted/redirect onde o cliente abriu o
      // iframe/redirect mas NÃO inseriu os dados) — não é uma venda/tentativa, o
      // seller não deve ver/contar. failed/pending são tentativas reais e ficam.
      .neq('status', 'requires_action')
      .order('created_at', { ascending: false })
      .range(from, to)

    if (status && status !== 'all') q = q.eq('status', status)
    if (method && method !== 'all') q = q.eq('method', method)
    if (dateFrom) q = q.gte('created_at', dateFrom)
    if (dateTo) q = q.lte('created_at', dateTo + 'T23:59:59')
    if (search) {
      q = q.or(
        `customer_name.ilike.%${search}%,customer_email.ilike.%${search}%,id.ilike.%${search}%,provider_transaction_id.ilike.%${search}%`
      )
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)

    const mapped = await Promise.all((data ?? []).map(async tx => ({
      id: tx.id,
      customer: tx.customer_name,
      customerEmail: tx.customer_email,
      country: tx.customer_country,
      paymentMethod: tx.method,
      // 🔥 amount em centavos → unidade da moeda original (BRL, EUR, etc.)
      amount: fromCents(tx.amount),
      currency: tx.currency,
      // 🔥 amount_usd_gross_cents → USD
      amountUSD: fromCents(tx.amount_usd_net_cents),
      status: tx.status,
      provider: tx.provider,
      providerTransactionId: tx.provider_transaction_id,
      // 🔥 fee e net_amount em centavos USD
      fee: fromCents(tx.fee),
      netAmount: fromCents(tx.net_amount),
      createdAt: tx.created_at,
      approvedAt: tx.approved_at,
      failedAt: tx.failed_at,
      riskLevel: tx.risk_level,
      riskScore: tx.risk_score,
      ip: tx.ip,
      cardLast4: tx.payment_last4,
      cardBrand: tx.payment_brand,
      // 🚚 Rastreio / envio (derivado do campo `tracking`)
      orderShipped: tx.tracking?.status === 'synced',
      trackingCode: tx.tracking?.number ?? null,
      trackingCarrier: tx.tracking?.carrier ?? null,
      trackingUrl: tx.tracking?.url ?? null,
      speiProofUrl: await this.storage.getSignedSpeiReceiptUrl(tx.metadata?.spei_proof_path),
      speiProofStatus: tx.metadata?.spei_proof_status ?? null,
      speiProofAnalysis: tx.metadata?.spei_proof_analysis ?? null,
    })))

    return paginatedResponse(mapped, count ?? 0, page, pageSize)
  }

  async getById(sellerId: string, id: string) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', id)
      .eq('seller_id', sellerId)
      .single()

    if (error || !data) throw new NotFoundException('Transação não encontrada')

    return {
      id: data.id,
      customer: data.customer_name,
      customerEmail: data.customer_email,
      country: data.customer_country,
      paymentMethod: data.method,
      amount: fromCents(data.amount),
      currency: data.currency,
      amountUSD: fromCents(data.amount_usd_gross_cents),
      status: data.status,
      provider: data.provider,
      providerTransactionId: data.provider_transaction_id,
      fee: fromCents(data.fee),
      netAmount: fromCents(data.net_amount),
      reserveAmount: fromCents(data.reserve_amount),
      // Processamento, orquestração, checkout, fixa e câmbio separados (nulo em venda antiga).
      feeBreakdown: publicFeeBreakdown(data.fee_breakdown),
      createdAt: data.created_at,
      approvedAt: data.approved_at,
      failedAt: data.failed_at,
      availableAt: data.available_at,
      riskLevel: data.risk_level,
      riskScore: data.risk_score,
      ip: data.ip,
      cardLast4: data.payment_last4,
      cardBrand: data.payment_brand,
      failureCode: data.failure_code,
      failureMessage: data.failure_message,
      webhookStatus: data.webhook_status,
      metadata: data.metadata,
      speiProofUrl: await this.storage.getSignedSpeiReceiptUrl(data.metadata?.spei_proof_path),
      speiProofStatus: data.metadata?.spei_proof_status ?? null,
      speiProofAnalysis: data.metadata?.spei_proof_analysis ?? null,
      // 🚚 Rastreio / envio (derivado do campo `tracking`)
      orderShipped: data.tracking?.status === 'synced',
      trackingCode: data.tracking?.number ?? null,
      trackingCarrier: data.tracking?.carrier ?? null,
      trackingUrl: data.tracking?.url ?? null,
    }
  }
}

// ============================================================
// WALLET SERVICE
// ============================================================

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name)

  // Opcional: o WalletService também é montado sem o OrchestratorModule
  // (testes, módulos que só creditam). Sem ele, ninguém saca pela Whop.
  constructor(@Optional() private readonly whopDestinations?: WhopPayoutDestinationsService) { }

  // ── Conta de recebimento ───────────────────────────────────────────────────
  // Seller com conta conectada saca pela Whop; os demais, pelos métodos
  // manuais. Misturar faria o CRM aprovar um Pix que ninguém paga.
  async getPayoutDestinations(sellerId: string, country?: unknown) {
    if (!this.whopDestinations) return { mode: 'manual' as const, saved: [], supported: [] }
    return this.whopDestinations.overview(sellerId, country)
  }

  async getPayoutDestinationFields(sellerId: string, query: Record<string, unknown>) {
    if (!this.whopDestinations) throw new BadRequestException('Sua conta não recebe saques pela Whop.')
    return this.whopDestinations.fields(sellerId, query)
  }

  private async resolvePayoutDestination(
    sellerId: string,
    dto: RequestPayoutDto,
    idempotencyKey?: string,
  ): Promise<Record<string, string>> {
    const whopMode = this.whopDestinations
      ? (await this.whopDestinations.overviewMode(sellerId)) === 'whop'
      : false

    if ((dto.method as string) === 'whop') {
      if (!whopMode) throw new BadRequestException('Sua conta não recebe saques pela Whop.')
      const destination = await this.whopDestinations!.resolveForRequest(sellerId, dto, idempotencyKey)
      // Só o que é exibível: id da conta e referência mascarada.
      return Object.fromEntries(
        Object.entries(destination).filter(([, value]) => value != null && value !== ''),
      ) as Record<string, string>
    }
    if (whopMode) {
      throw new BadRequestException('Sua conta recebe saques pela Whop: escolha uma conta salva ou informe uma nova.')
    }
    return this.buildDestination(dto)
  }

  async getBalance(sellerId: string) {
    const { data: balance, error } = await supabase
      .from('wallet_balance')
      .select('*')
      .eq('seller_id', sellerId)
      .single()


    const { data: nextPayout, error: Error } = await supabase
      .from('wallet_ledger')
      .select('amount, available_at, metadata')
      .eq('seller_id', sellerId)
      .eq('type', 'debit_payout')
      .eq('status', 'pending')
      .order('available_at', { ascending: true })
      .limit(1)
      .maybeSingle()


    // 🔥 wallet_balance armazena em centavos USD
    const available = fromCents(balance?.available_balance)
    const pending = fromCents(balance?.pending_balance)
    const reserved = fromCents(balance?.reserved_balance)
    const inTransit = fromCents(nextPayout?.amount)

    return {
      availableBalance: available,
      pendingBalance: pending,
      reservedBalance: reserved,
      inTransit,
      total: available + pending + reserved + inTransit,
      nextPayout: nextPayout ? {
        amount: fromCents(nextPayout.amount),
        date: formatBusinessDate(nextPayout.available_at),
        method: nextPayout.metadata.method,
      } : null,
    }
  }

  async getEntries(sellerId: string, params: {
    page?: number; pageSize?: number
    type?: string; search?: string
  }) {
    const { page = 1, pageSize = 20, type } = params
    const { from, to } = paginate(page, pageSize)

    let q = supabase
      .from('wallet_ledger')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (type && type !== 'all') {
      if (type === 'credit') q = q.in('type', ['credit_pending', 'credit_available', 'release_to_available', 'anticipation_release'])
      if (type === 'debit') q = q.in('type', ['debit_payout', 'fee_platform', 'anticipation_fee', 'chargeback_fee', 'chargeback_alert_fee', 'chargeback_debit', 'refund'])
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)

    const CREDIT_TYPES = ['credit_pending', 'credit_available', 'release_to_available', 'anticipation_release']

    // 🚚 Busca o tracking das transações de origem (só p/ entradas de crédito = venda)
    const creditTxIds = [...new Set(
      (data ?? [])
        .filter(e => CREDIT_TYPES.includes(e.type) && e.transaction_id)
        .map(e => e.transaction_id),
    )]

    const trackingMap = new Map<string, any>()
    if (creditTxIds.length > 0) {
      const { data: txs } = await supabase
        .from('transactions')
        .select('id, tracking')
        .in('id', creditTxIds)
      for (const t of txs ?? []) trackingMap.set(t.id, t.tracking)
    }

    const mapped = (data ?? []).map(entry => {
      const isCredit = CREDIT_TYPES.includes(entry.type)
      const tracking = isCredit ? trackingMap.get(entry.transaction_id) : null
      return {
        id: entry.id,
        type: isCredit ? 'credit' : 'debit',
        description: this.describeEntry(entry.type),
        // 🔥 amount em centavos → USD
        amount: fromCents(entry.amount),
        status: entry.status === 'completed' ? 'completed' : 'pending',
        date: formatBusinessDate(entry.created_at),
        transactionId: entry.transaction_id,
        // 🚚 Rastreio da venda de origem (débitos = false/null)
        orderShipped: isCredit ? tracking?.status === 'synced' : false,
        trackingCode: isCredit ? (tracking?.number ?? null) : null,
      }
    })

    return paginatedResponse(mapped, count ?? 0, page, pageSize)
  }

  async getPayouts(sellerId: string, params: { page?: number; pageSize?: number }) {
    const { page = 1, pageSize = 20 } = params
    const { from, to } = paginate(page, pageSize)

    const { data, error, count } = await supabase
      .from('wallet_ledger')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .eq('type', 'debit_payout')
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw new BadRequestException(error.message)

    const mapped = (data ?? []).map(p => ({
      id: p.id,
      method: p.metadata?.method ?? 'bank',
      bankAccount: describePayoutAccount(p.metadata),
      cryptoAddress: p.metadata?.destination?.cryptoAddress ?? null,
      cryptoNetwork: p.metadata?.destination?.cryptoNetwork ?? null,
      // 🔥 amount em centavos → USD
      amount: fromCents(p.amount),
      status: payoutStatusForSeller(p.status),
      date: formatBusinessDate(p.created_at),
      processedAt: p.available_at ? formatBusinessDate(p.available_at) : null,
    }))

    return paginatedResponse(mapped, count ?? 0, page, pageSize)
  }

  async creditPending(dto: {
    sellerId: string
    transactionId: string
    amount: number
    fee: number
    reserveAmount: number
    availableAt: Date | string | null
    reserveUntil: Date | string | null
  }) {
    const toISO = (d: Date | string | null): string => {
      if (!d) return new Date().toISOString()
      if (d instanceof Date) return d.toISOString()
      return d
    }

    const availableAtISO = toISO(dto.availableAt)
    const reserveUntilISO = toISO(dto.reserveUntil)

    const ledgerRows: any[] = [
      {
        seller_id: dto.sellerId,
        transaction_id: dto.transactionId,
        type: 'credit_pending',
        amount: dto.amount,        // 🔥 centavos — não converter aqui
        fee: dto.fee,
        currency: 'USD',
        status: 'pending',
        available_at: availableAtISO,
        created_at: new Date().toISOString(),
      },
    ]

    if (dto.reserveAmount > 0) {
      ledgerRows.push({
        seller_id: dto.sellerId,
        transaction_id: dto.transactionId,
        type: 'reserve_hold',
        amount: dto.reserveAmount,
        fee: 0,
        currency: 'USD',
        status: 'hold',
        available_at: reserveUntilISO,
        created_at: new Date().toISOString(),
      })
    }

    if (dto.fee > 0) {
      ledgerRows.push({
        seller_id: dto.sellerId,
        transaction_id: dto.transactionId,
        type: 'fee_platform',
        amount: dto.fee,
        fee: 0,
        currency: 'USD',
        created_at: new Date().toISOString(),
      })
    }

    const { error: insertError } = await supabase.from('wallet_ledger').insert(ledgerRows)

    if (insertError) {
      if ((insertError as any).code === '23505') return { alreadyProcessed: true }
      console.error('[WalletService] creditPending ledger error:', insertError)
      throw new Error('Failed to insert wallet ledger: ' + insertError.message)
    }

    // 🔥 add_pending_balance espera NUMERIC em USD (não centavos)
    // Converte centavos → USD antes de passar para o RPC
    const { error: balanceError } = await supabase.rpc('add_pending_balance', {
      p_seller_id: dto.sellerId,
      p_amount: dto.amount / 100,   // 🔥 centavos → USD
    })

    if (balanceError) {
      console.error('[WalletService] creditPending balance error:', balanceError)
      throw new Error('Failed to update pending balance: ' + balanceError.message)
    }

    return { success: true, availableAt: availableAtISO, reserveUntil: reserveUntilISO }
  }

  private describeEntry(type: string): string {
    const map: Record<string, string> = {
      credit_pending: 'Pagamento recebido',
      credit_available: 'Saldo liberado',
      reserve_hold: 'Reserva para chargeback',
      fee_platform: 'Taxa da plataforma',
      release_to_available: 'Reserva liberada',
      debit_payout: 'Saque realizado',
      anticipation_release: 'Antecipação de valores a liquidar',
      anticipation_fee: 'Taxa de antecipação',
      chargeback_debit: 'Chargeback',
      chargeback_fee: 'Taxa de chargeback',
      chargeback_alert_fee: 'Taxa de alerta de chargeback',
      refund: 'Estorno',
    }
    return map[type] ?? type
  }

  private usdToCents(usd: number): number {
    return Math.round(usd * 100)
  }

  // ── Chave Pix ──────────────────────────────────────────────────────────────
  //
  // Normaliza no formato que o PSP espera e barra lixo óbvio. Não confere
  // dígito verificador de CPF/CNPJ: a chave é validada de novo na liquidação,
  // e recusar aqui um documento válido seria pior que deixar passar.
  private normalizePixKey(type: string, rawKey: string): string {
    const key = rawKey.trim()
    if (!key) {
      throw new BadRequestException('Informe a chave Pix.')
    }

    if (type === 'cpf' || type === 'cnpj') {
      const digits = key.replace(/\D/g, '')
      const expected = type === 'cpf' ? 11 : 14
      if (digits.length !== expected) {
        throw new BadRequestException(
          `Chave Pix inválida: ${type.toUpperCase()} tem ${expected} dígitos.`,
        )
      }
      return digits
    }

    if (type === 'email') {
      const email = key.toLowerCase()
      if (email.length > 77 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) {
        throw new BadRequestException('Chave Pix inválida: e-mail incorreto.')
      }
      return email
    }

    if (type === 'phone') {
      const digits = key.replace(/\D/g, '')
      // Aceita com ou sem o código do país; grava sempre em E.164.
      const national = digits.startsWith('55') ? digits.slice(2) : digits
      if (national.length !== 10 && national.length !== 11) {
        throw new BadRequestException(
          'Chave Pix inválida: telefone com DDD e 8 ou 9 dígitos.',
        )
      }
      return `+55${national}`
    }

    if (type === 'random') {
      const evp = key.toLowerCase()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evp)) {
        throw new BadRequestException('Chave Pix aleatória inválida.')
      }
      return evp
    }

    throw new BadRequestException(
      'Tipo de chave Pix inválido. Use CPF, CNPJ, e-mail, telefone ou aleatória.',
    )
  }

  // ── Monta o objeto `destination` conforme o método ─────────────────────────
  //
  // Chaves em camelCase; o CRM normaliza pra snake_case ao exibir
  // (normalizeDestination em crm-admin.service.ts). Ao mexer aqui, mexer lá.
  private buildDestination(dto: RequestPayoutDto): Record<string, string> {
    const accountHolder = (dto.accountHolder ?? '').trim()
    const bankName = (dto.bankName ?? '').trim()

    if ((dto.method as string) === 'crypto') {
      const cryptoAddress = (dto.cryptoAddress ?? '').trim()
      const cryptoNetwork = (dto.cryptoNetwork ?? '').trim().toUpperCase()
      if (cryptoAddress.length < 10 || cryptoAddress.length > 200) {
        throw new BadRequestException('Endereço da carteira cripto inválido.')
      }
      if (!['TRC20', 'ERC20', 'BEP20'].includes(cryptoNetwork)) {
        throw new BadRequestException('Rede inválida. Use TRC20, ERC20 ou BEP20.')
      }
      return { cryptoAddress, cryptoNetwork, asset: 'USDT' }
    }
    if ((dto.method as string) === 'pix') {
      if (!accountHolder) {
        throw new BadRequestException('Nome do titular da chave é obrigatório.')
      }
      const pixKeyType = (dto.pixKeyType ?? '').trim().toLowerCase()
      const pixKey = this.normalizePixKey(pixKeyType, dto.pixKey ?? '')
      // `pixHolder` é o que o CRM exibe; `accountHolder` mantém o campo comum
      // aos demais métodos. Ao mexer aqui, conferir normalizeDestination.
      return {
        pixKey,
        pixKeyType,
        pixHolder: accountHolder,
        accountHolder,
        ...(bankName ? { bankName } : {}),
      }
    }

    if (!accountHolder) {
      throw new BadRequestException('Nome do titular da conta é obrigatório.')
    }

    if (dto.method === 'ach') {
      const achRoutingNumber = (dto.achRoutingNumber ?? '').replace(/\D/g, '')
      const achAccountNumber = (dto.achAccountNumber ?? '').replace(/\s/g, '')
      const achAccountType = (dto.achAccountType ?? 'checking').trim()

      // ABA routing number tem exatamente 9 dígitos — errar aqui devolve o
      // dinheiro dias depois, então vale barrar na entrada.
      if (achRoutingNumber.length !== 9) {
        throw new BadRequestException(
          'Routing number (ABA) deve ter 9 dígitos.',
        )
      }
      if (achAccountNumber.length < 4) {
        throw new BadRequestException('Número da conta inválido.')
      }
      if (!['checking', 'savings'].includes(achAccountType)) {
        throw new BadRequestException('Tipo de conta inválido.')
      }

      return {
        achRoutingNumber,
        achAccountNumber,
        achAccountType,
        accountHolder,
        ...(bankName ? { bankName } : {}),
      }
    }

    // iban
    const iban = (dto.iban ?? '').replace(/\s/g, '').toUpperCase()
    const swift = (dto.swift ?? '').replace(/\s/g, '').toUpperCase()

    // Formato do IBAN: 2 letras de país + 2 dígitos de verificação + até 30
    // alfanuméricos. Não valida o dígito verificador — só descarta lixo óbvio.
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
      throw new BadRequestException('IBAN inválido.')
    }
    if (swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)) {
      throw new BadRequestException('SWIFT/BIC inválido (8 ou 11 caracteres).')
    }

    return {
      iban,
      ...(swift ? { swift } : {}),
      accountHolder,
      ...(bankName ? { bankName } : {}),
    }
  }


  // ── Taxas do saque ─────────────────────────────────────────────────────────
  // Mínimo, % e fixa sobre o valor, e spread quando o saque é pago em outra
  // moeda (Pix em BRL, IBAN em EUR) — tudo da tarifa do seller no CRM.
  async quotePayout(sellerId: string, amountUsd: number, method: string) {
    const fees = await getEffectiveSellerFees(sellerId)
    const payoutCurrency = payoutCurrencyForMethod(method)
    const converted = payoutCurrency !== 'USD'
    const amountCents = Number.isFinite(amountUsd) && amountUsd > 0 ? this.usdToCents(amountUsd) : 0
    const calc = calculatePayoutFees(amountCents, fees, { currencyConverted: converted })
    return {
      minUsd: fees.payoutMinUsd,
      payoutCurrency,
      feePct: fees.payoutFeePct,
      feeFixedUsd: fees.payoutFeeFixedUsd,
      fxFeePct: converted ? fees.payoutFxFeePct : 0,
      amountCents: calc.amountCents,
      feeCents: calc.feeCents,
      fxFeeCents: calc.fxFeeCents,
      netCents: calc.netCents,
      amount: calc.amountCents / 100,
      fee: calc.feeCents / 100,
      fxFee: calc.fxFeeCents / 100,
      net: calc.netCents / 100,
      details: {
        payout_fee_pct: fees.payoutFeePct,
        payout_fee_fixed_usd: fees.payoutFeeFixedUsd,
        payout_fx_fee_pct: converted ? fees.payoutFxFeePct : 0,
      },
    }
  }

  private assertPayoutQuote(amountUsd: number, quote: { minUsd: number; netCents: number }) {
    if (amountUsd < quote.minUsd) {
      throw new BadRequestException(`O valor mínimo para saque é US$ ${quote.minUsd.toFixed(2)}.`)
    }
    if (quote.netCents <= 0) {
      throw new BadRequestException('O valor não cobre as taxas de saque.')
    }
  }

  // ── Caso de uso principal ──────────────────────────────────────────────────
  async requestPayout(
    dto: RequestPayoutDto,
  ): Promise<RequestPayoutResult> {
    const { data: seller, error: sellerError } = await supabase
      .from('seller_profiles')
      .select('provider_default')
      .eq('id', dto.sellerId)
      .maybeSingle()
    if (sellerError || !seller) {
      throw new BadRequestException('Seller não encontrado.')
    }
    // 1. Converte para centavos (formato do banco).
    //    O DTO já garantiu amount > 0 e >= mínimo via class-validator.
    const amountCents = this.usdToCents(dto.amount)


    // 3. 2FA — TODO.
    //    Ainda não implementado. Quando for, validar dto.twoFactorCode aqui
    //    (antes da RPC) ou dentro da própria função SQL.
    /* if (!dto.twoFactorCode) {
       this.logger.warn(
         'Saque solicitado sem código 2FA. 2FA não implementado.',
       )
     }*/

    // 4. Chama a RPC — toda a lógica de saldo (ler, travar, debitar
    //    available→pending, inserir no ledger) roda atômica no banco.
    const quote = await this.quotePayout(dto.sellerId, dto.amount, dto.method)
    this.assertPayoutQuote(dto.amount, quote)

    // Destino depois da cotação: na Whop, uma conta nova é cadastrada aqui —
    // não vale cadastrar para um saque que nem cobre as taxas.
    const destination = await this.resolvePayoutDestination(dto.sellerId, dto)

    const { data, error } = await supabase.rpc('request_payout', {
      p_seller_id: dto.sellerId,
      p_amount_cents: amountCents,
      p_method: dto.method,
      p_destination: destination,
      p_fee_cents: quote.feeCents,
      p_fx_fee_cents: quote.fxFeeCents,
      p_payout_currency: quote.payoutCurrency,
      p_fee_details: quote.details,
    })

    // 5. Tratamento de erro.
    if (error) {
      // Exceptions da função SQL (saldo insuficiente, valor mínimo, etc.)
      // chegam com a mensagem em error.message — erros de negócio
      // esperados → 400 com a mensagem original (a modal já exibe).
      this.logger.warn(
        `request_payout falhou: ${error.message} (code=${error.code})`,
      )

      if (error.code === '28000') {
        throw new UnauthorizedException(error.message)
      }
      throw new BadRequestException(
        error.message || 'Não foi possível processar o saque.',
      )
    }

    // A função retorna `table(...)` → array com uma linha.
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.payout_id) {
      this.logger.error('request_payout não retornou payout_id.')
      throw new BadRequestException('Não foi possível processar o saque.')
    }

    this.logger.log(
      `Saque criado: payoutId=${row.payout_id} method=${dto.method} amountCents=${amountCents}`,
    )

    // Aviso ao vendedor (fire-and-forget: e-mail nunca derruba o saque).
    void notifySellerPayout(dto.sellerId, 'requested', {
      amountCents,
      feeCents: quote.feeCents + quote.fxFeeCents,
      currency: 'USD',
      method: dto.method,
      payoutId: row.payout_id,
      destination,
      requestedAt: new Date().toISOString(),
    })

    // 6. Resposta — mantém o shape que a modal espera.
    return {
      payoutId: row.payout_id,
      status: 'processing', // exibido como "Em Processamento" na modal
    }
  }

  // ── Fluxo unificado (dash-checkout) ────────────────────────────────────────
  //
  // Mesma validação do saque acima, mas a criação passa por
  // `request_payout_idempotent`: repetir a chamada com a mesma chave devolve o
  // saque já criado. Não há fallback para `request_payout` — sem a função no
  // banco, o saque falha fechado.
  async requestPayoutIdempotent(
    sellerId: string,
    dto: RequestPayoutDto,
    idempotencyKey: string,
  ): Promise<UnifiedPayoutResult> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? '')) {
      throw new BadRequestException('Idempotency-Key inválido.')
    }
    this.assertPayoutInput(dto)

    const amountCents = this.usdToCents(dto.amount)
    const quote = await this.quotePayout(sellerId, dto.amount, dto.method)
    this.assertPayoutQuote(dto.amount, quote)
    // A mesma chave cadastra a mesma conta na Whop: o hash abaixo bate no retry.
    const destination = await this.resolvePayoutDestination(sellerId, dto, idempotencyKey)

    const { data, error } = await supabase.rpc('request_payout_idempotent', {
      p_seller_id: sellerId,
      p_idempotency_key: idempotencyKey,
      p_request_hash: payoutRequestHash(amountCents, dto.method, destination),
      p_amount_cents: amountCents,
      p_method: dto.method,
      p_destination: destination,
      p_fee_cents: quote.feeCents,
      p_fx_fee_cents: quote.fxFeeCents,
      p_payout_currency: quote.payoutCurrency,
      p_fee_details: quote.details,
    })

    if (error) {
      this.logger.warn(
        `request_payout_idempotent falhou: ${error.message} (code=${error.code})`,
      )
      if (error.code === 'KP409' || error.code === 'KP425') {
        throw new ConflictException(error.message)
      }
      if (error.code === '28000') {
        throw new UnauthorizedException(error.message)
      }
      // Função ausente no schema: a migration ainda não foi aplicada.
      if (error.code === 'PGRST202' || error.code === '42883') {
        throw new ServiceUnavailableException(
          'Solicitação de saque temporariamente indisponível.',
        )
      }
      if (error.code === 'KP500') {
        throw new InternalServerErrorException('Não foi possível confirmar o saque.')
      }
      throw new BadRequestException(
        error.message || 'Não foi possível processar o saque.',
      )
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row?.payoutId) {
      this.logger.error('request_payout_idempotent não retornou payoutId.')
      throw new InternalServerErrorException('Não foi possível confirmar o saque.')
    }

    const replayed = row.replayed === true
    this.logger.log(
      `Saque ${replayed ? 'repetido' : 'criado'}: payoutId=${row.payoutId} method=${dto.method} amountCents=${amountCents}`,
    )

    // Repetição com a mesma chave devolve o saque já criado: não avisa de novo.
    if (!replayed) {
      void notifySellerPayout(sellerId, 'requested', {
        amountCents,
        feeCents: quote.feeCents + quote.fxFeeCents,
        currency: 'USD',
        method: dto.method,
        payoutId: String(row.payoutId),
        destination,
        requestedAt: new Date().toISOString(),
      })
    }

    return {
      payoutId: String(row.payoutId),
      status: String(row.status ?? 'processing'),
      replayed,
    }
  }

  // O Pay não tem ValidationPipe global: o fluxo unificado confere aqui o que
  // o RequestPayoutDto declara com class-validator.
  private assertPayoutInput(dto: RequestPayoutDto) {
    const amount = dto?.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Informe um valor de saque válido.')
    }
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      throw new BadRequestException('O valor do saque aceita no máximo duas casas decimais.')
    }
    const methods: readonly string[] = [...VALID_METHODS, ...BLOCKED_METHODS]
    if (!methods.includes(dto.method as string)) {
      throw new BadRequestException('Método de saque inválido.')
    }
  }
}


// ============================================================
// DISPUTES SERVICE
// ============================================================

@Injectable()
export class DisputesService {

  async getStats(sellerId: string) {
    const { data } = await supabase
      .from('disputes')
      .select('status, amount')
      .eq('seller_id', sellerId)

    const rows = data ?? []
    const won = rows.filter(d => d.status === 'won').length
    const lost = rows.filter(d => d.status === 'lost').length

    return {
      total: rows.length,
      pending: rows.filter(d => ['pending', 'evidence_required'].includes(d.status)).length,
      won,
      lost,
      // 🔥 amount em centavos → USD
      totalAmount: rows.reduce((s, d) => s + fromCents(d.amount), 0),
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
    }
  }

  async list(sellerId: string, params: {
    page?: number; pageSize?: number
    status?: string; search?: string
  }) {
    const { page = 1, pageSize = 20, status, search } = params
    const { from, to } = paginate(page, pageSize)

    let q = supabase
      .from('disputes')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (status && status !== 'all') q = q.eq('status', status)
    if (search) {
      q = q.or(`customer_name.ilike.%${search}%,id.ilike.%${search}%,transaction_id.ilike.%${search}%`)
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)

    const mapped = (data ?? []).map(d => ({
      id: d.id,
      transactionId: d.transaction_id,
      customer: d.customer_name,
      customerEmail: d.customer_email,
      // 🔥 amount em centavos → USD
      amount: fromCents(d.amount),
      currency: d.currency ?? 'USD',
      reason: d.reason,
      reasonCode: d.reason_code,
      status: d.status,
      deadline: d.deadline ? formatBusinessDate(d.deadline) : null,
      createdAt: formatBusinessDate(d.created_at),
      seller: d.seller_name ?? 'Vendedor',
    }))

    return paginatedResponse(mapped, count ?? 0, page, pageSize)
  }

  async respond(sellerId: string, disputeId: string, body: {
    message: string; evidenceUrls?: string[]
  }) {
    const { data: dispute } = await supabase
      .from('disputes')
      .select('id, status, seller_id')
      .eq('id', disputeId)
      .eq('seller_id', sellerId)
      .single()

    if (!dispute) throw new NotFoundException('Disputa não encontrada')
    if (!['pending', 'evidence_required'].includes(dispute.status)) {
      throw new BadRequestException('Esta disputa não pode mais ser respondida')
    }

    await supabase
      .from('disputes')
      .update({
        status: 'pending',
        response_message: body.message,
        evidence_urls: body.evidenceUrls ?? [],
        respxaonded_at: new Date().toISOString(),
      })
      .eq('id', disputeId)

    return { message: 'Resposta enviada com sucesso' }
  }
}

// ============================================================
// TRANSFERS SERVICE
// ============================================================

@Injectable()
export class TransfersService {

  async getTotals(sellerId: string) {
    const { data, error } = await supabase.rpc('get_seller_transfer_totals', {
      p_seller_id: sellerId,
    })

    if (error) {
      console.error('[TransfersService.getTotals] RPC error:', error)
      // Fallback gracioso — retorna zeros em vez de quebrar a UI
      return { pending: 0, scheduled: 0, completed: 0, inTransit: 0 }
    }

    // RPC com `returns table` retorna array com 1 row
    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      return { pending: 0, scheduled: 0, completed: 0, inTransit: 0 }
    }

    return {
      pending: fromCents(row.pending_cents),
      scheduled: fromCents(row.scheduled_cents),
      completed: fromCents(row.completed_cents),
      inTransit: fromCents(row.in_transit_cents),
    }
  }

  async list(sellerId: string, params: {
    page?: number; pageSize?: number
    status?: string; search?: string
  }) {
    const { page = 1, pageSize = 20, status } = params
    const { from, to } = paginate(page, pageSize)

    let q = supabase
      .from('wallet_ledger')
      .select('*', { count: 'exact' })
      .eq('seller_id', sellerId)
      .eq('type', 'credit_pending')
      .order('created_at', { ascending: false })
      .range(from, to)

    if (status && status !== 'all') {
      const statusMap: Record<string, string> = {
        pending: 'pending', scheduled: 'hold', completed: 'completed', failed: 'failed',
      }
      if (statusMap[status]) q = q.eq('status', statusMap[status])
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)

    const { data: profile } = await supabase
      .from('seller_profiles').select('name').eq('id', sellerId).single()

    const mapped = (data ?? []).map(entry => {
      const entryStatus = entry.status === 'completed' ? 'completed'
        : entry.status === 'hold' ? 'scheduled'
          : entry.status === 'pending' ? 'pending'
            : 'failed'

      // 🔥 amount e fee em centavos → USD
      const amountUSD = fromCents(entry.amount)
      const feeUSD = fromCents(entry.fee ?? 0)

      return {
        id: entry.id,
        seller: profile?.name ?? 'Vendedor',
        sellerId,
        amount: amountUSD + feeUSD,
        fee: feeUSD,
        netAmount: amountUSD,
        status: entryStatus,
        releaseDate: entry.available_at
          ? formatBusinessDate(entry.available_at)
          : '-',
        createdAt: formatBusinessDate(entry.created_at),
        paidAt: entry.status === 'completed'
          ? formatBusinessDate(entry.created_at)
          : null,
        failReason: null,
        transactions: entry.transaction_id ? [{
          id: entry.transaction_id,
          date: formatBusinessDate(entry.created_at),
          amount: amountUSD,
          status: 'included',
        }] : [],
      }
    })

    return paginatedResponse(mapped, count ?? 0, page, pageSize)
  }

  async retry(sellerId: string, transferId: string) {
    const { data } = await supabase
      .from('wallet_ledger')
      .select('*').eq('id', transferId).eq('seller_id', sellerId).single()

    if (!data) throw new NotFoundException('Repasse não encontrado')
    if (data.status !== 'failed') throw new BadRequestException('Apenas repasses com falha podem ser reprocessados')

    await supabase.from('wallet_ledger').update({ status: 'pending' }).eq('id', transferId)
    return { message: 'Repasse reagendado com sucesso' }
  }
}

// ============================================================
// PAYMENT METHODS SERVICE
// ============================================================

@Injectable()
export class PaymentMethodsService {

  async list(sellerId: string) {
    const { data: profile } = await supabase
      .from('seller_profiles').select('enabled_methods, config, provider_default').eq('id', sellerId).single()

    const enabledMethods: string[] = profile?.enabled_methods ?? []
    const isWhopSeller = String(profile?.provider_default ?? '').toLowerCase().replace(/provider$/, '') === 'whop'

    // Tarifa efetiva (a do seller ou o padrão).
    const sellerFees = await getEffectiveSellerFees(sellerId)
    const feePercentage = saleFeePct(sellerFees)
    const feeFixedUsd = sellerFees.feeFixedUsd
    const settlementDays = sellerFees.settlementDays
    const reservePct = sellerFees.reservePercentage
    const anticipationPct = sellerFees.anticipationEnabled ? sellerFees.anticipationFeePct : 0
    const feesFormatted = `${feePercentage}% + $${Number(feeFixedUsd).toFixed(2)}`

    const { data: providers } = await supabase
      .from('provider_accounts').select('id, provider, supported_methods, status').eq('status', 'active')

    const dateFrom = new Date()
    dateFrom.setDate(dateFrom.getDate() - 30)

    const { data: kpis } = await supabase
      .from('seller_kpis')
      .select('method, approved_volume, approved_transactions, total_transactions')
      .eq('seller_id', sellerId)
      .gte('date_key', dateFrom.toISOString().split('T')[0])

    const metricsByMethod: Record<string, { volume: number; txs: number; approved: number; total: number }> = {}
    for (const k of kpis ?? []) {
      const method = ({ credit_card: 'card', debit_card: 'card', mbway: 'mb_way', sepa: 'sepa_debit' } as Record<string, string>)[k.method] ?? k.method
      if (!metricsByMethod[method]) metricsByMethod[method] = { volume: 0, txs: 0, approved: 0, total: 0 }
      // 🔥 approved_volume em centavos USD → USD
      metricsByMethod[method].volume += fromCents(k.approved_volume)
      metricsByMethod[method].txs += Number(k.approved_transactions)
      metricsByMethod[method].approved += Number(k.approved_transactions)
      metricsByMethod[method].total += Number(k.total_transactions)
    }

    const ALL_METHODS = [
      { id: 'card', name: 'Cartões', icon: 'card', category: 'card', countries: ['*'] },
      { id: 'apple_pay', name: 'Apple Pay', icon: 'apple_pay', category: 'wallet', countries: ['*'] },
      { id: 'google_pay', name: 'Google Pay', icon: 'google_pay', category: 'wallet', countries: ['*'] },
      { id: 'link', name: 'Link', icon: 'link', category: 'wallet', countries: ['*'] },
      { id: 'paypal', name: 'PayPal', icon: 'paypal', category: 'wallet', countries: ['*'] },
      { id: 'crypto', name: 'Criptomoedas', icon: 'crypto', category: 'wallet', countries: ['*'] },
      { id: 'pix', name: 'PIX', icon: 'pix', category: 'instant', countries: ['BR'] },
      { id: 'boleto', name: 'Boleto', icon: 'boleto', category: 'bank', countries: ['BR'] },
      { id: 'oxxo', name: 'OXXO', icon: 'oxxo', category: 'bank', countries: ['MX'] },
      { id: 'ideal', name: 'iDEAL', icon: 'ideal', category: 'instant', countries: ['NL'] },
      { id: 'bancontact', name: 'Bancontact', icon: 'bancontact', category: 'instant', countries: ['BE'] },
      { id: 'sepa_debit', name: 'SEPA Direct Debit', icon: 'sepa_debit', category: 'bank', countries: ['EU'] },
      { id: 'multibanco', name: 'Multibanco', icon: 'multibanco', category: 'bank', countries: ['PT'] },
      { id: 'mb_way', name: 'MB Way', icon: 'mb_way', category: 'instant', countries: ['PT'] },
      { id: 'blik', name: 'BLIK', icon: 'blik', category: 'instant', countries: ['PL'] },
      { id: 'p24', name: 'Przelewy24', icon: 'p24', category: 'instant', countries: ['PL'] },
      { id: 'eps', name: 'EPS', icon: 'eps', category: 'instant', countries: ['AT'] },
      { id: 'twint', name: 'TWINT', icon: 'twint', category: 'instant', countries: ['CH'] },
      { id: 'swish', name: 'Swish', icon: 'swish', category: 'instant', countries: ['SE'] },
      { id: 'revolut_pay', name: 'Revolut Pay', icon: 'revolut_pay', category: 'wallet', countries: ['EU'] },
      { id: 'klarna', name: 'Klarna', icon: 'klarna', category: 'wallet', countries: ['EU', 'US'] },
      { id: 'affirm', name: 'Affirm', icon: 'affirm', category: 'wallet', countries: ['US', 'CA'] },
      { id: 'afterpay_clearpay', name: 'Afterpay / Clearpay', icon: 'afterpay_clearpay', category: 'wallet', countries: ['US', 'CA', 'GB', 'AU', 'NZ'] },
      { id: 'cashapp', name: 'Cash App Pay', icon: 'cashapp', category: 'wallet', countries: ['US'] },
      { id: 'us_bank_account', name: 'Conta bancária US', icon: 'us_bank_account', category: 'bank', countries: ['US'] },
      { id: 'alipay', name: 'AliPay', icon: 'alipay', category: 'wallet', countries: ['CN'] },
      { id: 'wechat_pay', name: 'WeChat Pay', icon: 'wechat_pay', category: 'wallet', countries: ['CN'] },
      { id: 'amazon_pay', name: 'Amazon Pay', icon: 'amazon_pay', category: 'wallet', countries: ['*'] },
      { id: 'grabpay', name: 'GrabPay', icon: 'grabpay', category: 'wallet', countries: ['SG', 'MY'] },
    ]

    const providerMap: Record<string, string> = {}
    for (const p of providers ?? []) {
      for (const m of (p.supported_methods ?? [])) {
        if (!providerMap[m]) providerMap[m] = p.provider
      }
    }

    return ALL_METHODS.map(m => {
      const metrics = metricsByMethod[m.id]
      const volume = metrics?.volume ?? 0
      const txs = metrics?.txs ?? 0
      const rate = metrics && metrics.total > 0
        ? Math.round((metrics.approved / metrics.total) * 1000) / 10
        : 0

      return {
        id: m.id,
        name: m.name,
        icon: m.icon,
        category: m.category,
        provider: providerMap[m.id] ?? '—',
        countries: m.countries,
        // Na Whop os métodos padrão são resolvidos automaticamente por país,
        // moeda, dispositivo e elegibilidade do comprador.
        enabled: isWhopSeller || enabledMethods.includes(m.id),
        volume,           // já convertido via fromCents
        transactions: txs,
        approvalRate: rate,
        avgTicket: txs > 0 ? Math.round(volume / txs) : 0,
        fees: feesFormatted,
        feePercentage,
        feeFixedUsd,
        settlementDays,
        reservePercentage: reservePct,
        anticipationFeePct: anticipationPct,
        ...(m.id === 'spei' ? {
          speiBeneficiaryName: String(profile?.config?.spei_beneficiary_name ?? ''),
        } : {}),
      }
    })
  }

  async toggle(sellerId: string, methodId: string, enabled: boolean) {
    const { data: profile } = await supabase
      .from('seller_profiles').select('enabled_methods').eq('id', sellerId).single()

    const current: string[] = profile?.enabled_methods ?? []
    const updated = enabled
      ? [...new Set([...current, methodId])]
      : current.filter(m => m !== methodId)

    await supabase.from('seller_profiles').update({ enabled_methods: updated }).eq('id', sellerId)
    return { message: `Método ${enabled ? 'ativado' : 'desativado'} com sucesso` }
  }

  async updateConfig(sellerId: string, methodId: string, data: { beneficiaryName?: string }) {
    if (methodId !== 'spei') throw new BadRequestException('Este método não possui configuração editável.')

    const beneficiaryName = String(data?.beneficiaryName ?? '').trim()
    if (beneficiaryName.length > 120) {
      throw new BadRequestException('O nome do beneficiário deve ter no máximo 120 caracteres.')
    }

    const { data: profile } = await supabase
      .from('seller_profiles').select('config').eq('id', sellerId).single()
    const config = profile?.config ?? {}

    await supabase.from('seller_profiles').update({
      config: {
        ...config,
        // String vazia remove a personalização e reativa o fallback para o
        // nome do workspace no checkout.
        spei_beneficiary_name: beneficiaryName || null,
      },
    }).eq('id', sellerId)

    return { message: 'Configuração SPEI atualizada com sucesso' }
  }

  async getPerformance(sellerId: string, methodId: string) {
    const { data } = await supabase
      .from('seller_kpis')
      .select('date_key, approved_volume, approved_transactions')
      .eq('seller_id', sellerId)
      .eq('method', methodId)
      .order('date_key', { ascending: false })
      .limit(7)

    return (data ?? []).reverse().map(r => ({
      day: new Date(r.date_key).toLocaleDateString('pt-BR', { weekday: 'short' }),
      transactions: Number(r.approved_transactions),
      // 🔥 approved_volume em centavos → USD
      volume: fromCents(r.approved_volume),
    }))
  }
}

// ============================================================
// SETTINGS SERVICE
// ============================================================

@Injectable()
export class SettingsService {

  async get(sellerId: string, userId: string) {
    const [profile, apiKey, userData] = await Promise.all([
      supabase.from('seller_profiles').select('*').eq('id', sellerId).single(),
      supabase.from('api_keys').select('publishable_key, key_prefix').eq('seller_id', sellerId).eq('is_active', true).limit(1).maybeSingle(),
      // 🔥 whatsapp e avatar ficam na tabela users
      supabase.from('users').select('name, whatsapp, avatar_url').eq('id', userId).single(),
    ])

    const p = profile.data
    const k = apiKey.data
    const u = userData.data

    const { data: kycData } = await supabase
      .from('kyc_info').select('*').eq('user_id', userId).maybeSingle()

    return {
      company: {
        name: p?.name ?? u?.name ?? '',
        taxId: p?.metadata?.taxId ?? '',
        email: p?.email ?? '',
        phone: p?.metadata?.phone ?? '',
        address: p?.metadata?.address ?? '',
        country: p?.country ?? 'PT',
        currency: p?.config?.currency ?? 'EUR',
        logoUrl: p?.metadata?.logoUrl ?? null,
        instagram: p?.instagram ?? '',
        // 🔥 whatsapp vem da tabela users, não de seller_profiles
        whatsapp: u?.whatsapp ?? '',
      },
      bank: {
        accountHolder: p?.metadata?.bank?.accountHolder ?? '',
        iban: p?.metadata?.bank?.iban ?? '',
        bic: p?.metadata?.bank?.bic ?? '',
        bankName: p?.metadata?.bank?.name ?? '',
      },
      security: {
        twoFactorEnabled: p?.config?.security?.twoFactor ?? false,
        emailAlerts: p?.config?.security?.emailAlerts ?? true,
        ipRestriction: p?.config?.security?.ipRestriction ?? false,
        require3DS: p?.config?.security?.require3DS ?? true,
        velocityCheck: p?.config?.security?.velocityCheck ?? true,
        geoCheck: p?.config?.security?.geoCheck ?? true,
        cardTestingBlock: p?.config?.security?.cardTestingBlock ?? true,
        maxTransactionAmount: p?.config?.security?.maxTxAmount ?? 10000,
        riskScoreLimit: p?.config?.security?.riskScoreLimit ?? 85,
      },
      webhooks: {
        url: p?.metadata?.webhookUrl ?? '',
        secret: p?.metadata?.webhookSecret ?? '',
        events: p?.metadata?.webhookEvents ?? {
          'payment.succeeded': true,
          'payment.failed': true,
          'payment.refunded': true,
          'payout.created': true,
          'payout.completed': false,
          'dispute.created': true,
        },
      },
      apiKeys: {
        publishableKey: k?.publishable_key ?? '',
        secretKeyMasked: k ? `sk_live_${k.key_prefix}${'•'.repeat(32)}` : '',
        keyPrefix: k?.key_prefix ?? '',
      },
      kyc: kycData ? {
        fullName: kycData.full_name,
        cpfMasked: this.maskCpf(kycData.cpf),
        birthDate: kycData.birth_date,
        cep: this.formatCep(kycData.cep),
        street: kycData.street,
        number: kycData.number,
        complement: kycData.complement,
        neighborhood: kycData.neighborhood,
        city: kycData.city,
        state: kycData.state,
        status: kycData.review_status,
      } : null,
    }
  }

  async update(sellerId: string, userId: string, body: { section: string; data: Record<string, unknown> }) {
    const { section, data } = body

    const { data: profile, error: profileReadError } = await supabase
      .from('seller_profiles').select('config, metadata').eq('id', sellerId).single()

    if (profileReadError) throw new BadRequestException(profileReadError.message)

    const config = profile?.config ?? {}
    const metadata = profile?.metadata ?? {}

    if (section === 'company') {
      let avatarUrl: string | undefined
      if (data.avatarBase64 && typeof data.avatarBase64 === 'string') {
        avatarUrl = await this.uploadAvatar(userId, data.avatarBase64)
      }

      // 🔥 seller_profiles — whatsapp NÃO existe aqui, só no users
      const { error: companyUpdateError } = await supabase.from('seller_profiles').update({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.country !== undefined && { country: data.country }),
        metadata: {
          ...metadata,
          ...(data.taxId !== undefined && { taxId: data.taxId }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.address !== undefined && { address: data.address }),
          ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
        },
        config: { ...config, currency: data.currency },
      }).eq('id', sellerId)

      if (companyUpdateError) throw new BadRequestException(companyUpdateError.message)

      // 🔥 users — name, whatsapp e avatar ficam aqui
      const userUpdate: Record<string, any> = {}
      if (data.name !== undefined) userUpdate.name = data.name
      if (data.whatsapp !== undefined) userUpdate.whatsapp = data.whatsapp
      if (avatarUrl) userUpdate.avatar_url = avatarUrl

      if (Object.keys(userUpdate).length > 0) {
        const { error: userUpdateError } = await supabase.from('users').update(userUpdate).eq('id', userId)
        if (userUpdateError) throw new BadRequestException(userUpdateError.message)
      }

      // `/auth/me` lê o @ de users, enquanto Configurações lê de
      // seller_profiles. Mantemos as duas representações sincronizadas para o
      // refresh fechar a modal e para o restante do painel exibir o mesmo dado.
      if (data.instagram !== undefined) {
        try {
          await syncInstagram({
            sellerId,
            userId,
            instagram: String(data.instagram),
            updateSeller: async (id, instagram) => {
              const { error } = await supabase.from('seller_profiles').update({ instagram }).eq('id', id)
              return { error }
            },
            updateUser: async (id, instagram) => {
              const { error } = await supabase.from('users').update({ instagram }).eq('id', id)
              return { error }
            },
          })
        } catch (error) {
          throw new BadRequestException(error instanceof Error ? error.message : 'Não foi possível salvar o Instagram.')
        }
      }
    }

    if (section === 'bank') {
      await supabase.from('seller_profiles').update({
        metadata: { ...metadata, bank: { accountHolder: data.accountHolder, iban: data.iban, bic: data.bic, name: data.bankName } },
      }).eq('id', sellerId)
    }

    if (section === 'security') {
      await supabase.from('seller_profiles').update({
        config: { ...config, security: data },
      }).eq('id', sellerId)
    }

    if (section === 'webhooks') {
      const webhookSecret = metadata?.webhookSecret ?? require('crypto').randomBytes(32).toString('hex')
      await supabase.from('seller_profiles').update({
        metadata: { ...metadata, webhookUrl: data.url, webhookEvents: data.events, webhookSecret },
      }).eq('id', sellerId)
    }

    return { message: 'Configurações salvas com sucesso' }
  }

  private async uploadAvatar(userId: string, base64: string): Promise<string | undefined> {
    try {
      const matches = base64.match(/^data:(.+);base64,(.+)$/)
      const mimeType = matches?.[1] ?? 'image/jpeg'
      const rawBase64 = matches?.[2] ?? base64
      const buffer = Buffer.from(rawBase64, 'base64')
      const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
      const fileName = `avatars/${userId}.${ext}`

      const { error } = await supabase.storage.from('avatars').upload(fileName, buffer, { contentType: mimeType, upsert: true })
      if (error) { console.error('[SettingsService] Avatar upload error:', error.message); return undefined }

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(fileName)
      return `${publicUrl}?t=${Date.now()}`
    } catch (err) {
      console.error('[SettingsService] uploadAvatar error:', err)
      return undefined
    }
  }

  async getOffers(userId: string) {
    const { data } = await supabase.from('offers').select('*').eq('user_id', userId).order('created_at', { ascending: false })
    return data ?? []
  }

  async addOffer(userId: string, body: { name: string; salesPageUrl: string; riskLevel: 'WHITE' | 'GRAY' | 'BLACK' }) {
    const { data: sellerProfile } = await supabase
      .from('seller_profiles').select('id').eq('user_id', userId).single()

    if (!sellerProfile) throw new BadRequestException('Perfil de vendedor não encontrado')

    const { error } = await supabase.from('offers').insert({
      user_id: userId,
      seller_id: sellerProfile.id,
      name: body.name.trim(),
      sales_page_url: body.salesPageUrl.trim(),
      risk_level: body.riskLevel,
      status: 'pending_review',
      created_at: new Date(),
    })

    if (error) throw new BadRequestException('Erro ao adicionar oferta: ' + error.message)
    return { message: 'Oferta adicionada. Ficará em análise pendente.' }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const { data: user } = await supabase.from('users').select('password_hash').eq('id', userId).single()
    if (!user) throw new NotFoundException('Usuário não encontrado')

    const match = await bcrypt.compare(currentPassword, user.password_hash)
    if (!match) throw new UnauthorizedException('Senha atual incorreta')

    const hash = await bcrypt.hash(newPassword, 12)
    await supabase.from('users').update({ password_hash: hash }).eq('id', userId)
    return { message: 'Senha alterada com sucesso' }
  }

  async getWebhookSecret(sellerId: string) {
    const { data: profile, error } = await supabase
      .from('seller_profiles')
      .select('metadata')
      .eq('id', sellerId)
      .single()

    if (error || !profile) {
      throw new NotFoundException('Seller não encontrado')
    }

    // Já tem secret → retorna
    const existing = profile.metadata?.webhookSecret
    if (existing) return { secret: existing }

    // Lazy creation: gera, persiste, retorna
    const secret = this.generateWebhookSecret()

    const newMetadata = { ...(profile.metadata ?? {}), webhookSecret: secret }

    const { error: updateError } = await supabase
      .from('seller_profiles')
      .update({ metadata: newMetadata })
      .eq('id', sellerId)

    if (updateError) {
      // Não engole o erro — se a persistência falha, o secret retornado seria
      // inválido (não casaria com o que o webhook usa pra assinar).
      throw new InternalServerErrorException(
        `Failed to persist webhook secret: ${updateError.message}`,
      )
    }

    return { secret }
  }

  private generateWebhookSecret(): string {
    // 32 bytes = 256 bits, padrão pra HMAC-SHA256
    return 'whsec_' + crypto.randomBytes(32).toString('hex')
  }

  private maskCpf(cpf: string): string {
    if (!cpf || cpf.length !== 11) return '•••.•••.•••-••'
    return `•••.${cpf.slice(3, 6)}.•••-••`
  }

  private formatCep(cep: string): string {
    if (!cep || cep.length !== 8) return cep
    return `${cep.slice(0, 5)}-${cep.slice(5)}`
  }
}

// ============================================================
// API KEYS SERVICE
// ============================================================

@Injectable()
export class ApiKeysService {
  // grace period padrão de 7 dias — ajusta como achar melhor
  private readonly GRACE_PERIOD_DAYS = 7;

  async createKey(sellerId: string, name?: string) {
    const publishableKey = generateKey('pk_live');
    const secretKey = generateKey('sk_live');
    const secretKeyHash = hashKey(secretKey);
    const keyPrefix = secretKey.slice(0, 20);

    const { data, error } = await supabase
      .from('api_keys')
      .insert({
        seller_id: sellerId,
        publishable_key: publishableKey,
        secret_key_hash: secretKeyHash,
        key_prefix: keyPrefix,
        name: name ?? 'Default key',
        is_active: true,
      })
      .select('id')
      .single();

    if (error) throw new Error('Failed to create API key');
    return { keyId: data.id, publishableKey, secretKey };
  }

  async listKeys(sellerId: string) {
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, name, publishable_key, key_prefix, is_active, created_at, expires_at, revoked_at')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false });

    if (error) throw new Error('Failed to list keys');

    // marca quais estão em grace period pra UI mostrar aviso
    return data.map((key) => ({
      ...key,
      status: this.computeStatus(key),
    }));
  }

  private computeStatus(key: any): 'active' | 'expiring' | 'revoked' {
    if (!key.is_active) return 'revoked';
    if (key.expires_at && new Date(key.expires_at) > new Date()) return 'expiring';
    return 'active';
  }

  /**
   * Revogação imediata — só usar em caso de comprometimento de segurança
   * (ex: chave vazou no GitHub).
   */
  async revokeKeyImmediate(sellerId: string, keyId: string) {
    const { error } = await supabase
      .from('api_keys')
      .update({
        is_active: false,
        revoked_at: new Date().toISOString(),
      })
      .eq('id', keyId)
      .eq('seller_id', sellerId);

    if (error) throw new Error('Failed to revoke key');
    return { success: true };
  }

  /**
   * Revogação com grace period — chave continua funcionando até `expires_at`.
   * Esse é o método padrão pra rotação normal.
   */
  async scheduleRevocation(
    sellerId: string,
    keyId: string,
    graceDays = this.GRACE_PERIOD_DAYS,
  ) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + graceDays);

    const { error } = await supabase
      .from('api_keys')
      .update({ expires_at: expiresAt.toISOString() })
      .eq('id', keyId)
      .eq('seller_id', sellerId)
      .eq('is_active', true); // só agenda revogação em chaves ativas

    if (error) throw new Error('Failed to schedule revocation');
    return { success: true, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Rotação correta: cria a nova chave e agenda revogação da antiga
   * com grace period. As duas funcionam durante o período de transição.
   */
  async rotateKey(sellerId: string, oldKeyId: string, graceDays = this.GRACE_PERIOD_DAYS) {
    // 1. Cria a nova chave PRIMEIRO (se falhar, não mexemos na antiga)
    const newKey = await this.createKey(sellerId, 'Rotated key');

    // 2. Agenda revogação da antiga
    try {
      await this.scheduleRevocation(sellerId, oldKeyId, graceDays);
    } catch (err) {
      // Se falhar agendar, a nova chave já existe e tá ativa, então não é fatal.
      // Mas avisa pra o seller poder fazer manualmente.
      // (Opcionalmente: dispara um alerta interno aqui)
    }

    return {
      ...newKey,
      oldKeyExpiresInDays: graceDays,
      message: `Use a nova chave a partir de agora. A antiga continuará funcionando por ${graceDays} dias.`,
    };
  }

  /**
   * Validação considerando grace period:
   * chave é válida se is_active=true E (expires_at é null OU expires_at > now)
   */
  async validateApiKey(rawKey: string) {
    if (!rawKey) return null;

    const prefix = rawKey.slice(0, 20);
    const nowIso = new Date().toISOString();

    const { data: keys, error } = await supabase
      .from('api_keys')
      .select('id, seller_id, secret_key_hash, expires_at')
      .eq('key_prefix', prefix)
      .eq('is_active', true)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

    if (error || !keys?.length) return null;

    const incomingHash = hashKey(rawKey);
    for (const key of keys) {
      if (incomingHash === key.secret_key_hash) {
        // opcional: log de uso pra detectar quem ainda usa chave em grace period
        const isExpiring = !!key.expires_at;
        return {
          keyId: key.id,
          sellerId: key.seller_id,
          isExpiring,
          expiresAt: key.expires_at,
        };
      }
    }

    return null;
  }
}
