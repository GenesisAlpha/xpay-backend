import * as crypto from 'crypto';

// ============================================================================
// CONTAS CONECTADAS DA WHOP — regras puras (sem banco, sem rede)
// ----------------------------------------------------------------------------
// Isolamento entre sellers: cada seller com LLC americana cobra na PRÓPRIA
// conta da Whop (cobrança direta), então a disputa conta na conta dele e não
// na master. O DINHEIRO, porém, fica na master: a application fee leva tudo
// e a Koopfy transfere a parte do seller quando o saldo é liberado.
//
// Tudo que decide "onde cobrar?", "quanto é a taxa?", "o que responder à
// Whop?", "o que pedir ao seller?", "este evento é deste seller?" mora aqui
// para ser testável sem mock de Supabase.
// ============================================================================

// Id da conta no router/transactions. A conta conectada não tem linha em
// whop_accounts: o id carrega o biz_ para o webhook e o reembolso acharem a
// conta sem consulta extra. ⚠️ Mudar o prefixo órfã as transações existentes.
export const WHOP_CONNECTED_PREFIX = 'whopc_';

export function toConnectedProviderAccountId(whopAccountId: string): string {
  return `${WHOP_CONNECTED_PREFIX}${whopAccountId}`;
}

export function isConnectedProviderAccountId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(WHOP_CONNECTED_PREFIX) && id.length > WHOP_CONNECTED_PREFIX.length;
}

export function whopAccountIdFromProviderAccountId(id: string): string | null {
  return isConnectedProviderAccountId(id) ? id.slice(WHOP_CONNECTED_PREFIX.length) : null;
}

export type ConnectedStatus =
  | 'provisioning'
  | 'pending_verification'
  | 'action_required'
  | 'active'
  | 'restricted'
  | 'suspended'
  | 'rejected';

// RESERVE = chargeback acima de 1%: a Koopfy retém 10% das vendas do seller.
export type ConnectedRiskTier = 'OK' | 'WATCH' | 'RESERVE';

export interface RfiUnanswered {
  id: string;
  requirement: string;
  label: string | null;
  reason: string;
  type: string | null;
  options: string[];
  optional: boolean;
}

