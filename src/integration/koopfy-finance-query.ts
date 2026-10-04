export interface FinanceListQuery {
  page: number;
  pageSize: number;
  status?: string;
  method?: string;
  type?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Conta própria do seller (`whopl_…`, `whopa_…`, `stripel_…`, `paypall_…`). */
  accountId?: string;
}

// Só ids de conta PRÓPRIA entram no filtro: os pools da Koopfy não são do painel.
const OWN_ACCOUNT_ID = /^(whopl|whopa|stripel|paypall)_[A-Za-z0-9_-]{4,80}$/;

const FILTER_TOKEN = /^[a-z0-9_-]{1,40}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function token(value: unknown): string | undefined {
  return typeof value === 'string' && FILTER_TOKEN.test(value)
    ? value
    : undefined;
}

function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

export function normalizeFinanceListQuery(
  raw: Record<string, unknown>,
  allowedStatuses: readonly string[],
): FinanceListQuery {
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const search =
    typeof raw.search === 'string' ? raw.search.trim().slice(0, 160) : '';

  return {
    page: positiveInteger(raw.page, 1),
    pageSize: Math.min(positiveInteger(raw.pageSize, 20), 100),
    status:
      status && allowedStatuses.includes(status) ? status : undefined,
    method: token(raw.method),
    type: token(raw.type),
    search: search || undefined,
    dateFrom: date(raw.dateFrom),
    dateTo: date(raw.dateTo),
    accountId: typeof raw.accountId === 'string' && OWN_ACCOUNT_ID.test(raw.accountId) ? raw.accountId : undefined,
  };
}
