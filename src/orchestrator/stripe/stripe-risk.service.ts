import { Injectable, OnModuleInit } from '@nestjs/common';
import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.client';
import { StripeAccountsService, StripeAccountRow } from './stripe-accounts.service';

// ============================================================================
// STRIPE RISK — governador de risco do pool
// ----------------------------------------------------------------------------
// Duas funções, uma tese.
//
//   1. PROBE (GET /v1/account, em ciclo). É o ÚNICO sinal confiável de que uma
//      conta standalone foi restringida. A Stripe não manda webhook dizendo
//      "restringi você" — ela para de aceitar cobrança e você descobre pelo
//      primeiro comprador que reclama. O probe transforma isso em detecção em
//      minutos, e a conta sai do pool antes de queimar conversão.
//
//   2. JANELA DE RISCO (30d, por conta). Taxa de disputa e de fraude por
//      titular, com quarentena automática nos limiares.
//
// ⚠️ A TESE, DITA SEM ENFEITE. Rotear volume entre titulares NÃO baixa taxa de
// disputa. Disputa chega de 2 a 8 semanas depois da venda: quando a taxa sobe,
// o dano já está feito, e tirar volume da conta hoje PIORA a razão — o
// numerador continua chegando das vendas antigas e o denominador congela.
//
// O que este serviço faz é outra coisa, e é o que de fato protege:
//   • limita EXPOSIÇÃO — quanto dinheiro de quanto titular fica preso quando
//     uma conta congela (rampa + teto diário + quarentena);
//   • preserva CONTINUIDADE — a operação segue de pé com as contas saudáveis,
//     e o failover cross-PSP cobre o caso de o pool inteiro cair;
//   • dá TEMPO DE REAÇÃO — o alerta chega no WATCH, semanas antes do limiar da
//     bandeira, quando ainda dá para consertar a origem.
//
// Taxa de disputa se corrige na ORIGEM: descriptor que o comprador reconhece,
// entrega comprovável, reembolso sem atrito, oferta que entrega o que promete.
// Nenhuma linha de roteamento substitui isso — e o roteamento que tenta
// substituir isso é exatamente o que a Stripe classifica como evasão.
// ============================================================================

// ── Limiares ────────────────────────────────────────────────────────────────
//
// Referência das bandeiras (contagem de disputas ÷ contagem de vendas):
//   • Visa VDMP "standard": 0,9% + 100 disputas no mês
//   • Mastercard ECP:       1,5% + 100 disputas no mês
//   • A Stripe age MUITO antes disso — revisões costumam começar perto de 0,75%
//
// Por isso os limiares daqui são deliberadamente conservadores: quando a conta
// bate o número da bandeira, já é tarde. WATCH existe para avisar enquanto
// ainda há o que fazer.
const DISPUTE_RATE_WATCH      = 0.0040;  // 0,40% — alerta
const DISPUTE_RATE_THROTTLE   = 0.0065;  // 0,65% — reduz exposição nova
const DISPUTE_RATE_QUARANTINE = 0.0090;  // 0,90% — fora do pool

// Early Fraud Warnings (TC40 da Visa, chegam ANTES da disputa). É o indicador
// mais antecipado que existe — e o único que chega a tempo de o roteamento
// ainda importar.
const EFW_RATE_WATCH      = 0.0030;
const EFW_RATE_QUARANTINE = 0.0075;

// Taxa sobre amostra pequena é ruído: 2 disputas em 15 vendas dá 13% e não
// significa nada. Abaixo da amostra mínima, o gatilho é a CONTAGEM ABSOLUTA.
const MIN_SAMPLE = 100;
const ABSOLUTE_DISPUTE_FLOOR = 5;

// Cooldown aplicado no THROTTLE. Não resolve a taxa (ver o bloco acima) —
// limita quanto dinheiro novo entra numa conta que pode congelar.
const THROTTLE_COOLDOWN_HOURS = 12;

