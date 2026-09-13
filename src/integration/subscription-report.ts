export type SubscriptionStatusFilter =
  | 'all'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceling'
  | 'canceled';

export interface SubscriptionTransactionRow {
  id: string;
  customer_name?: string | null;
  customer_email?: string | null;
  amount?: number | null;
  amount_usd_gross_cents?: number | null;
  currency?: string | null;
  approved_at?: string | null;
  created_at?: string | null;
  metadata?: Record<string, any> | null;
}

export interface SubscriptionMembershipRow {
  whop_membership_id: string;
  koopfy_transaction_id?: string | null;
  koopfy_product_id?: string | null;
  customer_email?: string | null;
  status?: string | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, any> | null;
}

export interface SubscriptionListItem {
  id: string;
  transactionId: string;
  productId: string | null;
  customerName: string;
  customerEmail: string;
  productTitle: string;
  planId: string;
  planName: string;
  recurringAmount: number;
  currency: string;
  billingPeriodDays: number;
  trialPeriodDays: number;
  numberOfPayments: number | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  originalSaleAt: string | null;
}

interface BuildSubscriptionReportInput {
  transactions: SubscriptionTransactionRow[];
  subscriptions: SubscriptionMembershipRow[];
  status?: SubscriptionStatusFilter | string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface SubscriptionReportRepository {
  listTransactions(sellerId: string): Promise<SubscriptionTransactionRow[]>;
  listSubscriptions(transactionIds: string[]): Promise<SubscriptionMembershipRow[]>;
}

export type SubscriptionReportQuery = Omit<
  BuildSubscriptionReportInput,
  'transactions' | 'subscriptions'
>;

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const PAST_DUE_STATUSES = new Set(['past_due', 'unpaid']);
const CANCELED_STATUSES = new Set(['inactive', 'canceled', 'cancelled']);

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function isCanceling(item: SubscriptionListItem): boolean {
  return item.cancelAtPeriodEnd && ACTIVE_STATUSES.has(item.status);
}

function matchesStatus(item: SubscriptionListItem, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'canceling') return isCanceling(item);
  if (filter === 'past_due') return PAST_DUE_STATUSES.has(item.status);
  if (filter === 'canceled') return CANCELED_STATUSES.has(item.status);
  return item.status === filter;
}

function searchableText(item: SubscriptionListItem): string {
  return [
    item.customerName,
    item.customerEmail,
    item.productTitle,
    item.planName,
    item.id,
  ].join(' ').toLocaleLowerCase();
}

