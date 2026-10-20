// Regras puras do roteamento de contas: estratégias com entradas
// determinísticas (métricas do dia e sorteio injetado), filtros, tetos,
// pausas automáticas, breaker, taxa e o que fica valendo ao desligar.

import {
  BREAKER_COOLDOWN_MS,
  MIN_SAMPLE,
  NEUTRAL_SCORE,
  RoutingCandidate,
  activePause,
  computeStats,
  defaultAccountConfig,
  disputeLimitExceeded,
  emptyStats,
  ineligibility,
  isTechnicalFailure,
  keptOnDisable,
  ownAccountCommissionUsdCents,
  ownProviderOfId,
  parseAccountPatch,
  scoreOf,
  selectAccount,
  accountsToReplace,
  connectionChoice,
  capReached,
  computeToday,
  effectiveDailyLimits,
  routingDayStartMs,
  warmupState,
} from './seller-routing';

type Partial2 = {
  config?: Partial<RoutingCandidate['config']>;
  stats?: Partial<RoutingCandidate['stats']>;
  chargeable?: boolean;
  breakerOpen?: boolean;
};

function acc(id: string, opts: Partial2 = {}): RoutingCandidate {
  const provider = ownProviderOfId(id) ?? 'stripe';
  return {
    id,
    provider,
    config: { ...defaultAccountConfig(id, 's-1', provider), ...(opts.config ?? {}) },
    stats: { ...emptyStats(), ...(opts.stats ?? {}) },
    chargeable: opts.chargeable ?? true,
    breakerOpen: opts.breakerOpen ?? false,
  };
}

/** Roda N escolhas seguidas, somando cada venda ao dia da conta escolhida. */
function simulate(strategy: any, accounts: RoutingCandidate[], n: number, amount = 1000, random = () => 0.5) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const chosen = selectAccount(strategy, accounts.filter(a => ineligibility(a, { amountUsdCents: amount }, 0.75) === null), { amountUsdCents: amount }, random);
    if (!chosen) break;
    counts[chosen.id] = (counts[chosen.id] ?? 0) + 1;
    chosen.stats.todayOrders += 1;
    chosen.stats.todayUsdCents += amount;
  }
  return counts;
}

describe('estratégias', () => {
  it('orders_split divide os PEDIDOS do dia pelo peso', () => {
    const a = acc('stripel_a', { config: { weight: 70 } });
    const b = acc('whopa_b', { config: { weight: 30 } });
    expect(simulate('orders_split', [a, b], 100)).toEqual({ stripel_a: 70, whopa_b: 30 });
  });

  it('orders_split parte do déficit do dia (quem está atrás recebe)', () => {
    const a = acc('stripel_a', { config: { weight: 50 }, stats: { todayOrders: 10 } });
    const b = acc('stripel_b', { config: { weight: 50 }, stats: { todayOrders: 2 } });
    expect(selectAccount('orders_split', [a, b], {})?.id).toBe('stripel_b');
  });

  it('peso 0 deixa a conta só de reserva', () => {
    const a = acc('stripel_a', { config: { weight: 0 } });
    const b = acc('stripel_b', { config: { weight: 10 } });
    expect(simulate('orders_split', [a, b], 5)).toEqual({ stripel_b: 5 });
  });

  it('revenue_split divide o FATURAMENTO (USD), não a contagem', () => {
    // A já faturou 900 hoje em uma venda; B, 100 em outra. Pesos iguais:
    // a próxima venda de 500 vai para B (déficit de faturamento), mesmo com
    // os dois empatados em pedidos.
    const a = acc('stripel_a', { stats: { todayOrders: 1, todayUsdCents: 900 } });
    const b = acc('stripel_b', { stats: { todayOrders: 1, todayUsdCents: 100 } });
    expect(selectAccount('revenue_split', [a, b], { amountUsdCents: 500 })?.id).toBe('stripel_b');
    expect(selectAccount('orders_split', [a, b], { amountUsdCents: 500 })?.id).toBe('stripel_a');

    const c = acc('stripel_c', { config: { weight: 75 } });
    const d = acc('stripel_d', { config: { weight: 25 } });
    const counts = simulate('revenue_split', [c, d], 40, 2500);
    expect(c.stats.todayUsdCents).toBe(75000);
    expect(d.stats.todayUsdCents).toBe(25000);
    expect(counts).toEqual({ stripel_c: 30, stripel_d: 10 });
  });

  it('priority_cap: cascata por prioridade, cada conta até o seu teto', () => {
    const first = acc('whopl_biz_1', { config: { priority: 1, daily_cap_usd_cents: 3000 } });
    const second = acc('stripel_2', { config: { priority: 2, daily_cap_orders: 2 } });
    const third = acc('stripel_3', { config: { priority: 3 } });
    // 1000 por venda: a primeira leva 3 (teto 3000), a segunda 2 (teto de pedidos), o resto vai para a terceira.
    expect(simulate('priority_cap', [third, second, first], 7)).toEqual({ whopl_biz_1: 3, stripel_2: 2, stripel_3: 2 });
  });

  it('priority_cap: venda que não CABE no teto já vai para a próxima', () => {
    const first = acc('stripel_1', { config: { priority: 1, daily_cap_usd_cents: 10000 }, stats: { todayUsdCents: 9500 } });
    const second = acc('stripel_2', { config: { priority: 2 } });
    const ctx = { amountUsdCents: 1000 };
    const eligible = [first, second].filter(a => ineligibility(a, ctx, 0.75) === null);
    expect(selectAccount('priority_cap', eligible, ctx)?.id).toBe('stripel_2');
    // Venda pequena ainda cabe.
    const small = { amountUsdCents: 400 };
    expect(selectAccount('priority_cap', [first, second].filter(a => ineligibility(a, small, 0.75) === null), small)?.id).toBe('stripel_1');
  });

  it('score: proporcional ao score, não tudo para a melhor', () => {
    const good = acc('stripel_good', { config: { priority: 1 }, stats: { score: 80 } });
    const bad = acc('stripel_bad', { config: { priority: 2 }, stats: { score: 20 } });
    // Bilhetes: [0, 80) → good, [80, 100) → bad.
    expect(selectAccount('score', [good, bad], {}, () => 0.1)?.id).toBe('stripel_good');
    expect(selectAccount('score', [good, bad], {}, () => 0.79)?.id).toBe('stripel_good');
    expect(selectAccount('score', [good, bad], {}, () => 0.81)?.id).toBe('stripel_bad');

    // Sorteio uniforme em 100 passos: 80/20.
    let i = 0;
    const counts = simulate('score', [good, bad], 100, 1000, () => (i++ % 100) / 100);
    expect(counts).toEqual({ stripel_good: 80, stripel_bad: 20 });
  });

  it('sem conta elegível, nenhuma escolha', () => {
    expect(selectAccount('orders_split', [], {})).toBeNull();
  });
});

