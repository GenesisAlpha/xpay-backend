import { OwnProvider } from '../seller-provider/seller-provider-accounts';

// ============================================================================
// DOMÍNIOS DE PAGAMENTO DAS CONTAS PRÓPRIAS — regras puras
// ----------------------------------------------------------------------------
// Apple Pay e Google Pay só aparecem no checkout quando o domínio da página
// está registrado NA CONTA QUE COBRA. Para a conta própria do seller, o
// registro é feito na conta dele, com a chave que ele conectou:
//
//   • Stripe: `payment_method_domains` — o registro sozinho já libera Google
//     Pay e Link; Apple Pay exige o arquivo de associação DA STRIPE publicado
//     no domínio.
//   • Whop: `payment_method_domains` — a Whop verifica o arquivo de associação
//     DELA no domínio antes de registrar na Apple.
//   • PayPal: não tem carteira por domínio.
//
// Cada domínio serve UM arquivo, de UM provedor: num mesmo domínio o Apple Pay
// vale para a Whop ou para a Stripe, nunca para as duas.
// ============================================================================

export type WalletStatus = 'active' | 'pending' | 'not_required';

export interface OwnPaymentDomain {
  id: string | null;
  hostname: string;
  applePay: WalletStatus;
  googlePay: WalletStatus;
  /** Por que o Apple Pay ainda não está ativo (texto do provedor). */
  message: string | null;
}

export interface AssociationFile {
  provider: OwnProvider;
  /** De onde baixar o arquivo, byte a byte como o provedor publica. */
  url: string;
  /** Onde publicar no domínio. */
  path: string;
}

export const ASSOCIATION_FILE_PATH = '/.well-known/apple-developer-merchantid-domain-association';

const ASSOCIATION_FILE_URL: Partial<Record<OwnProvider, string>> = {
  whop: 'https://whop.com/.well-known/apple-platform-integrator/apple-developer-merchantid-domain-association',
  stripe: 'https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association',
};

/** Provedores que registram domínio (os que cobram cartão). */
export function supportsPaymentDomains(provider: OwnProvider): boolean {
  return provider === 'whop' || provider === 'stripe';
}

export function associationFileOf(provider: OwnProvider): AssociationFile | null {
  const url = ASSOCIATION_FILE_URL[provider];
  return url ? { provider, url, path: ASSOCIATION_FILE_PATH } : null;
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * "https://Loja.com/pagina" → "loja.com". Lança com a mensagem para o seller
 * quando não é um domínio. Domínio do provedor nunca entra.
 */
export function domainHostname(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');
  if (!HOSTNAME.test(value)) throw new Error('Domínio inválido. Informe só o endereço, como loja.com.');
  for (const blocked of ['whop.com', 'stripe.com', 'paypal.com']) {
    if (value === blocked || value.endsWith(`.${blocked}`)) throw new Error('Informe o domínio do seu site ou do seu checkout.');
  }
  return value;
}

/**
 * Domínios do checkout da Koopfy (onde o comprador paga quando o seller não
 * usa domínio próprio). Entram sozinhos em toda conta conectada.
 */
export function platformCheckoutHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts: string[] = [];
  for (const raw of [env.CHECKOUT_PUBLIC_URL ?? 'https://checkout.koopfy.com', ...(env.CHECKOUT_EXTRA_HOSTS ?? '').split(',')]) {
    try {
      const host = domainHostname(raw);
      if (!hosts.includes(host)) hosts.push(host);
    } catch { /* valor vazio ou inválido no ambiente: ignora */ }
  }
  return hosts;
}

const stripeWallet = (wallet: any, enabled: boolean): WalletStatus =>
  enabled && wallet?.status === 'active' ? 'active' : 'pending';

/** Payment Method Domain da Stripe → o que a tela mostra. */
export function mapStripeDomain(raw: any): OwnPaymentDomain {
  const enabled = raw?.enabled !== false;
  const applePay = stripeWallet(raw?.apple_pay, enabled);
  return {
    id: typeof raw?.id === 'string' ? raw.id : null,
    hostname: String(raw?.domain_name ?? '').toLowerCase(),
    applePay,
    googlePay: stripeWallet(raw?.google_pay, enabled),
    message: applePay === 'active'
      ? null
      : !enabled
        ? 'O domínio está desativado na Stripe.'
        : String(raw?.apple_pay?.status_details?.error_message ?? '').trim() || null,
  };
}

/**
 * Payment method domain da Whop → o que a tela mostra. A Whop só tem um
 * status (o do Apple Pay); o Google Pay dela não depende de registro.
 */
export function mapWhopDomain(raw: any): OwnPaymentDomain {
  return {
    id: typeof raw?.id === 'string' ? raw.id : null,
    hostname: String(raw?.hostname ?? '').toLowerCase(),
    applePay: raw?.status === 'verified' ? 'active' : 'pending',
    googlePay: 'not_required',
    message: null,
  };
}

/** Lista de qualquer um dos dois provedores ({data: []} ou []). */
export function domainItems(response: any): any[] {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}

/** Os da plataforma primeiro, depois em ordem alfabética; sem repetidos. */
export function sortDomains(domains: OwnPaymentDomain[], platformHosts: string[]): OwnPaymentDomain[] {
  const seen = new Set<string>();
  return domains
    .filter(domain => domain.hostname && !seen.has(domain.hostname) && seen.add(domain.hostname))
    .sort((a, b) => Number(platformHosts.includes(b.hostname)) - Number(platformHosts.includes(a.hostname))
      || a.hostname.localeCompare(b.hostname));
}
