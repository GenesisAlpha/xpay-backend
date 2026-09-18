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
export function decideConnectedMode(
  row: Pick<
    WhopConnectedAccountRow,
    'charges_enabled' | 'whop_account_id' | 'status' | 'risk_tier' | 'fallback_started_at' | 'fallback_disabled'
  > | null | undefined,
  nowMs = Date.now(),
): ConnectedModeDecision {
  if (!row || !row.charges_enabled) return { mode: 'master' };
  if (row.whop_account_id && row.status === 'active') return { mode: 'connected' };

  const down = row.whop_account_id ? `conta conectada ${row.status}` : 'conta conectada sem id da Whop';

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
// Decisões do dono (2026-09-17):
//
//   • o DONO da conta na Whop é a caixa da Koopfy (`contas@koopfy.com`), não o
//     seller: é para o dono que a Whop manda verificação, saque, disputa e
//     formulário fiscal. Com o e-mail dele, o seller recebia tudo direto da
//     Whop e ainda ganhava login lá. SEM "+": a Whop recusa subendereço
//     ("You entered an invalid email address. Please enter a real email
//     address", 2026-09-17). A mesma caixa vale para todas as contas;
//   • o imposto é da LLC do seller (`tax_remitted_by: self`) e vem INCLUSO no
//     preço — o comprador paga o que viu no checkout, e as taxas da Koopfy
//     são calculadas sobre esse mesmo valor;
//   • classificação fiscal padrão "Digital - SaaS". O id (`ptc_…`) não tem
//     endpoint de listagem documentado, então vem por env; sem ele, o resto
//     da configuração vale igual.

export const CONNECTED_OWNER_EMAIL_DEFAULT = 'contas@koopfy.com';

/**
 * E-mail do dono da conta conectada: a caixa da Koopfy, igual para todas as
 * contas. Um "+" configurado por engano é removido — a Whop recusa a criação
 * inteira com ele, e o provisionamento de todo seller novo pararia.
 */
export function connectedOwnerEmail(
  base: string = process.env.WHOP_CONNECTED_OWNER_EMAIL ?? CONNECTED_OWNER_EMAIL_DEFAULT,
): string {
  const [local, domain, ...rest] = String(base).trim().toLowerCase().split('@');
  if (!local || !domain || rest.length > 0 || !domain.includes('.')) {
    throw new Error(`WHOP_CONNECTED_OWNER_EMAIL inválido: "${base}"`);
  }
  return `${local.split('+')[0]}@${domain}`;
}

/** Erro da Whop que diz respeito ao e-mail do dono, e não ao cadastro do seller. */
export function isOwnerEmailRejection(message: string): boolean {
  return /invalid email|real email address/i.test(String(message ?? ''));
}

export interface ConnectedAccountSettings {
  send_customer_emails: false;
  tax_remitted_by: 'self';
  tax_type: 'inclusive';
  product_tax_code_id?: string;
}

/** O que toda conta conectada precisa ter na Whop. */
export function connectedAccountSettings(env: NodeJS.ProcessEnv = process.env): ConnectedAccountSettings {
  const taxCode = String(env.WHOP_CONNECTED_PRODUCT_TAX_CODE_ID ?? '').trim();
  return {
    // Nenhum e-mail transacional da Whop para o comprador: quem fala com ele é a Koopfy.
    send_customer_emails: false,
    tax_remitted_by: 'self',
    tax_type: 'inclusive',
    ...(taxCode.startsWith('ptc_') ? { product_tax_code_id: taxCode } : {}),
  };
}

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

/** LLC a partir de seller_documents. Campo inválido vira null. */
export function companyFrom(docs: any, website?: string | null) {
  const einDigits = String(docs?.company_ein ?? '').replace(/\D/g, '');
  const address = docs?.company_address ?? null;
  const zip = String(address?.postal_code ?? '').trim();
  const state = String(address?.state ?? '').trim().toUpperCase();
  const validAddress = Boolean(String(address?.line1 ?? '').trim() && String(address?.city ?? '').trim())
    && /^[A-Z]{2}$/.test(state) && /^\d{5}(-\d{4})?$/.test(zip);
  const formationState = String(docs?.company_formation_state ?? '').trim().toUpperCase();
  const siteCandidate = String(docs?.company_website ?? website ?? '').trim();

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
    website: /^https?:\/\//i.test(siteCandidate) ? siteCandidate.slice(0, 255) : null,
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
export function planBusinessVerification(kyc: any, docs: any, extra: { website?: string | null } = {}): BusinessVerificationPlan {
  const company = companyFrom(docs, extra.website);
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
      business_tax_identification_number: company.ein,
      ...(company.website ? { business_website: company.website } : {}),
      country: 'US',
      place_of_incorporation: company.formation_state,
      address: company.address,
      first_name: rep.first_name,
      last_name: rep.last_name,
      date_of_birth: rep.date_of_birth,
      // Representante brasileiro: o documento fiscal do país dele é o CPF.
      tax_identification_number: rep.tax_identification_number,
    },
  };
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
  source: { kyc: any; docs: any; email?: string | null; description?: string | null; website?: string | null },
  opts: { retryRequirements?: string[] } = {},
): { answers: RfiAnswer[]; unanswered: RfiUnanswered[] } {
  const rep = representativeFrom(source.kyc);
  const company = companyFrom(source.docs, source.website);
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
      case 'business_website':
      case 'social_media_or_website':
      case 'store_page_url': answer = text(item.id, company.website); break;
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
  business_website: 'company_website',
  social_media_or_website: 'company_website',
  store_page_url: 'company_website',
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

export function sellerRequirementItems(gaps: RequirementGap[], unanswered: RfiUnanswered[]): SellerRequirementItem[] {
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
    };
  };

  for (const gap of gaps) {
    const key = collapseKey(gap.key);
    // company_type: seller com CNPJ não tem pendência de LLC.
    if (key === 'company_type' || items.has(key)) continue;
    items.set(key, base(key, gap.label));
  }

  for (const request of unanswered ?? []) {
    const reason = request.reason === RFI_NOT_COLLECTED ? null : request.reason;
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