describe('score', () => {
  it('prior neutro sem amostra mínima', () => {
    expect(scoreOf({ approved7d: 5, failed7d: 2, disputes7d: 3 }, 0.75)).toBe(NEUTRAL_SCORE);
  });

  it('70% aprovação + 30% saúde de disputa', () => {
    // 90% de aprovação e nenhuma disputa: 0,7×0,9 + 0,3×1 = 0,93.
    expect(scoreOf({ approved7d: 90, failed7d: 10, disputes7d: 0 }, 0.75)).toBe(93);
    // 100% de aprovação e 0,5% de disputa com limite 0,75%: saúde 1/3 → 0,7 + 0,1 = 80.
    expect(scoreOf({ approved7d: 200, failed7d: 0, disputes7d: 1 }, 0.75)).toBe(80);
    // Disputa acima do limite zera só a parte de disputa; nunca abaixo de 1.
    expect(scoreOf({ approved7d: 20, failed7d: 0, disputes7d: 10 }, 0.75)).toBe(70);
    expect(scoreOf({ approved7d: 0, failed7d: 40, disputes7d: 0 }, 0.75)).toBe(30);
  });
});

describe('estatística de 7 dias', () => {
  it('aprovadas, recusadas, faturamento, estornos e disputas (status ou metadata)', () => {
    const stats = computeStats(
      [
        { provider_account_id: 'stripel_a', status: 'approved', amount_usd_gross_cents: 1000 },
        { provider_account_id: 'stripel_a', status: 'approved', amount_usd_gross_cents: '500', stripe_dispute: { id: 'dp_1' } },
        { provider_account_id: 'stripel_a', status: 'refunded', amount_usd_gross_cents: 300 },
        { provider_account_id: 'stripel_a', status: 'chargeback', amount_usd_gross_cents: 200 },
        { provider_account_id: 'stripel_a', status: 'failed', amount_usd_gross_cents: 999 },
        { provider_account_id: 'stripel_a', status: 'pending', amount_usd_gross_cents: 999 },
        { provider_account_id: 'outra', status: 'approved', amount_usd_gross_cents: 999 },
      ],
      ['stripel_a', 'stripel_b'],
      new Map([['stripel_a', { volume: 1500, paidCount: 2 }]]),
      0.75,
    );
    expect(stats.get('stripel_a')).toMatchObject({
      orders7d: 6,
      approved7d: 4,
      failed7d: 1,
      approvalRate: 0.8,
      revenueUsdCents7d: 2000,
      refunds7d: 1,
      disputes7d: 2,
      disputeRate: 0.5,
      todayOrders: 2,
      todayUsdCents: 1500,
      score: NEUTRAL_SCORE,
    });
    expect(stats.get('stripel_b')).toMatchObject({ orders7d: 0, approvalRate: null, disputeRate: null });
  });
});

