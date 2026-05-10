// auth/guards/jwt-auth.guard.ts
// Guard simples para rotas que só aceitam JWT (painel interno)
// Para rotas que aceitam tanto JWT quanto API Key, use UnifiedAuthGuard

import { Injectable, ExecutionContext } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}


// ─── auth/guards/api-key.guard.ts ────────────────────────────────────────────
// Guard dedicado para rotas que só aceitam API Key (integrações externas)
// Ex: POST /payments/create

import {
    CanActivate,
    Injectable as InjectableAK,
    UnauthorizedException,
} from '@nestjs/common'
import { supabase } from '../../lib/supabase.client'
import * as crypto from 'crypto'

@InjectableAK()
export class ApiKeyGuard implements CanActivate {

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest()

        const authHeader  = req.headers['authorization'] ?? ''
        const apiKeyHeader = req.headers['x-api-key']    ?? ''
        const token = apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '').trim()

        if (!token) throw new UnauthorizedException('API Key ausente')

        const prefix = token.slice(0, 20)

        const { data: apiKey } = await supabase
            .from('api_keys')
            .select('id, seller_id, secret_key_hash, is_active, expires_at')
            .eq('key_prefix', prefix)
            .eq('is_active', true)
            .maybeSingle()

        if (!apiKey) throw new UnauthorizedException('API Key inválida')

        if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
            throw new UnauthorizedException('API Key expirada')
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

        if (tokenHash !== apiKey.secret_key_hash) {
            throw new UnauthorizedException('API Key inválida')
        }

        const { data: seller } = await supabase
            .from('seller_profiles')
            .select('id, status, user_id')
            .eq('id', apiKey.seller_id)
            .maybeSingle()

        if (!seller || seller.status !== 'active') {
            throw new UnauthorizedException('Conta suspensa ou inativa')
        }

        // Fire-and-forget
        supabase
            .from('api_keys')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', apiKey.id)
            .then(() => {})

        req.sellerId = apiKey.seller_id
        req.user     = { sub: seller.user_id, sellerId: apiKey.seller_id }

        return true
    }
}


// ─── auth/decorators/auth.decorator.ts ───────────────────────────────────────
// Decoradores para marcar o tipo de autenticação exigida em cada rota

import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common'
import { UnifiedAuthGuard } from './unified-auth.guard'

// @Auth() → aceita JWT ou API Key (uso geral no dashboard)
export function Auth() {
    return applyDecorators(UseGuards(UnifiedAuthGuard))
}

// @ApiKeyOnly() → apenas API Key (rotas de integração externa)
export function ApiKeyOnly() {
    return applyDecorators(UseGuards(ApiKeyGuard))
}

// @JwtOnly() → apenas JWT (rotas exclusivas do painel)
export function JwtOnly() {
    return applyDecorators(UseGuards(JwtAuthGuard))
}