# Reconstrução da XPAY-db

O esquema inicial cobre o checkout europeu em sandbox a partir do contrato observado no backend `dad3e55f3eda6b42d64712081a5612572fce2712`. A cadeia histórica de SQL contém alterações incrementais e dependências ausentes. O Prisma descreve modelos legados e deve continuar separado do esquema que o runtime lê via PostgREST.

## Aplicar e verificar

1. Numa base nova, executar `001_xpay_sandbox_foundation.sql` e `002_xpay_wallet_contract.sql` em ordem como migrações transacionais. As roles `anon`, `authenticated` e `service_role` são provisionadas pelo Supabase.
2. Numa instância de validação PostgreSQL 17 sem tráfego, executar `001_xpay_sandbox_foundation.check.sql` com `ON_ERROR_STOP=1`. As fixtures são eliminadas pelo rollback.
3. Confirmar 21 tabelas de aplicação com RLS, 5 códigos de tier sem tarifas aprovadas e nenhum prestador ativo antes de escrever credenciais. As interfaces acedem à API autenticada. O browser não recebe a chave de serviço nem acede às tabelas.
4. Manter esta migração fora da sequência histórica automática enquanto as restantes dependências estiverem por recuperar. A sequência original pode voltar a criar objetos já presentes ou pressupor tabelas, views e funções em falta.

## Estrutura instalada

| Domínio | Tabelas | Código consumidor ou próximo ponto de ligação |
|---|---|---|
| Identidade e merchant | `users`, `seller_profiles`, `api_keys` | Auth e onboarding XPAY. `ApiKeyGuard` valida o hash e resolve o merchant do pedido. A chave de integração fica no servidor da loja ou do OrbiaCRM. |
| Tiers e tarifas | `fee_tiers`, `fee_tier_versions`, `seller_fees` | O cálculo existente lê `seller_fees`. A versão de tier é uma relação preparada. A publicação de tarifas e a resolução de versões ainda precisam de ligação ao cálculo. |
| Prestadores e roteamento | `stripe_accounts`, `account_daily_metrics`, `payment_method_routes`, `payment_method_route_history` | `StripeAccountsService`, `AccountRouterService` e `MethodRoutingService`. O sandbox só admite `livemode=false` e chave pública de teste. O registro de cifras é privado. Confirmar o ambiente das credenciais desencriptadas na aplicação antes de ativar a conta. |
| Checkout e pagamentos | `offers`, `checkout_sessions`, `transactions`, `transaction_attempts`, `gw_embed_origins` | `POST /checkout/session` e `POST /payments/create`. A API deve resolver merchant, preço e moeda no servidor. A sessão e os eventos devolvem apenas identificadores e dados públicos necessários ao checkout. |
| Eventos e tesouraria | `stripe_webhook_events`, `wallet_balance`, `wallet_ledger`, `xpay_event_outbox` | Dedupe do evento e unicidade no ledger. A gravação de aprovação, taxas, lançamentos e evento de saída ainda precisa de uma fronteira transacional. O outbox está criado e aguarda integração com o despachante. |
| OrbiaCRM | `xpay_orbia_merchants`, `xpay_orbia_products` | Mapeia instalação e organização a merchant e produto a oferta. IDs do CRM são referências externas. O receptor XPAY comercial ainda precisa de verificar assinatura, deduplicar e atualizar o mesmo negócio no funil. |

## Tarifas, unidades e reconciliação

- Os tiers legados `NEW`, `C`, `B`, `A` e `AAA` preservam os nomes de `prisma/seed_tiers.ts`. As respetivas tarifas históricas ficam fora da migração. O modelo de `seller_fees` tem um único registo efetivo por merchant, em linha com a leitura `maybeSingle()` e o `upsert` de onboarding. A rota antiga de criação de seller ainda tenta gravar várias linhas por tipo de taxa e precisa de ser alinhada antes de servir novos merchants.
- O motor existente usa a moeda e o valor original em cêntimos na venda. O ledger corrente usa USD em cêntimos e deriva o valor por câmbio. Qualquer evolução para liquidação EUR exige adaptar reconciliação e lançamentos. Uma reserva é um fundo a liquidar e deve permanecer separada da receita.
- O preço de checkout, a tarifa XPAY, o custo do prestador, o câmbio, as comissões de afiliado, a reserva, os estornos e os saques têm naturezas diferentes. O cálculo atual já produz `fee_breakdown` e custo estimado do prestador. O custo real da Stripe deve sair da reconciliação de balance transactions, mantendo a estimativa distinguível.
- A estrutura aceita versões de tier, moeda e vigência, além de snapshot por transação. O runtime precisa gravar a versão efetiva e os valores cobrados antes da confirmação. A lógica atual tem defaults históricos e grava `fee_breakdown` fora da transação de aprovação. Estes comportamentos devem ser resolvidos antes da ativação.