export interface WhopConnectedAccountRow {
  seller_id: string;
  whop_account_id: string | null;
  status: ConnectedStatus;
  charges_enabled: boolean;
  /** Verificação da empresa (KYB). */
  verification_id: string | null;
  verification_status: string | null;
  /** Verificação da pessoa responsável (KYC). */
  individual_verification_id: string | null;
  individual_verification_status: string | null;
  requested_information: any[];
  rfi_answered: string[];
  rfi_unanswered: RfiUnanswered[];
  whop_status: string | null;
  status_reason: string | null;
  capabilities: Record<string, string>;
  payment_controls: Record<string, any>;
  required_actions: any[];
  risk_tier: ConnectedRiskTier;
  risk_reason: string | null;
  risk_evaluated_at: string | null;
  base_reserve_percentage: number | null;
  fallback_started_at: string | null;
  fallback_disabled: boolean;
  last_error: string | null;
  last_synced_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Pior situação primeiro: a conta só opera com as DUAS verificações aprovadas
// (empresa e pessoa), então uma parada em qualquer uma define o estado.
const VERIFICATION_SEVERITY: ConnectedStatus[] = [
  'rejected', 'action_required', 'pending_verification', 'provisioning',
];

function verificationStage(status: string | null | undefined): ConnectedStatus | 'approved' {
  if (!status || status === 'not_started') return 'provisioning';
  if (status === 'rejected') return 'rejected';
  if (status === 'action_required') return 'action_required';
  return status === 'approved' ? 'approved' : 'pending_verification';
}

export function deriveConnectedStatus(input: {
  accountStatus?: string | null;
  /** Verificação de empresa (KYB). */
  verificationStatus?: string | null;
  /** Verificação da pessoa responsável (KYC). Ausente = ainda não criada. */
  individualStatus?: string | null;
  capabilities?: Record<string, string> | null;
}): ConnectedStatus {
  if (input.accountStatus === 'suspended') return 'suspended';

  const stages = [verificationStage(input.verificationStatus)];
  if (input.individualStatus !== undefined) stages.push(verificationStage(input.individualStatus));
  const worst = VERIFICATION_SEVERITY.find(stage => stages.includes(stage));
  if (worst) return worst;

  // `capabilities` só vem calculado com company:balance:read. Ausente não é
  // "bloqueado": é "não sabemos", e a própria Whop recusa a cobrança se for.
  const card = input.capabilities?.accept_card_payments;
  return card === undefined || card === 'active' ? 'active' : 'restricted';
}

// ─── Aviso ao seller: continuar a verificação / conta verificada ─────────────

// `pending` é a sessão aberta esperando o seller (ex.: o EIN no formulário da
// empresa); `action_required`, algo recusado ou pedido de novo.
const WAITING_ON_SELLER = new Set(['pending', 'action_required', 'requires_input']);

/** Reaviso do "continue a verificação" quando nada mudou: no máximo a cada 3 dias. */
export const VERIFICATION_REMINDER_MS = 3 * 24 * 60 * 60 * 1000;

export type VerificationEmailDecision =
  | { send: 'verified' }
  | { send: 'verification_needed'; signature: string }
  | { send: null };

/**
 * Qual e-mail o sync manda. `verified` só na virada para `active` e uma vez na
 * vida da conta. `verification_needed` quando alguma verificação espera o
 * seller — de novo só se a situação mudou (assinatura) ou passaram 3 dias.
 */
export function verificationEmailDecision(input: {
  previousStatus: string | null | undefined;
  status: ConnectedStatus;
  businessStatus?: string | null;
  individualStatus?: string | null;
  verifiedAlreadySent: boolean;
  lastNeeded?: { signature?: string | null; at?: string | null } | null;
  now?: number;
}): VerificationEmailDecision {
  if (input.status === 'active') {
    return input.previousStatus !== 'active' && !input.verifiedAlreadySent ? { send: 'verified' } : { send: null };
  }
  if (input.status === 'suspended' || input.status === 'rejected') return { send: null };

  const waiting = input.status === 'action_required'
    || WAITING_ON_SELLER.has(String(input.businessStatus ?? ''))
    || WAITING_ON_SELLER.has(String(input.individualStatus ?? ''));
  if (!waiting) return { send: null };

  const signature = `${input.status}|business:${input.businessStatus ?? '-'}|individual:${input.individualStatus ?? '-'}`;
  const last = input.lastNeeded;
  const lastAt = last?.at ? Date.parse(last.at) : NaN;
  const fresh = Number.isFinite(lastAt) && (input.now ?? Date.now()) - lastAt < VERIFICATION_REMINDER_MS;
  if (last && last.signature === signature && fresh) return { send: null };
  return { send: 'verification_needed', signature };
}

// ─── Roteamento ──────────────────────────────────────────────────────────────

// Janela do fallback na master enquanto a conta conectada está fora do ar.
// Passou disso sem ninguém resolver, o seller para de vender: um problema que
// dura três dias deixou de ser instabilidade e virou decisão.
export const CONNECTED_FALLBACK_MAX_MS = 72 * 60 * 60 * 1000;

export type ConnectedModeDecision =
  | { mode: 'master' }
  | { mode: 'connected' }
  | { mode: 'fallback'; reason: string; startsNow: boolean }
  | { mode: 'blocked'; reason: string };

// charges_enabled é o MODO do seller. Conta conectada fora do ar cai na master
// só se ele não tiver risco (reserva acionada = chargeback acima de 1%), dentro
// da janela e sem o corte do CRM: se a Whop derrubou a conta POR fraude, é
// isso que impede a fraude de ir para a conta de todos.
/**
 * A conta conectada RECEBE pagamento? É isso que decide onde a venda nasce.
 * Saque parado (pedido de informação da Whop sobre payout: `status`
 * action_required, `standard_payout` inativo) não tira a venda da conta — a
 * própria Whop avisa "You can still accept payments during this time". Só
 * suspensão, recusa ou o recebimento por cartão desligado mandam para a master.
 */
export function payinActive(
  row: Pick<WhopConnectedAccountRow, 'status'> & Partial<Pick<WhopConnectedAccountRow, 'capabilities' | 'whop_status'>>,
): boolean {
  if (row.status === 'suspended' || row.status === 'rejected' || row.whop_status === 'suspended') return false;
  const card = row.capabilities?.accept_card_payments;
  // Sem `capabilities` (chave sem company:balance:read) não dá para separar
  // recebimento de saque: vale o status geral, como antes.
  if (card === undefined) return row.status === 'active';
  return card === 'active';
}

export function decideConnectedMode(
  row: Pick<
    WhopConnectedAccountRow,
    'charges_enabled' | 'whop_account_id' | 'status' | 'risk_tier' | 'fallback_started_at' | 'fallback_disabled'
  > & Partial<Pick<WhopConnectedAccountRow, 'capabilities' | 'whop_status'>> | null | undefined,
  nowMs = Date.now(),
): ConnectedModeDecision {
  if (!row || !row.charges_enabled) return { mode: 'master' };
  if (row.whop_account_id && payinActive(row)) return { mode: 'connected' };

  const down = !row.whop_account_id
    ? 'conta conectada sem id da Whop'
    : `conta conectada ${row.status}${row.status === 'active' ? ' sem recebimento por cartão' : ''}`;

  if (row.fallback_disabled) return { mode: 'blocked', reason: `${down}; fallback na master cortado no CRM` };
  if (row.risk_tier === 'RESERVE') return { mode: 'blocked', reason: `${down}; seller com chargeback acima de 1% não usa a master` };

  if (row.fallback_started_at) {
    const started = Date.parse(row.fallback_started_at);
    if (Number.isFinite(started) && nowMs - started > CONNECTED_FALLBACK_MAX_MS) {
      return { mode: 'blocked', reason: `${down}; fallback na master passou de 72h` };
    }
  }

  return { mode: 'fallback', reason: down, startsNow: !row.fallback_started_at };
}

/**
 * Motivo que impede ATIVAR o Koopfy Payments na loja, ou null se pode.
 *
 * Decisão do dono (2026-09-18): seller que precisa de conta conectada (toda
 * conta que não é CNPJ) só ativa depois que a Whop aprovar a verificação — a
 * conta nunca aparece como ativa antes da hora, e ninguém começa a vender pela
 * master esperando a verificação. Quem vende na conta Whop própria (modo conta
 * externa) não depende da conta conectada.
 */
export function connectedActivationBlocker(input: {
  required: boolean;
  status: string | null | undefined;
  externalProviderConnected?: boolean;
}): string | null {
  if (input.externalProviderConnected) return null;
  if (!input.required || input.status === 'active') return null;
  return 'A verificação da sua conta ainda não foi concluída. O Koopfy Payments é ativado nesta loja assim que ela for aprovada.';
}

/** Motivo que impede ligar o modo conectado, ou null se pode. */
export function connectedChargeBlocker(row: Pick<WhopConnectedAccountRow, 'whop_account_id' | 'status'>): string | null {
  if (!row.whop_account_id) return 'A conta conectada ainda não foi criada na Whop.';
  if (row.status !== 'active') {
    return `A conta conectada está "${row.status}". Só dá para ligar com a verificação aprovada.`;
  }
  return null;
}

// ─── Dados do onboarding no formato da Whop ─────────────────────────────────

export type WhopDocumentType = 'ID_CARD' | 'DRIVERS' | 'RESIDENCE_PERMIT' | 'PASSPORT';

export interface WhopAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

/** O que falta no cadastro, com a chave do campo que o seller preenche. */
export interface RequirementGap {
  key: string;
  label: string;
}

const DOCUMENT_SLOTS: Record<WhopDocumentType, Array<{ slot: string; column: 'identity_front_path' | 'identity_back_path' }>> = {
  ID_CARD: [
    { slot: 'id_card_front', column: 'identity_front_path' },
    { slot: 'id_card_back', column: 'identity_back_path' },
  ],
  DRIVERS: [
    { slot: 'drivers_front', column: 'identity_front_path' },
    { slot: 'drivers_back', column: 'identity_back_path' },
  ],
  RESIDENCE_PERMIT: [
    { slot: 'residence_permit_front', column: 'identity_front_path' },
    { slot: 'residence_permit_back', column: 'identity_back_path' },
  ],
  PASSPORT: [{ slot: 'passport_front', column: 'identity_front_path' }],
};

// Documento: JPEG, PNG ou PDF. Selfie: só JPEG ou PNG. O storage aceita WebP,
// a Whop não — melhor apontar no cadastro do que falhar a requisição inteira.
const DOCUMENT_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'pdf']);
const SELFIE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);

export const LLC_STRUCTURES = ['single_member_llc', 'multi_member_llc'];

function extensionOf(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match ? match[1].toLowerCase() : '';
}

// ─── Configuração da conta conectada na Whop ────────────────────────────────
//
// Decisões do dono (2026-09-17/18):
//
//   • o DONO da conta na Whop é o próprio seller (e-mail dele). Um dono comum
//     a todas as contas foi descartado: dono em comum é sinal clássico para a
//     processadora ligar contas, e o risco de uma contaminaria as outras — o
//     oposto do isolamento que justifica a conta conectada. Os avisos da Whop
//     ao seller são desligados à mão, na conta dele;
//   • o imposto é todo do seller, por fora da Whop: `tax_remitted_by: none`.
//     Na tela da Whop, `self` aparece como "Whop collects, I remit" (a Whop
//     calcula e cobra no checkout e o seller repassa) — não é isso; `whop` é
//     a Whop cobrando e recolhendo. O preço segue INCLUSO: o comprador paga o
//     que viu, e as taxas da Koopfy saem sobre esse mesmo valor;
//   • classificação fiscal padrão "Digital - SaaS". O id (`ptc_…`) não tem
//     endpoint de listagem documentado, então vem por env; sem ele, o resto
//     da configuração vale igual.

/** Recusa da Whop por endereço da empresa (ZIP que não bate com o estado, etc.). */
export function isAddressRejection(message: string): boolean {
  return /postal code|business address|zip/i.test(String(message ?? ''));
}