const RISK_WINDOW_DAYS = 30;

// ── Anomalia de volume ──────────────────────────────────────────────────────
//
// 3x sobre a média de 14 dias é deliberadamente sensível: o custo de um alerta
// a mais é ler uma linha de log; o custo de um a menos é descobrir o pico pela
// carta de review. Duas semanas de linha de base absorvem sazonalidade de fim
// de semana sem diluir um pico real.
const VOLUME_BASELINE_DAYS = 14;
const VOLUME_SPIKE_MULTIPLIER = 3;
// Abaixo disto a média não significa nada e a rampa já governa o volume.
const VOLUME_MIN_BASELINE_DAYS = 5;
// Avisa antes de estourar: atualizar a declaração é fácil, explicar o estouro não.
const VOLUME_DECLARED_WARN_PCT = 0.80;
const TICKET_DEVIATION_MULTIPLIER = 2.5;

// Motivos de `requirements.disabled_reason` que significam restrição real.
// `requirements.past_due` e `pending_verification` NÃO entram: são pendências
// de documento, resolvem-se sozinhas e quarentenar por elas tira do ar uma
// conta que está funcionando.
const DISABLED_REASONS_FATAL = [
  'rejected.fraud',
  'rejected.terms_of_service',
  'rejected.listed',
  'rejected.other',
  'platform_paused',
  'under_review',
  'listed',
];

export type RiskTier = 'OK' | 'WATCH' | 'THROTTLE' | 'QUARANTINE';

export interface RiskWindow {
  accountId: string;
  paidCount: number;
  paidVolumeUsdCents: number;
  disputeCount: number;
  efwCount: number;
  refundCount: number;
  reviewCount: number;
  disputeRate: number;
  efwRate: number;
  refundRate: number;
  tier: RiskTier;
  reason: string;
  // Amostra insuficiente para taxa — o tier veio da contagem absoluta.
  lowSample: boolean;
}

@Injectable()
export class StripeRiskService implements OnModuleInit {
  constructor(private readonly accounts: StripeAccountsService) { }

  private tiers = new Map<string, RiskWindow>();

  private readonly PROBE_INTERVAL_MS = 5 * 60 * 1000;
  private readonly RISK_INTERVAL_MS = 15 * 60 * 1000;
  // De hora em hora: o pico precisa ser visto no MESMO dia para dar tempo de
  // avisar a Stripe, mas não melhora sendo recalculado a cada 15 minutos.
  private readonly VOLUME_INTERVAL_MS = 60 * 60 * 1000;

  onModuleInit() {
    // Primeira volta com atraso: subir a aplicação e imediatamente disparar N
    // chamadas à Stripe atrasa o boot e, num restart em loop, vira rate limit.
    setTimeout(() => void this.probeAll(), 20_000);
    setTimeout(() => void this.evaluatePool(), 45_000);

    setTimeout(() => void this.detectVolumeAnomalies(), 70_000);

    setInterval(() => void this.probeAll(), this.PROBE_INTERVAL_MS);
    setInterval(() => void this.evaluatePool(), this.RISK_INTERVAL_MS);
    setInterval(() => void this.detectVolumeAnomalies(), this.VOLUME_INTERVAL_MS);
  }

  // ─────────────────────────────────────────────
  // PROBE — GET /v1/account por conta
  // ─────────────────────────────────────────────

  async probeAll(): Promise<void> {
    const rows = await this.accounts.listOperational();
    if (rows.length === 0) return;

    // Sequencial de propósito. São poucas contas e o probe não é urgente;
    // paralelizar só aumenta a chance de bater rate limit da Stripe com
    // chaves diferentes vindas do mesmo IP — que é, ele mesmo, um sinal de
    // linkage que preferimos não emitir de graça.
    for (const row of rows) {
      try {
        await this.probeOne(row);
      } catch (err: any) {
        console.error(`[StripeRisk] probe ${row.id} falhou:`, err?.message);
      }
    }
  }

