import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
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
  mergeRequestedInformation,
  negativeFiatBalances,
  planBusinessVerification,
  planIndividualVerification,
  identityDocumentsPlan,
  companyFrom,
  accountSettingsPatch,
  connectedAccountSettings,
  connectedStatementDescriptor,
  KOOPFY_PRODUCT_EXTERNAL_ID,
  KOOPFY_PRODUCT_TITLE,
  isOwnerEmailRejection,
  isAddressRejection,
  isTransientProviderFailure,
  connectedAccountIdempotencyKey,
  existingSellerAccount,
  verificationEmailDecision,
  newAccountSettings,
  planRfiAnswers,
  sellerRequirementItems,
  toConnectedProviderAccountId,
  whopAccountIdFromProviderAccountId,
} from './whop-connected';
import { availableCents } from './whop-connected-payout';
import { notifySellerVerification } from '../../utils/seller-mail';

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

// Ações do log que marcam uma correção já feita numa verificação (o
// `verification_id` vai no payload): o sync não repete envio de arquivo.
const IDENTITY_DOCUMENTS_SENT = 'whop_connect.individual_documents_sent';
const BUSINESS_TIN_SENT = 'whop_connect.business_tin_sent';
// E-mails ao seller sobre a verificação (ver notifyVerification).
const VERIFICATION_EMAIL_SENT = 'whop_connect.email_verification_needed';
const VERIFIED_EMAIL_SENT = 'whop_connect.email_verified';

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
    // Saque por aprovação ligado: a liberação avulsa não roda.
    const autoRelease = process.env.WHOP_CONNECTED_AUTO_RELEASE === 'true'
      && process.env.WHOP_CONNECTED_PAYOUTS !== 'true';
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
    const plan = planBusinessVerification(source.kyc, source.documents);
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

    const plan = planBusinessVerification(source.kyc, source.documents);
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
        // A Whop pode ter criado a conta numa tentativa que respondeu erro:
        // adota a que já existe em vez de criar outra.
        const existing = await this.findSellerAccount(sellerId);
        if (existing) {
          whopAccountId = String(existing.id);
          await this.updateRow(sellerId, { whop_account_id: whopAccountId });
          await this.log(sellerId, managerId, 'whop_connect.account_adopted', { whop_account_id: whopAccountId });
        }
      }

      if (!whopAccountId) {
        // Dono = o próprio seller. Cada conta com dono próprio mantém o risco
        // isolado (dono em comum é sinal clássico para a Whop ligar contas: o
        // bloqueio de uma derrubaria as outras) e segue a orientação da Whop
        // ("the email should belong to the connected account"). Os avisos da
        // Whop ao seller são desligados à mão, na conta dele (2026-09-18).
        const ownerEmail = String(source.seller.email ?? '').trim().toLowerCase();
        // Cada tentativa depois de uma falha registrada ganha chave nova: se a
        // Whop guardou a resposta de erro sob a chave anterior, repetir com ela
        // devolveria o mesmo 400 sem tentar de novo — e falha passageira dela
        // (ex.: "Privy API error (0)") viraria permanente. Cliques simultâneos
        // veem o mesmo número e continuam idempotentes.
        const attempt = await this.failedProvisionAttempts(sellerId);
        const account = await this.whop.createAccount(
          {
            email: ownerEmail,
            // Título = nome que a Whop usa no extrato do comprador: a marca da
            // loja reconhecida por ele, não a razão social da LLC.
            title: String(source.seller.name || plan.account.business_name).slice(0, 80),
            country: 'US',
            // Nenhum e-mail transacional da Whop para o comprador: quem fala
            // com ele é a Koopfy.
            send_customer_emails: false,
            metadata: { external_id: sellerId, koopfy_seller_id: sellerId },
          },
          // E-mail e tentativa na chave: corrigir o e-mail ou tentar de novo
          // depois de uma falha nunca reaproveita uma resposta de erro guardada.
          connectedAccountIdempotencyKey(sellerId, createHash('sha256').update(ownerEmail).digest('hex').slice(0, 10), attempt),
        );
        whopAccountId = String(account?.id ?? '');
        if (!whopAccountId.startsWith('biz_')) {
          throw new WhopApiError('Whop não devolveu o id da conta criada', 502, null, null);
        }
        await this.updateRow(sellerId, { whop_account_id: whopAccountId });
      }

      // Imposto da LLC, incluso no preço, sem e-mail ao comprador — ver
      // connectedAccountSettings.
      await this.whop.updateAccount(whopAccountId, { ...plan.account, ...newAccountSettings() });

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
      // O EIN já vai no campo certo: o sync não precisa corrigi-lo depois.
      if (verification?.id) {
        await this.log(sellerId, managerId, BUSINESS_TIN_SENT, { verification_id: verification.id });
      }

      // A conta só opera com as DUAS verificações: empresa e pessoa responsável.
      // Os dados da pessoa são os mesmos exigidos na verificação da empresa, que
      // já passou pelo plano acima — se faltar algo, a de empresa segue e o que
      // falta vira pendência no painel do seller.
      const individualPlan = planIndividualVerification(source.kyc);
      let individual: any = null;
      if (individualPlan.verification) {
        // Documento e selfie no próprio pedido: sem eles a Whop abre uma sessão
        // e espera a pessoa concluir num link que ninguém abre (ver
        // identityDocumentsPlan). Sem documento no cadastro, segue sem — e o
        // sync envia assim que ele chegar.
        const identityDocs = await this.identityDocumentsPayload(source.documents);
        if (identityDocs.warning) console.warn(`[WhopConnect] seller ${sellerId}: ${identityDocs.warning}`);
        individual = await this.whop.createVerification(
          whopAccountId,
          { ...individualPlan.verification, ...(identityDocs.payload ?? {}) },
          `koopfy_connect_kyc_${sellerId}_${documentsVersion}`,
        );
        if (identityDocs.payload && individual?.id) {
          await this.log(sellerId, managerId, IDENTITY_DOCUMENTS_SENT, { verification_id: individual.id });
        }
      } else {
        console.warn(
          `[WhopConnect] seller ${sellerId}: verificação da pessoa não criada — falta ${individualPlan.missing.join(', ')}`,
        );
      }

      await this.updateRow(sellerId, {
        verification_id: verification?.id ?? null,
        verification_status: verification?.status ?? null,
        individual_verification_id: individual?.id ?? null,
        individual_verification_status: individual?.status ?? null,
        requested_information: mergeRequestedInformation([verification, individual]),
        rfi_answered: [],
        rfi_unanswered: [],
        status: deriveConnectedStatus({
          verificationStatus: verification?.status,
          individualStatus: individual?.status ?? null,
        }),
        last_error: null,
      });

      await this.log(sellerId, managerId, 'whop_connect.provisioned', {
        whop_account_id: whopAccountId,
        verification_id: verification?.id ?? null,
        verification_status: verification?.status ?? null,
        individual_verification_id: individual?.id ?? null,
        individual_verification_status: individual?.status ?? null,
      });
    } catch (err: any) {
      const message = this.errorMessage(err);
      await this.updateRow(sellerId, { last_error: message.slice(0, 500) }).catch(() => { /* best-effort */ });
      await this.log(sellerId, managerId, 'whop_connect.provision_failed', { error: message });
      // Recusa do e-mail: o problema é o endereço do seller, não o resto do
      // cadastro — dizer isso poupa o time de procurar no lugar errado.
      if (isOwnerEmailRejection(message)) {
        throw new BadRequestException(
          `A Whop recusou o e-mail do seller (${source.seller.email ?? 'sem e-mail'}). `
          + 'Confira se ele é real e recebe mensagens. '
          + `Resposta da Whop: ${message}`,
        );
      }
      // Falha da Whop com os fornecedores dela (a Privy cria o usuário dono):
      // não é problema do cadastro, e tentar de novo em instantes resolve.
      if (isTransientProviderFailure(message)) {
        throw new BadRequestException(
          'A Whop teve uma falha passageira ao criar o usuário da conta. Nada foi criado; '
          + `tente novamente em alguns minutos. Resposta da Whop: ${message}`,
        );
      }
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

    // O que este sync fez e o que não conseguiu fazer. Antes, cada etapa
    // engolia o próprio erro e o fim gravava `last_error: null`: o CRM mostrava
    // "tudo certo" e a Whop ficava igual, sem pista do motivo.
    const report: { done: string[]; warnings: string[] } = { done: [], warnings: [] };

    // Conta criada antes destas regras (ou alterada no painel da Whop): o sync
    // devolve a configuração certa. Só manda o que difere, para não fazer
    // PATCH a cada webhook; falhar aqui não derruba o sync.
    const settingsPatch = accountSettingsPatch(account, connectedAccountSettings());
    if (settingsPatch) {
      try {
        await this.whop.updateAccount(row.whop_account_id, settingsPatch);
        await this.log(sellerId, null, 'whop_connect.settings_applied', settingsPatch);
        report.done.push(`configuração aplicada (${Object.keys(settingsPatch).join(', ')})`);
        await this.settleTaxStates(sellerId, row.whop_account_id, settingsPatch, report);
      } catch (err: any) {
        // A Whop valida o endereço GUARDADO nela em qualquer alteração da conta.
        // Endereço errado na criação (ex.: estado de abertura no lugar do estado
        // do endereço) travava tudo; corrigido o cadastro, vai junto e destrava.
        const retried = isAddressRejection(this.errorMessage(err))
          ? await this.retryWithRegisteredAddress(sellerId, row.whop_account_id, settingsPatch)
          : null;
        if (retried?.ok) {
          report.done.push(`configuração aplicada com o endereço do cadastro (${Object.keys(settingsPatch).join(', ')}, business_address)`);
          await this.settleTaxStates(sellerId, row.whop_account_id, settingsPatch, report);
        } else {
          report.warnings.push(
            `a Whop recusou a configuração de imposto/e-mails: ${retried?.error ?? this.errorMessage(err)}`,
          );
        }
      }
    }

    // Descritor da fatura: vive no produto da cobrança, não na conta.
    const product = await this.ensureCheckoutProduct(row.whop_account_id);
    if (product.done) report.done.push(product.done);
    if (product.warning) report.warnings.push(product.warning);

    // Sem a lista de verificações ainda dá para sincronizar status/capacidades.
    const verifications = await this.whop.listVerifications(row.whop_account_id).catch((err: any) => {
      report.warnings.push(`não foi possível ler as verificações na Whop: ${this.errorMessage(err)}`);
      return null;
    });
    const list: any[] = Array.isArray(verifications?.data) ? verifications.data : [];
    const verification = list.find(v => v?.kind === 'business') ?? null;
    // A conta só opera com as DUAS verificações. Quando a da pessoa não existe
    // — conta criada antes desta função, ou dado do responsável que faltava na
    // hora do provisionamento — o sync cria agora. Sem isto a conta ficava para
    // sempre em "continue verificando" na Whop, e nada aqui a destravava.
    let individual = list.find(v => v?.kind === 'individual') ?? null;
    if (!individual && verifications) {
      const created = await this.ensureIndividualVerification(sellerId, row.whop_account_id);
      individual = created.verification;
      if (created.verification) report.done.push(`verificação da pessoa criada (${created.verification.status ?? 'enviada'})`);
      if (created.warning) report.warnings.push(created.warning);
    }

    // Verificações já abertas que dependem de alguém: completar com o que o
    // cadastro tem, uma vez por verificação (o log impede reenviar a cada
    // webhook). É o que tira do "continue verificando" as contas criadas antes.
    const completed = await this.completeOpenVerifications(sellerId, row.whop_account_id, { business: verification, individual });
    report.done.push(...completed.done);
    report.warnings.push(...completed.warnings);
    if (completed.individual) individual = completed.individual;

    const verificationStatus = verification?.status
      ?? account?.verification?.business?.status
      ?? row.verification_status;
    const individualStatus = individual?.status
      ?? account?.verification?.individual?.status
      ?? row.individual_verification_status
      ?? null;

    const status = deriveConnectedStatus({
      accountStatus: account?.status,
      verificationStatus,
      individualStatus,
      capabilities: account?.capabilities,
    });

    const requested = mergeRequestedInformation([verification, individual]);

    await this.updateRow(sellerId, {
      whop_status: account?.status ?? null,
      status_reason: account?.status_reason ?? null,
      capabilities: account?.capabilities ?? {},
      payment_controls: account?.payment_controls ?? {},
      required_actions: account?.required_actions ?? [],
      verification_id: verification?.id ?? row.verification_id,
      verification_status: verificationStatus ?? null,
      individual_verification_id: individual?.id ?? row.individual_verification_id,
      individual_verification_status: individualStatus,
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
      try {
        const rfi = await this.answerRequestedInformation(sellerId);
        if (rfi?.answered) report.done.push(`${rfi.answered} pedido(s) de informação respondido(s)`);
        const open = (rfi?.unanswered ?? []) as Array<{ label?: string | null; requirement?: string }>;
        if (open.length > 0) {
          report.warnings.push(
            `a Whop pede o que não temos no cadastro: ${open.map(item => item.label || item.requirement).join(', ')}`,
          );
        }
      } catch (err: any) {
        report.warnings.push(`não foi possível responder os pedidos da Whop: ${this.errorMessage(err)}`);
      }
    }

    await this.notifyVerification(sellerId, row.status, status, verificationStatus, individualStatus);

    // Verificações aprovadas e conta liberada na Whop: a venda passa a nascer na
    // conta do seller sem ninguém apertar botão. WHOP_CONNECTED_AUTO_ENABLE=false
    // devolve a decisão ao CRM.
    if (status === 'active' && !row.charges_enabled && process.env.WHOP_CONNECTED_AUTO_ENABLE !== 'false') {
      await this.setChargesEnabled(sellerId, 'auto', { enabled: true }).catch((err: any) =>
        console.error(`[WhopConnect] modo conectado automático do seller ${sellerId}:`, err?.message));
    }

    // O que ficou pendente aparece no CRM (last_error) e no log do seller, em
    // vez de só no console do servidor.
    if (report.warnings.length > 0) {
      await this.updateRow(sellerId, { last_error: report.warnings.join(' · ').slice(0, 500) }).catch(() => { /* best-effort */ });
    }
    if (report.done.length > 0 || report.warnings.length > 0) {
      await this.log(sellerId, null, 'whop_connect.sync_report', report);
    }

    return {
      ...(await this.getStatus(sellerId)),
      syncReport: {
        ...report,
        // A leitura que explica o "continue verificando" da Whop.
        state: `empresa: ${verificationStatus ?? 'não criada'} · pessoa: ${individual?.status ?? individualStatus ?? 'não criada'}`,
      },
    };
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
      if (!row?.verification_id && !row?.individual_verification_id) return null;

      const retry = new Set(opts.retryRequirements ?? []);
      const answered = new Set((row.rfi_answered ?? []).map(String));
      const pending = (row.requested_information ?? []).filter((item: any) =>
        item?.id && (!answered.has(String(item.id)) || (item.errors?.length && retry.has(item.requirement))));
      if (pending.length === 0) return { answered: 0, unanswered: row.rfi_unanswered ?? [] };

      const source = await this.loadSellerSource(sellerId);
      const { answers, unanswered } = planRfiAnswers(pending, {
        kyc: source.kyc,
        docs: source.documents,
        // Contato da conta = o dono, que é o próprio seller.
        email: source.seller.email,
        description: source.description,
      }, { retryRequirements: [...retry] });

      if (answers.length > 0) {
        // Cada pedido volta para a verificação de onde veio (empresa ou pessoa).
        const byVerification = new Map<string, Record<string, any>[]>();
        for (const answer of answers) {
          const item = pending.find((p: any) => String(p.id) === String(answer.id));
          const verificationId = String(item?.verification_id ?? row.verification_id ?? row.individual_verification_id);
          byVerification.set(verificationId, [...(byVerification.get(verificationId) ?? []), await this.toRfiPayload(answer)]);
        }
        for (const [verificationId, payload] of byVerification) {
          await this.whop.updateVerification(verificationId, { requested_information: payload });
        }
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
        // Quem está com CNPJ pode passar para LLC e aí ganha conta conectada.
        switchToLlc: true,
        items: [] as SellerRequirementItem[],
      };
    }

    const plan = planBusinessVerification(source.kyc, source.documents);
    return {
      companyType,
      connectedStatus,
      connected: {
        required: true,
        ready: plan.missing.length === 0,
        status: connectedStatus,
        // A verificação da empresa só se conclui no formulário da Whop (EIN e
        // papéis da LLC): o painel mostra o botão enquanto ela não for aprovada.
        businessPending: Boolean(row?.whop_account_id)
          && !['approved', 'rejected'].includes(String(row?.verification_status ?? '')),
      },
      switchToLlc: false,
      items: sellerRequirementItems(plan.gaps, row?.rfi_unanswered ?? []),
    };
  }

  /**
   * Link para o seller concluir a verificação da empresa no formulário da Whop.
   * A Whop não conclui KYB por API: o EIN enviado vai para o perfil fiscal, não
   * para o formulário (testado em 2026-09-18). Gerado a cada clique porque
   * vale ~1h e o token dá acesso a saque — nada disso fica gravado.
   */
  async onboardingLink(sellerId: string) {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) throw new NotFoundException('A conta conectada ainda não foi criada.');
    if (row.verification_status === 'approved') {
      throw new BadRequestException('A verificação da empresa já foi aprovada.');
    }

    const back = process.env.CHECKOUT_PAYMENTS_URL ?? 'https://app.koopfy.com/checkout/payments?modal=koopfy-payments';
    try {
      const link = await this.whop.createAccountLink({
        company_id: row.whop_account_id,
        use_case: 'account_onboarding',
        refresh_url: back,
        return_url: back,
      });
      const url = String(link?.url ?? '').trim();
      if (!/^https:\/\/[^/]*whop\.com\//.test(url)) throw new Error('a Whop não devolveu um link válido');
      await this.log(sellerId, null, 'whop_connect.onboarding_link', { expires_at: link?.expires_at ?? null });
      return { url, expiresAt: link?.expires_at ?? null };
    } catch (err: any) {
      throw new BadRequestException(`Não foi possível abrir a verificação na Whop: ${this.errorMessage(err)}`);
    }
  }

  /**
   * Sessão para o KycElement da Whop, embutido no Koopfy Payments: o seller
   * conclui a verificação (EIN, documentos, etapa da Sumsub) sem sair do
   * painel. Token da própria Whop, restrito a identity:read/write da conta
   * conectada dele e válido por 1h — gerado a cada abertura, nunca guardado.
   * Plataforma emite esse token para a conta conectada (testado em 2026-09-18).
   */
  async verificationSession(sellerId: string) {
    const row = await this.getRow(sellerId);
    if (!row?.whop_account_id) throw new NotFoundException('A conta conectada ainda não foi criada.');
    if (row.verification_status === 'approved' && row.individual_verification_status === 'approved') {
      throw new BadRequestException('A verificação da conta já foi aprovada.');
    }

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    try {
      const session = await this.whop.createAccessToken({
        account_id: row.whop_account_id,
        scoped_actions: ['identity:read', 'identity:write'],
        expires_at: expiresAt,
      });
      const token = String(session?.token ?? '').trim();
      if (!token) throw new Error('a Whop não devolveu o token');
      await this.log(sellerId, null, 'whop_connect.verification_session', { expires_at: session?.expires_at ?? expiresAt });
      return { accountId: row.whop_account_id, token, expiresAt: session?.expires_at ?? expiresAt };
    } catch (err: any) {
      throw new BadRequestException(`Não foi possível abrir a verificação: ${this.errorMessage(err)}`);
    }
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
    // Com o saque por aprovação ligado, o dinheiro só vai para a conta
    // conectada quando um saque é aprovado. Mandar o saldo inteiro por fora
    // esvaziaria o disponível e o seller não conseguiria mais pedir saque.
    if (process.env.WHOP_CONNECTED_PAYOUTS === 'true') {
      throw new BadRequestException('Liberação avulsa desligada: o saldo vai para a conta conectada quando um saque é aprovado.');
    }
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

  /** Saldo disponível (centavos) de uma conta Whop — master ou conectada. */
  async accountAvailableCents(accountId: string, currency: string): Promise<number> {
    const account = await this.whop.getAccount(accountId);
    return availableCents(account?.balances, currency);
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

  masterAccountId(): Promise<string> {
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

  /**
   * Cria a verificação da pessoa responsável quando ela ainda não existe na
   * conta. Roda no sync, então vale tanto para conta antiga (criada antes de a
   * Koopfy criar as duas) quanto para a que nasceu com dado faltando e só
   * depois foi completada pelo seller.
   *
   * Falha aqui não derruba o sync: a conta continua sendo sincronizada e o
   * motivo fica no log — mas ela seguiria parada sem este passo.
   */
  private async ensureIndividualVerification(
    sellerId: string,
    whopAccountId: string,
  ): Promise<{ verification: any | null; warning: string | null }> {
    try {
      const source = await this.loadSellerSource(sellerId);
      const plan = planIndividualVerification(source.kyc);
      if (!plan.verification) {
        return { verification: null, warning: `verificação da pessoa não criada: falta ${plan.missing.join(', ')}` };
      }

      // Mesma chave do provisionamento: se ela já foi criada lá, a Whop devolve
      // a mesma verificação em vez de abrir uma segunda.
      const documentsVersion = String(source.documents?.updated_at ?? source.documents?.submitted_at ?? 'v1')
        .replace(/[^0-9A-Za-z]/g, '')
        .slice(0, 40);

      const identityDocs = await this.identityDocumentsPayload(source.documents);
      const individual = await this.whop.createVerification(
        whopAccountId,
        { ...plan.verification, ...(identityDocs.payload ?? {}) },
        `koopfy_connect_kyc_${sellerId}_${documentsVersion}`,
      );
      await this.log(sellerId, null, 'whop_connect.individual_verification_created', {
        verification_id: individual?.id ?? null,
        status: individual?.status ?? null,
      });
      if (identityDocs.payload && individual?.id) {
        await this.log(sellerId, null, IDENTITY_DOCUMENTS_SENT, { verification_id: individual.id });
      }
      return { verification: individual ?? null, warning: null };
    } catch (err: any) {
      return { verification: null, warning: `a Whop recusou a verificação da pessoa: ${this.errorMessage(err)}` };
    }
  }

  /**
   * Documento + selfie do cadastro no formato que a Whop analisa direto, sem
   * sessão hospedada. Sem payload, o motivo — para o CRM e o log.
   */
  private async identityDocumentsPayload(
    docs: any,
  ): Promise<{ payload: Record<string, any> | null; warning: string | null }> {
    const plan = identityDocumentsPlan(docs);
    if (!plan.documentType || plan.files.length === 0) {
      return {
        payload: null,
        warning: `documento da pessoa não enviado à Whop: falta ${plan.problems.map(p => p.label).join(', ')}`,
      };
    }
    try {
      const documents = await this.loadDocuments(plan.files);
      return { payload: { document_type: plan.documentType, documents }, warning: null };
    } catch (err: any) {
      return { payload: null, warning: `documento da pessoa não enviado à Whop: ${this.errorMessage(err)}` };
    }
  }

  /**
   * Completa as verificações que estão esperando alguém:
   *   • pessoa em `pending` ("a session needs the user's input") → documento e
   *     selfie do cadastro, que dispensam a sessão;
   *   • empresa ainda não aprovada → EIN no campo certo. Até 2026-09-18 ele ia
   *     num campo que a Whop ignora, com o CPF no lugar dele.
   * Cada correção acontece uma vez por verificação.
   */
  private async completeOpenVerifications(
    sellerId: string,
    whopAccountId: string,
    current: { business: any | null; individual: any | null },
  ): Promise<{ done: string[]; warnings: string[]; individual: any | null }> {
    const done: string[] = [];
    const warnings: string[] = [];
    let individual: any | null = null;

    const businessOpen = current.business?.id
      && !['approved', 'rejected'].includes(String(current.business.status))
      && !(await this.alreadyLogged(sellerId, BUSINESS_TIN_SENT, current.business.id));
    const individualWaiting = current.individual?.id && current.individual.status === 'pending';
    if (!businessOpen && !individualWaiting) return { done, warnings, individual };

    let source: Awaited<ReturnType<WhopConnectService['loadSellerSource']>>;
    try {
      source = await this.loadSellerSource(sellerId);
    } catch (err: any) {
      return { done, warnings: [`não foi possível ler o cadastro: ${this.errorMessage(err)}`], individual };
    }

    if (businessOpen) {
      const ein = companyFrom(source.documents).ein;
      if (!ein) {
        warnings.push('EIN não corrigido na Whop: o cadastro não tem EIN válido');
      } else {
        try {
          await this.whop.updateVerification(current.business.id, { tax_identification_number: ein });
          await this.log(sellerId, null, BUSINESS_TIN_SENT, { verification_id: current.business.id });
          done.push('EIN enviado à verificação da empresa');
        } catch (err: any) {
          warnings.push(`a Whop recusou o EIN: ${this.errorMessage(err)}`);
        }
      }
    }

    if (individualWaiting) {
      if (await this.alreadyLogged(sellerId, IDENTITY_DOCUMENTS_SENT, current.individual.id)) {
        warnings.push('documento e selfie já enviados; a Whop ainda não começou a análise da pessoa');
      } else {
        // O PATCH não aceita documento ("Unsupported fields: document_type,
        // documents", testado em 2026-09-18). Documento só vai na CRIAÇÃO, então
        // a verificação é recriada com `restart: true`, que abandona a sessão
        // parada — ninguém a concluiria mesmo.
        const plan = planIndividualVerification(source.kyc);
        const identityDocs = await this.identityDocumentsPayload(source.documents);
        if (!plan.verification) {
          warnings.push(`verificação da pessoa não refeita: falta ${plan.missing.join(', ')}`);
        } else if (!identityDocs.payload) {
          warnings.push(identityDocs.warning ?? 'documento da pessoa não enviado à Whop');
        } else {
          const documentsVersion = String(source.documents?.updated_at ?? source.documents?.submitted_at ?? 'v1')
            .replace(/[^0-9A-Za-z]/g, '')
            .slice(0, 40);
          try {
            const created = await this.whop.createVerification(
              whopAccountId,
              { ...plan.verification, ...identityDocs.payload, restart: true },
              `koopfy_connect_kyc_docs_${sellerId}_${documentsVersion}`,
            );
            // A antiga e a nova ficam marcadas: nenhuma das duas recebe o envio de novo.
            for (const id of [current.individual.id, created?.id].filter(Boolean)) {
              await this.log(sellerId, null, IDENTITY_DOCUMENTS_SENT, { verification_id: id, replaced: current.individual.id });
            }
            individual = created?.id ? created : null;
            done.push(`verificação da pessoa refeita com documento e selfie${created?.status ? ` (${created.status})` : ''}`);
          } catch (err: any) {
            warnings.push(`a Whop recusou o documento da pessoa: ${this.errorMessage(err)}`);
          }
        }
      }
    }

    return { done, warnings, individual };
  }

  /**
   * Descritor da fatura no produto em que a conta conectada cobra
   * (`external_identifier: koopfy`). Só ATUALIZA: produto criado pela API de
   * produtos nunca ganha o `external_identifier` (a Whop ignora o campo no POST
   * e no PATCH — testado em 2026-09-18), então a cobrança não o acharia e
   * criaria outro. Quem cria o produto é a primeira venda; o webhook dela chama
   * este passo e a partir daí toda venda sai com o descritor.
   */
  async ensureCheckoutProduct(accountId: string): Promise<{ done?: string; warning?: string }> {
    const descriptor = connectedStatementDescriptor();
    const taxCode = connectedAccountSettings().product_tax_code_id;
    try {
      const list = await this.whop.listProducts(accountId);
      const existing = (list?.data ?? []).find((item: any) => item?.external_identifier === KOOPFY_PRODUCT_EXTERNAL_ID);
      if (!existing) return {}; // ainda sem venda: a primeira cria o produto
      const current = await this.whop.getProduct(existing.id);
      const taxOk = !taxCode || (current?.product_tax_code?.id ?? current?.product_tax_code_id) === taxCode;
      if (current?.custom_statement_descriptor === descriptor && taxOk) return {};
      await this.whop.updateProduct(existing.id, {
        custom_statement_descriptor: descriptor,
        ...(taxCode ? { product_tax_code_id: taxCode } : {}),
      });
      return { done: `descritor da fatura: ${descriptor}` };
    } catch (err: any) {
      return { warning: `a Whop recusou o descritor da fatura: ${this.errorMessage(err)}` };
    }
  }

  /**
   * Ao mudar `tax_remitted_by`, a Whop pode religar sozinha a coleta de sales
   * tax nos 51 estados — DEPOIS do nosso PATCH, mesmo com a lista vazia nele
   * (visto com `self` em 2026-09-18). Relê a conta e zera de novo.
   */
  private async settleTaxStates(
    sellerId: string,
    whopAccountId: string,
    applied: Record<string, any>,
    report: { done: string[]; warnings: string[] },
  ) {
    if (!('tax_remitted_by' in applied)) return;
    try {
      const account = await this.whop.getAccount(whopAccountId);
      const again = accountSettingsPatch(account, connectedAccountSettings());
      if (!again?.tax_collection_enabled_states) return;
      await this.whop.updateAccount(whopAccountId, { tax_collection_enabled_states: again.tax_collection_enabled_states });
      await this.log(sellerId, null, 'whop_connect.settings_applied', { tax_collection_enabled_states: again.tax_collection_enabled_states });
      report.done.push('coleta de imposto desligada nos estados que a Whop ligou');
    } catch (err: any) {
      report.warnings.push(`não foi possível desligar a coleta de imposto por estado: ${this.errorMessage(err)}`);
    }
  }

  /** Reenvia a configuração com o endereço da LLC que está no cadastro. */
  private async retryWithRegisteredAddress(
    sellerId: string,
    whopAccountId: string,
    settingsPatch: Record<string, any>,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const source = await this.loadSellerSource(sellerId);
      const address = companyFrom(source.documents).address;
      if (!address) return { ok: false, error: 'endereço da LLC inválido no cadastro — corrija rua, cidade, estado e ZIP' };
      await this.whop.updateAccount(whopAccountId, { ...settingsPatch, business_address: address });
      await this.log(sellerId, null, 'whop_connect.settings_applied', { ...settingsPatch, business_address: address });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `${this.errorMessage(err)} (confira o estado e o ZIP da LLC no cadastro)` };
    }
  }

  /** Quantas tentativas de criar a conta deste seller já falharam (pelo log). */
  /** Conta já criada na Whop para o seller (ver existingSellerAccount). */
  private async findSellerAccount(sellerId: string): Promise<any | null> {
    const accounts: any[] = [];
    let after: string | undefined;
    // Teto de 50 páginas (5 mil contas): a lista é da plataforma inteira.
    for (let page = 0; page < 50; page++) {
      const res: any = await this.whop.listAccounts(after);
      accounts.push(...(res?.data ?? []));
      if (!res?.page_info?.has_next_page || !res?.page_info?.end_cursor) break;
      after = res.page_info.end_cursor;
    }
    return existingSellerAccount(accounts, sellerId);
  }

  private async failedProvisionAttempts(sellerId: string): Promise<number> {
    const { count, error } = await supabase
      .from('crm_action_log')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('action', 'whop_connect.provision_failed');
    // Sem conseguir contar, usa um número novo: melhor uma chave inédita do
    // que reaproveitar a de uma tentativa que falhou.
    if (error) return Date.now();
    return count ?? 0;
  }

  /** Esta correção já foi feita nesta verificação? */
  /**
   * E-mail ao seller: "continue a verificação" enquanto ela depende dele e
   * "conta verificada" quando vira ativa. O envio fica no crm_action_log, que
   * também evita repetir a cada webhook. Nunca derruba o sync.
   */
  private async notifyVerification(
    sellerId: string,
    previousStatus: string | null,
    status: ReturnType<typeof deriveConnectedStatus>,
    businessStatus: string | null,
    individualStatus: string | null,
  ) {
    try {
      const [verified, needed] = await Promise.all([
        supabase.from('crm_action_log').select('id').eq('seller_id', sellerId)
          .eq('action', VERIFIED_EMAIL_SENT).limit(1),
        supabase.from('crm_action_log').select('payload, created_at').eq('seller_id', sellerId)
          .eq('action', VERIFICATION_EMAIL_SENT).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      // Sem ler o log não dá para saber se já avisamos: melhor não mandar em dobro.
      if (verified.error || needed.error) return;

      const decision = verificationEmailDecision({
        previousStatus,
        status,
        businessStatus,
        individualStatus,
        verifiedAlreadySent: (verified.data ?? []).length > 0,
        lastNeeded: needed.data
          ? { signature: (needed.data as any).payload?.signature ?? null, at: (needed.data as any).created_at ?? null }
          : null,
      });
      if (decision.send === null) return;
      const action = decision.send === 'verified' ? VERIFIED_EMAIL_SENT : VERIFICATION_EMAIL_SENT;
      const payload = {
        status,
        business_status: businessStatus,
        individual_status: individualStatus,
        ...('signature' in decision ? { signature: decision.signature } : {}),
      };

      if (!(await notifySellerVerification(sellerId, decision.send))) return;
      await this.log(sellerId, null, action, payload);
    } catch (err: any) {
      console.error(`[WhopConnect] e-mail de verificação do seller ${sellerId}:`, err?.message);
    }
  }

  private async alreadyLogged(sellerId: string, action: string, verificationId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('crm_action_log')
      .select('id')
      .eq('seller_id', sellerId)
      .eq('action', action)
      .eq('payload->>verification_id', verificationId)
      .limit(1);
    // Sem conseguir ler o log, melhor não reenviar arquivos às cegas.
    if (error) return true;
    return (data ?? []).length > 0;
  }

  private async loadSellerSource(sellerId: string) {
    const { data: seller, error } = await supabase
      .from('seller_profiles')
      .select('id, user_id, name, email, status')
      .eq('id', sellerId)
      .maybeSingle();
    if (error) throw new BadRequestException(`Erro ao ler o seller: ${error.message}`);
    if (!seller) throw new NotFoundException('Seller não encontrado.');

    const [kyc, documents, operation] = await Promise.all([
      seller.user_id
        ? supabase.from('kyc_info').select('*').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      seller.user_id
        ? supabase.from('seller_documents').select('*').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
      seller.user_id
        ? supabase.from('operation_config').select('description').eq('user_id', seller.user_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    return {
      seller,
      kyc: (kyc as any)?.data ?? null,
      documents: (documents as any)?.data ?? null,
      description: (operation as any)?.data?.description ?? null,
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