describe('filtros e tetos', () => {
  it('país, moeda e faixa de valor (USD)', () => {
    const a = acc('stripel_a', {
      config: { countries: ['BR', 'PT'], currencies: ['BRL'], min_ticket_usd_cents: 500, max_ticket_usd_cents: 50000 },
    });
    expect(ineligibility(a, { country: 'br', currency: 'brl', amountUsdCents: 1000 }, 0.75)).toBeNull();
    expect(ineligibility(a, { country: 'US' }, 0.75)).toBe('country');
    expect(ineligibility(a, { currency: 'USD' }, 0.75)).toBe('currency');
    expect(ineligibility(a, { amountUsdCents: 100 }, 0.75)).toBe('ticket');
    expect(ineligibility(a, { amountUsdCents: 60000 }, 0.75)).toBe('ticket');
    // Na escolha da sessão o país/valor ainda podem ser desconhecidos: não barram.
    expect(ineligibility(a, {}, 0.75)).toBeNull();
  });

  it('teto de pedidos e de USD do dia', () => {
    const orders = acc('stripel_a', { config: { daily_cap_orders: 3 }, stats: { todayOrders: 3 } });
    expect(ineligibility(orders, {}, 0.75)).toBe('cap_orders');
    const usd = acc('stripel_b', { config: { daily_cap_usd_cents: 10000 }, stats: { todayUsdCents: 10000 } });
    expect(ineligibility(usd, {}, 0.75)).toBe('cap_usd');
    // O mesmo pedido (sticky) ignora o teto: recusa + nova tentativa não troca de conta.
    expect(ineligibility(usd, {}, 0.75, { ignoreCaps: true })).toBeNull();
  });

  it('conta sem credencial pronta não recebe', () => {
    expect(ineligibility(acc('stripel_a', { chargeable: false }), {}, 0.75)).toBe('not_chargeable');
  });
});

describe('pausas', () => {
  it('manual', () => {
    const a = acc('stripel_a', { config: { paused_at: '2026-09-28T10:00:00Z', pause_reason: 'manual' } });
    expect(ineligibility(a, {}, 0.75)).toBe('paused_manual');
  });

  it('disputas acima do limite pausam só com a amostra mínima de aprovadas', () => {
    const small = acc('stripel_a', { stats: { approved7d: MIN_SAMPLE - 1, disputes7d: 5 } });
    expect(disputeLimitExceeded(small.stats, 0.75)).toBe(false);
    expect(ineligibility(small, {}, 0.75)).toBeNull();

    const sample = acc('stripel_b', { stats: { approved7d: MIN_SAMPLE, disputes7d: 1 } }); // 5%
    expect(ineligibility(sample, {}, 0.75)).toBe('paused_disputes');
    // O limite é por seller (CRM): com 6%, 5% passa.
    expect(ineligibility(sample, {}, 6)).toBeNull();
    // Exatamente no limite não pausa (só ACIMA).
    expect(disputeLimitExceeded({ approved7d: 400, disputes7d: 3 }, 0.75)).toBe(false);
    expect(disputeLimitExceeded({ approved7d: 400, disputes7d: 4 }, 0.75)).toBe(true);
  });

  it('breaker: aberto em memória ou pausa gravada dentro do cooldown; volta sozinha', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(ineligibility(acc('stripel_a', { breakerOpen: true }), {}, 0.75, { now })).toBe('paused_errors');

    const recent = acc('stripel_b', { config: { paused_at: new Date(now - 60_000).toISOString(), pause_reason: 'errors' } });
    expect(activePause(recent, 0.75, now)).toBe('errors');
    const old = acc('stripel_c', { config: { paused_at: new Date(now - BREAKER_COOLDOWN_MS - 1).toISOString(), pause_reason: 'errors' } });
    expect(activePause(old, 0.75, now)).toBeNull();
  });
});

describe('falha técnica × recusa (breaker)', () => {
  it('quem classifica manda', () => {
    expect(isTechnicalFailure({ data: { accountLevel: true } })).toBe(true);
    expect(isTechnicalFailure({ data: { accountLevel: false } })).toBe(false);
  });

  it('recusa do cartão na Whop não é técnica', () => {
    expect(isTechnicalFailure({ failureCode: 'insufficient_funds', providerTransactionId: 'pay_1', data: { decline_code: 'insufficient_funds' } })).toBe(false);
    expect(isTechnicalFailure({ failureMessage: 'Pagamento recusado.', data: { decline_code: 'do_not_honor' } })).toBe(false);
  });

  it('HTTP 5xx, 401/403, 429 e timeout são técnicos; 400 comum não', () => {
    expect(isTechnicalFailure({ failureMessage: 'Whop HTTP 503', data: {} })).toBe(true);
    expect(isTechnicalFailure({ failureMessage: 'x', data: { http_status: 401 } })).toBe(true);
    expect(isTechnicalFailure({ failureMessage: 'TIMEOUT_10000ms' })).toBe(true);
    expect(isTechnicalFailure({ failureMessage: 'Whop HTTP 400', data: {} })).toBe(false);
  });
});

describe('taxa de roteamento', () => {
  it('comissão = bruto × (commission_pct + routing_fee_pct)', () => {
    expect(ownAccountCommissionUsdCents(10000, 3, 0.8)).toBe(380);
    expect(ownAccountCommissionUsdCents(12345, 5, 0.8)).toBe(Math.round((12345 * 5.8) / 100));
  });

  it('desligado (taxa 0) dá exatamente o valor de antes', () => {
    for (const gross of [0, 1, 99, 12345, 999999]) {
      for (const pct of [0, 3, 4.5]) {
        expect(ownAccountCommissionUsdCents(gross, pct, 0)).toBe(Math.round((gross * pct) / 100));
      }
    }
  });
});

