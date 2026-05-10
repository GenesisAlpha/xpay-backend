import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { supabase } from '../lib/supabase.client';
import { MailService } from '../utils/mail';
import { StorageService } from '../lib/storage.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly storageService: StorageService,
  ) {}

  // =========================================
  // REGISTER
  // =========================================
  async register(dto: {
    name: string;
    instagram: string;
    whatsapp: string;
    email: string;
    password: string;
    profileImageBase64?: string;
    profileImageMime?: string;
  }) {
    const email = dto.email.toLowerCase().trim();

    // 1. Verifica duplicata
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      throw new ConflictException('Email já cadastrado');
    }

    // 2. Hash da senha
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // 3. Token de verificação de email
    const verifyToken = uuidv4();
    const verifyTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // 4. Cria usuário
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email,
        password_hash:                  passwordHash,
        name:                           dto.name,
        instagram:                      dto.instagram,
        whatsapp:                       dto.whatsapp.replace(/\D/g, ''),
        email_verified:                 false,
        email_verify_token:             verifyToken,
        email_verify_token_expires_at:  verifyTokenExpiresAt.toISOString(),
        kyc_completed:                  false,
        operation_setup_completed:      false,
        onboarding_completed:           false,
        created_at:                     new Date().toISOString(),
      })
      .select('id, email, name')
      .single();

    if (userError || !user) {
      throw new BadRequestException('Erro ao criar conta: ' + userError?.message);
    }

    // 5. 🔥 Cria seller_profile imediatamente junto com o usuário
    //    Começa com dados mínimos — completado durante o onboarding
    const { error: profileError } = await supabase
      .from('seller_profiles')
      .insert({
        user_id:         user.id,
        name:            dto.name,
        email:           email,
        instagram:       dto.instagram,
        enabled_methods: [],
        risk_level:      'WHITE',
        kyc_status:      'pending',
        status:          'pending_review',
        config: {
          settlement: { delayDays: 3 },
          reserve:    { percentage: 0, holdDays: 0 },
        },
        metadata:   {},
        created_at: new Date().toISOString(),
      });

    if (profileError) {
      // Rollback: remove o user criado para não deixar estado inconsistente
      await supabase.from('users').delete().eq('id', user.id);
      throw new BadRequestException('Erro ao criar perfil: ' + profileError.message);
    }

    // 6. Cria wallet_balance zerado para o seller
    const { data: sellerProfile } = await supabase
      .from('seller_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (sellerProfile) {
      await supabase
        .from('wallet_balance')
        .insert({
          seller_id:         sellerProfile.id,
          available_balance: 0,
          pending_balance:   0,
          reserved_balance:  0,
        });
    }

    // 7. Upload foto de perfil (opcional)
    if (dto.profileImageBase64 && dto.profileImageMime) {
      const avatarUrl = await this.storageService.uploadAvatar({
        userId: user.id,
        base64: dto.profileImageBase64,
        mime:   dto.profileImageMime,
      });

      await supabase
        .from('users')
        .update({ avatar_url: avatarUrl })
        .eq('id', user.id);

      // Atualiza também no seller_profile se tiver metadata
      if (sellerProfile) {
        await supabase
          .from('seller_profiles')
          .update({ metadata: { logoUrl: avatarUrl } })
          .eq('id', sellerProfile.id);
      }
    }

    // 8. Envia email de verificação via SendGrid
    await this.mailService.sendVerificationEmail({
      to:    email,
      name:  dto.name,
      token: verifyToken,
    });

    return {
      message: 'Conta criada com sucesso. Verifique seu email para ativar.',
    };
  }

  // =========================================
  // VERIFY EMAIL
  // =========================================
  async verifyEmail(token: string) {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, email_verify_token_expires_at, email_verified')
      .eq('email_verify_token', token)
      .maybeSingle();

    if (error || !user) {
      throw new BadRequestException('Token de verificação inválido');
    }

    if (user.email_verified) {
      throw new BadRequestException('Email já verificado');
    }

    const expiresAt = new Date(user.email_verify_token_expires_at);
    if (Date.now() > expiresAt.getTime()) {
      throw new BadRequestException('Token expirado. Solicite um novo email de verificação.');
    }

    await supabase
      .from('users')
      .update({
        email_verified:                 true,
        email_verify_token:             null,
        email_verify_token_expires_at:  null,
        email_verified_at:              new Date().toISOString(),
      })
      .eq('id', user.id);

    const accessToken = this.issueToken(user.id, user.email);

    return { accessToken, redirectTo: '/onboarding/kyc' };
  }

  // =========================================
  // RESEND VERIFICATION EMAIL
  // =========================================
  async resendVerification(email: string) {
    const { data: user } = await supabase
      .from('users')
      .select('id, name, email_verified')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (user.email_verified) throw new BadRequestException('Email já verificado');

    const newToken  = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await supabase
      .from('users')
      .update({
        email_verify_token:            newToken,
        email_verify_token_expires_at: expiresAt.toISOString(),
      })
      .eq('id', user.id);

    await this.mailService.sendVerificationEmail({
      to:    email,
      name:  user.name,
      token: newToken,
    });

    return { message: 'Email de verificação reenviado' };
  }

  // =========================================
  // LOGIN
  // =========================================
  async login(dto: { email: string; password: string }) {
    const email = dto.email.toLowerCase().trim();

    const { data: user } = await supabase
      .from('users')
      .select('id, email, name, password_hash, email_verified, kyc_completed, onboarding_completed, operation_setup_completed, avatar_url')
      .eq('email', email)
      .maybeSingle();

    if (!user) {
      throw new UnauthorizedException('Email ou senha incorretos');
    }

    const passwordMatch = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordMatch) {
      throw new UnauthorizedException('Email ou senha incorretos');
    }

    if (!user.email_verified) {
      throw new UnauthorizedException('Email não verificado. Verifique sua caixa de entrada.');
    }

    await supabase
      .from('users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user.id);

    const accessToken = this.issueToken(user.id, user.email);
    const redirectTo  = this.resolveRedirect(user);

    return {
      accessToken,
      user: {
        id:                        user.id,
        name:                      user.name,
        email:                     user.email,
        avatarUrl:                 user.avatar_url,
        kycCompleted:              user.kyc_completed,           // camelCase para o frontend
        operationSetupCompleted:   user.operation_setup_completed,
        onboardingCompleted:       user.onboarding_completed,    // camelCase para o frontend
      },
      redirectTo,
    };
  }

  // =========================================
  // FORGOT PASSWORD
  // =========================================
  async forgotPassword(email: string) {
    const { data: user } = await supabase
      .from('users')
      .select('id, name, email_verified')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (!user || !user.email_verified) {
      return { message: 'Se o email existir, você receberá um link de redefinição.' };
    }

    const resetToken = uuidv4();
    const expiresAt  = new Date(Date.now() + 2 * 60 * 60 * 1000);

    await supabase
      .from('users')
      .update({
        password_reset_token:      resetToken,
        password_reset_expires_at: expiresAt.toISOString(),
      })
      .eq('id', user.id);

    await this.mailService.sendPasswordResetEmail({
      to:    email,
      name:  user.name,
      token: resetToken,
    });

    return { message: 'Se o email existir, você receberá um link de redefinição.' };
  }

  // =========================================
  // RESET PASSWORD
  // =========================================
  async resetPassword(token: string, newPassword: string) {
    const { data: user } = await supabase
      .from('users')
      .select('id, password_reset_expires_at')
      .eq('password_reset_token', token)
      .maybeSingle();

    if (!user) throw new BadRequestException('Token inválido');

    const expiresAt = new Date(user.password_reset_expires_at);
    if (Date.now() > expiresAt.getTime()) {
      throw new BadRequestException('Token expirado. Solicite um novo link.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await supabase
      .from('users')
      .update({
        password_hash:             passwordHash,
        password_reset_token:      null,
        password_reset_expires_at: null,
      })
      .eq('id', user.id);

    return { message: 'Senha redefinida com sucesso' };
  }

  // =========================================
  // ME
  // =========================================
  async getMe(userId: string) {
    const { data: user } = await supabase
      .from('users')
      .select(`
        id, name, email, instagram, whatsapp, avatar_url,
        kyc_completed, operation_setup_completed, onboarding_completed,
        created_at, last_login_at
      `)
      .eq('id', userId)
      .single();

    if (!user) throw new NotFoundException('Usuário não encontrado');

    // 🔥 Retorna campos com os nomes que o frontend espera (camelCase consistente)
    return {
      id:                        user.id,
      name:                      user.name,
      email:                     user.email,
      instagram:                 user.instagram,
      whatsapp:                  user.whatsapp,
      avatar_url:                user.avatar_url,
      kyc_completed:             user.kyc_completed,
      operation_setup_completed: user.operation_setup_completed,
      onboarding_completed:      user.onboarding_completed,  // 🔥 era operation_setup_completed
      created_at:                user.created_at,
      last_login_at:             user.last_login_at,
    };
  }

  // =========================================
  // HELPERS
  // =========================================
  private issueToken(userId: string, email: string): string {
    return this.jwtService.sign({ sub: userId, email });
  }

  private resolveRedirect(user: {
    kyc_completed:       boolean;
    onboarding_completed: boolean;
  }): string {
    if (!user.kyc_completed)        return '/onboarding/kyc';
    if (!user.onboarding_completed) return '/onboarding/operation';
    return '/dashboard';
  }
}