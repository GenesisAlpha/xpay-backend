// utils/mbway.validator.ts
// Validador de número de telefone para MB Way
// Aceita números portugueses (+351) e espanhóis (+34) — principais mercados MB Way

export interface MbwayValidationResult {
  valid:      boolean
  normalized: string | null  // número normalizado E.164 ex: +351912345678
  reason?:    string
}

// ─── Prefixos móveis válidos ──────────────────────────────────────────────────

// Portugal: 91x, 92x, 93x, 96x (fixos como 21x, 22x são inválidos para MB Way)
const PT_MOBILE_PREFIXES = ['91', '92', '93', '96']

// Espanha: 6xx, 7xx
const ES_MOBILE_PREFIXES = ['6', '7']

// ─── Padrões de números fake/teste ───────────────────────────────────────────

const FAKE_PATTERNS = [
  /^(\d)\1{8}$/,      // todos os dígitos iguais: 999999999, 111111111
  /^123456789$/,       // sequência crescente
  /^987654321$/,       // sequência decrescente
  /^000000000$/,
  /^111111111$/,
  /^(123){3}$/,        // padrão repetido
  /^(12){4}\d$/,
]

// ─── Validador principal ──────────────────────────────────────────────────────

export function validateMbwayPhone(raw: string | null | undefined): MbwayValidationResult {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, normalized: null, reason: 'Número de telefone não informado.' }
  }

  // Remove espaços, hífens, parênteses e pontos
  const cleaned = raw.trim().replace(/[\s\-().]/g, '')

  let countryCode = ''
  let localNumber = ''

  // Detecta código de país
  if (cleaned.startsWith('+351')) {
    countryCode = '351'; localNumber = cleaned.slice(4)
  } else if (cleaned.startsWith('00351')) {
    countryCode = '351'; localNumber = cleaned.slice(5)
  } else if (cleaned.startsWith('+34')) {
    countryCode = '34'; localNumber = cleaned.slice(3)
  } else if (cleaned.startsWith('0034')) {
    countryCode = '34'; localNumber = cleaned.slice(4)
  } else if (cleaned.startsWith('351') && cleaned.length === 12) {
    countryCode = '351'; localNumber = cleaned.slice(3)
  } else if (cleaned.startsWith('34') && cleaned.length === 11) {
    countryCode = '34'; localNumber = cleaned.slice(2)
  } else {
    // Sem código de país — infere pelo padrão
    localNumber = cleaned
    if (/^9[1236]\d{7}$/.test(cleaned)) {
      countryCode = '351'  // Portugal
    } else if (/^[67]\d{8}$/.test(cleaned)) {
      countryCode = '34'   // Espanha
    } else {
      return {
        valid:      false,
        normalized: null,
        reason:     'Número inválido. Informe um número móvel português (+351) ou espanhol (+34).',
      }
    }
  }

  // Apenas dígitos no número local
  if (!/^\d+$/.test(localNumber)) {
    return { valid: false, normalized: null, reason: 'Número contém caracteres inválidos.' }
  }

  // Comprimento: 9 dígitos para PT e ES
  if (localNumber.length !== 9) {
    return {
      valid:      false,
      normalized: null,
      reason:     `Número deve ter 9 dígitos. Recebido: ${localNumber.length}.`,
    }
  }

  // Prefixo móvel válido
  if (countryCode === '351') {
    const prefix = localNumber.slice(0, 2)
    if (!PT_MOBILE_PREFIXES.includes(prefix)) {
      return {
        valid:      false,
        normalized: null,
        reason:     `MB Way requer número móvel português (91x, 92x, 93x ou 96x). Recebido: ${prefix}x.`,
      }
    }
  }

  if (countryCode === '34') {
    const prefix = localNumber.slice(0, 1)
    if (!ES_MOBILE_PREFIXES.includes(prefix)) {
      return {
        valid:      false,
        normalized: null,
        reason:     `MB Way requer número móvel espanhol (6xx ou 7xx).`,
      }
    }
  }

  // Detecta padrões fake
  for (const pattern of FAKE_PATTERNS) {
    if (pattern.test(localNumber)) {
      return {
        valid:      false,
        normalized: null,
        reason:     'Número inválido ou de teste. Por favor, use um número real.',
      }
    }
  }

  return { valid: true, normalized: `+${countryCode}${localNumber}` }
}