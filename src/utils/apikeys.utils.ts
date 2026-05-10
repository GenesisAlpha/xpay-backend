// api-keys/utils.ts
import * as crypto from 'crypto';

export function generateKey(prefix: string) {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}

export function hashKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function getKeyPrefix(key: string) {
  return key.split('_').slice(0, 2).join('_');
}