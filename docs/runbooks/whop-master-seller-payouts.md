# Runbook de rollout — saques de sellers pela conta master Whop

## Objetivo e invariantes

Este runbook libera o fluxo em que o seller configura o saque dentro da Koopfy, solicita uma retirada e aguarda a aprovação do CRM. A primeira chamada capaz de criar um payout na Whop acontece somente depois da aprovação administrativa.

Invariantes que precisam permanecer verdadeiros durante todo o rollout:

- o seller e o navegador nunca recebem credenciais Whop, IDs de conta conectada, IDs de payout do provedor, quote token ou dados completos do destino;
- `POST /integration/koopfy/finance/payouts` apenas reserva o saldo e cria uma execução local em `pending_review`;
- somente a aprovação do CRM pode chamar `WhopPayoutClient.createPayout`;
- uma execução local possui uma única `provider_idempotency_key` determinística;
- timeout ou resposta perdida nunca autoriza uma segunda tentativa com nova chave;
- saldo só retorna depois de `funds_returned_at` confirmado pelo provedor e apenas uma vez;
- a taxa exibida ao seller é consolidada: taxa adicional Koopfy + taxa da Whop;
- a `dash-pay` não participa deste fluxo.

## Responsáveis e autorização

- Release owner: coordena deploy, flags e evidências.
- Database owner: aplica migration somente em ambiente não produtivo primeiro.
- Finance/CRM operator: aprova, rejeita, tenta novamente e reconcilia pelo CRM.
- Incident owner: pode desabilitar a flag e coordenar reconciliação; não pode apagar execuções.

Nunca execute os passos de banco ou sandbox com uma URL de produção durante a validação inicial. Confirme o projeto Supabase, a conta master Whop e o seller de teste em voz alta no canal da mudança antes de prosseguir.

## Configuração necessária

Configure somente no servidor:

```text
WHOP_API_VERSION_DATE=2026-09-15
PAYOUT_PREVIEW_HMAC_SECRET=<segredo aleatório com pelo menos 32 bytes>
WHOP_MASTER_ACCOUNT_ID=<id interno da conta master; padrão whop_main no modo env>
WHOP_API_KEY=<credencial da conta master, quando usado o modo env>
WHOP_COMPANY_ID=<company da conta master, quando usado o modo env>
WHOP_WEBHOOK_SECRET=<segredo do endpoint Whop da conta master>
WHOP_PAYOUT_TIMEOUT_MS=10000
PAYOUT_RECONCILE_CRON=*/5 * * * *
PAYOUT_RECONCILE_STALE_MS=300000
PAYOUT_RECONCILE_BATCH_SIZE=50
KOOPFY_UNIFIED_PAYOUTS_ENABLED=true
KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED=false
```

No modo de contas persistidas, a credencial da conta apontada por `WHOP_MASTER_ACCOUNT_ID` deve existir cifrada em `whop_accounts`; não duplique a chave em logs ou evidências. A backend-embed precisa anunciar `payoutCreate` somente quando as duas flags de payout estiverem ativas.

Antes do deploy, valide:

- segredo HMAC com 32 bytes ou mais e diferente entre ambientes;
- credencial da conta master com permissão para accounts, verifications, payout methods, quotes, payouts e retrieval;
- webhook da conta master apontando para o endpoint Whop da Koopfy e usando corpo bruto;
- relógios do Pay e do gateway sincronizados, pois a assinatura do webhook possui tolerância temporal;
- nenhum segredo está presente em `NEXT_PUBLIC_*`, bundle da dashboard ou configuração entregue ao navegador.

## 1. Banco não produtivo

Primeiro faça as inspeções somente leitura:

```sql
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('request_payout','transfer_balance','credit_balance');

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('wallet_balance','wallet_ledger')
order by table_name, ordinal_position;
```

Pare se as assinaturas ou colunas forem diferentes das precondições da migration existente. Em seguida:

```bash
export KOOPFY_SUPABASE_TEST_DB_URL='<URL não produtiva>'

../../../dash-checkout/node_modules/.bin/supabase db push \
  --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" --dry-run

../../../dash-checkout/node_modules/.bin/supabase db push \
  --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" --yes

../../../dash-checkout/node_modules/.bin/supabase test db \
  supabase/tests/whop_master_seller_payouts.test.sql \
  --db-url "$KOOPFY_SUPABASE_TEST_DB_URL"

../../../dash-checkout/node_modules/.bin/supabase db advisors \
  --db-url "$KOOPFY_SUPABASE_TEST_DB_URL" \
  --type security --fail-on error

../../../dash-checkout/node_modules/.bin/supabase migration list \
  --db-url "$KOOPFY_SUPABASE_TEST_DB_URL"
```

