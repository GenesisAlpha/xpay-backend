// Pedidos da Whop sobre o negócio passam pelo CRM antes de ir para a Whop.
const tables: Record<string, any[]> = {};

function builder(table: string) {
  const filters: Array<(row: any) => boolean> = [];
  let op: { kind: 'select' | 'update' | 'insert'; payload?: any } = { kind: 'select' };
  let returning = false;
  const rows = () => (tables[table] ??= []);
  const run = () => {
    if (op.kind === 'insert') {
      const list = Array.isArray(op.payload) ? op.payload : [op.payload];
      for (const item of list) rows().push({ id: `sub_${rows().length + 1}`, created_at: new Date(Date.now() + rows().length).toISOString(), ...item });
      return { data: list, error: null };
    }
    const hit = rows().filter(row => filters.every(f => f(row)));
    if (op.kind === 'update') {
      for (const row of hit) Object.assign(row, op.payload);
      return { data: returning ? hit : null, error: null };
    }
    return { data: [...hit].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), error: null };
  };
  const q: any = {
    select: () => { if (op.kind !== 'select') returning = true; return q; },
    insert: (payload: any) => { op = { kind: 'insert', payload }; return q; },
    update: (payload: any) => { op = { kind: 'update', payload }; return q; },
    eq: (col: string, val: any) => { filters.push(row => row[col] === val); return q; },
    neq: (col: string, val: any) => { filters.push(row => row[col] !== val); return q; },
    in: (col: string, vals: any[]) => { filters.push(row => vals.includes(row[col])); return q; },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => { const r = run(); return { data: (r.data ?? [])[0] ?? null, error: null }; },
    single: async () => { const r = run(); return { data: (r.data ?? [])[0] ?? null, error: null }; },
    then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
  };
  return q;
}

jest.mock('../../lib/supabase.client', () => ({ supabase: { from: (t: string) => builder(t) } }));
jest.mock('../../utils/seller-mail', () => ({ notifySellerVerification: jest.fn(async () => undefined) }));

import { WhopConnectService } from './whop-connect.service';
import { sellerRequirementItems, rfiNeedsReview } from './whop-connected';

const SELLER = 'seller-1';
const proof = (verification: string) => ({
  id: 'inrqi_proof', type: 'files', label: 'Proof of fulfillment', requirement: 'proof_of_fulfillment',
  verification_id: verification, errors: [{ code: 'submission_rejected', reason: 'not a real customer' }],
});

function setup() {
  for (const key of Object.keys(tables)) delete tables[key];
  tables.whop_connected_accounts = [{
    seller_id: SELLER, whop_account_id: 'biz_seller', verification_id: 'idpf_business', individual_verification_id: 'idpf_person',
    status: 'action_required', requested_information: [proof('idpf_business'), proof('idpf_person'),
      { id: 'inrqi_dob', type: 'date', label: 'Date of birth', requirement: 'date_of_birth', verification_id: 'idpf_person' }],
    rfi_answered: [], rfi_unanswered: [], required_actions: [{ action: 'submit_information_request', title: 'We need info', blocked_capabilities: ['standard_payout'] }],
  }];
  const whop: any = {
    updateVerification: jest.fn(async () => ({})),
    uploadFile: jest.fn(async () => 'file_whop_1'),
    credentials: () => ({ apiKey: 'k', apiUrl: 'u' }),
  };
  const storage: any = {
    uploadRfiFile: jest.fn(async () => ({ path: 'rfi/seller-1/x.mp4', name: 'prova.mp4', mime: 'video/mp4' })),
    downloadDocument: jest.fn(async () => ({ base64: Buffer.from('video').toString('base64'), mime: 'video/mp4', byteLength: 5 })),
    getSignedDocumentUrl: jest.fn(async () => 'https://signed/url'),
  };
  return { whop, storage, service: new WhopConnectService(whop, storage) };
}

