import * as crypto from 'crypto'

// Assinatura dos webhooks da Slash: RSA-SHA256 sobre o corpo BRUTO, em base64
// no cabeçalho `slash-webhook-signature`.
// https://docs.slash.com/api-reference/public-rsa-key
//
// A Slash está trocando a chave: a atual assina até 4/10/2026 e a nova a partir
// de 5/10/2026. Durante a troca vale qualquer uma das duas. Depois de confirmar
// entregas assinadas com a nova, a atual pode sair daqui.
//
// SLASH_WEBHOOK_PUBLIC_KEYS (PEMs separados por linha em branco, `\n` literal
// aceito) substitui a lista inteira — para a próxima rotação sem deploy.

const SLASH_NEW_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArgs+6OXuaHZGmJNZ6d55
OROt6iO+oZDN7OrjJ4aTsYnYYYC8i4bUy4P5uuqPw3cafm/HfW4ebY4HNRqgoWbX
74Y4kv+V7+9Kd5xQqp4q8qynzCXmVOZXCCvpOIZD4U269C46jp4atyBNO2mSWSCL
BlLKCZR3JnGMUXvhc1VmXHaGUie/+rYM1O+AZZySv2i33OMwgXgiw9ZZ2SM4xqNE
WFKlLAXa8dlL/ex5wkoa7/CD6AI5zbbwqIktRGh/5zkd6SKc+XLrjtxD1hwINI4O
9KKim9yDbTMxUdY5aXVfw62XRKihD8fxEXVOLMmy3Iu8QKnkIEmd5peWlFupeDy0
sQIDAQAB
-----END PUBLIC KEY-----`

const SLASH_CURRENT_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq4+a15r2X7AU0erQGfNv
aNm4Rxd4XEFBIk+kARNydOaM0YoT56h07BD98KEQth7J3FWnSZL/gbv0rKrn5HhM
BMVloueB3irr+9mg6ORQ5ug0NVYnaQpGIaEjlrBdjrdk5gPepT6ztbaYSnfl8lzH
5JGc0Gq38HO2cfZlXQHT4mKy7im6Pa76z6NcXOaUh8O7lvskC1ckhhoGz8p4pd3v
wJi5YFwRAjFmJ8FRYhbPZXpTW796rH6EhIMkjHbVwf6yTKmiHeaXQ/14jcqhUJan
0mrF9cV3tgzb+l2XMDDKQlQGsfyGGdmE1APnQb6MK1IB/iVt8ntEQ8deKgkwH/wi
NQIDAQAB
-----END PUBLIC KEY-----`

export function slashWebhookPublicKeys(env: string | undefined = process.env.SLASH_WEBHOOK_PUBLIC_KEYS): string[] {
  const custom = (env ?? '').replace(/\\n/g, '\n').trim()
  if (!custom) return [SLASH_NEW_KEY, SLASH_CURRENT_KEY]
  return custom
    .split(/(?=-----BEGIN PUBLIC KEY-----)/)
    .map(k => k.trim())
    .filter(Boolean)
}

export function verifySlashSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  keys: string[] = slashWebhookPublicKeys(),
): { valid: boolean; reason?: string } {
  if (!signatureHeader) return { valid: false, reason: 'missing signature' }
  const signature = Buffer.from(String(signatureHeader).trim(), 'base64')
  if (!signature.length) return { valid: false, reason: 'empty signature' }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8')

  for (const key of keys) {
    try {
      if (crypto.verify('sha256', body, key, signature)) return { valid: true }
    } catch (err: any) {
      // Chave malformada no env não pode derrubar as outras.
      console.error('[slash-signature] chave pública inválida:', err?.message)
    }
  }
  return { valid: false, reason: 'signature mismatch' }
}