describe('desligar o roteamento', () => {
  it('fica a de maior prioridade de cada provedor, e só uma entre Whop e Stripe', () => {
    const kept = keptOnDisable([
      { id: 'whopl_biz_1', provider: 'whop', priority: 5 },
      { id: 'whopa_x', provider: 'whop', priority: 1 },
      { id: 'stripel_a', provider: 'stripe', priority: 2 },
      { id: 'stripel_b', provider: 'stripe', priority: 9 },
      { id: 'paypall_a', provider: 'paypal', priority: 50 },
      { id: 'paypall_b', provider: 'paypal', priority: 3 },
    ]);
    // Whop extra nunca fica (fora do roteamento a Whop é a principal).
    expect([...kept].sort()).toEqual(['paypall_b', 'stripel_a']);
  });
});

describe('edição da conta', () => {
  const base = defaultAccountConfig('stripel_a', 's-1', 'stripe');

  it('normaliza e valida os campos', () => {
    const patch = parseAccountPatch(
      { label: ' Stripe EUA ', weight: 60, priority: 2, dailyCapUsdCents: 500000, countries: 'us, br', currencies: ['usd'], paused: true },
      base,
      '2026-09-28T12:00:00Z',
    );
    expect(patch).toEqual({
      label: 'Stripe EUA',
      weight: 60,
      priority: 2,
      daily_cap_usd_cents: 500000,
      countries: ['US', 'BR'],
      currencies: ['USD'],
      paused_at: '2026-09-28T12:00:00Z',
      pause_reason: 'manual',
    });
    expect(parseAccountPatch({ paused: false, dailyCapOrders: null }, base, 'x')).toEqual({ paused_at: null, pause_reason: null, daily_cap_orders: null });
  });

  it('recusa valor inválido e faixa invertida', () => {
    expect(() => parseAccountPatch({ weight: -1 }, base, 'x')).toThrow('weight');
    expect(() => parseAccountPatch({ priority: 0 }, base, 'x')).toThrow('priority');
    expect(() => parseAccountPatch({ minTicketUsdCents: 900, maxTicketUsdCents: 100 }, base, 'x')).toThrow('invertida');
    expect(() => parseAccountPatch({ countries: ['BRA'] }, base, 'x')).toThrow('País');
  });
});

describe('status.externalProvider com o roteamento', () => {
  it('ganha routing { enabled, feePct } e providers.*.accounts', () => {
    const { combineExternalProviderView } = require('../seller-provider/seller-provider-accounts');
    const whop = { allowed: true, connected: true, provider: 'whop', accountName: 'Loja', commissionPct: 3, charging: true, walletReady: true, attention: null };
    const stripe = { id: 'x', seller_id: 's-1', provider: 'stripe', status: 'active', mode: 'live', account_ref: 'acct_1', display_name: 'Stripe', public_key: 'pk', secret_enc: 's' };
    const view = combineExternalProviderView(whop, { stripe, paypal: null }, {
      counts: { whop: 3, stripe: 5, paypal: 0 },
      routing: { enabled: true, feePct: 0.8 },
    });
    expect(view.routing).toEqual({ enabled: true, feePct: 0.8 });
    expect(view.providers.whop.accounts).toBe(3);
    expect(view.providers.stripe.accounts).toBe(5);
    expect(view.providers.paypal).toBeNull();
    // Sem extras (chamada antiga): o formato de antes, sem `routing` nem `accounts`.
    const legacy = combineExternalProviderView(whop, { stripe, paypal: null });
    expect(legacy.routing).toBeUndefined();
    expect(legacy.providers.stripe.accounts).toBeUndefined();
  });
});

describe('conectar mais uma conta', () => {
  it('roteamento ligado: a conta nova sempre entra', () => {
    expect(connectionChoice({ routingEnabled: true, occupying: 3 })).toBe('proceed')
  })

  it('primeira conta do grupo: conecta sem perguntar nada', () => {
    expect(connectionChoice({ routingEnabled: false, occupying: 0 })).toBe('proceed')
  })

  it('já há conta recebendo e o seller não disse o que quer: o painel pergunta', () => {
    expect(connectionChoice({ routingEnabled: false, occupying: 1 })).toBe('ask')
  })

  it('"usar várias contas" liga o roteamento; "trocar" segue como antes', () => {
    expect(connectionChoice({ routingEnabled: false, occupying: 1, multiAccount: true })).toBe('enable')
    // Na primeira conta também: é a opção oferecida já na conexão.
    expect(connectionChoice({ routingEnabled: false, occupying: 0, multiAccount: true })).toBe('enable')
    expect(connectionChoice({ routingEnabled: false, occupying: 1, replace: true })).toBe('proceed')
    // Só `true` vale: valor solto no corpo não liga taxa nenhuma.
    expect(connectionChoice({ routingEnabled: false, occupying: 1, multiAccount: 'true' })).toBe('ask')
  })
})

