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
//
//  MÉTODOS: ACH (bancos dos EUA), IBAN (SEPA/internacional), Pix (chave
//  brasileira) e cripto (USDT).
//
//  O saldo é em USD e o `amount` continua em dólares para todos os métodos —
//  inclusive Pix. A conversão para BRL é de quem liquida o saque; nada aqui
//  converte moeda.
//
//  Saques antigos em pix/crypto seguem legíveis: método e destino ficam no
//  metadata do wallet_ledger, que não tem constraint — nada a migrar.
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
export const VALID_METHODS = ['ach', 'iban', 'pix', 'crypto'] as const
export type WithdrawMethod = (typeof VALID_METHODS)[number]

/**
 * Métodos que existem no produto mas não processam hoje. Ficam aceitos pelo
 * @IsIn para o erro ser específico ("ainda não disponível") em vez de um
 * genérico "método inválido" — a diferença importa para quem lê o erro.
 *
 * Vazio hoje: ACH, IBAN, Pix e cripto processam.
 */
export const BLOCKED_METHODS = [] as const

export class RequestPayoutDto {
  // EM DÓLARES — convertido para centavos no service.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  // Mínimo por seller (seller_fees.payout_min_usd, padrão MIN_WITHDRAW_USD),
  // conferido no service junto das taxas.
  amount: number

  @IsIn([...VALID_METHODS, ...BLOCKED_METHODS], {
    message: 'Método de saque inválido.',
  })
  method: WithdrawMethod | (typeof BLOCKED_METHODS)[number]

  @IsString()
  sellerId?: string

  @IsOptional()
  @IsString()
  twoFactorCode?: string

  // ── ACH (bancos dos EUA) ──────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  achRoutingNumber?: string

  @IsOptional()
  @IsString()
  achAccountNumber?: string

  /** checking | savings */
  @IsOptional()
  @IsString()
  achAccountType?: string

  // ── IBAN (SEPA e internacional) ───────────────────────────────────────────
  @IsOptional()
  @IsString()
  iban?: string

  @IsOptional()
  @IsString()
  swift?: string

  // ── Pix (chave brasileira) ────────────────────────────────────────────────
  @IsOptional()
  @IsString()
  pixKey?: string

  /** cpf | cnpj | email | phone | random */
  @IsOptional()
  @IsString()
  pixKeyType?: string

  // ── Comuns às contas bancárias ────────────────────────────────────────────
  @IsOptional()
  @IsString()
  accountHolder?: string

  @IsOptional()
  @IsString()
  bankName?: string

  // ── Criptomoeda (USDT) ───────────────────────────────────────────────────
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

/** Idempotency-Key aceito — o mesmo formato validado no Checkout e no banco. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

// Resposta do fluxo unificado. `replayed` indica que a chave já tinha gerado
// este saque e nada foi debitado de novo.
export interface UnifiedPayoutResult extends RequestPayoutResult {
  replayed: boolean
}
