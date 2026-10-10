// ============================================================================
// STRIPE — trava de recusas por pedido
// ----------------------------------------------------------------------------
// Na Stripe o comprador confirma o pagamento no navegador: depois de uma
// recusa, o mesmo PaymentIntent aceita outra tentativa, e outra, sem passar por
// aqui. Um pedido com muitas recusas seguidas é o padrão de TESTE DE CARTÃO
// (alguém passando uma lista de cartões roubados para ver qual funciona), e
// rajada de recusa é o que mais pesa contra uma conta.
//
// A cada `payment_intent.payment_failed` o webhook conta a tentativa. Duas
// coisas encerram o pedido (o intent é cancelado na Stripe, e o client_secret
// dele deixa de servir):
//   • recusa DEFINITIVA — o emissor disse que o cartão é roubado, perdido,
//     bloqueado ou fraudulento. Insistir nele é pedir para o emissor reportar.
//   • tentativas demais no mesmo pedido.
//
// O comprador de verdade que errou o cartão algumas vezes continua comprando:
// basta abrir o checkout de novo, que é outro pedido.
// ============================================================================

/** Códigos em que o emissor mandou parar. Tentar de novo com o mesmo cartão não muda nada. */
export const HARD_DECLINE_CODES = new Set([
  'stolen_card',
  'lost_card',
  'pickup_card',
  'fraudulent',
  'restricted_card',
  'security_violation',
  'merchant_blacklist',
  'revocation_of_authorization',
  'revocation_of_all_authorizations',
  'stop_payment_order',
]);

export const DEFAULT_MAX_FAILED_ATTEMPTS = 4;

/** Teto de recusas por pedido (`STRIPE_MAX_FAILED_ATTEMPTS`; 0 desliga a trava por contagem). */
export function maxFailedAttempts(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STRIPE_MAX_FAILED_ATTEMPTS;
  if (raw == null || raw.trim() === '') return DEFAULT_MAX_FAILED_ATTEMPTS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_FAILED_ATTEMPTS;
}

export type DeclineGuardReason = 'hard_decline' | 'too_many_attempts';

/** Encerra o pedido? `attempts` já conta a recusa que acabou de chegar. */
export function declineGuardDecision(args: {
  attempts: number;
  declineCode?: string | null;
  maxAttempts?: number;
}): DeclineGuardReason | null {
  const code = String(args.declineCode ?? '').toLowerCase();
  if (code && HARD_DECLINE_CODES.has(code)) return 'hard_decline';
  const max = args.maxAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  if (max > 0 && args.attempts >= max) return 'too_many_attempts';
  return null;
}

/** Código da recusa no PaymentIntent do evento `payment_intent.payment_failed`. */
export function declineCodeOf(intent: any): string | null {
  const error = intent?.last_payment_error;
  const code = error?.decline_code ?? error?.code ?? null;
  return code ? String(code) : null;
}