describe('trocar a conta atual (roteamento desligado)', () => {
  const occupying = [{ id: 'whopl_biz_1', provider: 'whop' as const }];

  it('a conta de outro provedor do grupo sai depois que a nova conecta', () => {
    expect(accountsToReplace({ provider: 'stripe', replace: true, routingEnabled: false, occupying })).toEqual(['whopl_biz_1']);
  });

  it('mesmo provedor: a conexão regrava a conta no lugar, nada a remover', () => {
    expect(accountsToReplace({ provider: 'whop', replace: true, routingEnabled: false, occupying })).toEqual([]);
  });

  it('sem o pedido de troca, ou com o roteamento ligado, ninguém sai', () => {
    expect(accountsToReplace({ provider: 'stripe', routingEnabled: false, occupying })).toEqual([]);
    expect(accountsToReplace({ provider: 'stripe', replace: 'true', routingEnabled: false, occupying })).toEqual([]);
    expect(accountsToReplace({ provider: 'stripe', replace: true, routingEnabled: true, occupying })).toEqual([]);
  });
});

describe('dia do roteamento (Brasília)', () => {
  it('vira às 03:00 UTC (meia-noite de Brasília), não às 00:00 UTC', () => {
    // 22h de 05/10 em Brasília = 01h UTC de 06/10: ainda é dia 05 para o seller.
    expect(new Date(routingDayStartMs(Date.parse('2026-10-06T01:00:00Z'))).toISOString()).toBe('2026-10-05T03:00:00.000Z')
    expect(new Date(routingDayStartMs(Date.parse('2026-10-06T03:00:00Z'))).toISOString()).toBe('2026-10-06T03:00:00.000Z')
  })

  it('vendas do dia contam as aprovadas (inclusive estornadas) em USD bruto', () => {
    const today = computeToday([
      { provider_account_id: 'stripel_a', status: 'approved', amount_usd_gross_cents: '5000' },
      { provider_account_id: 'stripel_a', status: 'refunded', amount_usd_gross_cents: 3000 },
      { provider_account_id: 'stripel_a', status: 'pending', amount_usd_gross_cents: 9000 },
      { provider_account_id: 'stripel_a', status: 'failed', amount_usd_gross_cents: 9000 },
      { provider_account_id: 'outra', status: 'approved', amount_usd_gross_cents: 9000 },
    ], ['stripel_a', 'stripel_b'])
    expect(today.get('stripel_a')).toEqual({ volume: 8000, paidCount: 2 })
    expect(today.get('stripel_b')).toEqual({ volume: 0, paidCount: 0 })
  })
})

describe('aquecimento', () => {
  // Começou às 10h de Brasília de 01/10.
  const started = '2026-10-01T13:00:00Z'
  const warm = (extra: Record<string, any> = {}) => ({
    warmup_started_at: started,
    warmup_days: 7,
    warmup_start_orders: 3,
    warmup_start_usd_cents: 15000,
    warmup_growth_pct: 50,
    warmup_max_ticket_usd_cents: 10000,
    ...extra,
  })
  const at = (iso: string) => Date.parse(iso)

  it('limites sobem pela curva a cada dia de Brasília', () => {
    const config = { ...defaultAccountConfig('stripel_a', 's-1', 'stripe'), ...warm() }
    const day1 = warmupState(config, at('2026-10-02T02:59:00Z'))! // 23:59 do dia 01 em Brasília
    expect(day1).toMatchObject({ day: 1, ordersLimit: 3, usdLimitCents: 15000, totalDays: 7 })
    expect(warmupState(config, at('2026-10-02T03:00:00Z'))).toMatchObject({ day: 2, ordersLimit: 4, usdLimitCents: 22500 })
    expect(warmupState(config, at('2026-10-04T12:00:00Z'))).toMatchObject({ day: 4, ordersLimit: 10, usdLimitCents: 50625 })
    expect(day1.endsAt).toBe('2026-10-08T03:00:00.000Z')
  })

  it('acaba depois dos dias e não existe antes de começar', () => {
    const config = { ...defaultAccountConfig('stripel_a', 's-1', 'stripe'), ...warm() }
    expect(warmupState(config, at('2026-10-08T02:59:00Z'))?.day).toBe(7)
    expect(warmupState(config, at('2026-10-08T03:00:00Z'))).toBeNull()
    expect(warmupState({ ...config, warmup_started_at: null }, at('2026-10-02T12:00:00Z'))).toBeNull()
  })

  it('o teto diário é o destino: a curva nunca passa dele', () => {
    const config = { ...defaultAccountConfig('stripel_a', 's-1', 'stripe'), ...warm(), daily_cap_orders: 5, daily_cap_usd_cents: 30000 }
    expect(effectiveDailyLimits(config, at('2026-10-01T15:00:00Z'))).toMatchObject({ orders: 3, usdCents: 15000 })
    expect(effectiveDailyLimits(config, at('2026-10-05T15:00:00Z'))).toMatchObject({ orders: 5, usdCents: 30000 })
    // Terminado o aquecimento, só o teto.
    expect(effectiveDailyLimits(config, at('2026-10-20T15:00:00Z'))).toMatchObject({ orders: 5, usdCents: 30000, warmup: null })
  })

  it('só com vendas no início: volume fica livre (ou no teto)', () => {
    const config = { ...defaultAccountConfig('stripel_a', 's-1', 'stripe'), ...warm({ warmup_start_usd_cents: null }) }
    expect(effectiveDailyLimits(config, at('2026-10-01T15:00:00Z'))).toMatchObject({ orders: 3, usdCents: null })
  })

  it('tira a conta da escolha ao bater o limite do dia e acima do ticket máximo', () => {
    const now = at('2026-10-01T15:00:00Z')
    const a = acc('stripel_a', { config: warm(), stats: { todayOrders: 2, todayUsdCents: 9000 } })
    expect(ineligibility(a, {}, 0.75, { now })).toBeNull()
    expect(ineligibility(a, { amountUsdCents: 5000 }, 0.75, { now })).toBeNull()
    expect(ineligibility(a, { amountUsdCents: 7000 }, 0.75, { now })).toBe('cap_usd') // 9000 + 7000 > 15000
    expect(ineligibility(a, { amountUsdCents: 12000 }, 0.75, { now })).toBe('warmup_ticket')
    const full = acc('stripel_a', { config: warm(), stats: { todayOrders: 3 } })
    expect(capReached(full, null, now)).toBe('cap_orders')
    // No dia seguinte o limite já é 4.
    expect(capReached(full, null, at('2026-10-02T15:00:00Z'))).toBeNull()
  })

  it('a conta aquecendo divide com as outras e, cheia, a outra assume', () => {
    const now = at('2026-10-01T15:00:00Z')
    const nova = acc('stripel_nova', { config: { ...warm(), priority: 1 }, stats: { todayOrders: 3 } })
    const velha = acc('stripel_velha', { config: { priority: 2 } })
    const eligible = [nova, velha].filter(a => ineligibility(a, {}, 0.75, { now }) === null)
    expect(selectAccount('priority_cap', eligible, {})?.id).toBe('stripel_velha')
  })
})

