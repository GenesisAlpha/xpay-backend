import * as crypto from 'crypto';

declare module 'express' {
    interface Request {
        sellerId: string;
    }
}


export function hashKey(key: string) {
    return crypto
        .createHash('sha256')
        .update(key)
        .digest('hex');
}

import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import { readApiKeyCache, writeApiKeyCache } from './api-key-cache';
import * as bcrypt from 'bcrypt';

declare module 'express' {
    interface Request {
        sellerId: string;
    }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {

    async canActivate(context: ExecutionContext): Promise<boolean> {
        // 🐞 DEBUG TEMPORÁRIO — timing (remover depois).
        const __t0 = Date.now();

        const req = context.switchToHttp().getRequest();

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing API Key');
        }

        const token = authHeader.replace('Bearer ', '').trim();

        // 🔥 1. extrai prefixo (ex: sk_live_abc123)
        const prefix = token.slice(0, 20); // pode ajustar tamanho

        // 🔥 2. a chave vem do cache; o banco só entra quando ele não tem.
        let apiKey = readApiKeyCache(prefix);
        if (apiKey === undefined) {
            const { data } = await supabase
                .from('api_keys')
                .select('id, seller_id, secret_key_hash')
                .eq('key_prefix', prefix)
                .eq('is_active', true)
                .single();
            apiKey = data
                ? { id: data.id, sellerId: data.seller_id, secretKeyHash: data.secret_key_hash }
                : null;
            writeApiKeyCache(prefix, apiKey);
            console.log(`[timing][ApiKeyGuard] busca api_keys: ${Date.now() - __t0}ms`);
        }

        if (!apiKey) {
            throw new UnauthorizedException('Invalid API Key');
        }

        const hashedToken = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        // compara direto — o hash guardado é o mesmo do banco.
        if (hashedToken !== apiKey.secretKeyHash) {
            throw new UnauthorizedException('Invalid API Key');
        }
        // 🔥 4. injeta seller no request
        req.sellerId = apiKey.sellerId;

        return true;
    }
}