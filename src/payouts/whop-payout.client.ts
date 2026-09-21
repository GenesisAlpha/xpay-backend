import { Injectable } from "@nestjs/common";
import {
  WHOP_API_URL_DEFAULT,
  WHOP_ENV_ACCOUNT_ID,
  WhopAccountsService,
} from "../orchestrator/whop/whop-accounts.service";
import { WhopPayoutStatus } from "./payout.types";

const DEFAULT_API_VERSION = "2026-09-15";
const DEFAULT_TIMEOUT_MS = 10_000;
const PAYOUT_STATUSES: readonly WhopPayoutStatus[] = [
  "requested",
  "in_review",
  "processing",
  "completed",
  "failed",
  "canceled",
  "denied",
  "reversed",
];

type JsonRecord = Record<string, unknown>;

export interface WhopMoney {
  amount: string;
  currency: string;
  decimals: number;
  displayDecimals: number;
}

export interface WhopPayoutQuote {
  id: string;
  amount: WhopMoney;
  fee: WhopMoney;
  netAmount: WhopMoney;
  destinationAmount: WhopMoney;
  exchangeRate: string;
  estimatedArrival: string | null;
  expiresAt: string;
  quoteToken: string;
}

export interface WhopPayout {
  id: string;
  status: WhopPayoutStatus;
  amount: string;
  currency: string;
  feeAmount: string;
  markupFee: string;
  netAmount: string;
  destinationAmount: string | null;
  destinationCurrency: string | null;
  exchangeRate: string | null;
  estimatedArrival: string | null;
  createdAt: string;
  failure: {
    code: string | null;
    message: string | null;
    fundsReturnedAt: string | null;
  } | null;
}

export interface WhopSavedPayoutMethod {
  id: string;
  accountReference: string | null;
  destinationCurrency: string | null;
  institutionName: string | null;
  estimatedArrival: {
    standard: string | null;
    instant: string | null;
  } | null;
  nickname: string | null;
  isDefault: boolean;
  status: string;
  supportedPayoutMethod: {
    name: string | null;
    deliveryType: string;
    supportsStandardDelivery: boolean;
    supportsInstantDelivery: boolean;
  } | null;
}

export interface WhopSupportedPayoutMethod {
  id: string;
  name: string | null;
  iconUrl: string | null;
  deliveryType: string;
  supportsStandardDelivery: boolean;
  supportsInstantDelivery: boolean;
  requiredFields: Array<{
    id: string;
    label: string;
    type: string;
    inputType: string;
    required: boolean;
    sensitive: boolean;
    options: string[] | null;
    validation: string | null;
    placeholder: string | null;
  }> | null;
}

export interface WhopVerification {
  id: string;
  status: string;
  url: string | null;
}

export interface CreateWhopPayoutInput {
  accountId: string;
  amount: number;
  currency: string;
  payoutMethodId: string;
  quoteToken?: string;
  speed?: "standard" | "instant";
  platformCoversFees?: boolean;
  metadata?: Record<string, string>;
  notes?: string;
}

export interface CreateWhopQuoteInput {
  accountId: string;
  amount: number;
  currency: string;
  payoutMethodId: string;
  speed?: "standard" | "instant";
  platformCoversFees?: boolean;
}

