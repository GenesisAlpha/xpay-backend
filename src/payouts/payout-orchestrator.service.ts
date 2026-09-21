import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import {
  calculateKoopfyFee,
  providerIdempotencyKey,
  providerPayoutMinor,
  signPreviewConfirmation,
  verifyPreviewConfirmation,
} from './payout-domain';
import {
  ConfirmPayoutRequest,
  FeeRule,
  PayoutMethodKey,
  PayoutPreview,
} from './payout.types';
import {
  SellerPayoutAccountService,
  SellerPayoutMethodRow,
} from './seller-payout-account.service';
import {
  WhopMoney,
  WhopPayoutClient,
  WhopPayoutQuote,
} from './whop-payout.client';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface PayoutReservationInput {
  sellerId: string;
  idempotencyKey: string;
  requestHash: string;
  localMethodId: string;
  methodKey: PayoutMethodKey;
  speed: string | null;
  sourceCurrency: 'USD';
  destinationCurrency: string;
  grossMinor: number;
  koopfyFeeMinor: number;
  providerFeeMinor: number;
  providerPayoutMinor: number;
  netMinor: number;
  destinationAmountMinor: number;
  quoteId: string;
  quoteExpiresAt: string;
  exchangeRate: string | null;
  estimatedArrival: string | null;
  confirmedMinimumNetMinor: number;
  providerIdempotencyKey: string;
}

export interface PayoutReservationResult {
  payoutId: string;
  status: string;
  replayed: boolean;
}

export interface RequoteExecution {
  id: string;
  sellerId: string;
  localMethodId: string;
  methodKey: PayoutMethodKey;
  speed: string | null;
  sourceCurrency: string;
  providerPayoutMinor: number;
  localState: string;
}

@Injectable()
export class PayoutExecutionRepository {
  async getFeeRule(methodKey: PayoutMethodKey): Promise<FeeRule> {
    const { data, error } = await supabase
      .from('payout_fee_rules')
      .select('percentage_bps, fixed_fee_usd_cents')
      .eq('method_key', methodKey)
      .eq('enabled', true)
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) {
      throw new ConflictException(
        'Método de saque temporariamente indisponível.',
      );
    }
    return {
      percentageBps: Number(data.percentage_bps),
      fixedUsdCents: Number(data.fixed_fee_usd_cents),
    };
  }

  async findRequestReplay(
    sellerId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PayoutReservationResult | null> {
    const { data, error } = await supabase
      .from('payout_request_keys')
      .select('request_hash, response')
      .eq('seller_id', sellerId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) return null;
    if (data.request_hash !== requestHash) {
      throw new ConflictException(
        'Esta chave de idempotência já foi usada em outro saque.',
      );
    }
    if (!data.response) {
      throw new ConflictException(
        'Um saque com esta chave ainda está em processamento.',
      );
    }
    return parseReservationResult(data.response, true);
  }

  async reserve(
    input: PayoutReservationInput,
  ): Promise<PayoutReservationResult> {
    const { data, error } = await supabase.rpc(
      'request_provider_payout_idempotent',
      {
        p_seller_id: input.sellerId,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_seller_payout_method_id: input.localMethodId,
        p_method_key: input.methodKey,
        p_speed: input.speed,
        p_source_currency: input.sourceCurrency,
        p_destination_currency: input.destinationCurrency,
        p_gross_minor: input.grossMinor,
        p_koopfy_fee_minor: input.koopfyFeeMinor,
        p_provider_fee_minor: input.providerFeeMinor,
        p_provider_payout_minor: input.providerPayoutMinor,
        p_net_minor: input.netMinor,
        p_destination_amount_minor: input.destinationAmountMinor,
        p_quote_id: input.quoteId,
        p_quote_expires_at: input.quoteExpiresAt,
        p_exchange_rate: input.exchangeRate,
        p_estimated_arrival: input.estimatedArrival,
        p_confirmed_minimum_net_minor: input.confirmedMinimumNetMinor,
        p_provider_idempotency_key: input.providerIdempotencyKey,
      },
    );
    if (error) throw mapRpcError(error);
    return parseReservationResult(data, false);
  }

  async getRequoteExecution(
    sellerId: string,
    payoutId: string,
  ): Promise<RequoteExecution> {
    const { data, error } = await supabase
      .from('payout_executions')
      .select(
        'id, seller_id, seller_payout_method_id, method_key, delivery_speed, source_currency, provider_payout_minor, local_state',
      )
      .eq('id', payoutId)
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (error) throw storageUnavailable();
    if (!data) throw new NotFoundException('Saque não encontrado.');
    return {
      id: String(data.id),
      sellerId: String(data.seller_id),
      localMethodId: String(data.seller_payout_method_id),
      methodKey: data.method_key as PayoutMethodKey,
      speed:
        typeof data.delivery_speed === 'string' ? data.delivery_speed : null,
      sourceCurrency: String(data.source_currency),
      providerPayoutMinor: Number(data.provider_payout_minor),
      localState: String(data.local_state),
    };
  }

  async requeueRequoted(
    payoutId: string,
    input: {
      providerFeeMinor: number;
      netMinor: number;
      destinationAmountMinor: number;
      quoteId: string;
      quoteExpiresAt: string;
      exchangeRate: string | null;
      estimatedArrival: string | null;
      confirmedMinimumNetMinor: number;
    },
  ): Promise<{ payoutId: string; status: 'pending_review'; replayed: false }> {
    const { data, error } = await supabase.rpc('requeue_requoted_payout', {
      p_payout_id: payoutId,
      p_provider_fee_minor: input.providerFeeMinor,
      p_net_minor: input.netMinor,
      p_destination_amount_minor: input.destinationAmountMinor,
      p_quote_id: input.quoteId,
      p_quote_expires_at: input.quoteExpiresAt,
      p_exchange_rate: input.exchangeRate,
      p_estimated_arrival: input.estimatedArrival,
      p_confirmed_minimum_net_minor: input.confirmedMinimumNetMinor,
    });
    if (error) throw mapRpcError(error);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.requeued) {
      throw new InternalServerErrorException(
        'Não foi possível confirmar a nova cotação.',
      );
    }
    return { payoutId, status: 'pending_review', replayed: false };
  }
}

