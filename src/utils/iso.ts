/**
 * Mapa de língua → locale ISO (BCP 47) padrão.
 * Cobertura completa para países europeus + principais línguas globais.
 */
const DEFAULT_LOCALE_BY_LANGUAGE: Record<string, string> = {
  // ===== União Europeia (línguas oficiais) =====
  bg: 'bg-BG', // Búlgaro - Bulgária
  hr: 'hr-HR', // Croata - Croácia
  cs: 'cs-CZ', // Tcheco - República Tcheca
  da: 'da-DK', // Dinamarquês - Dinamarca
  nl: 'nl-NL', // Holandês - Países Baixos
  en: 'en-GB', // Inglês - Reino Unido (na UE histórica/Irlanda usa en-IE)
  et: 'et-EE', // Estoniano - Estônia
  fi: 'fi-FI', // Finlandês - Finlândia
  fr: 'fr-FR', // Francês - França
  de: 'de-DE', // Alemão - Alemanha
  el: 'el-GR', // Grego - Grécia
  hu: 'hu-HU', // Húngaro - Hungria
  ga: 'ga-IE', // Irlandês - Irlanda
  it: 'it-IT', // Italiano - Itália
  lv: 'lv-LV', // Letão - Letônia
  lt: 'lt-LT', // Lituano - Lituânia
  mt: 'mt-MT', // Maltês - Malta
  pl: 'pl-PL', // Polonês - Polônia
  pt: 'pt-PT', // Português - Portugal (use 'pt-BR' se o público for brasileiro)
  ro: 'ro-RO', // Romeno - Romênia
  sk: 'sk-SK', // Eslovaco - Eslováquia
  sl: 'sl-SI', // Esloveno - Eslovênia
  es: 'es-ES', // Espanhol - Espanha
  sv: 'sv-SE', // Sueco - Suécia

  // ===== Línguas co-oficiais / regionais europeias =====
  ca: 'ca-ES', // Catalão - Espanha
  eu: 'eu-ES', // Basco - Espanha
  gl: 'gl-ES', // Galego - Espanha
  cy: 'cy-GB', // Galês - Reino Unido
  gd: 'gd-GB', // Gaélico escocês - Reino Unido

  // ===== Europa fora da UE / EEA =====
  no: 'nb-NO', // Norueguês - Noruega (nb = bokmål, mais comum)
  nb: 'nb-NO', // Norueguês bokmål
  nn: 'nn-NO', // Norueguês nynorsk
  is: 'is-IS', // Islandês - Islândia
  fo: 'fo-FO', // Faroês - Ilhas Faroe
  de_ch: 'de-CH', // Alemão - Suíça (caso específico)
  fr_ch: 'fr-CH', // Francês - Suíça
  it_ch: 'it-CH', // Italiano - Suíça
  rm: 'rm-CH', // Romanche - Suíça
  sq: 'sq-AL', // Albanês - Albânia
  bs: 'bs-BA', // Bósnio - Bósnia e Herzegovina
  sr: 'sr-RS', // Sérvio - Sérvia
  mk: 'mk-MK', // Macedônio - Macedônia do Norte
  me: 'sr-ME', // Montenegrino (usa código sr com região ME)
  uk: 'uk-UA', // Ucraniano - Ucrânia
  be: 'be-BY', // Bielorrusso - Bielorrússia
  ru: 'ru-RU', // Russo - Rússia
  tr: 'tr-TR', // Turco - Turquia
  hy: 'hy-AM', // Armênio - Armênia
  ka: 'ka-GE', // Georgiano - Geórgia
  az: 'az-AZ', // Azerbaijano - Azerbaijão
  mo: 'ro-MD', // Moldavo (mesmo que romeno, região MD)

  // ===== Línguas globais não-europeias (frequentes em apps internacionais) =====
  ja: 'ja-JP', // Japonês
  ko: 'ko-KR', // Coreano
  zh: 'zh-CN', // Chinês simplificado
  ar: 'ar-SA', // Árabe
  he: 'he-IL', // Hebraico
  hi: 'hi-IN', // Hindi
  th: 'th-TH', // Tailandês
  vi: 'vi-VN', // Vietnamita
  id: 'id-ID', // Indonésio
  ms: 'ms-MY', // Malaio
  fa: 'fa-IR', // Persa
};

const FALLBACK_LOCALE = 'en-GB';

/**
 * Converte um código de língua para o formato ISO BCP 47 (ex: "es-ES").
 *
 * Aceita:
 *  - código de língua simples: "en"   → "en-GB"
 *  - já no formato completo:  "pt-BR" → "pt-BR" (normalizado)
 *  - separador com underscore:"pt_br" → "pt-BR"
 *  - case insensitive:        "PT-br" → "pt-BR"
 *  - undefined/null/vazio:    → fallback
 *
 * @param input código vindo de `ctx.customer.language` (ou similar)
 * @param fallback locale a usar quando input é inválido/desconhecido
 */
export function toIsoLocale(
  input?: string | null,
  fallback: string = FALLBACK_LOCALE,
): string {
  if (!input || typeof input !== 'string') return fallback;

  const normalized = input.trim().replace('_', '-');
  if (!normalized) return fallback;

  const [langRaw, regionRaw] = normalized.split('-');
  const lang = langRaw.toLowerCase();

  // já veio com região: normaliza pra "xx-XX"
  if (regionRaw) {
    const candidate = `${lang}-${regionRaw.toUpperCase()}`;
    return validateLocale(candidate, fallback);
  }

  // só veio a língua: pega o default do mapa
  const mapped = DEFAULT_LOCALE_BY_LANGUAGE[lang];
  return mapped ? validateLocale(mapped, fallback) : fallback;
}

/**
 * Valida o locale usando Intl.Locale (Node 14+).
 * Se for inválido, retorna o fallback.
 */
function validateLocale(candidate: string, fallback: string): string {
  try {
    return new Intl.Locale(candidate).toString();
  } catch {
    return fallback;
  }
}