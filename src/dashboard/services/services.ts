// ============================================================
// BACKEND SERVICES — dashboard modules
// Transactions | Wallet | Disputes | Transfers | PaymentMethods | Settings
// ============================================================

import { Injectable, BadRequestException, NotFoundException, UnauthorizedException, InternalServerErrorException, Logger } from '@nestjs/common'
import { supabase } from '../../lib/supabase.client'
import * as bcrypt from 'bcrypt';
import { generateKey, hashKey } from '../../utils/apikeys.utils';
import * as crypto from 'crypto';
import { RequestPayoutDto, RequestPayoutResult } from '../dto/request-payout.dto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

    const mapped = (data ?? []).map(tx => ({
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
    }))

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
    }
  }
}

// ============================================================
// WALLET SERVICE
// ============================================================

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name)

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
        date: new Date(nextPayout.available_at).toLocaleDateString('pt-BR'),
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
      if (type === 'credit') q = q.in('type', ['credit_pending', 'credit_available', 'release_to_available'])
      if (type === 'debit') q = q.in('type', ['debit_payout', 'fee_platform'])
    }

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)

    const CREDIT_TYPES = ['credit_pending', 'credit_available', 'release_to_available']

    const mapped = (data ?? []).map(entry => ({
      id: entry.id,
      type: CREDIT_TYPES.includes(entry.type) ? 'credit' : 'debit',
      description: this.describeEntry(entry.type),
      // 🔥 amount em centavos → USD
      amount: fromCents(entry.amount),
      status: entry.status === 'completed' ? 'completed' : 'pending',
      date: new Date(entry.created_at).toLocaleDateString('pt-BR'),
      transactionId: entry.transaction_id,
    }))

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
      method: 'bank',
      bankAccount: null,
      cryptoAddress: null,
      cryptoNetwork: null,
      // 🔥 amount em centavos → USD
      amount: fromCents(p.amount),
      status: p.status === 'completed' ? 'paid' : p.status === 'pending' ? 'pending' : 'failed',
      date: new Date(p.created_at).toLocaleDateString('pt-BR'),
      processedAt: p.available_at ? new Date(p.available_at).toLocaleDateString('pt-BR') : null,
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
    }
    return map[type] ?? type
  }

  private usdToCents(usd: number): number {
    return Math.round(usd * 100)
  }

  // ── Monta o objeto `destination` conforme o método ─────────────────────────
  private buildDestination(dto: RequestPayoutDto): Record<string, string> {
    if (dto.method === 'pix') {
      const pixKey = (dto.pixKey ?? '').trim()
      const pixHolder = (dto.pixHolder ?? '').trim()
      const pixKeyType = (dto.pixKeyType ?? '').trim()
      const pixBankName = (dto.pixBankName ?? '').trim()

      if (!pixKey) throw new BadRequestException('Chave PIX é obrigatória.')
      if (!pixHolder) {
        throw new BadRequestException('Nome do titular é obrigatório.')
      }

      return {
        pixKey,
        pixKeyType,
        pixHolder,
        ...(pixBankName ? { pixBankName } : {}),
      }
    }

    // crypto
    const cryptoAddress = (dto.cryptoAddress ?? '').trim()
    const cryptoNetwork = (dto.cryptoNetwork ?? '').trim()

    if (cryptoAddress.length < 20) {
      throw new BadRequestException('Endereço de carteira inválido.')
    }

    return { cryptoAddress, cryptoNetwork }
  }


  // ── Caso de uso principal ──────────────────────────────────────────────────
  async requestPayout(
    dto: RequestPayoutDto,
  ): Promise<RequestPayoutResult> {
    // 1. Converte para centavos (formato do banco).
    //    O DTO já garantiu amount > 0 e >= mínimo via class-validator.
    const amountCents = this.usdToCents(dto.amount)

    // 2. Monta os dados de destino (valida campos obrigatórios do método).
    const destination = this.buildDestination(dto)

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
    const { data, error } = await supabase.rpc('request_payout', {
      p_seller_id: dto.sellerId,
      p_amount_cents: amountCents,
      p_method: dto.method,
      p_destination: destination,
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

    // 6. Resposta — mantém o shape que a modal espera.
    return {
      payoutId: row.payout_id,
      status: 'processing', // exibido como "Em Processamento" na modal
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
      deadline: d.deadline ? new Date(d.deadline).toLocaleDateString('pt-BR') : null,
      createdAt: new Date(d.created_at).toLocaleDateString('pt-BR'),
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
          ? new Date(entry.available_at).toLocaleDateString('pt-BR')
          : '-',
        createdAt: new Date(entry.created_at).toLocaleDateString('pt-BR'),
        paidAt: entry.status === 'completed'
          ? new Date(entry.created_at).toLocaleDateString('pt-BR')
          : null,
        failReason: null,
        transactions: entry.transaction_id ? [{
          id: entry.transaction_id,
          date: new Date(entry.created_at).toLocaleDateString('pt-BR'),
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
      .from('seller_profiles').select('enabled_methods, config').eq('id', sellerId).single()

    const enabledMethods: string[] = profile?.enabled_methods ?? []

    const { data: sellerFees } = await supabase
      .from('seller_fees').select('*').eq('seller_id', sellerId).maybeSingle()

    const feePercentage = sellerFees?.fee_percentage ?? 0
    const feeFixedUsd = sellerFees?.fee_fixed_usd ?? 0
    const settlementDays = sellerFees?.settlement_days ?? 3
    const reservePct = sellerFees?.reserve_percentage ?? 0
    const anticipationPct = sellerFees?.anticipation_fee_pct ?? 4.99
    const feesFormatted = sellerFees ? `${feePercentage}% + $${Number(feeFixedUsd).toFixed(2)}` : '—'

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
      if (!metricsByMethod[k.method]) metricsByMethod[k.method] = { volume: 0, txs: 0, approved: 0, total: 0 }
      // 🔥 approved_volume em centavos USD → USD
      metricsByMethod[k.method].volume += fromCents(k.approved_volume)
      metricsByMethod[k.method].txs += Number(k.approved_transactions)
      metricsByMethod[k.method].approved += Number(k.approved_transactions)
      metricsByMethod[k.method].total += Number(k.total_transactions)
    }

    const ALL_METHODS = [
      { id: 'credit_card', name: 'Cartão de Crédito', icon: 'credit_card', category: 'card', countries: ['*'] },
      { id: 'debit_card', name: 'Cartão de Débito', icon: 'debit_card', category: 'card', countries: ['*'] },
      { id: 'pix', name: 'PIX', icon: 'pix', category: 'instant', countries: ['BR'] },
      { id: 'mbway', name: 'MB Way', icon: 'mbway', category: 'instant', countries: ['PT'] },
      { id: 'multibanco', name: 'Multibanco', icon: 'multibanco', category: 'bank', countries: ['PT'] },
      { id: 'ideal', name: 'iDEAL', icon: 'ideal', category: 'instant', countries: ['NL'] },
      { id: 'bancontact', name: 'Bancontact', icon: 'bancontact', category: 'instant', countries: ['BE'] },
      { id: 'apple_pay', name: 'Apple Pay', icon: 'applepay', category: 'wallet', countries: ['*'] },
      { id: 'google_pay', name: 'Google Pay', icon: 'googlepay', category: 'wallet', countries: ['*'] },
      { id: 'paypal', name: 'PayPal', icon: 'paypal', category: 'wallet', countries: ['*'] },
      { id: 'boleto', name: 'Boleto', icon: 'boleto', category: 'bank', countries: ['BR'] },
      { id: 'sepa', name: 'SEPA', icon: 'sepa', category: 'bank', countries: ['EU'] },
      { id: 'klarna', name: 'Klarna', icon: 'klarna', category: 'wallet', countries: ['EU', 'US'] },
      { id: 'blik', name: 'Blik', icon: 'blik', category: 'instant', countries: ['PL'] },
      { id: 'twint', name: 'Twint', icon: 'twint', category: 'instant', countries: ['CH'] },
      { id: 'revolut_pay', name: 'Revolut Pay', icon: 'revolut_pay', category: 'wallet', countries: ['EU'] },
      { id: 'alipay', name: 'AliPay', icon: 'alipay', category: 'wallet', countries: ['CN'] },
      { id: 'wechat', name: 'WeChat Pay', icon: 'wechat', category: 'wallet', countries: ['CN'] },
      { id: 'mercadopago', name: 'Mercado Pago', icon: 'mercadopago', category: 'wallet', countries: ['LATAM'] },
      { id: 'pse', name: 'PSE', icon: 'pse', category: 'instant', countries: ['CO'] },
      { id: 'spei', name: 'SPEI', icon: 'spei', category: 'instant', countries: ['MX'] },
      { id: 'oxxo', name: 'OXXO', icon: 'oxxo', category: 'bank', countries: ['MX'] },
      { id: 'khipu', name: 'Khipu', icon: 'khipu', category: 'instant', countries: ['CL'] },
      { id: 'webpay', name: 'Webpay', icon: 'webpay', category: 'instant', countries: ['CL'] },
      { id: 'nequi', name: 'Nequi', icon: 'nequi', category: 'wallet', countries: ['CO'] },
      { id: 'daviplata', name: 'Daviplata', icon: 'daviplata', category: 'wallet', countries: ['CO'] },
      { id: 'rapipago', name: 'Rapipago', icon: 'rapipago', category: 'bank', countries: ['AR'] },
      { id: 'pagofacil', name: 'Pago Fácil', icon: 'pagofacil', category: 'bank', countries: ['AR'] },
      { id: 'bank_transfer', name: 'Transferência', icon: 'bank_transfer', category: 'bank', countries: ['*'] },
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
        enabled: enabledMethods.includes(m.id),
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

    const { data: profile } = await supabase
      .from('seller_profiles').select('config, metadata').eq('id', sellerId).single()

    const config = profile?.config ?? {}
    const metadata = profile?.metadata ?? {}

    if (section === 'company') {
      let avatarUrl: string | undefined
      if (data.avatarBase64 && typeof data.avatarBase64 === 'string') {
        avatarUrl = await this.uploadAvatar(userId, data.avatarBase64)
      }

      // 🔥 seller_profiles — whatsapp NÃO existe aqui, só no users
      await supabase.from('seller_profiles').update({
        ...(data.name !== undefined && { name: data.name }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.instagram !== undefined && { instagram: data.instagram }),
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

      // 🔥 users — name, whatsapp e avatar ficam aqui
      const userUpdate: Record<string, any> = {}
      if (data.name !== undefined) userUpdate.name = data.name
      if (data.whatsapp !== undefined) userUpdate.whatsapp = data.whatsapp
      if (avatarUrl) userUpdate.avatar_url = avatarUrl

      if (Object.keys(userUpdate).length > 0) {
        await supabase.from('users').update(userUpdate).eq('id', userId)
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
      .eq('user_id', sellerId)
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