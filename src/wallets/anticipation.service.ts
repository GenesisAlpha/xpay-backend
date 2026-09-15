// Antecipação do saldo a liquidar.
//
// Habilitada por seller no CRM (seller_fees.anticipation_enabled), com taxa
// própria (anticipation_fee_pct). O seller vê quanto está a liquidar, a taxa e o
// líquido, e confirma: todos os créditos pendentes vão para o disponível de uma
// vez, na função anticipate_pending_balance (atômica, trava saldo e linhas).

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { calculateAnticipation, getEffectiveSellerFees } from '../shared/fee.calculator'

const toUsd = (cents: number) => Math.round(cents) / 100

@Injectable()
export class AnticipationService {
  async quote(sellerId: string) {
    const fees = await getEffectiveSellerFees(sellerId)
    const { data, error } = await supabase
      .from('wallet_ledger')
      .select('amount')
      .eq('seller_id', sellerId)
      .eq('type', 'credit_pending')
      .eq('status', 'pending')
    if (error) throw new InternalServerErrorException('Não foi possível calcular a antecipação.')

    const pendingCents = (data ?? []).reduce((sum, row: { amount: number | null }) => sum + Number(row.amount ?? 0), 0)
    const result = calculateAnticipation(pendingCents, fees)
    return {
      enabled: fees.anticipationEnabled,
      feePct: fees.anticipationFeePct,
      entries: (data ?? []).length,
      pendingCents: result.pendingCents,
      feeCents: result.feeCents,
      netCents: result.netCents,
      pending: toUsd(result.pendingCents),
      fee: toUsd(result.feeCents),
      net: toUsd(result.netCents),
    }
  }

  async anticipate(sellerId: string, body: { expectedPendingCents?: unknown }) {
    const fees = await getEffectiveSellerFees(sellerId)
    if (!fees.anticipationEnabled) {
      throw new ForbiddenException('A antecipação não está habilitada para esta conta.')
    }

    const expected = Number(body?.expectedPendingCents)
    if (!Number.isInteger(expected) || expected <= 0) {
      throw new BadRequestException('Atualize o valor a antecipar e confirme de novo.')
    }

    const { data, error } = await supabase.rpc('anticipate_pending_balance', {
      p_seller_id: sellerId,
      p_fee_pct: fees.anticipationFeePct,
      p_expected_cents: expected,
    })

    if (error) throw mapAnticipationError(error)

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, any> | null
    const pendingCents = Number(row?.pending_cents ?? 0)
    const feeCents = Number(row?.fee_cents ?? 0)
    return {
      reference: row?.reference ?? null,
      entries: Number(row?.entries ?? 0),
      pendingCents,
      feeCents,
      netCents: pendingCents - feeCents,
      pending: toUsd(pendingCents),
      fee: toUsd(feeCents),
      net: toUsd(pendingCents - feeCents),
    }
  }
}

export function mapAnticipationError(error: { message?: string; code?: string }) {
  const message = error?.message ?? ''
  if (/pending changed/i.test(message)) {
    return new ConflictException('O valor a liberar mudou. Revise e confirme de novo.')
  }
  if (/nothing to anticipate/i.test(message)) {
    return new ConflictException('Não há valores a liquidar para antecipar.')
  }
  if (/pending balance mismatch|wallet not found/i.test(message)) {
    console.error('[AnticipationService] saldo inconsistente:', message)
    return new ConflictException('Seu saldo está em conferência. Tente de novo mais tarde.')
  }
  if (error?.code === 'PGRST202' || /could not find the function|does not exist/i.test(message)) {
    return new ServiceUnavailableException('Antecipação indisponível no momento.')
  }
  console.error('[AnticipationService] anticipate_pending_balance falhou:', message)
  return new InternalServerErrorException('Não foi possível antecipar agora. Tente de novo.')
}
