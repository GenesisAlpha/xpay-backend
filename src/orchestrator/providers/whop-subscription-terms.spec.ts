import { whopRenewalTerms } from './whop-subscription-terms';

const base = { renewalPrice: 47, billingPeriodDays: 30, trialPeriodDays: 0, planInitialPrice: 0 };

// O que a Whop cobra na compra com esses termos: com teste, só o inicial; sem
// teste, inicial + renovação.
const whopChargesToday = (t: any, renewal = 47) => (t.trialPeriodDays > 0 ? t.initialPrice : t.initialPrice + renewal);

describe('whopRenewalTerms', () => {
  it('valor inicial maior que a mensalidade: cobra só o inicial hoje, sem teste', () => {
    const terms = whopRenewalTerms({ ...base, todayCharge: 97, planInitialPrice: 97 }) as any;
    expect(terms).toEqual({ initialPrice: 50, trialPeriodDays: 0, freshPlan: false });
    expect(whopChargesToday(terms)).toBe(97);
  });

  it('valor inicial igual à mensalidade: nada adicional', () => {
    const terms = whopRenewalTerms({ ...base, todayCharge: 47, planInitialPrice: 47 }) as any;
    expect(terms).toEqual({ initialPrice: 0, trialPeriodDays: 0, freshPlan: false });
    expect(whopChargesToday(terms)).toBe(47);
  });

  it('valor inicial menor que a mensalidade: um ciclo de teste, em plano novo', () => {
    const terms = whopRenewalTerms({ ...base, todayCharge: 1, renewalPrice: 29, planInitialPrice: 1 }) as any;
    expect(terms).toEqual({ initialPrice: 1, trialPeriodDays: 30, freshPlan: true });
    expect(whopChargesToday(terms, 29)).toBe(1);
  });

  it('ciclo anual: o teste acompanha o período', () => {
    const terms = whopRenewalTerms({ ...base, billingPeriodDays: 365, renewalPrice: 397, todayCharge: 97, planInitialPrice: 97 }) as any;
    expect(terms.trialPeriodDays).toBe(365);
  });

  it('teste do seller: hoje é só o inicial e a renovação vem depois do teste', () => {
    expect(whopRenewalTerms({ ...base, trialPeriodDays: 7, todayCharge: 1, planInitialPrice: 1 }))
      .toEqual({ initialPrice: 1, trialPeriodDays: 7, freshPlan: false });
    expect(whopRenewalTerms({ ...base, trialPeriodDays: 7, todayCharge: 0 }))
      .toEqual({ initialPrice: 0, trialPeriodDays: 7, freshPlan: false });
  });

  it('sem valor inicial: hoje é a primeira mensalidade', () => {
    const terms = whopRenewalTerms({ ...base, todayCharge: 47 }) as any;
    expect(terms).toEqual({ initialPrice: 0, trialPeriodDays: 0, freshPlan: false });
  });

  it('sem valor inicial e cobrança abaixo da mensalidade (cupom): recusa', () => {
    expect(whopRenewalTerms({ ...base, todayCharge: 40 })).toEqual({ error: expect.any(String) });
  });

  it('valor inicial com cupom abaixo da mensalidade: vira ciclo de teste', () => {
    const terms = whopRenewalTerms({ ...base, todayCharge: 30, planInitialPrice: 97 }) as any;
    expect(terms).toEqual({ initialPrice: 30, trialPeriodDays: 30, freshPlan: true });
  });

  it('checkout antigo (hoje = inicial + mensalidade) continua cobrando o mesmo que antes', () => {
    // Deploy do pay antes do checkout não muda o valor cobrado.
    const terms = whopRenewalTerms({ ...base, todayCharge: 144, planInitialPrice: 97 }) as any;
    expect(whopChargesToday(terms)).toBe(144);
  });

  it('cobrança inválida', () => {
    expect(whopRenewalTerms({ ...base, todayCharge: Number.NaN })).toEqual({ error: expect.any(String) });
    expect(whopRenewalTerms({ ...base, todayCharge: -1 })).toEqual({ error: expect.any(String) });
  });
});
