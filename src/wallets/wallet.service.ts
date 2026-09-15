// nexor/src/wallets/wallet.service.ts

import { Injectable } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'

interface ExternalFeeArgs {
  amount: number
  recipientId: string
}

interface PlatformFeeArgs {
  amount: number
  walletRef: string
  partner: string
}

@Injectable()
export class WalletService {

  // ─── creditPending ─────────────────────────────────────────────────────────

  async creditPending({
    sellerId,
    transactionId,
    amount,
    fee,
    reserveAmount,
    availableAt,
    reserveUntil,
    externalFee = null,
    platformFee = null,
  }: {
    sellerId: string
    transactionId: string
    amount: number
    fee: number
    reserveAmount: number
    availableAt: Date | string | null
    reserveUntil: Date | string | null
    externalFee?: ExternalFeeArgs | null
    platformFee?: PlatformFeeArgs | null
  }) {
    const toISO = (d: Date | string | null): string => {
      if (!d) return new Date().toISOString()
      if (d instanceof Date) return d.toISOString()
      return d
    }

    const availableAtISO = toISO(availableAt)
    const reserveUntilISO = toISO(reserveUntil)
    const now = new Date().toISOString()

    // ── 1. Linhas no ledger do seller ────────────────────────────────────────
    const ledgerRows: any[] = [
      {
        seller_id: sellerId,
        transaction_id: transactionId,
        type: 'credit_pending',
        amount,
        currency: 'USD',
        available_at: availableAtISO,
        status: 'pending',
        created_at: now,
      },
    ]

    if (reserveAmount > 0) {
      ledgerRows.push({
        seller_id: sellerId,
        transaction_id: transactionId,
        type: 'reserve_hold',
        amount: reserveAmount,
        currency: 'USD',
        available_at: reserveUntilISO,
        status: 'hold',
        created_at: now,
      })
    }

    if (platformFee && platformFee.amount > 0) {
      // Saída contábil do seller (registro do quanto saiu como fee)
      ledgerRows.push({
        seller_id: sellerId,
        transaction_id: transactionId,
        type: 'debit_platform_fee',
        amount: platformFee.amount,
        currency: 'USD',
        // wallet_ledger.status é NOT NULL — débito contábil já efetivado.
        status: 'completed',
        created_at: now,
        metadata: { platform_wallet_ref: platformFee.walletRef, partner: platformFee.partner },
      })

      // Entrada na wallet da plataforma — disponível imediatamente
      ledgerRows.push({
        seller_id: platformFee.walletRef,
        transaction_id: transactionId,
        type: 'credit_platform_fee',
        amount: platformFee.amount,
        currency: 'USD',
        status: 'completed',
        created_at: now,
        metadata: { source_seller_id: sellerId, partner: platformFee.partner },
      })
    }

    // 🔥 Linhas da external_fee
    if (externalFee && externalFee.amount > 0) {
      // Saída contábil do seller (o net já foi descontado antes no PaymentService)
      ledgerRows.push({
        seller_id: sellerId,
        transaction_id: transactionId,
        type: 'debit_external_fee',
        amount: externalFee.amount,
        currency: 'USD',
        // wallet_ledger.status é NOT NULL — débito contábil já efetivado.
        status: 'completed',
        created_at: now,
        metadata: { recipient_id: externalFee.recipientId },
      })

      // Entrada no recipient — disponível imediatamente (não segue D+3 do seller)
      ledgerRows.push({
        seller_id: externalFee.recipientId,
        transaction_id: transactionId,
        type: 'credit_external_fee',
        amount: externalFee.amount,
        currency: 'USD',
        status: 'completed',
        created_at: now,
        metadata: { source_seller_id: sellerId },
      })
    }

    const { error: insertError } = await supabase
      .from('wallet_ledger')
      .insert(ledgerRows)

    if (insertError) {
      if ((insertError as any).code === '23505') return { alreadyProcessed: true }
      console.error('[WalletService] creditPending ledger error:', insertError)
      throw new Error('Failed to insert wallet ledger: ' + insertError.message)
    }

    // ── 2. Atualiza pending balance do seller ────────────────────────────────
    const { error: balanceError } = await supabase.rpc('add_pending_balance', {
      p_seller_id: sellerId,
      p_amount: amount,
    })

    if (balanceError) {
      console.error('[WalletService] creditPending balance error:', balanceError)
      throw new Error('Failed to update pending balance: ' + balanceError.message)
    }

    // A reserva entra no saldo "em reserva" e volta ao disponível no prazo
    // (run_reserve_release_batch). Falha aqui não desfaz o crédito: a linha fica
    // sem reserve_counted e a liberação a devolve direto ao disponível.
    if (reserveAmount > 0) {
      const { error: reserveError } = await supabase.rpc('count_reserve_hold', { p_transaction_id: transactionId })
      if (reserveError) {
        console.error('[WalletService] reserva não somada ao saldo em reserva:', reserveError.message, { transactionId })
      }
    }

    if (platformFee && platformFee.amount > 0) {
      const { error: platBalanceError } = await supabase.rpc('add_available_balance', {
        p_seller_id: platformFee.walletRef,
        p_amount: platformFee.amount,
      })

      if (platBalanceError) {
        console.error(
          '[WalletService] platform_fee balance error (reconciliation needed):',
          platBalanceError,
          { transactionId, partner: platformFee.partner, walletRef: platformFee.walletRef },
        )
      }
    }


    // 🔥 3. Atualiza available balance do recipient (external_fee)
    if (externalFee && externalFee.amount > 0) {
      const { error: extBalanceError } = await supabase.rpc('add_available_balance', {
        p_seller_id: externalFee.recipientId,
        p_amount: externalFee.amount,
      })

      if (extBalanceError) {
        // Não trava — marca para reconciliação manual
        console.error(
          '[WalletService] external_fee balance error (reconciliation needed):',
          extBalanceError,
          { transactionId, recipient: externalFee.recipientId },
        )
      }
    }

    return {
      success: true,
      availableAt: availableAtISO,
      reserveUntil: reserveUntilISO,
      reserveAmount,
      pendingAmount: amount,
      externalFeeApplied: externalFee?.amount ?? 0,
    }
  }

