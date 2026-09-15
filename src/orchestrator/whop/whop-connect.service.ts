import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { supabase } from '../../lib/supabase.client';
import { StorageService } from '../../lib/storage.service';
import { ProviderAccountConfig } from '../provider-accounts.config';
import { WhopApiError, WhopPlatformClient } from './whop-platform.client';
import {
  ConnectedRiskTier,
  RELEASE_MIN_CENTS,
  RISK_RESERVE_PERCENTAGE,
  RfiAnswer,
  SellerRequirementItem,
  WhopConnectedAccountRow,
  classifyConnectedRisk,
  classifyWhopTransfer,
  connectedChargeBlocker,
  connectedWebhookSecret,
  decideConnectedMode,
  deriveConnectedStatus,
  escalateRiskTier,
  isDefinitiveWhopFailure,
  negativeFiatBalances,
  planBusinessVerification,
  planRfiAnswers,
  sellerRequirementItems,
  toConnectedProviderAccountId,
  whopAccountIdFromProviderAccountId,
} from './whop-connected';

// ============================================================================
// CONTAS CONECTADAS DA WHOP — ciclo de vida, roteamento, risco e dinheiro
// ----------------------------------------------------------------------------
// Só para seller com LLC americana. Seller com CNPJ (liberado no CRM) vende
// pela conta master — a Whop não verifica empresa brasileira.
//
// 1. CRM cria a conta (provision): conta filha nos EUA + EIN + verificação de
//    empresa (KYB). Documento, selfie e papéis da LLC seguem como resposta
//    automática aos pedidos de informação da Whop (answerRequestedInformation).
// 2. Webhook (account.updated, identity_profile.*) chama sync, que responde
//    os pedidos novos.
// 3. Verificação aprovada → o CRM liga o modo conectado: a venda nasce na
//    conta do seller (a disputa conta lá) e a application fee traz o dinheiro
//    para a master.
// 4. A carteira da Koopfy divide como sempre; o saldo liberado vai para a
//    conta conectada por transferência (releaseToSeller).
// 5. Reembolso/chargeback deixam a conta do seller negativa (ela fica zerada):
//    coverNegativeBalance cobre com a master, para a Whop não cobrar o seller
//    por um prejuízo que a Koopfy já descontou da carteira dele.
// 6. Chargeback acima de 1% → reserva de 10% na Koopfy. Ninguém é desativado.
// 7. Conta fora do ar → vendas na master por até 72h (sem reserva e sem corte
//    do CRM).
// ============================================================================

const TABLE = 'whop_connected_accounts';
const RISK_EVENTS_TABLE = 'whop_connected_risk_events';
const TRANSFERS_TABLE = 'whop_connected_transfers';

// Caminho quente: toda cobrança Whop consulta o modo do seller. 15s é curto o
// bastante para uma mudança valer já na próxima venda (sync/risco limpam o
// cache na hora).
const ROUTING_CACHE_TTL_MS = 15 * 1000;
const RISK_WINDOW_DAYS = 30;

// Limite da Whop por arquivo, antes do base64.
const WHOP_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

// Tipo no wallet_ledger da saída para a conta conectada.
const RELEASE_LEDGER_TYPE = 'debit_whop_transfer';
const CYCLE_INTERVAL_MS = 30 * 60 * 1000;

export type ConnectedRouting =
  | { mode: 'master'; fallbackReason?: string }
  | { mode: 'connected'; account: ProviderAccountConfig }
  | { mode: 'blocked'; reason: string };

@Injectable()
export class WhopConnectService implements OnModuleInit {
  private readonly routingCache = new Map<string, { at: number; routing: ConnectedRouting }>();
  private readonly answering = new Set<string>();
  private masterAccount: Promise<string> | null = null;
  private cycleRunning = false;

  constructor(
    private readonly whop: WhopPlatformClient,
    private readonly storage: StorageService,
  ) { }

  // Ciclo de 30 min:
  //  • cobertura de negativo — ligada por padrão (WHOP_CONNECTED_AUTO_COVER=false
  //    desliga): o reembolso/disputa chega por webhook, mas o débito na conta
  //    do seller pode acontecer depois do evento;
  //  • liberação automática — só com WHOP_CONNECTED_AUTO_RELEASE=true: é dinheiro
  //    saindo da master, e o primeiro ciclo precisa ser acompanhado.
  onModuleInit() {
    const autoCover = process.env.WHOP_CONNECTED_AUTO_COVER !== 'false';
    const autoRelease = process.env.WHOP_CONNECTED_AUTO_RELEASE === 'true';
    if (autoCover || autoRelease) {
      setInterval(() => void this.runCycle({ cover: autoCover, release: autoRelease }), CYCLE_INTERVAL_MS);
    }
  }

  // ─────────────────────────────────────────────
  // Leitura
  // ─────────────────────────────────────────────

  async getRow(sellerId: string): Promise<WhopConnectedAccountRow | null> {
    const { data, error } = await supabase.from(TABLE).select('*').eq('seller_id', sellerId).maybeSingle();
    if (error) throw new Error(`[WhopConnect] leitura do seller ${sellerId}: ${error.message}`);
    return (data as WhopConnectedAccountRow) ?? null;
  }

  async getRowByWhopAccount(whopAccountId: string): Promise<WhopConnectedAccountRow | null> {
    const { data, error } = await supabase.from(TABLE).select('*').eq('whop_account_id', whopAccountId).maybeSingle();
    if (error) throw new Error(`[WhopConnect] leitura da conta ${whopAccountId}: ${error.message}`);
    return (data as WhopConnectedAccountRow) ?? null;
  }

  async getStatus(sellerId: string) {
    const [account, source] = await Promise.all([this.getRow(sellerId), this.loadSellerSource(sellerId)]);
    const plan = planBusinessVerification(source.kyc, source.documents, { website: source.website });
    return {
      sellerId,
      account,
      mode: decideConnectedMode(account),
      companyType: source.documents?.company_type ?? null,
      missingForVerification: plan.missing,
    };
  }