  async probeOne(row: StripeAccountRow): Promise<void> {
    const secret = await this.accounts.getSecretKey(row.id);
    if (!secret) {
      await this.accounts.quarantine(row.id, 'secret_key ausente ou indecifrável');
      return;
    }

    const stripe = this.clientFor(secret);

    let account: Stripe.Account;
    try {
      account = await stripe.accounts.retrieve();
    } catch (err: any) {
      const code = err?.code ?? err?.raw?.code;
      const status = err?.statusCode ?? err?.raw?.statusCode;

      // Chave revogada / conta encerrada. É o sinal mais definitivo que existe:
      // a Stripe não devolve 401 por instabilidade. Quarentena imediata.
      if (status === 401 || code === 'api_key_expired' || code === 'account_invalid') {
        await this.accounts.quarantine(
          row.id,
          `credencial recusada pela Stripe (${code ?? status}) — chave revogada ou conta encerrada`,
        );
        return;
      }

      // Qualquer outra coisa é instabilidade. NÃO quarentena: derrubar o pool
      // inteiro porque a Stripe teve 30s de 5xx é transformar um incidente
      // deles num incidente nosso.
      console.warn(`[StripeRisk] probe ${row.id}: erro transitório (${status ?? '?'} ${code ?? ''})`);
      return;
    }

    const disabledReason = account.requirements?.disabled_reason ?? null;

    await this.accounts.saveProbe(row.id, {
      stripe_account_id: account.id,
      charges_enabled: account.charges_enabled ?? null,
      payouts_enabled: account.payouts_enabled ?? null,
      disabled_reason: disabledReason,
      requirements: account.requirements ?? {},
    });

    const fatal = disabledReason
      ? DISABLED_REASONS_FATAL.some(r => disabledReason.startsWith(r))
      : false;

    // charges_enabled=false é a restrição concreta — o momento exato em que a
    // conta parou de poder cobrar. Não espera limiar nenhum.
    if (account.charges_enabled === false || fatal) {
      await this.accounts.quarantine(
        row.id,
        `Stripe restringiu a conta (charges_enabled=${account.charges_enabled}, `
        + `disabled_reason=${disabledReason ?? 'null'})`,
      );
      return;
    }

    // Payout bloqueado com cobrança liberada: o dinheiro entra e não sai.
    // Não tira do pool — tirar aumentaria o prejuízo do titular, que já tem
    // saldo preso — mas é o alerta que precede o congelamento na maioria
    // dos casos, e ninguém olha o painel da Stripe de conta que "está bem".
    if (account.payouts_enabled === false) {
      console.error(
        `[StripeRisk] ⚠️ ${row.id} (${row.holder_legal_name ?? 'titular não identificado'}): `
        + 'PAYOUTS BLOQUEADOS com cobrança ainda liberada. O saldo está preso. '
        + `disabled_reason=${disabledReason ?? 'null'}. `
        + 'Verifique requirements.currently_due antes que vire restrição de cobrança.',
      );
    }

    // Conta quarentenada que voltou a aceitar cobrança: libera. É o único
    // caminho automático de volta ao pool, e de propósito ele exige que a
    // PRÓPRIA Stripe diga que está tudo certo — nunca "parou de dar erro".
    if (row.quarantined_at && account.charges_enabled === true && !fatal) {
      await this.accounts.release(
        row.id,
        'probe confirmou charges_enabled=true e nenhum disabled_reason fatal',
      );
    }
  }

  // ─────────────────────────────────────────────
  // JANELA DE RISCO
  // ─────────────────────────────────────────────

