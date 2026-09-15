// integration/cross-service-jwt.guard.ts
//
// Guard para chamadas vindas de OUTRO serviço Koopfy (ex.: o backend checkout)
// em nome de um seller logado. Diferente do JwtAuthGuard padrão, NÃO exige que o
// `sub` do token exista na tabela `users` do pay (os dois serviços têm bancos
// separados e o user.id pode divergir). Em vez disso:
//   1. valida a ASSINATURA do JWT com o JWT_SECRET compartilhado;
//   2. resolve a conta pelo `email` do token (elo garantido no login unificado)
//      e, se vier, pelo header X-Koopfy-Seller-Id — a conta que o workspace usa,
//      conferida como do mesmo usuário (seller-accounts.ts).
//
// Injeta em req.sellerCtx: { userId, email, seller }. `userId` é o usuário do
// pay dono dos dados da conta escolhida.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.client';
import { normalizeEmail, resolveAccountUserId, sellerIdFromHeaders } from './seller-accounts';

export interface SellerCtx {
  userId: string;
  email: string;
  seller: { id: string; status: string; kyc_status: string | null } | null;
}

function verifiedEmail(req: any): string {
  const authHeader = (req.headers['authorization'] ?? '') as string;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new UnauthorizedException('Token ausente');

  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET as string);
  } catch {
    throw new UnauthorizedException('Token inválido');
  }

  const email = normalizeEmail(payload?.email);
  if (!email) throw new UnauthorizedException('Token sem email');
  return email;
}

@Injectable()
export class CrossServiceJwtGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const email = verifiedEmail(req);

    // Conta de outro usuário no header: 403 dentro de resolveAccountUserId.
    const userId = await resolveAccountUserId(email, sellerIdFromHeaders(req.headers));
    if (!userId) {
      throw new UnauthorizedException('Seller não encontrado no Koopfy Pay');
    }

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('id, status, kyc_status')
      .eq('user_id', userId)
      .maybeSingle();

    const ctx: SellerCtx = { userId, email, seller: seller ?? null };
    req.sellerCtx = ctx;

    return true;
  }
}

// Guard mais leve: só valida a assinatura do JWT e extrai o email. NÃO exige que
// o user já exista no pay — usado no provisionamento (a conta pode não existir
// ainda). Injeta req.tokenEmail e req.accountSellerId (conta escolhida pelo
// workspace, conferida no service).
@Injectable()
export class CrossServiceTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    req.tokenEmail = verifiedEmail(req);
    req.accountSellerId = sellerIdFromHeaders(req.headers);
    return true;
  }
}