  // ─────────────────────────────────────────────
  // Criação (CRM)
  // ─────────────────────────────────────────────

  async provision(sellerId: string, managerId: string) {
    if (!this.whop.isConfigured()) {
      throw new BadRequestException('Whop não configurada: defina WHOP_API_KEY.');
    }

    const source = await this.loadSellerSource(sellerId);
    if (source.seller.status !== 'active') {
      throw new BadRequestException('Aprove o seller antes de criar a conta conectada.');
    }
    if (source.documents?.company_type !== 'US') {
      throw new BadRequestException('Conta conectada é só para LLC americana. Seller com CNPJ vende pela conta master.');
    }
    if (!source.seller.email) {
      throw new BadRequestException('Seller sem e-mail: a Whop exige o e-mail do titular.');
    }

    const plan = planBusinessVerification(source.kyc, source.documents, { website: source.website });
    if (plan.missing.length > 0 || !plan.account || !plan.verification) {
      throw new BadRequestException({
        message: 'Dados incompletos para a verificação da Whop.',
        missing: plan.missing,
      });
    }

    let row = await this.getRow(sellerId);

    // Verificação já enviada e não recusada: reenviar criaria sessão duplicada.
    // O que falta chega como pedido de informação e é respondido, não reenviado.
    if (row?.verification_id && row.verification_status !== 'rejected') {
      return this.sync(sellerId);
    }

    if (!row) {
      const { data, error } = await supabase
        .from(TABLE)
        .insert({ seller_id: sellerId, status: 'provisioning', created_by: managerId })
        .select('*')
        .single();
      if (error || !data) throw new BadRequestException(`Não foi possível registrar a conta conectada: ${error?.message}`);
      row = data as WhopConnectedAccountRow;
    }

    try {
      let whopAccountId = row.whop_account_id;

      if (!whopAccountId) {
        const account = await this.whop.createAccount(
          {
            email: source.seller.email,
            title: String(plan.account.business_name).slice(0, 80),
            country: 'US',
            ...(plan.verification.business_website ? { website: plan.verification.business_website } : {}),
            // Nenhum e-mail transacional da Whop para o comprador: quem fala
            // com ele é a Koopfy.
            send_customer_emails: false,
            metadata: { external_id: sellerId, koopfy_seller_id: sellerId },
          },
          `koopfy_connect_account_${sellerId}`,
        );
        whopAccountId = String(account?.id ?? '');
        if (!whopAccountId.startsWith('biz_')) {
          throw new WhopApiError('Whop não devolveu o id da conta criada', 502, null, null);
        }
        await this.updateRow(sellerId, { whop_account_id: whopAccountId });
      }

      await this.whop.updateAccount(whopAccountId, { ...plan.account, send_customer_emails: false });

      // A chave muda quando os documentos mudam: reenviar depois de uma
      // recusa com documento novo cria outra verificação; clique duplo não.
      const documentsVersion = String(source.documents?.updated_at ?? source.documents?.submitted_at ?? 'v1')
        .replace(/[^0-9A-Za-z]/g, '')
        .slice(0, 40);

      const verification = await this.whop.createVerification(
        whopAccountId,
        plan.verification,
        `koopfy_connect_kyb_${sellerId}_${documentsVersion}`,
      );

      await this.updateRow(sellerId, {
        verification_id: verification?.id ?? null,
        verification_status: verification?.status ?? null,
        requested_information: verification?.requested_information ?? [],
        rfi_answered: [],
        rfi_unanswered: [],
        status: deriveConnectedStatus({ verificationStatus: verification?.status }),
        last_error: null,
      });

      await this.log(sellerId, managerId, 'whop_connect.provisioned', {
        whop_account_id: whopAccountId,
        verification_id: verification?.id ?? null,
        verification_status: verification?.status ?? null,
      });
    } catch (err: any) {
      const message = this.errorMessage(err);
      await this.updateRow(sellerId, { last_error: message.slice(0, 500) }).catch(() => { /* best-effort */ });
      await this.log(sellerId, managerId, 'whop_connect.provision_failed', { error: message });
      throw new BadRequestException(`Whop recusou a conta conectada: ${message}`);
    }

    return this.sync(sellerId);
  }

  // ─────────────────────────────────────────────
  // Sincronização (webhook e CRM)
  // ─────────────────────────────────────────────

  async sync(sellerId: string) {
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta conectada.');
    if (!row.whop_account_id) return this.getStatus(sellerId);

    let account: any;
    try {
      account = await this.whop.getAccount(row.whop_account_id);
    } catch (err: any) {
      const message = this.errorMessage(err);
      await this.updateRow(sellerId, { last_error: message.slice(0, 500) }).catch(() => { /* best-effort */ });
      throw new BadRequestException(`Não foi possível ler a conta na Whop: ${message}`);
    }

    // Sem a lista de verificações ainda dá para sincronizar status/capacidades.
    const verifications = await this.whop.listVerifications(row.whop_account_id).catch((err: any) => {
      console.error(`[WhopConnect] verificações de ${row.whop_account_id}:`, err?.message);
      return null;
    });
    const list: any[] = Array.isArray(verifications?.data) ? verifications.data : [];
    // A da LLC é a de empresa; a individual só aparece se a Whop pedir à parte.
    const verification = list.find(v => v?.kind === 'business') ?? list.find(v => v?.kind === 'individual') ?? list[0] ?? null;

    const verificationStatus = verification?.status
      ?? account?.verification?.business?.status
      ?? account?.verification?.individual?.status
      ?? row.verification_status;

    const status = deriveConnectedStatus({
      accountStatus: account?.status,
      verificationStatus,
      capabilities: account?.capabilities,
    });

    const requested = verification?.requested_information ?? [];

    await this.updateRow(sellerId, {
      whop_status: account?.status ?? null,
      status_reason: account?.status_reason ?? null,
      capabilities: account?.capabilities ?? {},
      payment_controls: account?.payment_controls ?? {},
      required_actions: account?.required_actions ?? [],
      verification_id: verification?.id ?? row.verification_id,
      verification_status: verificationStatus ?? null,
      requested_information: requested,
      status,
      // Conta de volta: a próxima queda ganha uma janela de 72h nova.
      ...(status === 'active' ? { fallback_started_at: null } : {}),
      last_synced_at: new Date().toISOString(),
      last_error: null,
    });
    this.routingCache.delete(sellerId);

    if (status !== row.status) {
      const down = status !== 'active';
      if (down || row.charges_enabled) {
        console[down ? 'error' : 'log'](
          `[WhopConnect] seller ${sellerId} (${row.whop_account_id}): ${row.status} → ${status}`
          + (account?.status_reason ? ` (${account.status_reason})` : '')
          + (down && row.charges_enabled ? ' — vendas vão para a master (fallback) enquanto investigamos.' : ''),
        );
      }
      await this.log(sellerId, null, 'whop_connect.status_changed', { from: row.status, to: status });
    }

    if (requested.length > 0) {
      await this.answerRequestedInformation(sellerId).catch((err: any) =>
        console.error(`[WhopConnect] pedidos de informação do seller ${sellerId}:`, err?.message));
    }

    return this.getStatus(sellerId);
  }