describe('edição do aquecimento', () => {
  const nowIso = '2026-10-05T15:00:00.000Z'
  const base = defaultAccountConfig('stripel_a', 's-1', 'stripe')

  it('liga começando hoje, com crescimento padrão de 30%', () => {
    const patch = parseAccountPatch({ warmup: { days: 10, startOrders: 3 } }, base, nowIso)
    expect(patch).toEqual({
      warmup_started_at: nowIso,
      warmup_days: 10,
      warmup_start_orders: 3,
      warmup_start_usd_cents: null,
      warmup_growth_pct: 30,
      warmup_max_ticket_usd_cents: null,
    })
  })

  it('ajustar um aquecimento em curso mantém o dia; restart recomeça', () => {
    const running = { ...base, warmup_started_at: '2026-10-03T15:00:00.000Z', warmup_days: 10, warmup_start_orders: 3 }
    expect(parseAccountPatch({ warmup: { days: 14, startOrders: 5 } }, running, nowIso).warmup_started_at).toBe('2026-10-03T15:00:00.000Z')
    expect(parseAccountPatch({ warmup: { days: 14, startOrders: 5, restart: true } }, running, nowIso).warmup_started_at).toBe(nowIso)
    // Aquecimento já terminado: ligar de novo começa hoje.
    const done = { ...running, warmup_started_at: '2026-09-01T15:00:00.000Z' }
    expect(parseAccountPatch({ warmup: { days: 14, startOrders: 5 } }, done, nowIso).warmup_started_at).toBe(nowIso)
  })

  it('null encerra', () => {
    expect(parseAccountPatch({ warmup: null }, base, nowIso)).toEqual({ warmup_started_at: null })
  })

  it('recusa sem dias, sem limite de início ou com valores fora da faixa', () => {
    expect(() => parseAccountPatch({ warmup: { startOrders: 3 } }, base, nowIso)).toThrow(/days/)
    expect(() => parseAccountPatch({ warmup: { days: 7 } }, base, nowIso)).toThrow(/primeiro dia/)
    expect(() => parseAccountPatch({ warmup: { days: 0, startOrders: 3 } }, base, nowIso)).toThrow(/warmup.days/)
    expect(() => parseAccountPatch({ warmup: { days: 7, startOrders: 3, growthPct: 500 } }, base, nowIso)).toThrow(/growthPct/)
    expect(() => parseAccountPatch({ warmup: 'sim' }, base, nowIso)).toThrow(/warmup/)
  })
})