export function buildSubscriptionReport({
  transactions,
  subscriptions,
  status = 'all',
  search = '',
  page = 1,
  pageSize = 20,
}: BuildSubscriptionReportInput) {
  const transactionsById = new Map(transactions.map(transaction => [transaction.id, transaction]));
  const recurringUsdBySubscription = new Map<string, number>();

  // O conjunto de transações já chegou escopado pelo seller. Excluir memberships
  // sem uma transação correspondente mantém esse limite mesmo se uma consulta
  // futura trouxer, por engano, linhas de outra conta.
  const allItems = subscriptions.flatMap(subscription => {
    const transactionId = String(subscription.koopfy_transaction_id ?? '');
    const transaction = transactionsById.get(transactionId);
    if (!transaction) return [];

    const metadata = transaction.metadata ?? subscription.metadata ?? {};
    const plan = metadata.pricing_plan ?? {};
    const subscriptionConfig = metadata.subscription_config ?? {};
    const billingPeriodDays = positiveInteger(
      plan.billing_period_days ?? subscriptionConfig.billing_period_days,
      30,
    );
    const renewalPrice = plan.renewal_price != null
      ? finiteNumber(plan.renewal_price)
      : finiteNumber(transaction.amount) / 100;

    const item: SubscriptionListItem = {
      id: String(subscription.whop_membership_id),
      transactionId,
      productId: subscription.koopfy_product_id
        ? String(subscription.koopfy_product_id)
        : (metadata.product_id ? String(metadata.product_id) : null),
      customerName: String(transaction.customer_name ?? metadata.customer?.name ?? 'Cliente'),
      customerEmail: String(
        subscription.customer_email
          ?? transaction.customer_email
          ?? metadata.customer?.email
          ?? '',
      ),
      productTitle: String(metadata.product_title ?? metadata.productTitle ?? 'Produto recorrente'),
      planId: String(plan.id ?? metadata.koopfy_pricing_plan_id ?? 'default'),
      planName: String(plan.name ?? 'Plano principal'),
      recurringAmount: money(renewalPrice),
      currency: String(transaction.currency ?? metadata.currency ?? 'USD').toUpperCase(),
      billingPeriodDays,
      trialPeriodDays: Math.max(0, positiveInteger(
        plan.trial_period_days ?? subscriptionConfig.trial_period_days,
        0,
      )),
      numberOfPayments: plan.split_pay_required_payments == null
        ? null
        : positiveInteger(plan.split_pay_required_payments, 0) || null,
      status: String(subscription.status ?? 'inactive').toLocaleLowerCase(),
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      currentPeriodEnd: subscription.current_period_end ?? null,
      startedAt: subscription.created_at ?? null,
      updatedAt: subscription.updated_at ?? null,
      originalSaleAt: transaction.approved_at ?? transaction.created_at ?? null,
    };

    // O valor inicial pode ser promocional ou zero durante o trial. Para MRR,
    // priorizamos o preço de renovação do plano; quando ele não existe, usamos
    // o valor bruto em USD já normalizado na transação.
    recurringUsdBySubscription.set(
      item.id,
      plan.renewal_price != null
        ? finiteNumber(plan.renewal_price)
        : finiteNumber(transaction.amount_usd_gross_cents) / 100,
    );

    return [item];
  }).sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));

  const mrrUsdFor = (item: SubscriptionListItem) => money(
    finiteNumber(recurringUsdBySubscription.get(item.id)) * (30 / item.billingPeriodDays),
  );

  const activeItems = allItems.filter(item => ACTIVE_STATUSES.has(item.status));
  const planMap = new Map<string, {
    id: string;
    name: string;
    productTitle: string;
    subscribers: number;
    mrrUsd: number;
  }>();
  for (const item of activeItems) {
    const key = `${item.productId ?? 'product'}:${item.planId}`;
    const current = planMap.get(key) ?? {
      id: item.planId,
      name: item.planName,
      productTitle: item.productTitle,
      subscribers: 0,
      mrrUsd: 0,
    };
    current.subscribers += 1;
    current.mrrUsd = money(current.mrrUsd + mrrUsdFor(item));
    planMap.set(key, current);
  }

  const normalizedFilter = [
    'all', 'active', 'trialing', 'past_due', 'canceling', 'canceled',
  ].includes(status) ? status : 'all';
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = allItems.filter(item =>
    matchesStatus(item, normalizedFilter)
    && (!normalizedSearch || searchableText(item).includes(normalizedSearch)),
  );
  const safePageSize = Math.min(100, Math.max(1, Math.trunc(finiteNumber(pageSize, 20))));
  const safePage = Math.max(1, Math.trunc(finiteNumber(page, 1)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const currentPage = Math.min(safePage, totalPages);
  const offset = (currentPage - 1) * safePageSize;

  return {
    summary: {
      total: allItems.length,
      active: allItems.filter(item => item.status === 'active').length,
      trialing: allItems.filter(item => item.status === 'trialing').length,
      pastDue: allItems.filter(item => PAST_DUE_STATUSES.has(item.status)).length,
      canceling: allItems.filter(isCanceling).length,
      canceled: allItems.filter(item => CANCELED_STATUSES.has(item.status)).length,
      mrrUsd: money(activeItems.reduce((sum, item) => sum + mrrUsdFor(item), 0)),
    },
    plans: [...planMap.values()].sort((a, b) => b.mrrUsd - a.mrrUsd),
    data: filtered.slice(offset, offset + safePageSize),
    pagination: {
      page: currentPage,
      pageSize: safePageSize,
      total: filtered.length,
      totalPages,
    },
  };
}

export async function loadSubscriptionReport(
  repository: SubscriptionReportRepository,
  sellerId: string,
  query: SubscriptionReportQuery,
) {
  const transactions = await repository.listTransactions(sellerId);
  const transactionIds = transactions.map(transaction => transaction.id);
  const subscriptions = transactionIds.length > 0
    ? await repository.listSubscriptions(transactionIds)
    : [];

  return buildSubscriptionReport({
    transactions,
    subscriptions,
    ...query,
  });
}

export function filterTransactionsByWorkspace(
  transactions: SubscriptionTransactionRow[],
  workspaceId: string,
): SubscriptionTransactionRow[] {
  const normalizedWorkspaceId = String(workspaceId ?? '').trim();
  if (!normalizedWorkspaceId) return [];

  return transactions.filter(transaction =>
    String(transaction.metadata?.workspace_id ?? '') === normalizedWorkspaceId,
  );
}
