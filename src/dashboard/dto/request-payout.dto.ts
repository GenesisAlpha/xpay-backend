// ─────────────────────────────────────────────────────────────────────────────
//  dto/request-payout.dto.ts
// ─────────────────────────────────────────────────────────────────────────────
//
//  DTO da requisição de saque. Aqui usando class-validator para validação
//  declarativa — garanta que o ValidationPipe global esteja habilitado no
//  main.ts (app.useGlobalPipes(new ValidationPipe({ whitelist: true }))).
//
//  Observação sobre o `amount`: a modal envia EM DÓLARES (ex: 250.00).
//  A conversão para centavos acontece no service.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator'

export const MIN_WITHDRAW_USD = 200
export const VALID_METHODS = ['pix', 'crypto'] as const
export type WithdrawMethod = (typeof VALID_METHODS)[number]

export class RequestPayoutDto {
  // EM DÓLARES — convertido para centavos no service.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(MIN_WITHDRAW_USD, {
    message: `O valor mínimo para saque é US$ ${MIN_WITHDRAW_USD.toFixed(2)}.`,
  })
  amount: number

  @IsIn(VALID_METHODS, { message: 'Método de saque inválido.' })
  method: WithdrawMethod

  @IsString()
  sellerId?: string

  @IsOptional()
  @IsString()
  twoFactorCode?: string

  // ── PIX ───────────────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  pixKey?: string

  @IsOptional()
  @IsString()
  pixKeyType?: string

  @IsOptional()
  @IsString()
  pixHolder?: string

  @IsOptional()
  @IsString()
  pixBankName?: string

  // ── Cripto ────────────────────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  cryptoAddress?: string

  @IsOptional()
  @IsString()
  cryptoNetwork?: string
}

// Shape da resposta — mantém o que a modal espera.
export interface RequestPayoutResult {
  payoutId: string
  status: string
}