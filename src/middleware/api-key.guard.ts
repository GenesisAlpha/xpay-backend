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

        // 🔥 2. busca só UMA key
        const { data: apiKey, error } = await supabase
            .from('api_keys')
            .select('*')
            .eq('key_prefix', prefix)
            .eq('is_active', true)
            .single();
        console.log(`[timing][ApiKeyGuard] busca api_keys: ${Date.now() - __t0}ms`);

        if (error || !apiKey) {
            throw new UnauthorizedException('Invalid API Key');
        }

        const hashedToken = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        // compara direto
        if (hashedToken !== apiKey.secret_key_hash) {
            throw new UnauthorizedException('Invalid API Key');
        }
        // 🔥 4. injeta seller no request
        req.sellerId = apiKey.seller_id;
        console.log(`[timing][ApiKeyGuard] canActivate fim: ${Date.now() - __t0}ms`);

        return true;
    }
}