  async evaluatePool(): Promise<void> {
    const { data, error } = await supabase.rpc('stripe_pool_risk_window', {
      p_days: RISK_WINDOW_DAYS,
    });

    if (error) {
      console.error('[StripeRisk] stripe_pool_risk_window error:', error.message);
      return;
    }

    for (const row of (data ?? []) as any[]) {
      const window = this.classify({
        accountId: String(row.account_id),
        paidCount: Number(row.paid_count ?? 0),
        paidVolumeUsdCents: Number(row.paid_volume_usd_cents ?? 0),
        disputeCount: Number(row.dispute_count ?? 0),
        efwCount: Number(row.efw_count ?? 0),
        refundCount: Number(row.refund_count ?? 0),
        reviewCount: Number(row.review_count ?? 0),
      });

      this.tiers.set(window.accountId, window);
      await this.act(window);
    }
  }

  private classify(m: {
    accountId: string;
    paidCount: number;
    paidVolumeUsdCents: number;
    disputeCount: number;
    efwCount: number;
    refundCount: number;
    reviewCount: number;
  }): RiskWindow {
    const denom = Math.max(m.paidCount, 1);
    const disputeRate = m.disputeCount / denom;
    const efwRate = m.efwCount / denom;
    const refundRate = m.refundCount / denom;
    const lowSample = m.paidCount < MIN_SAMPLE;

    let tier: RiskTier = 'OK';
    let reason = 'dentro dos limiares';

    if (lowSample) {
      // Amostra pequena: a taxa não diz nada, a contagem diz. Cinco disputas em
      // menos de 100 vendas é um problema de oferta, não estatística.
      if (m.disputeCount >= ABSOLUTE_DISPUTE_FLOOR) {
        tier = 'QUARANTINE';
        reason = `${m.disputeCount} disputas em apenas ${m.paidCount} vendas `
          + '(amostra pequena, contagem absoluta)';
      } else if (m.disputeCount > 0 || m.efwCount > 0) {
        tier = 'WATCH';
        reason = `${m.disputeCount} disputa(s) e ${m.efwCount} EFW em ${m.paidCount} vendas `
          + '(amostra abaixo de ' + MIN_SAMPLE + ' — taxa ainda não é confiável)';
      }
      return { ...m, disputeRate, efwRate, refundRate, tier, reason, lowSample };
    }

    if (disputeRate >= DISPUTE_RATE_QUARANTINE || efwRate >= EFW_RATE_QUARANTINE) {
      tier = 'QUARANTINE';
      reason = `disputa ${(disputeRate * 100).toFixed(2)}% / EFW ${(efwRate * 100).toFixed(2)}% `
        + 'em faixa de programa de monitoramento das bandeiras';
    } else if (disputeRate >= DISPUTE_RATE_THROTTLE) {
      tier = 'THROTTLE';
      reason = `disputa ${(disputeRate * 100).toFixed(2)}% acima de `
        + `${(DISPUTE_RATE_THROTTLE * 100).toFixed(2)}%`;
    } else if (disputeRate >= DISPUTE_RATE_WATCH || efwRate >= EFW_RATE_WATCH) {
      tier = 'WATCH';
      reason = `disputa ${(disputeRate * 100).toFixed(2)}% / EFW ${(efwRate * 100).toFixed(2)}% `
        + 'em tendência de alta';
    }

    return { ...m, disputeRate, efwRate, refundRate, tier, reason, lowSample };
  }

  private async act(w: RiskWindow): Promise<void> {
    if (w.tier === 'OK') return;

    const head = `[StripeRisk] ${w.accountId} → ${w.tier}: ${w.reason} `
      + `(${w.disputeCount} disputas / ${w.efwCount} EFW / ${w.paidCount} vendas em ${RISK_WINDOW_DAYS}d)`;

    if (w.tier === 'QUARANTINE') {
      await this.accounts.quarantine(w.accountId, w.reason);
      return;
    }

    if (w.tier === 'THROTTLE') {
      const until = new Date(Date.now() + THROTTLE_COOLDOWN_HOURS * 3_600_000);
      await this.accounts.setCooldown(w.accountId, until, w.reason);
      console.error(
        head + '\n'
        + '  → cooldown aplicado. Isto NÃO baixa a taxa: as disputas que vão chegar '
        + 'são de vendas já feitas. Serve para limitar quanto dinheiro novo entra '
        + 'numa conta que pode congelar. A taxa só cai consertando a origem '
        + '(descriptor, entrega, política de reembolso, promessa da oferta).',
      );
      return;
    }

    console.warn(
      head + '\n'
      + '  → ainda no pool. Esta é a janela útil para agir: no limiar seguinte a '
      + 'conta sai, e no limiar da bandeira a decisão não é mais sua.',
    );
  }

