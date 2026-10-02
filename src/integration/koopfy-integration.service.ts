// integration/koopfy-integration.service.ts
//
// Status do onboarding + provisionamento da integração "Koopfy Pay" para o
// serviço checkout. O checkout chama estes métodos (via controller) para:
//   • saber se o seller já pode usar o Koopfy Pay como gateway;
//   • obter uma API key (sk_live_) ao ativar — emitida UMA vez aqui, pois o pay
//     só guarda o hash da chave (nunca o texto puro).

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../lib/supabase.client';
import { StorageService } from '../lib/storage.service';
import { generateKey, hashKey } from '../utils/apikeys.utils';
import { SellerCtx } from './cross-service-jwt.guard';
import {
  AccountState,
  accountAliasEmail,
  accountState,
  listSellerAccounts,
  normalizeEmail,
  resolveAccountUserId,
} from './seller-accounts';

const CREATE_ACCOUNT_FAILED = 'Não foi possível criar a conta financeira agora. Tente novamente.';
import { WalletService } from '../dashboard/services/services';
import { ActivationRequestsService } from '../activation/activation-requests.service';
import { WhopConnectService } from '../orchestrator/whop/whop-connect.service';
import { WhopLinkedAccountsService, sellerMayOperate } from '../orchestrator/whop/whop-linked.service';
import { isLinkedProviderAccountId, sellerExternalProviderView, toLinkedProviderAccountId } from '../orchestrator/whop/whop-linked';
import { connectionChoice, defaultRoutingFeePct } from '../orchestrator/routing/seller-routing';
import { SellerProviderAccountsService } from '../orchestrator/seller-provider/seller-provider-accounts.service';
import { SellerRoutingService } from '../orchestrator/routing/seller-routing.service';
import { OwnAccountFinanceService } from '../orchestrator/own-finance/own-account-finance.service';
import {
  SellerProviderKind,
  combineExternalProviderView,
  validatePaypalCredentials,
  validateStripeKeys,
} from '../orchestrator/seller-provider/seller-provider-accounts';
import { connectedActivationBlocker } from '../orchestrator/whop/whop-connected';
import {
  buildSubscriptionReport,
  filterTransactionsByWorkspace,
  loadSubscriptionReport,
  SubscriptionMembershipRow,
  SubscriptionTransactionRow,
} from './subscription-report';

/**
 * Moeda de exibição da carteira. `wallet_balance` guarda centavos sem moeda —
 * o dash-pay já exibe tudo em EUR (lib/mock-data.ts#formatCurrency), então
 * devolvemos a mesma referência para o checkout formatar igual.
 */
const WALLET_CURRENCY = 'EUR';

interface ProvisionBody {
  name?: string;
  whatsapp?: string;
  instagram?: string;
  avatarBase64?: string;
  avatarMime?: string;
}

@Injectable()
export class KoopfyIntegrationService {
  constructor(
    private readonly storage: StorageService,
    private readonly wallet: WalletService,
    private readonly activationRequests: ActivationRequestsService,
    private readonly whopConnect: WhopConnectService,
    // Modo conta externa: o seller conecta a conta Whop dele pelo painel
    // (liberado para todos; o CRM só corta).
    private readonly whopLinked: WhopLinkedAccountsService,
    // Stripe e PayPal próprios do seller (mesmo modo conta externa).
    private readonly sellerProviders: SellerProviderAccountsService,
    // Roteamento de contas (várias contas por provedor).
    private readonly sellerRouting: SellerRoutingService,
    // Saldo, saque e histórico de cada conta própria.
    private readonly ownFinance: OwnAccountFinanceService,
  ) {}

  /**
   * Situação do provedor externo para o painel: os campos de sempre (Whop) +
   * `providers` com Whop, Stripe e PayPal. null quando o CRM cortou o modo.
   */
  async externalProviderStatus(sellerId: string | null) {
    const whop = sellerExternalProviderView(
      sellerId ? await this.whopLinked.status(sellerId).catch(() => null) : this.whopLinked.publicView(null),
    );
    const rows = sellerId
      ? await this.sellerProviders.rows(sellerId).catch(() => ({ stripe: null, paypal: null }))
      : { stripe: null, paypal: null };
    // Roteamento: quantas contas de cada provedor e se está ligado (+ taxa).
    const [counts, routing] = sellerId
      ? await Promise.all([
        this.sellerProviders.connectedCounts(sellerId).catch(() => ({ whop: 0, stripe: 0, paypal: 0 })),
        this.sellerRouting.settings(sellerId).catch(() => null),
      ])
      : [{ whop: 0, stripe: 0, paypal: 0 }, null];
    const whopCount = counts.whop + (whop?.connected ? 1 : 0);
    return combineExternalProviderView(whop, rows, {
      counts: { whop: whopCount, stripe: counts.stripe, paypal: counts.paypal },
      routing: { enabled: Boolean(routing?.enabled), feePct: routing?.feePct ?? defaultRoutingFeePct() },
    });
  }