@Injectable()
export class PayoutOrchestratorService {
  constructor(
    private readonly accounts: SellerPayoutAccountService,
    private readonly whop: WhopPayoutClient,
    private readonly repository: PayoutExecutionRepository,
  ) {}

  async preview(
    sellerId: string,
    input: { methodId: string; speed?: string | null; grossMinor: number },
  ): Promise<PayoutPreview> {
    assertPreviewInput(input);
    const context = await this.quoteContext(
      sellerId,
      input.methodId,
      input.speed ?? null,
      input.grossMinor,
      randomQuoteKey(),
    );
    const previewExpiresAt = context.quote.expiresAt;
    const proofFields = {
      methodId: input.methodId,
      speed: input.speed ?? null,
      grossMinor: input.grossMinor,
      confirmedMinimumNetMinor: context.snapshot.netMinor,
      previewExpiresAt,
    };
    return {
      ...proofFields,
      methodKey: context.method.methodKey,
      consolidatedFeeMinor:
        context.koopfyFeeMinor + context.snapshot.providerFeeMinor,
      netMinor: context.snapshot.netMinor,
      sourceCurrency: 'USD',
      destinationCurrency: context.snapshot.destinationCurrency,
      destinationAmountMinor: context.snapshot.destinationAmountMinor,
      exchangeRate: context.snapshot.exchangeRate,
      estimatedArrival: context.snapshot.estimatedArrival,
      expiresAt: context.quote.expiresAt,
      confirmationToken: signPreviewConfirmation(
        proofFields,
        sellerId,
        previewSecret(),
      ),
    };
  }