describe('contas por link e fase da conta', () => {
  const { accountStage, linkModeAllows, ownProviderOfId, groupOfProvider, defaultAccountConfig } = require('./seller-routing')
  it('link: deny (padrão) só formulário, allow os dois, only só link', () => {
    expect(linkModeAllows('shopify', undefined)).toBe(false)
    expect(linkModeAllows('stripe', undefined)).toBe(true)
    expect(linkModeAllows('shopify', 'allow')).toBe(true)
    expect(linkModeAllows('whop', 'allow')).toBe(true)
    expect(linkModeAllows('shopify', 'only')).toBe(true)
    expect(linkModeAllows('stripe', 'only')).toBe(false)
  })
  it('id shopifyp_ é Shopify e digistp_ é Digistore24, as duas no grupo de cartão (campo antigo)', () => {
    expect(ownProviderOfId('shopifyp_abc')).toBe('shopify')
    expect(ownProviderOfId('digistp_abc')).toBe('digistore24')
    expect(groupOfProvider('shopify')).toBe('card')
    expect(groupOfProvider('digistore24')).toBe('card')
    expect(groupOfProvider('paypal')).toBe('paypal')
  })
  it('link providers: sem lista vale só Shopify; Digistore24 só quando o checkout manda', () => {
    expect(linkModeAllows('digistore24', 'allow')).toBe(false)
    expect(linkModeAllows('digistore24', 'allow', ['shopify', 'digistore24'])).toBe(true)
    expect(linkModeAllows('shopify', 'only', ['digistore24'])).toBe(false)
    expect(linkModeAllows('digistore24', 'only', ['digistore24'])).toBe(true)
    expect(linkModeAllows('stripe', 'allow', ['digistore24'])).toBe(true)
    expect(linkModeAllows('digistore24', undefined, ['digistore24'])).toBe(false)
  })
  it('fase: aquecendo, pronta para escalar e ativa', () => {
    const base = defaultAccountConfig('shopifyp_x', 's', 'shopify')
    const started = '2026-10-01T12:00:00Z'
    const cfg = { ...base, warmup_started_at: started, warmup_days: 7, warmup_start_orders: 3 }
    expect(accountStage(cfg, Date.parse('2026-10-03T12:00:00Z'))).toBe('warming')
    expect(accountStage(cfg, Date.parse('2026-10-09T12:00:00Z'))).toBe('ready_to_scale')
    expect(accountStage(base, Date.parse('2026-10-09T12:00:00Z'))).toBe('active')
  })
})

describe('métodos por conta', () => {
  const { canonicalMethod, methodAllowed, applyAccountMethods, parseAccountPatch, defaultAccountConfig, ineligibility, emptyStats } = require('./seller-routing')
  const base = defaultAccountConfig('stripel_a', 's', 'stripe')
  it('cartão tem um nome só', () => {
    expect(canonicalMethod('credit_card')).toBe('card')
    expect(canonicalMethod('Debit_Card')).toBe('card')
    expect(canonicalMethod('apple_pay')).toBe('apple_pay')
  })
  it('sem lista, tudo; com lista, só os ligados (mantendo a grafia de origem)', () => {
    expect(applyAccountMethods(['credit_card', 'pix', 'apple_pay'], base)).toEqual(['credit_card', 'pix', 'apple_pay'])
    const cfg = { ...base, methods: ['card', 'apple_pay'] }
    expect(applyAccountMethods(['credit_card', 'pix', 'apple_pay'], cfg)).toEqual(['credit_card', 'apple_pay'])
    expect(methodAllowed(cfg, 'pix')).toBe(false)
  })
  it('venda com método desligado não fica na conta', () => {
    const candidate = { id: 'stripel_a', provider: 'stripe', config: { ...base, methods: ['card'] }, stats: emptyStats(), chargeable: true, breakerOpen: false }
    expect(ineligibility(candidate, { method: 'pix' }, 0.75)).toBe('method')
    expect(ineligibility(candidate, { method: 'credit_card' }, 0.75)).toBeNull()
    expect(ineligibility(candidate, {}, 0.75)).toBeNull()
  })
  it('PUT aceita a lista, normaliza e recusa lixo; vazio volta a tudo', () => {
    expect(parseAccountPatch({ methods: ['credit_card', 'PIX', 'pix'] }, base, 'now')).toEqual({ methods: ['card', 'pix'] })
    expect(parseAccountPatch({ methods: [] }, base, 'now')).toEqual({ methods: null })
    expect(() => parseAccountPatch({ methods: ['<script>'] }, base, 'now')).toThrow('Método inválido')
  })
})

