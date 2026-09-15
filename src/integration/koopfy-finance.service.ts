import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DashboardService, Period } from '../dashboard/services/reports.service';
import {
  ApiKeysService,
  DisputesService,
  PaymentMethodsService,
  SettingsService,
  TransactionsService,
  TransfersService,
  WalletService,
} from '../dashboard/services/services';
import { RequestPayoutDto } from '../dashboard/dto/request-payout.dto';
import { SellerCtx } from './cross-service-jwt.guard';
import { AnticipationService } from '../wallets/anticipation.service';
import { normalizeFinanceListQuery } from './koopfy-finance-query';

const TRANSACTION_STATUSES = [
  'pending',
  'approved',
  'failed',
  'processing',
  'refunded',
  'chargeback',
] as const;
const DISPUTE_STATUSES = [
  'pending',
  'evidence_required',
  'won',
  'lost',
] as const;
const TRANSFER_STATUSES = [
  'pending',
  'scheduled',
  'completed',
  'failed',
] as const;
const PERIODS: Period[] = ['today', 'yesterday', '7d', '30d', '90d'];
// Mesma allowlist do Checkout (finance.types.ts). Identidade nunca vem do corpo.
const PAYOUT_FIELDS = [
  'method',
  'amount',
  'accountHolder',
  'bankName',
  'achRoutingNumber',
  'achAccountNumber',
  'achAccountType',
  'iban',
  'swift',
  'cryptoAddress',
  'cryptoNetwork',
  // Faltavam: sem eles todo saque Pix pelo fluxo unificado falhava no buildDestination.
  'pixKey',
  'pixKeyType',
] as const;

function publicTransaction(transaction: any) {
  return {
    id: transaction.id,
    customer: transaction.customer ?? null,
    customerEmail: transaction.customerEmail ?? null,
    country: transaction.country ?? null,
    paymentMethod: transaction.paymentMethod ?? null,
    processor: 'Koopfy Payments' as const,
    orderId: transaction.orderId ?? null,
    amount: Number(transaction.amount ?? 0),
    currency: transaction.currency ?? 'USD',
    amountUSD: Number(transaction.amountUSD ?? 0),
    fee: Number(transaction.fee ?? 0),
    netAmount: Number(transaction.netAmount ?? 0),
    reserveAmount:
      transaction.reserveAmount == null
        ? undefined
        : Number(transaction.reserveAmount),
    status: transaction.status,
    createdAt: transaction.createdAt,
    approvedAt: transaction.approvedAt ?? null,
    failedAt: transaction.failedAt ?? null,
    availableAt: transaction.availableAt ?? null,
    riskLevel: transaction.riskLevel ?? null,
    riskScore: transaction.riskScore ?? null,
    cardLast4: transaction.cardLast4 ?? null,
    cardBrand: transaction.cardBrand ?? null,
    failureCode: transaction.failureCode ?? null,
    failureMessage: transaction.failureMessage ?? null,
    orderShipped: Boolean(transaction.orderShipped),
    trackingCode: transaction.trackingCode ?? null,
    trackingCarrier: transaction.trackingCarrier ?? null,
    trackingUrl: transaction.trackingUrl ?? null,
    speiProofUrl: transaction.speiProofUrl ?? null,
    speiProofStatus: transaction.speiProofStatus ?? null,
    speiProofAnalysis: transaction.speiProofAnalysis
      ? {
          confidence: transaction.speiProofAnalysis.confidence,
          reason: transaction.speiProofAnalysis.reason,
        }
      : null,
  };
}

function paginated<T, U>(
  response: {
    data?: T[];
    total?: number;
    page?: number;
    pageSize?: number;
    totalPages?: number;
  },
  map: (item: T) => U,
) {
  return {
    data: (response.data ?? []).map(map),
    total: Number(response.total ?? 0),
    page: Number(response.page ?? 1),
    pageSize: Number(response.pageSize ?? 20),
    totalPages: Number(response.totalPages ?? 0),
  };
}

