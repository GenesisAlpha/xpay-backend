// Taxas cobradas pela Koopfy por transação, para o lucro do Analytics no
// checkout. O checkout manda os ids das transações (orders.gateway_payment_id)
// e recebe a taxa de cada uma em USD.

export const MAX_FEE_IDS = 500;
const TX_ID = /^[A-Za-z0-9_-]{6,80}$/;

/** Ids válidos e sem repetição, no máximo MAX_FEE_IDS. */
export function normalizeFeeIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  for (const value of raw) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (TX_ID.test(id)) ids.add(id);
    if (ids.size >= MAX_FEE_IDS) break;
  }
  return [...ids];
}

/** tx.fee vem em centavos de USD. */
export function feesFromRows(rows: Array<{ id: string; fee: number | string | null }>) {
  return rows.map((row) => {
    const cents = Number(row.fee ?? 0);
    return { id: row.id, fee: Number.isFinite(cents) ? Math.round(cents) / 100 : 0 };
  });
}