  // ─────────────────────────────────────────────
  // Pedidos de informação da Whop (RFI)
  // ─────────────────────────────────────────────

  // `retryRequirements`: requisitos para os quais o seller acabou de mandar
  // dado novo. Só eles são reenviados mesmo com resposta anterior recusada.
  async answerRequestedInformation(sellerId: string, opts: { retryRequirements?: string[] } = {}) {
    // Webhook e CRM podem disparar juntos; responder duas vezes subiria os
    // mesmos arquivos em dobro.
    if (this.answering.has(sellerId)) return null;
    this.answering.add(sellerId);

    try {
      const row = await this.getRow(sellerId);
      if (!row?.verification_id) return null;

      const retry = new Set(opts.retryRequirements ?? []);
      const answered = new Set((row.rfi_answered ?? []).map(String));
      const pending = (row.requested_information ?? []).filter((item: any) =>
        item?.id && (!answered.has(String(item.id)) || (item.errors?.length && retry.has(item.requirement))));
      if (pending.length === 0) return { answered: 0, unanswered: row.rfi_unanswered ?? [] };

      const source = await this.loadSellerSource(sellerId);
      const { answers, unanswered } = planRfiAnswers(pending, {
        kyc: source.kyc,
        docs: source.documents,
        email: source.seller.email,
        description: source.description,
        website: source.website,
      }, { retryRequirements: [...retry] });

      if (answers.length > 0) {
        const payload: Record<string, any>[] = [];
        for (const answer of answers) payload.push(await this.toRfiPayload(answer));
        await this.whop.updateVerification(row.verification_id, { requested_information: payload });
      }

      await this.updateRow(sellerId, {
        rfi_answered: [...answered, ...answers.map(a => a.id)],
        rfi_unanswered: unanswered,
        last_error: null,
      });

      if (unanswered.length > 0) {
        console.warn(
          `[WhopConnect] seller ${sellerId}: ${unanswered.length} pedido(s) da Whop sem resposta automática — `
          + unanswered.map(u => u.requirement).join(', '),
        );
      }
      if (answers.length > 0) {
        await this.log(sellerId, null, 'whop_connect.rfi_answered', {
          answered: answers.map(a => a.id),
          unanswered: unanswered.map(u => u.requirement),
        });
      }

      return { answered: answers.length, unanswered };
    } catch (err: any) {
      const message = this.errorMessage(err);
      await this.updateRow(sellerId, { last_error: `pedidos de informação: ${message}`.slice(0, 500) }).catch(() => { /* best-effort */ });
      throw new BadRequestException(`Não foi possível responder os pedidos da Whop: ${message}`);
    } finally {
      this.answering.delete(sellerId);
    }
  }

  private async toRfiPayload(answer: RfiAnswer): Promise<Record<string, any>> {
    if ('value' in answer) return { id: answer.id, value: answer.value };
    if ('address' in answer) return { id: answer.id, address: answer.address };
    if ('documentSlots' in answer) return { id: answer.id, documents: await this.loadDocuments(answer.documentSlots) };

    const files: string[] = [];
    for (const path of answer.filePaths) {
      const file = await this.storage.downloadDocument(path);
      if (!file) throw new BadRequestException(`Não foi possível ler "${path}" no storage.`);
      files.push(await this.whop.uploadFile({
        filename: path.split('/').pop() || 'documento',
        contentType: file.mime,
        data: Buffer.from(file.base64, 'base64'),
      }));
    }
    return { id: answer.id, files };
  }

  // ─────────────────────────────────────────────
  // Pendências para o seller (painel do checkout)
  // ─────────────────────────────────────────────

  /**
   * O que falta para a conta conectada: dados e documentos da LLC que o
   * cadastro ainda não tem e pedidos da Whop sem resposta automática.
   *
   * Vale para toda conta que não é CNPJ — inclusive a aprovada antes do
   * onboarding novo, sem tipo de empresa gravado. Seller com CNPJ liberado no
   * CRM vende pela master e não tem conta conectada a criar.
   *
   * `connected.ready`: cadastro completo para o CRM criar a conta conectada.
   */
  async getSellerRequirements(sellerId: string) {
    const [row, source] = await Promise.all([this.getRow(sellerId), this.loadSellerSource(sellerId)]);
    const companyType = source.documents?.company_type ?? null;
    const connectedStatus = row?.status ?? null;

    if (companyType === 'BR') {
      return {
        companyType,
        connectedStatus,
        connected: { required: false, ready: false, status: connectedStatus },
        items: [] as SellerRequirementItem[],
      };
    }

    const plan = planBusinessVerification(source.kyc, source.documents, { website: source.website });
    return {
      companyType,
      connectedStatus,
      connected: { required: true, ready: plan.missing.length === 0, status: connectedStatus },
      items: sellerRequirementItems(plan.gaps, row?.rfi_unanswered ?? []),
    };
  }

