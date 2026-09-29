// ============================================================================
// PROVIDER ACCOUNTS — agora definidos NO PROJETO (não mais no Supabase).
// ----------------------------------------------------------------------------
// Cada conta representa uma credencial/gateway disponível. O seller escolhe o
// provider via seller.provider_default; o router resolve a conta aqui.
//
// Credenciais (API keys) ficam em variáveis de ambiente — nunca commitar chave.
// ============================================================================

export type ProviderName = 'setinel_gate' | 'approvebly' | 'coinflow' | 'simulator' | 'rox_pay' | 'whop' | 'stripe' | 'clip' | 'paypal';

// ⚠️ Nem toda conta vive aqui. Dois pools são DINÂMICOS e vêm de tabela:
//
//   • `whop_accounts`   → WhopAccountsService   — N companies independentes
//   • `stripe_accounts` → StripeAccountsService — N titulares independentes
//   • `gw_card_accounts` → ClipAccountsService  — N contas Clip MX
//
// A Clip tampouco tem entrada estática aqui, e por um motivo a mais que as
// outras: o teto dela NÃO é daily_cap_amount. É reserva atômica no banco, em
// centavos de MXN (gw_hold_card). Preencher daily_cap_amount numa conta Clip
// faria o router comparar MXN contra o volume em USD cents de
// account_daily_metrics e derrubar a conta por um motivo inexistente.
//
// Em ambos, as contas entram e saem por decisão operacional e pausar não pode
// custar um deploy. O router mescla os três em getAccounts() — todos nesta
// mesma forma (ProviderAccountConfig).
//
// A Stripe NÃO tem entrada estática aqui de propósito: uma conta Stripe única
// no env era exatamente o ponto de falha que o pool veio resolver. Cadastre em
// `stripe_accounts` e rode supabase_stripe_accounts_migration.sql.

export interface ProviderAccountConfig {
  id: string;
  provider: ProviderName;
  status: 'active' | 'inactive';
  weight: number;
  supported_methods: string[];   // ['all'] aceita todos
  countries?: string[];
  risk_levels?: string[];
  // Verticais que esta conta atende (ECOMMERCE | INFO | NUTRA). Vazio = todas.
  // É o eixo que separa risco entre titulares — ver a migration da Stripe.
  segments?: string[];
  country?: string;
  api_url?: string;

  // ── Tetos de roteamento (opcionais; null/undefined = sem teto) ─────────────
  // Em CENTAVOS DE USD — mesma unidade de account_daily_metrics.volume, que é
  // alimentada por markPaid(accountId, tx.amount_usd_net_cents).
  daily_cap_amount?: number;   // conta sai do pool ao atingir o volume do dia
  min_ticket?: number;
  max_ticket?: number;
  // Pausa temporária sem mexer no status (rampa de aquecimento, incidente).
  cooldown_until?: string;
  // Credenciais lidas em runtime; mantêm as chaves fora do código-fonte.
  apiKey?: string;
  apiSecret?: string;
  // Chave dedicada do fluxo MB Way hosted (Sentinel) — separada da apiKey de cartão.
  mbwayApiKey?: string;
  mid?: string;
  config?: Record<string, any>;
  metadata?: Record<string, any>;
}

export const PROVIDER_ACCOUNTS: ProviderAccountConfig[] = [
  {
    id: 'setinel_gate_main',
    provider: 'setinel_gate',
    status: 'active',
    weight: 1,
    supported_methods: ['card', 'apple_pay', 'google_pay', 'mbway'],
    // País da conta bancária que recebe o settlement (usado p/ cross-border).
    country: process.env.SENTINEL_SETTLEMENT_COUNTRY,
    api_url: process.env.SENTINEL_API_URL ?? 'https://sentinelgate.biz/v1',
    apiKey: process.env.SENTINEL_API_KEY,
    apiSecret: process.env.SENTINEL_API_SECRET,
    // MB Way (hosted/create) usa uma chave própria.
    mbwayApiKey: process.env.SENTINEL_MBWAY_API_KEY,
    mid: process.env.KOOPFY_MID_SENTINEL,
    config: {
      webhook: process.env.SENTINEL_WEBHOOK,
    },
  },
  {
    id: 'approvebly_main',
    provider: 'approvebly',
    status: 'active',
    weight: 1,
    supported_methods: ['all'],
    country: process.env.APPROVEBLY_SETTLEMENT_COUNTRY,
    api_url: process.env.APPROVEBLY_API_URL,
    apiKey: process.env.APPROVEBLY_API_KEY,
    config: {},
  },
  {
    id: 'coinflow_main',
    provider: 'coinflow',
    status: 'active',
    weight: 1,
    // Cartão tokenizado no client (SDK Coinflow). Carteiras/ACH adicionar depois.
    supported_methods: ['card'],
    country: process.env.COINFLOW_SETTLEMENT_COUNTRY,
    // Host (sem /api): prod https://api.coinflow.cash · sandbox https://api-sandbox.coinflow.cash
    api_url: process.env.COINFLOW_API_URL ?? 'https://api.coinflow.cash',
    apiKey: process.env.COINFLOW_API_KEY,
    // merchantId exposto ao front (SDK) via buildProviderPublicConfig.
    mid: process.env.COINFLOW_MERCHANT_ID,
    config: {
      webhook_url: process.env.COINFLOW_WEBHOOK_URL,
    },
  },
  {
    id: 'rox_pay_main',
    provider: 'rox_pay',
    status: 'active',
    weight: 1,
    // RoxDirect (card) via checkout hospedado. Moedas aceitas: allowlist
    // travada em payments.service.ts (USD/EUR/GBP/CHF/CAD/RON/JPY).
    supported_methods: ['card'],
    country: process.env.ROX_PAY_SETTLEMENT_COUNTRY,
    // Prod: https://app.roxpay.eu · Sandbox: https://sandbox.roxpay.eu
    api_url: process.env.ROX_PAY_API_URL ?? 'https://app.roxpay.eu',
    // apiKey/apiSecret = Username/Password das API Credentials da Rox Pay
    // (usadas em POST /auth/token pra gerar o Bearer JWT).
    apiKey: process.env.ROX_PAY_USERNAME,
    apiSecret: process.env.ROX_PAY_PASSWORD,
    config: {
      company_id: process.env.ROX_PAY_COMPANY_ID,
      webhook_secret: process.env.ROX_PAY_WEBHOOK_SECRET,
    },
  },
  // TESTE — aprova tudo de forma fictícia (demo/underwriting). Sem credenciais.
  // Associe a uma conta via seller_profiles.provider_default = 'simulator'.
  {
    id: 'simulator_main',
    provider: 'simulator',
    status: 'active',
    weight: 1,
    supported_methods: ['all'],
    config: {},
  },
];

export function getProviderAccountById(id: string): ProviderAccountConfig | undefined {
  return PROVIDER_ACCOUNTS.find(a => a.id === id);
}

export function getActiveProviderAccounts(): ProviderAccountConfig[] {
  return PROVIDER_ACCOUNTS.filter(a => a.status === 'active');
}
