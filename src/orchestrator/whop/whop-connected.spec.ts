import * as crypto from 'crypto';
import {
  connectedStatementDescriptor,
  isValidStatementDescriptor,
  identityDocumentsPlan,
  accountSettingsPatch,
  connectedAccountSettings,
  isOwnerEmailRejection,
  CONNECTED_FALLBACK_MAX_MS,
  checkConnectedEventOwnership,
  classifyConnectedRisk,
  classifyWhopTransfer,
  connectedApplicationFee,
  decideConnectedMode,
  deriveConnectedStatus,
  escalateRiskTier,
  extractWhopEventAccountId,
  isConnectedProviderAccountId,
  isDefinitiveWhopFailure,
  negativeFiatBalances,
  RFI_NOT_COLLECTED,
  mergeRequestedInformation,
  planBusinessVerification,
  planIndividualVerification,
  planRfiAnswers,
  rfiRequirementsForKeys,
  sellerRequirementItems,
  toConnectedProviderAccountId,
  verifyWhopWebhookSignature,
  whopAccountIdFromProviderAccountId,
} from './whop-connected';

const kyc = {
  full_name: 'Maria da Silva Souza',
  cpf: '529.982.247-25',
  birth_date: '1990-05-17',
  phone: '+5511987654321',
  cep: '01310100',
  street: 'Av. Paulista',
  number: '1000',
  complement: 'Sala 5',
  neighborhood: 'Bela Vista',
  city: 'São Paulo',
  state: 'sp',
};

const docs = {
  company_type: 'US',
  company_legal_name: 'Petal Post, LLC',
  company_ein: '12-3456789',
  company_structure: 'single_member_llc',
  company_formation_state: 'WY',
  company_address: { line1: '30 N Gould St', line2: 'Ste R', city: 'Sheridan', state: 'WY', postal_code: '82801' },
  company_website: 'https://petalpost.com',
  ein_document_path: 'u1/ein_document.pdf',
  articles_of_organization_path: 'u1/articles_of_organization.pdf',
  operating_agreement_path: 'u1/operating_agreement.pdf',
  identity_document_type: 'ID_CARD',
  identity_front_path: 'u1/identity_front.jpg',
  identity_back_path: 'u1/identity_back.png',
  selfie_path: 'u1/selfie.jpg',
};

describe('ids da conta conectada', () => {
  it('ida e volta entre biz_ e o id do router', () => {
    const id = toConnectedProviderAccountId('biz_seller');
    expect(id).toBe('whopc_biz_seller');
    expect(isConnectedProviderAccountId(id)).toBe(true);
    expect(whopAccountIdFromProviderAccountId(id)).toBe('biz_seller');
    expect(isConnectedProviderAccountId('whop_main')).toBe(false);
    expect(whopAccountIdFromProviderAccountId('whop_main')).toBeNull();
  });

  it('lê a conta do envelope novo e do fixado antes de 2026-08-14', () => {
    expect(extractWhopEventAccountId({ account_id: 'biz_a' })).toBe('biz_a');
    expect(extractWhopEventAccountId({ company_id: 'biz_b' })).toBe('biz_b');
    expect(extractWhopEventAccountId({ account_id: 'user_x' })).toBeNull();
    expect(extractWhopEventAccountId({})).toBeNull();
  });
});

