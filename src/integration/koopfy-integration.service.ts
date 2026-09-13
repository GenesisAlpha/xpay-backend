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
import { WalletService } from '../dashboard/services/services';
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
  ) {}

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

    if (userError || !user) {
      throw new BadRequestException('Erro ao provisionar conta: ' + userError?.message);
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
      throw new BadRequestException('Erro ao provisionar perfil: ' + profileError.message);
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
  /**
   * Status do seller para o checkout decidir o estado do card "Koopfy Pay".
   * - notFound: não tem conta no pay
   * - pending:  onboarding incompleto ou aguardando aprovação
   * - active:   aprovado, pode ativar/usar
   * - rejected/suspended: bloqueado
   */
  async getStatus(email: string) {
    const normEmail = (email ?? '').toLowerCase().trim();

    const { data: user } = await supabase
      .from('users')
      .select(
        'id, name, email, avatar_url, instagram, created_at, kyc_completed, operation_setup_completed, documents_completed, onboarding_completed',
      )
      .eq('email', normEmail)
      .maybeSingle();

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
      };
    }

    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('id, status, kyc_status')
      .eq('user_id', user.id)
      .maybeSingle();

    const sellerStatus = seller?.status ?? null; // pending_review | active | rejected | suspended

    // A conta pode existir só por PROVISIONAMENTO (criada no onboarding do checkout)
    // sem o seller ter feito o KYC ainda. Nesse caso o status é 'pending_review',
    // mas NÃO é "em análise" — falta o seller enviar os documentos no dash-pay.
    // Usamos documents_completed (último passo) p/ distinguir.
    const documentsSubmitted = !!user?.documents_completed;

    let state: 'not_found' | 'onboarding' | 'pending' | 'active' | 'rejected' | 'suspended';
    if (!seller) state = 'not_found';
    else if (sellerStatus === 'active') state = 'active';
    else if (sellerStatus === 'rejected') state = 'rejected';
    else if (sellerStatus === 'suspended') state = 'suspended';
    else if (!documentsSubmitted) state = 'onboarding'; // provisionada, KYC ainda não enviado
    else state = 'pending'; // KYC enviado, aguardando aprovação

    // Dados da conta detectada (login unificado por email) — usados na UI para
    // oferecer "associar esta conta" em vez de criar uma nova.
    const account = seller
      ? {
          sellerId: seller.id,
          name: user?.name ?? null,
          email: user?.email ?? normEmail,
          avatarUrl: user?.avatar_url ?? null,
          instagram: user?.instagram ?? null,
          createdAt: user?.created_at ?? null,
        }
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
    };
  }

  /**
   * Ativa a integração: só permitido quando o seller está aprovado (active).
   * Emite uma nova API key sk_live_ e retorna o texto puro UMA vez — o checkout
   * deve guardá-la (o pay só persiste o hash).
   */
  async activate(ctx: SellerCtx) {
    const seller = ctx.seller;
    if (!seller) {
      throw new NotFoundException('Seller sem conta no Koopfy Pay. Faça o onboarding.');
    }
    if (seller.status !== 'active') {
      throw new ConflictException(
        `Onboarding ainda não aprovado (status: ${seller.status}).`,
      );
    }

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
  async getLogisticsChannel(email: string) {
    const normEmail = (email ?? '').toLowerCase().trim();

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', normEmail)
      .maybeSingle();

    if (!user) return { url: null as string | null };

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
  async getBalance(email: string) {
    const normEmail = (email ?? '').toLowerCase().trim();

    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('email', normEmail)
      .maybeSingle();

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
  async getSubscriptions(email: string, query: Record<string, any> = {}) {
    const normEmail = (email ?? '').toLowerCase().trim();
    const workspaceId = String(query.workspaceId ?? '').trim();
    if (!workspaceId) throw new BadRequestException('Workspace obrigatório.');

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('email', normEmail)
      .maybeSingle();
    if (userError) {
      throw new BadRequestException('Não foi possível localizar a conta no Koopfy Pay.');
    }

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
