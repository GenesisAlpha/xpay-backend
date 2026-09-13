import assert from "node:assert/strict"
import test from "node:test"

async function loadReportBuilder() {
  return import("./subscription-report.ts").catch(() => ({}))
}

const transactions = [
  {
    id: "tx-monthly",
    customer_name: "Ana Lima",
    customer_email: "ana@example.com",
    amount: 1000,
    amount_usd_gross_cents: 1000,
    currency: "USD",
    approved_at: "2026-09-01T12:00:00.000Z",
    created_at: "2026-09-01T11:59:00.000Z",
    metadata: {
      workspace_id: "workspace-a",
      product_title: "Comunidade Pro",
      pricing_plan: {
        id: "monthly",
        name: "Mensal",
        renewal_price: 29,
        billing_period_days: 30,
        trial_period_days: 0,
      },
    },
  },
  {
    id: "tx-annual",
    customer_name: "Bruno Souza",
    customer_email: "bruno@example.com",
    amount: 12000,
    amount_usd_gross_cents: 12000,
    currency: "USD",
    approved_at: null,
    created_at: "2026-08-20T10:00:00.000Z",
    metadata: {
      workspace_id: "workspace-a",
      product_title: "Curso Premium",
      pricing_plan: {
        id: "annual",
        name: "Pro Annual",
        renewal_price: 120,
        billing_period_days: 365,
        trial_period_days: 7,
      },
    },
  },
  {
    id: "tx-past-due",
    customer_name: "Carla Melo",
    customer_email: "carla@example.com",
    amount: 4900,
    amount_usd_gross_cents: 4900,
    currency: "USD",
    approved_at: "2026-07-10T09:00:00.000Z",
    created_at: "2026-07-10T08:59:00.000Z",
    metadata: {
      workspace_id: "workspace-b",
      product_title: "Mentoria",
      subscription_config: { billing_period_days: 30, trial_period_days: 0 },
    },
  },
]

const subscriptions = [
  {
    whop_membership_id: "membership-monthly",
    koopfy_transaction_id: "tx-monthly",
    koopfy_product_id: "product-community",
    customer_email: "ana@example.com",
    status: "active",
    cancel_at_period_end: true,
    current_period_end: "2026-10-01T12:00:00.000Z",
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-05T12:00:00.000Z",
    metadata: {},
  },
  {
    whop_membership_id: "membership-annual",
    koopfy_transaction_id: "tx-annual",
    koopfy_product_id: "product-course",
    customer_email: "bruno@example.com",
    status: "trialing",
    cancel_at_period_end: false,
    current_period_end: "2027-08-20T10:00:00.000Z",
    created_at: "2026-08-20T10:00:00.000Z",
    updated_at: "2026-08-20T10:00:00.000Z",
    metadata: {},
  },
  {
    whop_membership_id: "membership-past-due",
    koopfy_transaction_id: "tx-past-due",
    koopfy_product_id: "product-mentoring",
    customer_email: "carla@example.com",
    status: "unpaid",
    cancel_at_period_end: false,
    current_period_end: "2026-08-10T09:00:00.000Z",
    created_at: "2026-07-10T09:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
    metadata: {},
  },
  {
    whop_membership_id: "membership-other-seller",
    koopfy_transaction_id: "tx-not-owned",
    koopfy_product_id: "product-secret",
    customer_email: "other@example.com",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: null,
    created_at: "2026-09-10T10:00:00.000Z",
    updated_at: "2026-09-10T10:00:00.000Z",
    metadata: {},
  },
]

test("builds a seller-scoped recurring portfolio with normalized MRR", async () => {
  const module = await loadReportBuilder()
  assert.equal(typeof module.buildSubscriptionReport, "function", "subscription report builder must exist")

  const report = module.buildSubscriptionReport({ transactions, subscriptions })

  assert.deepEqual(report.summary, {
    total: 3,
    active: 1,
    trialing: 1,
    pastDue: 1,
    canceling: 1,
    canceled: 0,
    mrrUsd: 38.86,
  })
  assert.equal(report.pagination.total, 3)
  assert.equal(report.data[0].id, "membership-monthly")
  assert.equal(report.data[0].customerName, "Ana Lima")
  assert.equal(report.data[0].productTitle, "Comunidade Pro")
  assert.equal(report.data[0].planName, "Mensal")
  assert.equal(report.data[0].recurringAmount, 29)
  assert.equal(report.data.some(item => item.id === "membership-other-seller"), false)
})

