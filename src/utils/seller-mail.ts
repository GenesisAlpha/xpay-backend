// E-mails de saque para o vendedor.
//
// Saque mexe com dinheiro: o vendedor precisa saber quando pediu, quando foi
// aprovado ou recusado (e por quê), quando saiu e quando falhou com o saldo
// devolvido. Sem isso, cada status vira ticket de "cadê meu dinheiro".
// Sempre enviados — não há opção de desligar.
//
// Conteúdo: valor em destaque, linha do tempo do saque (solicitado → aprovado →
// enviado), método, destino MASCARADO (chave Pix, conta, carteira), taxa e
// valor líquido, ID e datas, motivo em recusa/falha e o que fazer a seguir.
// Mesmo visual dos e-mails do checkout (seller-email-kit.ts de lá).
//
// Sem DI de propósito: os serviços chamam fire-and-forget e uma falha de e-mail
// nunca derruba o saque. Nunca lança: loga e segue.

import * as sgMail from '@sendgrid/mail';
import { supabase } from '../lib/supabase.client';

export type PayoutEmailEvent = 'requested' | 'approved' | 'rejected' | 'completed' | 'failed';

export interface PayoutEmailInfo {
  amountCents: number;
  currency?: string | null;
  method?: string | null;
  reason?: string | null;
  payoutId?: string | null;
  /** metadata.destination do ledger (camelCase): pixKey, bankName, iban, cryptoAddress… */
  destination?: Record<string, any> | null;
  /** Taxa do saque em centavos (wallet_ledger.fee). */
  feeCents?: number | null;
  requestedAt?: string | null;
  /** ID da transferência no provedor (saque concluído). */
  providerPayoutId?: string | null;
}

type Lang = 'pt' | 'es' | 'en';
type Tone = 'success' | 'warning' | 'danger' | 'info';

const SPANISH_COUNTRIES = ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'UY', 'PY', 'BO', 'EC', 'VE', 'CR', 'GT', 'PA', 'DO'];

function languageFor(country?: string | null): Lang {
  const code = String(country ?? '').toUpperCase();
  if (['BR', 'PT', 'AO', 'MZ'].includes(code)) return 'pt';
  if (SPANISH_COUNTRIES.includes(code)) return 'es';
  return 'en';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const localeOf = (lang: Lang) => (lang === 'pt' ? 'pt-BR' : lang === 'es' ? 'es-ES' : 'en-US');

function money(cents: number, currency: string | null | undefined, lang: Lang): string {
  const cur = String(currency || 'USD').toUpperCase();
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(localeOf(lang), { style: 'currency', currency: cur }).format(value);
  } catch {
    return `${value.toFixed(2)} ${cur}`;
  }
}