  async confirm(
    sellerId: string,
    input: ConfirmPayoutRequest,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<PayoutReservationResult> {
    assertConfirmationInput(input, idempotencyKey);
    if (
      !verifyPreviewConfirmation(
        input,
        sellerId,
        input.confirmationToken,
        previewSecret(),
      ) ||
      new Date(input.previewExpiresAt).getTime() <= now.getTime()
    ) {
      throw new ConflictException(
        'A cotação expirou ou foi alterada. Revise novamente.',
      );
    }

    const requestHash = confirmationHash(sellerId, input);
    const replay = await this.repository.findRequestReplay(
      sellerId,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const context = await this.quoteContext(
      sellerId,
      input.methodId,
      input.speed,
      input.grossMinor,
      quoteKey('confirm', sellerId, idempotencyKey),
    );
    if (context.snapshot.netMinor < input.confirmedMinimumNetMinor) {
      throw new ConflictException(
        'A cotação mudou. Revise o valor líquido antes de confirmar.',
      );
    }

    return this.repository.reserve({
      sellerId,
      idempotencyKey,
      requestHash,
      localMethodId: input.methodId,
      methodKey: context.method.methodKey,
      speed: input.speed,
      sourceCurrency: 'USD',
      destinationCurrency: context.snapshot.destinationCurrency,
      grossMinor: input.grossMinor,
      koopfyFeeMinor: context.koopfyFeeMinor,
      providerFeeMinor: context.snapshot.providerFeeMinor,
      providerPayoutMinor: context.providerPayoutMinor,
      netMinor: context.snapshot.netMinor,
      destinationAmountMinor: context.snapshot.destinationAmountMinor,
      quoteId: context.quote.id,
      quoteExpiresAt: context.quote.expiresAt,
      exchangeRate: context.snapshot.exchangeRate,
      estimatedArrival: context.snapshot.estimatedArrival,
      confirmedMinimumNetMinor: input.confirmedMinimumNetMinor,
      providerIdempotencyKey: providerIdempotencyKey(
        `${sellerId}:${idempotencyKey}`,
      ),
    });
  }

  async reconfirm(
    sellerId: string,
    payoutId: string,
    confirmedMinimumNetMinor: number,
    idempotencyKey: string,
  ): Promise<PayoutReservationResult> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? '')) {
      throw new BadRequestException('Idempotency-Key inválido.');
    }
    assertMinor(confirmedMinimumNetMinor);
    const execution = await this.repository.getRequoteExecution(
      sellerId,
      payoutId,
    );
    if (execution.localState !== 'requote_required') {
      throw new ConflictException(
        'Este saque não aguarda uma nova confirmação.',
      );
    }
    const method = await this.accounts.assertOwnedActiveMethod(
      sellerId,
      execution.localMethodId,
    );
    const account = await this.readyAccount(sellerId);
    const selectedSpeed = normalizeSpeed(execution.speed);
    const [quote, savedMethods] = await Promise.all([
      this.whop.createQuote(
        {
          accountId: account.providerAccountId,
          amount: execution.providerPayoutMinor / 100,
          currency: execution.sourceCurrency.toLowerCase(),
          payoutMethodId: method.providerMethodId,
          speed: selectedSpeed,
          platformCoversFees: false,
        },
        quoteKey('reconfirm', payoutId, idempotencyKey),
      ),
      this.whop.listSavedPayoutMethods(account.providerAccountId),
    ]);
    const snapshot = quoteSnapshot(
      quote,
      execution.providerPayoutMinor,
      savedMethodEta(savedMethods, method.providerMethodId, selectedSpeed),
    );
    if (snapshot.netMinor < confirmedMinimumNetMinor) {
      throw new ConflictException(
        'A cotação mudou novamente. Revise o valor líquido.',
      );
    }
    return this.repository.requeueRequoted(payoutId, {
      providerFeeMinor: snapshot.providerFeeMinor,
      netMinor: snapshot.netMinor,
      destinationAmountMinor: snapshot.destinationAmountMinor,
      quoteId: quote.id,
      quoteExpiresAt: quote.expiresAt,
      exchangeRate: snapshot.exchangeRate,
      estimatedArrival: snapshot.estimatedArrival,
      confirmedMinimumNetMinor,
    });
  }

  private async quoteContext(
    sellerId: string,
    methodId: string,
    speed: string | null,
    grossMinor: number,
    quoteIdempotencyKey: string,
  ) {
    const [account, method] = await Promise.all([
      this.readyAccount(sellerId),
      this.accounts.assertOwnedActiveMethod(sellerId, methodId),
    ]);
    if (speed && !method.deliverySpeeds.includes(speed)) {
      throw new BadRequestException(
        'Velocidade indisponível para este método.',
      );
    }
    const rule = await this.repository.getFeeRule(method.methodKey);
    const koopfyFeeMinor = calculateKoopfyFee(grossMinor, rule);
    if (koopfyFeeMinor >= grossMinor) {
      throw new BadRequestException(
        'O valor informado não cobre as taxas mínimas deste método.',
      );
    }
    const payoutMinor = providerPayoutMinor(grossMinor, koopfyFeeMinor);
    const selectedSpeed = normalizeSpeed(speed);
    const [quote, savedMethods] = await Promise.all([
      this.whop.createQuote(
        {
          accountId: account.providerAccountId,
          amount: payoutMinor / 100,
          currency: 'usd',
          payoutMethodId: method.providerMethodId,
          speed: selectedSpeed,
          platformCoversFees: false,
        },
        quoteIdempotencyKey,
      ),
      this.whop.listSavedPayoutMethods(account.providerAccountId),
    ]);
    return {
      account,
      method,
      quote,
      koopfyFeeMinor,
      providerPayoutMinor: payoutMinor,
      snapshot: quoteSnapshot(
        quote,
        payoutMinor,
        savedMethodEta(savedMethods, method.providerMethodId, selectedSpeed),
      ),
    };
  }

  private async readyAccount(sellerId: string) {
    const readiness = await this.accounts.getReadiness(sellerId);
    if (readiness.status !== 'ready' || !readiness.payoutsEnabled) {
      throw new ConflictException('A conta de saque ainda não está pronta.');
    }
    const account = await this.accounts.ensureConnectedAccount(sellerId);
    if (!account.providerAccountId) {
      throw new ConflictException(
        'A conta de saque ainda está sendo preparada.',
      );
    }
    return account as typeof account & { providerAccountId: string };
  }
}