  /** Respostas do seller a pedidos da Whop que não têm campo no cadastro (texto, data, arquivo…). */
  async submitDirectRfiAnswers(
    sellerId: string,
    answers: Array<{ id: string; value?: string; file?: { base64: string; mime: string; name?: string } }>,
  ) {
    if (!answers?.length) return { answered: 0 };

    const row = await this.getRow(sellerId);
    if (!row?.verification_id) throw new BadRequestException('Não há verificação da Whop em andamento para esta conta.');

    const requested = new Map<string, any>(
      (row.requested_information ?? []).map((item: any) => [String(item?.id), item] as [string, any]),
    );
    const payload: Record<string, any>[] = [];

    for (const answer of answers) {
      const item = requested.get(answer.id);
      if (!item) throw new BadRequestException('Pedido de informação não encontrado. Atualize a página e tente de novo.');

      if (answer.file) {
        const data = Buffer.from(answer.file.base64, 'base64');
        if (data.byteLength > WHOP_DOCUMENT_MAX_BYTES) {
          throw new BadRequestException(`O arquivo de "${item.label ?? item.requirement}" tem mais de 5 MB.`);
        }
        const fileId = await this.whop.uploadFile({
          filename: answer.file.name || 'documento',
          contentType: answer.file.mime,
          data,
        });
        payload.push({ id: answer.id, files: [fileId] });
      } else if (answer.value?.trim()) {
        payload.push({ id: answer.id, value: answer.value.trim() });
      }
    }

    if (payload.length === 0) return { answered: 0 };

    try {
      await this.whop.updateVerification(row.verification_id, { requested_information: payload });
    } catch (err: any) {
      throw new BadRequestException(`A Whop recusou a resposta: ${this.errorMessage(err)}`);
    }

    const answeredIds = payload.map(p => String(p.id));
    await this.updateRow(sellerId, {
      rfi_answered: [...new Set([...(row.rfi_answered ?? []), ...answeredIds])],
      rfi_unanswered: (row.rfi_unanswered ?? []).filter(u => !answeredIds.includes(u.id)),
    });
    await this.log(sellerId, null, 'whop_connect.rfi_answered_by_seller', { answered: answeredIds });

    return { answered: answeredIds.length };
  }

  // ─────────────────────────────────────────────
  // Modo conectado, fallback e risco (CRM)
  // ─────────────────────────────────────────────

  async setChargesEnabled(sellerId: string, managerId: string, dto: { enabled: boolean; reason?: string }) {
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta conectada.');

    if (dto.enabled) {
      const blocker = connectedChargeBlocker(row);
      if (blocker) throw new BadRequestException(blocker);

      // No modo conectado a reserva é por risco: zero até o chargeback passar
      // de 1%. Guarda a reserva anterior para devolver se o modo for desligado.
      const currentReserve = await this.getSellerReserve(sellerId);
      await this.updateRow(sellerId, {
        charges_enabled: true,
        base_reserve_percentage: row.base_reserve_percentage ?? currentReserve,
      });
      await this.setSellerReserve(sellerId, row.risk_tier === 'RESERVE' ? RISK_RESERVE_PERCENTAGE : 0);
    } else {
      if (!dto.reason?.trim()) {
        throw new BadRequestException(
          'Informe o motivo: desligar o modo conectado devolve as vendas deste seller para a conta master da Koopfy.',
        );
      }
      await this.updateRow(sellerId, { charges_enabled: false, fallback_started_at: null });
      if (row.base_reserve_percentage != null) await this.setSellerReserve(sellerId, Number(row.base_reserve_percentage));
    }

    this.routingCache.delete(sellerId);
    await this.log(sellerId, managerId, dto.enabled ? 'whop_connect.charges_enabled' : 'whop_connect.charges_disabled', {
      reason: dto.reason ?? null,
    });
    return this.getStatus(sellerId);
  }

  // Corta (ou devolve) o fallback na master para ESTE seller. Religar abre
  // uma janela de 72h nova — é uma decisão explícita de quem investigou.
  async setFallbackEnabled(sellerId: string, managerId: string, dto: { enabled: boolean; reason?: string }) {
    if (!dto.reason?.trim()) throw new BadRequestException('Motivo é obrigatório.');
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta conectada.');

    await this.updateRow(sellerId, {
      fallback_disabled: !dto.enabled,
      ...(dto.enabled ? { fallback_started_at: null } : {}),
    });
    this.routingCache.delete(sellerId);
    await this.log(sellerId, managerId, dto.enabled ? 'whop_connect.fallback_enabled' : 'whop_connect.fallback_disabled', {
      reason: dto.reason.trim(),
    });
    return this.getStatus(sellerId);
  }

  async resetRisk(sellerId: string, managerId: string, notes: string) {
    if (!notes?.trim()) throw new BadRequestException('Explique a revisão antes de zerar o risco.');
    const row = await this.getRow(sellerId);
    if (!row) throw new NotFoundException('Seller sem conta conectada.');

    await this.updateRow(sellerId, { risk_tier: 'OK', risk_reason: `revisão manual: ${notes.trim()}`.slice(0, 500) });
    if (row.charges_enabled && row.risk_tier === 'RESERVE') await this.setSellerReserve(sellerId, 0);
    this.routingCache.delete(sellerId);
    await this.log(sellerId, managerId, 'whop_connect.risk_reset', { from: row.risk_tier, notes: notes.trim() });
    return this.getStatus(sellerId);
  }

  // ─────────────────────────────────────────────
  // Roteamento (caminho quente do pagamento)
  // ─────────────────────────────────────────────