  // ─────────────────────────────────────────────
  // ANOMALIA DE VOLUME — a causa nº1 de review, e a que nada acima cobre
  //
  // O teto diário impede ULTRAPASSAR um limite. Isto é outra coisa: detecta o
  // volume de hoje SAIR DO PADRÃO da própria conta, e o acumulado do mês
  // divergir do que foi DECLARADO à Stripe na abertura.
  //
  // Por que importa mais do que parece: para o modelo de risco da Stripe, uma
  // conta que declarou 20 mil/mês e faz 300 mil não é uma conta de sucesso — é
  // indistinguível de uma conta aberta com uma história e usada para outra. E
  // um pico de 5x num dia dispara review sozinho, por mais legítimo que seja,
  // porque o modelo não sabe que você lançou campanha.
  //
  // ⚠️ O VALOR DISTO É O AVISO, NÃO O BLOQUEIO. Detectar o pico antes da Stripe
  // te dá a chance de avisá-los ANTES — e campanha comunicada com antecedência
  // é a diferença entre uma conversa e uma retenção. Por isso o alerta é alto e
  // não há ação automática: cortar volume legítimo custaria mais que o risco.
  // ─────────────────────────────────────────────

  async detectVolumeAnomalies(): Promise<void> {
    const rows = await this.accounts.listOperational();

    for (const row of rows) {
      if (row.quarantined_at) continue;

      const { data, error } = await supabase.rpc('stripe_account_volume_baseline', {
        p_account_id: row.id,
        p_baseline_days: VOLUME_BASELINE_DAYS,
      });

      if (error) {
        console.error('[StripeRisk] volume_baseline error:', error.message);
        continue;
      }

      const m = Array.isArray(data) ? data[0] : data;
      if (!m) continue;

      const hoje = Number(m.today_usd_cents ?? 0);
      const base = Number(m.baseline_daily_usd_cents ?? 0);
      const diasComVenda = Number(m.baseline_days_with_sales ?? 0);
      const mtd = Number(m.mtd_usd_cents ?? 0);
      const ticketMtd = Number(m.mtd_avg_ticket_usd_cents ?? 0);

      // ── Pico diário ──
      // Exige histórico mínimo: 3x sobre a média de dois dias de operação é
      // ruído de conta nova, não anomalia. E a rampa de aquecimento já governa
      // o volume nessa fase.
      if (diasComVenda >= VOLUME_MIN_BASELINE_DAYS && base > 0) {
        const mult = hoje / base;
        if (mult >= VOLUME_SPIKE_MULTIPLIER) {
          console.error(
            `[StripeRisk] 📈 PICO DE VOLUME em ${row.id}: hoje ${Math.round(hoje / 100)} USD `
            + `contra média de ${Math.round(base / 100)} USD nos últimos ${diasComVenda} dias `
            + `(${mult.toFixed(1)}x).\n`
            + '  → Se for campanha, AVISE a Stripe hoje. Pico comunicado antes é conversa; '
            + 'pico descoberto por eles é review — e review com saldo alto vira retenção.',
          );
        }
      }

      // ── Acumulado do mês contra o declarado ──
      const declarado = row.declared_monthly_volume_usd_cents;
      if (declarado != null && declarado > 0) {
        const pct = mtd / declarado;

        if (pct >= 1) {
          console.error(
            `[StripeRisk] 🚨 VOLUME DECLARADO ULTRAPASSADO em ${row.id}: `
            + `${Math.round(mtd / 100)} USD no mês contra ${Math.round(declarado / 100)} USD `
            + `declarados (${Math.round(pct * 100)}%).\n`
            + '  → Atualize o volume declarado com a Stripe. Operar muito acima do declarado '
            + 'é misrepresentation na leitura deles, e é o gatilho de review mais comum '
            + 'que existe — mesmo quando o crescimento é totalmente legítimo.',
          );
        } else if (pct >= VOLUME_DECLARED_WARN_PCT) {
          console.warn(
            `[StripeRisk] ${row.id}: ${Math.round(pct * 100)}% do volume declarado `
            + `no mês (${Math.round(mtd / 100)}/${Math.round(declarado / 100)} USD). `
            + 'Vale revisar a declaração antes de estourar.',
          );
        }
      }

      // ── Ticket médio ──
      // Ticket muito acima do declarado muda o perfil de risco da conta: outro
      // público, outra taxa de disputa, outro tipo de fraude. A Stripe reage a
      // isso separadamente do volume.
      const ticketDeclarado = row.declared_avg_ticket_usd_cents;
      if (ticketDeclarado != null && ticketDeclarado > 0 && ticketMtd > 0) {
        const desvio = ticketMtd / ticketDeclarado;
        if (desvio >= TICKET_DEVIATION_MULTIPLIER || desvio <= 1 / TICKET_DEVIATION_MULTIPLIER) {
          console.warn(
            `[StripeRisk] ${row.id}: ticket médio do mês ${Math.round(ticketMtd / 100)} USD `
            + `contra ${Math.round(ticketDeclarado / 100)} USD declarados (${desvio.toFixed(1)}x). `
            + 'Perfil de risco diferente do que foi underwritten.',
          );
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  // Consulta em memória — usada pelo provider para decidir política 3DS.
  // ─────────────────────────────────────────────

  tierOf(accountId: string): RiskTier {
    return this.tiers.get(accountId)?.tier ?? 'OK';
  }

  windowOf(accountId: string): RiskWindow | null {
    return this.tiers.get(accountId) ?? null;
  }

  snapshot(): RiskWindow[] {
    return [...this.tiers.values()].sort((a, b) => b.disputeRate - a.disputeRate);
  }

  // ─────────────────────────────────────────────
  // POLÍTICA DE 3DS
  //
  // 3DS transfere a responsabilidade da fraude para o emissor — a disputa por
  // "não fui eu" deixa de contar contra a conta. O custo é conversão: exigir em
  // tudo derruba aprovação. Por isso a regra é escalonada e não binária.
  //
  // Devolve o valor de payment_method_options.card.request_three_d_secure.
  // 'automatic' deixa a Stripe decidir (o padrão, e o certo na maior parte).
  // ─────────────────────────────────────────────

  requestThreeDSecure(args: {
    accountId: string;
    amountUsdCents?: number;
    riskLevel?: string;
  }): 'any' | 'automatic' {
    const tier = this.tierOf(args.accountId);

    // Conta sob pressão: força 3DS em tudo. Perder alguma conversão é melhor
    // que perder a conta — e neste tier a conta está a um passo de sair.
    if (tier === 'THROTTLE' || tier === 'QUARANTINE') return 'any';

    // Em WATCH, força só no ticket alto: é onde a disputa dói e onde o
    // comprador tolera o atrito extra.
    if (tier === 'WATCH' && (args.amountUsdCents ?? 0) >= 150_00) return 'any';

    if (String(args.riskLevel ?? '').toUpperCase() === 'HIGH') return 'any';

    return 'automatic';
  }

  // ─────────────────────────────────────────────
  // Registro de evento de risco (chamado pelo webhook)
  //
  // A PK da tabela é o id do objeto na Stripe, então reentrega não conta duas
  // vezes no numerador — o dedupe é a própria chave, não um if.
  // ─────────────────────────────────────────────

  async recordRiskEvent(args: {
    id: string;
    accountId: string;
    kind: 'dispute' | 'early_fraud_warning' | 'review' | 'refund' | 'payout_failed';
    reason?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    chargeId?: string | null;
    paymentIntentId?: string | null;
    transactionId?: string | null;
    payload?: any;
  }): Promise<void> {
    const { error } = await supabase.from('stripe_risk_events').insert({
      id: args.id,
      account_id: args.accountId,
      kind: args.kind,
      reason: args.reason ?? null,
      amount_cents: args.amountCents ?? null,
      currency: args.currency ?? null,
      charge_id: args.chargeId ?? null,
      payment_intent_id: args.paymentIntentId ?? null,
      transaction_id: args.transactionId ?? null,
      payload: args.payload ?? {},
    });

    if (error) {
      if ((error as any).code === '23505') return;  // reentrega, já contado
      console.error('[StripeRisk] recordRiskEvent error:', error.message);
      return;
    }

    console.warn(
      `[StripeRisk] ${args.kind.toUpperCase()} em ${args.accountId}: `
      + `${args.reason ?? 'sem motivo informado'} (${args.amountCents ?? '?'} ${args.currency ?? ''})`,
    );

    // Disputa e EFW reavaliam na hora. Esperar os 15 min do ciclo é aceitável
    // para a estatística e não é para o caso em que a conta acabou de cruzar o
    // limiar — a próxima venda já não deveria ir para lá.
    if (args.kind === 'dispute' || args.kind === 'early_fraud_warning') {
      await this.evaluateOne(args.accountId);
    }
  }

  async evaluateOne(accountId: string): Promise<RiskWindow | null> {
    const { data, error } = await supabase.rpc('stripe_account_risk_window', {
      p_account_id: accountId,
      p_days: RISK_WINDOW_DAYS,
    });

    if (error) {
      console.error('[StripeRisk] stripe_account_risk_window error:', error.message);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    const window = this.classify({
      accountId,
      paidCount: Number(row.paid_count ?? 0),
      paidVolumeUsdCents: Number(row.paid_volume_usd_cents ?? 0),
      disputeCount: Number(row.dispute_count ?? 0),
      efwCount: Number(row.efw_count ?? 0),
      refundCount: Number(row.refund_count ?? 0),
      reviewCount: Number(row.review_count ?? 0),
    });

    this.tiers.set(accountId, window);
    await this.act(window);
    return window;
  }

  // ─────────────────────────────────────────────
  // Auditoria de linkage — a checagem que decide se o pool é pool de verdade.
  //
  // Roda sob demanda (CRM / boot). Duas contas ativas compartilhando descriptor,
  // e-mail de suporte, domínio ou conta bancária são, para a Stripe, a mesma
  // operação: ela vincula as contas sozinha e a restrição em uma alcança as
  // outras. Um pool assim não distribui risco nenhum — só distribui a ilusão.
  // ─────────────────────────────────────────────

  async auditLinkage(): Promise<Array<{ sinal: string; valor: string; contas: number; account_ids: string[] }>> {
    const { data, error } = await supabase.from('stripe_account_linkage_audit').select('*');

    if (error) {
      console.error('[StripeRisk] auditLinkage error:', error.message);
      return [];
    }

    const rows = (data ?? []) as any[];
    for (const r of rows) {
      console.error(
        `[StripeRisk] 🔗 LINKAGE: ${r.contas} contas ativas compartilham ${r.sinal}="${r.valor}" `
        + `(${(r.account_ids ?? []).join(', ')}). Para a Stripe isso é uma operação só — `
        + 'restrição numa alcança as outras.',
      );
    }
    return rows;
  }

  private clientFor(secretKey: string): Stripe {
    return new Stripe(secretKey, {
      apiVersion: '2023-10-16',
      // Retry só em erro de rede/5xx (o SDK não repete request não idempotente
      // sem chave de idempotência — ver stripe.provider.ts, que sempre manda).
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }
}
