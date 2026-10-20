// E-mails da conta e de saque para o vendedor.
//
// Conta: aprovada (pode vender e aceitar pagamentos, com métodos liberados,
// taxas e primeiros passos), desativada (motivo e o que muda) e reativada.
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

/**
 * Logo da Koopfy no cabeçalho escuro (texto branco + carrinho amarelo). PNG
 * porque Gmail e Outlook não mostram SVG. Com imagens bloqueadas, o alt
 * aparece em branco no lugar — o e-mail continua identificado.
 */
const KOOPFY_EMAIL_LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://app.koopfy.com/assets/images/logo-koopfy.png';
// Fundo do cabeçalho: roxo escuro em três camadas. `bgcolor` para o Outlook,
// background-color para o resto e a mesma cor como background-image, que o
// modo escuro do app do Gmail não inverte. Só com CSS o fundo some ou clareia,
// e a logo branca fica sem contraste.
const KOOPFY_EMAIL_HEADER_BG = '#1e1038';
const KOOPFY_EMAIL_HEADER_ATTRS = `bgcolor="${KOOPFY_EMAIL_HEADER_BG}" style="background-color:${KOOPFY_EMAIL_HEADER_BG};background-image:linear-gradient(${KOOPFY_EMAIL_HEADER_BG},${KOOPFY_EMAIL_HEADER_BG});padding:18px 32px"`;
const KOOPFY_EMAIL_LOGO_TAG = `<img src="${KOOPFY_EMAIL_LOGO_URL}" alt="Koopfy" width="115" height="28" style="display:block;border:0;outline:none;text-decoration:none;height:28px;width:115px;color:#ffffff;font-size:18px;font-weight:800">`;

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

function checklist(items: string[], mark = '✓'): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${items.map((item) => `<tr>
<td width="22" style="padding:5px 0;vertical-align:top;font-size:14px;color:${BRAND};font-weight:700">${mark}</td>
<td style="padding:5px 0;font-size:14px;line-height:1.5;color:${INK}">${item}</td>
</tr>`).join('')}
</table>`;
}

function pills(labels: string[]): string {
  return labels
    .map((label) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:6px 12px;border-radius:999px;background:#f4f4f5;border:1px solid ${LINE};font-size:13px;font-weight:600;color:${INK}">${escapeHtml(label)}</span>`)
    .join('');
}

