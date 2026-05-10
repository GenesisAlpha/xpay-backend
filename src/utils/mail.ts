import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';

@Injectable()
export class MailService {
    constructor() {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY!);
    }

    private readonly FROM = {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: process.env.SENDGRID_FROM_NAME ?? 'Nexor',
    };

    private readonly FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.nexorpayments.com';

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

        const verifyUrl = `${this.FRONTEND_URL}/verify-email?token=${token}`
        const firstName = name.split(' ')[0]
        const html = this.buildVerificationHtml({ firstName, verifyUrl })


        await this.send({
            to,
            subject: 'Confirme seu email — Nexor',
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

        const html = this.buildResetHtml({ firstName, resetUrl });

        await this.send({
            to,
            subject: 'Redefinir sua senha — Nexor',
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
    // EMAIL TEMPLATES
    // =========================================
    private buildVerificationHtml({
        firstName,
        verifyUrl,
    }: {
        firstName: string;
        verifyUrl: string;
    }): string {
        return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirme seu email</title>
</head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1d27;border-radius:16px;border:1px solid #2a2d3a;overflow:hidden;max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #00c77f, #00a86b);;padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <div style="background:rgba(255,255,255,0.2);border-radius:10px;padding:8px;display:inline-block;">
                  <span style="color:#fff;font-size:20px;">⚡</span>
                </div>
                <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">Nexor Global</span>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Verificação de Email</p>
              <h1 style="margin:0 0 20px;font-size:26px;font-weight:700;color:#f1f5f9;line-height:1.2;">
                Olá, ${firstName} 👋
              </h1>
              <p style="margin:0 0 28px;font-size:16px;color:#94a3b8;line-height:1.6;">
                Obrigado por criar sua conta na Nexor. Clique no botão abaixo para confirmar seu email e ativar sua conta.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${verifyUrl}"
                       style="display:inline-block;background:#00c77f;color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 40px;border-radius:12px;letter-spacing:0.2px;">
                      Confirmar Email
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <div style="background:#1e2433;border:1px solid #2a2d3a;border-radius:10px;padding:16px 20px;margin-bottom:28px;">
                <p style="margin:0;font-size:14px;color:#64748b;">
                  ⏱️ Este link expira em <strong style="color:#94a3b8;">24 horas</strong>. 
                  Se não solicitou, ignore este email.
                </p>
              </div>

              <!-- Fallback link -->
              <p style="margin:0;font-size:13px;color:#475569;">
                Ou copie e cole este link no navegador:<br>
                <a href="${verifyUrl}" style="color:#00c77f;word-break:break-all;font-size:12px;">${verifyUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#141720;padding:20px 40px;border-top:1px solid #2a2d3a;text-align:center;">
              <p style="margin:0;font-size:12px;color:#374151;">
                © ${new Date().getFullYear()} Nexor · Todos os direitos reservados
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

    private buildResetHtml({
        firstName,
        resetUrl,
    }: {
        firstName: string;
        resetUrl: string;
    }): string {
        return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redefinir senha</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#1a1d27;border-radius:16px;border:1px solid #2a2d3a;overflow:hidden;max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#dc2626,#b91c1c);padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:10px;">
                <div style="background:rgba(255,255,255,0.2);border-radius:10px;padding:8px;display:inline-block;">
                  <span style="color:#fff;font-size:20px;">🔒</span>
                </div>
                <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;"> Nexor</span>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <p style="margin:0 0 8px;font-size:13px;color:#64748b;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Redefinição de Senha</p>
              <h1 style="margin:0 0 20px;font-size:26px;font-weight:700;color:#f1f5f9;line-height:1.2;">
                Redefinir senha, ${firstName}
              </h1>
              <p style="margin:0 0 28px;font-size:16px;color:#94a3b8;line-height:1.6;">
                Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para criar uma nova senha.
              </p>

              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${resetUrl}"
                       style="display:inline-block;background:#dc2626;color:#fff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 40px;border-radius:12px;">
                      Redefinir Senha
                    </a>
                  </td>
                </tr>
              </table>

              <div style="background:#1e2433;border:1px solid #2a2d3a;border-radius:10px;padding:16px 20px;margin-bottom:28px;">
                <p style="margin:0;font-size:14px;color:#64748b;">
                  ⏱️ Este link expira em <strong style="color:#94a3b8;">2 horas</strong>. 
                  Se não solicitou, sua senha permanece segura — ignore este email.
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#475569;">
                Ou copie e cole no navegador:<br>
                <a href="${resetUrl}" style="color:#00c77f;word-break:break-all;font-size:12px;">${resetUrl}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#141720;padding:20px 40px;border-top:1px solid #2a2d3a;text-align:center;">
              <p style="margin:0;font-size:12px;color:#374151;">
                © ${new Date().getFullYear()} Nexor · Todos os direitos reservados
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