import { Injectable } from '@nestjs/common';
import { supabase } from '../../lib/supabase.client';
import { CryptoService } from '../../crypto/crypto.service';
import { ProviderAccountConfig } from '../provider-accounts.config';

// ============================================================================
// CLIP ACCOUNTS — pool dinâmico (tabelas gw_card_accounts / gw_spei_accounts)
// ----------------------------------------------------------------------------
// Mesmo desenho dos pools Whop e Stripe: N contas que entram e saem por decisão
// operacional, sem deploy. O que muda — e muda tudo — é COMO o teto é aplicado.
//
// ⚠️ ESTE POOL NÃO USA account_daily_metrics, E NÃO PODE USAR.
// Os outros pools contam volume DEPOIS do pagamento (markPaid). Clip não
// permite: o SDK monta o iframe do cartão com a PUBLIC KEY e o token que sai
// dali só é cobrável pelo SECRET DA MESMA CONTA. A conta é escolhida antes de o
// comprador digitar o cartão, e entre a escolha e a cobrança passam minutos.
// Um contador pós-fato não enxerga o que está em voo: dois checkouts
// simultâneos furam o teto sem erro nenhum.
//
// Por isso o teto vive no banco, como RESERVA atômica (gw_hold_card), e este
// serviço NÃO informa daily_cap_amount ao AccountRouterService. Deixar o
// withinDailyCap do router opinar aqui seria um segundo teto, em outra unidade
// (USD cents), discordando silenciosamente do primeiro.
//
// ⚠️ UNIDADES. Tudo aqui é em centavos de MXN. account_daily_metrics é em
// centavos de USD. Os dois nunca se encontram.
//
// Ver: apps/pay/supabase_gw_routing_migration.sql
// ============================================================================

export interface ClipCardAccountRow {
  id: string;
  label: string | null;
  provider: string;
  currency: string;
  country: string;
  risk_level: 'WHITE' | 'GRAY';
  public_key: string;
  daily_cap_minor: number;
  upsell_headroom_minor: number;
  weight: number | null;
  priority: number | null;
  min_ticket_minor: number | null;
  max_ticket_minor: number | null;
  status: string;
  cooldown_until: string | null;
  metadata: Record<string, any> | null;
}

export interface ClipSpeiAccountRow {
  id: string;
  label: string | null;
  currency: string;
  country: string;
  risk_level: 'WHITE' | 'GRAY';
  clabe: string;
  banco: string;
  beneficiario: string;
  balance_cap_minor: number;
  buffer_pct: number;
  reserved_minor: number;
  occupied_minor: number;
  weight: number | null;
  priority: number | null;
  status: string;
  metadata: Record<string, any> | null;
}

const CARD_COLUMNS =
  'id, label, provider, currency, country, risk_level, public_key, daily_cap_minor, upsell_headroom_minor, ' +
  'weight, priority, min_ticket_minor, max_ticket_minor, status, cooldown_until, metadata';

const SPEI_COLUMNS =
  'id, label, currency, country, risk_level, clabe, banco, beneficiario, balance_cap_minor, ' +
  'buffer_pct, reserved_minor, occupied_minor, weight, priority, status, metadata';

export type CardHold = {
  reservation_id: string;
  account_id: string;
  public_key: string;
  held_minor: number;
};

export type SpeiHold = {
  reservation_id: string;
  account_id: string;
  clabe: string;
  banco: string;
  beneficiario: string;
  charge_minor: number;
};

@Injectable()
export class ClipAccountsService {
  constructor(private readonly crypto: CryptoService) { }

  private cache: ProviderAccountConfig[] | null = null;
  private hydratedAt = 0;

  // Mesmo TTL dos outros pools. Vale para o CADASTRO das contas (chaves, status),
  // nunca para o contador — o contador é lido e escrito no mesmo statement
  // atômico dentro do Postgres, e cachear isso seria recriar a corrida que a
  // reserva existe para matar.
  private readonly CACHE_TTL_MS = 30 * 1000;

  invalidate() {
    this.cache = null;
    this.hydratedAt = 0;
  }

  // ─────────────────────────────────────────────
  // Pool roteável (cartão)
  // ─────────────────────────────────────────────

