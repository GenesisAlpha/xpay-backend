import { OwnProvider } from '../seller-provider/seller-provider-accounts';

// ============================================================================
// PERMISSÕES DA CHAVE DAS CONTAS PRÓPRIAS — regras puras
// ----------------------------------------------------------------------------
// A conta conecta só com as permissões de venda. As de saldo/saque e as de
// Apple Pay/Google Pay são conferidas DEPOIS, com leituras que não mudam nada
// na conta dele (GET). O que faltar volta com o nome que ele procura no painel
// do provedor, para o painel da Koopfy pedir que ele ative.
// ============================================================================

export type PermissionGroupKey = 'finance' | 'wallets';
export type PermissionStatus = 'ok' | 'missing' | 'unknown';

/**
 * E-mails da Whop ao comprador na conta própria do seller: 'on' = a Whop
 * manda recibo e avisos em nome da conta; 'off' = só a Koopfy fala com ele.
 * A chave da conta não pode mudar isso (a Whop só deixa uma Account API key
 * editar contas CONECTADAS, nunca a própria) — o seller desliga no painel da
 * Whop e a Koopfy confere com GET /accounts/me.
 */
export type CustomerEmailsStatus = 'on' | 'off' | 'unknown';

export function customerEmailsStatus(httpStatus: number | null, body: any): CustomerEmailsStatus {
  if (httpStatus == null || httpStatus < 200 || httpStatus >= 300) return 'unknown';
  const value = body?.send_customer_emails;
  return value === false ? 'off' : value === true ? 'on' : 'unknown';
}

export interface PermissionProbe {
  /** Grupo que a leitura confere. */
  group: PermissionGroupKey;
  /** Caminho da leitura na API do provedor. `{company}` = company da Whop. */
  path: string;
  /** Permissões que esta leitura prova (nome do painel do provedor). */
  permissions: string[];
}

export interface PermissionCheck {
  key: PermissionGroupKey;
  status: PermissionStatus;
  /** O que ativar na chave (vazio quando está tudo certo). */
  missing: string[];
}

/** Leituras de cada provedor. Todas GET: nada na conta dele muda. */
export const PERMISSION_PROBES: Record<OwnProvider, PermissionProbe[]> = {
  stripe: [
    { group: 'finance', path: '/v1/balance', permissions: ['Balance — Read'] },
    { group: 'finance', path: '/v1/payouts?limit=1', permissions: ['Payouts — Write'] },
    { group: 'wallets', path: '/v1/payment_method_domains?limit=1', permissions: ['Payment Method Domains — Write'] },
  ],
  whop: [
    { group: 'finance', path: '/api/v1/ledger_accounts/{company}', permissions: ['company:balance:read'] },
    { group: 'finance', path: '/api/v1/payout_methods?account_id={company}', permissions: ['payout:account:read', 'payout:destination:read'] },
    { group: 'wallets', path: '/api/v1/payment_method_domains?first=1', permissions: ['Payment method domains'] },
  ],
  paypal: [
    { group: 'finance', path: '/v1/reporting/balances?currency_code=ALL&include_crypto_currencies=false', permissions: ['Transaction search'] },
  ],
};

// Escrita que não dá para conferir sem agir na conta: entra na lista junto
// quando alguma leitura do mesmo grupo já falhou (ele vai gerar a chave de novo).
const UNPROBED: Partial<Record<OwnProvider, Partial<Record<PermissionGroupKey, string[]>>>> = {
  whop: { finance: ['payout:withdraw_funds'] },
};

/**
 * Resposta do provedor → situação da permissão. 403 é "a chave não pode";
 * a Whop também responde 401 para permissão ausente. Qualquer outra falha
 * (rede, 5xx, chave revogada na Stripe) fica como "não deu para conferir":
 * nunca acusamos falta de permissão sem o provedor dizer.
 */
export function probeStatus(provider: OwnProvider, httpStatus: number | null): PermissionStatus {
  if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) return 'ok';
  if (httpStatus === 403) return 'missing';
  if (httpStatus === 401 && provider === 'whop') return 'missing';
  return 'unknown';
}

/** Junta as leituras por grupo: falta se alguma faltou; ok só se todas passaram. */
export function summarizePermissions(
  provider: OwnProvider,
  results: Array<{ probe: PermissionProbe; status: PermissionStatus }>,
): PermissionCheck[] {
  const groups: PermissionGroupKey[] = [];
  for (const { probe } of results) if (!groups.includes(probe.group)) groups.push(probe.group);

  return groups.map(key => {
    const own = results.filter(item => item.probe.group === key);
    const missing = own.filter(item => item.status === 'missing').flatMap(item => item.probe.permissions);
    if (missing.length > 0) {
      return { key, status: 'missing' as const, missing: [...missing, ...(UNPROBED[provider]?.[key] ?? [])] };
    }
    return { key, status: own.every(item => item.status === 'ok') ? 'ok' as const : 'unknown' as const, missing: [] };
  });
}