## Integração entre aplicações

O OrbiaCRM é a fonte do catálogo comercial e do negócio. O XPAY é a fonte do estado do pagamento. Um identificador externo estável mantém os dois associados. O servidor usa preços em unidades menores, incluindo 990 para 9,90 EUR. A compatibilidade antiga de interpretação do valor no checkout exige um contrato explícito para evitar ambiguidades com valores inteiros baixos.

1. O servidor do OrbiaCRM ou da loja cria uma sessão XPAY com a oferta e referência validadas. O browser recebe um identificador de sessão e, quando necessário, a chave pública da conta Stripe escolhida.
2. O backend XPAY recebe e valida o webhook da conta que criou o PaymentIntent. Antes de confirmar um pagamento, deve validar modo, conta, objeto do prestador, valor e moeda. Confirmação e lançamentos precisam de ser seguros perante reentregas e falhas a meio.
3. O XPAY publica um evento de negócio assinado. O OrbiaCRM valida e lê o estado da cobrança antes de atualizar o funil. O endpoint de faturação de assinaturas do OrbiaCRM tem um contrato próprio e precisa de um adaptador dedicado para eventos de pedidos XPAY.
4. O frontend XPay em `feature/xpay-commerce` é uma demonstração estática. Ligar através de API autenticada, com autorização por merchant. O mapeamento inicial previsto é checkout e estado do pedido, depois backoffice de contas e tarifas, depois relatórios e finanças.

## Dependências por fechar

| Área | Evidência de contratos adicionais |
|---|---|
| Onboarding e backoffice | `kyc_info`, `operation_config`, `seller_documents`, `crm_managers`, `crm_assignments`, `crm_action_log`, `crm_notes`, `seller_kpis`, views administrativas |
| Roteamento e provedores | `seller_provider_accounts`, `seller_routing_settings`, `seller_routing_accounts`, `routing_assignments`, `stripe_risk_events`, `stripe_efw_decisions`, `stripe_account_linkage_audit`, RPCs de limites e risco; adicionais por PSP |
| Contabilidade | `add_pending_balance`, `add_available_balance`, `debit_balance`, settlement, reservas, payout, chargebacks, antecipação, reconciliação e funções de relatórios. Há funções incrementais recuperáveis no repositório. |
| Comércio e extensões | Modelo persistente de link, produtos, itens de pedido e preços recorrentes. Afiliados, payout, assinaturas e faturação do seller têm módulos e migrações próprios. |

O ensaio da cadeia original numa base PostgreSQL 17 descartável passou 28 de 33 ficheiros Supabase após alinhar `wallet_ledger.id` como texto e incluir `wallet_balance.withdrawing_balance`. Os demais pararam em dependências de KYC, documentos, Whop Connected, Clip e SPEI. Executar o DDL com sucesso não comprova o comportamento dos RPCs sobre dinheiro.

Um dump do esquema original ajuda a recuperar tipos, defaults, índices, grants, triggers, policies e funções com menos hipóteses. Se for indisponível, cada contrato deve ser reconstituído e testado por fluxo sem importar dados ou credenciais.

## Referências de mercado

- [Stripe Connect](https://docs.stripe.com/connect/charges) distingue o desenho de cobrança e a responsabilidade financeira da plataforma. [Balance transactions](https://docs.stripe.com/reports/balance-transaction-types) suporta reconciliação por tipo de movimento.
- [Shopify](https://help.shopify.com/en/manual/your-account/manage-billing/billing-charges/types-of-charges/third-party-charges/third-party-transaction-fees) distingue o plano da loja e as taxas aplicáveis a processadores externos.
- [Hotmart](https://hotmart.com/en/legal/payments-policy) combina componentes fixos e de serviço sobre vendas aprovadas.

Para o XPAY, manter separadas a assinatura SaaS do OrbiaCRM, a remuneração da XPAY por transação e o custo real do PSP. O modelo comercial e a tabela de tarifas dependem da aprovação do operador.
