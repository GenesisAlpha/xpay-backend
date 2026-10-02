import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';
import {
  DEFAULT_LINKED_COMMISSION_PCT,
  LinkedBalance,
  LinkedPayoutMethod,
  WhopLinkedAccountRow,
  isLinkedProviderAccountId,
  linkedChargeBlocker,
  mapLedgerBalance,
  mapPayoutMethods,
  toCents,
  toLinkedProviderAccountId,
  whopAccountIdFromLinkedProviderAccountId,
} from './whop-linked';
import { ownProviderConflict, toWhopExtraAccountId } from '../seller-provider/seller-provider-accounts';
import {
  SellerProviderAccountsService,
  sellerChargesOnAnyOwnAccount,
  sellerHasOwnStripe,
} from '../seller-provider/seller-provider-accounts.service';
import { saveRoutingLabel, sellerRoutingEnabled } from '../routing/routing-store';

// ============================================================================
// CONTA WHOP PRÓPRIA DO SELLER (modo conexão)
// ----------------------------------------------------------------------------
// O seller cola a chave de API da conta dele; a Koopfy valida contra a Whop,
// guarda cifrada e passa a cobrar naquela conta. O dinheiro é dele: não há
// application fee, não há carteira e não há saque no pay.
//
// A chave NUNCA volta para o browser: só o id da conta, o nome e o status.
// ============================================================================

const TABLE = 'whop_linked_accounts';

// Os saques que o painel dispara na conta dele. A Whop não documenta listagem
// de saques, então o histórico da tela é o nosso registro.
const WITHDRAWALS_TABLE = 'whop_linked_withdrawals';

// Status em que a Whop não mexe mais: não vale reconsultar.
const FINAL_WITHDRAWAL_STATUS = new Set(['completed', 'failed', 'canceled', 'cancelled', 'denied']);

// Duplicado de whop-accounts.service de propósito: importar de lá fecharia um
// ciclo (whop-accounts → whop-linked → whop-accounts) e a injeção do Nest
// receberia `undefined` no meio do ciclo.
const WHOP_API_URL_DEFAULT = 'https://api.whop.com';

// A conta muda pouco e toda cobrança consulta: cache curto evita ida ao banco
// no caminho quente sem segurar uma revogação por muito tempo.
const CACHE_TTL_MS = 15 * 1000;

// Permissões que a chave dele precisa ter para o Financeiro do painel
// funcionar (saldo, contas bancárias e saque). Sem elas a cobrança ainda sai,
// mas a tela de saldo fica cega — por isso conferimos na conexão.
// Métodos de quem vende só pela conta dele: a mesma lista padrão da aprovação
// no CRM (ALL_METHODS do dash-pay), para ele ficar igual a um seller aprovado.
const EXTERNAL_DEFAULT_METHODS = [
  'credit_card', 'spei', 'apple_pay', 'google_pay', 'ideal', 'bizum', 'bancontact', 'mbway', 'blik',
  'ach', 'venmo', 'cash_app', 'zelle', 'interac_debit', 'interac_etransfer',
];

export const WALLET_SCOPES = [
  'company:balance:read',
  'payout:account:read',
  'payout:destination:read',
  'payout:withdraw_funds',
];

@Injectable()
export class WhopLinkedAccountsService {
  constructor(
    private readonly crypto: CryptoService,
    // Contas Whop EXTRAS (roteamento ligado) moram em seller_provider_accounts.
    // Opcional só para os testes que montam o serviço à mão.
    @Optional() private readonly sellerProviders?: SellerProviderAccountsService,
  ) {}

  private cache = new Map<string, { row: WhopLinkedAccountRow | null; at: number }>();

