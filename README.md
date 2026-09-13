# AtlasGlobalPayments — Dossier Tecnico Completo

> **Core Banking & Payment Orchestration Engine v2.4.1**
> Plataforma SaaS multi-tenant para processamento de pagamentos, tesouraria e orquestracao de gateways

---

## Indice

1. [Visao Geral do Sistema](#1-visao-geral-do-sistema)
2. [Arquitetura](#2-arquitetura)
3. [Stack Tecnologica](#3-stack-tecnologica)
4. [Modelo de Dados (Prisma Schema)](#4-modelo-de-dados)
5. [API REST — Referencia Completa](#5-api-rest)
6. [Motor de Pagamentos (Orchestrator)](#6-motor-de-pagamentos)
7. [Provedores de Pagamento (Providers)](#7-provedores-de-pagamento)
8. [Sistema de Ledger & Tesouraria](#8-sistema-de-ledger--tesouraria)
9. [Motor de Liquidacao (Settlement)](#9-motor-de-liquidacao)
10. [Autenticacao & Seguranca](#10-autenticacao--seguranca)
11. [Cron Jobs & Processamento Agendado](#11-cron-jobs--processamento-agendado)
12. [Infraestrutura & Deploy](#12-infraestrutura--deploy)
13. [Scripts Operacionais](#13-scripts-operacionais)
14. [Fluxos de Dados](#14-fluxos-de-dados)
15. [Tabela de Enums & Configuracao](#15-tabela-de-enums--configuracao)
16. [Variaveis de Ambiente](#16-variaveis-de-ambiente)
17. [Estrutura de Diretorios](#17-estrutura-de-diretorios)
18. [Observacoes & Recomendacoes](#18-observacoes--recomendacoes)

---

## 1. Visao Geral do Sistema

### O que e

O **AtlasGlobalPayments Core** e um motor de core banking e orquestracao de pagamentos construido em Node.js/TypeScript. Opera como o sistema nervoso central de uma plataforma SaaS multi-tenant que processa pagamentos cross-border entre Europa (EUR) e Brasil (BRL).

### Dominio de Negocio

| Aspecto | Detalhe |
|---|---|
| **Mercados** | Europa (PT, UK) + Brasil |
| **Moedas** | EUR, BRL, USD, USDT, BTC |
| **Modelo** | SaaS Multi-Tenant (sub-marcas por merchant) |
| **Metodos de Pagamento** | Cartao (Stripe/SumUp), PIX (Mistic), MBWay, Bancontact, Cripto (NOWPayments), Transferencia Bancaria |
| **Precificacao** | 5 niveis de tarifa (NEW → AAA) com fees progressivos |
| **Liquidacao** | Modelo D+X com 3 etapas de saldo |

### Funcionalidades Principais

- **Motor de Tesouraria (Ledger):** Sistema de 3 pools de liquidez (Incoming, Pending, Available) protegido por transacoes ACID via Prisma
- **Smart Routing SaaS:** Roteamento dinamico de pagamentos multi-tenant suportando 5 provedores
- **Payouts Automatizados:** Motor de saques com aprovacao manual por backoffice
- **Cron de Liquidacao:** Motor agendado (node-cron) para transicao de estado de fundos
- **Dashboard de Pipeline:** Agregacao de transacoes por status com filtros
- **Payment Links:** Checkout links com slugs unicos e branding customizavel
- **API Keys:** Autenticacao via API key para integracoes headless
- **Headless Checkout:** Fluxo de checkout publico com branding por store

---

## 2. Arquitetura

### Diagrama de Arquitetura

```
                                    ┌─────────────────────────────────────┐
                                    │         Clientes Externos           │
                                    │  (Frontend, Mobile, Integracoes)   │
                                    └──────────────┬──────────────────────┘
                                                   │ HTTPS
                                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        API Gateway (Express 4.x)                         │
│                        Porta: 8080 / 8081 (host)                         │
│                                                                          │
│  ┌──────────┐  ┌───────────────┐  ┌─────────────┐  ┌────────────────┐  │
│  │  CORS    │  │  JSON Parser  │  │ Raw Body    │  │  Auth          │  │
│  │  Origin  │  │  (global)     │  │ (Stripe     │  │  (JWT / API    │  │
│  │  Check   │  │               │  │  webhook)   │  │   Key)         │  │
│  └──────────┘  └───────────────┘  └─────────────┘  └────────────────┘  │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            Route Layer                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                    api.routes.ts (Router Central)                    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└────────┬─────────┬──────────┬──────────┬──────────┬──────────┬───────────┘
         │         │          │          │          │          │
    ┌────▼───┐ ┌──▼───┐ ┌────▼───┐ ┌───▼───┐ ┌───▼────┐ ┌───▼────────┐
    │Wallet  │ │Store │ │Gateway │ │Deposit│ │Transac.│ │Admin/      │
    │Control.│ │Contr.│ │Control.│ │Control.│ │Control.│ │Dashboard   │
    └────┬───┘ └──┬───┘ └────┬───┘ └───┬───┘ └───┬────┘ └───┬────────┘
         │        │          │          │          │           │
         └────────┴──────────┴──────────┴──────────┴───────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Service Layer                                   │
│  ┌───────────────────────┐ ┌───────────────────┐ ┌────────────────────┐ │
│  │ LedgerService         │ │ SettlementService │ │ PaymentOrchestrator│ │
│  │ (Double-Entry Ledger) │ │ (3-Stage Engine)  │ │ (Smart Routing)    │ │
│  └───────────┬───────────┘ └────────┬──────────┘ └─────────┬──────────┘ │
└──────────────┼──────────────────────┼──────────────────────┼─────────────┘
               │                      │                      │
               ▼                      ▼                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        Data Layer (Prisma 5.x)                           │
│                        PostgreSQL                                        │
│  ┌────────┐ ┌────────┐ ┌──────┐ ┌────────┐ ┌────────┐ ┌──────────┐     │
│  │ User   │ │Wallet  │ │Store │ │LedgerTx│ │Transac.│ │TierConfig│     │
│  └────────┘ └────────┘ └──────┘ └────────┘ └────────┘ └──────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
            ┌────────────┐ ┌───────────┐ ┌──────────────┐
            │  Stripe    │ │  Mistic   │ │ NOWPayments  │
            │  (EUR)     │ │  (BRL/PIX)│ │ (Cripto)     │
            ├────────────┤ └───────────┘ ├──────────────┤
            │  SumUp     │               │  Viva Wallets│
            │  (EUR/PT)  │               │  (EUR)       │
            └────────────┘               └──────────────┘
```

### Padroes Arquiteturais

| Padrao | Implementacao |
|---|---|
| **MVC Simplificado** | Controllers → Services → Prisma (sem repositorio separado) |
| **Multi-Tenant SaaS** | User → Store[] → GatewayConfig[] com isolacao por `user_id` |
| **Double-Entry Ledger** | `LedgerTransaction` → `LedgerEntry[]` (contabilidade de partidas dobradas) |
| **3-Stage Settlement** | `balance_incoming` → `balance_pending` → `balance_available` |
| **Strategy Pattern** | `PaymentProvider` interface com implementacoes por provedor |
| **Smart Routing** | Roteamento por moeda (BRL→Mistic, EUR→Stripe) com fallback automatico |
| **Tiered Pricing** | `TierConfig` (NEW/C/B/A/AAA) com overrides por utilizador |

---

## 3. Stack Tecnologica

### Core Runtime

| Componente | Versao | Uso |
|---|---|---|
| **Node.js** | 20 (slim) | Runtime principal |
| **TypeScript** | ^5.2.2 | Linguagem principal (target: ES2022) |
| **Express** | ^4.18.2 | Framework HTTP |
| **Prisma** | ^5.22.0 | ORM para PostgreSQL |
| **PostgreSQL** | — | Base de dados principal |

### Dependencias de Producao

| Pacote | Versao | Funcao |
|---|---|---|
| `@prisma/client` | ^5.22.0 | Cliente de runtime Prisma ORM |
| `axios` | ^1.14.0 | Cliente HTTP para chamadas a APIs externas |
| `bcryptjs` | ^2.4.3 | Hashing de passwords (10 salt rounds) |
| `cors` | ^2.8.5 | Middleware CORS |
| `dotenv` | ^16.3.1 | Carregamento de variaveis de ambiente |
| `jsonwebtoken` | ^9.0.2 | Emissao/verificacao de tokens JWT |
| `node-cron` | ^4.2.1 | Agendamento de tarefas (cron) |
| `stripe` | ^14.1.0 | SDK oficial Stripe |
| `zod` | ^4.3.6 | Validacao de schemas em runtime |

### Dependencias de Desenvolvimento

| Pacote | Versao | Funcao |
|---|---|---|
| `@types/bcryptjs` | ^2.4.6 | TypeScript types |
| `@types/cors` | ^2.8.15 | TypeScript types |
| `@types/express` | ^4.17.20 | TypeScript types |
| `@types/jsonwebtoken` | ^9.0.5 | TypeScript types |
| `@types/node` | ^20.8.9 | TypeScript types |
| `@types/node-cron` | ^3.0.11 | TypeScript types |
| `prisma` | ^5.22.0 | Prisma CLI (migrations, generate) |
| `typescript` | ^5.2.2 | Compilador TypeScript |

### Configuracao TypeScript

| Setting | Valor |
|---|---|
| `target` | ES2022 |
| `module` | CommonJS |
| `outDir` | `./dist` |
| `rootDir` | `./src` |
| `strict` | `true` |
| `esModuleInterop` | `true` |
| `skipLibCheck` | `true` |

---

## 4. Modelo de Dados

### Visao Geral do Schema

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│    User      │────<│    Store     │────<│  GatewayConfig   │
│              │     │              │     │                  │
│ id (cuid)    │     │ id (cuid)    │     │ id (cuid)        │
│ username     │     │ name         │     │ provider_name    │
│ password_hash│     │ logo_url     │     │ api_key (enc)    │
│ role         │     │ primary_color│     │ merchant_id      │
│ tier         │     │ webhook_url  │     │ routing_rules    │
│ kyc_level    │     │ webhook_sec  │     │ is_active        │
│ 2fa_secret   │     │ user_id (FK) │     │ user_id (FK)     │
└──┬───┬───┬───┘     └──────────────┘     │ store_id (FK)    │
   │   │   │                              └──────────────────┘
   │   │   │
   │   │   ├──────────<┌──────────────┐
   │   │   │           │    Wallet    │
   │   │   │           │              │
   │   │   │           │ id (cuid)    │
   │   │   │           │ user_id (FK) │
   │   │   │           │ currency_code│
   │   │   │           │ type         │
   │   │   │           │ bal_incoming │
   │   │   │           │ bal_pending  │
   │   │   │           │ bal_available│
   │   │   │           └──────┬───────┘
   │   │   │                  │
   │   │   ├──────────<┌──────▼───────┐     ┌──────────────────┐
   │   │              │ LedgerEntry  │────>│ LedgerTransaction│
   │   │              │              │     │                  │
   │   │              │ wallet_id    │     │ id (cuid)        │
   │   │              │ direction    │     │ type             │
   │   │              │ amount       │     │ status           │
   │   │              │ currency_code│     │ cleared_at       │
   │   │              └──────────────┘     └──────────────────┘
   │   │
   │   ├──────────<┌──────────────┐     ┌──────────────────┐
   │              │  Transaction  │────>│  WebhookEvent    │
   │              │              │     │                  │
   │              │ id (cuid)    │     │ payload (JSON)   │
   │              │ amount       │     │ status           │
   │              │ currency     │     │ attempts         │
   │              │ status       │     │ response_code    │
   │              │ provider_name│     └──────────────────┘
   │              │ payee_id(FK) │
   │              │ store_id(FK) │
   │              │ net_amount   │
   │              │ fee_amount   │
   │              │ clears_at    │
   │              │ metadata     │
   │              └──────────────┘
   │
   ├──────────<┌──────────────┐
   │           │    Payout    │
   │           │              │
   │           │ amount       │
   │           │ currency_code│
   │           │ method       │
   │           │ destination  │
   │           │ status       │
   │           └──────────────┘
   │
   ├──────────<┌──────────────┐
   │           │    ApiKey    │
   │           │              │
   │           │ key_hash     │
   │           │ key_prefix   │
   │           └──────────────┘
   │
   └──────────<┌──────────────┐
              │ PaymentLink  │
              │              │
              │ slug (unique)│
              │ amount       │
              │ currency     │
              │ active       │
              └──────────────┘

┌──────────────┐     ┌──────────────────┐
│   Currency   │     │   TierConfig     │
│              │     │                  │
│ code (PK)    │     │ name (unique)    │
│ type         │     │ feeInEur         │
│ precision    │     │ feeInBrl         │
│ is_active    │     │ feeOut           │
└──────────────┘     │ feeSwap          │
                     │ volLimit         │
                     │ defaultBrlProv   │
                     │ defaultEurProv   │
                     └──────────────────┘

┌──────────────────┐
│ MasterProvider   │
│                  │
│ id (manual PK)   │
│ companyName      │
│ providerType     │
│ capabilities[]   │
│ settlementDays   │
│ apiKeyEncrypted  │
│ isActive         │
└──────────────────┘
```

### Enums

#### `Role`
```
admin     — Acesso total ao backoffice
operator  — Operador com permissoes limitadas
viewer    — Leitura apenas
merchant  — Merchant (recebe pagamentos)
customer  — Cliente final
```

#### `TransactionStatus`
```
pending            — Pagamento iniciado, aguardando confirmacao
gateway_confirmed  — Confirmado pelo provedor, aguardando liquidacao
failed             — Pagamento falhou
settled            — Fundos liquidados e disponiveis
```

### Modelos Detalhados

#### User
| Campo | Tipo | Restricoes | Descricao |
|---|---|---|---|
| `id` | String (cuid) | PK | Identificador unico |
| `username` | String | Unique | Login do utilizador |
| `password_hash` | String | — | Hash bcrypt da password |
| `role` | Role enum | Default: `customer` | Papel no sistema |
| `tier` | String | Default: `"NEW"` | Nivel de tarifa (NEW/C/B/A/AAA) |
| `overrideFeeInEur` | Decimal? | — | Override de fee EUR |
| `overrideFeeInBrl` | Decimal? | — | Override de fee BRL |
| `overrideFeeSwap` | Decimal? | — | Override de fee swap |
| `maxVolumeMonthly` | Decimal | Default: 10000 | Limite mensal |
| `email` | String? | Unique | Email |
| `email_verified` | Boolean | Default: false | Verificacao de email |
| `phone` | String? | Unique | Telefone |
| `two_factor_secret` | String? | — | Segredo TOTP 2FA |
| `full_name` | String? | — | Nome completo (KYC) |
| `country` | String? | — | Pais (KYC) |
| `tax_id` | String? | — | NIF/CNPJ (KYC) |
| `kyc_level` | Int | Default: 0 | Nivel de KYC |
| `chatwoot_contact_id` | String? | — | Integracao CRM Chatwoot |
| `webhook_url` | String? | — | URL de webhook do merchant |
| `webhook_secret` | String? | — | Segredo para assinatura HMAC |

#### Wallet
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String (cuid) | PK |
| `user_id` | String | FK → User |
| `currency_code` | String | FK → Currency |
| `type` | String | `merchant`, `fee`, `treasury`, `fx_pool` |
| `balance_incoming` | Decimal(20,8) | Fundos recebidos, nao confirmados |
| `balance_pending` | Decimal(20,8) | Confirmados, em periodo de liquidacao |
| `balance_available` | Decimal(20,8) | Disponiveis para uso/saque |
| **Unique** | `[user_id, currency_code, type]` | Composto |

#### Transaction
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String (cuid) | PK |
| `amount` | Decimal(15,2) | Valor do pagamento |
| `currency` | String | Moeda |
| `status` | TransactionStatus | Estado da transacao |
| `country_code` | String | Codigo do pais |
| `payment_method` | String | card, mbway, bancontact, pix, etc. |
| `provider_name` | String | Gateway utilizado |
| `fee_amount` | Decimal? | Taxa cobrada (default: 0.0) |
| `net_amount` | Decimal? | Valor liquido (default: 0.0) |
| `provider_transaction_id` | String? | Ref. externa (unique) |
| `customer_email` | String? | Email do pagador |
| `metadata` | Json? | Payload flexivel |
| `payee_id` | String | FK → User (merchant) |
| `store_id` | String? | FK → Store |
| `clears_at` | DateTime? | Previsao de liquidacao |

#### LedgerTransaction
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String (cuid) | PK |
| `type` | String | PAYIN, PAYOUT, SWAP, FEE |
| `status` | String | pending, cleared |
| `reference_id` | String? | Referencia externa |
| `description` | String? | Descricao humana |
| `cleared_at` | DateTime? | Quando foi liquidado |

#### LedgerEntry
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String (cuid) | PK |
| `ledger_transaction_id` | String | FK → LedgerTransaction |
| `wallet_id` | String | FK → Wallet |
| `direction` | String | CREDIT, DEBIT |
| `amount` | Decimal(20,8) | Valor |
| `currency_code` | String | FK → Currency |

#### TierConfig (Catalogo de Precos)
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String (cuid) | PK |
| `name` | String | Identificador do tier (unique) |
| `feeInEur` | Decimal | Fee para rececoes EUR |
| `feeInBrl` | Decimal | Fee para rececoes BRL |
| `feeOut` | Decimal | Fee para saques (default: 0) |
| `feeSwap` | Decimal | Fee para conversao (default: 0) |
| `defaultBrlProv` | String | Provedor BRL padrao |
| `defaultEurProv` | String | Provedor EUR padrao |
| `volLimit` | Decimal | Limite de volume mensal |

#### Tabela de Tiers (Seed Data)

| Tier | Fee EUR | Fee BRL | Fee Swap | Vol. Limit | Provedor BRL | Provedor EUR |
|---|---|---|---|---|---|---|
| **NEW** | 0.25 | 0.15 | 0.05 | €5,000 | MISTIC | STRIPE_001_UK |
| **C** | 0.25 | 0.15 | 0.05 | €10,000 | MISTIC | STRIPE_001_UK |
| **B** | 0.20 | 0.15 | 0.05 | €50,000 | MISTIC | SUMUP_001_PT |
| **A** | 0.15 | 0.10 | 0.03 | €100,000 | PIXMATRIZ | STRIPE_002_PT |
| **AAA** | 0.10 | 0.05 | 0.02 | €999,999 | PIXMATRIZ | SUMUP_001_PT |

> Fees expressas como valores flat por transacao (em EUR), nao percentagens

#### MasterProvider (Contas proprias da plataforma)
| Campo | Tipo | Descricao |
|---|---|---|
| `id` | String | PK manual (ex: `Stripe_001_UK`) |
| `companyName` | String | Nome da entidade legal |
| `providerType` | String | stripe, sumup, mistic, nowpayments |
| `capabilities` | String[] | CARD, MBWAY, BANCONTACT, etc. |
| `settlementDays` | Int | Dias ate liquidacao |
| `apiKeyEncrypted` | String? | Chave criptografada |
| `isActive` | Boolean | Default: true |

---

## 5. API REST

### Base URL
```
Producao:  https://api-core.nexflowx.tech/api/v1
Desenvolvimento: http://localhost:8080/api/v1
```

### Autenticacao
Todos os endpoints protegidos suportam dois metodos:
1. **JWT Bearer Token:** `Authorization: Bearer <token>` (expiracao: 24h)
2. **API Key:** `x-api-key: nx_live_<hex32>` (chave SHA-256 hashed no servidor)

### Mapa Completo de Endpoints

#### Autenticacao

```
POST   /api/v1/auth/login
```
| Campo | Tipo | Descricao |
|---|---|---|
| `username` | String | Nome de utilizador |
| `password` | String | Password (suporta plaintext e bcrypt) |

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "...", "role": "merchant", "username": "..." }
}
```
**Publico** — sem autenticacao necessaria

---

#### Wallets (Carteiras)

```
GET    /api/v1/wallet          ← Carteira principal (auto-cria se nao existir)
GET    /api/v1/wallets         ← Lista todas as carteiras do utilizador
```

**Response GET /wallet:**
```json
{
  "data": {
    "id": "...",
    "user_id": "...",
    "currency_code": "EUR",
    "type": "merchant",
    "balance_incoming": "150.50",
    "balance_pending": "320.00",
    "balance_available": "1250.75"
  }
}
```

> Nota: `/wallet` cria automaticamente uma wallet EUR se o utilizador nao tiver nenhuma

---

#### Deposits (Entradas de Fundos)

```
POST   /api/v1/deposits
```
| Campo | Tipo | Descricao |
|---|---|---|
| `amount` | Number | Valor obrigatorio |
| `currency` | String | Moeda (BRL, EUR) |
| `method` | String? | Metodo de pagamento |
| `store_id` | String? | ID da store (opcional) |
| `customer_email` | String? | Email do pagador |
| `country` | String? | Codigo do pais |
| `metadata` | Object? | Dados adicionais |

**Response 200 (PIX):**
```json
{
  "transactionId": "dep_a1b2c3d4e5f6",
  "type": "QR_CODE",
  "qr_code": "00020126580014br.gov.bcb...",
  "qr_code_base64": "data:image/png;base64,...",
  "expires_in": 3600,
  "provider": "mistic"
}
```

**Response 200 (Checkout):**
```json
{
  "transactionId": "dep_a1b2c3d4e5f6",
  "type": "HOSTED_CHECKOUT",
  "url": "https://checkout.nexflowx.tech/?txId=dep_a1b2c3d4e5f6",
  "provider": "stripe"
}
```

**Response 200 (Transferencia Bancaria):**
```json
{
  "transactionId": "dep_a1b2c3d4e5f6",
  "type": "BANK_TRANSFER",
  "iban": "PT50 0000 0000 1234 5678 9012 3",
  "bic": "NEXFPTPL",
  "bank_name": "NeXFlowX Core Bank"
}
```

**Logica de Roteamento Automatico:**
- **BRL:** Primario → `mistic`, Fallback → `mercadopago`
- **EUR:** Primario → `stripe`, Fallback → `sumup`
- Fallback automatico se provedor primario falhar

---

#### Swap (Conversao de Moeda)

```
POST   /api/v1/swap
```
**Validacao Zod:** `swapSchema`
| Campo | Tipo | Validacao |
|---|---|---|
| `amount` | Number | `positive()` |
| `from_currency` | String | 3-5 chars |
| `to_currency` | String | 3-5 chars |

**Taxas FX hardcoded:**
- EUR → USDT: 1.08
- USDT → EUR: 0.92
- Fee: 1% do valor bruto

**Lancamentos no Ledger (5 entries):**
1. DEBIT wallet origem (moeda origem)
2. CREDIT fx_pool admin (moeda origem)
3. CREDIT wallet destino (moeda destino, liquido)
4. CREDIT fee wallet admin (moeda destino, fee)
5. DEBIT fx_pool admin (moeda destino, bruto)

---

#### Payout (Saques)

```
POST   /api/v1/payout
```
**Validacao Zod:** `payoutSchema`
| Campo | Tipo | Validacao |
|---|---|---|
| `amount` | Number | `positive()` |
| `currency` | String | 3-5 chars |
| `method` | String | enum: IBAN, CRYPTO, PIX, SEPA, BANK |
| `destination` | String | min 5 chars |

**Lancamentos no Ledger (2 entries):**
1. DEBIT wallet merchant (valor do saque)
2. CREDIT treasury wallet admin (valor do saque)

> Status inicial: `pending` — requer aprovacao manual via `/admin/payouts/:id/approve`

---

#### Users (Perfil)

```
GET    /api/v1/users/me          ← Perfil do utilizador autenticado
PATCH  /api/v1/users/me          ← Atualiza perfil (email, full_name, phone)
POST   /api/v1/users/me/password ← Altera password
```

---

#### API Keys

```
GET    /api/v1/api-keys          ← Lista chaves (sem hash, so prefix)
POST   /api/v1/api-keys          ← Cria nova chave (mostrada 1x)
DELETE /api/v1/api-keys/:id      ← Revoga chave
```

**Response POST:**
```json
{
  "id": "...",
  "name": "Key gerada a 2026-01-15",
  "raw_key": "nx_live_a1b2c3d4e5f6...",
  "message": "Guarde esta chave. Ela nao sera mostrada novamente."
}
```

---

#### Stores (Multi-Tenant SaaS)

```
GET    /api/v1/stores            ← Lista stores do merchant
POST   /api/v1/stores            ← Cria nova store/brand
PATCH  /api/v1/stores/:id        ← Atualiza store
```

| Campo | Tipo | Descricao |
|---|---|---|
| `name` | String | Nome da marca |
| `logo_url` | String? | URL do logo |
| `primary_color` | String | Cor primaria (default: #111111) |
| `accent_color` | String | Cor de destaque (default: #00FF41) |
| `webhook_url` | String? | URL de webhook da store |

---

#### Gateway Configuration

```
GET    /api/v1/settings/gateways       ← Lista gateways (api_key omitido)
POST   /api/v1/settings/gateways       ← Configura gateway (api_key criptografado AES-256)
```

| Campo | Tipo | Descricao |
|---|---|---|
| `provider_name` | String | stripe, sumup, mistic, viva, nowpayments |
| `api_key` | String | Chave API (criptografada com AES-256-CBC antes de guardar) |
| `merchant_id` | String? | ID do merchant no gateway |
| `is_active` | Boolean | Ativo/inativo |
| `store_id` | String? | Vincular a store especifica |

---

#### Payment Links

```
GET    /api/v1/payment-links    ← Lista links de pagamento
POST   /api/v1/payment-links    ← Cria novo link
```

| Campo | Tipo | Descricao |
|---|---|---|
| `amount` | Number | Valor fixo |
| `currency` | String | Moeda |
| `description` | String? | Descricao |
| `store_id` | String? | Vincular a store |

**Response POST:**
```json
{
  "paymentUrl": "https://pay.nexflowx.tech/a1b2c3d4e5f6"
}
```

---

#### Dashboard

```
GET    /api/v1/pipeline          ← Agregacao por status
GET    /api/v1/transactions      ← Lista paginada
```

**Query Params (transactions):**
| Param | Default | Descricao |
|---|---|---|
| `store_id` | — | Filtro por store |
| `limit` | 25 | Items por pagina |
| `page` | 1 | Numero da pagina |

**Response GET /pipeline:**
```json
{
  "pending": 1250.50,
  "gateway_confirmed": 3200.00,
  "settled": 18500.75,
  "failed": 150.00
}
```

---

#### Admin / Backoffice

```
GET    /api/v1/admin/users                    ← Lista todos os utilizadores
POST   /api/v1/admin/users/:id/force-password ← Reset de password
GET    /api/v1/admin/payouts/pending          ← Lista saques pendentes
POST   /api/v1/admin/payouts/:id/approve      ← Aprova saque
```

---

#### Webhooks (Publicos)

```
POST   /api/v1/webhooks/stripe       ← Webhook Stripe (raw body, sig verification)
POST   /api/v1/webhooks/sumup        ← Webhook SumUp
POST   /api/v1/webhooks/mistic       ← Webhook Mistic/PIX
POST   /api/v1/webhooks/nowpayments  ← Webhook NOWPayments (HMAC-SHA512)
```

**Seguranca por Provedor:**
| Provedor | Verificacao |
|---|---|
| Stripe | `stripe.webhooks.constructEvent()` — verificacao de assinatura |
| NOWPayments | HMAC-SHA512 via header `x-nowpayments-sig` |
| SumUp | Sem verificacao (TODO: production) |
| Mistic | Sem verificacao (TODO: production) |

---

#### Checkout Sessions (Publicos — Headless)

```
GET    /api/v1/checkout-session/:id              ← Dados do checkout + branding
PATCH  /api/v1/checkout-session/:id/customer     ← Atualiza dados do cliente
POST   /api/v1/checkout-session/:id/initiate     ← Inicia pagamento no gateway
```

**Response GET /checkout-session/:id:**
```json
{
  "id": "...",
  "amount": 99.99,
  "currency": "EUR",
  "merchant_name": "Minha Loja",
  "branding": {
    "logo_url": "https://...",
    "primary_color": "#1a1a2e",
    "accent_color": "#f0ebe3"
  },
  "allowed_methods": ["stripe", "sumup"]
}
```

---

## 6. Motor de Pagamentos

### PaymentOrchestrator

```
src/services/orchestrator.service.ts
```

Responsavel pelo roteamento inteligente de pagamentos para os provedores corretos.

#### Providers Registados

| Nome | Classe | Status |
|---|---|---|
| `mistic` | MockPixProvider | Mock (Phase 2) |
| `mercadopago` | MockPixProvider | Mock (Phase 2) |

> **Nota:** O orchestrator atual usa mocks. Os providers reais (MisticProvider, NowPaymentsProvider) estao implementados mas ainda nao ligados ao orchestrator (previsto para Phase 2 com carregamento dinamico de chaves da DB).

#### Fluxo de Roteamento no DepositController

```
requestDeposit()
  │
  ├─ Descoberta de Gateway (tenant-aware)
  │   ├─ store_id fornecido? → buscar por store
  │   └─ sem store_id → buscar por user_id (global)
  │
  ├─ Roteamento Inteligente (por moeda)
  │   ├─ BRL → Primario: mistic, Fallback: mercadopago
  │   ├─ EUR → Primario: stripe, Fallback: sumup
  │   └─ Outros → Primeiro gateway disponivel
  │
  ├─ Pre-registo de Transacao (idempotente)
  │   └─ txId = "dep_" + 12 chars hex
  │
  ├─ Chamada ao Provider
  │   ├─ mistic/mercadopago → QR_CODE (PIX)
  │   ├─ stripe/sumup/viva → HOSTED_CHECKOUT (URL)
  │   └─ internal_bank → BANK_TRANSFER (IBAN)
  │
  └─ Fallback Automatico
      ├─ Primario falha? → Tenta fallback
      └─ Ambos falham? → Transaction status = 'failed'
```

### Interface PaymentProvider

```typescript
interface PaymentProvider {
  createPayment(
    amount: number,
    currency: string,
    reference: string,
    metadata?: any
  ): Promise<any>;

  createPixPayment?(           // Opcional (so provedores PIX)
    amount: number,
    reference: string,
    customer: any
  ): Promise<any>;

  verifyPayment(
    transactionId: string
  ): Promise<boolean>;
}
```

---

## 7. Provedores de Pagamento

### MisticPay (PIX/BRL)

**Ficheiro:** `src/providers/mistic.provider.ts`

| Aspecto | Detalhe |
|---|---|
| **Base URL** | `https://api.misticpay.com/api` |
| **Autenticacao** | Headers `ci` (client ID) + `cs` (client secret) |
| **Operacoes** | PIX create, PIX verify |
| **Expiracao** | 3600 segundos |
| **Moeda** | BRL apenas |

**Endpoints Externos:**
- `POST /transactions/create` — Cria pagamento PIX
- `POST /transactions/check` — Verifica status do pagamento

**Response de Criacao PIX:**
```json
{
  "txid": "...",
  "qr_code": "00020126580014br.gov.bcb...",
  "qr_code_base64": "data:image/png;base64,...",
  "expires_in": 3600
}
```

---

### NOWPayments (Cripto)

**Ficheiro:** `src/providers/nowpayments.provider.ts`

| Aspecto | Detalhe |
|---|---|
| **Base URL** | `https://api.nowpayments.io/v1` |
| **Autenticacao** | `x-api-key` header + JWT (para payouts) |
| **Rede default** | USDT TRC20 |
| **Rede BEP20** | `metadata.network === 'BEP20'` |
| **IPN Callback** | HMAC-SHA512 verification |

**Endpoints Externos:**
- `POST /payment` — Cria pagamento cripto
- `POST /auth` — Obtem JWT para payouts
- `POST /payout` — Executa payout cripto

**Operacoes:**
| Operacao | Metodo | Descricao |
|---|---|---|
| Cash-In | `createPayment()` | Cria pagamento para rececao |
| Cash-Out | `createPayout()` | Executa saque para endereco crypto |

---

### Stripe (EUR)

**Ficheiro:** `src/providers/stripe.ts`

| Aspecto | Detalhe |
|---|---|
| **SDK** | `stripe` ^14.1.0 |
| **API Version** | `2023-10-16` |
| **Modos** | `hosted` (redirect) e `embedded` (in-page) |
| **Webhook** | `payment_intent.succeeded` |

**Endpoints (via SDK):**
- `stripe.checkout.sessions.create()` — Cria sessao de checkout

**Redirect URLs:**
- Success: `https://api.nexflowx.tech/success?tx={txId}`
- Cancel: `https://api.nexflowx.tech/cancel`

> **Nota:** Este provider nao implementa a interface `PaymentProvider` — e standalone

---

### Viva Wallets (EUR)

**Ficheiro:** `src/providers/viva.ts`

| Aspecto | Detalhe |
|---|---|
| **Demo URL** | `https://demo-api.vivapayments.com` |
| **Live URL** | `https://api.vivapayments.com` |
| **Autenticacao** | OAuth2 Client Credentials |
| **Modo** | Controlado por `VIVA_MODE` env var |

**Endpoints Externos:**
- `POST {accountsUrl}/connect/token` — OAuth2 token
- `POST {apiUrl}/checkout/v2/orders` — Cria ordem de checkout

> **Nota:** Tambem nao implementa a interface `PaymentProvider` — standalone

---

### SumUp (EUR/PT)

**Integracao:** Diretamente no `server.ts` e `deposit.controller.ts` (sem provider dedicado)

| Aspecto | Detalhe |
|---|---|
| **Base URL** | `https://api.sumup.com/v0.1` |
| **Autenticacao** | Bearer token (chave criptografada na DB) |
| **Operacao** | Criacao de checkout |
| **SDK Frontend** | `public/sumup-checkout.js` |

**Endpoint Externo:**
- `POST /checkouts` — Cria checkout com amount, currency, checkout_reference, merchant_code

---

### Tabela Comparativa de Provedores

| Provedor | Moedas | Metodos | Interface | Webhook Sig. |
|---|---|---|---|---|
| MisticPay | BRL | PIX | PaymentProvider | Nenhuma |
| NOWPayments | USD/USDT | Cripto (TRC20, BEP20) | PaymentProvider | HMAC-SHA512 |
| Stripe | EUR, USD, GBP | Cartao | Standalone | Stripe SDK |
| Viva Wallets | EUR | Cartao | Standalone | Nenhuma |
| SumUp | EUR | Cartao, MBWay | Integracao direta | Nenhuma |

---

## 8. Sistema de Ledger & Tesouraria

### Modelo de 3 Pools (Triple-Ledger)

```
Rececao de Pagamento
         │
         ▼
┌─────────────────┐     Cron Diario (meia-noite)
│ balance_incoming│ ──────────────────────────────►
│ (fundos do dia) │                              │
└─────────────────┘                              ▼
                                          ┌─────────────────┐
                                          │ balance_pending │     Cron Horario
                                          │ (em liquidacao) │ ──────────────────►
                                          └─────────────────┘                    │
                                                                                 ▼
                                                                    ┌──────────────────┐
                                                                    │balance_available │
                                                                    │ (disponivel)     │
                                                                    └──────────────────┘
```

### LedgerService (Partidas Dobradas)

**Ficheiro:** `src/services/ledger.service.ts`

#### Funcao `commitTransaction()`

Atomica via `prisma.$transaction`. Executa os seguintes passos:

1. **Validacao de Balanco:** Total de CREDITS deve igualar total de DEBITS por moeda (tolerancia: 0.00000001)
2. **Criacao do Registro:** `LedgerTransaction` + `LedgerEntry[]` (nested create)
3. **Atualizacao de Wallets:** Baseado em tipo e direcao

#### Matriz de Atualizacao de Saldo

| Tipo Wallet | Direcao | Status | balance_available |
|---|---|---|---|
| Liability (merchant/fee) | CREDIT | cleared | +amount |
| Liability (merchant/fee) | CREDIT | pending | sem alteracao |
| Liability (merchant/fee) | DEBIT | cleared | -amount |
| Liability (merchant/fee) | DEBIT | pending | -amount (bloqueado) |
| Asset (treasury/fx_pool) | DEBIT | cleared | +amount |
| Asset (treasury/fx_pool) | DEBIT | pending | sem alteracao |
| Asset (treasury/fx_pool) | CREDIT | cleared | -amount |
| Asset (treasury/fx_pool) | CREDIT | pending | -amount (bloqueado) |

> **Regra:** Asset wallets consideram DEBIT como entrada (dinheiro saindo da plataforma). Liability wallets (merchant) consideram CREDIT como entrada.

#### Tipos de Transacao no Ledger

| Tipo | Descricao | Status tipico |
|---|---|---|
| `PAYIN` | Entrada de fundos via deposito | `cleared` |
| `PAYOUT` | Saida de fundos via saque | `pending` |
| `SWAP` | Conversao entre moedas | `cleared` |
| `FEE` | Cobranca de taxa | `cleared` |

---

## 9. Motor de Liquidacao

**Ficheiro:** `src/services/settlement.service.ts`

### Processo 1: closeDailyIncoming()

```
Agendamento: 0 0 * * * (diario, meia-noite)
Timezone: America/Sao_Paulo
```

1. Encontra **todas** as wallets com `balance_incoming > 0`
2. Para cada wallet:
   - `balance_incoming → 0`
   - `balance_pending += antigo balance_incoming`
3. Atualiza transacoes: `gateway_confirmed → pending`

### Processo 2: clearMatureFunds()

```
Agendamento: 0 * * * * (cada hora, minuto 0)
Timezone: UTC (sistema)
```

1. Encontra transacoes com `status: 'pending'` e `clears_at <= now`
2. Para cada transacao madura:
   - Encontra wallet merchant por `user_id` + `currency_code`
   - `balance_pending -= net_amount`
   - `balance_available += net_amount`
   - `transaction.status → 'settled'`

### Maquina de Estados da Transacao

```
                    Webhook confirmado
pending ──────────────────────────────────► gateway_confirmed
                                                  │
                                          Cron diario (meia-noite)
                                                  │
                                                  ▼
                                              pending
                                                  │
                                    clears_at atingido (cron horario)
                                                  │
                                                  ▼
                                              settled


    Qualquer ponto ──────► failed (erro/fallback)
```

---

## 10. Autenticacao & Seguranca

### Fluxo de Autenticacao

```
Request
  │
  ├─ Header x-api-key presente?
  │   ├─ Sim → SHA-256 hash → buscar na DB
  │   │       ├─ Encontrado → req.user = { id, role }
  │   │       └─ Nao encontrado → 401 "API Key invalida"
  │   │
  │   └─ Nao → Verificar Authorization Bearer
  │            ├─ Presente → jwt.verify(token, JWT_SECRET)
  │            │             ├─ Valido → req.user = { id, role }
  │            │             └─ Invalido → 403 "Sessao expirada"
  │            └─ Ausente → 401 "Token em falta"
  │
  ▼
Route Handler (req.user disponivel)
```

### Criptografia AES-256-CBC

Usada para criptografar/decifrar chaves de API dos gateways armazenadas na DB.

**Formato armazenado:** `IV_HEX:ENCRYPTED_HEX`

**Chave:** `NEXFLOWX_MASTER_KEY` (32 bytes, padded/truncated de hex para 64 chars)

**Funcoes:**
- `encryptKey(text)` — em `gateway.controller.ts`
- `decryptKey(text)` — em `server.ts`

### Validacao de Input (Zod)

**Ficheiro:** `src/validators/transaction.validator.ts`

**Schemas definidos:**
- `swapSchema` — amount (positive), from_currency (3-5 chars), to_currency (3-5 chars)
- `payoutSchema` — amount (positive), currency (3-5 chars), method (enum: IBAN/CRYPTO/PIX/SEPA/BANK), destination (min 5 chars)

**Middleware:** `validate(schema)` — factory que retorna middleware Express

**Response de validacao:**
```json
{
  "error": "Dados invalidos no Payload",
  "details": [{ "campo": "amount", "mensagem": "..." }]
}
```

---

## 11. Cron Jobs & Processamento Agendado

**Ficheiro:** `src/cron/index.ts`

| Schedule | Tarefa | Timezone | Descricao |
|---|---|---|---|
| `0 0 * * *` | `SettlementService.closeDailyIncoming()` | America/Sao_Paulo | Transfere fundos incoming → pending |
| `0 * * * *` | `SettlementService.clearMatureFunds()` | UTC | Libera fundos pending → available |

Todos os cron jobs sao iniciados automaticamente pelo `server.ts` via `startCronJobs()`.

---

## 12. Infraestrutura & Deploy

### Docker

**Dockerfile:**
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/          # Copiado ANTES de npm install (crucial para prisma generate)
RUN npm install                # Executa postinstall: prisma generate
COPY . .
RUN npm run build              # Compila TypeScript
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

**docker-compose.yml:**
```yaml
services:
  api-dev-env:
    container_name: nexflowx-core-bank-dev
    build: .
    ports:
      - "8081:8080"
    env_file: .env
    restart: unless-stopped
```

| Aspecto | Detalhe |
|---|---|
| **Imagem base** | `node:20-slim` |
| **Porta container** | 8080 |
| **Porta host** | 8081 |
| **Dependencia sistema** | `openssl` (necessario para binario Prisma) |
| **Build otimizado** | package.json + prisma copiados primeiro (cache Docker) |
| **DB** | PostgreSQL externo (nao definido no compose) |

### CORS

**Origens permitidas (whitelist):**
- `https://central.nexflowx.tech`
- `https://atlas.nexflowx.tech`
- `http://localhost:3000`
- `http://localhost:3001`

> **Nota:** CORS esta atualmente em modo permissivo (aceita todas as origens) durante transicao

### OpenAPI Spec

**Ficheiro:** `openapi.yaml`
- **Versao OpenAPI:** 3.0.3
- **API Version:** 3.1.0
- **Titulo:** NeXFlowX Core Banking API

---

## 13. Scripts Operacionais

### Diretorio `/ops/` — Scripts de Operacao

Estes scripts sao ferramentas cirurgicas para gestao da base de dados e tesouraria.

| Script | Funcao | Perigo |
|---|---|---|
| `create_admin.js` | Cria utilizador admin master | Cria credenciais hardcoded |
| `create_client.js` | Provisiona client enterprise (Euro2026) | Cria credenciais hardcoded |
| `seed_dev.js` | Seed completo do ambiente dev (currencies, admin, merchant, gateways) | Requer execute |
| `seed_beta.js` | Seed destrutivo — limpa todas as tabelas e recria dados beta | **DESTRUTIVO** |
| `fix_treasury.js` | Cria wallets treasury ausentes (USDT, BRL) | Altera saldos |
| `fix_fx_pool.js` | Alinha saldos do FX pool ao ledger | Altera saldos |
| `fix_and_reconcile.js` | Hot-fix treasury + reconciliacao V2 | Corrige bug + audita |
| `reconcile.js` | Motor de reconciliacao independente (V1) | Leitura + relatorio |
| `simulate_paid.js` | Simula confirmacao de pagamento (CLI) | Altera status |
| `injetor_dev.js` | Injeta chave Stripe test (criptografada) | Altera gateway config |
| `injetor_dev_gateways.js` | Injeta configs Stripe + SumUp para beta | Altera gateway configs |
| `injetor_direto.js` | Injecao direta de API key + gateways | Cria credenciais |
| `injetar_chaves.js` | Injeta credenciais via API (HTTP) | Chamadas HTTP |
| `gerar_chave_direta.js` | Gera nova API key live (random) | Cria nova chave |
| `reset_test_pass.js` | Reset de password para testes | Altera password |
| `restaurar_credenciais.js` | Restaura gateway configs com placeholders | Sobrescreve configs |
| `sync_headless_api.js` | Patches server.ts para checkout headless | **Modifica codigo-fonte** |
| `update_merchant.js` | Atualiza merchant code SumUp | Altera gateway config |
| `update_schema.js` | Adiciona campo metadata ao schema | Modifica prisma schema |
| `update_server.js` | Patches server.ts para payment links | **Modifica codigo-fonte** |
| `seed_xdeals.js` | Seed do utilizador XDeals | Cria credenciais |
| `seed_tiers.ts` | Seed dos 5 tiers de precos | Cria/atualiza tiers |

### Diretorio `/scripts/` — Scripts de Patch

Estes scripts modificam ficheiros fonte no disco usando regex (search-and-replace). Sao ferramentas de conveniencia de desenvolvimento, nao migracoes producao.

| Script | Alvo | Funcao |
|---|---|---|
| `patch_routes.js` | api.routes.ts | Adiciona rotas wallet/ledger |
| `fix_routes.js` | api.routes.ts | Limpa imports duplicados, adiciona rotas V2 |
| `patch_admin_routes.js` | api.routes.ts | Injeta rotas admin backoffice |
| `patch_merchant_routes.js` | api.routes.ts | Injeta rotas store/gateway |
| `patch_server.js` | server.ts | Adiciona startCronJobs() |
| `patch_stripe_raw.js` | server.ts | Injeta raw body handler para Stripe webhook |
| `patch_cors.js` | server.ts | Substitui config CORS por whitelist |
| `patch_architecture.js` | schema.prisma | Adiciona Role enum, tier fields, TierConfig, MasterProvider |
| `patch_schema.js` | schema.prisma | Adiciona modelo PaymentLink |
| `patch_settlement.js` | schema.prisma | Substitui balance_total por balance_incoming/pending |

---

## 14. Fluxos de Dados

### Fluxo 1: Cash-In (Deposito)

```
Cliente                          API                             Gateway
  │                                │                                │
  │  POST /deposits                │                                │
  │ {amount, currency}             │                                │
  │───────────────────────────────►│                                │
  │                                │  1. Descobrir gateway           │
  │                                │  2. Pré-registar transacao      │
  │                                │  3. Criar pagamento             │
  │                                │───────────────────────────────►│
  │                                │                                │
  │                                │  QR Code / Checkout URL         │
  │                                │◄───────────────────────────────│
  │  {txId, qr_code, url}         │                                │
  │◄───────────────────────────────│                                │
  │                                │                                │
  │  Cliente faz pagamento         │                                │
  │────────────────────────────────────────────────────────────────►│
  │                                │                                │
  │                                │  Webhook (provider → API)       │
  │                                │◄───────────────────────────────│
  │                                │  4. processCashIn()             │
  │                                │  5. Transaction → confirmed     │
  │                                │  6. Wallet.balance_incoming +=   │
  │                                │                                │
  │                                │  ─ ─ ─ ─ ─ Cron Diario ─ ─ ─ ─ │
  │                                │  7. incoming → pending          │
  │                                │                                │
  │                                │  ─ ─ ─ ─ ─ Cron Horario ─ ─ ─ ─│
  │                                │  8. pending → available         │
```

### Fluxo 2: Swap (Conversao)

```
Utilizador
  │
  │  POST /swap {amount, from_currency, to_currency}
  │──────────────► API
  │                │
  │                │  1. Verificar saldo wallet origem
  │                │  2. Calcular taxa FX + fee (1%)
  │                │  3. LedgerService.commitTransaction()
  │                │     ├─ DEBIT wallet origem
  │                │     ├─ CREDIT fx_pool admin (origem)
  │                │     ├─ CREDIT wallet destino (liquido)
  │                │     ├─ CREDIT fee wallet admin
  │                │     └─ DEBIT fx_pool admin (destino)
  │                │
  │  {success, reference_id}
  │◄───────────────│
```

### Fluxo 3: Payout (Saque)

```
Merchant                         Admin/Backoffice
  │                                  │
  │  POST /payout                    │
  │  {amount, method, destination}   │
  │─────────────────► API            │
  │                    │             │
  │                    │  1. Verificar saldo disponivel
  │                    │  2. LedgerService.commitTransaction()
  │                    │     ├─ DEBIT wallet merchant
  │                    │     └─ CREDIT treasury admin
  │                    │  3. Criar Payout (status: pending)
  │                    │             │
  │  {payout_id}      │             │
  │◄───────────────────│             │
  │                    │             │
  │                    │  POST /admin/payouts/:id/approve
  │                    │◄────────────│
  │                    │  4. Payout → completed
  │                    │             │
  │                    │             │ Execucao bancaria/cripto
  │                    │             │ (manual ou automatizado)
```

---

## 15. Tabela de Enums & Configuracao

### Roles do Sistema

| Role | Nivel | Descricao |
|---|---|---|
| `admin` | Maximo | Acesso total, backoffice, aprovacao de payouts |
| `operator` | Alto | Operacoes limitadas |
| `viewer` | Medio | Leitura apenas |
| `merchant` | Normal | Recebe pagamentos, gerencia stores |
| `customer` | Basico | Cliente final |

### Status de Transacao

| Status | Significado |
|---|---|
| `pending` | Aguardando confirmacao do gateway ou em periodo de liquidacao |
| `gateway_confirmed` | Pagamento confirmado pelo provedor |
| `failed` | Pagamento falhou |
| `settled` | Fundos liquidados e disponiveis |

### Tipos de Wallet

| Tipo | Propriedade | Uso |
|---|---|---|
| `merchant` | Liability | Carteira principal do merchant |
| `fee` | Liability | Recebedor de taxas |
| `treasury` | Asset | Tesouraria da plataforma (payouts) |
| `fx_pool` | Asset | Pool de cambio da plataforma (swaps) |

### Metodos de Pagamento

| Metodo | Gateway | Moeda |
|---|---|---|
| Cartao | Stripe, SumUp, Viva | EUR |
| PIX | Mistic | BRL |
| MBWay | SumUp | EUR |
| Bancontact | Stripe | EUR |
| Cripto (TRC20) | NOWPayments | USD/USDT |
| Cripto (BEP20) | NOWPayments | USD/USDT |
| Transferencia Bancaria | Internal | EUR |

### Direcoes do Ledger

| Direcao | Liability (merchant) | Asset (treasury/fx_pool) |
|---|---|---|
| CREDIT | Entrada de fundos (+) | Saida de fundos (-) |
| DEBIT | Saida de fundos (-) | Entrada de fundos (+) |

---

## 16. Variaveis de Ambiente

### Obrigatorias

| Variavel | Descricao | Exemplo |
|---|---|---|
| `DATABASE_URL` | String de conexao PostgreSQL | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Chave secreta para JWT | `your-256-bit-secret` |

### Gateways

| Variavel | Gateway | Descricao |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe | Chave API secreta |
| `STRIPE_WEBHOOK_SECRET` | Stripe | Segredo webhook |
| `VIVA_CLIENT_ID` | Viva Wallets | Client ID OAuth2 |
| `VIVA_CLIENT_SECRET` | Viva Wallets | Client Secret OAuth2 |
| `VIVA_SOURCE_CODE` | Viva Wallets | Source Code merchant |
| `VIVA_MODE` | Viva Wallets | `demo` ou `live` |
| `NOWPAYMENTS_API_KEY` | NOWPayments | Chave API |
| `NOWPAYMENTS_EMAIL` | NOWPayments | Email para auth |
| `NOWPAYMENTS_PASSWORD` | NOWPayments | Password para auth |
| `NOWPAYMENTS_IPN_SECRET` | NOWPayments | Segredo HMAC para IPN |

### Seguranca

| Variavel | Descricao |
|---|---|
| `NEXFLOWX_MASTER_KEY` | Chave AES-256 (32 bytes) para criptografia de API keys |
| `SUPABASE_JWT_SECRET` | Segredo JWT Supabase (SSO) |

### Rollout

| Variavel | Descricao | Padrao |
|---|---|---|
| `KOOPFY_UNIFIED_PAYOUTS_ENABLED` | Libera `POST /integration/koopfy/finance/payouts` (saque pelo dash-checkout). Exige a migration `supabase/migrations/*_payout_request_idempotency.sql` aplicada: a rota chama somente `request_payout_idempotent` e nunca cai para `request_payout`. Precisa estar `true` tambem no backend checkout, que anuncia `capabilities.payoutCreate` ao dashboard. | desligada |

---

## 17. Estrutura de Diretorios

```
NeXFlowX-Fintech-Core/
├── prisma/
│   ├── schema.prisma              # Schema da base de dados (13+ modelos)
│   ├── seed_tiers.ts              # Seed dos 5 tiers de precos
│   └── migrations/                # Migrations Prisma
│       └── 20260406231040_.../
│           └── migration.sql
├── src/
│   ├── server.ts                  # Entry point Express (port 8080)
│   ├── routes/
│   │   └── api.routes.ts          # Router central (28 endpoints)
│   ├── controllers/               # 11 controllers
│   │   ├── admin.controller.ts    # Backoffice (users, payouts)
│   │   ├── apikey.controller.ts   # API key CRUD
│   │   ├── dashboard.controller.ts# Pipeline + transacoes paginadas
│   │   ├── deposit.controller.ts  # Core deposit flow (smart routing)
│   │   ├── gateway.controller.ts  # Gateway config (AES-256 encrypt)
│   │   ├── payment-link.controller.ts # Payment links
│   │   ├── store.controller.ts    # Multi-tenant stores
│   │   ├── transaction.controller.ts # Swap + Payout
│   │   ├── user.controller.ts     # Profile management
│   │   ├── wallet.controller.ts   # Wallet queries
│   │   └── webhook.controller.ts  # Provider webhooks (processCashIn)
│   ├── services/                  # 3 services
│   │   ├── ledger.service.ts      # Double-entry ledger (5-entry matrix)
│   │   ├── orchestrator.service.ts# Payment routing (mock providers)
│   │   └── settlement.service.ts  # 3-stage settlement engine
│   ├── providers/                 # 4 payment providers
│   │   ├── mistic.provider.ts     # MisticPay (PIX/BRL)
│   │   ├── nowpayments.provider.ts# NOWPayments (Cripto)
│   │   ├── stripe.ts              # Stripe (EUR)
│   │   └── viva.ts                # Viva Wallets (EUR)
│   ├── middleware/                # 2 middleware
│   │   ├── auth.middleware.ts     # JWT + API Key dual auth
│   │   └── validate.middleware.ts # Zod schema validation
│   ├── interfaces/
│   │   └── payment-provider.interface.ts # PaymentProvider interface
│   ├── validators/
│   │   └── transaction.validator.ts # swapSchema + payoutSchema
│   └── cron/
│       └── index.ts               # Scheduled jobs (2 tasks)
├── ops/                           # 22 operational scripts
├── scripts/                       # 10 code-patch scripts
├── public/
│   └── sumup-checkout.js          # SumUp SDK loader
├── openapi.yaml                   # OpenAPI 3.0.3 spec
├── Dockerfile                     # Docker build config
├── docker-compose.yml             # Orchestration config
├── tsconfig.json                  # TypeScript config
├── package.json                   # Dependencies (v2.4.1)
└── .gitignore                     # VCS exclusions
```

---

## 18. Observacoes & Recomendacoes

### Pontos Fortes da Arquitetura

1. **Ledger de partidas dobradas** — Modelo contabil robusto com validacao de balanco
2. **3-stage settlement** — Modelo realista para fintech (incoming → pending → available)
3. **Multi-tenant SaaS** — Isolacao adequada de stores e gateway configs
4. **Smart routing com fallback** — Resiliencia na selecao de provedores
5. **Criptografia AES-256** — Chaves de gateway protegidas em repouso
6. **Tiered pricing** — Sistema flexivel de precos com 5 niveis e overrides
7. **Interface PaymentProvider** — Abstracao extensivel para novos provedores

### Areas para Melhoria

| Area | Estado | Recomendacao |
|---|---|---|
| **RBAC** | Sem middleware de roles | Implementar role-check em middleware antes de rotas admin |
| **Validacao** | Apenas swap/payout com Zod | Adicionar schemas Zod para deposits, stores, gateways, payment-links |
| **Rate Limiting** | Ausente | Implementar `express-rate-limit` em todos os endpoints |
| **Webhook Security** | SumUp/Mistic sem verificacao | Implementar HMAC ou verificacao de assinatura |
| **Testes** | Nenhum framework | Adicionar Jest/Vitest com testes unitarios e integracao |
| **Migracoes** | Patch scripts com regex | Usar apenas `prisma migrate` para evolucao do schema |
| **FX Rates** | Hardcoded EUR/USDT | Integrar API de taxas em tempo real |
| **Logging** | Console.log basico | Implementar logger estruturado (Winston/Pino) |
| **CORS** | Modo permissivo | Restringir ao whitelist definido |
| **API Keys em ops** | Credenciais hardcoded | Usar apenas variaveis de ambiente |

---

> **Documento gerado automaticamente como Dossier Tecnico completo da plataforma AtlasGlobalPayments Core Banking Engine v2.4.1**
>
> Este documento cobre a totalidade da infraestrutura, API REST, modelo de dados, sistema de ledger, provedores de pagamento, motor de liquidacao e scripts operacionais.