describe('planBusinessVerification (LLC)', () => {
  it('monta a conta e a verificação de empresa a partir do onboarding', () => {
    const plan = planBusinessVerification(kyc, docs);

    expect(plan.missing).toEqual([]);
    expect(plan.account).toEqual({
      business_name: 'Petal Post, LLC',
      business_address: { line1: '30 N Gould St', line2: 'Ste R', city: 'Sheridan', state: 'WY', postal_code: '82801', country: 'US' },
      tax_identifiers: [{ tax_id_type: 'us_ein', tax_id_value: '12-3456789' }],
    });
    expect(plan.verification).toEqual({
      kind: 'business',
      business_name: 'Petal Post, LLC',
      business_structure: 'single_member_llc',
      // EIN no campo que a Whop lê; o CPF vai só na verificação da pessoa.
      tax_identification_number: '12-3456789',
      business_website: 'https://petalpost.com',
      country: 'US',
      place_of_incorporation: 'WY',
      address: { line1: '30 N Gould St', line2: 'Ste R', city: 'Sheridan', state: 'WY', postal_code: '82801', country: 'US' },
      first_name: 'Maria',
      last_name: 'da Silva Souza',
      date_of_birth: '1990-05-17',
    });
  });

  it('seller com CNPJ não passa: conta conectada é só LLC', () => {
    const plan = planBusinessVerification(kyc, { ...docs, company_type: 'BR' });
    expect(plan.missing).toContain('cadastro como empresa americana (LLC)');
    expect(plan.verification).toBeNull();
  });

  it('lista todos os faltantes de uma vez', () => {
    const plan = planBusinessVerification(
      { full_name: 'Maria', cpf: '123' },
      { company_type: 'US', company_ein: '123', identity_document_type: 'DRIVERS', identity_front_path: 'u1/front.webp' },
    );

    expect(plan.account).toBeNull();
    expect(plan.missing).toEqual([
      'razão social da LLC',
      'EIN (XX-XXXXXXX)',
      'tipo da LLC (um ou mais sócios)',
      'estado de abertura da LLC',
      'endereço da LLC nos EUA (rua, cidade, estado e ZIP)',
      'nome completo do representante (nome e sobrenome)',
      'data de nascimento do representante',
      'telefone do representante com DDI (ex.: +5511999999999)',
      'CPF do representante',
      'endereço residencial do representante',
      'carta do EIN',
      'Articles of Organization',
      'frente do documento em JPEG, PNG ou PDF',
      'verso do documento',
      'selfie',
    ]);
  });

  it('passaporte não pede verso; selfie em PDF é recusada', () => {
    const passport = planBusinessVerification(kyc, {
      ...docs, identity_document_type: 'PASSPORT', identity_back_path: null, identity_front_path: 'u1/passport.pdf',
    });
    expect(passport.missing).toEqual([]);

    const pdfSelfie = planBusinessVerification(kyc, { ...docs, selfie_path: 'u1/selfie.pdf' });
    expect(pdfSelfie.missing).toEqual(['selfie em JPEG ou PNG']);
  });
});

describe('planRfiAnswers', () => {
  const source = { kyc, docs, email: 'maria@petalpost.com', description: 'x'.repeat(120), website: null };

  it('responde com o que o onboarding tem: texto, endereço, arquivos e documento', () => {
    const { answers, unanswered } = planRfiAnswers([
      { id: 'inrqi_1', requirement: 'ein', type: 'text' },
      { id: 'inrqi_2', requirement: 'business_address', type: 'address' },
      { id: 'inrqi_3', requirement: 'business_verification_document', type: 'files' },
      { id: 'inrqi_4', requirement: 'identity_document', type: 'id_document' },
      { id: 'inrqi_5', requirement: 'selfie', type: 'files' },
      { id: 'inrqi_6', requirement: 'business_structure', type: 'select', options: [{ value: 'single_member_llc' }, { value: 'multi_member_llc' }] },
      { id: 'inrqi_7', requirement: 'business_representative_title', type: 'select', options: ['CEO', 'Owner', 'Manager'] },
      { id: 'inrqi_8', requirement: 'business_description', type: 'text' },
      { id: 'inrqi_9', requirement: 'personal_address', type: 'address' },
    ], source);

    expect(unanswered).toEqual([]);
    expect(answers).toEqual([
      { id: 'inrqi_1', value: '12-3456789' },
      { id: 'inrqi_2', address: { line1: '30 N Gould St', line2: 'Ste R', city: 'Sheridan', state: 'WY', postal_code: '82801', country: 'US' } },
      { id: 'inrqi_3', filePaths: ['u1/ein_document.pdf'] },
      { id: 'inrqi_4', documentSlots: [{ slot: 'id_card_front', path: 'u1/identity_front.jpg' }, { slot: 'id_card_back', path: 'u1/identity_back.png' }] },
      { id: 'inrqi_5', filePaths: ['u1/selfie.jpg'] },
      { id: 'inrqi_6', value: 'single_member_llc' },
      { id: 'inrqi_7', value: 'Owner' },
      { id: 'inrqi_8', value: 'x'.repeat(120) },
      { id: 'inrqi_9', address: { line1: 'Av. Paulista, 1000', line2: 'Sala 5 - Bela Vista', city: 'São Paulo', state: 'SP', postal_code: '01310-100', country: 'BR' } },
    ]);
  });

  it('o que não foi coletado, ou foi recusado antes, vai para o CRM', () => {
    const { answers, unanswered } = planRfiAnswers([
      { id: 'inrqi_a', requirement: 'expected_monthly_volume', type: 'text', label: 'Volume mensal' },
      { id: 'inrqi_b', requirement: 'selfie', type: 'files', errors: [{ code: 'selfie_face_mismatch', reason: 'Rosto não confere' }] },
      { id: 'inrqi_c', requirement: 'business_description', type: 'text' },
    ], { ...source, description: 'curta' });

    expect(answers).toEqual([]);
    expect(unanswered.map(u => u.requirement)).toEqual(['expected_monthly_volume', 'selfie', 'business_description']);
    expect(unanswered[1].reason).toContain('Rosto não confere');
  });
});