Gate de aprovação:

- dry-run contém apenas a migration pretendida;
- pgTAP conclui 43/43;
- advisor não retorna erro de segurança;
- `20260921051248_whop_master_seller_payouts.sql` aparece no histórico não produtivo;
- browser roles não possuem acesso às tabelas/RPCs privadas de payout.

## 2. Matriz automatizada

Execute nos repositórios canônicos antes de promover artefatos:

```bash
cd /Users/lucas/koopfy/backend/apps/pay
pnpm test -- --runInBand
pnpm build

cd /Users/lucas/koopfy/backend-embed
pnpm --dir apps/checkout test -- --runInBand
pnpm --dir apps/checkout build

cd /Users/lucas/koopfy/dash-checkout
node --test \
  lib/finance/payout-request.test.mjs \
  lib/koopfy-payments-state.test.mjs \
  lib/finance-api.test.mjs
pnpm build
```

Todos os comandos devem sair com código zero. Registre commit, horário, duração e total de testes; não cole variáveis de ambiente.

## 3. Ordem de deploy com flag fechada

1. Aplique e verifique a migration no ambiente não produtivo.
2. Configure `WHOP_API_VERSION_DATE=2026-09-15`, `PAYOUT_PREVIEW_HMAC_SECRET` e as credenciais master somente no servidor.
3. Mantenha `KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED=false` ao publicar, nesta ordem: Pay, checkout facade e seller UI.
4. Faça smoke test de leitura: wallet/histórico continuam disponíveis e a capability `payoutCreate` permanece `false`.
5. Confirme que o CRM carrega regras de taxa e ações de payout, mas não aprove uma execução real enquanto o sandbox não estiver preparado.

Publicar a UI antes do Pay é proibido: o Pay novo transforma idempotência ainda em processamento em 503 e recupera replay assinado antes da expiração da cotação.

## 4. Aceitação sandbox

Use um seller interno sem dados reais de comprador e valores mínimos permitidos pelo sandbox. Registre uma janela de início/fim para correlacionar logs e chamadas.

### Passo 1 — habilitação controlada

Ative as duas flags somente no ambiente sandbox/interno:

```text
KOOPFY_UNIFIED_PAYOUTS_ENABLED=true
KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED=true
```

Confirme que `capabilities.payoutCreate=true` aparece apenas para o ambiente/coorte autorizado.

### Passo 2 — verificação e método salvo

1. Abra **Saldo e liquidações → Solicitar saque**.
2. Conclua a verificação de identidade em navegação de mesma aba.
3. Use **Já concluí — atualizar status** até a conta ficar `ready` e `payoutsEnabled=true`.
4. Crie um destino suportado e confirme que a tela passa a mostrar somente referência mascarada.
5. Inspecione a resposta pública: ela pode conter apenas ID local do método, tipo, rótulo, referência mascarada, moeda/país/rede, velocidades, default e status.

### Passo 3 — preview e reserva local

1. Solicite uma cotação e guarde apenas valores consolidados e horários.
2. Confirme a cotação pela seller UI.
3. Verifique `payout_executions.local_state='pending_review'`.
4. Verifique que `available_balance` diminuiu pelo bruto e `withdrawing_balance` aumentou pelo mesmo bruto.
5. Na janela registrada, confirme **zero** chamadas `POST /api/v1/payouts` nos logs de saída/Whop.
6. Simule resposta perdida no POST local, feche/reabra a tela após a expiração e confirme que o mesmo body e a mesma `Idempotency-Key` recuperam a execução existente.

Falha neste passo exige rollback imediato; a solicitação do seller não pode criar payout externo.

### Passo 4 — aprovação CRM e retry forçado

1. Abra a execução pelo CRM e revise bruto, taxas consolidadas, líquido, destino mascarado e ETA.
2. Force uma falha recuperável/timeout na primeira tentativa de despacho.
3. Aprove a execução e depois acione retry/reconciliação conforme o estado.
4. Confirme exatamente um `provider_payout_id`, uma `provider_idempotency_key` e uma criação aceita na Whop.
5. Confirme que cliques concorrentes de aprovação produzem um vencedor e no-op seguro para os demais.
6. Confirme a trilha em `crm_action_log` para request, aprovação e despacho.

