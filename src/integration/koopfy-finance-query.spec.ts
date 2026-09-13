import { normalizeFinanceListQuery } from './koopfy-finance-query';

describe('normalizeFinanceListQuery', () => {
  it('clamps pagination and drops unsupported status values', () => {
    expect(
      normalizeFinanceListQuery(
        { page: '-2', pageSize: '999', status: 'hacked' },
        ['pending', 'completed'],
      ),
    ).toEqual({
      page: 1,
      pageSize: 100,
      status: undefined,
      method: undefined,
      type: undefined,
      search: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    });
  });

  it('trims bounded filters without accepting arbitrary keys', () => {
    expect(
      normalizeFinanceListQuery(
        {
          page: '3',
          pageSize: '40',
          status: 'completed',
          method: 'pix',
          type: 'credit',
          search: `  ${'x'.repeat(200)}  `,
          dateFrom: '2026-09-01',
          dateTo: '2026-09-11',
          sellerId: 'attacker-controlled',
        },
        ['pending', 'completed'],
      ),
    ).toEqual({
      page: 3,
      pageSize: 40,
      status: 'completed',
      method: 'pix',
      type: 'credit',
      search: 'x'.repeat(160),
      dateFrom: '2026-09-01',
      dateTo: '2026-09-11',
    });
  });

  it('drops malformed dates and invalid filter tokens', () => {
    expect(
      normalizeFinanceListQuery(
        {
          status: ['completed'],
          method: '../stripe',
          type: 'credit card',
          dateFrom: '09/01/2026',
          dateTo: '2026-99-99',
        },
        ['completed'],
      ),
    ).toEqual({
      page: 1,
      pageSize: 20,
      status: undefined,
      method: undefined,
      type: undefined,
      search: undefined,
      dateFrom: undefined,
      dateTo: undefined,
    });
  });
});