  // ─── releaseToAvailable ────────────────────────────────────────────────────

  async releaseToAvailable({
    sellerId,
    transactionId,
    amount,
  }: {
    sellerId: string
    transactionId: string
    amount: number
  }) {
    const { data: existing } = await supabase
      .from('wallet_ledger')
      .select('id')
      .eq('transaction_id', transactionId)
      .eq('type', 'release_to_available')
      .maybeSingle()

    if (existing) return { alreadyProcessed: true }

    const { error: insertError } = await supabase
      .from('wallet_ledger')
      .insert({
        seller_id: sellerId,
        transaction_id: transactionId,
        type: 'release_to_available',
        amount,
        currency: 'USD',
        created_at: new Date().toISOString(),
      })

    if (insertError) {
      console.error('[WalletService] releaseToAvailable ledger error:', insertError)
      throw new Error('Failed to insert release ledger: ' + insertError.message)
    }

    const { error: balanceError } = await supabase.rpc('move_pending_to_available', {
      p_seller_id: sellerId,
      p_amount: amount,
    })

    if (balanceError) {
      console.error('[WalletService] releaseToAvailable balance error:', balanceError)
      throw new Error('Failed to move balance to available: ' + balanceError.message)
    }

    return { success: true, releasedAmount: amount }
  }

  // ─── debitAvailable ────────────────────────────────────────────────────────

  async debitAvailable({
    sellerId,
    amount,
    payoutId,
  }: {
    sellerId: string
    amount: number
    payoutId: string
  }) {
    const balance = await this.getBalance(sellerId)

    if (balance.available_balance < amount) {
      throw new Error('Insufficient balance')
    }

    const { error } = await supabase.from('wallet_ledger').insert({
      seller_id: sellerId,
      transaction_id: payoutId,
      type: 'debit_payout',
      amount,
      currency: 'USD',
      created_at: new Date().toISOString(),
    })

    if (error) {
      console.error('[WalletService] debitAvailable error:', error)
      throw new Error('Failed to insert debit ledger: ' + error.message)
    }

    const { error: balanceError } = await supabase.rpc('debit_available_balance', {
      p_seller_id: sellerId,
      p_amount: amount,
      p_payout_id: payoutId,
    })

    if (balanceError) {
      console.error('[WalletService] debitAvailable balance error:', balanceError)
      throw new Error('Failed to debit balance: ' + balanceError.message)
    }
  }

  // ─── getBalance ────────────────────────────────────────────────────────────

  async getBalance(sellerId: string) {
    const { data, error } = await supabase
      .from('wallet_balance')
      .select('*')
      .eq('seller_id', sellerId)
      .single()

    if (error) throw new Error('Failed to fetch balance: ' + error.message)
    return data
  }
}