function quoteSnapshot(
  quote: WhopPayoutQuote,
  expectedPayoutMinor: number,
  estimatedArrival: string | null = null,
) {
  const amountMinor = moneyToMinor(quote.amount);
  const providerFeeMinor = moneyToMinor(quote.fee);
  const netMinor = moneyToMinor(quote.netAmount);
  const destinationAmountMinor = moneyToMinor(quote.destinationAmount);
  if (
    quote.amount.currency !== 'usd' ||
    quote.fee.currency !== 'usd' ||
    quote.netAmount.currency !== 'usd' ||
    amountMinor !== expectedPayoutMinor ||
    providerFeeMinor < 0 ||
    netMinor < 0 ||
    netMinor > expectedPayoutMinor
  ) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inconsistente.',
    );
  }
  return {
    providerFeeMinor,
    netMinor,
    destinationCurrency: quote.destinationAmount.currency.toUpperCase(),
    destinationAmountMinor,
    exchangeRate: quote.exchangeRate || null,
    estimatedArrival: quote.estimatedArrival ?? estimatedArrival,
  };
}

function savedMethodEta(
  methods: Array<{
    id: string;
    estimatedArrival: {
      standard: string | null;
      instant: string | null;
    } | null;
  }>,
  providerMethodId: string,
  speed: 'standard' | 'instant',
): string | null {
  return (
    methods.find((method) => method.id === providerMethodId)
      ?.estimatedArrival?.[speed] ?? null
  );
}

function moneyToMinor(money: WhopMoney): number {
  if (
    !Number.isInteger(money.decimals) ||
    money.decimals < 0 ||
    money.decimals > 18
  ) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inválida.',
    );
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(money.amount);
  if (!match) {
    throw new ServiceUnavailableException(
      'O provedor retornou uma cotação inválida.',
    );
  }
  const fraction = (match[2] ?? '').padEnd(money.decimals, '0');
  if (fraction.length > money.decimals) {
    throw new ServiceUnavailableException(
      'O provedor retornou precisão inesperada.',
    );
  }
  const minor =
    BigInt(match[1]) * 10n ** BigInt(money.decimals) + BigInt(fraction || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ServiceUnavailableException(
      'O valor cotado excede o limite suportado.',
    );
  }
  return Number(minor);
}

