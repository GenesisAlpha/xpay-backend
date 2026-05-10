import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class CryptoService {

    // 🔥 chave MASTER (32 bytes)
    private key = Buffer.from(process.env.CRYPTO_MASTER_KEY!, 'hex');

    encrypt(text: string): string {
        const iv = crypto.randomBytes(16);

        const cipher = crypto.createCipheriv(
            'aes-256-gcm',
            this.key,
            iv
        ) as crypto.CipherGCM;

        const encrypted = Buffer.concat([
            cipher.update(text, 'utf8'),
            cipher.final(),
        ]);

        const tag = cipher.getAuthTag();

        // 🔥 padrão único: iv:tag:content
        return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    }

    decrypt(encryptedData: string): string {
        const [ivHex, tagHex, encryptedHex] = encryptedData.split(':');

        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const encryptedText = Buffer.from(encryptedHex, 'hex');

        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            this.key,
            iv
        );

        decipher.setAuthTag(tag);

        const decrypted = Buffer.concat([
            decipher.update(encryptedText),
            decipher.final(),
        ]);

        return decrypted.toString('utf8');
    }
}