function renderEmail(o: {
  lang: Lang; tone: Tone; preheader: string; badge: string; title: string; intro: string;
  hero?: { label: string; value: string; caption?: string }; sections: string[];
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
<tr><td ${KOOPFY_EMAIL_HEADER_ATTRS}>
${KOOPFY_EMAIL_LOGO_TAG}
</td></tr>
<tr><td style="padding:28px 32px 8px">
<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${t.bg};border:1px solid ${t.border};color:${t.fg};font-size:12px;font-weight:700">${escapeHtml(o.badge)}</span>
<h1 style="margin:14px 0 6px;font-size:22px;line-height:1.3;font-weight:700;color:${INK}">${escapeHtml(o.title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46">${escapeHtml(o.intro)}</p>
</td></tr>
${o.hero ? `<tr><td style="padding:16px 32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="padding:18px 20px;background:${t.bg};border:1px solid ${t.border};border-radius:12px">
<p style="margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${t.fg}">${escapeHtml(o.hero.label)}</p>
<p style="margin:6px 0 0;font-size:30px;line-height:1.15;font-weight:800;color:${INK}">${escapeHtml(o.hero.value)}</p>
${o.hero.caption ? `<p style="margin:6px 0 0;font-size:13px;color:#52525b">${o.hero.caption}</p>` : ''}
</td></tr></table>
</td></tr>` : '<tr><td style="padding:8px 32px 4px"></td></tr>'}
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

// ── Conta: aprovada, desativada, reativada ────────────────────────────────

export type AccountEmailEvent = 'approved' | 'suspended' | 'reactivated';

export interface AccountEmailInfo {
  reason?: string | null;
  enabledMethods?: string[] | null;
  /** Taxas aplicadas na aprovação (seller_fees): percentual, fixo em USD, prazos e reserva. */
  fees?: {
    fee_percentage?: number | null;
    fee_fixed_usd?: number | null;
    settlement_days?: number | null;
    reserve_percentage?: number | null;
    reserve_hold_days?: number | null;
  } | null;
}

const PAYMENT_METHOD_NAMES: Record<string, Record<Lang, string>> = {
  card: { pt: 'Cartão', es: 'Tarjeta', en: 'Card' },
  credit_card: { pt: 'Cartão de crédito', es: 'Tarjeta de crédito', en: 'Credit card' },
  debit_card: { pt: 'Cartão de débito', es: 'Tarjeta de débito', en: 'Debit card' },
  pix: { pt: 'Pix', es: 'Pix', en: 'Pix' },
  boleto: { pt: 'Boleto', es: 'Boleto', en: 'Boleto' },
  apple_pay: { pt: 'Apple Pay', es: 'Apple Pay', en: 'Apple Pay' },
  google_pay: { pt: 'Google Pay', es: 'Google Pay', en: 'Google Pay' },
  crypto: { pt: 'Cripto', es: 'Cripto', en: 'Crypto' },
  paypal: { pt: 'PayPal', es: 'PayPal', en: 'PayPal' },
  mbway: { pt: 'MB WAY', es: 'MB WAY', en: 'MB WAY' },
  mb_way: { pt: 'MB WAY', es: 'MB WAY', en: 'MB WAY' },
  multibanco: { pt: 'Multibanco', es: 'Multibanco', en: 'Multibanco' },
  ideal: { pt: 'iDEAL', es: 'iDEAL', en: 'iDEAL' },
  bancontact: { pt: 'Bancontact', es: 'Bancontact', en: 'Bancontact' },
  oxxo: { pt: 'OXXO', es: 'OXXO', en: 'OXXO' },
  spei: { pt: 'SPEI', es: 'SPEI', en: 'SPEI' },
  sepa: { pt: 'SEPA', es: 'SEPA', en: 'SEPA' },
  klarna: { pt: 'Klarna', es: 'Klarna', en: 'Klarna' },
};

const ACCOUNT_COPY: Record<Lang, {
  approved: { subject: string; badge: string; title: (name: string) => string; intro: string };
  suspended: { subject: string; badge: string; title: string; intro: string };
  reactivated: { subject: string; badge: string; title: string; intro: string };
  methods: string; conditions: string; fee: string; settlement: (days: number) => string; settlementLabel: string;
  reserve: (pct: string, days: number) => string; reserveLabel: string;
  firstSteps: string; steps: string[];
  reason: string; whatChanges: string; changes: string[]; howToFix: string; fixText: string;
  reactivatedNote: string;
  createProduct: string; openDashboard: string; support: string;
  footerApproved: string; footerAccount: string;
}> = {
  pt: {
    approved: {
      subject: '🎉 Conta aprovada — você já pode vender com a Koopfy',
      badge: 'Conta aprovada',
      title: (name) => (name ? `Tudo pronto, ${name}! Você já pode vender` : 'Tudo pronto! Você já pode vender'),
      intro: 'Sua conta de pagamentos foi aprovada. Seus checkouts já aceitam pagamentos e cada venda aprovada entra no seu saldo.',
    },
    suspended: {
      subject: 'Sua conta Koopfy foi desativada',
      badge: 'Conta desativada',
      title: 'Sua conta de pagamentos foi desativada',
      intro: 'Enquanto a conta estiver desativada, seus checkouts não aceitam novos pagamentos.',
    },
    reactivated: {
      subject: '✅ Sua conta Koopfy foi reativada',
      badge: 'Conta reativada',
      title: 'Você já pode vender de novo',
      intro: 'Sua conta de pagamentos foi reativada e seus checkouts voltaram a aceitar pagamentos.',
    },
    methods: 'Métodos de pagamento liberados',
    conditions: 'Suas condições',
    fee: 'Taxa por venda aprovada',
    settlementLabel: 'Saldo disponível para saque',
    settlement: (days) => (days <= 0 ? 'no mesmo dia da venda' : days === 1 ? '1 dia após a venda' : `${days} dias após a venda`),
    reserveLabel: 'Reserva de segurança',
    reserve: (pct, days) => `${pct} de cada venda, liberada após ${days} dias`,
    firstSteps: 'Primeiros passos',
    steps: [
      'Crie ou revise seus produtos (preço, imagens e descrição)',
      'Gere o link de checkout e faça uma compra de teste',
      'Configure seus pixels de anúncio e o domínio da loja',
      'Cadastre seus dados de saque para receber as vendas',
    ],
    reason: 'Motivo',
    whatChanges: 'O que muda',
    changes: [
      'Novos pagamentos ficam bloqueados nos seus checkouts',
      'Pedidos já concluídos não são afetados',
      'Para dúvidas sobre saldo e saques, fale com o suporte',
    ],
    howToFix: 'Como resolver',
    fixText: 'Fale com o suporte informando o motivo acima. Se precisar enviar documentos ou ajustar algo na conta, a equipe explica o próximo passo.',
    reactivatedNote: 'Confira se seus produtos, links de checkout e dados de saque continuam corretos antes de voltar a anunciar.',
    createProduct: 'Criar produto',
    openDashboard: 'Abrir painel',
    support: 'Falar com o suporte',
    footerApproved: 'Boas vendas! Qualquer dúvida, é só responder para o suporte.',
    footerAccount: 'Aviso sobre a sua conta — enviado sempre, não pode ser desligado.',
  },
  es: {
    approved: {
      subject: '🎉 Cuenta aprobada — ya puedes vender con Koopfy',
      badge: 'Cuenta aprobada',
      title: (name) => (name ? `¡Todo listo, ${name}! Ya puedes vender` : '¡Todo listo! Ya puedes vender'),
      intro: 'Tu cuenta de pagos fue aprobada. Tus checkouts ya aceptan pagos y cada venta aprobada entra en tu saldo.',
    },
    suspended: {
      subject: 'Tu cuenta Koopfy fue desactivada',
      badge: 'Cuenta desactivada',
      title: 'Tu cuenta de pagos fue desactivada',
      intro: 'Mientras la cuenta esté desactivada, tus checkouts no aceptan nuevos pagos.',
    },
    reactivated: {
      subject: '✅ Tu cuenta Koopfy fue reactivada',
      badge: 'Cuenta reactivada',
      title: 'Ya puedes vender de nuevo',
      intro: 'Tu cuenta de pagos fue reactivada y tus checkouts volvieron a aceptar pagos.',
    },
    methods: 'Métodos de pago habilitados',
    conditions: 'Tus condiciones',
    fee: 'Comisión por venta aprobada',
    settlementLabel: 'Saldo disponible para retiro',
    settlement: (days) => (days <= 0 ? 'el mismo día de la venta' : days === 1 ? '1 día después de la venta' : `${days} días después de la venta`),
    reserveLabel: 'Reserva de seguridad',
    reserve: (pct, days) => `${pct} de cada venta, liberada después de ${days} días`,
    firstSteps: 'Primeros pasos',
    steps: [
      'Crea o revisa tus productos (precio, imágenes y descripción)',
      'Genera el enlace de checkout y haz una compra de prueba',
      'Configura tus píxeles de anuncios y el dominio de la tienda',
      'Registra tus datos de retiro para recibir las ventas',
    ],
    reason: 'Motivo',
    whatChanges: 'Qué cambia',
    changes: [
      'Los nuevos pagos quedan bloqueados en tus checkouts',
      'Los pedidos ya completados no se ven afectados',
      'Para dudas sobre saldo y retiros, habla con soporte',
    ],
    howToFix: 'Cómo resolverlo',
    fixText: 'Habla con soporte indicando el motivo de arriba. Si hace falta enviar documentos o ajustar algo en la cuenta, el equipo te explica el siguiente paso.',
    reactivatedNote: 'Revisa que tus productos, enlaces de checkout y datos de retiro sigan correctos antes de volver a anunciar.',
    createProduct: 'Crear producto',
    openDashboard: 'Abrir panel',
    support: 'Hablar con soporte',
    footerApproved: '¡Buenas ventas! Cualquier duda, escribe a soporte.',
    footerAccount: 'Aviso sobre tu cuenta — siempre se envía, no se puede desactivar.',
  },
  en: {
    approved: {
      subject: '🎉 Account approved — you can start selling with Koopfy',
      badge: 'Account approved',
      title: (name) => (name ? `You're all set, ${name}! Start selling` : "You're all set! Start selling"),
      intro: 'Your payments account was approved. Your checkouts now accept payments and every approved sale goes to your balance.',
    },
    suspended: {
      subject: 'Your Koopfy account was deactivated',
      badge: 'Account deactivated',
      title: 'Your payments account was deactivated',
      intro: "While the account is deactivated, your checkouts don't accept new payments.",
    },
    reactivated: {
      subject: '✅ Your Koopfy account was reactivated',
      badge: 'Account reactivated',
      title: 'You can sell again',
      intro: 'Your payments account was reactivated and your checkouts accept payments again.',
    },
    methods: 'Enabled payment methods',
    conditions: 'Your terms',
    fee: 'Fee per approved sale',
    settlementLabel: 'Balance available for payout',
    settlement: (days) => (days <= 0 ? 'same day as the sale' : days === 1 ? '1 day after the sale' : `${days} days after the sale`),
    reserveLabel: 'Security reserve',
    reserve: (pct, days) => `${pct} of each sale, released after ${days} days`,
    firstSteps: 'First steps',
    steps: [
      'Create or review your products (price, images and description)',
      'Generate your checkout link and place a test purchase',
      'Set up your ad pixels and store domain',
      'Add your payout details to receive your sales',
    ],
    reason: 'Reason',
    whatChanges: 'What changes',
    changes: [
      'New payments are blocked on your checkouts',
      'Orders already completed are not affected',
      'For questions about balance and payouts, contact support',
    ],
    howToFix: 'How to fix it',
    fixText: "Contact support mentioning the reason above. If documents or account changes are needed, the team will explain the next step.",
    reactivatedNote: 'Check that your products, checkout links and payout details are still correct before advertising again.',
    createProduct: 'Create product',
    openDashboard: 'Open dashboard',
    support: 'Contact support',
    footerApproved: 'Happy selling! Any questions, just reach out to support.',
    footerAccount: 'Account notice — always sent, cannot be turned off.',
  },
};

function percent(value: number, lang: Lang): string {
  return `${new Intl.NumberFormat(localeOf(lang), { maximumFractionDigits: 2 }).format(value)}%`;
}

export async function notifySellerAccount(
  sellerId: string | null | undefined,
  event: AccountEmailEvent,
  info: AccountEmailInfo = {},
): Promise<void> {
  try {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey || !sellerId) {
      if (!apiKey) console.warn(`[SellerMail] account ${event}: SENDGRID_API_KEY ausente — e-mail não enviado.`);
      return;
    }
    const { data: seller } = await supabase
      .from('seller_profiles').select('email, name, country, enabled_methods').eq('id', sellerId).maybeSingle();
    if (!seller?.email) {
      console.warn(`[SellerMail] account ${event}: seller ${sellerId} sem e-mail.`);
      return;
    }

    const lang = languageFor(seller.country);
    const c = ACCOUNT_COPY[lang];
    const dashboard = (process.env.SELLER_DASHBOARD_URL ?? 'https://app.koopfy.com').replace(/\/+$/, '');
    const supportEmail = String(process.env.PLATFORM_ALERT_EMAIL ?? 'support@koopfy.com').split(',')[0].trim() || 'support@koopfy.com';
    const firstName = String(seller.name ?? '').trim().split(/\s+/)[0];
    const methods = (info.enabledMethods ?? seller.enabled_methods ?? []) as string[];
    const methodNames = [...new Set(methods.map((m) => {
      const key = String(m).toLowerCase();
      return PAYMENT_METHOD_NAMES[key]?.[lang] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
    }))];

    let subject: string;
    let html: string;

    if (event === 'approved') {
      const f = info.fees ?? {};
      const feeParts = [
        Number(f.fee_percentage) > 0 ? percent(Number(f.fee_percentage), lang) : null,
        Number(f.fee_fixed_usd) > 0 ? money(Math.round(Number(f.fee_fixed_usd) * 100), 'USD', lang) : null,
      ].filter(Boolean).join(' + ');
      subject = c.approved.subject;
      html = renderEmail({
        lang,
        tone: 'success',
        preheader: c.approved.intro,
        badge: c.approved.badge,
        title: c.approved.title(firstName),
        intro: c.approved.intro,
        sections: [
          methodNames.length ? section(c.methods, pills(methodNames)) : '',
          section(c.conditions, kvRows([
            [c.fee, feeParts ? `<strong>${escapeHtml(feeParts)}</strong>` : null],
            [c.settlementLabel, f.settlement_days != null ? escapeHtml(c.settlement(Number(f.settlement_days))) : null],
            [c.reserveLabel, Number(f.reserve_percentage) > 0
              ? escapeHtml(c.reserve(percent(Number(f.reserve_percentage), lang), Number(f.reserve_hold_days ?? 90)))
              : null],
          ])),
          section(c.firstSteps, checklist(c.steps.map((s) => escapeHtml(s)))),
        ],
        primary: { label: c.createProduct, href: `${dashboard}/products` },
        secondary: { label: c.openDashboard, href: dashboard },
        footerNote: c.footerApproved,
        prefsUrl: `${dashboard}/settings/notifications`,
      });
    } else if (event === 'suspended') {
      subject = c.suspended.subject;
      html = renderEmail({
        lang,
        tone: 'danger',
        preheader: c.suspended.intro,
        badge: c.suspended.badge,
        title: c.suspended.title,
        intro: c.suspended.intro,
        sections: [
          info.reason ? section(c.reason, callout('danger', `<strong>${escapeHtml(info.reason)}</strong>`)) : '',
          section(c.whatChanges, checklist(c.changes.map((s) => escapeHtml(s)), '•')),
          section(c.howToFix, `<p style="margin:0;font-size:14px;line-height:1.6;color:${INK}">${escapeHtml(c.fixText)}</p>`),
        ],
        primary: { label: c.support, href: `mailto:${supportEmail}?subject=${encodeURIComponent(c.suspended.badge)}` },
        secondary: { label: c.openDashboard, href: dashboard },
        footerNote: c.footerAccount,
        prefsUrl: `${dashboard}/settings/notifications`,
      });
    } else {
      subject = c.reactivated.subject;
      html = renderEmail({
        lang,
        tone: 'success',
        preheader: c.reactivated.intro,
        badge: c.reactivated.badge,
        title: c.reactivated.title,
        intro: c.reactivated.intro,
        sections: [
          methodNames.length ? section(c.methods, pills(methodNames)) : '',
          section('', callout('info', escapeHtml(c.reactivatedNote))),
        ],
        primary: { label: c.openDashboard, href: dashboard },
        footerNote: c.footerAccount,
        prefsUrl: `${dashboard}/settings/notifications`,
      });
    }

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: seller.email,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? process.env.PLATFORM_FROM_EMAIL ?? 'no-reply@koopfy.com',
        name: process.env.SENDGRID_FROM_NAME ?? 'Koopfy',
      },
      subject,
      html,
    });
  } catch (error: any) {
    console.error(`[SellerMail] account ${event} (seller ${sellerId}) falhou:`, error?.response?.body ?? error?.message ?? error);
  }
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

// ── Conta de pagamento conectada: verificação pendente e aprovada ─────────
//
// Sem nome do provedor: para o seller, é a verificação do Koopfy Payments (o
// formulário também fica embutido no painel). O botão leva direto a ele.

export type VerificationEmailEvent = 'verification_needed' | 'verified';

const VERIFICATION_COPY: Record<Lang, {
  needed: { subject: string; badge: string; title: (name: string) => string; intro: string };
  verified: { subject: string; badge: string; title: (name: string) => string; intro: string };
  prepare: string; items: string[]; tip: string; next: string; nextSteps: string[];
  continueCta: string; openCta: string; footer: string;
}> = {
  pt: {
    needed: {
      subject: 'Falta pouco para ativar seus recebimentos',
      badge: 'Ação necessária',
      title: (name) => (name ? `${name}, continue a verificação da sua conta` : 'Continue a verificação da sua conta'),
      intro: 'Para liberar os recebimentos no Koopfy Payments, precisamos que você conclua a verificação da sua empresa. Leva poucos minutos e é feita dentro do painel da Koopfy.',
    },
    verified: {
      subject: '✅ Conta verificada — seus recebimentos estão liberados',
      badge: 'Conta verificada',
      title: (name) => (name ? `Tudo certo, ${name}! Sua conta foi aprovada` : 'Tudo certo! Sua conta foi aprovada'),
      intro: 'A verificação da sua empresa e do responsável foi concluída. Sua conta de pagamento no Koopfy Payments está aprovada e pronta para receber.',
    },
    prepare: 'Tenha em mãos',
    items: ['EIN da sua LLC', 'Documento de identidade do responsável', 'Celular com câmera para a selfie'],
    tip: 'Se a verificação já estiver em andamento, é só abrir o painel e continuar de onde parou.',
    next: 'Próximos passos',
    nextSteps: ['Abra o Koopfy Payments no painel e confira sua conta', 'Com a conta ativa, suas próximas vendas são recebidas nela'],
    continueCta: 'Continuar verificação', openCta: 'Abrir Koopfy Payments',
    footer: 'Aviso da sua conta de pagamento — sempre enviado.',
  },
  es: {
    needed: {
      subject: 'Falta poco para activar tus cobros',
      badge: 'Acción necesaria',
      title: (name) => (name ? `${name}, continúa la verificación de tu cuenta` : 'Continúa la verificación de tu cuenta'),
      intro: 'Para habilitar los cobros en Koopfy Payments, necesitamos que completes la verificación de tu empresa. Toma pocos minutos y se hace dentro del panel de Koopfy.',
    },
    verified: {
      subject: '✅ Cuenta verificada — tus cobros están habilitados',
      badge: 'Cuenta verificada',
      title: (name) => (name ? `¡Listo, ${name}! Tu cuenta fue aprobada` : '¡Listo! Tu cuenta fue aprobada'),
      intro: 'La verificación de tu empresa y del responsable fue completada. Tu cuenta de pago en Koopfy Payments está aprobada y lista para recibir.',
    },
    prepare: 'Ten a mano',
    items: ['EIN de tu LLC', 'Documento de identidad del responsable', 'Celular con cámara para la selfie'],
    tip: 'Si la verificación ya está en curso, solo abre el panel y continúa donde la dejaste.',
    next: 'Próximos pasos',
    nextSteps: ['Abre Koopfy Payments en el panel y revisa tu cuenta', 'Con la cuenta activa, tus próximas ventas se reciben en ella'],
    continueCta: 'Continuar verificación', openCta: 'Abrir Koopfy Payments',
    footer: 'Aviso de tu cuenta de pago — siempre enviado.',
  },
  en: {
    needed: {
      subject: 'Almost there — finish activating your payouts',
      badge: 'Action needed',
      title: (name) => (name ? `${name}, continue your account verification` : 'Continue your account verification'),
      intro: 'To enable payments on Koopfy Payments, please finish verifying your business. It takes a few minutes and happens right inside the Koopfy dashboard.',
    },
    verified: {
      subject: '✅ Account verified — you are ready to get paid',
      badge: 'Account verified',
      title: (name) => (name ? `All set, ${name}! Your account is approved` : 'All set! Your account is approved'),
      intro: 'Your business and representative verification is complete. Your Koopfy Payments account is approved and ready to receive payments.',
    },
    prepare: 'Have ready',
    items: ["Your LLC's EIN", "Representative's ID document", 'A phone with a camera for the selfie'],
    tip: 'If you already started, just open the dashboard and pick up where you left off.',
    next: 'Next steps',
    nextSteps: ['Open Koopfy Payments in the dashboard and review your account', 'Once the account is active, your next sales are received in it'],
    continueCta: 'Continue verification', openCta: 'Open Koopfy Payments',
    footer: 'Payment account notice — always sent.',
  },
};

/** Devolve true só quando o e-mail saiu (quem chama registra o envio). Nunca lança. */
export async function notifySellerVerification(
  sellerId: string | null | undefined,
  event: VerificationEmailEvent,
): Promise<boolean> {
  try {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey || !sellerId) {
      if (!apiKey) console.warn(`[SellerMail] verification ${event}: SENDGRID_API_KEY ausente — e-mail não enviado.`);
      return false;
    }
    const { data: seller } = await supabase
      .from('seller_profiles').select('email, name, country').eq('id', sellerId).maybeSingle();
    if (!seller?.email) {
      console.warn(`[SellerMail] verification ${event}: seller ${sellerId} sem e-mail.`);
      return false;
    }

    const lang = languageFor(seller.country);
    const c = VERIFICATION_COPY[lang];
    const dashboard = (process.env.SELLER_DASHBOARD_URL ?? 'https://app.koopfy.com').replace(/\/+$/, '');
    const payments = process.env.CHECKOUT_PAYMENTS_URL ?? `${dashboard}/checkout/payments?modal=koopfy-payments`;
    const firstName = String(seller.name ?? '').trim().split(/\s+/)[0];
    const copy = event === 'verified' ? c.verified : c.needed;

    const html = renderEmail({
      lang,
      tone: event === 'verified' ? 'success' : 'warning',
      preheader: copy.intro,
      badge: copy.badge,
      title: copy.title(firstName),
      intro: copy.intro,
      sections: event === 'verified'
        ? [section(c.next, checklist(c.nextSteps.map((s) => escapeHtml(s))))]
        : [
          section(c.prepare, checklist(c.items.map((s) => escapeHtml(s)), '•')),
          section('', callout('info', escapeHtml(c.tip))),
        ],
      primary: { label: event === 'verified' ? c.openCta : c.continueCta, href: payments },
      footerNote: c.footer,
      prefsUrl: `${dashboard}/settings/notifications`,
    });

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: seller.email,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? process.env.PLATFORM_FROM_EMAIL ?? 'no-reply@koopfy.com',
        name: process.env.SENDGRID_FROM_NAME ?? 'Koopfy',
      },
      subject: copy.subject,
      html,
    });
    return true;
  } catch (error: any) {
    console.error(`[SellerMail] verification ${event} (seller ${sellerId}) falhou:`, error?.response?.body ?? error?.message ?? error);
    return false;
  }
}