  async getRow(sellerId: string): Promise<WhopLinkedAccountRow | null> {
    const cached = this.cache.get(sellerId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;

    const { data, error } = await supabase.from(TABLE).select('*').eq('seller_id', sellerId).maybeSingle();
    if (error) {
      // Tabela ausente (migration pendente) não pode derrubar a cobrança.
      console.error('[WhopLinked] leitura da conta:', error.message);
      return null;
    }
    const row = (data as WhopLinkedAccountRow) ?? null;
    this.cache.set(sellerId, { row, at: Date.now() });
    return row;
  }

  /** Situação da conexão para o CRM e para o painel (nunca devolve a chave). */
  async status(sellerId: string) {
    return this.publicView(await this.getRow(sellerId));
  }

  /**
   * Libera (ou corta) o modo conta externa para o seller. Desde 2026-09-28 ele
   * vem liberado para todos (decisão do dono): sem registro = liberado, e o
   * CRM só serve para CORTAR ('disabled') ou religar quem foi cortado.
   */
  async allow(sellerId: string, enabled: boolean, actor: string | null = null) {
    const row = await this.getRow(sellerId);
    const now = new Date().toISOString();

    if (!enabled) {
      // Sem registro o modo vale liberado: cortar precisa gravar o bloqueio.
      const { error } = await supabase.from(TABLE).upsert(
        {
          seller_id: sellerId,
          status: 'disabled',
          commission_pct: Number(row?.commission_pct ?? DEFAULT_LINKED_COMMISSION_PCT),
          updated_at: now,
          ...(row ? {} : { created_by: actor }),
        },
        { onConflict: 'seller_id' },
      );
      if (error) throw new BadRequestException(`Não foi possível cortar o modo conta externa: ${error.message}`);
      this.cache.delete(sellerId);
      await this.log(sellerId, actor, 'whop_linked.mode_disabled', {});
      return this.publicView(await this.getRow(sellerId));
    }

    // Já conectada: religar não pede a chave de novo.
    const status = row?.whop_account_id && row.api_key ? 'active' : 'allowed';
    const { error } = await supabase.from(TABLE).upsert(
      {
        seller_id: sellerId,
        status,
        commission_pct: Number(row?.commission_pct ?? DEFAULT_LINKED_COMMISSION_PCT),
        updated_at: now,
        ...(row ? {} : { created_by: actor }),
      },
      { onConflict: 'seller_id' },
    );
    if (error) throw new BadRequestException(`Não foi possível liberar o modo conta externa: ${error.message}`);

    this.cache.delete(sellerId);
    await this.log(sellerId, actor, 'whop_linked.mode_allowed', { status });
    return this.publicView(await this.getRow(sellerId));
  }

  // ─── Financeiro da conta dele, dentro do painel da Koopfy ────────────────
  //
  // O dinheiro nunca passa pela Koopfy: lemos o saldo da conta dele e mandamos
  // o saque para o banco dele. Tudo com a chave que ele conectou.

  /** Saldo da conta externa (por moeda), como a Whop devolve agora. */
  async balance(sellerId: string): Promise<LinkedBalance> {
    const { row, apiKey } = await this.connected(sellerId);
    const ledger = await this.walletCall(sellerId, () =>
      this.whopGet(apiKey, row.api_url ?? WHOP_API_URL_DEFAULT, `/api/v1/ledger_accounts/${encodeURIComponent(row.whop_account_id!)}`),
    );
    return mapLedgerBalance(ledger);
  }

  /** Contas bancárias que ele já cadastrou na Whop — o destino do saque. */
  async payoutMethods(sellerId: string): Promise<LinkedPayoutMethod[]> {
    const { row, apiKey } = await this.connected(sellerId);
    const payload = await this.walletCall(sellerId, () =>
      this.whopGet(apiKey, row.api_url ?? WHOP_API_URL_DEFAULT, `/api/v1/payout_methods?account_id=${encodeURIComponent(row.whop_account_id!)}`),
    );
    return mapPayoutMethods(payload);
  }

  /**
   * Saque da conta dele para o banco dele. A Koopfy só dispara o pedido: o
   * dinheiro sai da Whop dele e nunca encosta na nossa carteira.
   */
  async withdraw(
    sellerId: string,
    input: { amountCents: number; currency: string; payoutMethodId: string },
    actor: string | null = null,
  ) {
    const { row, apiKey } = await this.connected(sellerId);

    const amountCents = Math.floor(Number(input?.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new BadRequestException('Informe um valor de saque maior que zero.');
    }
    const payoutMethodId = String(input?.payoutMethodId ?? '').trim();
    if (!payoutMethodId) throw new BadRequestException('Escolha para qual conta bancária enviar.');
    const currency = String(input?.currency ?? '').trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) throw new BadRequestException('Moeda do saque inválida.');

    // Não deixa pedir mais do que a Whop libera: o erro dela viria genérico e
    // o seller ficaria sem saber por quê.
    const balance = await this.balance(sellerId);
    const ceiling = currency === balance.currency
      ? balance.withdrawableCents
      : balance.currencies.find(item => item.currency === currency)?.availableCents ?? 0;
    if (amountCents > ceiling) {
      throw new BadRequestException(
        `Valor acima do disponível para saque (${(ceiling / 100).toFixed(2)} ${currency.toUpperCase()}).`,
      );
    }

    // A chave de idempotência é nossa e fica gravada: um retry do painel (ou um
    // duplo clique) não vira dois saques.
    const idempotencyKey = randomUUID();
    const { data: saved, error: saveError } = await supabase
      .from(WITHDRAWALS_TABLE)
      .insert({
        seller_id: sellerId,
        whop_account_id: row.whop_account_id,
        idempotency_key: idempotencyKey,
        amount_cents: amountCents,
        currency,
        payout_method_id: payoutMethodId,
        status: 'requested',
        requested_by: actor,
      })
      .select('id')
      .single();
    if (saveError) {
      console.error('[WhopLinked] registro do saque:', saveError.message);
      throw new BadRequestException('Não foi possível registrar o saque agora. Tente novamente.');
    }

    try {
      const withdrawal = await this.whopPost(apiKey, row.api_url ?? WHOP_API_URL_DEFAULT, '/api/v1/withdrawals', {
        company_id: row.whop_account_id,
        payout_method_id: payoutMethodId,
        // A Whop trabalha em decimal; nós guardamos centavos.
        amount: amountCents / 100,
        currency,
        idempotency_key: idempotencyKey,
      });

      await supabase
        .from(WITHDRAWALS_TABLE)
        .update({
          whop_withdrawal_id: withdrawal?.id ?? null,
          status: withdrawal?.status ?? 'requested',
          fee_cents: toCents(withdrawal?.fees?.fee_amount ?? 0) + toCents(withdrawal?.fees?.markup_fee ?? 0),
          estimated_at: withdrawal?.estimated_availability ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', saved.id);

      await this.log(sellerId, actor, 'whop_linked.withdrawal', {
        amount_cents: amountCents,
        currency,
        whop_withdrawal_id: withdrawal?.id ?? null,
      });

      return this.withdrawals(sellerId);
    } catch (err: any) {
      const reason = String(err?.message ?? err).slice(0, 500);
      await supabase
        .from(WITHDRAWALS_TABLE)
        .update({ status: 'failed', failure_reason: reason, updated_at: new Date().toISOString() })
        .eq('id', saved.id);
      throw new BadRequestException(`A Whop recusou o saque: ${reason}`);
    }
  }

  /**
   * Saques pedidos por aqui. A Whop não documenta uma listagem, então a fonte é
   * o nosso registro — e cada abertura da tela tenta atualizar o que ainda está
   * em andamento.
   */
  async withdrawals(sellerId: string) {
    const { data, error } = await supabase
      .from(WITHDRAWALS_TABLE)
      .select('*')
      .eq('seller_id', sellerId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[WhopLinked] leitura dos saques:', error.message);
      return [];
    }

    const rows = data ?? [];
    await this.refreshPendingWithdrawals(sellerId, rows);

    return rows.map(row => ({
      id: row.id,
      whopWithdrawalId: row.whop_withdrawal_id,
      amountCents: Number(row.amount_cents ?? 0),
      feeCents: Number(row.fee_cents ?? 0),
      currency: row.currency,
      status: row.status,
      estimatedAt: row.estimated_at,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
    }));
  }

  /** Enquanto o saque não termina, a Whop é a dona da verdade sobre o status. */
  private async refreshPendingWithdrawals(sellerId: string, rows: any[]) {
    const open = rows.filter(row => row.whop_withdrawal_id && !FINAL_WITHDRAWAL_STATUS.has(String(row.status)));
    if (open.length === 0) return;

    const { row: account, apiKey } = await this.connected(sellerId).catch(() => ({ row: null, apiKey: null } as any));
    if (!account || !apiKey) return;

    for (const row of open) {
      try {
        const fresh = await this.whopGet(
          apiKey,
          account.api_url ?? WHOP_API_URL_DEFAULT,
          `/api/v1/withdrawals/${encodeURIComponent(row.whop_withdrawal_id)}`,
        );
        const status = String(fresh?.status ?? '').trim();
        if (!status || status === row.status) continue;
        row.status = status;
        row.estimated_at = fresh?.estimated_availability ?? row.estimated_at;
        await supabase
          .from(WITHDRAWALS_TABLE)
          .update({ status, estimated_at: row.estimated_at, updated_at: new Date().toISOString() })
          .eq('id', row.id);
      } catch (err: any) {
        // Listagem não é lugar de falhar: o status antigo ainda é verdade.
        console.error(`[WhopLinked] status do saque ${row.whop_withdrawal_id}:`, err?.message);
      }
    }
  }

  /** Conta conectada + chave decifrada, ou o erro certo para o painel. */
  private async connected(sellerId: string): Promise<{ row: WhopLinkedAccountRow; apiKey: string }> {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) throw new NotFoundException('Nenhuma conta de provedor externo conectada.');
    const apiKey = this.reveal(row);
    if (!apiKey) {
      throw new BadRequestException('A chave da sua conta externa não pôde ser lida. Conecte a conta novamente.');
    }
    return { row, apiKey };
  }

  /**
   * Chamada de saldo/saque: o que falha aqui quase sempre é a chave sem os
   * escopos certos, e o painel precisa dizer isso em vez de mostrar tela vazia.
   */
  private async walletCall<T>(sellerId: string, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      await this.markWallet(sellerId, true, null);
      return result;
    } catch (err: any) {
      const reason = String(err?.message ?? err);
      await this.markWallet(sellerId, false, reason.slice(0, 500));
      throw new BadRequestException(
        `A Whop não liberou esta consulta (${reason}). A chave precisa das permissões de saldo e saque — gere outra e conecte de novo.`,
      );
    }
  }

  private async markWallet(sellerId: string, ready: boolean, error: string | null) {
    const row = await this.getRow(sellerId);
    if (!row || row.wallet_ready === ready) return;

    const { error: dbError } = await supabase
      .from(TABLE)
      .update({ wallet_ready: ready, ...(error ? { last_error: error } : {}), updated_at: new Date().toISOString() })
      .eq('seller_id', sellerId);
    if (dbError) console.error('[WhopLinked] wallet_ready:', dbError.message);
    this.cache.delete(sellerId);
  }

  /** Conta pronta para cobrar? É o que decide o roteamento da venda. */
  async isChargeable(sellerId: string): Promise<boolean> {
    const row = await this.getRow(sellerId);
    return row?.status === 'active' && linkedChargeBlocker(row) === null;
  }

  /**
   * Liga a conta do seller: valida a chave contra a Whop (quem é a company),
   * recusa conta que já é filha da Koopfy ou de outro seller, e guarda cifrada.
   */
  async connect(
    sellerId: string,
    apiKey: string,
    actor: string | null = null,
    // `replacing`: o seller escolheu trocar a conta de cartão atual (Stripe) por
    // esta; a antiga é desconectada por quem chama, depois que esta conectar.
    opts: { label?: string | null; replacing?: boolean } = {},
  ) {
    const key = String(apiKey ?? '').trim();
    if (!key) throw new BadRequestException('Informe a chave de API da sua conta Whop.');

    // Liberado para todos; só quem a equipe cortou no CRM ('disabled') não
    // conecta. Primeira conexão cria o registro, como a liberação do CRM fazia.
    let current = await this.getRow(sellerId);
    if (current?.status === 'disabled') {
      throw new BadRequestException('O modo conta externa foi desativado para esta conta. Fale com o atendimento da Koopfy.');
    }
    if (!current) {
      await this.allow(sellerId, true, actor);
      current = await this.getRow(sellerId);
      if (!current) throw new BadRequestException('Não foi possível preparar a conexão agora. Tente de novo.');
    }

    // Roteamento ligado: Whop e Stripe convivem, e uma Whop além da principal
    // vira conta EXTRA (`whopa_…`). Desligado: só uma conta própria de cartão.
    const routing = await sellerRoutingEnabled(sellerId);
    if (!routing && !opts.replacing) {
      // Whop e Stripe cobram cartão: só uma conta própria de cartão por vez.
      const conflict = ownProviderConflict('whop', { whop: false, stripe: await sellerHasOwnStripe(sellerId) });
      if (conflict) throw new ConflictException(conflict);
    }

    const company = await this.readCompany(key);
    if (!company.id.startsWith('biz_')) {
      throw new BadRequestException('A chave não pertence a uma conta de empresa na Whop.');
    }

    const { data: child } = await supabase
      .from('whop_connected_accounts')
      .select('seller_id')
      .eq('whop_account_id', company.id)
      .maybeSingle();
    if (child) {
      throw new ConflictException('Esta conta já é uma conta conectada criada pela Koopfy.');
    }

    // Já tem a principal conectada e esta chave é de OUTRA company: com o
    // roteamento, entra como conta extra — a principal (carteira, saque,
    // vendas antigas) continua intacta.
    const principalConnected = Boolean(current.whop_account_id && current.api_key)
      && (current.status === 'active' || current.status === 'invalid');
    if (routing && principalConnected && current.whop_account_id !== company.id) {
      return this.connectExtra(sellerId, key, company, actor, opts.label ?? null);
    }

    const { data: other } = await supabase
      .from(TABLE)
      .select('seller_id')
      .eq('whop_account_id', company.id)
      .neq('seller_id', sellerId)
      .maybeSingle();
    if (other) {
      throw new ConflictException('Esta conta Whop já está conectada em outra conta Koopfy.');
    }

    // Sem webhook NA CONTA DELE a venda nunca confirma: o webhook da master só
    // recebe eventos das contas filhas da Koopfy.
    const accountId = toLinkedProviderAccountId(company.id);
    const webhook = await this.registerWebhook(key, company.apiUrl, company.id, accountId);

    // Como a Koopfy recebe (desde 2026-09-28): a comissão (commission_pct, do
    // CRM ou 3%) de cada venda vira débito em dólar e é cobrada no cartão que
    // o seller salvou na Whop da Koopfy (checkout: billing_debits + cron). Não
    // há mais afiliado nem rev-share na conta dele.
    const commissionPct = Number(current.commission_pct ?? DEFAULT_LINKED_COMMISSION_PCT);

    // A chave serve para o financeiro do painel (saldo e saque)? Vale saber
    // agora, na tela em que ele ainda tem a chave na mão, e não depois, quando
    // ele for sacar. Ler o ledger é o teste mais barato e real.
    const walletReady = await this.whopGet(key, company.apiUrl, `/api/v1/ledger_accounts/${encodeURIComponent(company.id)}`)
      .then(() => true)
      .catch((err: any) => {
        console.error(`[WhopLinked] saldo da conta ${company.id}:`, err?.message);
        return false;
      });

    const now = new Date().toISOString();
    const { error } = await supabase.from(TABLE).upsert(
      {
        seller_id: sellerId,
        whop_account_id: company.id,
        wallet_ready: walletReady,
        company_title: company.title,
        api_key: this.crypto.encrypt(key),
        api_url: company.apiUrl,
        webhook_id: webhook.id,
        webhook_secret: webhook.secret ? this.crypto.encrypt(webhook.secret) : null,
        commission_pct: commissionPct,
        status: 'active',
        last_checked_at: now,
        last_error: null,
        created_by: actor,
        updated_at: now,
      },
      { onConflict: 'seller_id' },
    );
    if (error) {
      console.error('[WhopLinked] gravação da conta:', error.message);
      throw new BadRequestException('Não foi possível salvar a conexão agora. Tente novamente.');
    }

    this.cache.delete(sellerId);
    await saveRoutingLabel({ sellerId, accountId, provider: 'whop', label: opts.label });
    await this.prepareExternalOnlySeller(sellerId);
    await this.log(sellerId, actor, 'whop_linked.connected', {
      whop_account_id: company.id,
      company_title: company.title,
      webhook_id: webhook.id,
    });
    return this.publicView(await this.getRow(sellerId));
  }

  /**
   * Conta Whop EXTRA (roteamento ligado): mesma validação e mesmo webhook da
   * principal, apontando para `/webhook/whop/whopa_<id>` com o segredo dela.
   * A mesma company não entra duas vezes (nem como principal de outro seller).
   */
  private async connectExtra(
    sellerId: string,
    key: string,
    company: { id: string; title: string | null; apiUrl: string },
    actor: string | null,
    label: string | null,
  ) {
    if (!this.sellerProviders) throw new BadRequestException('Contas extras indisponíveis agora. Tente de novo.');

    const { data: otherPrincipal } = await supabase
      .from(TABLE)
      .select('seller_id')
      .eq('whop_account_id', company.id)
      .neq('seller_id', sellerId)
      .maybeSingle();
    if (otherPrincipal) throw new ConflictException('Esta conta Whop já está conectada em outra conta Koopfy.');
    await this.sellerProviders.assertNotTakenByOther(
      sellerId, 'whop', company.id, 'Esta conta Whop já está conectada em outra conta Koopfy.',
    );

    // Reconexão da mesma company reaproveita a linha (id do roteador e webhook).
    const existing = (await this.sellerProviders.listRows(sellerId))
      .find(row => row.provider === 'whop' && row.account_ref === company.id);
    const rowId = existing?.id ?? randomUUID();
    const accountId = toWhopExtraAccountId(rowId);
    const webhook = await this.registerWebhook(key, company.apiUrl, company.id, accountId);

    await this.sellerProviders.saveWhopExtra(sellerId, {
      id: rowId,
      account_ref: company.id,
      display_name: company.title ? String(company.title).slice(0, 120) : null,
      // O biz_ é público (o Whop Elements monta com ele no navegador).
      public_key: company.id,
      secret_enc: this.crypto.encrypt(key),
      api_url: company.apiUrl,
      webhook_id: webhook.id,
      webhook_secret_enc: webhook.secret ? this.crypto.encrypt(webhook.secret) : null,
    }, actor);
    await saveRoutingLabel({ sellerId, accountId, provider: 'whop', label });

    await this.log(sellerId, actor, 'whop_linked.extra_connected', {
      account_id: accountId,
      whop_account_id: company.id,
      webhook_id: webhook.id,
    });
    return this.publicView(await this.getRow(sellerId));
  }

  /**
   * Seller que vende só pela conta dele, sem aprovação da Koopfy: provider e
   * métodos são gravados na aprovação do CRM, que ele não passa. Sem isso a
   * venda nem chegaria na Whop. Seller aprovado mantém o que o CRM definiu.
   */
  private async prepareExternalOnlySeller(sellerId: string) {
    const { data: seller } = await supabase
      .from('seller_profiles')
      .select('status, provider_default, enabled_methods')
      .eq('id', sellerId)
      .maybeSingle();
    if (!seller || seller.status === 'active') return;

    const patch: Record<string, unknown> = {};
    if (String(seller.provider_default ?? '').toLowerCase().replace(/provider$/, '') !== 'whop') {
      patch.provider_default = 'whop';
    }
    if (!(seller.enabled_methods ?? []).length) patch.enabled_methods = EXTERNAL_DEFAULT_METHODS;
    if (!Object.keys(patch).length) return;

    const { error } = await supabase.from('seller_profiles').update(patch).eq('id', sellerId);
    if (error) console.error(`[WhopLinked] provider do seller ${sellerId}:`, error.message);
  }

  /**
   * Desliga a conexão. As vendas voltam a sair pela conta da Koopfy.
   *
   * Pelo próprio seller (`bySeller`) a conta volta a 'allowed': o modo segue
   * liberado e ele pode conectar de novo — ou trocar pela Stripe. 'disabled'
   * é o corte do CRM, que esconde a opção e trava a reconexão. As chaves
   * ficam: reembolso e disputa de vendas antigas ainda chegam pelo webhook.
   */
  async disconnect(sellerId: string, reason: string, actor: string | null = null, opts: { bySeller?: boolean } = {}) {
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta Whop própria conectada.');

    const { error } = await supabase
      .from(TABLE)
      .update({
        status: opts.bySeller ? 'allowed' : 'disabled',
        last_error: reason || null,
        updated_at: new Date().toISOString(),
        created_by: actor ?? row.created_by,
      })
      .eq('seller_id', sellerId);
    if (error) throw new BadRequestException(`Não foi possível desligar a conexão: ${error.message}`);

    this.cache.delete(sellerId);
    await this.log(sellerId, actor, 'whop_linked.disconnected', { reason: reason || null });
    return this.publicView(await this.getRow(sellerId));
  }

  /** Comissão da Koopfy nessa conta: vira débito em dólar cobrado no cartão do seller. */
  async setCommission(sellerId: string, commissionPct: number, actor: string | null = null) {
    const pct = Number(commissionPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
      throw new BadRequestException('Comissão deve ficar entre 0% e 25%.');
    }

    // O percentual vale para qualquer conta própria (Whop, Stripe ou PayPal) e
    // mora aqui desde a Whop. Seller sem conexão Whop ainda ganha o registro
    // ('allowed' = liberado, sem conta Whop): é onde o pay lê a comissão.
    // Vale a partir da próxima venda: o pay grava o percentual em cada
    // transação (metadata.own_account) e o checkout cobra por ele.
    const row = await this.getRow(sellerId);
    const now = new Date().toISOString();
    const { error } = row
      ? await supabase.from(TABLE).update({ commission_pct: pct, updated_at: now }).eq('seller_id', sellerId)
      : await supabase.from(TABLE).upsert(
        { seller_id: sellerId, status: 'allowed', commission_pct: pct, created_by: actor, updated_at: now },
        { onConflict: 'seller_id' },
      );
    if (error) throw new BadRequestException(`Não foi possível salvar a comissão: ${error.message}`);

    this.cache.delete(sellerId);
    await this.log(sellerId, actor, 'whop_linked.commission_changed', { commission_pct: pct });
    return this.publicView(await this.getRow(sellerId));
  }

  /** Cada ação fica no log do seller: quem conectou a conta dele e quando. */
  private async log(sellerId: string, managerId: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      // `manager_id` é do gestor do CRM; seller e sistema vão no payload.
      manager_id: managerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(managerId) ? managerId : null,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload: { ...payload, actor: managerId },
      created_at: new Date().toISOString(),
    });
    if (error) console.error(`[WhopLinked] ação ${action} não registrada:`, error.message);
  }

  /** O que o painel e o CRM podem ver: nunca a chave. */
  publicView(row: WhopLinkedAccountRow | null) {
    // Sem registro = liberado (ninguém cortou): o painel mostra "conecte seu provedor".
    if (!row) return { allowed: true as const, connected: false as const };
    return {
      // Só 'disabled' (cortado no CRM) esconde a opção.
      allowed: row.status !== 'disabled',
      // 'allowed' com chave = o seller desconectou (a chave fica para os
      // webhooks de vendas antigas): para o painel, não está conectada.
      connected: Boolean(row.whop_account_id && row.api_key) && row.status !== 'allowed',
      whopAccountId: row.whop_account_id,
      companyTitle: row.company_title,
      status: row.status,
      commissionPct: Number(row.commission_pct ?? 0),
      // Sem afiliado + rev-share na conta dele, a Koopfy não recebe nada.
      affiliateReady: Boolean(row.affiliate_id && row.affiliate_code && row.affiliate_override_id),
      // Saldo, extrato e saque da conta dele dentro do painel da Koopfy.
      walletReady: Boolean(row.wallet_ready),
      blocker: linkedChargeBlocker(row),
      lastCheckedAt: row.last_checked_at,
      lastError: row.last_error,
    };
  }

  /** Conta do roteador (`whopl_<biz>`), com a chave do seller já decifrada. */
  async getProviderAccountById(id: string): Promise<ProviderAccountConfig | null> {
    if (!isLinkedProviderAccountId(id)) return null;
    const whopAccountId = whopAccountIdFromLinkedProviderAccountId(id);

    const { data } = await supabase.from(TABLE).select('*').eq('whop_account_id', whopAccountId).maybeSingle();
    const row = (data as WhopLinkedAccountRow) ?? null;
    if (!row) return null;
    return this.toProviderAccount(row);
  }

  async getProviderAccountForSeller(sellerId: string): Promise<ProviderAccountConfig | null> {
    const row = await this.getRow(sellerId);
    if (!row || linkedChargeBlocker(row)) return null;
    return this.toProviderAccount(row);
  }

  private toProviderAccount(row: WhopLinkedAccountRow): ProviderAccountConfig | null {
    const apiKey = this.reveal(row);
    if (!apiKey || !row.whop_account_id) return null;
    return {
      id: toLinkedProviderAccountId(row.whop_account_id),
      provider: 'whop',
      status: row.status === 'active' ? 'active' : 'inactive',
      weight: 1,
      supported_methods: ['all'],
      api_url: row.api_url ?? WHOP_API_URL_DEFAULT,
      apiKey,
      config: {
        company_id: row.whop_account_id,
        // `linked`: a cobrança vai sem application fee e a venda não entra na
        // carteira da Koopfy (o dinheiro é do seller).
        linked: true,
        seller_id: row.seller_id,
        // Segredo do webhook que criamos na conta dele, para validar o evento.
        webhook_secret: row.webhook_secret ? this.decryptOrNull(row.webhook_secret) : undefined,
      },
    };
  }

  private reveal(row: WhopLinkedAccountRow): string | undefined {
    if (!row.api_key) return undefined;
    try {
      return this.crypto.decrypt(row.api_key);
    } catch (err: any) {
      console.error(`[WhopLinked] chave de ${row.seller_id} indecifrável:`, err?.message);
      return undefined;
    }
  }

  private decryptOrNull(value: string): string | undefined {
    try {
      return this.crypto.decrypt(value);
    } catch {
      return undefined;
    }
  }

  private async whopGet(apiKey: string, apiUrl: string, path: string) {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message ?? `Whop HTTP ${response.status} em ${path}`);
    }
    return json;
  }

  private async whopPost(apiKey: string, apiUrl: string, path: string, body: Record<string, any>) {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json?.error?.message ?? `Whop HTTP ${response.status} em ${path}`);
    }
    return json;
  }

  /**
   * Cria o webhook na conta do seller apontando para a rota desta conta
   * (`/webhook/whop/whopl_<biz>`). A Whop só devolve o segredo na criação, por
   * isso ele é guardado aqui, cifrado.
   */
  private async registerWebhook(
    apiKey: string,
    apiUrl: string,
    companyId: string,
    accountId: string,
  ): Promise<{ id: string | null; secret: string | null }> {
    const base = process.env.PAY_PUBLIC_URL ?? 'https://api.koopfy.com/pay';
    const response = await fetch(`${apiUrl}/api/v1/webhooks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        // `resource_id` (não `company_id`): este endpoint é a exceção na API.
        resource_id: companyId,
        url: `${base}/webhook/whop/${accountId}`,
        events: [
          'payment.succeeded',
          'payment.failed',
          'membership.activated',
          'membership.deactivated',
          'membership.cancel_at_period_end_changed',
          'refund.created',
          'dispute.created',
          'dispute_alert.created',
        ],
        api_version: 'v1',
        enabled: true,
      }),
    }).catch((err: any) => {
      throw new BadRequestException(`Não foi possível criar o webhook na sua conta Whop (${err?.message ?? 'erro de rede'}).`);
    });

    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new BadRequestException(
        json?.error?.message
          ?? `A Whop recusou a criação do webhook (HTTP ${response.status}). A chave precisa de permissão para gerenciar webhooks.`,
      );
    }
    return { id: json?.id ?? null, secret: json?.webhook_secret ?? null };
  }

  /** Quem é a company da chave — também serve de validação da chave. */
  private async readCompany(apiKey: string): Promise<{ id: string; title: string | null; apiUrl: string }> {
    const apiUrl = process.env.WHOP_API_URL?.trim() || WHOP_API_URL_DEFAULT;
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/api/v5/company`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
    } catch (err: any) {
      throw new BadRequestException(`Não foi possível falar com a Whop agora (${err?.message ?? 'erro de rede'}).`);
    }

    const json: any = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      throw new BadRequestException('A Whop recusou esta chave. Confira se copiou a chave certa e se ela tem permissão de cobrança.');
    }
    if (!response.ok) {
      throw new BadRequestException(json?.error?.message ?? `A Whop respondeu ${response.status} ao validar a chave.`);
    }

    const id = String(json?.id ?? '').trim();
    if (!id) throw new BadRequestException('A Whop não informou a conta desta chave.');
    return { id, title: json?.title ?? null, apiUrl };
  }
}

