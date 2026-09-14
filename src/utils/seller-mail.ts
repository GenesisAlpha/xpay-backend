// E-mails de saque para o vendedor.
//
// Saque mexe com dinheiro: o vendedor precisa saber quando pediu, quando foi
// aprovado ou recusado (e por quê), quando saiu e quando falhou com o saldo
// devolvido. Sem isso, cada status vira ticket de "cadê meu dinheiro".
// Sempre enviados — não há opção de desligar.
//
// Sem DI de propósito: os serviços chamam fire-and-forget e uma falha de e-mail
// nunca derruba o saque. Nunca lança: loga e segue.

import * as sgMail from '@sendgrid/mail';
import { supabase } from '../lib/supabase.client';

export type PayoutEmailEvent = 'requested' | 'approved' | 'rejected' | 'completed' | 'failed';

type Lang = 'pt' | 'es' | 'en';

const SPANISH_COUNTRIES = ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'UY', 'PY', 'BO', 'EC', 'VE', 'CR', 'GT', 'PA', 'DO'];

function languageFor(country?: string | null): Lang {
  const code = String(country ?? '').toUpperCase();
  if (['BR', 'PT', 'AO', 'MZ'].includes(code)) return 'pt';
  if (SPANISH_COUNTRIES.includes(code)) return 'es';
  return 'en';
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Copy {
  subject: (amount: string) => string;
  intro: (amount: string) => string;
  detail?: string;
}

const COPY: Record<Lang, Record<PayoutEmailEvent, Copy> & { reason: string; button: string; footer: string; method: string }> = {
  pt: {
    requested: {
      subject: (a) => `Saque de ${a} solicitado`,
      intro: (a) => `Recebemos seu pedido de saque de <strong>${a}</strong>. O valor fica reservado enquanto analisamos.`,
    },
    approved: {
      subject: (a) => `Saque de ${a} aprovado`,
      intro: (a) => `Seu saque de <strong>${a}</strong> foi aprovado e está sendo enviado.`,
    },
    rejected: {
      subject: (a) => `Saque de ${a} recusado`,
      intro: (a) => `Seu saque de <strong>${a}</strong> foi recusado. O valor voltou para o seu saldo disponível.`,
    },
    completed: {
      subject: (a) => `Saque de ${a} enviado`,
      intro: (a) => `Seu saque de <strong>${a}</strong> foi concluído e enviado ao destino cadastrado.`,
    },
    failed: {
      subject: (a) => `Saque de ${a} não foi concluído`,
      intro: (a) => `O envio do seu saque de <strong>${a}</strong> falhou. O valor voltou para o seu saldo disponível e você pode solicitar de novo.`,
    },
    reason: 'Motivo',
    method: 'Método',
    button: 'Ver saques',
    footer: 'E-mail automático da Koopfy sobre a sua conta.',
  },
  es: {
    requested: {
      subject: (a) => `Retiro de ${a} solicitado`,
      intro: (a) => `Recibimos tu solicitud de retiro de <strong>${a}</strong>. El monto queda reservado mientras lo revisamos.`,
    },
    approved: {
      subject: (a) => `Retiro de ${a} aprobado`,
      intro: (a) => `Tu retiro de <strong>${a}</strong> fue aprobado y se está enviando.`,
    },
    rejected: {
      subject: (a) => `Retiro de ${a} rechazado`,
      intro: (a) => `Tu retiro de <strong>${a}</strong> fue rechazado. El monto volvió a tu saldo disponible.`,
    },
    completed: {
      subject: (a) => `Retiro de ${a} enviado`,
      intro: (a) => `Tu retiro de <strong>${a}</strong> se completó y fue enviado al destino registrado.`,
    },
    failed: {
      subject: (a) => `Retiro de ${a} no completado`,
      intro: (a) => `El envío de tu retiro de <strong>${a}</strong> falló. El monto volvió a tu saldo disponible y puedes solicitarlo de nuevo.`,
    },
    reason: 'Motivo',
    method: 'Método',
    button: 'Ver retiros',
    footer: 'Correo automático de Koopfy sobre tu cuenta.',
  },
  en: {
    requested: {
      subject: (a) => `Payout of ${a} requested`,
      intro: (a) => `We received your payout request of <strong>${a}</strong>. The amount is held while we review it.`,
    },
    approved: {
      subject: (a) => `Payout of ${a} approved`,
      intro: (a) => `Your payout of <strong>${a}</strong> was approved and is on its way.`,
    },
    rejected: {
      subject: (a) => `Payout of ${a} declined`,
      intro: (a) => `Your payout of <strong>${a}</strong> was declined. The amount is back in your available balance.`,
    },
    completed: {
      subject: (a) => `Payout of ${a} sent`,
      intro: (a) => `Your payout of <strong>${a}</strong> is complete and was sent to your registered destination.`,
    },
    failed: {
      subject: (a) => `Payout of ${a} not completed`,
      intro: (a) => `Sending your payout of <strong>${a}</strong> failed. The amount is back in your available balance and you can request it again.`,
    },
    reason: 'Reason',
    method: 'Method',
    button: 'View payouts',
    footer: 'Automatic Koopfy email about your account.',
  },
};

function formatAmount(amountCents: number, currency: string | null | undefined, lang: Lang): string {
  const cur = String(currency || 'USD').toUpperCase();
  const locale = lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es-ES' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: cur }).format((Number(amountCents) || 0) / 100);
  } catch {
    return `${((Number(amountCents) || 0) / 100).toFixed(2)} ${cur}`;
  }
}

