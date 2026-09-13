import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';

// =========================================
// BRAND — Koopfy (roxo + fundo escuro)
// =========================================
const BRAND = {
    name: 'Koopfy',
    purple: '#8B5CF6',
    purpleDark: '#6D28D9',
    gradient: 'linear-gradient(135deg, #8B5CF6, #6D28D9)',
    bg: '#0a0a0f',
    card: '#16161f',
    cardInner: '#1e1e2a',
    border: '#2a2a3a',
    title: '#f5f3ff',
    text: '#a9a3c2',
    muted: '#6b6680',
    faint: '#494459',
};

@Injectable()
export class MailService {
    constructor() {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    }

    private readonly FROM = {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: process.env.SENDGRID_FROM_NAME ?? BRAND.name,
    };

    // Domínio do dash-pay (links de verify-email / reset-password). Em produção
    // DEVE vir de FRONTEND_URL (EB). Fallback = domínio de produção do dash-pay
    // p/ não quebrar se a env ficar ausente. Local: setar FRONTEND_URL=http://localhost:3000.
    private readonly FRONTEND_URL = process.env.FRONTEND_URL || 'https://merchant.koopfy.com';

    // =========================================
    // EMAIL VERIFICATION
    // =========================================
    async sendVerificationEmail({
        to,
        name,
        token,
    }: {
        to: string;
        name: string;
        token: string;
    }) {
        const verifyUrl = `${this.FRONTEND_URL}/verify-email?token=${token}`;
        const firstName = name.split(' ')[0];

        const html = this.buildLayout({
            eyebrow: 'Verificação de Email',
            heading: `Olá, ${firstName} 👋`,
            intro: `Obrigado por criar sua conta na ${BRAND.name}. Clique no botão abaixo para confirmar seu email e ativar sua conta.`,
            ctaLabel: 'Confirmar Email',
            ctaUrl: verifyUrl,
            notice: '⏱️ Este link expira em <strong style="color:#cbb9ff;">24 horas</strong>. Se não solicitou, ignore este email.',
            fallbackUrl: verifyUrl,
        });

        await this.send({
            to,
            subject: `Confirme seu email — ${BRAND.name}`,
            html,
        });
    }

    // =========================================
    // PASSWORD RESET
    // =========================================
    async sendPasswordResetEmail({
        to,
        name,
        token,
    }: {
        to: string;
        name: string;
        token: string;
    }) {
        const resetUrl = `${this.FRONTEND_URL}/reset-password?token=${token}`;
        const firstName = name.split(' ')[0];

        const html = this.buildLayout({
            eyebrow: 'Redefinição de Senha',
            heading: `Redefinir senha, ${firstName}`,
            intro: 'Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha.',
            ctaLabel: 'Redefinir Senha',
            ctaUrl: resetUrl,
            notice: '⏱️ Este link expira em <strong style="color:#cbb9ff;">2 horas</strong>. Se não solicitou, sua senha permanece segura — ignore este email.',
            fallbackUrl: resetUrl,
            icon: '🔒',
        });

        await this.send({
            to,
            subject: `Redefinir sua senha — ${BRAND.name}`,
            html,
        });
    }

    // =========================================
    // SEND HELPER
    // =========================================
    private async send({
        to,
        subject,
        html,
    }: {
        to: string;
        subject: string;
        html: string;
    }) {
        try {
            await sgMail.send({
                to,
                from: this.FROM,
                subject,
                html,
            });
        } catch (err: any) {
            console.error('SendGrid error:', err?.response?.body ?? err.message);
            throw new InternalServerErrorException('Falha ao enviar email');
        }
    }

    // =========================================
    // SHARED LAYOUT (dark + roxo Koopfy)
    // =========================================
    private buildLayout({
        eyebrow,
        heading,
        intro,
        ctaLabel,
        ctaUrl,
        notice,
        fallbackUrl,
        icon = '⚡',
    }: {
        eyebrow: string;
        heading: string;
        intro: string;
        ctaLabel: string;
        ctaUrl: string;
        notice: string;
        fallbackUrl: string;
        icon?: string;
    }): string {
        return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:${BRAND.card};border-radius:16px;border:1px solid ${BRAND.border};overflow:hidden;max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:${BRAND.gradient};padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <div style="background:rgba(255,255,255,0.2);border-radius:10px;padding:8px;display:inline-block;">
                  <span style="color:#fff;font-size:20px;">${icon}</span>
                </div>
                <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">${BRAND.name}</span>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:13px;color:${BRAND.purple};text-transform:uppercase;letter-spacing:1px;font-weight:600;">${eyebrow}</p>
              <h1 style="margin:0 0 20px;font-size:26px;font-weight:700;color:${BRAND.title};line-height:1.2;">
                ${heading}
              </h1>
              <p style="margin:0 0 28px;font-size:16px;color:${BRAND.text};line-height:1.6;">
                ${intro}
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${ctaUrl}"
                       style="display:inline-block;background:${BRAND.gradient};background-color:${BRAND.purpleDark};color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 40px;border-radius:12px;letter-spacing:0.2px;box-shadow:0 8px 24px rgba(124,58,237,0.35);">
                      ${ctaLabel}
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Notice -->
              <div style="background:${BRAND.cardInner};border:1px solid ${BRAND.border};border-radius:10px;padding:16px 20px;margin-bottom:28px;">
                <p style="margin:0;font-size:14px;color:${BRAND.muted};">
                  ${notice}
                </p>
              </div>

              <!-- Fallback link -->
              <p style="margin:0;font-size:13px;color:${BRAND.faint};">
                Ou copie e cole este link no navegador:<br>
                <a href="${fallbackUrl}" style="color:${BRAND.purple};word-break:break-all;font-size:12px;">${fallbackUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#101018;padding:20px 40px;border-top:1px solid ${BRAND.border};text-align:center;">
              <p style="margin:0;font-size:12px;color:${BRAND.faint};">
                © ${new Date().getFullYear()} ${BRAND.name} · Todos os direitos reservados
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
    }
}