describe('pendências do seller', () => {
  const source = { kyc, docs, email: 'maria@petalpost.com', description: 'x'.repeat(120), website: null };
  const rfi = (over: Partial<Record<string, any>>) => ({
    id: 'inrqi_x', requirement: 'x', label: null, reason: RFI_NOT_COLLECTED, type: 'text', options: [], optional: false, ...over,
  });

  it('junta frente/verso/tipo do documento num campo e ignora company_type', () => {
    const items = sellerRequirementItems([
      { key: 'company_type', label: 'Tipo' },
      { key: 'identity_front', label: 'Frente' },
      { key: 'identity_back', label: 'Verso' },
      { key: 'company_ein', label: 'EIN' },
    ], []);
    expect(items.map(i => i.key)).toEqual(['identity', 'company_ein']);
    expect(items[0]).toMatchObject({ input: 'identity', source: 'cadastro', rfiId: null });
  });

  it('pedido da Whop com campo no cadastro vira esse campo, com o motivo da recusa', () => {
    const items = sellerRequirementItems([], [
      rfi({ id: 'inrqi_1', requirement: 'business_address', reason: 'endereço de agente registrado não aceito' }),
      rfi({ id: 'inrqi_2', requirement: 'ein' }),
    ]);
    expect(items).toEqual([
      expect.objectContaining({ key: 'company_address', input: 'address', source: 'whop', reason: 'endereço de agente registrado não aceito' }),
      expect.objectContaining({ key: 'company_ein', source: 'whop', reason: null }),
    ]);
  });

  it('pedido sem campo no cadastro é respondido direto pelo seller', () => {
    const [item] = sellerRequirementItems([], [
      rfi({ id: 'inrqi_9', requirement: 'source_of_funds', label: 'Origem dos recursos', type: 'select', options: ['Vendas', 'Investimento'], optional: true }),
    ]);
    expect(item).toEqual({
      key: 'rfi:inrqi_9', label: 'Origem dos recursos', input: 'select', source: 'whop',
      reason: null, rfiId: 'inrqi_9', options: ['Vendas', 'Investimento'], optional: true,
    });
  });

  it('campo corrigido reabre os pedidos da Whop ligados a ele', () => {
    expect(rfiRequirementsForKeys(['identity_front', 'phone']).sort()).toEqual(['identity_document', 'phone_number']);
    expect(rfiRequirementsForKeys(['kyc'])).toEqual(expect.arrayContaining(['first_name', 'date_of_birth', 'personal_address']));
    expect(rfiRequirementsForKeys(['company_formation_state'])).toEqual([]);
  });

  it('pedido recusado antes só é reenviado quando o campo foi corrigido', () => {
    const errored = { id: 'inrqi_1', requirement: 'ein', type: 'text', errors: [{ reason: 'EIN não confere' }] };
    expect(planRfiAnswers([errored], source).answers).toEqual([]);
    expect(planRfiAnswers([errored], source, { retryRequirements: ['ein'] }).answers).toEqual([
      expect.objectContaining({ id: 'inrqi_1' }),
    ]);
  });
});

