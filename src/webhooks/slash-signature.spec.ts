import * as crypto from 'crypto'
import { slashWebhookPublicKeys, verifySlashSignature } from './slash-signature'

const pair = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const sign = (body: string, privateKey: string) =>
  crypto.sign('sha256', Buffer.from(body), privateKey).toString('base64')

describe('verifySlashSignature', () => {
  const body = '{"event":"payments.payment_intent.updated","eventId":"e1","entityId":"acq_payment_intent_1"}'
  const current = pair()
  const next = pair()
  const keys = [next.publicKey, current.publicKey]

  it('aceita assinatura de qualquer uma das chaves durante a troca', () => {
    expect(verifySlashSignature(body, sign(body, current.privateKey), keys)).toEqual({ valid: true })
    expect(verifySlashSignature(Buffer.from(body), sign(body, next.privateKey), keys)).toEqual({ valid: true })
  })

  it('recusa corpo re-serializado (bytes diferentes)', () => {
    const reserialized = JSON.stringify(JSON.parse(body), null, 1)
    expect(verifySlashSignature(reserialized, sign(body, current.privateKey), keys).valid).toBe(false)
  })

  it('recusa assinatura de outra chave e cabeçalho ausente', () => {
    expect(verifySlashSignature(body, sign(body, pair().privateKey), keys).valid).toBe(false)
    expect(verifySlashSignature(body, undefined, keys)).toEqual({ valid: false, reason: 'missing signature' })
  })

  it('uma chave malformada não impede as outras', () => {
    expect(verifySlashSignature(body, sign(body, current.privateKey), ['lixo', current.publicKey]).valid).toBe(true)
  })
})

describe('slashWebhookPublicKeys', () => {
  it('traz as duas chaves publicadas pela Slash por padrão', () => {
    const keys = slashWebhookPublicKeys('')
    expect(keys).toHaveLength(2)
    keys.forEach(k => expect(() => crypto.createPublicKey(k)).not.toThrow())
  })

  it('o env substitui a lista, com \\n literal', () => {
    const a = pair().publicKey
    const b = pair().publicKey
    const env = `${a}\n${b}`.replace(/\n/g, '\\n')
    expect(slashWebhookPublicKeys(env)).toEqual([a.trim(), b.trim()])
  })
})
