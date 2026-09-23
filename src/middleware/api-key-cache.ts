// Cache da chave de API em memória.
//
// O guard buscava a chave no banco a CADA requisição — ~300 ms em toda compra,
// renovação e webhook, sempre a mesma linha. Aqui ela fica por 30 segundos.
//
// O que isso custa: uma revogação imediata pode levar até 30 s para valer em
// uma instância que não recebeu a chamada (o ambiente roda mais de uma). Quem
// revoga limpa o cache do processo; o resto expira sozinho. Chave desconhecida
// também é lembrada, por menos tempo, para que uma enxurrada de requisições com
// credencial errada não vire uma enxurrada de consultas.

export interface CachedApiKey {
  id: string;
  sellerId: string;
  secretKeyHash: string;
}

const HIT_TTL_MS = 30_000;
const MISS_TTL_MS = 5_000;

const cache = new Map<string, { value: CachedApiKey | null; until: number }>();

/** `undefined` = não está no cache. `null` = prefixo sabidamente inválido. */
export function readApiKeyCache(prefix: string): CachedApiKey | null | undefined {
  const entry = cache.get(prefix);
  if (!entry) return undefined;
  if (Date.now() > entry.until) {
    cache.delete(prefix);
    return undefined;
  }
  return entry.value;
}

export function writeApiKeyCache(prefix: string, value: CachedApiKey | null) {
  cache.set(prefix, {
    value,
    until: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS),
  });
}

/** Sem prefixo, limpa tudo: quem revoga não sabe o prefixo, só o id da chave. */
export function invalidateApiKeyCache(prefix?: string) {
  if (prefix) cache.delete(prefix);
  else cache.clear();
}