// ── Roteamento de contas: conta pausada ───────────────────────────────────

export interface RoutingPauseEmailInfo {
  /** Nome que o seller reconhece (apelido, senão o nome da conta no provedor). */
  accountName: string;
  provider: string;
  disputes: number;
  approved: number;
  limitPct: number;
  /** Contas do mesmo grupo que continuam recebendo. */
  remaining: number;
}

const ROUTING_PAUSE_COPY: Record<Lang, {
  subject: (name: string) => string; badge: string; title: string; intro: (name: string) => string;
  why: string; disputes: string; limit: string; next: string;
  stillSelling: (n: number) => string; noneLeft: string; cta: string; footer: string;
}> = {
  pt: {
    subject: (name) => `Conta ${name} pausada no roteamento`,
    badge: 'Conta pausada',
    title: 'Uma conta saiu do roteamento',
    intro: (name) => `A conta ${name} passou do limite de disputas e parou de receber vendas novas. As vendas já feitas nela não mudam.`,
    why: 'Por que pausou',
    disputes: 'Disputas em 7 dias',
    limit: 'Limite',
    next: 'O que acontece agora',
    stillSelling: (n) => n === 1 ? 'A outra conta do grupo continua recebendo as vendas.' : `As outras ${n} contas do grupo continuam recebendo as vendas.`,
    noneLeft: 'Não há outra conta recebendo neste grupo: o checkout fica sem essa forma de pagamento até uma conta voltar. Conecte outra conta ou resolva as disputas.',
    cta: 'Abrir o roteamento',
    footer: 'A conta volta sozinha quando a taxa de disputas ficar abaixo do limite.',
  },
  es: {
    subject: (name) => `Cuenta ${name} pausada en el enrutamiento`,
    badge: 'Cuenta pausada',
    title: 'Una cuenta salió del enrutamiento',
    intro: (name) => `La cuenta ${name} superó el límite de disputas y dejó de recibir ventas nuevas. Las ventas ya hechas en ella no cambian.`,
    why: 'Por qué se pausó',
    disputes: 'Disputas en 7 días',
    limit: 'Límite',
    next: 'Qué pasa ahora',
    stillSelling: (n) => n === 1 ? 'La otra cuenta del grupo sigue recibiendo las ventas.' : `Las otras ${n} cuentas del grupo siguen recibiendo las ventas.`,
    noneLeft: 'No hay otra cuenta recibiendo en este grupo: el checkout queda sin esa forma de pago hasta que una cuenta vuelva. Conecta otra cuenta o resuelve las disputas.',
    cta: 'Abrir el enrutamiento',
    footer: 'La cuenta vuelve sola cuando la tasa de disputas quede por debajo del límite.',
  },
  en: {
    subject: (name) => `Account ${name} paused in routing`,
    badge: 'Account paused',
    title: 'An account left the routing',
    intro: (name) => `The account ${name} went over the dispute limit and stopped receiving new sales. Sales already made on it don't change.`,
    why: 'Why it was paused',
    disputes: 'Disputes in 7 days',
    limit: 'Limit',
    next: 'What happens now',
    stillSelling: (n) => n === 1 ? 'The other account in the group keeps receiving sales.' : `The other ${n} accounts in the group keep receiving sales.`,
    noneLeft: 'No other account is receiving in this group: the checkout loses this payment method until an account comes back. Connect another account or resolve the disputes.',
    cta: 'Open routing',
    footer: 'The account comes back on its own when the dispute rate drops below the limit.',
  },
};