describe('connectedApplicationFee', () => {
  it('pede tudo menos 1 centavo para o saldo ficar na master', () => {
    expect(connectedApplicationFee(343.48)).toEqual({ fee: 343.47 });
    expect(connectedApplicationFee(1)).toEqual({ fee: 0.99 });
  });

  it('valor que não comporta a fee falha fechado', () => {
    expect(connectedApplicationFee(0.01)).toHaveProperty('error');
    expect(connectedApplicationFee(NaN)).toHaveProperty('error');
  });
});

describe('risco por seller', () => {
  it('amostra pequena: reserva só com 3 disputas', () => {
    const base = { paidCount: 20, alertCount: 0, refundCount: 0 };
    expect(classifyConnectedRisk({ ...base, disputeCount: 3 }).tier).toBe('RESERVE');
    expect(classifyConnectedRisk({ ...base, disputeCount: 1 }).tier).toBe('WATCH');
    expect(classifyConnectedRisk({ ...base, disputeCount: 0, alertCount: 1 }).tier).toBe('WATCH');
    expect(classifyConnectedRisk({ ...base, disputeCount: 0 }).tier).toBe('OK');
  });

  it('com amostra: alerta em 0,50% e reserva em 1%', () => {
    const base = { paidCount: 1000, alertCount: 0, refundCount: 0 };
    expect(classifyConnectedRisk({ ...base, disputeCount: 10 }).tier).toBe('RESERVE');
    expect(classifyConnectedRisk({ ...base, disputeCount: 9 }).tier).toBe('WATCH');
    expect(classifyConnectedRisk({ ...base, disputeCount: 5 }).tier).toBe('WATCH');
    expect(classifyConnectedRisk({ ...base, disputeCount: 0, alertCount: 5 }).tier).toBe('WATCH');
    expect(classifyConnectedRisk({ ...base, disputeCount: 4 }).tier).toBe('OK');
  });

  it('só escala sozinho; descer é manual', () => {
    expect(escalateRiskTier('RESERVE', 'OK')).toBe('RESERVE');
    expect(escalateRiskTier('WATCH', 'RESERVE')).toBe('RESERVE');
    expect(escalateRiskTier(undefined, 'WATCH')).toBe('WATCH');
  });
});

describe('decideConnectedMode', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const row = {
    charges_enabled: true,
    whop_account_id: 'biz_seller',
    status: 'active' as const,
    risk_tier: 'OK' as const,
    fallback_started_at: null as string | null,
    fallback_disabled: false,
  };

  it('fora do modo conectado, o seller é da master', () => {
    expect(decideConnectedMode(null, now)).toEqual({ mode: 'master' });
    expect(decideConnectedMode({ ...row, charges_enabled: false }, now)).toEqual({ mode: 'master' });
  });

  it('conta ativa cobra na conta conectada', () => {
    expect(decideConnectedMode(row, now)).toEqual({ mode: 'connected' });
  });

  it('conta fora do ar cai na master e marca o início da janela', () => {
    expect(decideConnectedMode({ ...row, status: 'suspended' }, now)).toEqual({
      mode: 'fallback',
      reason: 'conta conectada suspended',
      startsNow: true,
    });
    const started = new Date(now - 60 * 60 * 1000).toISOString();
    expect(decideConnectedMode({ ...row, status: 'restricted', fallback_started_at: started }, now))
      .toMatchObject({ mode: 'fallback', startsNow: false });
  });

  it('sem fallback: reserva acionada, corte do CRM ou janela de 72h vencida', () => {
    const down = { ...row, status: 'suspended' as const };
    expect(decideConnectedMode({ ...down, risk_tier: 'RESERVE' }, now).mode).toBe('blocked');
    expect(decideConnectedMode({ ...down, fallback_disabled: true }, now).mode).toBe('blocked');
    const expired = new Date(now - CONNECTED_FALLBACK_MAX_MS - 1).toISOString();
    expect(decideConnectedMode({ ...down, fallback_started_at: expired }, now).mode).toBe('blocked');
  });
});

