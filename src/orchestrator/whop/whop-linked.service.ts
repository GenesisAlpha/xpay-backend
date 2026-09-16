import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';
import {
  DEFAULT_LINKED_COMMISSION_PCT,
  WhopLinkedAccountRow,
  isLinkedProviderAccountId,
  linkedChargeBlocker,
  toLinkedProviderAccountId,
  whopAccountIdFromLinkedProviderAccountId,
} from './whop-linked';

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

// Duplicado de whop-accounts.service de propósito: importar de lá fecharia um
// ciclo (whop-accounts → whop-linked → whop-accounts) e a injeção do Nest
// receberia `undefined` no meio do ciclo.
const WHOP_API_URL_DEFAULT = 'https://api.whop.com';

// A conta muda pouco e toda cobrança consulta: cache curto evita ida ao banco
// no caminho quente sem segurar uma revogação por muito tempo.
const CACHE_TTL_MS = 15 * 1000;

@Injectable()
export class WhopLinkedAccountsService {
  constructor(private readonly crypto: CryptoService) {}

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
   * Libera (ou corta) o modo conta externa para o seller. Só depois disso o
   * painel dele mostra "Conecte seu provedor externo" — quem conecta é ele.
   */
  async allow(sellerId: string, enabled: boolean, actor: string | null = null) {
    const row = await this.getRow(sellerId);
    const now = new Date().toISOString();

    if (!enabled) {
      if (!row) return this.publicView(null);
      const { error } = await supabase
        .from(TABLE)
        .update({ status: 'disabled', updated_at: now })
        .eq('seller_id', sellerId);
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

  /** Conta pronta para cobrar? É o que decide o roteamento da venda. */
  async isChargeable(sellerId: string): Promise<boolean> {
    const row = await this.getRow(sellerId);
    return row?.status === 'active' && linkedChargeBlocker(row) === null;
  }

  /**
   * Liga a conta do seller: valida a chave contra a Whop (quem é a company),
   * recusa conta que já é filha da Koopfy ou de outro seller, e guarda cifrada.
   */
  async connect(sellerId: string, apiKey: string, actor: string | null = null) {
    const key = String(apiKey ?? '').trim();
    if (!key) throw new BadRequestException('Informe a chave de API da sua conta Whop.');

    // O modo conta externa é liberado pela equipe, a pedido do seller. Sem
    // liberação, ninguém conecta uma conta de fora sozinho.
    const current = await this.getRow(sellerId);
    if (!current || current.status === 'disabled') {
      throw new BadRequestException('O modo conta externa não está liberado para esta conta. Fale com o atendimento da Koopfy.');
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

    // Como a Koopfy recebe: afiliada da conta dele, com rev-share do percentual
    // combinado. Falhar aqui NÃO derruba a conexão — a venda já sai, e o CRM
    // mostra que a comissão ficou pendente para o time resolver.
    const commissionPct = Number(current.commission_pct ?? DEFAULT_LINKED_COMMISSION_PCT);
    const affiliate = await this.setupAffiliate(key, company.apiUrl, company.id, commissionPct).catch((err: any) => {
      console.error(`[WhopLinked] afiliado na conta ${company.id}:`, err?.message);
      return { id: null, code: null, overrideId: null, error: String(err?.message ?? err).slice(0, 300) };
    });

    const now = new Date().toISOString();
    const { error } = await supabase.from(TABLE).upsert(
      {
        seller_id: sellerId,
        whop_account_id: company.id,
        company_title: company.title,
        api_key: this.crypto.encrypt(key),
        api_url: company.apiUrl,
        webhook_id: webhook.id,
        webhook_secret: webhook.secret ? this.crypto.encrypt(webhook.secret) : null,
        commission_pct: commissionPct,
        affiliate_id: affiliate.id,
        affiliate_code: affiliate.code,
        affiliate_override_id: affiliate.overrideId,
        status: 'active',
        last_checked_at: now,
        last_error: (affiliate as any).error ?? null,
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
    await this.log(sellerId, actor, 'whop_linked.connected', {
      whop_account_id: company.id,
      company_title: company.title,
      webhook_id: webhook.id,
    });
    return this.publicView(await this.getRow(sellerId));
  }

  /** Desliga a conexão. As vendas voltam a sair pela conta da Koopfy. */
  async disconnect(sellerId: string, reason: string, actor: string | null = null) {
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta Whop própria conectada.');

    const { error } = await supabase
      .from(TABLE)
      .update({ status: 'disabled', last_error: reason || null, updated_at: new Date().toISOString(), created_by: actor ?? row.created_by })
      .eq('seller_id', sellerId);
    if (error) throw new BadRequestException(`Não foi possível desligar a conexão: ${error.message}`);

    this.cache.delete(sellerId);
    await this.log(sellerId, actor, 'whop_linked.disconnected', { reason: reason || null });
    return this.publicView(await this.getRow(sellerId));
  }

  /** Comissão da Koopfy nessa conta (cobrada como afiliado na Whop). */
  async setCommission(sellerId: string, commissionPct: number, actor: string | null = null) {
    const pct = Number(commissionPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 25) {
      throw new BadRequestException('Comissão deve ficar entre 0% e 25%.');
    }

    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta Whop própria conectada.');

    // O percentual que vale é o que está na Whop: sem atualizar a rev-share, o
    // número mudaria só na nossa tela e a comissão continuaria a antiga.
    const patch: Record<string, any> = { commission_pct: pct, updated_at: new Date().toISOString() };
    const apiKey = this.reveal(row);
    if (row.affiliate_id && apiKey) {
      try {
        const override = await this.createOverride(apiKey, row.api_url ?? WHOP_API_URL_DEFAULT, row.affiliate_id, pct);
        patch.affiliate_override_id = override?.id ?? row.affiliate_override_id;
        patch.last_error = null;
      } catch (err: any) {
        throw new BadRequestException(`A Whop recusou a nova comissão: ${err?.message ?? err}`);
      }
    } else {
      patch.last_error = 'comissão salva só na Koopfy: a conta dele ainda não tem afiliado configurado';
    }

    const { error } = await supabase.from(TABLE).update(patch).eq('seller_id', sellerId);
    if (error) throw new BadRequestException(`Não foi possível salvar a comissão: ${error.message}`);

    this.cache.delete(sellerId);
    await this.log(sellerId, actor, 'whop_linked.commission_changed', { commission_pct: pct });
    return this.publicView(await this.getRow(sellerId));
  }

  /** Cada ação fica no log do seller: quem conectou a conta dele e quando. */
  private async log(sellerId: string, managerId: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: managerId,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload,
      created_at: new Date().toISOString(),
    });
    if (error) console.error(`[WhopLinked] ação ${action} não registrada:`, error.message);
  }

  /** O que o painel e o CRM podem ver: nunca a chave. */
  publicView(row: WhopLinkedAccountRow | null) {
    if (!row) return { allowed: false as const, connected: false as const };
    return {
      // Liberado pela equipe: o painel do seller mostra "conecte seu provedor".
      allowed: row.status !== 'disabled',
      connected: Boolean(row.whop_account_id && row.api_key),
      whopAccountId: row.whop_account_id,
      companyTitle: row.company_title,
      status: row.status,
      commissionPct: Number(row.commission_pct ?? 0),
      // Sem afiliado + rev-share na conta dele, a Koopfy não recebe nada.
      affiliateReady: Boolean(row.affiliate_id && row.affiliate_override_id),
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
        // Vai em cada checkout: é o que atribui a venda à Koopfy e paga a comissão.
        affiliate_code: row.affiliate_code ?? undefined,
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

  /**
   * Como a Koopfy recebe: vira afiliada da conta dele e ganha uma rev-share do
   * percentual combinado. O `affiliate_code` viaja em cada checkout que
   * criamos — as vendas que ele fizer por fora não entram na comissão.
   *
   * A Whop credita no saldo da conta Koopfy e estorna sozinha no reembolso.
   */
  private async setupAffiliate(apiKey: string, apiUrl: string, companyId: string, commissionPct: number) {
    const identifier = process.env.KOOPFY_WHOP_AFFILIATE?.trim();
    if (!identifier) {
      throw new Error('KOOPFY_WHOP_AFFILIATE ausente: sem ele a Koopfy não vira afiliada e a comissão não é cobrada.');
    }

    const affiliate = await this.whopPost(apiKey, apiUrl, '/api/v1/affiliates', {
      account_id: companyId,
      user_identifier: identifier,
    });
    const id = String(affiliate?.id ?? '').trim();
    if (!id) throw new Error('A Whop não devolveu o afiliado criado.');

    const override = await this.createOverride(apiKey, apiUrl, id, commissionPct);
    return {
      id,
      code: affiliate?.affiliate_code ?? affiliate?.code ?? null,
      overrideId: override?.id ?? null,
    };
  }

  /** Rev-share da conta toda: vale para qualquer produto dele vendido pela Koopfy. */
  private createOverride(apiKey: string, apiUrl: string, affiliateId: string, commissionPct: number) {
    return this.whopPost(apiKey, apiUrl, `/api/v1/affiliates/${encodeURIComponent(affiliateId)}/overrides`, {
      override_type: 'rev_share',
      commission_type: 'percentage',
      commission_value: commissionPct,
      // Sobre o líquido, depois das taxas da Whop — o que sobra de verdade.
      revenue_basis: 'post_fees',
    });
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
export async function sellerChargesOnOwnWhopAccount(sellerId: string): Promise<boolean> {
  const { data } = await supabase
    .from(TABLE)
    .select('status, whop_account_id, last_error')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (!data) return false;
  return linkedChargeBlocker(data as WhopLinkedAccountRow) === null;
}