@Injectable()
export class KoopfyFinanceService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly transactions: TransactionsService,
    private readonly wallet: WalletService,
    private readonly disputes: DisputesService,
    private readonly transfers: TransfersService,
    private readonly methods: PaymentMethodsService,
    private readonly settings: SettingsService,
    private readonly apiKeys: ApiKeysService,
    private readonly anticipation?: AnticipationService,
  ) {}

  private seller(ctx: SellerCtx) {
    if (!ctx.seller || ctx.seller.status !== 'active') {
      throw new ConflictException('Conta financeira ainda não está ativa.');
    }
    return ctx.seller;
  }

  async getOverview(ctx: SellerCtx, requestedPeriod: unknown) {
    const seller = this.seller(ctx);
    const period = PERIODS.includes(requestedPeriod as Period)
      ? (requestedPeriod as Period)
      : '30d';
    const result = await this.dashboard.getData(seller.id, period);
    return {
      kpis: result.kpis,
      volumeChart: result.volumeChart,
      methodsDistribution: result.methodsDistribution,
      recentActivity: result.recentActivity,
      recurring: result.recurring,
    };
  }

  async listTransactions(ctx: SellerCtx, raw: Record<string, unknown>) {
    const seller = this.seller(ctx);
    const query = normalizeFinanceListQuery(raw, TRANSACTION_STATUSES);
    const response = await this.transactions.list(seller.id, {
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      method: query.method,
      search: query.search,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
    return paginated(response, publicTransaction);
  }

  async getTransaction(ctx: SellerCtx, id: string) {
    const seller = this.seller(ctx);
    return publicTransaction(await this.transactions.getById(seller.id, id));
  }

  async getWallet(ctx: SellerCtx) {
    return this.wallet.getBalance(this.seller(ctx).id);
  }

  async listWalletEntries(ctx: SellerCtx, raw: Record<string, unknown>) {
    const seller = this.seller(ctx);
    const query = normalizeFinanceListQuery(raw, []);
    const response = await this.wallet.getEntries(seller.id, {
      page: query.page,
      pageSize: query.pageSize,
      type: ['credit', 'debit'].includes(query.type ?? '')
        ? query.type
        : undefined,
      search: query.search,
    });
    return paginated(response, (entry: any) => ({
      id: entry.id,
      type: entry.type,
      description: entry.description,
      amount: Number(entry.amount ?? 0),
      status: entry.status,
      date: entry.date,
      transactionId: entry.transactionId ?? null,
      orderShipped: Boolean(entry.orderShipped),
      trackingCode: entry.trackingCode ?? null,
    }));
  }

  async getPayoutQuote(ctx: SellerCtx, query: Record<string, unknown>) {
    const method = String(query?.method ?? 'ach').toLowerCase();
    const amount = Number(String(query?.amount ?? '0').replace(',', '.'));
    return this.wallet.quotePayout(
      this.seller(ctx).id,
      Number.isFinite(amount) ? amount : 0,
      ['ach', 'iban', 'pix', 'crypto'].includes(method) ? method : 'ach',
    );
  }

  async getAnticipationQuote(ctx: SellerCtx) {
    return this.anticipationService().quote(this.seller(ctx).id);
  }

  async anticipate(ctx: SellerCtx, body: Record<string, unknown>) {
    return this.anticipationService().anticipate(this.seller(ctx).id, body ?? {});
  }

  private anticipationService() {
    if (!this.anticipation) throw new ConflictException('Antecipação indisponível no momento.');
    return this.anticipation;
  }

  async listPayouts(ctx: SellerCtx, raw: Record<string, unknown>) {
    const seller = this.seller(ctx);
    const query = normalizeFinanceListQuery(raw, []);
    const response = await this.wallet.getPayouts(seller.id, {
      page: query.page,
      pageSize: query.pageSize,
    });
    return paginated(response, (payout: any) => ({
      id: payout.id,
      method: payout.method,
      bankAccount: payout.bankAccount ?? null,
      cryptoAddress: payout.cryptoAddress ?? null,
      cryptoNetwork: payout.cryptoNetwork ?? null,
      amount: Number(payout.amount ?? 0),
      status: payout.status,
      date: payout.date,
      processedAt: payout.processedAt ?? null,
    }));
  }

  async requestPayout(
    ctx: SellerCtx,
    body: Record<string, unknown>,
    idempotencyKey: unknown,
  ) {
    // Fail-closed: sem a flag, esta rota não cria saque — nem pelo fluxo legado.
    if (process.env.KOOPFY_UNIFIED_PAYOUTS_ENABLED !== 'true') {
      throw new ConflictException(
        'Solicitação de saque temporariamente indisponível nesta experiência.',
      );
    }
    const seller = this.seller(ctx);
    const dto = Object.fromEntries(
      PAYOUT_FIELDS.flatMap((key) =>
        body?.[key] === undefined ? [] : [[key, body[key]]],
      ),
    ) as unknown as RequestPayoutDto;

    const result = await this.wallet.requestPayoutIdempotent(
      seller.id,
      dto,
      typeof idempotencyKey === 'string' ? idempotencyKey : '',
    );
    return {
      payoutId: result.payoutId,
      status: result.status,
      replayed: result.replayed,
    };
  }

  async getTransferTotals(ctx: SellerCtx) {
    return this.transfers.getTotals(this.seller(ctx).id);
  }

  async listTransfers(ctx: SellerCtx, raw: Record<string, unknown>) {
    const seller = this.seller(ctx);
    const query = normalizeFinanceListQuery(raw, TRANSFER_STATUSES);
    const response = await this.transfers.list(seller.id, {
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      search: query.search,
    });
    return paginated(response, (transfer: any) => ({
      id: transfer.id,
      amount: Number(transfer.amount ?? 0),
      fee: Number(transfer.fee ?? 0),
      netAmount: Number(transfer.netAmount ?? 0),
      status: transfer.status,
      releaseDate: transfer.releaseDate,
      createdAt: transfer.createdAt,
      paidAt: transfer.paidAt ?? null,
      failReason: transfer.failReason ?? null,
      retryable: transfer.status === 'failed',
      transactions: (transfer.transactions ?? []).map((item: any) => ({
        id: item.id,
        date: item.date,
        amount: Number(item.amount ?? 0),
        status: item.status,
      })),
    }));
  }

  async retryTransfer(ctx: SellerCtx, id: string) {
    return this.transfers.retry(this.seller(ctx).id, id);
  }

  async getDisputeStats(ctx: SellerCtx) {
    return this.disputes.getStats(this.seller(ctx).id);
  }

  async listDisputes(ctx: SellerCtx, raw: Record<string, unknown>) {
    const seller = this.seller(ctx);
    const query = normalizeFinanceListQuery(raw, DISPUTE_STATUSES);
    const response = await this.disputes.list(seller.id, {
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      search: query.search,
    });
    return paginated(response, (dispute: any) => ({
      id: dispute.id,
      transactionId: dispute.transactionId,
      customer: dispute.customer,
      customerEmail: dispute.customerEmail,
      amount: Number(dispute.amount ?? 0),
      currency: dispute.currency,
      reason: dispute.reason,
      reasonCode: dispute.reasonCode,
      status: dispute.status,
      deadline: dispute.deadline ?? null,
      createdAt: dispute.createdAt,
    }));
  }

  async respondToDispute(
    ctx: SellerCtx,
    id: string,
    body: { message?: unknown; evidenceUrls?: unknown },
  ) {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 4000) {
      throw new BadRequestException('A resposta deve ter entre 1 e 4000 caracteres.');
    }
    const evidenceUrls = Array.isArray(body.evidenceUrls)
      ? body.evidenceUrls
          .filter((url): url is string => typeof url === 'string')
          .slice(0, 12)
      : [];
    return this.disputes.respond(this.seller(ctx).id, id, {
      message,
      evidenceUrls,
    });
  }

  async listPaymentMethods(ctx: SellerCtx) {
    const methods = await this.methods.list(this.seller(ctx).id);
    return methods.map((method: any) => ({
      id: method.id,
      name: method.name,
      icon: method.icon,
      category: method.category,
      processor: 'Koopfy Payments' as const,
      countries: method.countries ?? [],
      enabled: Boolean(method.enabled),
      volume: Number(method.volume ?? 0),
      transactions: Number(method.transactions ?? 0),
      approvalRate: Number(method.approvalRate ?? 0),
      avgTicket: Number(method.avgTicket ?? 0),
      fees: method.fees,
      feePercentage: Number(method.feePercentage ?? 0),
      feeFixedUsd: Number(method.feeFixedUsd ?? 0),
      settlementDays: Number(method.settlementDays ?? 0),
      reservePercentage: Number(method.reservePercentage ?? 0),
      anticipationFeePct: Number(method.anticipationFeePct ?? 0),
      speiBeneficiaryName: method.speiBeneficiaryName,
    }));
  }

  async getPaymentMethodPerformance(ctx: SellerCtx, id: string) {
    return this.methods.getPerformance(this.seller(ctx).id, id);
  }

  async getIntegrationSettings(ctx: SellerCtx) {
    const result = await this.settings.get(this.seller(ctx).id, ctx.userId);
    return {
      webhooks: {
        url: result.webhooks?.url ?? '',
        events: result.webhooks?.events ?? {},
      },
    };
  }

  async updateIntegrationSettings(
    ctx: SellerCtx,
    body: { url?: unknown; events?: unknown },
  ) {
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('invalid protocol');
      } catch {
        throw new BadRequestException('Informe uma URL HTTPS válida.');
      }
    }
    const events =
      body.events && typeof body.events === 'object' && !Array.isArray(body.events)
        ? Object.fromEntries(
            Object.entries(body.events as Record<string, unknown>)
              .filter(([key, enabled]) =>
                /^[a-z]+\.[a-z]+$/.test(key) && typeof enabled === 'boolean',
              )
              .slice(0, 30),
          )
        : {};
    return this.settings.update(this.seller(ctx).id, ctx.userId, {
      section: 'webhooks',
      data: { url, events },
    });
  }

  async revealWebhookSecret(ctx: SellerCtx) {
    return this.settings.getWebhookSecret(this.seller(ctx).id);
  }

  async listOffers(ctx: SellerCtx) {
    this.seller(ctx);
    const offers = await this.settings.getOffers(ctx.userId);
    return offers.map((offer: any) => ({
      id: offer.id,
      name: offer.name,
      salesPageUrl: offer.sales_page_url,
      riskLevel: offer.risk_level,
      status: offer.status,
      createdAt: offer.created_at,
    }));
  }

  async addOffer(
    ctx: SellerCtx,
    body: { name?: unknown; salesPageUrl?: unknown; riskLevel?: unknown },
  ) {
    this.seller(ctx);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const salesPageUrl =
      typeof body.salesPageUrl === 'string' ? body.salesPageUrl.trim() : '';
    const riskLevel = body.riskLevel === 'GRAY' ? 'GRAY' : 'WHITE';
    if (!name || name.length > 200) {
      throw new BadRequestException('Informe o nome da oferta.');
    }
    try {
      new URL(salesPageUrl);
    } catch {
      throw new BadRequestException('Informe uma URL de vendas válida.');
    }
    return this.settings.addOffer(ctx.userId, { name, salesPageUrl, riskLevel });
  }

  async listApiKeys(ctx: SellerCtx) {
    const keys = await this.apiKeys.listKeys(this.seller(ctx).id);
    return keys.map((key: any) => ({
      id: key.id,
      name: key.name,
      publishableKey: key.publishable_key,
      keyPrefix: key.key_prefix,
      status: key.status,
      createdAt: key.created_at,
      expiresAt: key.expires_at ?? null,
      revokedAt: key.revoked_at ?? null,
    }));
  }

  async createApiKey(ctx: SellerCtx, name?: unknown) {
    const normalized = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    return this.apiKeys.createKey(
      this.seller(ctx).id,
      normalized || 'Integration key',
    );
  }

  async revokeApiKey(ctx: SellerCtx, id: string) {
    return this.apiKeys.revokeKeyImmediate(this.seller(ctx).id, id);
  }

  async rotateApiKey(ctx: SellerCtx, id: string) {
    return this.apiKeys.rotateKey(this.seller(ctx).id, id);
  }
}