  async listActive(): Promise<ProviderAccountConfig[]> {
    const fresh = this.cache && Date.now() - this.hydratedAt < this.CACHE_TTL_MS;
    if (fresh) return this.cache!;

    const { data, error } = await supabase
      .from('gw_card_accounts')
      .select(CARD_COLUMNS)
      .eq('status', 'active');

    if (error) {
      // Tabela faltando não é instabilidade — é migration que não rodou. E o
      // sintoma que chega ao seller ("nenhuma conta disponível") não sugere isso
      // em nada. Mesma lição do pool Stripe.
      if (/relation .* does not exist|schema cache/i.test(error.message)) {
        console.error(
          '[ClipAccounts] tabela `gw_card_accounts` NÃO EXISTE. Rode a migration '
          + 'apps/pay/supabase_gw_routing_migration.sql — sem ela nenhum pagamento '
          + 'Clip sai do lugar.',
        );
      } else {
        console.error('[ClipAccounts] listActive error:', error.message);
      }
      // Cache velho vale mais que pool vazio: pool vazio derruba todo pagamento
      // Clip até o Supabase voltar.
      return this.cache ?? [];
    }

    const mapped = await Promise.all(
      (data ?? []).map(row => this.toProviderAccount(row as unknown as ClipCardAccountRow)),
    );

    this.cache = mapped;
    this.hydratedAt = Date.now();
    return mapped;
  }

  async getById(id: string): Promise<ProviderAccountConfig | null> {
    const cached = this.cache?.find(a => a.id === id);
    if (cached && Date.now() - this.hydratedAt < this.CACHE_TTL_MS) return cached;

    const { data, error } = await supabase
      .from('gw_card_accounts')
      .select(CARD_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error('[ClipAccounts] getById error:', error.message);
      return cached ?? null;
    }
    if (!data) return null;

    // Sem filtro de status de propósito: webhook e consulta de status de uma
    // conta pausada continuam chegando, e é dinheiro que já entrou. Quem barra
    // a conta é o pool (listActive), não este lookup.
    return this.toProviderAccount(data as unknown as ClipCardAccountRow);
  }

  // ─────────────────────────────────────────────
  // RESERVA — o caminho quente
  //
  // Uma chamada, um round-trip, decisão e débito no mesmo statement. Devolve
  // null quando NÃO HÁ CAPACIDADE — que é um resultado legítimo, não um erro.
  // Quem chama não pode dar retry: retry não cria teto, só consome latência do
  // comprador que está com o cartão na mão.
  // ─────────────────────────────────────────────