  async getChargeRouting(sellerId: string): Promise<ConnectedRouting> {
    const cached = this.routingCache.get(sellerId);
    if (cached && Date.now() - cached.at < ROUTING_CACHE_TTL_MS) return cached.routing;

    const { data, error } = await supabase.from(TABLE).select('*').eq('seller_id', sellerId).maybeSingle();

    if (error) {
      // Migration não aplicada: ninguém pode estar em modo conectado ainda.
      if (/relation .* does not exist|schema cache/i.test(error.message)) return { mode: 'master' };

      // Não dá para saber se o seller tem reserva acionada ou fallback
      // cortado — cair na master sem saber arriscaria o contágio.
      console.error(`[WhopConnect] modo do seller ${sellerId} indisponível:`, error.message);
      return { mode: 'blocked', reason: 'estado da conta conectada indisponível' };
    }

    const row = data as WhopConnectedAccountRow | null;
    const decision = decideConnectedMode(row);
    let routing: ConnectedRouting;

    if (decision.mode === 'connected' && row) {
      routing = { mode: 'connected', account: this.toProviderAccount(row, true) };
    } else if (decision.mode === 'fallback' && row) {
      if (decision.startsNow) {
        // A janela conta da PRIMEIRA venda desviada, não de cada uma.
        await this.updateRow(sellerId, { fallback_started_at: new Date().toISOString() });
        console.error(
          `[WhopConnect] 🚨 seller ${sellerId}: ${decision.reason} — vendas na MASTER por até 72h. Investigue a conta.`,
        );
        await this.log(sellerId, null, 'whop_connect.fallback_started', { reason: decision.reason });
      }
      routing = { mode: 'master', fallbackReason: decision.reason };
    } else if (decision.mode === 'blocked') {
      routing = { mode: 'blocked', reason: decision.reason };
    } else {
      routing = { mode: 'master' };
    }

    this.routingCache.set(sellerId, { at: Date.now(), routing });
    return routing;
  }

  // Sem filtro de status (mesmo motivo do WhopAccountsService.getById): o
  // webhook e o reembolso de uma conta fora do ar continuam chegando, e é
  // dinheiro que já entrou. Quem barra cobrança nova é o status 'inactive'.
  async getProviderAccountById(providerAccountId: string): Promise<ProviderAccountConfig | null> {
    const whopAccountId = whopAccountIdFromProviderAccountId(providerAccountId);
    if (!whopAccountId) return null;

    const row = await this.getRowByWhopAccount(whopAccountId).catch((err: any) => {
      console.error('[WhopConnect] getProviderAccountById:', err?.message);
      return null;
    });
    if (!row) return null;

    return this.toProviderAccount(row, decideConnectedMode(row).mode === 'connected');
  }

  private toProviderAccount(row: WhopConnectedAccountRow, chargeable: boolean): ProviderAccountConfig {
    const { apiKey, apiUrl } = this.whop.credentials();
    return {
      id: toConnectedProviderAccountId(String(row.whop_account_id)),
      provider: 'whop',
      status: chargeable ? 'active' : 'inactive',
      weight: 1,
      supported_methods: ['all'],
      api_url: apiUrl,
      apiKey,
      config: {
        company_id: row.whop_account_id,
        // WhopProvider cobra a application fee quando isto é true.
        connected: true,
        seller_id: row.seller_id,
        // Um webhook da master com child_resource_events recebe os eventos de
        // TODAS as contas conectadas — um segredo só.
        webhook_secret: connectedWebhookSecret() || undefined,
      },
    };
  }

  // ─────────────────────────────────────────────
  // Risco por seller (webhook)
  // ─────────────────────────────────────────────

  async recordRiskSignal(args: {
    eventId: string;
    sellerId: string;
    whopAccountId: string;
    kind: 'dispute' | 'dispute_alert' | 'refund';
    transactionId?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    reason?: string | null;
    payload?: Record<string, any>;
  }) {
    const { error } = await supabase.from(RISK_EVENTS_TABLE).insert({
      id: args.eventId,
      seller_id: args.sellerId,
      whop_account_id: args.whopAccountId,
      kind: args.kind,
      transaction_id: args.transactionId ?? null,
      amount_cents: args.amountCents ?? null,
      currency: args.currency ?? null,
      reason: args.reason ?? null,
      payload: args.payload ?? {},
    });

    if (error) {
      if ((error as any).code === '23505') return; // reentrega, já contado
      console.error('[WhopConnect] recordRiskSignal:', error.message);
      return;
    }

    // Disputa e alerta reavaliam na hora: a próxima venda já sai com a
    // reserva se o seller acabou de cruzar 1%.
    if (args.kind !== 'refund') await this.evaluateRisk(args.sellerId);
  }

  async evaluateRisk(sellerId: string) {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) return null;

    const { data, error } = await supabase.rpc('whop_connected_risk_window', {
      p_seller_id: sellerId,
      p_days: RISK_WINDOW_DAYS,
    });
    if (error) {
      console.error('[WhopConnect] whop_connected_risk_window:', error.message);
      return null;
    }

    const window = Array.isArray(data) ? data[0] : data;
    const risk = classifyConnectedRisk({
      paidCount: Number(window?.paid_count ?? 0),
      disputeCount: Number(window?.dispute_count ?? 0),
      alertCount: Number(window?.alert_count ?? 0),
      refundCount: Number(window?.refund_count ?? 0),
    });

    const tier: ConnectedRiskTier = escalateRiskTier(row.risk_tier, risk.tier);
    await this.updateRow(sellerId, {
      risk_evaluated_at: new Date().toISOString(),
      ...(tier !== row.risk_tier ? { risk_tier: tier, risk_reason: risk.reason } : {}),
    });
    this.routingCache.delete(sellerId);

    if (tier !== row.risk_tier) {
      if (tier === 'RESERVE' && row.charges_enabled) {
        await this.setSellerReserve(sellerId, RISK_RESERVE_PERCENTAGE);
      }
      console.error(
        `[WhopConnect] 🚨 seller ${sellerId}: risco ${row.risk_tier} → ${tier} (${risk.reason})`
        + (tier === 'RESERVE' ? ` — reserva de ${RISK_RESERVE_PERCENTAGE}% nas próximas vendas.` : ''),
      );
      await this.log(sellerId, null, 'whop_connect.risk_escalated', { from: row.risk_tier, to: tier, reason: risk.reason });
    }