  // ─── Roteamento de contas ───────────────────────────────────────────────

  routingView(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.sellerRouting.view(ctx.seller.id);
  }

  updateRouting(ctx: SellerCtx, body: Record<string, any>) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.sellerRouting.update(ctx.seller.id, body ?? {}, `seller:${ctx.userId}`);
  }

  updateRoutingAccount(ctx: SellerCtx, accountId: string, body: Record<string, any>) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.sellerRouting.updateAccount(ctx.seller.id, accountId, body ?? {}, `seller:${ctx.userId}`);
  }

  routingHistory(ctx: SellerCtx, limit?: unknown) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.sellerRouting.history(ctx.seller.id, limit);
  }

  // ─── Financeiro das contas próprias ─────────────────────────────────────
  // Saldo, destinos, saque e histórico de cada conta (Whop, Stripe, PayPal),
  // e a visão que soma todas por moeda. Ver OwnAccountFinanceService.

  externalFinanceOverview(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.ownFinance.overview(ctx.seller.id);
  }

  externalAccountWallet(ctx: SellerCtx, accountId: string) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.ownFinance.wallet(ctx.seller.id, accountId);
  }

  externalAccountWithdraw(ctx: SellerCtx, accountId: string, body: Record<string, any>) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.ownFinance.withdraw(
      ctx.seller.id,
      accountId,
      { amountCents: body?.amountCents, currency: body?.currency, payoutMethodId: body?.payoutMethodId },
      `seller:${ctx.userId}`,
    );
  }

  /**
   * Antes de conectar uma conta: o que fazer com a que já recebe no mesmo
   * grupo (ver `connectionChoice`). `multiAccount` liga o roteamento (com o
   * aceite da taxa), `replace` troca a atual, e sem nenhum dos dois o painel
   * recebe 409 ROUTING_CHOICE_REQUIRED, com a taxa, para perguntar.
   */
  private async prepareConnection(
    sellerId: string,
    provider: 'whop' | SellerProviderKind,
    body: Record<string, any>,
    actor: string,
  ): Promise<{ enabledRouting: boolean }> {
    const settings = await this.sellerRouting.settings(sellerId);
    const group = provider === 'paypal' ? 'paypal' : 'card';
    const occupying = settings.enabled
      ? []
      : (await this.sellerRouting.loadPool(sellerId, settings).catch(() => []))
        .filter(entry => entry.group === group && entry.connection === 'active');

    const choice = connectionChoice({
      routingEnabled: settings.enabled,
      multiAccount: body?.multiAccount,
      replace: body?.replace,
      occupying: occupying.length,
    });
    if (choice === 'proceed') return { enabledRouting: false };
    if (choice === 'enable') {
      await this.sellerRouting.update(sellerId, { enabled: true, acceptFee: body?.acceptFee === true }, actor);
      return { enabledRouting: true };
    }

    // 400, não 409: o checkout só repassa ao painel o motivo de 400/422.
    throw new BadRequestException({
      error: 'ROUTING_CHOICE_REQUIRED',
      message: 'Você já tem uma conta recebendo. Ligue o roteamento para usar as duas, ou troque a conta atual.',
      details: {
        feePct: settings.feePct,
        feeAccepted: Boolean(settings.feeAcceptedAt),
        current: occupying.map(entry => ({
          id: entry.id,
          provider: entry.provider,
          name: entry.config.label ?? entry.accountName,
        })),
      },
    });
  }

  /**
   * O roteamento foi ligado só para esta conexão e ela falhou (chave errada,
   * provedor fora do ar): volta a desligar. Sem isto o seller ficaria pagando
   * a taxa de roteamento com a mesma conta única de antes.
   */
  private async connectWithChoice<T>(
    sellerId: string,
    prepared: { enabledRouting: boolean },
    actor: string,
    connect: () => Promise<T>,
  ): Promise<T> {
    try {
      return await connect();
    } catch (err) {
      if (prepared.enabledRouting) {
        await this.sellerRouting.update(sellerId, { enabled: false }, actor)
          .catch((rollback: any) => console.error(`[Integration] roteamento de ${sellerId} não desligado após conexão falha:`, rollback?.message));
      }
      throw err;
    }
  }

  /**
   * Desconecta UMA conta (com o roteamento há várias do mesmo provedor).
   * A Whop principal segue o desligar de sempre (volta a 'allowed', chave
   * guardada para os webhooks de vendas antigas).
   */
  async disconnectOwnAccount(ctx: SellerCtx, accountId: string) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    const sellerId = ctx.seller.id;
    const actor = `seller:${ctx.userId}`;
    if (isLinkedProviderAccountId(accountId)) {
      const row = await this.whopLinked.getRow(sellerId);
      if (!row?.whop_account_id || toLinkedProviderAccountId(row.whop_account_id) !== accountId) {
        throw new NotFoundException('Conta não encontrada ou já desconectada.');
      }
      await this.whopLinked.disconnect(sellerId, 'desconectado pelo seller', actor, { bySeller: true });
    } else {
      await this.sellerProviders.disconnectById(sellerId, accountId, actor);
    }
    return this.externalProviderStatus(sellerId);
  }

  /** Conta do pay de quem conecta; cria a principal quando ainda não existe. */
  private async sellerForConnection(email: string, accountSellerId: string | null): Promise<{ sellerId: string; userId: string }> {
    const normEmail = normalizeEmail(email);
    if (!normEmail) throw new NotFoundException('Conta Koopfy Pay não encontrada.');

    let userId = await resolveAccountUserId(normEmail, accountSellerId);
    if (!userId) userId = (await this.provision(normEmail, {})).userId;

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (!seller?.id) throw new NotFoundException('Não foi possível criar a sua conta Koopfy Pay agora. Tente de novo.');
    return { sellerId: seller.id, userId };
  }

  /**
   * Conecta a Stripe ou o PayPal do próprio seller. Mesma regra da Whop: quem
   * ainda não tem conta no pay ganha a principal agora. As credenciais são
   * conferidas ANTES — pedido inválido não pode deixar conta vazia para trás.
   */
  async connectOwnProvider(
    email: string,
    accountSellerId: string | null,
    provider: SellerProviderKind,
    body: Record<string, any>,
  ) {
    try {
      if (provider === 'stripe') validateStripeKeys(String(body?.secretKey ?? ''), String(body?.publishableKey ?? ''));
      else validatePaypalCredentials(body ?? {});
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }

    const { sellerId, userId } = await this.sellerForConnection(email, accountSellerId);
    const actor = `seller:${userId}`;
    const prepared = await this.prepareConnection(sellerId, provider, body ?? {}, actor);
    await this.connectWithChoice(sellerId, prepared, actor, () => provider === 'stripe'
      ? this.sellerProviders.connectStripe(
        sellerId,
        { secretKey: body?.secretKey, publishableKey: body?.publishableKey, label: body?.label ?? null },
        actor,
      )
      : this.sellerProviders.connectPaypal(
        sellerId,
        { clientId: body?.clientId, clientSecret: body?.clientSecret, mode: body?.mode, label: body?.label ?? null },
        actor,
      ));
    return this.externalProviderStatus(sellerId);
  }

  async disconnectOwnProvider(ctx: SellerCtx, provider: SellerProviderKind) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    await this.sellerProviders.disconnect(ctx.seller.id, provider, `seller:${ctx.userId}`);
    return this.externalProviderStatus(ctx.seller.id);
  }

  /**
   * Conecta a conta Whop do próprio seller. Quem ainda não tem conta no pay
   * ganha a principal agora, por baixo (como a liberação do CRM fazia): é ela
   * que guarda a conexão e recebe o registro das vendas. Conta escolhida pelo
   * workspace (header) é conferida como do mesmo usuário.
   */
  async connectExternalProvider(
    email: string,
    accountSellerId: string | null,
    apiKey: string,
    label: string | null = null,
    choice: { multiAccount?: unknown; acceptFee?: unknown; replace?: unknown } = {},
  ) {
    // Antes de criar conta: pedido sem chave não pode deixar conta vazia para trás.
    if (!String(apiKey ?? '').trim()) throw new BadRequestException('Informe a chave de API da sua conta Whop.');
    const { sellerId, userId } = await this.sellerForConnection(email, accountSellerId);
    const actor = `seller:${userId}`;
    const prepared = await this.prepareConnection(sellerId, 'whop', choice, actor);

    // Com o roteamento ligado e a principal já conectada, outra company entra
    // como conta Whop EXTRA (whopa_…) — ver WhopLinkedAccountsService.connect.
    await this.connectWithChoice(sellerId, prepared, actor, () =>
      this.whopLinked.connect(sellerId, apiKey, actor, { label }));
    // Mesma visão do /status (campos da Whop + `providers`).
    return this.externalProviderStatus(sellerId);
  }

  /**
   * Financeiro da conta externa: saldo, contas bancárias e saques da conta Whop
   * dele. O dinheiro não passa pela Koopfy — só lemos e disparamos o pedido.
   */
  async externalProviderWallet(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    const sellerId = ctx.seller.id;
    const [balance, payoutMethods, withdrawals] = await Promise.all([
      this.whopLinked.balance(sellerId),
      this.whopLinked.payoutMethods(sellerId).catch(() => []),
      this.whopLinked.withdrawals(sellerId).catch(() => []),
    ]);
    return { balance, payoutMethods, withdrawals };
  }

  externalProviderWithdraw(
    ctx: SellerCtx,
    body: { amountCents?: number; currency?: string; payoutMethodId?: string },
  ) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.whopLinked.withdraw(
      ctx.seller.id,
      {
        amountCents: Number(body?.amountCents),
        currency: String(body?.currency ?? ''),
        payoutMethodId: String(body?.payoutMethodId ?? ''),
      },
      `seller:${ctx.userId}`,
    );
  }

  async disconnectExternalProvider(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    // Pelo seller: volta a 'allowed' (pode reconectar ou trocar pela Stripe).
    await this.whopLinked.disconnect(ctx.seller.id, 'desconectado pelo seller', `seller:${ctx.userId}`, { bySeller: true });
    return this.externalProviderStatus(ctx.seller.id);
  }

  /** Sessão (token de 1h) para a verificação embutida no painel. */
  connectedVerificationSession(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.whopConnect.verificationSession(ctx.seller.id);
  }

  /** Formulário da Whop para concluir a verificação da empresa (link de ~1h). */
  connectedOnboardingLink(ctx: SellerCtx) {
    if (!ctx.seller) throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    return this.whopConnect.onboardingLink(ctx.seller.id);
  }

  getActivationRequest(ctx: SellerCtx) {
    return this.activationRequests.getForUser(ctx.userId);
  }

  requestActivation(ctx: SellerCtx, dto: { kind: 'cnpj' | 'us_company'; message?: string }) {
    return this.activationRequests.request(ctx.userId, dto);
  }

  /**
   * O que o painel do checkout precisa para o seller se destravar sozinho:
   * liberação de CNPJ, última solicitação, motivo da recusa e pendências
   * (faltantes do cadastro da LLC + pedidos da Whop). Falha aqui não derruba o
   * status — sem pendências o painel segue o fluxo normal.
   */
  private async loadRequirements(
    userId: string,
    sellerId: string | null,
    documentsSubmitted: boolean,
    sellerActive: boolean,
    rejectionReason: string | null,
  ) {
    try {
      const [activation, requirements] = await Promise.all([
        this.activationRequests.getForUser(userId),
        // Durante o onboarding a etapa de documentos já pede tudo. Conta ativa é
        // verificada sempre: pode ter sido aprovada antes do cadastro da LLC e
        // ainda não ter o que a conta conectada exige.
        sellerId && (documentsSubmitted || sellerActive)
          ? this.whopConnect.getSellerRequirements(sellerId)
          : Promise.resolve(null),
      ]);
      return {
        cnpjAllowed: activation.cnpjAllowed,
        activationRequest: activation.latest,
        rejectionReason,
        companyType: requirements?.companyType ?? null,
        connectedStatus: requirements?.connectedStatus ?? null,
        connected: requirements?.connected ?? null,
        switchToLlc: requirements?.switchToLlc ?? false,
        items: requirements?.items ?? [],
      };
    } catch (err: any) {
      console.error('[integration] requirements:', err?.message);
      return { cnpjAllowed: false, activationRequest: null, rejectionReason, companyType: null, connectedStatus: null, connected: null, switchToLlc: false, items: [] };
    }
  }

  /**
   * Provisiona (cria/atualiza) a conta do seller no Koopfy Pay a partir da
   * identidade compartilhada (login unificado), SEM exigir segunda senha nem
   * verificação de email — o seller já está autenticado/verificado no checkout.
   *
   * Idempotente: se já existe conta para o email, só completa campos faltantes.
   * Espelha o que o register cria: users + seller_profiles + wallet_balance.
   */
  async provision(email: string, body: ProvisionBody) {
    const normEmail = email.toLowerCase().trim();

    const { data: existing } = await supabase
      .from('users')
      .select('id, name, instagram, whatsapp, avatar_url')
      .eq('email', normEmail)
      .maybeSingle();

    // ── Já existe: completa só o que falta ──────────────────────────────────
    if (existing) {
      const patch: Record<string, any> = {};
      if (body.name && !existing.name) patch.name = body.name.trim();
      if (body.instagram && !existing.instagram) patch.instagram = body.instagram;
      if (body.whatsapp && !existing.whatsapp) patch.whatsapp = body.whatsapp.replace(/\D/g, '');
      if (body.avatarBase64 && body.avatarMime && !existing.avatar_url) {
        patch.avatar_url = await this.storage.uploadAvatar({
          userId: existing.id,
          base64: body.avatarBase64,
          mime: body.avatarMime,
        });
      }
      if (Object.keys(patch).length) {
        await supabase.from('users').update(patch).eq('id', existing.id);
      }
      return { provisioned: false, alreadyExisted: true, userId: existing.id };
    }

    // ── Cria a conta (espelha o register, sem senha/verificação) ────────────
    const name = body.name?.trim() || normEmail.split('@')[0];
    const randomPasswordHash = await bcrypt.hash(uuidv4() + uuidv4(), 12);

    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email: normEmail,
        password_hash: randomPasswordHash,
        name,
        instagram: body.instagram ?? null,
        whatsapp: body.whatsapp ? body.whatsapp.replace(/\D/g, '') : null,
        email_verified: true, // já verificado no checkout (login unificado)
        kyc_completed: false,
        operation_setup_completed: false,
        onboarding_completed: false,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    // A mensagem do 400 chega ao seller pelo checkout: detalhe do banco só no log.
    if (userError || !user) {
      console.error('[integration] provision user:', userError);
      throw new BadRequestException('Não foi possível criar a conta financeira agora. Tente novamente.');
    }

    const { error: profileError } = await supabase.from('seller_profiles').insert({
      user_id: user.id,
      name,
      email: normEmail,
      instagram: body.instagram ?? null,
      enabled_methods: [],
      risk_level: 'WHITE',
      kyc_status: 'pending',
      status: 'pending_review',
      config: {
        settlement: { delayDays: 3 },
        reserve: { percentage: 0, holdDays: 0 },
      },
      metadata: {},
      created_at: new Date().toISOString(),
    });

    if (profileError) {
      await supabase.from('users').delete().eq('id', user.id); // rollback
      console.error('[integration] provision profile:', profileError);
      throw new BadRequestException('Não foi possível criar a conta financeira agora. Tente novamente.');
    }

    const { data: sellerProfile } = await supabase
      .from('seller_profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (sellerProfile) {
      await supabase.from('wallet_balance').insert({
        seller_id: sellerProfile.id,
        available_balance: 0,
        pending_balance: 0,
        reserved_balance: 0,
      });

      if (body.avatarBase64 && body.avatarMime) {
        const avatarUrl = await this.storage.uploadAvatar({
          userId: user.id,
          base64: body.avatarBase64,
          mime: body.avatarMime,
        });
        await supabase.from('users').update({ avatar_url: avatarUrl }).eq('id', user.id);
        await supabase
          .from('seller_profiles')
          .update({ metadata: { logoUrl: avatarUrl } })
          .eq('id', sellerProfile.id);
      }
    }

    return { provisioned: true, alreadyExisted: false, userId: user.id };
  }

  /** Contas Koopfy Payments do usuário: a principal (do e-mail) e as criadas a mais. */
  listAccounts(email: string) {
    return listSellerAccounts(email);
  }

  /**
   * Conta nova, do zero: cadastro, documentos, saldo e repasses próprios.
   *
   * A primeira conta do e-mail é a principal (igual ao provisionamento). As
   * seguintes ganham um usuário interno ligado ao dono (users.owner_user_id),
   * para os dados gravados por user_id não se misturarem com os da principal.
   */
  async createAccount(email: string, body: { name?: unknown }) {
    const normEmail = (email ?? '').toLowerCase().trim();
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : null;

    const { data: owner } = await supabase
      .from('users')
      .select('id, name')
      .eq('email', normEmail)
      .maybeSingle();

    if (!owner) {
      const created = await this.provision(normEmail, name ? { name } : {});
      const { data: seller } = await supabase
        .from('seller_profiles')
        .select('id')
        .eq('user_id', created.userId)
        .maybeSingle();
      if (!seller) throw new BadRequestException(CREATE_ACCOUNT_FAILED);
      return { sellerId: seller.id as string, primary: true };
    }

    // Usuário do e-mail sem seller (cadastro antigo incompleto): a nova conta é a principal.
    const { data: ownerSeller } = await supabase
      .from('seller_profiles')
      .select('id')
      .eq('user_id', owner.id)
      .maybeSingle();
    if (!ownerSeller) {
      const sellerId = await this.insertSellerProfile(owner.id, name ?? owner.name ?? normEmail.split('@')[0], normEmail, null);
      return { sellerId, primary: true };
    }

    const accountEmail = accountAliasEmail(normEmail);
    const accountName = name ?? owner.name ?? normEmail.split('@')[0];
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({
        email: accountEmail,
        password_hash: await bcrypt.hash(uuidv4() + uuidv4(), 12),
        name: accountName,
        email_verified: true,
        kyc_completed: false,
        operation_setup_completed: false,
        onboarding_completed: false,
        owner_user_id: owner.id,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (userError || !user) {
      console.error('[integration] createAccount user:', userError);
      throw new BadRequestException(CREATE_ACCOUNT_FAILED);
    }

    try {
      const sellerId = await this.insertSellerProfile(user.id, accountName, normEmail, accountEmail);
      return { sellerId, primary: false };
    } catch (err) {
      await supabase.from('users').delete().eq('id', user.id); // rollback
      throw err;
    }
  }

  /**
   * seller_profiles + carteira, como no provisionamento. O e-mail do perfil é o
   * do dono (é para onde vão os e-mails ao seller); se o banco recusar e-mail
   * repetido, usa o interno da conta.
   */
  private async insertSellerProfile(userId: string, name: string, email: string, fallbackEmail: string | null) {
    const row = (profileEmail: string) => ({
      user_id: userId,
      name,
      email: profileEmail,
      enabled_methods: [],
      risk_level: 'WHITE',
      kyc_status: 'pending',
      status: 'pending_review',
      config: {
        settlement: { delayDays: 3 },
        reserve: { percentage: 0, holdDays: 0 },
      },
      metadata: {},
      created_at: new Date().toISOString(),
    });

    let { data: profile, error } = await supabase.from('seller_profiles').insert(row(email)).select('id').single();
    if (error?.code === '23505' && fallbackEmail) {
      ({ data: profile, error } = await supabase.from('seller_profiles').insert(row(fallbackEmail)).select('id').single());
    }
    if (error || !profile) {
      console.error('[integration] createAccount profile:', error);
      throw new BadRequestException(CREATE_ACCOUNT_FAILED);
    }

    const { error: walletError } = await supabase.from('wallet_balance').insert({
      seller_id: profile.id,
      available_balance: 0,
      pending_balance: 0,
      reserved_balance: 0,
    });
    if (walletError) console.error('[integration] createAccount wallet:', walletError.message);

    return profile.id as string;
  }
  /**
   * Status do seller para o checkout decidir o estado do card "Koopfy Pay".
   * - notFound: não tem conta no pay
   * - pending:  onboarding incompleto ou aguardando aprovação
   * - active:   aprovado, pode ativar/usar
   * - rejected/suspended: bloqueado
   */
  async getStatus(email: string, sellerId: string | null = null) {
    const normEmail = (email ?? '').toLowerCase().trim();

    // Conta que o workspace usa (header) ou a principal do e-mail.
    const accountUserId = await resolveAccountUserId(normEmail, sellerId);
    const { data: user } = accountUserId
      ? await supabase
          .from('users')
          .select(
            'id, name, email, avatar_url, instagram, created_at, kyc_completed, operation_setup_completed, documents_completed, onboarding_completed',
          )
          .eq('id', accountUserId)
          .maybeSingle()
      : { data: null as any };

    // Email ainda não tem conta no Koopfy Pay → o checkout deve oferecer criar
    // (onboarding), não tratar como erro de comunicação.
    if (!user) {
      return {
        state: 'not_found' as const,
        sellerId: null,
        sellerStatus: null,
        kycStatus: null,
        account: null,
        onboarding: { kyc: false, operation: false, documents: false, completed: false },
        // Provedor externo liberado para todos: conectar cria a conta (connectExternalProvider).
        externalProvider: await this.externalProviderStatus(null),
      };
    }

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('id, status, kyc_status, rejection_reason')
      .eq('user_id', user.id)
      .maybeSingle();

    const sellerStatus = seller?.status ?? null; // pending_review | active | rejected | suspended

    // A conta pode existir só por PROVISIONAMENTO (criada no onboarding do checkout)
    // sem o seller ter feito o KYC ainda. Nesse caso o status é 'pending_review',
    // mas NÃO é "em análise" — falta o seller enviar os documentos no dash-pay.
    // Usamos documents_completed (último passo) p/ distinguir.
    const documentsSubmitted = !!user?.documents_completed;

    // Modo conta externa: a liberação no CRM faz as vezes da aprovação. Conta
    // Whop dele cobrando = conta ativa para o painel, sem cadastro nem
    // pendências da Koopfy (quem faz o KYC da empresa é a Whop).
    // Usuário sem perfil de seller também vê a opção: conectar cria a conta.
    const externalProvider = await this.externalProviderStatus(seller?.id ?? null);
    const externalOnly = sellerStatus === 'pending_review' && Boolean(externalProvider?.charging);

    const state: 'not_found' | AccountState = !seller
      ? 'not_found'
      : externalOnly ? 'active' : accountState(sellerStatus, documentsSubmitted);

    // Dados da conta detectada (login unificado por email) — usados na UI para
    // oferecer "associar esta conta" em vez de criar uma nova.
    const account = seller
      ? {
          sellerId: seller.id,
          name: user?.name ?? null,
          // Conta a mais tem e-mail interno: mostra o do usuário logado.
          email: normEmail,
          avatarUrl: user?.avatar_url ?? null,
          instagram: user?.instagram ?? null,
          createdAt: user?.created_at ?? null,
        }
      : null;

    const requirements = seller && !externalOnly
      ? await this.loadRequirements(user.id, seller.id, documentsSubmitted, sellerStatus === 'active', seller.rejection_reason ?? null)
      : null;

    return {
      state,
      sellerId: seller?.id ?? null,
      sellerStatus,
      kycStatus: seller?.kyc_status ?? null,
      account,
      onboarding: {
        kyc: !!user?.kyc_completed,
        operation: !!user?.operation_setup_completed,
        documents: !!user?.documents_completed,
        completed: !!user?.onboarding_completed,
      },
      requirements,
      // Modo conta externa: o painel mostra "conecte seu provedor externo"
      // quando a equipe liberou; com a conta conectada, mostra a situação dela.
      externalProvider,
    };
  }

  /**
   * Ativa a integração: só permitido quando o seller está aprovado (active).
   * Emite uma nova API key sk_live_ e retorna o texto puro UMA vez — o checkout
   * deve guardá-la (o pay só persiste o hash).
   */
  private async connectedActivationBlocker(sellerId: string): Promise<string | null> {
    try {
      const [requirements, external] = await Promise.all([
        this.whopConnect.getSellerRequirements(sellerId),
        this.externalProviderStatus(sellerId).catch(() => null),
      ]);
      return connectedActivationBlocker({
        required: Boolean(requirements?.connected?.required),
        status: requirements?.connected?.status ?? null,
        externalProviderConnected: Boolean((external as any)?.connected),
      });
    } catch (err: any) {
      // Sem conseguir ler a situação, não trava a ativação por uma falha
      // passageira — o pior caso é um seller ativar um pouco antes.
      console.error(`[KoopfyIntegration] checagem da conta conectada de ${sellerId}:`, err?.message);
      return null;
    }
  }

  async activate(ctx: SellerCtx) {
    const seller = ctx.seller;
    if (!seller) {
      throw new NotFoundException('Seller sem conta no Koopfy Pay. Faça o onboarding.');
    }
    // Modo conta externa: com a conta Whop dele conectada, a liberação do CRM
    // faz as vezes da aprovação (ver sellerMayOperate).
    if (!(await sellerMayOperate(seller))) {
      throw new ConflictException(
        `Onboarding ainda não aprovado (status: ${seller.status}).`,
      );
    }

    // Conta conectada ainda em verificação na Whop: não ativa (ver
    // connectedActivationBlocker). O painel já esconde o botão; isto cobre
    // chamada direta e painel antigo em cache.
    const blocker = await this.connectedActivationBlocker(seller.id);
    if (blocker) throw new ConflictException(blocker);

    const publishableKey = generateKey('pk_live');
    const secretKey = generateKey('sk_live');
    const secretKeyHash = hashKey(secretKey);
    const keyPrefix = secretKey.slice(0, 20);

    const { error } = await supabase.from('api_keys').insert({
      seller_id: seller.id,
      publishable_key: publishableKey,
      secret_key_hash: secretKeyHash,
      key_prefix: keyPrefix,
      name: 'Koopfy Checkout',
      is_active: true,
    });

    if (error) {
      throw new ConflictException('Falha ao emitir a API key: ' + error.message);
    }

    return { sellerId: seller.id, secretKey, publishableKey };
  }

  /**
   * Emite um JWT curto VÁLIDO no pay (sub = pay user.id) para SSO: o seller chega
   * no dash-pay já autenticado, sem relogar. Requer que a conta já exista (o
   * checkout chama provision antes). 30 min é suficiente p/ o onboarding.
   */
  sso(ctx: SellerCtx) {
    if (!ctx.userId) {
      throw new NotFoundException('Conta Koopfy Pay não encontrada.');
    }
    const token = jwt.sign(
      { sub: ctx.userId, email: ctx.email },
      process.env.JWT_SECRET as string,
      { expiresIn: '30m' },
    );
    return { token };
  }

  /**
   * Canal da operação logística deste merchant.
   *
   * A URL do grupo é definida pelo CRM na aprovação do merchant (e editável
   * depois em PATCH crm/sellers/:id/logistics-group). Fica em
   * `seller_profiles.config.logistics_group_url`.
   *
   * O dash do seller usa isto no botão "Solicitar Homologação" da tela de
   * Produtos. Sem conta ou sem grupo definido devolve `url: null` — a UI
   * desabilita o botão explicando o motivo, em vez de abrir aba em branco.
   */
  async getLogisticsChannel(email: string, sellerId: string | null = null) {
    const userId = await resolveAccountUserId(email, sellerId);
    if (!userId) return { url: null as string | null };
    const user = { id: userId };

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('config')
      .eq('user_id', user.id)
      .maybeSingle();

    return { url: (seller?.config?.logistics_group_url as string) ?? null };
  }

  /**
   * Saldo da carteira para o card "Seu saldo" da home do checkout.
   *
   * Reaproveita o WalletService do dashboard — mesma fonte e mesmas conversões
   * de centavos que o dash-pay usa, então os dois painéis nunca divergem.
   *
   * Resolve o seller pelo email (mesmo elo do login unificado que o getStatus
   * usa). Sem conta provisionada devolve `not_found`: o checkout mostra o CTA
   * de ativação em vez de zeros, que seriam enganosos.
   */
  async getBalance(email: string, sellerId: string | null = null) {
    const userId = await resolveAccountUserId(email, sellerId);
    const user = userId ? { id: userId } : null;

    const { data: seller } = user
      ? await supabase
          .from('seller_profiles')
          .select('id, status')
          .eq('user_id', user.id)
          .maybeSingle()
      : { data: null };

    if (!seller) {
      return { state: 'not_found' as const, currency: WALLET_CURRENCY, balance: null };
    }

    // Conta externa: o dinheiro nunca entra na carteira da Koopfy, então o card
    // da home mostraria zeros verdadeiros e enganosos. Diz de onde é o saldo e
    // manda para a tela que lê a conta dele.
    const external = await this.whopLinked.status(seller.id).catch(() => null);
    if (external?.connected) {
      return { state: 'external' as const, currency: WALLET_CURRENCY, balance: null };
    }

    const b = await this.wallet.getBalance(seller.id);

    return {
      // pending_review | active | rejected | suspended
      state: seller.status,
      currency: WALLET_CURRENCY,
      balance: {
        available: b.availableBalance,
        pending: b.pendingBalance,
        reserved: b.reservedBalance,
        inTransit: b.inTransit,
        total: b.total,
        nextPayout: b.nextPayout,
      },
    };
  }

  /**
   * Central recorrente consumida pelo dashboard do checkout.
   *
   * O limite de autorização é a lista de transactions do seller: memberships
   * sem uma transação pertencente a ele são descartadas também pelo mapper.
   * Isso mantém `whop_subscriptions` privada e evita IDOR mesmo usando service
   * role nesta integração server-to-server.
   */
  async getSubscriptions(email: string, query: Record<string, any> = {}, sellerId: string | null = null) {
    const workspaceId = String(query.workspaceId ?? '').trim();
    if (!workspaceId) throw new BadRequestException('Workspace obrigatório.');

    const userId = await resolveAccountUserId(email, sellerId);
    const user = userId ? { id: userId } : null;

    const { data: seller, error: sellerError } = user
      ? await supabase
          .from('seller_profiles')
          .select('id, status')
          .eq('user_id', user.id)
          .maybeSingle()
      : { data: null, error: null };
    if (sellerError) {
      throw new BadRequestException('Não foi possível localizar o perfil no Koopfy Pay.');
    }

    if (!seller) {
      return {
        state: 'not_found' as const,
        ...buildSubscriptionReport({ transactions: [], subscriptions: [] }),
      };
    }

    const report = await loadSubscriptionReport({
      listTransactions: async (sellerId: string) => {
        const { data, error } = await supabase
          .from('transactions')
          .select(
            'id, customer_name, customer_email, amount, amount_usd_gross_cents, currency, approved_at, created_at, metadata',
          )
          .eq('seller_id', sellerId);
        if (error) throw new BadRequestException('Não foi possível carregar as vendas recorrentes.');
        return filterTransactionsByWorkspace(
          (data ?? []) as SubscriptionTransactionRow[],
          workspaceId,
        );
      },
      listSubscriptions: async (transactionIds: string[]) => {
        const memberships: SubscriptionMembershipRow[] = [];

        // Evita URLs PostgREST grandes em contas com muitas transações, sem
        // remover o vínculo de ownership que protege a consulta.
        for (let offset = 0; offset < transactionIds.length; offset += 200) {
          const ids = transactionIds.slice(offset, offset + 200);
          const { data, error } = await supabase
            .from('whop_subscriptions')
            .select(
              'whop_membership_id, koopfy_transaction_id, koopfy_product_id, customer_email, status, cancel_at_period_end, current_period_end, metadata, created_at, updated_at',
            )
            .in('koopfy_transaction_id', ids);
          if (error) throw new BadRequestException('Não foi possível carregar as assinaturas.');
          memberships.push(...((data ?? []) as SubscriptionMembershipRow[]));
        }

        return memberships;
      },
    }, seller.id, {
      status: query.status,
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });

    return { state: seller.status, ...report };
  }
}
