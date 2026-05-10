// auth/guards/unified-auth.guard.ts
//
// Guard único que cobre os 3 cenários de autenticação da plataforma:
//
//   1. JWT próprio (dashboard / frontend do painel)
//      Header: Authorization: Bearer <jwt_gerado_pelo_nestjs>
//
//   2. API Key (sellers integrando via API)
//      Header: Authorization: Bearer sk_live_xxxxx
//      ou Header: X-Api-Key: sk_live_xxxxx
//
//   3. (Opcional/legado) Supabase Auth token
//      Header: Authorization: Bearer <supabase_jwt>
//      Só entra nesse fallback se os outros dois falharem.
//
// Todos os casos resolvem req.sellerId e req.user para os controllers.

import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as crypto from 'crypto'
import { supabase } from '../../lib/supabase.client'

@Injectable()
export class UnifiedAuthGuard implements CanActivate {

    constructor(private readonly jwtService: JwtService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest()

        // ─── Extrai o token ───────────────────────────────────────────────────
        // Aceita tanto Authorization: Bearer <token>
        // quanto o header customizado X-Api-Key: <token>

        const authHeader = req.headers['authorization'] ?? ''
        const apiKeyHeader = req.headers['x-api-key'] ?? ''

        const token = apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '').trim()

        if (!token) {
            throw new UnauthorizedException('Token de autenticação ausente')
        }

        // ─── 1. Tenta JWT próprio ─────────────────────────────────────────────
        // Tokens JWT começam com "eyJ" (base64 de {"alg":...})

        if (token.startsWith('eyJ')) {
            return this.validateJwt(req, token)
        }

        // ─── 2. Tenta API Key (sk_live_ ou sk_test_) ─────────────────────────
        // Prefixo definido no momento da geração da chave

        if (token.startsWith('sk_live_') || token.startsWith('sk_test_')) {
            return this.validateApiKey(req, token)
        }

        // ─── 3. Fallback: qualquer outro token vai para API Key ───────────────
        // (cobre casos onde o seller envia a chave sem o prefixo padrão)

        return this.validateApiKey(req, token)
    }

    // =========================================================================
    // 1. VALIDA JWT PRÓPRIO
    // =========================================================================

    private async validateJwt(req: any, token: string): Promise<boolean> {
        let payload: { sub: string; email: string }

        try {
            payload = this.jwtService.verify(token, {
                secret: process.env.JWT_SECRET,
            })
        } catch {
            throw new UnauthorizedException('JWT inválido ou expirado')
        }

        // Verifica que o usuário ainda existe e está ativo
        const { data: user } = await supabase
            .from('users')
            .select('id, email, email_verified, kyc_completed, onboarding_completed')
            .eq('id', payload.sub)
            .maybeSingle()

        if (!user) {
            throw new UnauthorizedException('Usuário não encontrado')
        }

        if (!user.email_verified) {
            throw new UnauthorizedException('Email não verificado')
        }

        // Resolve seller_id (pode ser null se ainda não completou onboarding)
        const { data: seller } = await supabase
            .from('seller_profiles')
            .select('id, status')
            .eq('user_id', user.id)
            .maybeSingle()

        // Injeta no request
        req.user     = { sub: user.id, email: user.email }
        req.sellerId = seller?.id ?? null
        req.authType = 'jwt'

        return true
    }

    // =========================================================================
    // 2. VALIDA API KEY
    // =========================================================================

    private async validateApiKey(req: any, token: string): Promise<boolean> {

        // Extrai o prefixo (primeiros 20 chars) para busca indexada
        const prefix = token.slice(0, 20)

        const { data: apiKey } = await supabase
            .from('api_keys')
            .select('id, seller_id, secret_key_hash, is_active, expires_at')
            .eq('key_prefix', prefix)
            .eq('is_active', true)
            .maybeSingle()

        if (!apiKey) {
            throw new UnauthorizedException('API Key inválida')
        }

        // Verifica expiração (se configurada)
        if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
            throw new UnauthorizedException('API Key expirada')
        }

        // Compara hash SHA-256
        const tokenHash = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex')

        if (tokenHash !== apiKey.secret_key_hash) {
            throw new UnauthorizedException('API Key inválida')
        }

        // Verifica que o seller está ativo
        const { data: seller } = await supabase
            .from('seller_profiles')
            .select('id, status, user_id')
            .eq('id', apiKey.seller_id)
            .maybeSingle()

        if (!seller) {
            throw new UnauthorizedException('Seller não encontrado')
        }

        if (seller.status !== 'active') {
            throw new UnauthorizedException('Conta suspensa ou inativa')
        }

        // Atualiza last_used_at de forma assíncrona (não bloqueia o request)
        supabase
            .from('api_keys')
            .update({ last_used_at: new Date().toISOString() })
            .eq('id', apiKey.id)
            .then(() => {})

        // Injeta no request
        req.sellerId = apiKey.seller_id
        req.user     = { sub: seller.user_id, sellerId: apiKey.seller_id }
        req.authType = 'api_key'

        return true
    }
}