function dateTime(iso: string | null | undefined, lang: Lang, country?: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '—';
  const timeZone = String(country ?? '').toUpperCase() === 'BR' ? 'America/Sao_Paulo' : 'UTC';
  const text = new Intl.DateTimeFormat(localeOf(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
  return timeZone === 'UTC' ? `${text} UTC` : text;
}

// ── Destino mascarado: o suficiente para reconhecer, nunca o dado inteiro ──

function maskMiddle(value: string, keepStart: number, keepEnd: number): string {
  const v = value.trim();
  if (v.length <= keepStart + keepEnd) return v.replace(/.(?=.{2})/g, '•');
  return `${v.slice(0, keepStart)}••••${v.slice(-keepEnd)}`;
}

function maskPixKey(key: string, type: string): string {
  const t = type.toLowerCase();
  if (t === 'email' && key.includes('@')) {
    const [user, domain] = key.split('@');
    return `${user.slice(0, 2)}•••@${domain}`;
  }
  if (t === 'random' || t === 'evp' || key.length > 20) return maskMiddle(key, 4, 4);
  return maskMiddle(key, 3, 2);
}

const METHOD: Record<string, Record<Lang, string>> = {
  pix: { pt: 'Pix', es: 'Pix', en: 'Pix' },
  crypto: { pt: 'Cripto (USDT)', es: 'Cripto (USDT)', en: 'Crypto (USDT)' },
  bank_transfer: { pt: 'Transferência bancária', es: 'Transferencia bancaria', en: 'Bank transfer' },
  wire: { pt: 'Transferência internacional', es: 'Transferencia internacional', en: 'Wire transfer' },
  sepa: { pt: 'SEPA', es: 'SEPA', en: 'SEPA' },
  ach: { pt: 'ACH', es: 'ACH', en: 'ACH' },
};

function methodLabel(method: string | null | undefined, lang: Lang): string | null {
  const m = String(method ?? '').toLowerCase();
  if (!m) return null;
  return METHOD[m]?.[lang] ?? m.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function destinationLabel(dest: Record<string, any> | null | undefined): string | null {
  if (!dest) return null;
  if (dest.pixKey) {
    const type = String(dest.pixKeyType ?? '');
    return `${type ? `${type.toUpperCase()} · ` : ''}${maskPixKey(String(dest.pixKey), type)}`;
  }
  if (dest.cryptoAddress) {
    return `${dest.cryptoNetwork ? `${String(dest.cryptoNetwork)} · ` : ''}${maskMiddle(String(dest.cryptoAddress), 6, 4)}`;
  }
  const account = dest.iban ?? dest.accountNumber ?? dest.account ?? null;
  if (account) {
    const bank = dest.bankName ? `${String(dest.bankName)} · ` : '';
    return `${bank}•••• ${String(account).replace(/\s/g, '').slice(-4)}`;
  }
  return dest.bankName ? String(dest.bankName) : null;
}

// ── Textos ────────────────────────────────────────────────────────────────

interface EventCopy {
  subject: (amount: string) => string;
  badge: string;
  title: string;
  intro: string;
  tone: Tone;
}

const COPY: Record<Lang, Record<PayoutEmailEvent, EventCopy> & {
  hero: string; steps: [string, string, string]; rejectedStep: string; failedStep: string;
  details: string; method: string; destination: string; holder: string; payoutId: string; requestedAt: string;
  fee: string; net: string; transferId: string; reason: string; balanceBack: string; next: string;
  nextByEvent: Record<PayoutEmailEvent, string>; view: string; support: string; footer: string;
}> = {
  pt: {
    requested: { subject: (a) => `Saque de ${a} solicitado`, badge: 'Saque solicitado', title: 'Recebemos seu pedido de saque', intro: 'O valor fica reservado no seu saldo enquanto a equipe analisa o pedido.', tone: 'info' },
    approved: { subject: (a) => `✅ Saque de ${a} aprovado`, badge: 'Saque aprovado', title: 'Seu saque foi aprovado', intro: 'O pagamento está sendo enviado para o destino cadastrado.', tone: 'info' },
    rejected: { subject: (a) => `Saque de ${a} recusado`, badge: 'Saque recusado', title: 'Seu saque foi recusado', intro: 'O valor voltou para o seu saldo disponível.', tone: 'danger' },
    completed: { subject: (a) => `💸 Saque de ${a} enviado`, badge: 'Saque enviado', title: 'Seu saque foi enviado', intro: 'A transferência foi concluída para o destino cadastrado.', tone: 'success' },
    failed: { subject: (a) => `Saque de ${a} não foi concluído`, badge: 'Falha no envio', title: 'Não conseguimos enviar seu saque', intro: 'O valor voltou para o seu saldo disponível e você pode solicitar de novo.', tone: 'danger' },
    hero: 'Valor do saque',
    steps: ['Solicitado', 'Aprovado', 'Enviado'],
    rejectedStep: 'Recusado',
    failedStep: 'Falhou',
    details: 'Detalhes do saque', method: 'Método', destination: 'Destino', holder: 'Titular', payoutId: 'ID do saque', requestedAt: 'Solicitado em',
    fee: 'Taxa', net: 'Valor líquido', transferId: 'ID da transferência', reason: 'Motivo',
    balanceBack: 'O valor voltou para o seu <strong>saldo disponível</strong>.',
    next: 'Próximo passo',
    nextByEvent: {
      requested: 'Você recebe um e-mail a cada mudança de status. Confira se o destino acima está correto.',
      approved: 'O prazo de chegada depende do método e do banco de destino. Avisamos quando o envio for concluído.',
      rejected: 'Corrija o que foi apontado no motivo e solicite um novo saque pelo painel.',
      completed: 'Se o valor não aparecer no destino em até 2 dias úteis, fale com o suporte informando o ID da transferência.',
      failed: 'Confira os dados do destino e solicite o saque de novo pelo painel.',
    },
    view: 'Ver saques', support: 'Falar com o suporte',
    footer: 'Aviso financeiro — enviado sempre, não pode ser desligado.',
  },
  es: {
    requested: { subject: (a) => `Retiro de ${a} solicitado`, badge: 'Retiro solicitado', title: 'Recibimos tu solicitud de retiro', intro: 'El monto queda reservado en tu saldo mientras el equipo revisa la solicitud.', tone: 'info' },
    approved: { subject: (a) => `✅ Retiro de ${a} aprobado`, badge: 'Retiro aprobado', title: 'Tu retiro fue aprobado', intro: 'El pago se está enviando al destino registrado.', tone: 'info' },
    rejected: { subject: (a) => `Retiro de ${a} rechazado`, badge: 'Retiro rechazado', title: 'Tu retiro fue rechazado', intro: 'El monto volvió a tu saldo disponible.', tone: 'danger' },
    completed: { subject: (a) => `💸 Retiro de ${a} enviado`, badge: 'Retiro enviado', title: 'Tu retiro fue enviado', intro: 'La transferencia se completó al destino registrado.', tone: 'success' },
    failed: { subject: (a) => `Retiro de ${a} no completado`, badge: 'Fallo en el envío', title: 'No pudimos enviar tu retiro', intro: 'El monto volvió a tu saldo disponible y puedes solicitarlo de nuevo.', tone: 'danger' },
    hero: 'Monto del retiro',
    steps: ['Solicitado', 'Aprobado', 'Enviado'],
    rejectedStep: 'Rechazado',
    failedStep: 'Falló',
    details: 'Detalles del retiro', method: 'Método', destination: 'Destino', holder: 'Titular', payoutId: 'ID del retiro', requestedAt: 'Solicitado el',
    fee: 'Comisión', net: 'Monto neto', transferId: 'ID de la transferencia', reason: 'Motivo',
    balanceBack: 'El monto volvió a tu <strong>saldo disponible</strong>.',
    next: 'Siguiente paso',
    nextByEvent: {
      requested: 'Recibes un correo en cada cambio de estado. Verifica que el destino de arriba sea correcto.',
      approved: 'El plazo de llegada depende del método y del banco de destino. Te avisamos cuando se complete.',
      rejected: 'Corrige lo indicado en el motivo y solicita un nuevo retiro desde el panel.',
      completed: 'Si el monto no aparece en el destino en 2 días hábiles, contacta a soporte con el ID de la transferencia.',
      failed: 'Revisa los datos del destino y solicita el retiro de nuevo desde el panel.',
    },
    view: 'Ver retiros', support: 'Hablar con soporte',
    footer: 'Aviso financiero — siempre se envía, no se puede desactivar.',
  },
  en: {
    requested: { subject: (a) => `Payout of ${a} requested`, badge: 'Payout requested', title: 'We received your payout request', intro: 'The amount is held in your balance while the team reviews the request.', tone: 'info' },
    approved: { subject: (a) => `✅ Payout of ${a} approved`, badge: 'Payout approved', title: 'Your payout was approved', intro: 'The payment is being sent to your registered destination.', tone: 'info' },
    rejected: { subject: (a) => `Payout of ${a} declined`, badge: 'Payout declined', title: 'Your payout was declined', intro: 'The amount is back in your available balance.', tone: 'danger' },
    completed: { subject: (a) => `💸 Payout of ${a} sent`, badge: 'Payout sent', title: 'Your payout was sent', intro: 'The transfer to your registered destination is complete.', tone: 'success' },
    failed: { subject: (a) => `Payout of ${a} not completed`, badge: 'Transfer failed', title: "We couldn't send your payout", intro: 'The amount is back in your available balance and you can request it again.', tone: 'danger' },
    hero: 'Payout amount',
    steps: ['Requested', 'Approved', 'Sent'],
    rejectedStep: 'Declined',
    failedStep: 'Failed',
    details: 'Payout details', method: 'Method', destination: 'Destination', holder: 'Account holder', payoutId: 'Payout ID', requestedAt: 'Requested on',
    fee: 'Fee', net: 'Net amount', transferId: 'Transfer ID', reason: 'Reason',
    balanceBack: 'The amount is back in your <strong>available balance</strong>.',
    next: 'Next step',
    nextByEvent: {
      requested: "You'll get an email at every status change. Check that the destination above is correct.",
      approved: "Arrival time depends on the method and destination bank. We'll let you know when it's sent.",
      rejected: 'Fix what the reason points out and request a new payout from your dashboard.',
      completed: "If the amount doesn't show up within 2 business days, contact support with the transfer ID.",
      failed: 'Check your destination details and request the payout again from your dashboard.',
    },
    view: 'View payouts', support: 'Contact support',
    footer: 'Financial notice — always sent, cannot be turned off.',
  },
};

// ── Layout (mesmo visual do seller-email-kit do checkout) ─────────────────

const TONES: Record<Tone, { fg: string; bg: string; border: string }> = {
  success: { fg: '#047857', bg: '#ecfdf5', border: '#a7f3d0' },
  warning: { fg: '#b45309', bg: '#fffbeb', border: '#fde68a' },
  danger: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  info: { fg: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
};
const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const BRAND = '#6d28d9';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function section(title: string, body: string): string {
  if (!body) return '';
  return `<tr><td style="padding:8px 32px 20px">
${title ? `<p style="margin:0 0 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:${MUTED}">${escapeHtml(title)}</p>` : ''}
${body}
</td></tr>`;
}

function kvRows(rows: Array<[string, string | null | undefined]>): string {
  const visible = rows.filter(([, v]) => v != null && String(v).trim() !== '');
  if (!visible.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${visible.map(([label, value], i) => `<tr>
<td style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:13px;color:${MUTED};width:40%;vertical-align:top">${escapeHtml(label)}</td>
<td style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:14px;color:${INK};text-align:right;vertical-align:top;word-break:break-word">${value}</td>
</tr>`).join('')}
</table>`;
}

function callout(tone: Tone, html: string): string {
  const t = TONES[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
<td style="padding:14px 16px;background:${t.bg};border:1px solid ${t.border};border-radius:10px;font-size:14px;line-height:1.55;color:${INK}">${html}</td>
</tr></table>`;
}

/** Linha do tempo em três passos. `state` por passo: done | current | error | todo. */
function timeline(steps: Array<{ label: string; state: 'done' | 'current' | 'error' | 'todo' }>): string {
  const color = (s: string) => (s === 'done' ? TONES.success.fg : s === 'current' ? BRAND : s === 'error' ? TONES.danger.fg : '#d4d4d8');
  const mark = (s: string) => (s === 'done' ? '✓' : s === 'error' ? '✕' : s === 'current' ? '•' : '');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${steps.map((step) => `<td width="${Math.floor(100 / steps.length)}%" style="text-align:center;vertical-align:top;padding:0 4px">
<div style="margin:0 auto;width:28px;height:28px;border-radius:50%;background:${step.state === 'todo' ? '#ffffff' : color(step.state)};border:2px solid ${color(step.state)};color:#ffffff;font-size:14px;font-weight:700;line-height:28px">${mark(step.state)}</div>
<p style="margin:6px 0 0;font-size:12px;font-weight:${step.state === 'todo' ? 400 : 700};color:${step.state === 'todo' ? MUTED : color(step.state)}">${escapeHtml(step.label)}</p>
</td>`).join('')}
</tr></table>`;
}

function stepsFor(event: PayoutEmailEvent, c: (typeof COPY)[Lang]) {
  const [requested, approved, sent] = c.steps;
  switch (event) {
    case 'requested':
      return [{ label: requested, state: 'done' as const }, { label: approved, state: 'current' as const }, { label: sent, state: 'todo' as const }];
    case 'approved':
      return [{ label: requested, state: 'done' as const }, { label: approved, state: 'done' as const }, { label: sent, state: 'current' as const }];
    case 'completed':
      return [{ label: requested, state: 'done' as const }, { label: approved, state: 'done' as const }, { label: sent, state: 'done' as const }];
    case 'rejected':
      return [{ label: requested, state: 'done' as const }, { label: c.rejectedStep, state: 'error' as const }, { label: sent, state: 'todo' as const }];
    case 'failed':
      return [{ label: requested, state: 'done' as const }, { label: approved, state: 'done' as const }, { label: c.failedStep, state: 'error' as const }];
  }
}

function renderEmail(o: {
  lang: Lang; tone: Tone; preheader: string; badge: string; title: string; intro: string;
  hero: { label: string; value: string; caption?: string }; sections: string[];
  primary: { label: string; href: string }; secondary?: { label: string; href: string }; footerNote: string; prefsUrl: string;
}): string {
  const t = TONES[o.tone];
  const why = o.lang === 'pt' ? 'Você recebe este e-mail porque vende com a Koopfy.' : o.lang === 'es' ? 'Recibes este correo porque vendes con Koopfy.' : 'You receive this email because you sell with Koopfy.';
  const rights = o.lang === 'pt' ? 'Todos os direitos reservados' : o.lang === 'es' ? 'Todos los derechos reservados' : 'All rights reserved';
  return `<!doctype html>
<html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(o.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:${FONT};-webkit-font-smoothing:antialiased">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${escapeHtml(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
<tr><td style="background:#0b0b12;padding:18px 32px">
<span style="font-size:18px;font-weight:800;letter-spacing:-.02em;color:#ffffff">Koopfy</span><span style="display:inline-block;width:7px;height:7px;margin-left:3px;border-radius:50%;background:#8b5cf6"></span>
</td></tr>
<tr><td style="padding:28px 32px 8px">
<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${t.bg};border:1px solid ${t.border};color:${t.fg};font-size:12px;font-weight:700">${escapeHtml(o.badge)}</span>
<h1 style="margin:14px 0 6px;font-size:22px;line-height:1.3;font-weight:700;color:${INK}">${escapeHtml(o.title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46">${escapeHtml(o.intro)}</p>
</td></tr>
<tr><td style="padding:16px 32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="padding:18px 20px;background:${t.bg};border:1px solid ${t.border};border-radius:12px">
<p style="margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${t.fg}">${escapeHtml(o.hero.label)}</p>
<p style="margin:6px 0 0;font-size:30px;line-height:1.15;font-weight:800;color:${INK}">${escapeHtml(o.hero.value)}</p>
${o.hero.caption ? `<p style="margin:6px 0 0;font-size:13px;color:#52525b">${o.hero.caption}</p>` : ''}
</td></tr></table>
</td></tr>
${o.sections.filter(Boolean).join('\n')}
<tr><td style="padding:8px 32px 28px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding:0 8px 8px 0"><a href="${escapeHtml(o.primary.href)}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:${BRAND};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700">${escapeHtml(o.primary.label)}</a></td>
${o.secondary ? `<td style="padding:0 0 8px"><a href="${escapeHtml(o.secondary.href)}" style="display:inline-block;padding:12px 20px;border-radius:10px;border:1px solid ${LINE};background:#ffffff;color:${INK};text-decoration:none;font-size:14px;font-weight:600">${escapeHtml(o.secondary.label)}</a></td>` : ''}
</tr></table>
</td></tr>
<tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid ${LINE}">
<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(o.footerNote)}</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(why)}</p>
<p style="margin:6px 0 0;font-size:11px;color:#a1a1aa">© ${new Date().getFullYear()} Koopfy · ${escapeHtml(rights)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export async function notifySellerPayout(
  sellerId: string | null | undefined,
  event: PayoutEmailEvent,
  info: PayoutEmailInfo,
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
    const c = COPY[lang];
    const e = c[event];
    const currency = info.currency || 'USD';
    const amount = money(info.amountCents, currency, lang);
    const fee = Number(info.feeCents) > 0 ? Number(info.feeCents) : 0;
    const dashboard = (process.env.SELLER_DASHBOARD_URL ?? 'https://app.koopfy.com').replace(/\/+$/, '');
    const supportEmail = String(process.env.PLATFORM_ALERT_EMAIL ?? 'support@koopfy.com').split(',')[0].trim() || 'support@koopfy.com';
    const holder = info.destination?.accountHolder ?? info.destination?.pixHolder ?? null;
    const shortId = info.payoutId ? String(info.payoutId).slice(0, 8).toUpperCase() : null;
    const firstName = String(seller.name ?? '').trim().split(/\s+/)[0];

    const sections = [
      section('', timeline(stepsFor(event, c))),
      ...((event === 'rejected' || event === 'failed')
        ? [section(c.reason, callout('danger', `${info.reason ? `<strong>${escapeHtml(info.reason)}</strong><br>` : ''}${c.balanceBack}`))]
        : []),
      section(c.details, kvRows([
        [c.method, methodLabel(info.method, lang) ? escapeHtml(methodLabel(info.method, lang)) : null],
        [c.destination, destinationLabel(info.destination) ? escapeHtml(destinationLabel(info.destination)) : null],
        [c.holder, holder ? escapeHtml(holder) : null],
        [c.fee, fee ? escapeHtml(money(fee, currency, lang)) : null],
        [c.net, fee ? `<strong>${escapeHtml(money(Math.max(0, info.amountCents - fee), currency, lang))}</strong>` : null],
        [c.payoutId, shortId ? `<span style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(shortId)}</span>` : null],
        [c.requestedAt, escapeHtml(dateTime(info.requestedAt, lang, seller.country))],
        [c.transferId, info.providerPayoutId ? `<span style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(info.providerPayoutId)}</span>` : null],
      ])),
      section(c.next, `<p style="margin:0;font-size:14px;line-height:1.6;color:${INK}">${escapeHtml(c.nextByEvent[event])}</p>`),
    ];

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: seller.email,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? process.env.PLATFORM_FROM_EMAIL ?? 'no-reply@koopfy.com',
        name: process.env.SENDGRID_FROM_NAME ?? 'Koopfy',
      },
      subject: e.subject(amount),
      html: renderEmail({
        lang,
        tone: e.tone,
        preheader: `${e.badge} · ${amount}${firstName ? ` · ${firstName}` : ''}`,
        badge: e.badge,
        title: e.title,
        intro: e.intro,
        hero: {
          label: c.hero,
          value: amount,
          caption: escapeHtml([methodLabel(info.method, lang), destinationLabel(info.destination)].filter(Boolean).join(' · ')),
        },
        sections,
        primary: { label: c.view, href: `${dashboard}/finance/transfers` },
        secondary: { label: c.support, href: `mailto:${supportEmail}${shortId ? `?subject=${encodeURIComponent(`${c.payoutId} ${shortId}`)}` : ''}` },
        footerNote: c.footer,
        prefsUrl: `${dashboard}/settings/notifications`,
      }),
    });
  } catch (error: any) {
    console.error(`[SellerMail] payout ${event} (seller ${sellerId}) falhou:`, error?.response?.body ?? error?.message ?? error);
  }
}
