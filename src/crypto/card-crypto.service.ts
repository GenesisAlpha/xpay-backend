import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

// ============================================================================
// Decifração do envelope de CARTÃO (Waylinx → Koopfy)
// ----------------------------------------------------------------------------
// Esquema: RSA-OAEP-256 (envelopa a chave AES) + AES-256-GCM (cifra o cartão).
// A chave privada NUNCA fica em código/disco/log — vem de KOOPFY_CARD_KEYS
// (mapa key_id → PEM). Em produção, trocar este KeyProvider por KMS/HSM.
//
// ⚠️ PCI: nunca logar number/cvv/encrypted_payload. Persistir só brand+last4.
// ============================================================================

const REQUIRED_ALG = 'RSA-OAEP-256+A256GCM';

export interface CardEnvelope {
  encrypted_payload: string; // base64 — AES-GCM; últimos 16 bytes = auth tag
  encrypted_key: string;     // base64 — AES key (32 bytes) via RSA-OAEP-256
  iv: string;                // base64
  alg: string;               // "RSA-OAEP-256+A256GCM"
  key_id: string;            // ex: "kpf_key_2026_01"
}

export interface DecryptedCard {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  holderName?: string;
  brand?: string;
  document?: string;
}

@Injectable()
export class CardCryptoService {
  // key_id → PEM da chave privada (mantém histórico p/ rotação)
  private readonly keys: Record<string, string> = {};

  constructor() {
    // KOOPFY_CARD_KEYS = JSON { "<key_id>": "<base64(PEM privada)>" }
    const raw = process.env.KOOPFY_CARD_KEYS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        for (const [id, b64] of Object.entries(parsed)) {
          this.keys[id] = Buffer.from(String(b64), 'base64').toString('utf8');
        }
      } catch (e: any) {
        console.error('[CardCrypto] KOOPFY_CARD_KEYS inválido (JSON):', e?.message);
      }
    }
  }

  private getPrivateKey(keyId: string): string | null {
    return this.keys[keyId] ?? null;
  }

  // Deriva a chave PÚBLICA da privada configurada — pro frontend cifrar o
  // cartão antes de mandar (nunca existiu esse lado ligado até agora: sem
  // publicKey, preparePayload cai no fallback sem cifra de aplicação).
  // Usa a primeira key_id do mapa (hoje só existe uma; se rotacionar, ajustar
  // pra escolher a "atual" explicitamente).
  getPublicKeyInfo(): { publicKey: string; keyId: string; algorithm: string } | null {
    const keyId = Object.keys(this.keys)[0];
    if (!keyId) return null;

    try {
      const publicKey = crypto
        .createPublicKey(this.keys[keyId])
        .export({ type: 'spki', format: 'pem' })
        .toString();
      return { publicKey, keyId, algorithm: REQUIRED_ALG };
    } catch (e: any) {
      console.error('[CardCrypto] getPublicKeyInfo falhou:', e?.message);
      return null;
    }
  }

  decryptCardEnvelope(env: CardEnvelope): DecryptedCard {
    if (!env || typeof env !== 'object') {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'card_encrypted ausente' });
    }
    if (env.alg !== REQUIRED_ALG) {
      throw new BadRequestException({ code: 'CARD_DECRYPT_FAILED', message: `alg inválido (esperado ${REQUIRED_ALG})` });
    }

    const privPem = this.getPrivateKey(env.key_id);
    if (!privPem) {
      throw new BadRequestException({ code: 'CARD_DECRYPT_FAILED', message: `key_id desconhecido: ${env.key_id}` });
    }

    try {
      const aesKey = crypto.privateDecrypt(
        { key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(env.encrypted_key, 'base64'),
      );

      const ct = Buffer.from(env.encrypted_payload, 'base64');
      if (ct.length <= 16) throw new Error('payload muito curto');
      const tag = ct.subarray(ct.length - 16);
      const data = ct.subarray(0, ct.length - 16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');

      const card = JSON.parse(plain) as DecryptedCard;
      if (!card?.number || !card?.cvv || !card?.expiryMonth || !card?.expiryYear) {
        throw new Error('campos do cartão ausentes após decifrar');
      }
      return card;
    } catch {
      // Nunca vaza detalhe (pode conter dado sensível).
      throw new BadRequestException({ code: 'CARD_DECRYPT_FAILED', message: 'falha ao decifrar o cartão' });
    }
  }
}
