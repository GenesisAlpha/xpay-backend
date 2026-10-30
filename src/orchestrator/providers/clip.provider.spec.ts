import { ClipProvider } from './clip.provider';

// Status que a Clip devolve em GET /payments/:id (vistos em produção em 28/10).
describe('ClipProvider.retrieve — status da Clip', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const retrieveWith = async (status: string) => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ id: 'clip_pay_1', status }),
    }) as never;
    return new ClipProvider().retrieve({
      providerTransactionId: 'clip_pay_1',
      providerConfig: { id: 'clip_mx_gray_03', apiKey: 'sk', config: { public_key: 'pk' } },
    });
  };

  it.each([
    ['completed', 'paid'],
    ['pending', 'pending'],
    ['rejected', 'failed'],
    // 3DS abandonado: a Clip cancela com CA-AUT01 e escreve com dois L.
    ['cancelled', 'failed'],
    ['canceled', 'failed'],
  ])('%s → %s', async (clip, esperado) => {
    await expect(retrieveWith(clip)).resolves.toEqual(expect.objectContaining({ success: true, status: esperado }));
  });
});

// O que o checkout manda (customer.name inteiro + billing_address) tem que
// chegar à Clip como nome/sobrenome, endereço com número e telefone real.
describe('ClipProvider.charge — dados do comprador', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const ctx = (over: Record<string, any> = {}) => ({
    transactionId: 'tx-1',
    amount: 23800,
    payment_data: { clipToken: 'tok' },
    customer: { name: 'Ana López Pérez', email: 'ana@example.com', phone: '+52 55 1234 5678' },
    billing_address: { address: 'Av. Juárez', number: '45-A', zipcode: '06600', city: 'Cuauhtémoc', state: 'Ciudad de México', country: 'MX' },
    providerConfig: { id: 'clip_mx_gray_03', apiKey: 'sk', config: { public_key: 'pk' } },
    ...over,
  });

  const sent: any[] = [];
  const mockClip = (...responses: Array<{ status: number; body: any }>) => {
    sent.length = 0;
    global.fetch = jest.fn().mockImplementation(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      const r = responses[Math.min(sent.length - 1, responses.length - 1)];
      return { status: r.status, text: async () => JSON.stringify(r.body) };
    }) as never;
  };

  it('nome separado, endereço com número do formulário e telefone de 10 dígitos', async () => {
    mockClip({ status: 200, body: { id: 'p1', status: 'completed' } });
    await new ClipProvider().charge(ctx() as never);
    expect(sent[0].customer).toEqual(expect.objectContaining({
      first_name: 'Ana', last_name: 'López Pérez', phone: '5512345678',
      address: expect.objectContaining({
        street: 'Av. Juárez', exterior_number: '45-A', postal_code: '06600',
        city: 'Cuauhtémoc', state: 'Ciudad de México', country: 'Mexico',
      }),
    }));
  });

  it('campos de topo como o plugin oficial da Clip', async () => {
    mockClip({ status: 200, body: { id: 'p1', status: 'completed' } });
    await new ClipProvider().charge(ctx({ metadata: { redirect_url: 'https://checkout.koopfy.com/payment-result?orderId=1' } }) as never);
    expect(sent[0]).toEqual(expect.objectContaining({
      type: 'openplatform', entry_mode: 'manual', country: 'MX', tip_amount: 0,
      webhook_url: 'https://api.koopfy.com/pay/webhook/clip',
    }));
    expect(sent[0].metadata.website).toBe('https://checkout.koopfy.com');
  });

  it('estado em código (folha da Shopify) vira o nome', async () => {
    mockClip({ status: 200, body: { id: 'p1', status: 'completed' } });
    await new ClipProvider().charge(ctx({
      billing_address: { address: 'Tercera 1409', number: '1409', zipcode: '31940', city: 'Madera', state: 'CHIH', country: 'MX' },
    }) as never);
    expect(sent[0].customer.address.state).toBe('Chihuahua');
  });

  it('prevention_data como na documentação: sessão do SDK nos dois campos e o user agent do checkout', async () => {
    mockClip({ status: 200, body: { id: 'p1', status: 'completed' } });
    await new ClipProvider().charge(ctx({
      payment_data: { clipToken: 'tok', clipSessionId: 'sdk-sess-1' },
      context: { orderId: 'o1', userAgent: 'Mozilla/5.0 (iPhone)' },
    }) as never);
    expect(sent[0].prevention_data).toEqual({
      session_id: 'sdk-sess-1', device_finger_print_token: 'sdk-sess-1', user_agent: 'Mozilla/5.0 (iPhone)',
    });
  });

  it('sem telefone não inventa número; sem número no formulário tira da rua', async () => {
    mockClip({ status: 200, body: { id: 'p1', status: 'completed' } });
    await new ClipProvider().charge(ctx({
      customer: { name: 'Ana', email: 'ana@example.com', phone: null },
      billing_address: { address: 'Insurgentes 1602 Piso 4', zipcode: '03940', city: 'CDMX', country: 'MX' },
    }) as never);
    expect(sent[0].customer.phone).toBeUndefined();
    expect(sent[0].customer.address.exterior_number).toBe('1602');
  });

  it('CL2200 por endereço ou telefone: reenvia sem o endereço e com o telefone de respaldo', async () => {
    mockClip(
      { status: 400, body: { error_code: 'CL2200', detail: 'customer.address.state is invalid; customer.phone is required' } },
      { status: 200, body: { id: 'p1', status: 'completed' } },
    );
    const r = await new ClipProvider().charge(ctx({ customer: { name: 'Ana', email: 'ana@example.com' } }) as never);
    expect(r.success).toBe(true);
    // Só o estado sai: CP, rua e número continuam (AVS).
    expect(sent[1].customer.address.state).toBeUndefined();
    expect(sent[1].customer.address).toEqual(expect.objectContaining({ postal_code: '06600', exterior_number: '45-A' }));
    expect(sent[1].metadata.billing_address.state).toBeUndefined();
    expect(sent[1].customer.phone).toBe('5555555555');
  });

  it('CL2200 sem campo citado do endereço: o endereço sai inteiro', async () => {
    mockClip(
      { status: 400, body: { error_code: 'CL2200', detail: 'invalid customer address' } },
      { status: 200, body: { id: 'p1', status: 'completed' } },
    );
    await new ClipProvider().charge(ctx() as never);
    expect(sent[1].customer.address).toBeUndefined();
    expect(sent[1].metadata.billing_address).toBeUndefined();
  });

  it('CL2200 num campo do plugin: ele sai e a venda segue', async () => {
    mockClip(
      { status: 400, body: { error_code: 'CL2200', detail: 'entry_mode is invalid' } },
      { status: 200, body: { id: 'p1', status: 'completed' } },
    );
    const r = await new ClipProvider().charge(ctx() as never);
    expect(r.success).toBe(true);
    expect(sent[1].entry_mode).toBeUndefined();
    expect(sent[1].type).toBe('openplatform');
    expect(sent[1].customer.address.postal_code).toBe('06600');
  });
});

describe('mxStateName', () => {
  const { mxStateName } = require('./clip.provider');
  it.each([['CHIH', 'Chihuahua'], ['CHH', 'Chihuahua'], ['MX-NLE', 'Nuevo León'], ['CDMX', 'Ciudad de México'], ['Jalisco', 'Jalisco'], ['', '']])(
    '%s → %s', (a, b) => expect(mxStateName(a)).toBe(b),
  );
});