    return { ...risk, tier };
  }

  // ─────────────────────────────────────────────
  // Cobertura de saldo negativo (master → conta do seller)
  // ─────────────────────────────────────────────
  //
  // A conta conectada fica zerada (a fee leva tudo). Reembolso e chargeback
  // debitam lá e ela fica negativa; pelos termos da Whop esse negativo é
  // cobrado do SELLER, com juros e, depois de 72h, da conta bancária dele.
  // A Koopfy já descontou esse prejuízo da carteira interna do seller, então
  // quem cobre na Whop é a master.
  //
  // Olha o saldo real em vez de calcular pelo evento: se a Whop devolver a
  // fee ao reembolsar (não documentado), o negativo nem existe e nada sai.

  async coverNegativeBalance(sellerId: string, eventRef: string) {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) return { sellerId, covered: [] as any[] };

    const account = await this.whop.getAccount(row.whop_account_id);
    const negatives = negativeFiatBalances(account?.balances);
    if (negatives.length === 0) return { sellerId, covered: [] as any[] };

    const masterId = await this.masterAccountId();
    const covered: Array<{ currency: string; amount: number; outcome: string }> = [];

    for (const { currency, amount } of negatives) {
      // Uma cobertura em andamento por moeda: se a anterior ainda não abateu
      // o negativo, mandar outra cobriria duas vezes.
      if (await this.hasOpenCover(row, masterId, currency)) continue;

      const idempotencyKey = `koopfy_cover_${sellerId}_${currency}_${eventRef}`.slice(0, 255);
      const { data: inserted, error } = await supabase
        .from(TRANSFERS_TABLE)
        .insert({
          seller_id: sellerId,
          whop_account_id: row.whop_account_id,
          kind: 'negative_cover',
          currency,
          amount,
          status: 'processing',
          idempotency_key: idempotencyKey,
          reason: eventRef,
        })
        .select('*')
        .single();

      if (error) {
        if ((error as any).code === '23505') continue; // mesmo evento, já coberto
        throw new Error(`[WhopConnect] registro da cobertura: ${error.message}`);
      }

      const outcome = await this.sendCover(row, masterId, inserted);
      covered.push({ currency, amount, outcome });
    }

    if (covered.length > 0) {
      console.warn(`[WhopConnect] saldo negativo do seller ${sellerId} coberto pela master:`, JSON.stringify(covered));
      await this.log(sellerId, null, 'whop_connect.negative_covered', { event: eventRef, covered });
    }
    return { sellerId, covered };
  }

  private async hasOpenCover(row: WhopConnectedAccountRow, masterId: string, currency: string): Promise<boolean> {
    const { data } = await supabase
      .from(TRANSFERS_TABLE)
      .select('*')
      .eq('seller_id', row.seller_id)
      .eq('currency', currency)
      .eq('status', 'processing');

    let open = false;
    for (const entry of data ?? []) {
      if ((await this.sendCover(row, masterId, entry)) === 'processing') open = true;
    }
    return open;
  }

  private async sendCover(
    row: WhopConnectedAccountRow,
    masterId: string,
    entry: { id: string; idempotency_key: string; currency: string; amount: number | string; whop_transfer_id?: string | null },
  ): Promise<'succeeded' | 'failed' | 'processing'> {
    let transfer: any;
    try {
      transfer = entry.whop_transfer_id
        ? await this.whop.getTransfer(entry.whop_transfer_id)
        : await this.whop.createTransfer({
          origin_id: masterId,
          destination_id: row.whop_account_id,
          amount: Number(entry.amount),
          currency: entry.currency,
          notes: 'Cobertura de saldo negativo (Koopfy)',
          metadata: { koopfy_seller_id: row.seller_id, koopfy_cover_id: entry.id },
        }, entry.idempotency_key);
    } catch (err: any) {
      if (!entry.whop_transfer_id && err instanceof WhopApiError && isDefinitiveWhopFailure(err.status)) {
        await this.updateTransfer(entry.id, { status: 'failed', failure_reason: this.errorMessage(err).slice(0, 500) });
        console.error(
          `[WhopConnect] 🚨 cobertura de ${entry.amount} ${entry.currency} do seller ${row.seller_id} RECUSADA: `
          + `${this.errorMessage(err)} — o negativo segue na conta dele.`,
        );
        return 'failed';
      }
      return 'processing';
    }

    const outcome = classifyWhopTransfer(transfer);
    await this.updateTransfer(entry.id, {
      status: outcome,
      whop_transfer_id: transfer?.id ?? entry.whop_transfer_id ?? null,
      failure_reason: outcome === 'failed' ? String(transfer?.failure_reason ?? 'transferência recusada pela Whop') : null,
    });
    return outcome;
  }

  private async updateTransfer(id: string, patch: Record<string, any>) {
    const { error } = await supabase
      .from(TRANSFERS_TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) console.error(`[WhopConnect] cobertura ${id}:`, error.message);
  }

  // ─────────────────────────────────────────────
  // Liberação: saldo disponível → conta conectada
  // ─────────────────────────────────────────────
  //
  // O dinheiro da venda está na master. Quando o saldo do seller fica
  // disponível na carteira da Koopfy (prazo normal ou fim da reserva), ele é
  // transferido para a conta conectada. Com a conta fora do ar, espera.
  //
  // Ordem: ledger 'processing' → débito atômico do saldo → transferência.
  // Débito antes da Whop impede duas instâncias de transferirem o mesmo
  // saldo; o ledger antes do débito garante rastro se algo cair no meio.

  async runCycle(opts: { cover: boolean; release: boolean }) {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select('seller_id, status, charges_enabled')
        .not('whop_account_id', 'is', null);
      if (error) {
        console.error('[WhopConnect] ciclo:', error.message);
        return;
      }

      // Uma chave por hora: o mesmo negativo não é coberto duas vezes no
      // mesmo ciclo, e um negativo novo na hora seguinte ganha cobertura nova.
      const sweepRef = `sweep_${new Date().toISOString().slice(0, 13).replace(/\D/g, '')}`;

      for (const row of data ?? []) {
        if (opts.cover) {
          await this.coverNegativeBalance(row.seller_id, sweepRef).catch((err: any) =>
            console.error(`[WhopConnect] cobertura do seller ${row.seller_id}:`, err?.message));
        }
        if (opts.release && row.charges_enabled && row.status === 'active') {
          await this.releaseToSeller(row.seller_id).catch((err: any) =>
            console.error(`[WhopConnect] liberação do seller ${row.seller_id}:`, err?.message));
        }
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  async releaseToSeller(sellerId: string, managerId: string | null = null) {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) throw new BadRequestException('Seller sem conta conectada na Whop.');
    if (!row.charges_enabled || row.status !== 'active') {
      return { sellerId, releasedCents: 0, skipped: `conta conectada ${row.charges_enabled ? row.status : 'fora do modo conectado'}` };
    }

    const masterId = await this.masterAccountId();

    // 1. Retoma liberações que ficaram em aberto (timeout, Whop processando).
    const { data: open } = await supabase
      .from('wallet_ledger')
      .select('transaction_id, amount, metadata')
      .eq('seller_id', sellerId)
      .eq('type', RELEASE_LEDGER_TYPE)
      .eq('status', 'processing');
    for (const entry of open ?? []) {
      await this.settleRelease(row, masterId, entry);
    }

    // 2. Saldo disponível novo.
    const { data: balance, error: balanceError } = await supabase
      .from('wallet_balance')
      .select('available_balance')
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (balanceError) throw new Error(`[WhopConnect] saldo do seller ${sellerId}: ${balanceError.message}`);

    const available = Math.floor(Number(balance?.available_balance ?? 0));
    if (available < RELEASE_MIN_CENTS) return { sellerId, releasedCents: 0, resumed: open?.length ?? 0 };

    // 3. A carteira é em USD; o saldo da master é separado por moeda. Sem USD
    // suficiente a transferência falharia — melhor não debitar nada e avisar.
    const master = await this.masterBalance('usd');
    if (master.available * 100 < available) {
      const reason = `saldo em USD da master insuficiente (US$ ${master.available.toFixed(2)} para US$ ${(available / 100).toFixed(2)})`
        + (master.others.length ? `; outras moedas: ${master.others.join(', ')}` : '');
      console.error(`[WhopConnect] liberação do seller ${sellerId} adiada: ${reason}`);
      return { sellerId, releasedCents: 0, skipped: reason };
    }

    const releaseId = randomUUID();
    const metadata = { whop_account_id: row.whop_account_id, release_id: releaseId, requested_by: managerId };

    const { error: ledgerError } = await supabase.from('wallet_ledger').insert({
      seller_id: sellerId,
      transaction_id: releaseId,
      type: RELEASE_LEDGER_TYPE,
      amount: available,
      currency: 'USD',
      status: 'processing',
      created_at: new Date().toISOString(),
      metadata,
    });
    if (ledgerError) throw new Error(`[WhopConnect] ledger da liberação: ${ledgerError.message}`);

    const { error: debitError } = await supabase.rpc('debit_balance', {
      p_seller_id: sellerId,
      p_bucket: 'available',
      p_amount_cents: available,
    });
    if (debitError) {
      // Outra liberação (ou um saque) levou o saldo antes: nada saiu.
      await this.markRelease(releaseId, 'failed', { ...metadata, failure_reason: debitError.message });
      return { sellerId, releasedCents: 0, skipped: `saldo mudou: ${debitError.message}` };
    }

    const outcome = await this.settleRelease(row, masterId, { transaction_id: releaseId, amount: available, metadata });
    if (managerId) await this.log(sellerId, managerId, 'whop_connect.release_requested', { amount_cents: available, outcome });
    return { sellerId, releasedCents: outcome === 'failed' ? 0 : available, outcome };
  }

  private async settleRelease(
    row: WhopConnectedAccountRow,
    masterId: string,
    entry: { transaction_id: string; amount: number; metadata?: Record<string, any> | null },
  ): Promise<'succeeded' | 'failed' | 'processing'> {
    const releaseId = entry.transaction_id;
    const amount = Number(entry.amount);
    const metadata = entry.metadata ?? {};
    const key = `koopfy_release_${releaseId}`;

    let transfer: any;
    try {
      transfer = metadata.whop_transfer_id
        ? await this.whop.getTransfer(metadata.whop_transfer_id)
        : await this.whop.createTransfer({
          origin_id: masterId,
          destination_id: row.whop_account_id,
          amount: amount / 100,
          currency: 'usd',
          notes: 'Liberação de saldo Koopfy',
          metadata: { koopfy_seller_id: row.seller_id, koopfy_release_id: releaseId },
        }, key);
    } catch (err: any) {
      // Só criação recusada de forma definitiva devolve o saldo. Falha ao
      // CONSULTAR uma transferência que já existe nunca devolve.
      if (!metadata.whop_transfer_id && err instanceof WhopApiError && isDefinitiveWhopFailure(err.status)) {
        await this.refundRelease(row.seller_id, releaseId, amount, metadata, this.errorMessage(err));
        return 'failed';
      }
      console.error(`[WhopConnect] liberação ${releaseId} em aberto (tenta de novo no próximo ciclo):`, this.errorMessage(err));
      return 'processing';
    }

    const outcome = classifyWhopTransfer(transfer);
    if (outcome === 'failed') {
      await this.refundRelease(row.seller_id, releaseId, amount, metadata, transfer?.failure_reason ?? 'transferência recusada pela Whop');
      return 'failed';
    }

    await this.markRelease(
      releaseId,
      outcome === 'succeeded' ? 'completed' : 'processing',
      { ...metadata, whop_transfer_id: transfer?.id ?? metadata.whop_transfer_id ?? null, whop_transfer_status: transfer?.status ?? null },
      transfer?.id ?? null,
    );
    return outcome;
  }

  private async refundRelease(sellerId: string, releaseId: string, amount: number, metadata: Record<string, any>, reason: string) {
    const { error } = await supabase.rpc('credit_balance', {
      p_seller_id: sellerId,
      p_bucket: 'available',
      p_amount_cents: amount,
    });
    await this.markRelease(releaseId, 'failed', {
      ...metadata,
      failure_reason: reason,
      ...(error ? { reconciliation: true, credit_error: error.message } : {}),
    });
    console.error(
      `[WhopConnect] liberação ${releaseId} do seller ${sellerId} recusada (${reason}) — `
      + (error ? `saldo NÃO devolvido (${error.message}), reconciliar à mão.` : 'saldo devolvido ao disponível.'),
    );
  }

  private async markRelease(releaseId: string, status: string, metadata: Record<string, any>, providerId?: string | null) {
    const { error } = await supabase
      .from('wallet_ledger')
      .update({ status, metadata, ...(providerId ? { provider_payout_id: providerId } : {}) })
      .eq('transaction_id', releaseId)
      .eq('type', RELEASE_LEDGER_TYPE);
    if (error) console.error(`[WhopConnect] ledger da liberação ${releaseId} (${status}):`, error.message);
  }

  private async masterBalance(currency: string): Promise<{ available: number; others: string[] }> {
    const account = await this.whop.getAccount(await this.masterAccountId());
    const balances: any[] = Array.isArray(account?.balances) ? account.balances : [];
    const match = balances.find(b => String(b?.symbol ?? '').toLowerCase() === currency);
    const available = Number(match?.breakdown?.available ?? match?.balance ?? 0);
    const others = balances
      .filter(b => String(b?.symbol ?? '').toLowerCase() !== currency && Number(b?.balance) > 0)
      .map(b => `${b.symbol} ${b.balance}`);
    return { available: Number.isFinite(available) ? available : 0, others };
  }

  private masterAccountId(): Promise<string> {
    const fromEnv = process.env.WHOP_COMPANY_ID?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);

    if (!this.masterAccount) {
      this.masterAccount = this.whop.getAccount('me')
        .then((account: any) => {
          const id = String(account?.id ?? '');
          if (!id.startsWith('biz_')) throw new Error('Whop não devolveu o id da conta master');
          return id;
        })
        .catch((err: any) => {
          // Falha não fica cacheada: o próximo ciclo tenta de novo.
          this.masterAccount = null;
          throw err;
        });
    }
    return this.masterAccount;
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async getSellerReserve(sellerId: string): Promise<number | null> {
    const { data } = await supabase.from('seller_fees').select('reserve_percentage').eq('seller_id', sellerId).maybeSingle();
    return data?.reserve_percentage == null ? null : Number(data.reserve_percentage);
  }

  // A reserva vive em seller_fees: o cálculo de taxa de toda venda (master ou
  // conectada, inclusive no fallback) já lê de lá.
  private async setSellerReserve(sellerId: string, percentage: number) {
    const { error } = await supabase
      .from('seller_fees')
      .update({ reserve_percentage: percentage, updated_at: new Date().toISOString() })
      .eq('seller_id', sellerId);
    if (error) throw new Error(`[WhopConnect] reserva do seller ${sellerId}: ${error.message}`);
    await this.log(sellerId, null, 'whop_connect.reserve_set', { reserve_percentage: percentage });
  }

  private async loadSellerSource(sellerId: string) {
    const { data: seller, error } = await supabase
      .from('seller_profiles')
      .select('id, user_id, name, email, status')
      .eq('id', sellerId)
      .maybeSingle();
    if (error) throw new BadRequestException(`Erro ao ler o seller: ${error.message}`);
    if (!seller) throw new NotFoundException('Seller não encontrado.');

    const [kyc, documents, operation, offer] = await Promise.all([
      seller.user_id
        ? supabase.from('kyc_info').select('*').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      seller.user_id
        ? supabase.from('seller_documents').select('*').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      seller.user_id
        ? supabase.from('operation_config').select('description').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('offers').select('sales_page_url').eq('seller_id', sellerId).limit(1).maybeSingle(),
    ]);

    const website = String((offer as any)?.data?.sales_page_url ?? '').trim();
    return {
      seller,
      kyc: (kyc as any)?.data ?? null,
      documents: (documents as any)?.data ?? null,
      description: (operation as any)?.data?.description ?? null,
      website: /^https?:\/\//i.test(website) ? website.slice(0, 255) : null,
    };
  }

  private async loadDocuments(slots: Array<{ slot: string; path: string }>): Promise<Record<string, string>> {
    const documents: Record<string, string> = {};
    for (const { slot, path } of slots) {
      const file = await this.storage.downloadDocument(path);
      if (!file) throw new BadRequestException(`Não foi possível ler "${slot}" no storage.`);
      if (file.byteLength > WHOP_DOCUMENT_MAX_BYTES) {
        throw new BadRequestException(`"${slot}" tem mais de 5 MB — a Whop recusa. Peça um arquivo menor ao seller.`);
      }
      documents[slot] = file.base64;
    }
    return documents;
  }

  private async updateRow(sellerId: string, patch: Record<string, any>) {
    const { error } = await supabase
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('seller_id', sellerId);
    if (error) throw new Error(`[WhopConnect] atualização do seller ${sellerId}: ${error.message}`);
  }

  private errorMessage(err: any): string {
    return err instanceof WhopApiError ? `${err.message} (HTTP ${err.status})` : String(err?.message ?? err);
  }

  private async log(sellerId: string, managerId: string | null, action: string, payload: Record<string, any>) {
    const { error } = await supabase.from('crm_action_log').insert({
      seller_id: sellerId,
      manager_id: managerId,
      action,
      resource_type: 'seller',
      resource_id: sellerId,
      payload,
      created_at: new Date(),
    });
    if (error) console.error(`[WhopConnect] crm_action_log (${action}):`, error.message);
  }
}