export async function notifySellerPayout(
  sellerId: string | null | undefined,
  event: PayoutEmailEvent,
  info: { amountCents: number; currency?: string | null; method?: string | null; reason?: string | null },
): Promise<void> {
  try {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey || !sellerId) {
      if (!apiKey) console.warn(`[SellerMail] payout ${event}: SENDGRID_API_KEY ausente — e-mail não enviado.`);
      return;
    }
    const { data: seller } = await supabase
      .from('seller_profiles').select('email, name, country').eq('id', sellerId).maybeSingle();
    if (!seller?.email) {
      console.warn(`[SellerMail] payout ${event}: seller ${sellerId} sem e-mail.`);
      return;
    }

    const lang = languageFor(seller.country);
    const copy = COPY[lang];
    const amount = formatAmount(info.amountCents, info.currency, lang);
    const firstName = String(seller.name ?? '').trim().split(/\s+/)[0];
    const dashboard = (process.env.SELLER_DASHBOARD_URL ?? 'https://app.koopfy.com').replace(/\/+$/, '');
    const link = `${dashboard}/finance/transfers`;

    const lines = [
      firstName ? `<p>${escapeHtml(firstName)},</p>` : '',
      `<p>${copy[event].intro(escapeHtml(amount))}</p>`,
      info.method ? `<p style="margin:0 0 4px;color:#555">${copy.method}: ${escapeHtml(String(info.method))}</p>` : '',
      info.reason ? `<p style="margin:0 0 4px;color:#555">${copy.reason}: ${escapeHtml(String(info.reason))}</p>` : '',
    ].join('');

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: seller.email,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? process.env.PLATFORM_FROM_EMAIL ?? 'no-reply@koopfy.com',
        name: process.env.SENDGRID_FROM_NAME ?? 'Koopfy',
      },
      subject: copy[event].subject(amount),
      html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px;border-radius:12px;background:#fff;color:#18181b;font-size:15px;line-height:1.55">
${lines}
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600">${copy.button}</a></p>
<p style="margin:24px 0 0;color:#71717a;font-size:12px">${copy.footer}</p>
</div></body></html>`,
    });
  } catch (error: any) {
    console.error(`[SellerMail] payout ${event} (seller ${sellerId}) falhou:`, error?.response?.body ?? error?.message ?? error);
  }
}