describe('slots de método', () => {
  const s = require('./seller-routing')
  it('cartão e carteiras num slot só; o resto é o próprio método', () => {
    for (const m of ['card', 'credit_card', 'Debit_Card', 'apple_pay', 'google_pay']) expect(s.slotOfMethod(m)).toBe('card')
    expect(s.slotOfMethod('paypal')).toBe('paypal')
    expect(s.slotOfMethod('PIX')).toBe('pix')
    expect(s.slotOfMethod('ideal')).toBe('ideal')
  })
  it('slots da conta: link só cartão, PayPal só PayPal, Whop/Stripe pelos métodos efetivos', () => {
    expect(s.slotsOfAccount('shopify', ['shopify_checkout'])).toEqual(['card'])
    expect(s.slotsOfAccount('digistore24', ['digistore_checkout'])).toEqual(['card'])
    expect(s.slotsOfAccount('paypal', ['paypal'])).toEqual(['paypal'])
    expect(s.slotsOfAccount('stripe', ['ideal', 'credit_card', 'apple_pay', 'bancontact'])).toEqual(['card', 'bancontact', 'ideal'])
    const cfg = { ...s.defaultAccountConfig('whopa_x', 's', 'whop'), methods: ['pix'] }
    expect(s.slotsOfAccount('whop', s.effectiveMethods('whop', ['credit_card', 'pix'], cfg))).toEqual(['pix'])
    // Whop sem nada lido atende pelo menos o cartão (como antes dos slots).
    expect(s.effectiveMethods('whop', [], null)).toEqual(['credit_card'])
  })
  it('estratégia do slot: a gravada, senão paypal_strategy no PayPal e card_strategy no resto', () => {
    const settings = { cardStrategy: 'priority_cap', paypalStrategy: 'score', methodStrategies: { pix: 'revenue_split' } }
    expect(s.strategyOfSlot(settings, 'card')).toBe('priority_cap')
    expect(s.strategyOfSlot(settings, 'paypal')).toBe('score')
    expect(s.strategyOfSlot(settings, 'pix')).toBe('revenue_split')
    expect(s.strategyOfSlot(settings, 'ideal')).toBe('priority_cap')
    expect(s.normalizeMethodStrategies({ pix: 'score', 'X!': 'score', card: 'lixo' })).toEqual({ pix: 'score' })
  })
  it('PUT strategies: valida slot e estratégia; null remove', () => {
    expect(s.parseStrategiesPatch({ PIX: 'score', card: null })).toEqual({ pix: 'score', card: null })
    expect(() => s.parseStrategiesPatch({ 'pi x': 'score' })).toThrow()
    try { s.parseStrategiesPatch({ 'pi x': 'score' }) } catch (e: any) { expect(e.getResponse()).toMatchObject({ error: 'ROUTING_INVALID_SLOT' }) }
    try { s.parseStrategiesPatch({ pix: 'x' }) } catch (e: any) { expect(e.getResponse()).toMatchObject({ error: 'ROUTING_INVALID_STRATEGY' }) }
  })
  it('atribuição do slot: method_accounts, senão as colunas antigas no cartão e no PayPal', () => {
    const a = { card_account_id: 'stripel_a', paypal_account_id: 'paypall_b', method_accounts: { pix: 'whopa_c' } }
    expect(s.assignedOfSlot(a, 'card')).toBe('stripel_a')
    expect(s.assignedOfSlot(a, 'paypal')).toBe('paypall_b')
    expect(s.assignedOfSlot(a, 'pix')).toBe('whopa_c')
    expect(s.assignedOfSlot(a, 'ideal')).toBeNull()
    expect(s.assignedOfSlot(null, 'card')).toBeNull()
  })
  it('linkProviders do config: CSV filtrado, padrão Shopify', () => {
    expect(s.parseLinkProviders(undefined)).toEqual(['shopify'])
    expect(s.parseLinkProviders('digistore24, SHOPIFY,lixo')).toEqual(['digistore24', 'shopify'])
    expect(s.parseLinkProviders('lixo')).toEqual(['shopify'])
  })
  it('conta por link: ids e prefixo', () => {
    expect(s.toDigistoreLinkAccountId('u1')).toBe('digistp_u1')
    expect(s.isLinkAccountId('digistp_u1')).toBe(true)
    expect(s.linkRowIdOf('digistp_u1')).toBe('u1')
    expect(s.linkRowIdOf('shopifyp_u2')).toBe('u2')
    // O prefixo cabe na regex do backend do checkout.
    expect(/^[a-z]{4,8}_/.test('digistp_u1')).toBe(true)
  })
  it('conta que já recebe: só ativas, pelo formulário, com slot em comum', () => {
    const pool = [
      { id: 'whopl_1', provider: 'whop', connection: 'active', slots: ['card', 'pix'] },
      { id: 'stripel_i', provider: 'stripe', connection: 'active', slots: ['ideal'] },
      { id: 'shopifyp_1', provider: 'shopify', connection: 'active', slots: ['card'] },
      { id: 'paypall_1', provider: 'paypal', connection: 'active', slots: ['paypal'] },
      { id: 'stripel_s', provider: 'stripe', connection: 'standby', slots: ['card'] },
    ]
    expect(s.occupyingAccounts('stripe', pool).map((e: any) => e.id)).toEqual(['whopl_1'])
    expect(s.occupyingAccounts('paypal', pool).map((e: any) => e.id)).toEqual(['paypall_1'])
  })
  it('desligar conta sobreposição de slots e uma por provedor', () => {
    const kept = s.keptOnDisable([
      { id: 'stripel_a', provider: 'stripe', priority: 1, slots: ['card', 'ideal'] },
      { id: 'stripel_b', provider: 'stripe', priority: 2, slots: ['bancontact'] },
      { id: 'whopl_biz', provider: 'whop', priority: 3, slots: ['card', 'pix'] },
      { id: 'paypall_a', provider: 'paypal', priority: 9, slots: ['paypal'] },
    ])
    expect([...kept].sort()).toEqual(['paypall_a', 'stripel_a'])
  })
})