describe('planIndividualVerification', () => {
  it('monta a verificação da pessoa com os dados do cadastro', () => {
    const plan = planIndividualVerification(kyc);
    expect(plan.missing).toEqual([]);
    expect(plan.verification).toMatchObject({
      kind: 'individual',
      country: 'BR',
      first_name: 'Maria',
      date_of_birth: '1990-05-17',
      tax_identification_number: '52998224725',
      address: { country: 'BR', state: 'SP' },
    });
    expect(plan.verification?.phone).toMatch(/^\+/);
  });

  it('sem telefone ou CPF não cria a verificação e diz o que falta', () => {
    const plan = planIndividualVerification({ ...kyc, phone: null, cpf: null });
    expect(plan.verification).toBeNull();
    expect(plan.gaps.map(g => g.key).sort()).toEqual(['kyc', 'phone']);
  });
});

describe('mergeRequestedInformation', () => {
  it('junta os pedidos das duas verificações marcando a origem', () => {
    expect(mergeRequestedInformation([
      { id: 'idpf_business', requested_information: [{ id: 'inrqi_1', requirement: 'ein' }] },
      { id: 'idpf_individual', requested_information: [{ id: 'inrqi_2', requirement: 'identity_document' }] },
      null,
      { id: null, requested_information: [{ id: 'inrqi_3' }] },
    ])).toEqual([
      { id: 'inrqi_1', requirement: 'ein', verification_id: 'idpf_business' },
      { id: 'inrqi_2', requirement: 'identity_document', verification_id: 'idpf_individual' },
    ]);
  });
});

describe('deriveConnectedStatus', () => {
  it('mapeia conta e verificação da Whop', () => {
    expect(deriveConnectedStatus({ accountStatus: 'suspended', verificationStatus: 'approved' })).toBe('suspended');
    expect(deriveConnectedStatus({ verificationStatus: 'approved' })).toBe('active');
    expect(deriveConnectedStatus({ verificationStatus: 'approved', capabilities: { accept_card_payments: 'inactive' } })).toBe('restricted');
    expect(deriveConnectedStatus({ verificationStatus: 'action_required' })).toBe('action_required');
    expect(deriveConnectedStatus({ verificationStatus: 'manual_review' })).toBe('pending_verification');
    expect(deriveConnectedStatus({ verificationStatus: 'rejected' })).toBe('rejected');
    expect(deriveConnectedStatus({})).toBe('provisioning');
  });
});

describe('status com as duas verificações', () => {
  it('vale a pior situação entre empresa e pessoa', () => {
    const capabilities = { accept_card_payments: 'active' };
    expect(deriveConnectedStatus({ verificationStatus: 'approved', individualStatus: 'approved', capabilities })).toBe('active');
    expect(deriveConnectedStatus({ verificationStatus: 'approved', individualStatus: null })).toBe('provisioning');
    expect(deriveConnectedStatus({ verificationStatus: 'approved', individualStatus: 'pending' })).toBe('pending_verification');
    expect(deriveConnectedStatus({ verificationStatus: 'pending', individualStatus: 'action_required' })).toBe('action_required');
    expect(deriveConnectedStatus({ verificationStatus: 'rejected', individualStatus: 'approved' })).toBe('rejected');
    expect(deriveConnectedStatus({ accountStatus: 'suspended', verificationStatus: 'approved', individualStatus: 'approved' })).toBe('suspended');
  });

  it('sem a verificação da pessoa (conta antiga) segue só pela empresa', () => {
    expect(deriveConnectedStatus({ verificationStatus: 'approved', capabilities: { accept_card_payments: 'active' } })).toBe('active');
  });
});

describe('transferências', () => {
  it('classifica o status da transferência', () => {
    expect(classifyWhopTransfer({ status: 'succeeded' })).toBe('succeeded');
    expect(classifyWhopTransfer({ status: 'failed' })).toBe('failed');
    expect(classifyWhopTransfer({ status: 'processing' })).toBe('processing');
    expect(classifyWhopTransfer({})).toBe('processing');
  });

  it('só recusa definitiva é final; o resto fica em aberto para retomar', () => {
    expect(isDefinitiveWhopFailure(400)).toBe(true);
    expect(isDefinitiveWhopFailure(403)).toBe(true);
    expect(isDefinitiveWhopFailure(0)).toBe(true);
    expect(isDefinitiveWhopFailure(409)).toBe(false);
    expect(isDefinitiveWhopFailure(429)).toBe(false);
    expect(isDefinitiveWhopFailure(502)).toBe(false);
  });

  it('acha só os saldos negativos em moeda fiduciária', () => {
    expect(negativeFiatBalances([
      { symbol: 'USD', balance: '-15.00' },
      { symbol: 'BRL', balance: '-49.9' },
      { symbol: 'EUR', balance: '10.00' },
      { symbol: 'USDT', balance: '-3' },
      { symbol: 'GBP', balance: 'abc' },
    ])).toEqual([
      { currency: 'usd', amount: 15 },
      { currency: 'brl', amount: 49.9 },
    ]);
    expect(negativeFiatBalances(undefined)).toEqual([]);
  });
});