  async holdCard(args: {
    amountMinor: number;
    sellerId: string;
    country: string;
    riskLevel: 'WHITE' | 'GRAY';
    currency?: string;
    externalReference?: string | null;
    ttlMinutes?: number;
  }): Promise<CardHold | null> {
    const { data, error } = await supabase.rpc('gw_hold_card', {
      p_amount_minor: args.amountMinor,
      p_seller_id: args.sellerId,
      p_country: args.country,
      p_risk_level: args.riskLevel,
      p_currency: args.currency ?? 'MXN',
      p_external_reference: args.externalReference ?? null,
      p_ttl_minutes: args.ttlMinutes ?? 180,
    });

    if (error) {
      console.error('[ClipAccounts] gw_hold_card error:', error.message);
      // Erro de RPC não é falta de capacidade. Devolver null aqui fazia o
      // endpoint responder `available:false` e escondia migrations quebradas
      // como se o teto da conta estivesse cheio.
      throw new Error(`gw_hold_card falhou: ${error.message}`);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ? (row as CardHold) : null;
  }

  async holdSpei(args: {
    amountMinor: number;
    sellerId: string;
    country: string;
    riskLevel: 'WHITE' | 'GRAY';
    currency?: string;
    externalReference?: string | null;
    ttlMinutes?: number;
  }): Promise<SpeiHold | null> {
    // Retry do mesmo pedido deve devolver a reserva já criada. Sem isto, uma
    // resposta perdida entre o RPC e o browser pode marcar a transação como
    // falha e, na repetição, consumir o teto uma segunda vez.
    if (args.externalReference) {
      const { data: existing, error: existingError } = await supabase
        .from('gw_reservations')
        .select('id, account_id, charge_minor')
        .eq('external_reference', args.externalReference)
        .eq('seller_id', args.sellerId)
        .eq('method', 'spei')
        .eq('state', 'held')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingError) {
        console.error('[ClipAccounts] lookup de reserva SPEI error:', existingError.message);
        throw new Error('Falha ao consultar reserva SPEI existente.');
      }

      if (existing) {
        const { data: account, error: accountError } = await supabase
          .from('gw_spei_accounts')
          .select('clabe, banco, beneficiario')
          .eq('id', existing.account_id)
          .maybeSingle();

        if (accountError || !account) {
          console.error('[ClipAccounts] conta da reserva SPEI error:', accountError?.message);
          throw new Error('Conta da reserva SPEI existente não foi encontrada.');
        }

        return {
          reservation_id: existing.id,
          account_id: existing.account_id,
          clabe: account.clabe,
          banco: account.banco,
          beneficiario: account.beneficiario,
          charge_minor: existing.charge_minor,
        };
      }
    }

    const { data, error } = await supabase.rpc('gw_hold_spei', {
      p_amount_minor: args.amountMinor,
      p_seller_id: args.sellerId,
      p_country: args.country,
      p_risk_level: args.riskLevel,
      p_currency: args.currency ?? 'MXN',
      p_external_reference: args.externalReference ?? null,
      p_ttl_minutes: args.ttlMinutes ?? 180,
    });

    if (error) {
      console.error('[ClipAccounts] gw_hold_spei error:', error.message);
      // Erro de RPC não é "sem capacidade". Propagar evita gravar
      // SPEI_CAPACITY_EXHAUSTED quando o problema real é banco/schema/rede.
      throw new Error('Falha ao reservar conta SPEI.');
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row ? (row as SpeiHold) : null;
  }

  // ─────────────────────────────────────────────
  // POR QUE NÃO HOUVE CONTA SPEI
  //
  // `gw_hold_spei` devolve zero linhas por SEIS motivos diferentes, e todos
  // chegavam ao operador como a mesma frase — "indisponível no momento" — que
  // soa como falta de capacidade e manda investigar o lugar errado. Na prática
  // a causa mais comum é a mais boba: a conta ficou `inactive` porque o seed a
  // insere assim de propósito e alguém ativou só a de cartão.
  //
  // Roda SÓ no caminho de falha: custo zero no fluxo normal.
  // ─────────────────────────────────────────────

  async diagnosticarSpei(args: {
    amountMinor: number; country: string; riskLevel: string; currency?: string;
  }): Promise<string> {
    const { data, error } = await supabase
      .from('gw_spei_accounts')
      .select('id, status, currency, country, risk_level, reserved_minor, occupied_minor, balance_cap_minor, buffer_pct');

    if (error) return `não foi possível diagnosticar (${error.message})`;
    if (!data?.length) {
      return 'NENHUMA conta SPEI cadastrada — o seed (supabase_gw_routing_seed.example.sql) não rodou.';
    }

    const moeda = (args.currency ?? 'MXN').toUpperCase();
    const linhas = data.map((a: any) => {
      const motivos: string[] = [];
      if (a.status !== 'active') motivos.push(`status=${a.status} (ative: update gw_spei_accounts set status='active' where id='${a.id}')`);
      if (String(a.currency).toUpperCase() !== moeda) motivos.push(`moeda=${a.currency}≠${moeda}`);
      if (String(a.country).toUpperCase() !== args.country.toUpperCase()) motivos.push(`país=${a.country}≠${args.country}`);

      // Isolamento estrito: WHITE somente em WHITE e GRAY somente em GRAY.
      const rc = String(a.risk_level).toUpperCase();
      const rs = args.riskLevel.toUpperCase();
      if (rc !== rs) motivos.push(`risco conta=${rc} vs seller=${rs}`);

      const teto = Math.floor(Number(a.balance_cap_minor) * (1 - Number(a.buffer_pct)));
      if (Number(a.occupied_minor) + args.amountMinor > teto) {
        motivos.push(`sem espaço: ocupado ${a.occupied_minor} + ${args.amountMinor} > teto com colchão ${teto} (reservado ${a.reserved_minor} é apenas informativo)`);
      }
      return `${a.id}: ${motivos.length ? motivos.join(' · ') : 'ELEGÍVEL (corrida? reserva concorrente tomou o espaço)'}`;
    });

    return linhas.join(' | ');
  }

  // ─────────────────────────────────────────────
  // Reserva por id — a REVALIDAÇÃO no servidor.
  //
  // ⚠️ NUNCA confie no account_id que o browser mandou. Se o servidor aceitar
  // qual conta usar vindo do cliente, o cliente escolhe em qual conta cobrar e
  // o teto por conta vira decoração — basta apontar sempre para a mesma conta,
  // ou para uma que já estouraria. A reserva é a única fonte: ela diz qual
  // conta foi debitada, e é a essa que a cobrança tem que ir.
  // ─────────────────────────────────────────────

  async getReservation(reservationId: string): Promise<{
    id: string; seller_id: string; method: string; account_id: string; state: string;
    amount_minor: number; charge_minor: number; held_minor: number;
    currency: string; country: string; risk_level: string; expires_at: string;
  } | null> {
    const { data, error } = await supabase
      .from('gw_reservations')
      .select('id, seller_id, method, account_id, state, amount_minor, charge_minor, held_minor, currency, country, risk_level, expires_at')
      .eq('id', reservationId)
      .maybeSingle();

    if (error) {
      console.error('[ClipAccounts] getReservation error:', error.message);
      return null;
    }
    return (data as any) ?? null;
  }

  // Migra espaço de reservado para capturado. Idempotente pelo clip_payment_id
  // (constraint unique em gw_captures) — o webhook pode reentregar à vontade.
  // Retorna true só quando ESTA chamada foi a que contabilizou.
  async capture(args: {
    reservationId: string;
    amountMinor: number;
    clipPaymentId?: string | null;
    kind?: string;
    receiptNo?: string | null;
    installments?: number | null;
    source?: string;
  }): Promise<boolean> {
    const { data, error } = await supabase.rpc('gw_capture', {
      p_reservation_id: args.reservationId,
      p_amount_minor: args.amountMinor,
      p_clip_payment_id: args.clipPaymentId ?? null,
      p_kind: args.kind ?? 'base',
      p_receipt_no: args.receiptNo ?? null,
      p_installments: args.installments ?? null,
      p_source: args.source ?? null,
    });

    if (error) {
      // ⚠️ Falhar aqui NÃO desfaz a cobrança — o dinheiro já entrou na Clip.
      // Gritar alto é o mínimo: o contador ficou menor que a realidade, e a
      // conta vai aceitar mais volume do que deveria até alguém conciliar.
      console.error(
        `[ClipAccounts] 🚨 gw_capture FALHOU para a reserva ${args.reservationId} `
        + `(payment ${args.clipPaymentId ?? 'sem id'}): ${error.message}. `
        + 'O pagamento existe na Clip e NÃO está contabilizado no teto.',
      );
      return false;
    }
    return data === true;
  }

  // Devolve o espaço reservado. `reason` separa "recusado" de "fluxo terminou" —
  // sem isso as duas ficam idênticas no histórico do dash.
  async release(reservationId: string, reason: string): Promise<void> {
    const { error } = await supabase.rpc('gw_release', {
      p_reservation_id: reservationId,
      p_reason: reason,
    });
    if (error) console.error('[ClipAccounts] gw_release error:', error.message);
  }

  // Venda aprovada e fluxo de upsell encerrado: devolve só a folga que sobrou.
  // Sem isto a folga só volta no TTL, e até lá é teto parado à toa.
  async finalize(reservationId: string): Promise<void> {
    const { error } = await supabase.rpc('gw_finalize', { p_reservation_id: reservationId });
    if (error) console.error('[ClipAccounts] gw_finalize error:', error.message);
  }

  // ─────────────────────────────────────────────
  // UPSELL DE UM CLIQUE — tokens extras da compra
  //
  // A Clip não guarda cartão: o token é de um uso e vale 15 min. O checkout
  // gera alguns tokens a mais enquanto o formulário está vivo e manda com a
  // compra; cada oferta aceita no funil consome um. Ver a migration
  // 20261007140000_gw_clip_upsell_tokens.
  // ─────────────────────────────────────────────

  /** Vida útil que assumimos: 15 min da Clip menos a folga da viagem. */
  static readonly UPSELL_TOKEN_TTL_MS = 14 * 60 * 1000;
  static readonly MAX_UPSELL_TOKENS = 5;

  async storeUpsellTokens(args: {
    transactionId: string;
    sellerId: string;
    accountId: string;
    reservationId: string | null;
    sessionId?: string | null;
    tokens: string[];
  }): Promise<number> {
    const tokens = args.tokens.slice(0, ClipAccountsService.MAX_UPSELL_TOKENS);
    if (!tokens.length) return 0;
    const expiresAt = new Date(Date.now() + ClipAccountsService.UPSELL_TOKEN_TTL_MS).toISOString();
    const rows = tokens.map(t => ({
      transaction_id: args.transactionId,
      seller_id: args.sellerId,
      account_id: args.accountId,
      reservation_id: args.reservationId,
      token_enc: this.crypto.encrypt(t),
      session_id: args.sessionId ?? null,
      expires_at: expiresAt,
    }));
    const { error } = await supabase.from('gw_clip_upsell_tokens').insert(rows);
    if (error) {
      // Sem os tokens a compra continua valendo; só o funil não oferece upsell.
      console.error('[ClipAccounts] tokens de upsell não gravados:', error.message);
      return 0;
    }
    return rows.length;
  }

  /** Quantos tokens ainda dão para cobrar (elegibilidade da oferta). */
  async availableUpsellTokens(transactionId: string): Promise<number> {
    const { count, error } = await supabase
      .from('gw_clip_upsell_tokens')
      .select('id', { count: 'exact', head: true })
      .eq('transaction_id', transactionId)
      .is('used_at', null)
      .gt('expires_at', new Date(Date.now() + 20_000).toISOString());
    if (error) {
      console.error('[ClipAccounts] contagem de tokens de upsell:', error.message);
      return 0;
    }
    return count ?? 0;
  }

  /** Consome um token (atômico). null = acabaram ou venceram. */
  async takeUpsellToken(parentTransactionId: string, usedBy: string): Promise<{
    accountId: string; reservationId: string | null; token: string; sessionId: string | null;
  } | null> {
    const { data, error } = await supabase.rpc('gw_take_clip_upsell_token', {
      p_transaction_id: parentTransactionId,
      p_used_by: usedBy,
    });
    if (error) {
      console.error('[ClipAccounts] gw_take_clip_upsell_token:', error.message);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.token_enc) return null;
    try {
      return {
        accountId: row.account_id,
        reservationId: row.reservation_id ?? null,
        token: this.crypto.decrypt(row.token_enc),
        sessionId: row.session_id ?? null,
      };
    } catch (err: any) {
      console.error('[ClipAccounts] token de upsell ilegível:', err?.message);
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SPEI — cadastro e saque
  // ─────────────────────────────────────────────

  async listActiveSpei(): Promise<ClipSpeiAccountRow[]> {
    const { data, error } = await supabase
      .from('gw_spei_accounts')
      .select(SPEI_COLUMNS)
      .eq('status', 'active');

    if (error) {
      console.error('[ClipAccounts] listActiveSpei error:', error.message);
      return [];
    }
    return (data ?? []) as unknown as ClipSpeiAccountRow[];
  }

  // Único ponto em que a VERDADE sobre o saldo SPEI entra no sistema. Ver o
  // comentário de gw_spei_withdraw na migration: `saldoObservadoMinor` é o que
  // permite detectar dinheiro que entrou sem passar pelo checkout.
  async withdrawSpei(args: {
    accountId: string;
    saldoObservadoMinor: number;
    valorSacadoMinor: number;
    createdBy?: string | null;
    nota?: string | null;
  }) {
    const { data, error } = await supabase.rpc('gw_spei_withdraw', {
      p_account_id: args.accountId,
      p_saldo_observado_minor: args.saldoObservadoMinor,
      p_valor_sacado_minor: args.valorSacadoMinor,
      p_created_by: args.createdBy ?? null,
      p_nota: args.nota ?? null,
    });

    if (error) throw new Error(`gw_spei_withdraw: ${error.message}`);
    return Array.isArray(data) ? data[0] : data;
  }

  // Capacidade das duas famílias no mesmo formato — o que o dash desenha.
  async capacity() {
    const { data, error } = await supabase
      .from('gw_capacity')
      .select('*')
      .order('method')
      .order('id');

    if (error) {
      console.error('[ClipAccounts] capacity error:', error.message);
      return [];
    }
    return data ?? [];
  }

  // ─────────────────────────────────────────────
  // MAPEAMENTO
  // ─────────────────────────────────────────────

  private async toProviderAccount(row: ClipCardAccountRow): Promise<ProviderAccountConfig> {
    return {
      id: row.id,
      provider: 'clip' as any,
      status: row.status === 'active' ? 'active' : 'inactive',
      weight: Number(row.weight ?? 1),
      // Clip MX processa cartão; SPEI não passa pela API dela (é transferência
      // direta para CLABE) e por isso NÃO entra aqui como método do provider.
      supported_methods: ['card'],
      countries: [row.country],
      risk_levels: [row.risk_level],
      country: row.country,

      // A secret key vive em apiKey — é o campo que executeWithProvider entrega
      // ao provider em providerConfig.apiKey.
      apiKey: await this.revealSecret(row.id),

      // ⚠️ daily_cap_amount FICA UNDEFINED DE PROPÓSITO.
      // O teto do Clip é reserva no banco, em centavos de MXN. Preencher este
      // campo faria o withinDailyCap do router comparar MXN contra o volume em
      // USD cents de account_daily_metrics e tirar a conta do pool por um
      // motivo que não existe.
      daily_cap_amount: undefined,
      min_ticket: row.min_ticket_minor ?? undefined,
      max_ticket: row.max_ticket_minor ?? undefined,
      cooldown_until: row.cooldown_until ?? undefined,

      config: {
        // Pública por design: monta o iframe de cartão no browser.
        public_key: row.public_key,
        currency: row.currency,
        label: row.label,
        daily_cap_minor: row.daily_cap_minor,
        upsell_headroom_minor: row.upsell_headroom_minor,
        priority: row.priority,
        ...(row.metadata ?? {}),
      },
    };
  }

  // ─────────────────────────────────────────────
  // O secret vem por RPC, não por tabela.
  //
  // private.gw_card_secrets está fora do schema exposto ao PostgREST, então
  // `.from('gw_card_secrets')` simplesmente não enxerga a tabela. A RPC
  // gw_card_secret é a ponte — e devolve o BLOB CIFRADO, nunca o secret. Quem
  // decifra é o CryptoService, com a CRYPTO_MASTER_KEY do ambiente do pay.
  // ─────────────────────────────────────────────

  private async revealSecret(accountId: string): Promise<string | undefined> {
    const { data, error } = await supabase.rpc('gw_card_secret', { p_account_id: accountId });

    if (error) {
      console.error(`[ClipAccounts] gw_card_secret(${accountId}) error:`, error.message);
      return undefined;
    }
    if (!data) {
      console.error(
        `[ClipAccounts] conta ${accountId} está ATIVA mas NÃO TEM SECRET cadastrado. `
        + 'Ela vai ser escolhida pelo roteador e falhar na cobrança. Rode: '
        + 'CRYPTO_MASTER_KEY=<hex> node ops/gw-encrypt.js ' + accountId,
      );
      return undefined;
    }

    const value = String(data);
    const parts = value.split(':');
    const looksEncrypted =
      parts.length === 3 && parts.every(p => /^[0-9a-f]+$/i.test(p) && p.length > 0);

    if (!looksEncrypted) {
      console.warn(`[ClipAccounts] ${accountId}.secret_enc em texto puro — cifre com ops/gw-encrypt.js.`);
      return value;
    }

    try {
      return this.crypto.decrypt(value);
    } catch (err: any) {
      console.error(`[ClipAccounts] falha ao decifrar o secret de ${accountId}:`, err?.message);
      return undefined;
    }
  }
}