/**
 * Avisa o seller que uma conta dele foi pausada por disputas. Sem isto ele só
 * descobre abrindo a tela — e, se era a única conta do grupo, descobre pelas
 * vendas que pararam. Nunca lança: o aviso não pode atrapalhar o roteamento.
 */
export async function notifySellerRoutingPause(
  sellerId: string | null | undefined,
  info: RoutingPauseEmailInfo,
): Promise<void> {
  try {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey || !sellerId) {
      if (!apiKey) console.warn('[SellerMail] routing pause: SENDGRID_API_KEY ausente — e-mail não enviado.');
      return;
    }
    const { data: seller } = await supabase
      .from('seller_profiles').select('email, name, country').eq('id', sellerId).maybeSingle();
    if (!seller?.email) {
      console.warn(`[SellerMail] routing pause: seller ${sellerId} sem e-mail.`);
      return;
    }

    const lang = languageFor(seller.country);
    const c = ROUTING_PAUSE_COPY[lang];
    const dashboard = (process.env.SELLER_DASHBOARD_URL ?? 'https://app.koopfy.com').replace(/\/+$/, '');
    const rate = info.approved > 0 ? (info.disputes / info.approved) * 100 : 0;
    const html = renderEmail({
      lang,
      tone: 'warning',
      preheader: c.intro(info.accountName),
      badge: c.badge,
      title: c.title,
      intro: c.intro(info.accountName),
      sections: [
        section(c.why, kvRows([
          [c.disputes, `${info.disputes} / ${info.approved} (${percent(rate, lang)})`],
          [c.limit, percent(info.limitPct, lang)],
        ])),
        section(c.next, callout(info.remaining > 0 ? 'info' : 'danger', escapeHtml(info.remaining > 0 ? c.stillSelling(info.remaining) : c.noneLeft))),
      ],
      primary: { label: c.cta, href: `${dashboard}/checkout/routing` },
      footerNote: c.footer,
      prefsUrl: `${dashboard}/settings/notifications`,
    });

    sgMail.setApiKey(apiKey);
    await sgMail.send({
      to: seller.email,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL ?? process.env.PLATFORM_FROM_EMAIL ?? 'no-reply@koopfy.com',
        name: process.env.SENDGRID_FROM_NAME ?? 'Koopfy',
      },
      subject: c.subject(info.accountName),
      html,
    });
  } catch (error: any) {
    console.error(`[SellerMail] routing pause (seller ${sellerId}) falhou:`, error?.response?.body ?? error?.message ?? error);
  }
}
