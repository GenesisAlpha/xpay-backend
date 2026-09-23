import {
  invalidateApiKeyCache,
  readApiKeyCache,
  writeApiKeyCache,
} from './api-key-cache';

describe('cache da chave de API', () => {
  const key = { id: 'key-1', sellerId: 'seller-1', secretKeyHash: 'hash' };

  beforeEach(() => {
    invalidateApiKeyCache();
    jest.useRealTimers();
  });

  it('separa "não está no cache" de "prefixo inválido"', () => {
    expect(readApiKeyCache('sk_live_x')).toBeUndefined();
    writeApiKeyCache('sk_live_x', null);
    expect(readApiKeyCache('sk_live_x')).toBeNull();
  });

  it('devolve a chave guardada sem ir ao banco', () => {
    writeApiKeyCache('sk_live_a', key);
    expect(readApiKeyCache('sk_live_a')).toEqual(key);
  });

  it('esquece a chave quando o tempo passa', () => {
    jest.useFakeTimers();
    writeApiKeyCache('sk_live_a', key);
    jest.advanceTimersByTime(31_000);
    expect(readApiKeyCache('sk_live_a')).toBeUndefined();
  });

  it('esquece o prefixo inválido antes da chave válida', () => {
    jest.useFakeTimers();
    writeApiKeyCache('sk_live_a', key);
    writeApiKeyCache('sk_live_b', null);
    jest.advanceTimersByTime(6_000);
    expect(readApiKeyCache('sk_live_b')).toBeUndefined();
    expect(readApiKeyCache('sk_live_a')).toEqual(key);
  });

  it('revogação limpa tudo — a chave para de valer na hora', () => {
    writeApiKeyCache('sk_live_a', key);
    invalidateApiKeyCache();
    expect(readApiKeyCache('sk_live_a')).toBeUndefined();
  });
});