### Passo 5 — webhooks duplicados e fora de ordem

Entregue fixtures assinadas, sem gravar o body bruto nas evidências:

1. `processing` duas vezes;
2. `completed` antes de um `processing` atrasado;
3. `failed` sem `funds_returned_at`;
4. o mesmo `failed` com `funds_returned_at`;
5. duplicata do evento anterior;
6. `reversed` com confirmação de retorno.

Confirme:

- estado terminal não regride;
- duplicatas não repetem lançamentos;
- falha sem confirmação do retorno não restaura saldo;
- `wallet_restored_at` é preenchido uma única vez após `funds_returned_at`;
- o valor restaurado é o bruto reservado, não o líquido;
- payout Koopfy desconhecido é retryable e gera alerta, sem ser associado por adivinhação.

### Passo 6 — recotação

Force deterioração do líquido durante a aprovação. A execução deve mudar para `requote_required`, a seller UI deve mostrar taxas/líquido atualizados e somente uma nova confirmação explícita pode devolvê-la a `pending_review`. O texto não pode afirmar que o dinheiro foi enviado.

## 5. Evidências permitidas

Crie uma pasta de evidência protegida com:

- commits e artefatos implantados;
- ambiente, janela temporal e IDs **locais** da execução/ledger;
- contagem de requests, aprovações, chamadas externas e webhooks duplicados;
- antes/depois dos saldos em unidades menores;
- screenshots com seller, documento, conta, Pix e carteira mascarados;
- resultado resumido de testes, pgTAP, advisor e queries de observabilidade.

Nunca capture:

- API key, webhook secret, HMAC secret ou header Authorization;
- `confirmationToken`, quote token ou payload assinado;
- documento de identidade;
- routing/account number, chave Pix ou endereço de carteira completos;
- `biz_*`, `potk_*` ou `wdrl_*` em material compartilhado fora do time operacional;
- body bruto de webhook.

## 6. Observabilidade e alertas

### Métricas derivadas da fonte autoritativa

O dashboard operacional deve consultar/agregar `payout_executions` e `crm_action_log`. Use somente acesso service-role:

```sql
select
  date_trunc('hour', created_at) as bucket,
  count(*) as requests,
  count(*) filter (where reviewed_at is not null and local_state <> 'rejected') as approvals,
  count(*) filter (where local_state = 'rejected') as rejections,
  count(*) filter (where accepted_at is not null) as provider_acceptances,
  count(*) filter (where completed_at is not null) as completions,
  count(*) filter (where local_state = 'reversed') as reversals,
  count(*) filter (where local_state = 'dispatch_failed') as dispatch_failures,
  sum(gross_minor) as gross_minor,
  sum(provider_fee_minor) as provider_fee_minor,
  sum(koopfy_fee_minor) as koopfy_fee_minor,
  sum(net_minor) filter (where completed_at is not null) as delivered_net_minor
from public.payout_executions
where created_at >= now() - interval '24 hours'
group by 1
order by 1;
```

Timers de aprovação, aceite e conclusão:

```sql
select
  percentile_cont(array[0.5, 0.95, 0.99]) within group (
    order by extract(epoch from (reviewed_at - created_at))
  ) filter (where reviewed_at is not null) as request_to_review_seconds,
  percentile_cont(array[0.5, 0.95, 0.99]) within group (
    order by extract(epoch from (accepted_at - reviewed_at))
  ) filter (where accepted_at is not null and reviewed_at is not null) as review_to_accept_seconds,
  percentile_cont(array[0.5, 0.95, 0.99]) within group (
    order by extract(epoch from (completed_at - accepted_at))
  ) filter (where completed_at is not null and accepted_at is not null) as accept_to_complete_seconds
from public.payout_executions
where created_at >= now() - interval '7 days';
```

Erros, execuções stale e criações externas incertas:

```sql
select error_code, count(*)
from public.payout_executions
where error_code is not null
  and updated_at >= now() - interval '1 hour'
group by error_code
order by count(*) desc;

select id, local_state, updated_at
from public.payout_executions
where local_state in ('dispatching','processing','dispatch_failed')
  and updated_at < now() - interval '5 minutes'
order by updated_at;

select id, provider_create_started_at
from public.payout_executions
where provider_create_started_at is not null
  and provider_create_resolved_at is null
order by provider_create_started_at;
```

