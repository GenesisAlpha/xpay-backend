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