/**
 * Atalho para o caminho da venda: o seller cobra na conta dele? Sem DI porque
 * o serviço de pagamentos monta as taxas antes de resolver a conta no router.
 */
/**
 * Comissão da Koopfy (%) quando o seller cobra na conta Whop PRÓPRIA dele;
 * null quando a venda não sai por lá. Percentual do CRM ou 3%.
 */
export async function ownWhopAccountCommissionPct(sellerId: string): Promise<number | null> {
  const { data } = await supabase
    .from(TABLE)
    .select('status, whop_account_id, last_error, commission_pct')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (!data || linkedChargeBlocker(data as WhopLinkedAccountRow) !== null) return null;
  // null/ausente = padrão (Number(null) seria 0% e a Koopfy não cobraria nada).
  const raw = (data as any).commission_pct;
  const pct = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_LINKED_COMMISSION_PCT;
}

export async function sellerChargesOnOwnWhopAccount(sellerId: string): Promise<boolean> {
  const { data } = await supabase
    .from(TABLE)
    .select('status, whop_account_id, last_error')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (!data) return false;
  return linkedChargeBlocker(data as WhopLinkedAccountRow) === null;
}

/**
 * Seller que pode cobrar e ativar o checkout: aprovado pela Koopfy, ou ainda
 * sem aprovação mas cobrando numa conta PRÓPRIA dele (Whop, Stripe ou PayPal).
 *
 * No modo conta externa a liberação no CRM faz as vezes da aprovação: quem faz
 * o KYC da empresa é a Whop, e o dinheiro nunca passa pela Koopfy. Por isso a
 * exceção vale só enquanto a conta dele está conectada e cobrando — chave
 * recusada ou conexão desligada volta a travar, e a venda nunca cai no pool da
 * Koopfy (o router só manda para a conta dele). Recusado e suspenso não passam.
 */
export async function sellerMayOperate(seller: { id: string; status?: string | null } | null): Promise<boolean> {
  if (!seller) return false;
  if (seller.status === 'active') return true;
  if (seller.status !== 'pending_review') return false;
  return sellerChargesOnAnyOwnAccount(seller.id);
}