describe('pedidos da Whop sobre o negócio', () => {
  it('classifica o que passa pelo CRM', () => {
    expect(rfiNeedsReview('proof_of_fulfillment')).toBe(true);
    expect(rfiNeedsReview('business_description')).toBe(true);
    expect(rfiNeedsReview('product_description')).toBe(true);
    expect(rfiNeedsReview('date_of_birth')).toBe(false);
    expect(rfiNeedsReview('identity_document')).toBe(false);
  });

  it('resposta do seller sobre o negócio fica no CRM e não vai à Whop; o resto vai direto', async () => {
    const { whop, service } = setup();
    const result = await service.submitDirectRfiAnswers(SELLER, [
      { id: 'inrqi_proof', value: 'Conversa com o comprador', file: { base64: 'dmlkZW8=', mime: 'video/mp4', name: 'prova.mp4' } },
      { id: 'inrqi_dob', value: '1990-01-01' },
    ]);
    expect(result).toMatchObject({ answered: 1, inReview: 1 });
    expect(whop.updateVerification).toHaveBeenCalledTimes(1);
    expect(whop.updateVerification).toHaveBeenCalledWith('idpf_person', { requested_information: [{ id: 'inrqi_dob', value: '1990-01-01' }] });
    const [sub] = tables.whop_rfi_submissions;
    expect(sub).toMatchObject({ request_id: 'inrqi_proof', status: 'pending_review', file_path: 'rfi/seller-1/x.mp4', value: 'Conversa com o comprador' });
    expect(sub.verification_ids).toEqual(['idpf_business', 'idpf_person']);
  });

  it('CRM vê o que a Whop pede e a resposta aguardando', async () => {
    const { service } = setup();
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'texto' }]);
    const review = await service.getRfiReview(SELLER);
    expect(review.requiredActions[0]).toMatchObject({ title: 'We need info', blockedCapabilities: ['standard_payout'] });
    const proofRequest = review.requests.find(r => r.id === 'inrqi_proof');
    expect(proofRequest).toMatchObject({ needsReview: true, rejections: ['not a real customer'], verificationIds: ['idpf_business', 'idpf_person'] });
    expect(review.submissions[0]).toMatchObject({ status: 'pending_review', value: 'texto' });
  });

  it('aprovar envia o arquivo à Whop nas duas verificações e marca como respondido', async () => {
    const { whop, service } = setup();
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'Conversa', file: { base64: 'dmlkZW8=', mime: 'video/mp4' } }]);
    const sub = tables.whop_rfi_submissions[0];
    await service.approveRfiSubmission(SELLER, sub.id, 'manager-1');
    expect(whop.uploadFile).toHaveBeenCalledTimes(1);
    expect(whop.updateVerification).toHaveBeenCalledWith('idpf_business', { requested_information: [{ id: 'inrqi_proof', files: ['file_whop_1'], value: 'Conversa' }] });
    expect(whop.updateVerification).toHaveBeenCalledWith('idpf_person', { requested_information: [{ id: 'inrqi_proof', files: ['file_whop_1'], value: 'Conversa' }] });
    expect(sub.status).toBe('sent');
    expect(tables.whop_connected_accounts[0].rfi_answered).toContain('inrqi_proof');
  });

  it('recusa da Whop no envio fica registrada e pode ser reenviada', async () => {
    const { whop, service } = setup();
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'texto' }]);
    const sub = tables.whop_rfi_submissions[0];
    whop.updateVerification.mockRejectedValueOnce(new Error('invalid file'));
    await expect(service.approveRfiSubmission(SELLER, sub.id, 'manager-1')).rejects.toThrow('A Whop recusou o envio');
    expect(sub).toMatchObject({ status: 'send_failed', whop_error: 'invalid file' });
    await service.approveRfiSubmission(SELLER, sub.id, 'manager-1');
    expect(sub.status).toBe('sent');
  });

  it('recusar exige motivo e o seller vê o motivo nas pendências', async () => {
    const { service } = setup();
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'texto' }]);
    const sub = tables.whop_rfi_submissions[0];
    await expect(service.rejectRfiSubmission(SELLER, sub.id, 'm', '')).rejects.toThrow('Explique');
    await service.rejectRfiSubmission(SELLER, sub.id, 'm', 'Mande a conversa com um comprador real');
    const items = sellerRequirementItems([], [{ id: 'inrqi_proof', requirement: 'proof_of_fulfillment', label: 'Proof', reason: 'x', type: 'files', options: [], optional: false }],
      new Map([['inrqi_proof', tables.whop_rfi_submissions[0]]]));
    expect(items[0].review).toEqual({ status: 'rejected', note: 'Mande a conversa com um comprador real' });
  });

  it('reenviar substitui a resposta que aguardava', async () => {
    const { service } = setup();
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'primeira' }]);
    await service.submitDirectRfiAnswers(SELLER, [{ id: 'inrqi_proof', value: 'segunda' }]);
    const open = tables.whop_rfi_submissions.filter(s => s.status === 'pending_review');
    expect(open).toHaveLength(1);
    expect(open[0].value).toBe('segunda');
  });
});