export class WhopPayoutApiError extends Error {
  readonly name = "WhopPayoutApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly idempotencyReplay = false,
  ) {
    super(publicErrorMessage(code));
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

@Injectable()
export class WhopPayoutClient {
  constructor(private readonly accounts: WhopAccountsService) {}

  async createConnectedAccount(
    input: {
      email: string;
      title?: string;
      country?: string;
      website?: string;
      metadata?: Record<string, unknown>;
      sendCustomerEmails?: boolean;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; title: string | null }> {
    const value = await this.request("/accounts", {
      method: "POST",
      idempotencyKey,
      body: JSON.stringify({
        email: input.email,
        title: input.title,
        country: input.country,
        website: input.website,
        metadata: input.metadata,
        send_customer_emails: input.sendCustomerEmails ?? false,
      }),
    });
    const record = expectRecord(value);
    return {
      id: expectPrefixedString(record.id, "biz_"),
      title: optionalString(record.title),
    };
  }

  async createVerificationSession(
    accountId: string,
    input: JsonRecord,
    idempotencyKey: string,
  ): Promise<WhopVerification> {
    const value = await this.request(
      `/verifications?account_id=${encodeURIComponent(accountId)}`,
      {
        method: "POST",
        idempotencyKey,
        body: JSON.stringify(input),
      },
    );
    return parseVerification(value);
  }

  async listVerifications(accountId: string): Promise<WhopVerification[]> {
    const value = await this.request(
      `/verifications?account_id=${encodeURIComponent(accountId)}`,
      { method: "GET" },
    );
    return parseCollection(value).map(parseVerification);
  }

  async listSupportedPayoutMethods(
    accountId: string,
    options: {
      country?: string;
      amount?: number;
      currency?: string;
      supportedPayoutMethodId?: string;
      destinationCurrency?: string;
    } = {},
  ): Promise<WhopSupportedPayoutMethod[]> {
    const query = queryString({
      account_id: accountId,
      country: options.country,
      amount: options.amount,
      currency: options.currency,
      supported_payout_method_id: options.supportedPayoutMethodId,
      destination_currency: options.destinationCurrency,
      first: 100,
    });
    const value = await this.request(`/payouts/supported_methods?${query}`, {
      method: "GET",
    });
    return parseCollection(value).map(parseSupportedMethod);
  }

  async listSavedPayoutMethods(
    accountId: string,
  ): Promise<WhopSavedPayoutMethod[]> {
    const query = queryString({ account_id: accountId, first: 100 });
    const value = await this.request(`/payouts/methods?${query}`, {
      method: "GET",
    });
    return parseCollection(value).map(parseSavedMethod);
  }

  async createSavedPayoutMethod(
    input: {
      accountId: string;
      supportedPayoutMethodId: string;
      destinationCurrency?: string;
      fields: Record<string, string>;
      nickname?: string;
      isDefault?: boolean;
    },
    idempotencyKey: string,
  ): Promise<WhopSavedPayoutMethod> {
    const value = await this.request("/payouts/methods", {
      method: "POST",
      idempotencyKey,
      body: JSON.stringify({
        account_id: input.accountId,
        supported_payout_method_id: input.supportedPayoutMethodId,
        destination_currency: input.destinationCurrency,
        fields: input.fields,
        nickname: input.nickname,
        is_default: input.isDefault ?? false,
      }),
    });
    return parseSavedMethod(value);
  }

  async deleteSavedPayoutMethod(id: string): Promise<{ id: string }> {
    const value = await this.request(
      `/payouts/methods/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const record = expectRecord(value);
    return { id: expectPrefixedString(record.id, "potk_") };
  }

  async createQuote(
    input: CreateWhopQuoteInput,
    idempotencyKey: string,
  ): Promise<WhopPayoutQuote> {
    const value = await this.request("/payouts/quotes", {
      method: "POST",
      idempotencyKey,
      body: JSON.stringify(payoutRequestBody(input)),
    });
    return parseQuote(value);
  }

  async createPayout(
    input: CreateWhopPayoutInput,
    idempotencyKey: string,
  ): Promise<WhopPayout> {
    const value = await this.request("/payouts", {
      method: "POST",
      idempotencyKey,
      body: JSON.stringify({
        ...payoutRequestBody(input),
        quote_token: input.quoteToken,
        metadata: input.metadata,
        notes: input.notes,
      }),
    });
    return parsePayout(value);
  }

  async retrievePayout(id: string, accountId: string): Promise<WhopPayout> {
    const query = queryString({ account_id: accountId });
    const value = await this.request(
      `/payouts/${encodeURIComponent(id)}?${query}`,
      { method: "GET" },
    );
    return parsePayout(value);
  }

  private async request(
    path: string,
    init: RequestInit & { idempotencyKey?: string },
  ): Promise<unknown> {
    const accountId =
      process.env.WHOP_MASTER_ACCOUNT_ID?.trim() || WHOP_ENV_ACCOUNT_ID;
    const account = await this.accounts.getById(accountId);
    if (!account?.apiKey) {
      throw new WhopPayoutApiError(500, "master_account_not_configured", false);
    }

    const baseUrl = normalizeApiBase(account.api_url || WHOP_API_URL_DEFAULT);
    const timeoutMs = parseTimeout(process.env.WHOP_PAYOUT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Api-Version-Date":
            process.env.WHOP_API_VERSION_DATE?.trim() || DEFAULT_API_VERSION,
          ...(init.idempotencyKey
            ? { "Idempotency-Key": init.idempotencyKey }
            : {}),
        },
      });
    } catch {
      throw new WhopPayoutApiError(0, "provider_unavailable", true);
    }

    const json = await response.json().catch(() => null);
    if (!response.ok) throw mapHttpError(response.status);
    if (json === null) {
      throw new WhopPayoutApiError(502, "invalid_provider_response", true);
    }
    return json;
  }
}

function payoutRequestBody(input: CreateWhopQuoteInput) {
  return {
    account_id: input.accountId,
    amount: input.amount,
    currency: input.currency,
    payout_method_id: input.payoutMethodId,
    speed: input.speed ?? "standard",
    platform_covers_fees: input.platformCoversFees ?? false,
  };
}

function normalizeApiBase(value: string): string {
  return `${value.replace(/\/$/, "").replace(/\/api\/v1$/, "")}/api/v1`;
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function mapHttpError(status: number): WhopPayoutApiError {
  if (status === 401) {
    return new WhopPayoutApiError(status, "authentication_failed", false);
  }
  if (status === 403) {
    return new WhopPayoutApiError(status, "permission_denied", false);
  }
  if (status === 409) {
    return new WhopPayoutApiError(status, "idempotency_conflict", false, true);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new WhopPayoutApiError(status, "provider_validation_failed", false);
  }
  return new WhopPayoutApiError(status, "provider_unavailable", status >= 500);
}

function publicErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    master_account_not_configured: "Conta master de payouts não configurada.",
    authentication_failed: "Falha de autenticação no provedor de payouts.",
    permission_denied:
      "A conta não tem permissão para esta operação de payout.",
    idempotency_conflict: "A operação de payout já foi recebida pelo provedor.",
    provider_validation_failed: "O provedor recusou os dados do payout.",
    provider_unavailable:
      "O provedor de payouts está temporariamente indisponível.",
    invalid_provider_response: "O provedor retornou uma resposta inválida.",
  };
  return messages[code] || "Falha na operação de payout.";
}

function parseQuote(value: unknown): WhopPayoutQuote {
  try {
    const record = expectRecord(value);
    if (record.object !== "payout_quote") throw new Error("object");
    return {
      id: expectPrefixedString(record.id, "pout_"),
      amount: parseMoney(record.amount),
      fee: parseMoney(record.fee),
      netAmount: parseMoney(record.net_amount),
      destinationAmount: parseMoney(record.destination_amount),
      exchangeRate: expectFiniteNumber(record.exchange_rate).toString(),
      estimatedArrival: nullableDateString(record.estimated_arrival),
      expiresAt: expectDateString(record.expires_at),
      quoteToken: expectString(record.quote_token),
    };
  } catch {
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function parsePayout(value: unknown): WhopPayout {
  try {
    const record = expectRecord(value);
    const status = expectString(record.status) as WhopPayoutStatus;
    if (!PAYOUT_STATUSES.includes(status)) throw new Error("status");
    return {
      id: expectOneOfPrefixes(record.id, ["wdrl_", "cofr_"]),
      status,
      amount: expectDecimal(record.amount),
      currency: expectCurrency(record.currency),
      feeAmount: expectDecimal(record.fee_amount),
      markupFee: expectDecimal(record.markup_fee),
      netAmount: expectDecimal(record.net_amount),
      destinationAmount: nullableDecimal(record.destination_amount),
      destinationCurrency: nullableCurrency(record.destination_currency),
      exchangeRate:
        record.exchange_rate === null || record.exchange_rate === undefined
          ? null
          : expectFiniteNumber(record.exchange_rate).toString(),
      estimatedArrival: nullableDateString(record.estimated_arrival),
      createdAt: expectDateString(record.created_at),
      failure: parseFailure(record.failure),
    };
  } catch (error) {
    if (error instanceof WhopPayoutApiError) throw error;
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function parseVerification(value: unknown): WhopVerification {
  try {
    const record = expectRecord(value);
    const status = expectString(record.status);
    if (
      ![
        'not_started',
        'pending',
        'processing',
        'manual_review',
        'approved',
        'rejected',
        'action_required',
      ].includes(status)
    ) {
      throw new Error('status');
    }
    return {
      id: expectString(record.id),
      status,
      url: optionalString(
        record.session_url ?? record.url ?? record.verification_url,
      ),
    };
  } catch {
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function parseSupportedMethod(value: unknown): WhopSupportedPayoutMethod {
  try {
    const record = expectRecord(value);
    const rawFields = record.required_fields;
    return {
      id: expectPrefixedString(record.id, "podst_"),
      name: optionalString(record.name),
      iconUrl: optionalString(record.icon_url),
      deliveryType: expectString(record.delivery_type),
      supportsStandardDelivery: expectBoolean(
        record.supports_standard_delivery,
      ),
      supportsInstantDelivery: expectBoolean(record.supports_instant_delivery),
      requiredFields:
        rawFields === null || rawFields === undefined
          ? null
          : expectArray(rawFields).map((field) => {
              const item = expectRecord(field);
              return {
                id: expectString(item.id),
                label: expectString(item.label),
                type: expectString(item.type),
                inputType: expectString(item.input_type),
                required: expectBoolean(item.required),
                sensitive: expectBoolean(item.sensitive),
                options:
                  item.options === null || item.options === undefined
                    ? null
                    : expectArray(item.options).map(expectString),
                validation: optionalString(item.validation),
                placeholder: optionalString(item.placeholder),
              };
            }),
    };
  } catch {
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function parseSavedMethod(value: unknown): WhopSavedPayoutMethod {
  try {
    const record = expectRecord(value);
    const supported = record.supported_payout_method;
    return {
      id: expectPrefixedString(record.id, "potk_"),
      accountReference: optionalString(record.account_reference),
      destinationCurrency: nullableCurrency(record.destination_currency),
      institutionName: optionalString(record.institution_name),
      estimatedArrival: parseEstimatedArrival(record.estimated_arrival),
      nickname: optionalString(record.nickname),
      isDefault: expectBoolean(record.is_default),
      status: expectString(record.status),
      supportedPayoutMethod:
        supported === null || supported === undefined
          ? null
          : parseSupportedMethodSummary(supported),
    };
  } catch {
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function parseSupportedMethodSummary(value: unknown) {
  const record = expectRecord(value);
  return {
    name: optionalString(record.name),
    deliveryType: expectString(record.delivery_type),
    supportsStandardDelivery: expectBoolean(record.supports_standard_delivery),
    supportsInstantDelivery: expectBoolean(record.supports_instant_delivery),
  };
}

function parseEstimatedArrival(value: unknown) {
  if (value === null || value === undefined) return null;
  const record = expectRecord(value);
  return {
    standard: nullableDateString(record.standard),
    instant: nullableDateString(record.instant),
  };
}

function parseMoney(value: unknown): WhopMoney {
  const record = expectRecord(value);
  return {
    amount: expectDecimal(record.amount),
    currency: expectCurrency(record.currency),
    decimals: expectInteger(record.decimals),
    displayDecimals: expectInteger(record.display_decimals),
  };
}

function parseFailure(value: unknown): WhopPayout["failure"] {
  if (value === null || value === undefined) return null;
  const record = expectRecord(value);
  return {
    code: optionalString(record.code),
    message: optionalString(record.message),
    fundsReturnedAt: nullableDateString(record.funds_returned_at),
  };
}

function parseCollection(value: unknown): unknown[] {
  try {
    return expectArray(expectRecord(value).data);
  } catch {
    throw new WhopPayoutApiError(502, "invalid_provider_response", true);
  }
}

function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.toString();
}

function expectRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("record");
  }
  return value as JsonRecord;
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("array");
  return value;
}

function expectString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("string");
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return expectString(value);
}

function expectPrefixedString(value: unknown, prefix: string): string {
  const result = expectString(value);
  if (!new RegExp(`^${escapeRegex(prefix)}[A-Za-z0-9_]+$`).test(result)) {
    throw new Error("prefix");
  }
  return result;
}

function expectOneOfPrefixes(value: unknown, prefixes: string[]): string {
  const result = expectString(value);
  if (
    !prefixes.some((prefix) =>
      new RegExp(`^${escapeRegex(prefix)}[A-Za-z0-9_]+$`).test(result),
    )
  ) {
    throw new Error("prefix");
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("boolean");
  return value;
}

function expectInteger(value: unknown): number {
  if (!Number.isInteger(value)) throw new Error("integer");
  return value as number;
}

function expectFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("number");
  }
  return value;
}

function expectDecimal(value: unknown): string {
  const result = expectString(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(result)) throw new Error("decimal");
  return result;
}

function nullableDecimal(value: unknown): string | null {
  return value === null || value === undefined ? null : expectDecimal(value);
}

function expectCurrency(value: unknown): string {
  const result = expectString(value);
  if (!/^[a-z]{3,5}$/.test(result)) throw new Error("currency");
  return result;
}

function nullableCurrency(value: unknown): string | null {
  return value === null || value === undefined ? null : expectCurrency(value);
}

function expectDateString(value: unknown): string {
  const result = expectString(value);
  if (Number.isNaN(Date.parse(result))) throw new Error("date");
  return result;
}

function nullableDateString(value: unknown): string | null {
  return value === null || value === undefined ? null : expectDateString(value);
}
