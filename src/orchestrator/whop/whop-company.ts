// ============================================================================
// Descobre a company (account) dona de uma chave de API da Whop.
//
// Dois caminhos, na ordem:
//   1. GET /api/v5/company — legado, mas é o que aceita a chave com menos
//      permissões (uma chave só de cobrança resolve a company por aqui).
//   2. GET /api/v1/accounts/me — o equivalente na API v1 atual. Entra quando o
//      legado deixar de existir (404/410), para a conexão não morrer no dia em
//      que a Whop desligar a rota antiga.
//
// Sem imports de serviço de propósito: whop-accounts → whop-linked → … fecham
// ciclo e a injeção do Nest recebe `undefined` no meio.
// ============================================================================

export type FetchLike = (url: string, init?: any) => Promise<any>;

export interface WhopCompanyLookup {
  ok: boolean;
  status: number;
  /** Corpo da resposta que valeu (a última tentativa). */
  json: any;
  /** `{ id, title }` quando a chave resolveu uma company. */
  company: { id: string; title: string | null } | null;
  /** Qual rota respondeu por último. */
  route: 'v5' | 'v1';
}

export async function lookupWhopCompany(
  apiKey: string,
  apiUrl: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
): Promise<WhopCompanyLookup> {
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  const legacy = await fetchImpl(`${apiUrl}/api/v5/company`, { method: 'GET', headers });
  const legacyJson: any = await legacy.json().catch(() => ({}));
  if (legacy.ok && legacyJson?.id) {
    return { ok: true, status: legacy.status, json: legacyJson, company: pick(legacyJson), route: 'v5' };
  }
  // 401/403 é a chave, não a rota: repetir na v1 só devolveria o mesmo erro.
  if (legacy.status !== 404 && legacy.status !== 410) {
    return { ok: false, status: legacy.status, json: legacyJson, company: null, route: 'v5' };
  }

  const current = await fetchImpl(`${apiUrl}/api/v1/accounts/me`, { method: 'GET', headers });
  const currentJson: any = await current.json().catch(() => ({}));
  const company = current.ok && currentJson?.id ? pick(currentJson) : null;
  return { ok: Boolean(company), status: current.status, json: currentJson, company, route: 'v1' };
}

function pick(json: any): { id: string; title: string | null } {
  return { id: String(json.id), title: typeof json.title === 'string' ? json.title : null };
}