test("filters virtual subscription states and searchable product data before paginating", async () => {
  const module = await loadReportBuilder()
  assert.equal(typeof module.buildSubscriptionReport, "function", "subscription report builder must exist")

  const canceling = module.buildSubscriptionReport({
    transactions,
    subscriptions,
    status: "canceling",
    page: 1,
    pageSize: 20,
  })
  assert.deepEqual(canceling.data.map(item => item.id), ["membership-monthly"])

  const searched = module.buildSubscriptionReport({
    transactions,
    subscriptions,
    search: "pro annual",
    page: 1,
    pageSize: 20,
  })
  assert.deepEqual(searched.data.map(item => item.id), ["membership-annual"])

  const pastDue = module.buildSubscriptionReport({
    transactions,
    subscriptions,
    status: "past_due",
    page: 1,
    pageSize: 1,
  })
  assert.equal(pastDue.pagination.total, 1)
  assert.equal(pastDue.pagination.totalPages, 1)
  assert.equal(pastDue.data[0].status, "unpaid")
})

test("loads memberships only through transactions owned by the requested seller", async () => {
  const module = await loadReportBuilder()
  assert.equal(typeof module.loadSubscriptionReport, "function", "subscription loader must exist")

  const repository = {
    async listTransactions(sellerId) {
      return sellerId === "seller-a" ? transactions.slice(0, 2) : []
    },
    async listSubscriptions(transactionIds) {
      return subscriptions.filter(row => transactionIds.includes(row.koopfy_transaction_id))
    },
  }

  const report = await module.loadSubscriptionReport(repository, "seller-a", {
    status: "all",
    page: 1,
    pageSize: 20,
  })

  assert.equal(report.summary.total, 2)
  assert.deepEqual(report.data.map(item => item.transactionId), ["tx-monthly", "tx-annual"])
})

test("does not query memberships when the seller has no recurring transactions", async () => {
  const module = await loadReportBuilder()
  assert.equal(typeof module.loadSubscriptionReport, "function", "subscription loader must exist")

  let membershipQueryRan = false
  const report = await module.loadSubscriptionReport({
    async listTransactions() {
      return []
    },
    async listSubscriptions() {
      membershipQueryRan = true
      return subscriptions
    },
  }, "seller-empty", {})

  assert.equal(membershipQueryRan, false)
  assert.equal(report.summary.total, 0)
  assert.deepEqual(report.data, [])
})

test("keeps only transactions attributed to the active checkout workspace", async () => {
  const module = await loadReportBuilder()
  assert.equal(typeof module.filterTransactionsByWorkspace, "function", "workspace filter must exist")

  assert.deepEqual(
    module.filterTransactionsByWorkspace(transactions, "workspace-a").map(row => row.id),
    ["tx-monthly", "tx-annual"],
  )
  assert.deepEqual(module.filterTransactionsByWorkspace(transactions, "workspace-missing"), [])
})

test("does not classify an already inactive membership as still canceling", async () => {
  const module = await loadReportBuilder()
  const report = module.buildSubscriptionReport({
    transactions: [transactions[0]],
    subscriptions: [{
      ...subscriptions[0],
      status: "inactive",
      cancel_at_period_end: true,
    }],
  })

  assert.equal(report.summary.canceling, 0)
  assert.equal(report.summary.canceled, 1)
  assert.equal(module.buildSubscriptionReport({
    transactions: [transactions[0]],
    subscriptions: [{ ...subscriptions[0], status: "inactive", cancel_at_period_end: true }],
    status: "canceling",
  }).data.length, 0)
})