/**
 * Falha da Whop ao falar com um fornecedor dela — ex.: "Privy API error (0)",
 * a Privy cria o usuário dono da conta. Status 0 é chamada sem resposta: não
 * é o cadastro do seller, e uma nova tentativa (com chave nova) costuma passar.
 */
export function isTransientProviderFailure(message: string): boolean {
  return /privy api error|\(0\)|timed? ?out|temporar|try again/i.test(String(message ?? ''));
}

/**
 * Conta que a Whop já criou para este seller, pelo metadata que mandamos na
 * criação. Existe quando a Whop cria a conta mas responde erro (ex.: Privy
 * fora do ar): sem adotá-la, o banco fica sem o id, as verificações nunca são
 * abertas e a próxima tentativa cria uma segunda conta. Havendo mais de uma,
 * fica a mais antiga — é a que o seller pode já ter começado a verificar.
 */
export function existingSellerAccount(accounts: any[], sellerId: string): any | null {
  const owned = (accounts ?? []).filter(
    a =>
      String(a?.id ?? '').startsWith('biz_') &&
      (a?.metadata?.koopfy_seller_id === sellerId || a?.metadata?.external_id === sellerId),
  );
  owned.sort((a, b) => String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')));
  return owned[0] ?? null;
}

/**
 * Chave de idempotência da criação da conta conectada: seller + e-mail +
 * número da tentativa. A 1ª tentativa mantém o formato antigo (sem sufixo),
 * para quem já criou continuar reconhecido pela Whop.
 */
export function connectedAccountIdempotencyKey(sellerId: string, emailHash: string, attempt: number): string {
  const base = `koopfy_connect_account_${sellerId}_${emailHash}`;
  return attempt > 0 ? `${base}_a${attempt}` : base;
}

/** Recusa da Whop pelo e-mail do dono (o do seller), e não pelo resto do cadastro. */
export function isOwnerEmailRejection(message: string): boolean {
  return /invalid email|real email address/i.test(String(message ?? ''));
}

export interface ConnectedAccountSettings {
  send_customer_emails: false;
  tax_remitted_by: 'none';
  tax_type: 'inclusive';
  /**
   * Nenhum estado. Quando a conta passa por `self`, a Whop liga sozinha a
   * coleta nos 51 estados; com `none` a lista vazia garante que nada seja
   * calculado na venda, mesmo em conta que já passou por `self`.
   */
  tax_collection_enabled_states: string[];
  product_tax_code_id?: string;
}

/**
 * Configuração da conta recém-criada. Sem a lista de estados: conta nova não
 * remete o próprio imposto, e a Whop recusa o PATCH que a traz (ver
 * accountSettingsPatch).
 */
export function newAccountSettings(env: NodeJS.ProcessEnv = process.env) {
  const { tax_collection_enabled_states: _states, ...settings } = connectedAccountSettings(env);
  return settings;
}

/** O que toda conta conectada precisa ter na Whop. */
export function connectedAccountSettings(env: NodeJS.ProcessEnv = process.env): ConnectedAccountSettings {
  const taxCode = String(env.WHOP_CONNECTED_PRODUCT_TAX_CODE_ID ?? '').trim();
  return {
    // Nenhum e-mail transacional da Whop para o comprador: quem fala com ele é a Koopfy.
    send_customer_emails: false,
    tax_remitted_by: 'none',
    tax_type: 'inclusive',
    tax_collection_enabled_states: [],
    ...(taxCode.startsWith('ptc_') ? { product_tax_code_id: taxCode } : {}),
  };
}

// ─── Produto da cobrança: descritor na fatura ───────────────────────────────
//
// A conta conectada cobra num produto único (`external_identifier: koopfy`,
// o mesmo que o whop.provider usa no plano). O que o comprador vê na fatura do
// cartão é o `custom_statement_descriptor` DESTE produto — não há campo na
// conta. `WHOP*KOOPFY` (decisão do dono, 2026-09-18) é o mesmo nome que a área
// do cliente e o e-mail de confirmação mostram: fatura e tela têm de bater.
// O prefixo entra no valor: a Whop guarda como mandado (testado).

export const KOOPFY_PRODUCT_EXTERNAL_ID = 'koopfy';

/**
 * Identificador do produto da cobrança, UM POR LOJA (decisão do dono,
 * 2026-09-20). Antes era `koopfy` para tudo: na master, as vendas de todas as
 * lojas caíam no mesmo produto, e relatório, reembolso e disputa vinham
 * misturados. Sem loja no pedido, cai no identificador antigo — o produto que
 * já existe — em vez de inventar um.
 *
 * Isto NÃO isola risco: a conta continua sendo uma só. Risco separado é conta
 * conectada.
 */
export function koopfyProductExternalId(workspaceId?: string | null): string {
  const id = String(workspaceId ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return id ? `${KOOPFY_PRODUCT_EXTERNAL_ID}_${id.slice(0, 60)}` : KOOPFY_PRODUCT_EXTERNAL_ID;
}

/** Produto criado pelo checkout da Koopfy (o antigo, único, e os por loja). */
export function isKoopfyProduct(externalIdentifier?: string | null): boolean {
  const value = String(externalIdentifier ?? '');
  return value === KOOPFY_PRODUCT_EXTERNAL_ID || value.startsWith(`${KOOPFY_PRODUCT_EXTERNAL_ID}_`);
}

/**
 * Nome do produto na Whop: a LOJA, o mesmo que o comprador lê no título do
 * plano. Nunca o que ela vende (ver whop-plan-title.ts).
 */
export function koopfyProductTitle(storeName?: string | null): string {
  const name = String(storeName ?? '').trim().replace(/\s+/g, ' ');
  return name ? name.slice(0, 30) : KOOPFY_PRODUCT_TITLE;
}
export const KOOPFY_PRODUCT_TITLE = 'Koopfy';
export const CONNECTED_STATEMENT_DESCRIPTOR_DEFAULT = 'WHOP*KOOPFY';

/** Regras da Whop: 5 a 22 caracteres, ao menos uma letra, sem < > \ ' ". */
export function isValidStatementDescriptor(value: unknown): value is string {
  const text = String(value ?? '');
  return text.length >= 5 && text.length <= 22 && /[a-z]/i.test(text) && !/[<>\\'"]/.test(text);
}

export function connectedStatementDescriptor(
  value: string | undefined = process.env.WHOP_CONNECTED_STATEMENT_DESCRIPTOR,
): string {
  const text = String(value ?? '').trim().toUpperCase();
  return isValidStatementDescriptor(text) ? text : CONNECTED_STATEMENT_DESCRIPTOR_DEFAULT;
}

const TAX_STATES_EDITABLE = new Set(['self', 'none']);

/**
 * Só o que difere entre a conta na Whop e o desejado — ou null quando já
 * está certa. É o que o sync manda, para não fazer PATCH a cada webhook.
 */
export function accountSettingsPatch(
  account: any,
  desired: ConnectedAccountSettings,
): Partial<ConnectedAccountSettings> | null {
  const patch: Partial<ConnectedAccountSettings> = {};
  if (account?.send_customer_emails !== desired.send_customer_emails) {
    patch.send_customer_emails = desired.send_customer_emails;
  }
  if (account?.tax_remitted_by !== desired.tax_remitted_by) patch.tax_remitted_by = desired.tax_remitted_by;
  if (account?.tax_type !== desired.tax_type) patch.tax_type = desired.tax_type;
  const states = Array.isArray(account?.tax_collection_enabled_states) ? account.tax_collection_enabled_states : [];
  const wanted = desired.tax_collection_enabled_states;
  // A Whop valida a lista contra o modo que a conta JÁ tem: em conta nova
  // (modo vazio) ou `whop` ela recusa o PATCH inteiro ("Tax collection states
  // can only be set when the account remits its own tax"). A limpeza fica para
  // depois que o modo virou `none` (settleTaxStates / próximo sync).
  if (
    TAX_STATES_EDITABLE.has(String(account?.tax_remitted_by ?? '')) &&
    (states.length !== wanted.length || states.some((state: string) => !wanted.includes(state)))
  ) {
    patch.tax_collection_enabled_states = wanted;
  }
  if (desired.product_tax_code_id) {
    const current = account?.product_tax_code?.id ?? account?.product_tax_code_id ?? null;
    if (current !== desired.product_tax_code_id) patch.product_tax_code_id = desired.product_tax_code_id;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Representante da LLC a partir do KYC (pessoa física no Brasil). Campo inválido vira null. */
export function representativeFrom(kyc: any) {
  const nameParts = String(kyc?.full_name ?? '').trim().split(/\s+/).filter(Boolean);
  const cpf = String(kyc?.cpf ?? '').replace(/\D/g, '');
  const birthDate = String(kyc?.birth_date ?? '').slice(0, 10);
  const phone = String(kyc?.phone ?? '').replace(/[^\d+]/g, '');
  const cep = String(kyc?.cep ?? '').replace(/\D/g, '');
  const hasAddress = Boolean(kyc?.street && kyc?.number && kyc?.city && kyc?.state) && cep.length === 8;
  const line2 = [kyc?.complement, kyc?.neighborhood].filter((p: any) => String(p ?? '').trim()).join(' - ');

  return {
    first_name: nameParts.length >= 2 ? nameParts[0] : null,
    last_name: nameParts.length >= 2 ? nameParts.slice(1).join(' ') : null,
    date_of_birth: /^\d{4}-\d{2}-\d{2}$/.test(birthDate) ? birthDate : null,
    phone: /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null,
    tax_identification_number: cpf.length === 11 ? cpf : null,
    personal_address: hasAddress
      ? {
        line1: `${String(kyc.street).trim()}, ${String(kyc.number).trim()}`,
        line2: line2 || null,
        city: String(kyc.city).trim(),
        state: String(kyc.state).trim().toUpperCase(),
        postal_code: `${cep.slice(0, 5)}-${cep.slice(5)}`,
        country: 'BR',
      } as WhopAddress
      : null,
  };
}

/**
 * LLC a partir de seller_documents. Campo inválido vira null.
 *
 * Sem site: o endereço da loja NÃO vai para a Whop (decisão do dono,
 * 2026-09-18). Ele revela o que o seller vende — a Whop suspendeu uma conta
 * como "Unsupported business" logo depois de receber o site da loja.
 */
export function companyFrom(docs: any) {
  const einDigits = String(docs?.company_ein ?? '').replace(/\D/g, '');
  const address = docs?.company_address ?? null;
  const zip = String(address?.postal_code ?? '').trim();
  const state = String(address?.state ?? '').trim().toUpperCase();
  const validAddress = Boolean(String(address?.line1 ?? '').trim() && String(address?.city ?? '').trim())
    && /^[A-Z]{2}$/.test(state) && /^\d{5}(-\d{4})?$/.test(zip);
  const formationState = String(docs?.company_formation_state ?? '').trim().toUpperCase();

  return {
    isLlc: docs?.company_type === 'US',
    legal_name: String(docs?.company_legal_name ?? '').trim() || null,
    ein: einDigits.length === 9 ? `${einDigits.slice(0, 2)}-${einDigits.slice(2)}` : null,
    structure: LLC_STRUCTURES.includes(docs?.company_structure) ? String(docs.company_structure) : null,
    formation_state: /^[A-Z]{2}$/.test(formationState) ? formationState : null,
    address: validAddress
      ? {
        line1: String(address.line1).trim(),
        line2: String(address?.line2 ?? '').trim() || null,
        city: String(address.city).trim(),
        state,
        postal_code: zip,
        country: 'US',
      } as WhopAddress
      : null,
  };
}

function identitySlotsFrom(docs: any): { type: WhopDocumentType | null; slots: Array<{ slot: string; path: string }>; problems: RequirementGap[] } {
  const type = DOCUMENT_SLOTS[docs?.identity_document_type as WhopDocumentType]
    ? (docs.identity_document_type as WhopDocumentType)
    : null;
  const problems: RequirementGap[] = [];
  const slots: Array<{ slot: string; path: string }> = [];

  if (!type) {
    problems.push({
      key: 'identity_document_type',
      label: 'tipo do documento de identidade (RG, CNH, passaporte ou autorização de residência)',
    });
    return { type, slots, problems };
  }

  for (const { slot, column } of DOCUMENT_SLOTS[type]) {
    const front = column === 'identity_front_path';
    const key = front ? 'identity_front' : 'identity_back';
    const side = front ? 'frente' : 'verso';
    const path = docs?.[column];
    if (!path) problems.push({ key, label: `${side} do documento` });
    else if (!DOCUMENT_EXTENSIONS.has(extensionOf(path))) problems.push({ key, label: `${side} do documento em JPEG, PNG ou PDF` });
    else slots.push({ slot, path });
  }
  return { type, slots, problems };
}

// ─── Verificação de empresa (KYB) da LLC ────────────────────────────────────

export interface BusinessVerificationPlan {
  missing: string[];
  gaps: RequirementGap[];
  account: {
    business_name: string;
    business_address: WhopAddress;
    tax_identifiers: Array<{ tax_id_type: string; tax_id_value: string }>;
  } | null;
  verification: Record<string, any> | null;
}

/**
 * Monta a conta e a verificação de empresa da LLC a partir do onboarding.
 * A verificação de empresa não aceita documentos no pedido: documento, selfie
 * e papéis da empresa seguem depois, como resposta aos pedidos de informação
 * (planRfiAnswers). Por isso eles já são exigidos aqui — sem eles a conta
 * criada ficaria parada em `action_required`.
 *
 * Devolve TODOS os faltantes de uma vez, para corrigir num passo só.
 */
export function planBusinessVerification(kyc: any, docs: any): BusinessVerificationPlan {
  const company = companyFrom(docs);
  const rep = representativeFrom(kyc);
  const identity = identitySlotsFrom(docs);
  const gaps: RequirementGap[] = [];
  const gap = (key: string, label: string) => gaps.push({ key, label });

  if (!company.isLlc) gap('company_type', 'cadastro como empresa americana (LLC)');
  if (!company.legal_name) gap('company_legal_name', 'razão social da LLC');
  if (!company.ein) gap('company_ein', 'EIN (XX-XXXXXXX)');
  if (!company.structure) gap('company_structure', 'tipo da LLC (um ou mais sócios)');
  if (!company.formation_state) gap('company_formation_state', 'estado de abertura da LLC');
  if (!company.address) gap('company_address', 'endereço da LLC nos EUA (rua, cidade, estado e ZIP)');

  if (!rep.first_name) gap('kyc', 'nome completo do representante (nome e sobrenome)');
  if (!rep.date_of_birth) gap('kyc', 'data de nascimento do representante');
  if (!rep.phone) gap('phone', 'telefone do representante com DDI (ex.: +5511999999999)');
  if (!rep.tax_identification_number) gap('kyc', 'CPF do representante');
  if (!rep.personal_address) gap('kyc', 'endereço residencial do representante');

  if (!docs?.ein_document_path) gap('ein_document', 'carta do EIN');
  if (!docs?.articles_of_organization_path) gap('articles_of_organization', 'Articles of Organization');
  gaps.push(...identity.problems);

  const selfie = docs?.selfie_path;
  if (!selfie) gap('selfie', 'selfie');
  else if (!SELFIE_EXTENSIONS.has(extensionOf(selfie))) gap('selfie', 'selfie em JPEG ou PNG');

  const missing = gaps.map(g => g.label);
  if (missing.length > 0) return { missing, gaps, account: null, verification: null };

  return {
    missing,
    gaps,
    account: {
      business_name: company.legal_name!,
      business_address: company.address!,
      tax_identifiers: [{ tax_id_type: 'us_ein', tax_id_value: company.ein! }],
    },
    verification: {
      kind: 'business',
      business_name: company.legal_name,
      business_structure: company.structure,
      // O EIN vai em `tax_identification_number` ("SSN for individuals, EIN
      // for businesses"). `business_tax_identification_number` não existe na
      // API — era ignorado, e o CPF do representante ocupava o lugar do EIN:
      // a Whop pedia o EIN de novo no "continue verificando".
      tax_identification_number: company.ein,
      country: 'US',
      place_of_incorporation: company.formation_state,
      address: company.address,
      first_name: rep.first_name,
      last_name: rep.last_name,
      date_of_birth: rep.date_of_birth,
      // O CPF do representante vai na verificação DELE (individual), não aqui.
    },
  };
}

// ─── Documentos da pessoa, direto na verificação ────────────────────────────
//
// Sem documentos, a verificação nasce `pending` — "while a session needs the
// user's input": a Whop espera a PESSOA abrir o `session_url` e concluir lá, e
// os campos que mandamos só pré-preenchem esse formulário. Ninguém abria o link
// e a conta ficava em "continue verificando" para sempre.
//
// Com o documento e a selfie no próprio pedido não existe sessão: a Whop
// analisa direto ("one POST, then poll"). Os arquivos já estão no cadastro —
// as chaves (`id_card_front`, `passport_front`, `selfie`…) são as mesmas das
// respostas de pedido de documento. Base64 cru, até 5 MB por arquivo (o limite
// é conferido no download, em loadDocuments).

export interface IdentityDocumentsPlan {
  documentType: WhopDocumentType | null;
  /** Arquivo do storage por chave da Whop, na ordem em que são enviados. */
  files: Array<{ slot: string; path: string }>;
  problems: RequirementGap[];
}

export function identityDocumentsPlan(docs: any): IdentityDocumentsPlan {
  const identity = identitySlotsFrom(docs);
  const problems = [...identity.problems];
  const files = [...identity.slots];

  const selfie = docs?.selfie_path;
  if (!selfie) problems.push({ key: 'selfie', label: 'selfie' });
  // A selfie precisa ser foto: PDF, que vale para o documento, aqui é recusado.
  else if (!SELFIE_EXTENSIONS.has(extensionOf(selfie))) problems.push({ key: 'selfie', label: 'selfie em JPEG ou PNG' });
  else files.push({ slot: 'selfie', path: selfie });

  return { documentType: identity.type, files: problems.length > 0 ? [] : files, problems };
}

// ─── Verificação da pessoa responsável (KYC) ────────────────────────────────
//
// A conta conectada precisa das duas verificações: a da empresa (LLC) e a da
// pessoa que responde por ela. Os dados são os mesmos do onboarding; documento
// e selfie seguem depois, como resposta aos pedidos da Whop.

export function planIndividualVerification(kyc: any): {
  missing: string[];
  gaps: RequirementGap[];
  verification: Record<string, any> | null;
} {
  const rep = representativeFrom(kyc);
  const gaps: RequirementGap[] = [];
  const gap = (key: string, label: string) => gaps.push({ key, label });

  if (!rep.first_name) gap('kyc', 'nome completo do responsável (nome e sobrenome)');
  if (!rep.date_of_birth) gap('kyc', 'data de nascimento do responsável');
  if (!rep.phone) gap('phone', 'telefone do responsável com DDI (ex.: +5511999999999)');
  if (!rep.tax_identification_number) gap('kyc', 'CPF do responsável');
  if (!rep.personal_address) gap('kyc', 'endereço residencial do responsável');

  const missing = gaps.map(g => g.label);
  if (missing.length > 0) return { missing, gaps, verification: null };

  return {
    missing,
    gaps,
    verification: {
      kind: 'individual',
      // Pessoa brasileira: país do documento é o BR e o número fiscal é o CPF.
      country: 'BR',
      first_name: rep.first_name,
      last_name: rep.last_name,
      date_of_birth: rep.date_of_birth,
      phone: rep.phone,
      tax_identification_number: rep.tax_identification_number,
      address: rep.personal_address,
    },
  };
}

/**
 * Pedidos das duas verificações numa lista só, cada item sabendo de qual
 * verificação veio — a resposta vai para o `idpf_` certo.
 */
export function mergeRequestedInformation(
  verifications: Array<{ id?: string | null; requested_information?: any[] } | null | undefined>,
): Array<Record<string, any>> {
  const items: Array<Record<string, any>> = [];
  for (const verification of verifications) {
    if (!verification?.id) continue;
    for (const item of verification.requested_information ?? []) {
      if (item?.id) items.push({ ...item, verification_id: verification.id });
    }
  }
  return items;
}

// ─── Respostas aos pedidos de informação (RFI) ──────────────────────────────
//
// A Whop pede o que falta por `requested_information`. Respondemos sozinhos o
// que o onboarding já tem; o resto vira pendência no painel do seller. Um item
// com `errors` (resposta anterior recusada) só é reenviado quando o seller
// mandou dado novo para aquele requisito (`retryRequirements`) — reenviar o
// mesmo arquivo seria recusado de novo.

export interface RfiItem {
  id: string;
  requirement: string;
  type?: string;
  label?: string | null;
  options?: any[];
  optional?: boolean;
  errors?: Array<{ code?: string; reason?: string }>;
}

export type RfiAnswer =
  | { id: string; value: string }
  | { id: string; address: WhopAddress }
  | { id: string; filePaths: string[] }
  | { id: string; documentSlots: Array<{ slot: string; path: string }> };

// Motivo interno de "não temos o dado": o seller vê só o pedido, sem este texto.
export const RFI_NOT_COLLECTED = 'dado não coletado no onboarding';
/** Resposta sobre o negócio guardada para o CRM aprovar (não foi à Whop). */
export const RFI_IN_REVIEW = 'resposta em análise pela Koopfy';

// ─── Pedidos sobre o negócio: passam pelo CRM ───────────────────────────────
// O que o seller vende, como entrega, descrição do negócio/produto, site e
// políticas: a resposta (dele ou do cadastro) vai para o CRM aprovar antes de
// chegar à Whop. Dados pessoais e documentos da empresa seguem direto.
const REVIEWED_RFI_REQUIREMENTS = new Set([
  'proof_of_fulfillment',
  'business_description',
  'product_description',
  'business_website',
  'website',
  'company_website',
  'refund_policy',
  'terms_of_service',
  'customer_support',
  'marketing_materials',
  'sales_channels',
]);
const REVIEWED_RFI_PATTERN = /fulfil|product|website|business_description|refund|marketing|sales|customer|deliver|inventory|supplier|invoice|traffic/i;

export function rfiNeedsReview(requirement: string | null | undefined): boolean {
  const key = String(requirement ?? '');
  return REVIEWED_RFI_REQUIREMENTS.has(key) || REVIEWED_RFI_PATTERN.test(key);
}

function optionValues(options: any[] | undefined): string[] {
  return (options ?? [])
    .map(o => (typeof o === 'string' ? o : o?.value ?? o?.id ?? null))
    .filter((v): v is string => typeof v === 'string');
}

function pickOption(options: any[] | undefined, preferred: Array<string | RegExp>): string | null {
  const values = optionValues(options);
  for (const want of preferred) {
    const hit = values.find(v => (typeof want === 'string' ? v.toLowerCase() === want.toLowerCase() : want.test(v)));
    if (hit) return hit;
  }
  return null;
}

export function planRfiAnswers(
  items: RfiItem[],
  source: { kyc: any; docs: any; email?: string | null; description?: string | null },
  opts: { retryRequirements?: string[] } = {},
): { answers: RfiAnswer[]; unanswered: RfiUnanswered[] } {
  const rep = representativeFrom(source.kyc);
  const company = companyFrom(source.docs);
  const identity = identitySlotsFrom(source.docs);
  const description = String(source.description ?? '').trim();
  const retry = new Set(opts.retryRequirements ?? []);

  const answers: RfiAnswer[] = [];
  const unanswered: RfiUnanswered[] = [];

  const text = (id: string, value: string | null | undefined) => (value ? ({ id, value } as RfiAnswer) : null);
  const files = (id: string, path: string | null | undefined) => (path ? ({ id, filePaths: [path] } as RfiAnswer) : null);
  const pending = (item: RfiItem, reason: string): RfiUnanswered => ({
    id: item.id,
    requirement: item.requirement,
    label: item.label ?? null,
    reason,
    type: item.type ?? null,
    options: optionValues(item.options),
    optional: item.optional === true,
  });

  for (const item of items) {
    if (!item?.id) continue;

    if (item.errors?.length && !retry.has(item.requirement)) {
      unanswered.push(pending(
        item,
        `resposta anterior recusada: ${item.errors.map(e => e.reason ?? e.code).filter(Boolean).join('; ') || 'sem motivo'}`,
      ));
      continue;
    }

    let answer: RfiAnswer | null = null;
    switch (item.requirement) {
      case 'first_name': answer = text(item.id, rep.first_name); break;
      case 'last_name': answer = text(item.id, rep.last_name); break;
      case 'creator_legal_name':
        answer = text(item.id, rep.first_name ? `${rep.first_name} ${rep.last_name}` : null); break;
      case 'date_of_birth': answer = text(item.id, rep.date_of_birth); break;
      case 'email':
      case 'creator_email_address': answer = text(item.id, source.email ?? null); break;
      case 'phone_number': answer = text(item.id, rep.phone); break;
      case 'personal_address':
        answer = rep.personal_address ? { id: item.id, address: rep.personal_address } : null; break;
      case 'personal_id_number': answer = text(item.id, rep.tax_identification_number); break;
      case 'personal_id_number_country': answer = text(item.id, pickOption(item.options, ['BR', /^bra/i])); break;
      case 'country_of_issue': answer = text(item.id, 'BR'); break;

      case 'business_name':
      case 'company_title': answer = text(item.id, company.legal_name); break;
      case 'ein':
      case 'company_tax_id': answer = text(item.id, company.ein); break;
      case 'business_structure': answer = text(item.id, pickOption(item.options, [company.structure ?? ''])); break;
      case 'account_type': answer = text(item.id, pickOption(item.options, ['company'])); break;
      case 'business_representative_title':
        answer = text(item.id, pickOption(item.options, ['Owner', /owner/i, /member/i, /manager/i])); break;
      case 'business_address':
        answer = company.address ? { id: item.id, address: company.address } : null; break;
      // Site da loja nunca é respondido por nós (ver companyFrom): o pedido
      // fica pendente para a Koopfy decidir o que informar.
      case 'business_description':
        // A Whop exige 100–1000 caracteres; fora disso quem escreve é o seller.
        answer = text(item.id, description.length >= 100 ? description.slice(0, 1000) : null); break;
      case 'product_description': answer = text(item.id, description || null); break;

      case 'identity_document':
        answer = identity.slots.length && !identity.problems.length ? { id: item.id, documentSlots: identity.slots } : null; break;
      case 'selfie': answer = files(item.id, source.docs?.selfie_path); break;
      case 'business_verification_document': answer = files(item.id, source.docs?.ein_document_path); break;
      case 'business_incorporation_papers': answer = files(item.id, source.docs?.articles_of_organization_path); break;
      case 'ownership_structure': answer = files(item.id, source.docs?.operating_agreement_path); break;
    }

    if (answer) answers.push(answer);
    else unanswered.push(pending(item, RFI_NOT_COLLECTED));
  }

  return { answers, unanswered };
}

// ─── Pendências para o seller ───────────────────────────────────────────────
//
// Junta o que falta no cadastro (gaps) com o que a Whop pediu e não deu para
// responder sozinho. Pedido da Whop que corresponde a um campo do cadastro vira
// esse campo (o seller corrige uma vez e a resposta sai sozinha); pedido sem
// correspondência é respondido direto pelo seller (texto, data, arquivo…).

export type SellerRequirementInput =
  | 'kyc' | 'phone' | 'text' | 'select' | 'date' | 'address' | 'file' | 'identity';

export interface SellerRequirementItem {
  key: string;
  label: string;
  input: SellerRequirementInput;
  source: 'cadastro' | 'whop';
  reason: string | null;
  rfiId: string | null;
  options: string[];
  optional: boolean;
  /** Pedido sobre o negócio respondido e ainda no CRM; `rejected` traz o motivo. */
  review: { status: 'pending_review' | 'rejected'; note: string | null } | null;
}

// Requisito da Whop → campo do cadastro que responde a ele.
const RFI_ONBOARDING_KEY: Record<string, string> = {
  first_name: 'kyc',
  last_name: 'kyc',
  creator_legal_name: 'kyc',
  date_of_birth: 'kyc',
  personal_address: 'kyc',
  personal_id_number: 'kyc',
  phone_number: 'phone',
  business_name: 'company_legal_name',
  company_title: 'company_legal_name',
  ein: 'company_ein',
  company_tax_id: 'company_ein',
  business_structure: 'company_structure',
  business_address: 'company_address',
  // Site: sem campo do cadastro — ele não vai para a Whop (ver companyFrom).
  // Se ela pedir, aparece como pedido avulso e alguém decide o que responder.
  identity_document: 'identity',
  selfie: 'selfie',
  business_verification_document: 'ein_document',
  business_incorporation_papers: 'articles_of_organization',
  ownership_structure: 'operating_agreement',
};

const KEY_ITEM: Record<string, { label: string; input: SellerRequirementInput; options?: string[] }> = {
  kyc: { label: 'Dados pessoais do responsável', input: 'kyc' },
  phone: { label: 'Telefone com DDI', input: 'phone' },
  company_legal_name: { label: 'Razão social da LLC', input: 'text' },
  company_ein: { label: 'EIN da LLC', input: 'text' },
  company_structure: { label: 'Sócios da LLC', input: 'select', options: LLC_STRUCTURES },
  company_formation_state: { label: 'Estado de abertura da LLC', input: 'text' },
  company_address: { label: 'Endereço da LLC nos EUA', input: 'address' },
  company_website: { label: 'Site da empresa', input: 'text' },
  ein_document: { label: 'Carta do EIN', input: 'file' },
  articles_of_organization: { label: 'Articles of Organization', input: 'file' },
  operating_agreement: { label: 'Operating Agreement', input: 'file' },
  identity: { label: 'Documento de identidade (frente e verso)', input: 'identity' },
  selfie: { label: 'Selfie', input: 'file' },
};

// Frente, verso e tipo do documento são corrigidos juntos, num campo só.
function collapseKey(key: string): string {
  return key.startsWith('identity_') ? 'identity' : key;
}

/** Requisitos da Whop que um campo do cadastro responde — para reenviar depois que o seller corrige. */
export function rfiRequirementsForKeys(keys: string[]): string[] {
  const wanted = new Set(keys.map(collapseKey));
  return Object.entries(RFI_ONBOARDING_KEY)
    .filter(([, key]) => wanted.has(key))
    .map(([requirement]) => requirement);
}

export function sellerRequirementItems(
  gaps: RequirementGap[],
  unanswered: RfiUnanswered[],
  reviews: Map<string, { status: string; review_note?: string | null }> = new Map(),
): SellerRequirementItem[] {
  const items = new Map<string, SellerRequirementItem>();

  const base = (key: string, fallbackLabel: string): SellerRequirementItem => {
    const known = KEY_ITEM[key];
    return {
      key,
      label: known?.label ?? fallbackLabel,
      input: known?.input ?? 'text',
      source: 'cadastro',
      reason: null,
      rfiId: null,
      options: known?.options ?? [],
      optional: false,
      review: null,
    };
  };

  for (const gap of gaps) {
    const key = collapseKey(gap.key);
    // company_type: seller com CNPJ não tem pendência de LLC.
    if (key === 'company_type' || items.has(key)) continue;
    items.set(key, base(key, gap.label));
  }

  for (const request of unanswered ?? []) {
    const reason = request.reason === RFI_NOT_COLLECTED || request.reason === RFI_IN_REVIEW ? null : request.reason;
    const mapped = RFI_ONBOARDING_KEY[request.requirement];

    if (mapped) {
      const current = items.get(mapped) ?? base(mapped, request.label ?? request.requirement);
      items.set(mapped, { ...current, source: 'whop', reason: reason ?? current.reason });
      continue;
    }

    const input: SellerRequirementInput = request.type === 'files'
      ? 'file'
      : request.type === 'id_document'
        ? 'identity'
        : (['select', 'date', 'phone', 'address'] as const).includes(request.type as any)
          ? request.type as SellerRequirementInput
          : 'text';

    items.set(`rfi:${request.id}`, {
      key: `rfi:${request.id}`,
      label: request.label ?? request.requirement,
      input,
      source: 'whop',
      reason,
      rfiId: request.id,
      options: request.options ?? [],
      optional: request.optional === true,
      review: reviewFor(reviews.get(request.id)),
    });
  }

  return [...items.values()];
}

// ─── Taxa da plataforma (application fee) ────────────────────────────────────
//
// O saldo fica na master: a fee pede o valor inteiro menos 1 centavo (a Whop
// exige fee MENOR que o valor). Ela desconta as próprias taxas antes e limita a
// coleta ao que sobra — a master recebe o líquido da Whop, a conta do seller
// fica zerada. A divisão com o seller é feita na carteira da Koopfy, como nas
// vendas da master, e a parte dele vai para a conta conectada na liberação.

export function connectedApplicationFee(chargeAmount: number): { fee: number } | { error: string } {
  const price = Number(chargeAmount);
  if (!Number.isFinite(price) || price <= 0.01) {
    return { error: `valor cobrado baixo demais para a taxa da plataforma (${chargeAmount})` };
  }
  return { fee: Math.round((price - 0.01) * 100) / 100 };
}

// ─── Risco por seller ────────────────────────────────────────────────────────
//
// A conta conectada não é desativada por risco. O remédio é financeiro: com
// chargeback acima de 1% a Koopfy retém 10% das vendas do seller (a Whop só
// age em 1,5%). WATCH é só alerta, para alguém olhar antes de chegar lá.

const RISK_WATCH = 0.005;
const RISK_RESERVE = 0.01;
const RISK_MIN_SAMPLE = 50;
// Com menos de 50 vendas, 1 disputa já passa de 1% — contagem absoluta evita
// reter o seller novo por um único chargeback.
const RISK_FLOOR_RESERVE = 3;

export const RISK_RESERVE_PERCENTAGE = 10;

const TIER_RANK: Record<ConnectedRiskTier, number> = { OK: 0, WATCH: 1, RESERVE: 2 };

export function riskTierRank(tier: ConnectedRiskTier): number {
  return TIER_RANK[tier] ?? 0;
}

// Só sobe sozinho. Descer é humano (CRM): uma semana boa depois de dez
// disputas não significa que a causa foi embora — só que as disputas ainda
// não chegaram.
export function escalateRiskTier(current: ConnectedRiskTier | null | undefined, next: ConnectedRiskTier): ConnectedRiskTier {
  const base = current && TIER_RANK[current] !== undefined ? current : 'OK';
  return TIER_RANK[next] > TIER_RANK[base] ? next : base;
}

export function classifyConnectedRisk(m: {
  paidCount: number;
  disputeCount: number;
  alertCount: number;
  refundCount: number;
}): { tier: ConnectedRiskTier; reason: string; disputeRate: number; alertRate: number; lowSample: boolean } {
  const denom = Math.max(m.paidCount, 1);
  const disputeRate = m.disputeCount / denom;
  const alertRate = m.alertCount / denom;
  const lowSample = m.paidCount < RISK_MIN_SAMPLE;
  const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
  const result = (tier: ConnectedRiskTier, reason: string) => ({ tier, reason, disputeRate, alertRate, lowSample });

  if (lowSample) {
    if (m.disputeCount >= RISK_FLOOR_RESERVE) {
      return result('RESERVE', `${m.disputeCount} disputas em ${m.paidCount} vendas (amostra pequena)`);
    }
    if (m.disputeCount > 0 || m.alertCount > 0) {
      return result('WATCH', `${m.disputeCount} disputa(s) e ${m.alertCount} alerta(s) em ${m.paidCount} vendas`);
    }
    return result('OK', 'dentro do padrão');
  }

  if (disputeRate >= RISK_RESERVE) return result('RESERVE', `chargeback em ${pct(disputeRate)}`);
  if (disputeRate >= RISK_WATCH || alertRate >= RISK_WATCH) {
    return result('WATCH', `chargeback ${pct(disputeRate)} / alertas ${pct(alertRate)}`);
  }
  return result('OK', 'dentro do padrão');
}

// ─── Transferências (liberação e cobertura de negativo) ─────────────────────

// Abaixo de US$ 1 a transferência custa mais do que move; o saldo espera.
export const RELEASE_MIN_CENTS = 100;

export function classifyWhopTransfer(transfer: any): 'succeeded' | 'failed' | 'processing' {
  const status = String(transfer?.status ?? '').toLowerCase();
  if (status === 'succeeded' || status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'processing';
}

/**
 * Recusa definitiva: o saldo volta para o seller na hora. Timeout, 409
 * (mesma chave ainda em andamento), 429 e 5xx NÃO são: a transferência pode
 * ter saído, então fica em aberto e é retomada com a mesma chave.
 */
export function isDefinitiveWhopFailure(status: number): boolean {
  if (status === 0) return true; // configuração ausente: nada foi enviado
  return status >= 400 && status < 500 && status !== 409 && status !== 429;
}

/** Saldos negativos (moedas fiduciárias) de uma conta, a partir de `balances[]` do Retrieve Account. */
export function negativeFiatBalances(balances: any[] | null | undefined): Array<{ currency: string; amount: number }> {
  return (Array.isArray(balances) ? balances : [])
    .map(b => ({ currency: String(b?.symbol ?? '').toLowerCase(), balance: Number(b?.balance) }))
    .filter(b => /^[a-z]{3}$/.test(b.currency) && Number.isFinite(b.balance) && b.balance < 0)
    .map(b => ({ currency: b.currency, amount: Math.round(-b.balance * 100) / 100 }));
}

// ─── Eventos do webhook das contas conectadas ───────────────────────────────

/** biz_ da conta que gerou o evento. Envelope novo usa account_id; o fixado antes de 2026-08-14, company_id. */
export function extractWhopEventAccountId(body: any): string | null {
  const id = body?.account_id ?? body?.company_id ?? null;
  return typeof id === 'string' && id.startsWith('biz_') ? id : null;
}

/**
 * Segredo dos eventos das contas conectadas. Padrão: o mesmo webhook da master
 * com "eventos de contas conectadas" ligado, logo o mesmo WHOP_WEBHOOK_SECRET.
 * WHOP_CONNECTED_WEBHOOK_SECRET só é preciso num webhook separado.
 */
export function connectedWebhookSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.WHOP_CONNECTED_WEBHOOK_SECRET?.trim() || env.WHOP_WEBHOOK_SECRET?.trim() || null;
}

export function extractWhopEventMetadata(body: any): Record<string, any> {
  const data = body?.data ?? {};
  return data?.metadata
    ?? data?.payment?.metadata
    ?? data?.checkout_configuration?.metadata
    ?? data?.plan?.metadata
    ?? body?.metadata
    ?? {};
}

/**
 * Evento de uma conta conectada só pode mexer em transação DO MESMO seller e
 * DA MESMA conta. A assinatura prova que veio da Whop, não que o metadata
 * aponta para a transação certa — sem isto, um pagamento no seller A com
 * metadata de uma transação do seller B aprovaria o pedido de B.
 */
export function checkConnectedEventOwnership(args: {
  connectedSellerId: string;
  providerAccountId: string;
  metadata: Record<string, any>;
  transaction?: { seller_id?: string | null; provider_account_id?: string | null } | null;
}): { ok: true } | { ok: false; reason: string } {
  const metaSeller = args.metadata?.koopfy_seller_id;
  if (metaSeller != null && String(metaSeller) !== args.connectedSellerId) {
    return { ok: false, reason: `metadata aponta para o seller ${metaSeller}` };
  }

  const metaAccount = args.metadata?.koopfy_account_id;
  if (metaAccount != null && String(metaAccount) !== args.providerAccountId) {
    return { ok: false, reason: `metadata aponta para a conta ${metaAccount}` };
  }

  const tx = args.transaction;
  if (tx) {
    if (String(tx.seller_id ?? '') !== args.connectedSellerId) {
      return { ok: false, reason: `transação pertence ao seller ${tx.seller_id}` };
    }
    if (tx.provider_account_id && tx.provider_account_id !== args.providerAccountId) {
      return { ok: false, reason: `transação cobrada na conta ${tx.provider_account_id}` };
    }
  }

  return { ok: true };
}

// Standard Webhooks, com a mesma derivação de chave de
// WebhookService.verifyWhopSignature (segredo `ws_…` usado CRU; `whsec_…`
// base64-decodado). Duplicado aqui para o endpoint das contas conectadas
// validar ANTES de ler o banco — o método de lá é privado e resolve a conta
// primeiro.
export function verifyWhopWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  toleranceSeconds = 5 * 60,
  nowSeconds = Math.floor(Date.now() / 1000),
): { valid: boolean; reason?: string } {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];

  if (!id || !timestamp || !signatureHeader) return { valid: false, reason: 'missing signature headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid timestamp' };
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return { valid: false, reason: 'timestamp fora da tolerância' };

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const keys: Buffer[] = [Buffer.from(secret, 'utf8')];
  if (secret.startsWith('whsec_')) keys.push(Buffer.from(secret.slice('whsec_'.length), 'base64'));

  const provided = signatureHeader
    .split(' ')
    .map(part => part.split(',')[1] ?? '')
    .filter(Boolean);
  if (provided.length === 0) return { valid: false, reason: 'no v1 signature' };

  for (const key of keys) {
    const expected = Buffer.from(crypto.createHmac('sha256', key).update(signedContent).digest('base64'));
    for (const candidate of provided) {
      const candidateBuf = Buffer.from(candidate);
      if (candidateBuf.length === expected.length && crypto.timingSafeEqual(candidateBuf, expected)) {
        return { valid: true };
      }
    }
  }

  return { valid: false, reason: 'signature mismatch' };
}

function reviewFor(sub: { status: string; review_note?: string | null } | undefined): SellerRequirementItem['review'] {
  if (!sub) return null;
  // Falha no envio é problema nosso: para o seller continua em análise.
  if (sub.status === 'pending_review' || sub.status === 'send_failed') return { status: 'pending_review', note: null };
  if (sub.status === 'rejected') return { status: 'rejected', note: sub.review_note ?? null };
  return null;
}
