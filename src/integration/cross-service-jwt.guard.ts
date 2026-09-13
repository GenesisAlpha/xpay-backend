// integration/cross-service-jwt.guard.ts
//
// Guard para chamadas vindas de OUTRO serviço Koopfy (ex.: o backend checkout)
// em nome de um seller logado. Diferente do JwtAuthGuard padrão, NÃO exige que o
// `sub` do token exista na tabela `users` do pay (os dois serviços têm bancos
// separados e o user.id pode divergir). Em vez disso:
//   1. valida a ASSINATURA do JWT com o JWT_SECRET compartilhado;
//   2. resolve o seller pelo `email` do token (elo garantido no login unificado).
//
// Injeta em req.sellerCtx: { userId, email, seller }.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.client';

export interface SellerCtx {
  userId: string;
  email: string;
  seller: { id: string; status: string; kyc_status: string | null } | null;
}

@Injectable()
export class CrossServiceJwtGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();

    const authHeader = (req.headers['authorization'] ?? '') as string;
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Token ausente');

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET as string);
    } catch {
      throw new UnauthorizedException('Token inválido');
    }

    const email = payload?.email;
    if (!email) throw new UnauthorizedException('Token sem email');

    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      throw new UnauthorizedException('Seller não encontrado no Koopfy Pay');
    }

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('id, status, kyc_status')
      .eq('user_id', user.id)
      .maybeSingle();

    const ctx: SellerCtx = { userId: user.id, email: user.email, seller: seller ?? null };
    req.sellerCtx = ctx;

    return true;
  }
}

// Guard mais leve: só valida a assinatura do JWT e extrai o email. NÃO exige que
// o user já exista no pay — usado no provisionamento (a conta pode não existir
// ainda). Injeta req.tokenEmail.
@Injectable()
export class CrossServiceTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = (req.headers['authorization'] ?? '') as string;
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Token ausente');

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET as string);
    } catch {
      throw new UnauthorizedException('Token inválido');
    }

    if (!payload?.email) throw new UnauthorizedException('Token sem email');
    req.tokenEmail = String(payload.email).toLowerCase().trim();
    return true;
  }
}