describe('checkConnectedEventOwnership', () => {
  const args = {
    connectedSellerId: 'seller-1',
    providerAccountId: 'whopc_biz_seller',
    metadata: { koopfy_seller_id: 'seller-1', koopfy_account_id: 'whopc_biz_seller' },
    transaction: { seller_id: 'seller-1', provider_account_id: 'whopc_biz_seller' },
  };

  it('aceita evento do próprio seller na própria conta', () => {
    expect(checkConnectedEventOwnership(args)).toEqual({ ok: true });
  });

  it('recusa metadata ou transação de outro seller ou de outra conta', () => {
    expect(checkConnectedEventOwnership({ ...args, metadata: { koopfy_seller_id: 'seller-2' } }).ok).toBe(false);
    expect(checkConnectedEventOwnership({ ...args, metadata: { koopfy_account_id: 'whop_main' } }).ok).toBe(false);
    expect(checkConnectedEventOwnership({ ...args, transaction: { seller_id: 'seller-2' } }).ok).toBe(false);
    expect(checkConnectedEventOwnership({
      ...args,
      transaction: { seller_id: 'seller-1', provider_account_id: 'whop_main' },
    }).ok).toBe(false);
  });
});

describe('verifyWhopWebhookSignature', () => {
  const secret = 'ws_abc123';
  const body = '{"type":"payment.succeeded"}';
  const now = 1_780_000_000;

  function headers(content = body, ts = now) {
    const signature = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`msg_1.${ts}.${content}`)
      .digest('base64');
    return { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${signature}` };
  }

  it('aceita a assinatura com o segredo cru', () => {
    expect(verifyWhopWebhookSignature(body, headers(), secret, 300, now)).toEqual({ valid: true });
  });

  it('recusa corpo alterado, timestamp velho e headers ausentes', () => {
    expect(verifyWhopWebhookSignature('{"type":"x"}', headers(), secret, 300, now).valid).toBe(false);
    expect(verifyWhopWebhookSignature(body, headers(body, now - 600), secret, 300, now).valid).toBe(false);
    expect(verifyWhopWebhookSignature(body, {}, secret, 300, now).valid).toBe(false);
  });
});

describe('recusa do e-mail do dono', () => {
  it('reconhece a recusa do e-mail pela Whop', () => {
    expect(isOwnerEmailRejection('You entered an invalid email address. Please enter a real email address.')).toBe(true);
    expect(isOwnerEmailRejection('business_name is required')).toBe(false);
  });
});

describe('configuração da conta conectada', () => {
  it('imposto da LLC, incluso no preço, sem e-mail ao comprador e sem estado coletando', () => {
    expect(connectedAccountSettings({})).toEqual({
      send_customer_emails: false,
      tax_remitted_by: 'self',
      tax_type: 'inclusive',
      tax_collection_enabled_states: [],
    });
  });

  it('desliga a coleta que a Whop liga sozinha ao virar self', () => {
    const conta = { send_customer_emails: false, tax_remitted_by: 'self', tax_type: 'inclusive', tax_collection_enabled_states: ['CA', 'NY'] };
    expect(accountSettingsPatch(conta, connectedAccountSettings({}))).toEqual({ tax_collection_enabled_states: [] });
    expect(accountSettingsPatch({ ...conta, tax_collection_enabled_states: [] }, connectedAccountSettings({}))).toBeNull();
  });

  it('classificação fiscal só entra com um id ptc_ válido', () => {
    expect(connectedAccountSettings({ WHOP_CONNECTED_PRODUCT_TAX_CODE_ID: 'ptc_saas' }).product_tax_code_id).toBe('ptc_saas');
    expect(connectedAccountSettings({ WHOP_CONNECTED_PRODUCT_TAX_CODE_ID: 'Digital - SaaS' }).product_tax_code_id).toBeUndefined();
  });

  it('sync só manda o que está diferente', () => {
    const desired = connectedAccountSettings({ WHOP_CONNECTED_PRODUCT_TAX_CODE_ID: 'ptc_saas' });
    const certa = { send_customer_emails: false, tax_remitted_by: 'self', tax_type: 'inclusive', tax_collection_enabled_states: [], product_tax_code: { id: 'ptc_saas' } };
    expect(accountSettingsPatch(certa, desired)).toBeNull();

    expect(accountSettingsPatch({ ...certa, tax_type: 'exclusive', send_customer_emails: true }, desired))
      .toEqual({ tax_type: 'inclusive', send_customer_emails: false });
  });

  it('conta nunca configurada recebe tudo (lista vazia não gera patch)', () => {
    expect(accountSettingsPatch({}, connectedAccountSettings({}))).toEqual({
      send_customer_emails: false,
      tax_remitted_by: 'self',
      tax_type: 'inclusive',
    });
  });
});

describe('documentos da pessoa direto na verificação', () => {
  const docs = {
    identity_document_type: 'ID_CARD',
    identity_front_path: 'u1/rg-frente.jpg',
    identity_back_path: 'u1/rg-verso.pdf',
    selfie_path: 'u1/selfie.png',
  };

  it('RG: frente, verso e selfie nas chaves que a Whop analisa sem sessão', () => {
    expect(identityDocumentsPlan(docs)).toEqual({
      documentType: 'ID_CARD',
      files: [
        { slot: 'id_card_front', path: 'u1/rg-frente.jpg' },
        { slot: 'id_card_back', path: 'u1/rg-verso.pdf' },
        { slot: 'selfie', path: 'u1/selfie.png' },
      ],
      problems: [],
    });
  });

  it('passaporte só tem frente', () => {
    const plan = identityDocumentsPlan({ identity_document_type: 'PASSPORT', identity_front_path: 'u1/p.jpg', selfie_path: 'u1/s.jpg' });
    expect(plan.files.map(f => f.slot)).toEqual(['passport_front', 'selfie']);
  });

  it('selfie em PDF não serve: a Whop exige foto', () => {
    const plan = identityDocumentsPlan({ ...docs, selfie_path: 'u1/selfie.pdf' });
    expect(plan.files).toEqual([]);
    expect(plan.problems.map(p => p.label)).toContain('selfie em JPEG ou PNG');
  });

  it('faltando algo, não manda nada pela metade', () => {
    const plan = identityDocumentsPlan({ ...docs, identity_back_path: null });
    expect(plan.files).toEqual([]);
    expect(plan.problems.map(p => p.label)).toContain('verso do documento');
  });

  it('sem tipo de documento, diz o que falta', () => {
    const plan = identityDocumentsPlan({ selfie_path: 'u1/s.jpg' });
    expect(plan.documentType).toBeNull();
    expect(plan.problems[0].key).toBe('identity_document_type');
  });
});

describe('descritor da fatura', () => {
  it('padrão é WHOP*KOOPFY, o mesmo nome da área do cliente', () => {
    expect(connectedStatementDescriptor(undefined)).toBe('WHOP*KOOPFY');
  });

  it('segue as regras da Whop: 5 a 22, com letra, sem aspas nem < > \\', () => {
    expect(isValidStatementDescriptor('WHOP*KOOPFY')).toBe(true);
    expect(isValidStatementDescriptor('KOOP')).toBe(false);
    expect(isValidStatementDescriptor('WHOP*UM NOME LONGO DEMAIS')).toBe(false);
    expect(isValidStatementDescriptor('12345')).toBe(false);
    expect(isValidStatementDescriptor('WHOP*"X"')).toBe(false);
  });

  it('valor inválido no env cai no padrão, em vez de derrubar o produto', () => {
    expect(connectedStatementDescriptor('x')).toBe('WHOP*KOOPFY');
    expect(connectedStatementDescriptor('whop*loja')).toBe('WHOP*LOJA');
  });
});