O log periódico `Payout reconciliation` precisa ser ingerido como evento estruturado com `scanned`, `reconciled`, `manualRequired` e `failed`. Não inclua IDs de destino ou payloads do provedor.

### Alertas obrigatórios antes do rollout geral

| Alerta | Condição | Ação inicial |
|---|---|---|
| Autenticação/permissão Whop | qualquer `authentication_failed` ou `permission_denied` | fechar flag; validar credencial/escopo sem rotacionar às cegas |
| Assinatura inválida | qualquer `Whop: assinatura inválida` | conferir raw body, relógio, segredo e endpoint; não aceitar evento |
| Payout Koopfy desconhecido | resposta retryable para metadata `koopfy_payout_id` sem execução | procurar por ID local; não anexar manualmente sem validar metadata imutável |
| Falha repetida de despacho | mesma execução em `dispatch_failed` após retry administrativo | bloquear novo retry automático e escalar para Finance/Engenharia |
| Execução stale | `dispatching/processing` acima do SLA ou `manualRequired > 0` | reconciliar pelo CRM; nunca restaurar saldo por suposição |
| Restauração divergente | `funds_returned_at` sem `wallet_restored_at` além do ciclo do reconciler | investigar RPC e reconciliar; não creditar manualmente duas vezes |

Teste cada alerta em não produção e anexe horário de disparo, recebimento e resolução. Sem evidência de disparo, o gate de produção permanece fechado.

## 7. Rollout progressivo

1. Mantenha a flag master fechada durante todos os deploys.
2. Habilite em ambiente interno e conclua toda a aceitação sandbox.
3. Habilite uma coorte limitada por ambiente/gateway/allowlist operacional. A flag atual é global; não a use como substituta de segmentação.
4. Observe ao menos um ciclo completo de reconciliação e os SLAs definidos.
5. Amplie a coorte somente sem alertas abertos, execuções incertas ou divergência de saldo.
6. Habilite disponibilidade geral por último.

## 8. Rollback

Em incidente:

1. Defina `KOOPFY_WHOP_MASTER_PAYOUTS_ENABLED=false` no Pay e na checkout facade.
2. Confirme `capabilities.payoutCreate=false`; não aceite novas solicitações nem novos despachos.
3. Mantenha webhooks e o scheduler de reconciliação executando. A flag fechada não autoriza abandonar payouts já aceitos.
4. Não apague `payout_executions`, `payout_request_keys`, ledger, métodos ou eventos.
5. Liste todas as execuções não terminais e reconcilie cada uma pela leitura autoritativa do provedor.
6. Execução com `provider_create_started_at` sem resolução exige reconciliação manual; nunca repita create nem devolva fundos por inferência.
7. Só reverta código depois que cada execução estiver terminal, `requote_required`, `dispatch_failed` conhecido ou formalmente entregue ao procedimento manual.
8. Registre causa, impacto, saldos e IDs locais no incidente; mantenha segredos e dados de destino fora do documento.

Query de controle:

```sql
select id, local_state, provider_payout_id is not null as has_provider_payout,
       provider_create_started_at, provider_create_resolved_at,
       funds_returned_at, wallet_restored_at, updated_at
from public.payout_executions
where local_state not in ('completed','failed','canceled','denied','reversed','rejected')
order by updated_at;
```

O rollback só termina quando Finance e Engenharia assinarem a lista de execuções remanescentes.

## Checklist de liberação

- [ ] Migration aplicada e 43/43 pgTAP aprovados em não produção.
- [ ] Advisor sem erro de segurança.
- [ ] Matriz automatizada verde nos três repositórios.
- [ ] Request do seller produziu zero chamadas de create ao provedor.
- [ ] Aprovação CRM produziu exatamente um payout sob retry forçado.
- [ ] Duplicatas e eventos fora de ordem não repetiram restauração.
- [ ] Retry após resposta perdida reutilizou body e chave, inclusive após expiração do preview.
- [ ] Taxa, líquido, câmbio e ETA conferem com a fonte autoritativa.
- [ ] Alertas obrigatórios dispararam em não produção.
- [ ] Evidências estão mascaradas e sem segredos.
- [ ] Rollback foi ensaiado com webhooks/reconciliação ativos.
- [ ] Aprovação final de Finance, Engenharia e release owner registrada.