function assertPreviewInput(input: {
  methodId: string;
  speed?: string | null;
  grossMinor: number;
}) {
  if (typeof input.methodId !== 'string' || input.methodId.length < 8) {
    throw new BadRequestException('Método de saque inválido.');
  }
  assertMinor(input.grossMinor);
  if (input.speed != null && !['standard', 'instant'].includes(input.speed)) {
    throw new BadRequestException('Velocidade de saque inválida.');
  }
}

function assertConfirmationInput(
  input: ConfirmPayoutRequest,
  idempotencyKey: string,
) {
  assertPreviewInput(input);
  assertMinor(input.confirmedMinimumNetMinor);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? '')) {
    throw new BadRequestException('Idempotency-Key inválido.');
  }
  if (
    typeof input.previewExpiresAt !== 'string' ||
    Number.isNaN(Date.parse(input.previewExpiresAt)) ||
    typeof input.confirmationToken !== 'string' ||
    input.confirmationToken.length < 32
  ) {
    throw new BadRequestException('Confirmação de cotação inválida.');
  }
}

function assertMinor(value: number, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new BadRequestException('Valor do saque inválido.');
  }
}

function normalizeSpeed(
  value: string | null | undefined,
): 'standard' | 'instant' {
  return value === 'instant' ? 'instant' : 'standard';
}

function confirmationHash(
  sellerId: string,
  input: ConfirmPayoutRequest,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sellerId,
        methodId: input.methodId,
        speed: input.speed,
        grossMinor: input.grossMinor,
        confirmedMinimumNetMinor: input.confirmedMinimumNetMinor,
        previewExpiresAt: input.previewExpiresAt,
      }),
    )
    .digest('hex');
}

function randomQuoteKey(): string {
  return `koopfy_quote_${randomUUID().replace(/-/g, '')}`;
}

function quoteKey(scope: string, owner: string, key: string): string {
  return `koopfy_${scope}_${createHash('sha256')
    .update(`${owner}:${key}`)
    .digest('hex')
    .slice(0, 40)}`;
}

function previewSecret(): string {
  return process.env.PAYOUT_PREVIEW_HMAC_SECRET ?? '';
}

function parseReservationResult(
  value: any,
  replayedFallback: boolean,
): PayoutReservationResult {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row?.payoutId || typeof row.payoutId !== 'string') {
    throw new InternalServerErrorException(
      'Não foi possível confirmar o saque.',
    );
  }
  return {
    payoutId: row.payoutId,
    status: String(row.status ?? 'pending_review'),
    replayed:
      typeof row.replayed === 'boolean' ? row.replayed : replayedFallback,
  };
}

function mapRpcError(error: { code?: string; message?: string }) {
  if (['KP402', 'KP403', 'KP404'].includes(error.code ?? '')) {
    return new BadRequestException(safeRpcMessage(error.code));
  }
  if (['KP409', 'KP425'].includes(error.code ?? '')) {
    return new ConflictException(safeRpcMessage(error.code));
  }
  if (error.code === 'PGRST202' || error.code === '42883') {
    return storageUnavailable();
  }
  if (error.code === 'KP500') {
    return new InternalServerErrorException(
      'Não foi possível confirmar o saque.',
    );
  }
  return new BadRequestException('Não foi possível processar o saque.');
}

function safeRpcMessage(code?: string): string {
  const messages: Record<string, string> = {
    KP402: 'Saldo disponível insuficiente.',
    KP403: 'Método de saque inválido para esta conta.',
    KP404: 'Conta ou saque não encontrado.',
    KP409: 'O saque não pode ser alterado neste estado.',
    KP425: 'Um saque com esta chave ainda está em processamento.',
  };
  return messages[code ?? ''] ?? 'Não foi possível processar o saque.';
}

function storageUnavailable() {
  return new ServiceUnavailableException(
    'Solicitação de saque temporariamente indisponível.',
  );
}
