// strategies/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { supabase } from '../../lib/supabase.client';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET!,
    });
  }

  // `act` marca sessão aberta pela equipe no CRM (acesso ao painel do seller):
  // quem lê decide o que fazer — o saque, por exemplo, é recusado.
  async validate(payload: { sub: string; email: string; act?: { manager_id?: string; role?: string } }) {
    // Valida que o user ainda existe e está ativo
    const { data: user } = await supabase
      .from('users')
      .select('id, email, email_verified')
      .eq('id', payload.sub)
      .maybeSingle();

    if (!user || !user.email_verified) {
      throw new UnauthorizedException('Token inválido');
    }

    return { sub: user.id, email: user.email, act: payload.act ?? null };
  }
}