import { ChargeResponse } from './provider.types';

// ⚠️ ACHADO CRÍTICO: a Rox Pay TRUNCA `Metadata.custom_css` em 2000
// caracteres, SEM avisar (a API aceita o request normalmente, StatusCode 200,
// e simplesmente corta a string no meio — confirmado inspecionando o DOM real
// com Playwright: o <style id="embedded-checkout-custom-css"> injetado tinha
// exatos 2000 chars, cortado no meio de um comentário). Isso NÃO é Shadow DOM
// (também descartado pelo mesmo teste — os campos são <input> normais no
// document principal) — é só o texto sendo cortado antes de chegar nas regras
// de verdade. Por isso: ZERO comentários dentro da string abaixo (cada byte
// conta) e seletores agrupados via `[id^="embedded-checkout-"]` em vez de
// listar os 6 IDs em cada regra. Qualquer edição aqui precisa continuar < 2000
// chars — depois de editar, rodar `.trim().length` e conferir.
//
// Tokens de cor/medida (borda #e5e7eb, 48px altura, radius 8px, texto
// #111827, placeholder #9ca3af, primária #006fee) vieram da página "standard"
// real da Rox Pay (inspecionada em produção) — o embedded não tem esse visual
// nativo (nem com CSS completo enviado; era mesmo truncamento).
//
// LABELS E PLACEHOLDER. O markup deles é
//   <div data-embedded-checkout="field-cardNumber">
//     <label for=…>Card number</label><input data-embedded-checkout="cardNumber" …>
//
// Tentamos label flutuante (HeroUI) e NÃO serve aqui: com o campo vazio o label
// fica centralizado DENTRO da caixa, então o comprador lê "Card number" no
// lugar dos dígitos. Agora o label é sempre pequeno em cima (padrão Stripe/
// Adyen) e o campo mostra "4321 4321 4321 4321" enquanto vazio.
//
// ⚠️ PSEUDO-ELEMENTO PRECISA DE z-index. O input tem fundo BRANCO OPACO e é
// pintado por cima do ::before/::after do container — sem `z-index:2` o
// fantasma dos dígitos e o ícone simplesmente não aparecem (foi o bug do
// placeholder invisível). E com z-index eles passam a interceptar clique, daí
// o `pointer-events:none` obrigatório junto.
//
// PLACEHOLDERS: usar os NATIVOS deles, não zerar todos. O do expirationDate é
// literalmente "MM/YY" (lido do bundle) — informação de formato que o comprador
// precisa. Zerar tudo pra esconder o do cardNumber (que só repetia "Card
// number") custou esse "MM/YY" junto. Agora só o cardNumber é transparente, e
// os demais aparecem em #9ca3af. O `:placeholder-shown` continua valendo como
// detector de "campo vazio" mesmo com a cor transparente.
//
// NOME/SOBRENOME: escondidos só QUANDO JÁ VÊM PREENCHIDOS, via
// `:has(input:not(:placeholder-shown))`. Escondê-los sempre quebraria o
// checkout quando o nome não viesse do nosso lado — campo obrigatório
// invisível, comprador sem entender por que o submit não passa. Como
// mandamos shopper_first_name/shopper_last_name no Metadata, na prática eles
// somem; se um dia não vier nome, reaparecem sozinhos.
//
// ALTURA: quem define é o `inlineHeight` do PaymentPopup (não tem postMessage
// de resize da Rox). Mexer nas medidas aqui — altura do input, padding-top do
// campo, gap — muda a altura do conteúdo e pede remedir aquele valor.
//
// Tamanho atual: 1969 chars — 31 de folga. MEDIR de novo a cada edição.
// O que já foi sacrificado por espaço, em ordem de recuperação: `:hover` na
// borda dos inputs, `font-weight` do label, `border-radius` do ícone, e o
// ícone com dois gradientes (hoje é gradiente do chip sobre cor sólida).
//
// Estrutura real do form-fields (confirmada via Playwright, filhos diretos):
// section-card-payment ("Pay with card"), field-holderName, field-holderSurname,
// field-cardNumber, field-expirationDate, field-cvc, field-email, field-saveCard,
// submit-section > button[data-embedded-checkout="submit-primary"] ("Continue").
// Pares lado a lado (holderName+holderSurname, expirationDate+cvc): TODOS os
// field-* são 50% e só o cardNumber volta pra 100% — sai mais barato que listar
// os quatro. CUIDADO com a especificidade: `[attr]` sozinho (0,1,0) PERDE pra
// `[data-embedded-checkout=form-fields]>div` (0,1,1) mesmo com !important e
// mesmo vindo depois — daí o prefixo `div` nas duas regras de flex. Foi
// exatamente essa a regressão que juntou os campos numa coluna só.
// Botão: texto trocado via truque CSS (font-size:0 esconde "Continue" + ::after
// com o texto novo) já que não existe campo pra customizar o label do botão.
//
// Margem lateral: form-fields fica dentro de vários wrappers da Rox (shell +
// painel com padding próprio, ~41px de margem lateral acumulada) sem um
// seletor estável pra mirar neles direto. Em vez de arriscar um seletor
// frágil (classe Tailwind tipo "md:py-5"), usamos margin negativa NO PRÓPRIO
// form-fields (seletor que já controlamos) pra "escapar" do padding dos
// ancestrais — testado ao vivo, sem clipping (nenhum ancestral usa
// overflow:hidden apertado o bastante pra cortar).
//
// Header/logo da Rox: o hide via CSS está aqui como camada extra —
// `header.fixed-top` (a classe real, confirmada no HTML deles; o seletor por
// `style*="linear-gradient"` que existia junto era redundante e saiu pelo
// orçamento de chars) + zerar o `pt-[70px]` do wrapper, que compensava a altura
// do header fixo. Ele SOZINHO não é confiável — chegamos a testar até 10s de atraso na
// revelação do frontend com o iframe escondido (display:none) esperando
// esse CSS aplicar, e o flash continuava aparecendo. Suspeita: display:none/
// opacity:0 no NOSSO wrapper pausa o bootstrap JS DELES enquanto escondido,
// então esse custom_css só termina de aplicar LOGO DEPOIS que a gente
// revela — e é exatamente essa transição (header aparece → some) que vira o
// "flash". Também testamos crop físico (cortar 70px fixos do iframe) — HAVIA
// tirado a header, mas truncava conteúdo real quando o layout deles mudava.
// Solução final: o iframe SEMPRE roda em opacity:1 (nunca pausado) e o
// frontend cobre com um overlay opaco À PARTE por um teto fixo curto
// (PaymentPopup `opaqueCoverMs`) — o bootstrap deles roda em velocidade
// normal por baixo, sem depender de quando o CSS abaixo aplica. Esse CSS
// continua aqui só como reforço (não faz mal se funcionar; se não funcionar,
// o overlay já resolve sozinho).
const ROX_PAY_EMBEDDED_CSS = `
header.fixed-top{display:none!important}
div[class*="pt-[70px]"]{padding-top:0!important}
[data-checkout-shell]{background:#fff!important;padding:0!important}
[data-embedded-checkout=form-fields]{margin:0 -25px!important;padding:12px 14px!important;display:flex;flex-wrap:wrap;gap:10px}
[data-embedded-checkout=form-fields]>div{flex:1 1 100%!important}
div[data-embedded-checkout^=field-]{position:relative;padding-top:20px!important;flex:1 1 calc(50% - 5px)!important}
div[data-embedded-checkout=field-cardNumber]{flex:1 1 100%!important}
div[data-embedded-checkout^=field-holder]:has(input:not(:placeholder-shown)),[data-embedded-checkout=field-saveCard],div:has(>input[type=search]){display:none!important}
[id^=embedded-checkout-]{width:100%!important;box-sizing:border-box;height:46px!important;padding:0 12px!important;border:1.5px solid #e5e7eb!important;border-radius:8px!important;background:#fff!important;font-size:15px!important;color:#111827!important}
[id^=embedded-checkout-]:focus{outline:none!important;border-color:#006fee!important}
[id^=embedded-checkout-]::placeholder{color:#9ca3af}
#embedded-checkout-cardNumber::placeholder{color:transparent}
[data-embedded-checkout^=field-]>label{position:absolute;left:0;top:0;line-height:14px;font-size:12px;color:#6b7280}
[data-embedded-checkout=field-cardNumber]:has(input:placeholder-shown)::before{content:"4321 4321 4321 4321";position:absolute;left:13px;top:20px;line-height:46px;font-size:15px;color:#9ca3af;pointer-events:none;z-index:2}
#embedded-checkout-cardNumber{padding-right:52px!important}
[data-embedded-checkout=field-cardNumber]::after{content:"";position:absolute;right:12px;top:32px;width:32px;height:21px;background:linear-gradient(#f7cf6b,#e0a338) no-repeat 5px 6px/9px 7px,#1f1f1f;pointer-events:none;z-index:2}
[data-embedded-checkout=submit-primary]{background:#16a34a!important;border:0;font-size:0!important}
[data-embedded-checkout=submit-primary]::after{content:"Pay now";font-size:16px!important}
`.trim();

// Códigos de método da Rox Pay — os de verdade são de 3 letras e vêm de
// GET /api/v4/payments/available-payment-methods (por company). Enviar
// 'ideal'/'card' em PaymentMethods dá 422 "not available for this company":
// não é falta de habilitação, é vocabulário errado.
//
// COMO O IFRAME DECIDE O QUE MOSTRAR (lido do bundle deles, não da doc):
// o PaymentMethods vira `transaction_metadata.accepted_cards`, e cada método
// tem um gate próprio. O do iDEAL, por exemplo:
//     provider.id === 5 && currency === 'EUR' && country === 'NL'
//     && (accepted_cards ausente → ok; presente → só se contiver 'INT')
// Consequência prática: RESTRINGIR esconde. Mandar só os códigos de cartão
// deixaria iDEAL/Bancontact/wallets de fora do iframe.
//
// Por isso só restringimos quando o comprador escolheu um APM específico no
// NOSSO checkout — aí o link vira *_only e abre direto no formulário daquele
// método, sem ele escolher duas vezes. Cartão (e wallets, que moram DENTRO do
// formulário de cartão) não restringe nada: o iframe mostra tudo que a
// company tem ativo para aquele país/moeda.
// Idioma do checkout hospedado. A Rox aceita `Lang` no payments/link e a lista
// é FECHADA — o próprio erro 422 entrega quais são:
//     it, en, fr, de, es, ru, tr, pl, ro, cz, hu, il
// Holandês e português NÃO estão nela. Comprador da Holanda, então, vê o
// checkout em inglês; o belga vê em francês, que é a língua co-oficial de lá
// coberta pela lista. Fora do mapa cai em 'en' (default da Rox quando o campo
// é omitido — o path do link vira /payments/<lang>/...).
const ROX_PAY_LANG_BY_COUNTRY: Record<string, string> = {
    IT: 'it', FR: 'fr', BE: 'fr', LU: 'fr', CH: 'de', DE: 'de', AT: 'de',
    ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es',
    RU: 'ru', TR: 'tr', PL: 'pl', RO: 'ro', CZ: 'cz', HU: 'hu', IL: 'il',
};

const ROX_PAY_METHOD_CODES: Record<string, string[]> = {
    ideal: ['INT'],        // iDEAL | Wero — EUR, NL
    bancontact: ['BON'],   // Bancontact — EUR, BE
    pay_by_bank: ['BANK'], // EUR/GBP
    // SEPA fica de fora de propósito: o link vira SEPA-only e exige
    // DebtorIban/DebtorName, que o nosso checkout não coleta.
    // card/credit_card/apple_pay/google_pay: ausentes DE PROPÓSITO — ver acima.
};

// ============================================================================
// ROX PAY (API v4) — checkout hospedado via Payment Link.
// Docs: https://app.roxpay.eu/api/v4/docs/
//
// Auth: POST /api/v4/auth/token com {Username, Password} (= providerConfig
// apiKey/apiSecret) -> BearerToken válido 12h. Cacheado aqui por conta.
//
// Charge: POST /api/v4/payments/link -> devolve PaymentUrl (hosted, tipo
// "standard") + TransactionId. Mandamos nosso `transactionId` interno como
// `TransactionId` — a Rox dedup por esse campo, então retry é idempotente.
//
// Moedas aceitas pela Rox Pay: EUR, USD, GBP, CHF, CAD, RON, JPY (mesma
// allowlist já travada em payments.service.ts, ANTES desta chamada). JPY é
// zero-decimal na Rox (Amount em unidade MAIOR); as demais em centavos —
// nosso `amount` interno é sempre centavos, então convertemos só na saída.
//
// Status final chega por webhook (POST /webhook/rox-pay). A Rox NÃO assina
// os deliveries — autentica por header custom configurado 1x no cadastro do
// webhook (POST /api/v4/webhooks/create). Ver getTransactionStatus(), usado
// pelo WebhookService pra buscar o status AUTORITATIVO em vez de confiar no
// corpo (enxuto) do evento.
// ============================================================================

export class RoxPayProvider {
    name = 'rox_pay';

    private static tokenCache = new Map<string, { token: string; expiresAt: number }>();
    private static methodsCache = new Map<string, { codes: Set<string>; expiresAt: number }>();

    /**
     * Códigos ATIVOS na company. Usado só para INTERSECTAR com o que queremos
     * mandar: enviar um código inativo derruba o link inteiro com 422, e aí o
     * comprador não paga de jeito nenhum. Falha na consulta → null, e o caller
     * omite PaymentMethods (comportamento anterior: iframe com tudo).
     */
    private async availableMethodCodes(providerConfig: any, token: string): Promise<Set<string> | null> {
        const { id, api_url } = providerConfig;

        const cached = RoxPayProvider.methodsCache.get(id);
        if (cached && cached.expiresAt > Date.now()) return cached.codes;

        try {
            const res = await fetch(`${api_url}/api/v4/payments/available-payment-methods`, {
                headers: { 'Authorization': `Bearer ${token}` },
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok || !Array.isArray(json?.PaymentMethods)) return null;

            const codes = new Set<string>(
                json.PaymentMethods.map((m: any) => String(m?.Code ?? '')).filter(Boolean),
            );
            RoxPayProvider.methodsCache.set(id, { codes, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
            return codes;
        } catch {
            return null;
        }
    }

    private async getToken(providerConfig: any): Promise<string> {
        const { id, api_url, apiKey: username, apiSecret: password, config } = providerConfig;

        const cached = RoxPayProvider.tokenCache.get(id);
        if (cached && cached.expiresAt > Date.now()) return cached.token;

        const res = await fetch(`${api_url}/api/v4/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Username: username,
                Password: password,
                ...(config?.company_id ? { CompanyId: config.company_id } : {}),
            }),
        });

        const json: any = await res.json().catch(() => ({}));
        if (!res.ok || !json?.BearerToken) {
            throw new Error(json?.Message ?? `Rox Pay auth HTTP ${res.status}`);
        }

        // Token dura 12h — cacheia com folga de 30min pra evitar expirar no meio de um request.
        RoxPayProvider.tokenCache.set(id, {
            token: json.BearerToken,
            expiresAt: Date.now() + 11.5 * 60 * 60 * 1000,
        });
        return json.BearerToken;
    }

    async charge(ctx: any): Promise<ChargeResponse> {
        // Cartão cru decifrado (config.rox_pay_card_flow = 'native', ver
        // buildProviderPublicConfig no pay) → tokeniza/autoriza/captura direto,
        // sem iframe. Ausente → segue o fluxo hosted de sempre (payments/link).
        if (ctx?.payment_data?.cardNumber) {
            return this.chargeNative(ctx);
        }
        return this.chargeEmbedded(ctx);
    }

    private async chargeEmbedded(ctx: any): Promise<ChargeResponse> {
        const { amount, currency, transactionId, providerConfig, metadata, customer, method } = ctx;
        const { id, api_url, apiKey, apiSecret, storeReference } = providerConfig;

        if (!api_url || !apiKey || !apiSecret) {
            return this.failure(id, transactionId, 'Rox Pay: api_url/apiKey/apiSecret (Username/Password) ausentes');
        }

        try {
            // 🐞 DEBUG TEMPORÁRIO — timing (remover depois).
            const __t0 = Date.now();
            const token = await this.getToken(providerConfig);
            console.log(`[timing][rox-pay] getToken: ${Date.now() - __t0}ms`);

            const cur = String(currency ?? 'EUR').toUpperCase();
            // JPY é zero-decimal na Rox Pay — as demais moedas da allowlist usam centavos.
            const roxAmount = cur === 'JPY'
                ? Math.round(Number(amount) / 100)
                : Math.round(Number(amount));

            const orderRef = metadata?.order_number ?? metadata?.orderId ?? transactionId;
            const checkoutBase = process.env.CHECKOUT_PUBLIC_URL ?? 'https://checkout.koopfy.com';

            // Rox Pay: TransactionId tem limite de 30 chars E precisa ser ÚNICO por
            // CHAMADA — reenviar o mesmo valor não faz dedupe (diferente do
            // /payments/authorize): dá 400 "already exists". Nem orderRef (order_number,
            // estável por sessão) nem transactionId (nosso id interno — a idempotência
            // do createPayment REAPROVEITA a mesma linha de `transactions` em retries
            // com a mesma idempotencyKey, então também se repete) servem sozinhos como
            // sufixo. Usamos timestamp — único a cada invocação de charge(), mesmo
            // reaproveitando a mesma transação interna.
            const uniqueSuffix = Date.now().toString(36);
            const roxTransactionId = `${String(orderRef).slice(0, 20)}-${uniqueSuffix}`.slice(0, 30);

            // Nome/email já coletados no NOSSO checkout — pré-popula e some com o
            // campo de email (HideEmailInput) pra não pedir de novo pro cliente.
            // Não existe "hide" pra nome documentado; só pré-popula (reduz fricção).
            const fullName = String(customer?.name ?? '').trim();
            const [shopperFirstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
            const shopperLastName = rest.join(' ') || undefined;

            // País do comprador. O gate de iDEAL/Bancontact do iframe lê
            // `Metadata.country_code` e, na AUSÊNCIA dele, assume "NL" —
            // ou seja: sem isso um comprador belga não veria Bancontact.
            const countryCode = String(
                ctx?.billing_address?.country ?? customer?.country ?? '',
            ).trim().toUpperCase().slice(0, 2);

            // Recorte de métodos: só para APM escolhido explicitamente no nosso
            // checkout (vira *_only e abre direto naquele formulário). Cartão e
            // wallets não restringem — restringir ESCONDE os outros métodos.
            // Código inativo na company → omite (nunca derruba o link).
            const wanted = ROX_PAY_METHOD_CODES[String(method ?? '').toLowerCase()];
            let paymentMethodCodes: string[] = [];
            if (wanted?.length) {
                const available = await this.availableMethodCodes(providerConfig, token);
                paymentMethodCodes = available
                    ? wanted.filter(c => available.has(c))
                    : [];
            }

            const res = await fetch(`${api_url}/api/v4/payments/link`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    TransactionId: roxTransactionId,
                    Amount: roxAmount,
                    Currency: cur,
                    Purpose: metadata?.description ?? `Order ${orderRef}`,
                    // "Quando omitido, a página mostra um header genérico" (doc) — passar
                    // Title troca esse header genérico pelo nosso. Não documentado se
                    // remove a barra inteira; custom_css abaixo tenta esconder o resto.
                    Title: metadata?.description ?? `Order ${orderRef}`,
                    // Default da Rox Pay é false (só pré-autoriza, exige capture manual
                    // depois via /payments/capture) — sem isso a transação nunca sai de
                    // "Authorized" pra "Settled"/"Success" e nunca vira pagamento de verdade.
                    AutoCapture: true,
                    // Store cadastrada manualmente no painel da Rox Pay, por seller
                    // (config.rox_pay_store_reference). Omitida → cai na store default
                    // da company (ou nenhuma associação, se não houver default).
                    ...(storeReference ? { StoreReference: storeReference } : {}),
                    ...(paymentMethodCodes.length ? { PaymentMethods: paymentMethodCodes } : {}),
                    ...(ROX_PAY_LANG_BY_COUNTRY[countryCode]
                        ? { Lang: ROX_PAY_LANG_BY_COUNTRY[countryCode] }
                        : {}),
                    // "embedded" é o modo ATIVO por padrão (estilização + Apple Pay
                    // funcionando lá, testado). "standard" TAMBÉM tem a mesma barra de
                    // header (confirmado ao vivo — não resolve o flash) e perde o
                    // custom_css, mas fica disponível via env var só pra ISOLAR um teste
                    // de Apple Pay por lá (a doc documenta o handshake especificamente
                    // pro embedded — vale confirmar se no standard funciona "de graça",
                    // sem handshake nenhum, já que ali é a própria página deles sem nada
                    // nosso no meio). NÃO mexer no default aqui — só setar
                    // ROX_PAY_CHECKOUT_TYPE=standard no .env temporariamente pra esse
                    // teste específico, e tirar depois.
                    Type: (process.env.ROX_PAY_CHECKOUT_TYPE === 'standard' ? 'standard' : 'embedded'),
                    // shopper_* pré-popula nome/email com o que já temos. custom_css só
                    // faz sentido (e só é aceito) no embedded — omitido em standard.
                    Metadata: {
                        ...(process.env.ROX_PAY_CHECKOUT_TYPE !== 'standard' ? { custom_css: ROX_PAY_EMBEDDED_CSS } : {}),
                        ...(countryCode ? { country_code: countryCode } : {}),
                        ...(customer?.email ? { shopper_email: customer.email } : {}),
                        ...(shopperFirstName ? { shopper_first_name: shopperFirstName } : {}),
                        ...(shopperLastName ? { shopper_last_name: shopperLastName } : {}),
                    },
                    // Já temos o email do checkout — não precisa pedir de novo.
                    ...(customer?.email ? { HideEmailInput: true } : {}),
                    SuccessRedirectUrl: metadata?.return_url
                        ?? `${checkoutBase}/payment-result?orderId=${orderRef}&status=success`,
                    FailureRedirectUrl: metadata?.failure_url
                        ?? `${checkoutBase}/payment-result?orderId=${orderRef}&status=failed`,
                    CancelRedirectUrl: metadata?.cancel_url
                        ?? `${checkoutBase}/payment-result?orderId=${orderRef}&status=cancelled`,
                }),
            });
            console.log(`[timing][rox-pay] payments/link fetch: ${Date.now() - __t0}ms`);

            const json: any = await res.json().catch(() => ({}));

            if (!res.ok || json?.Result === false) {
                return this.failure(id, transactionId, json?.Message ?? `Rox Pay HTTP ${res.status}`, json);
            }
            if (!json?.PaymentUrl) {
                return this.failure(id, transactionId, 'Rox Pay: PaymentUrl ausente na resposta', json);
            }

            return {
                success: true,
                status: 'requires_action',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: json.TransactionId ?? roxTransactionId,
                providerStatus: 'pending',
                redirectUrl: json.PaymentUrl,
                checkout_url: json.PaymentUrl,
                data: json,
            };
        } catch (err: any) {
            console.error('[RoxPayProvider] charge error:', err?.message);
            return this.failure(id, transactionId, err?.message ?? 'erro desconhecido');
        }
    }

    // ============================================================================
    // MODO NATIVO — campos de cartão próprios (sem iframe). Opt-in por seller
    // (config.rox_pay_card_flow = 'native'). EXPERIMENTAL — ver notas no plano:
    // escopo PCI mais pesado (cartão cru passa pelo nosso backend antes de
    // tokenizar) e SEM 3DS/SCA (authorize/capture não expõem challenge/redirect;
    // a doc da Rox só documenta esse fluxo pra cobrança MIT, cliente ausente).
    //
    // 3 chamadas síncronas: tokeniza (POST /wallet/cards) → autoriza (POST
    // /payments/authorize) → captura (POST /payments/capture) → confirma o
    // resultado real via GET /transactions/{id} (authorize/capture só devolvem
    // Result:boolean — não é suficiente pra saber se aprovou de verdade).
    // Resultado é SÍNCRONO (approved/failed direto) — cai no mesmo pipeline de
    // aprovação imediata que o provider 'simulator' já usa.
    // ============================================================================
    private async chargeNative(ctx: any): Promise<ChargeResponse> {
        const { amount, currency, transactionId, providerConfig, metadata, customer, payment_data } = ctx;
        const { id, api_url, apiKey, apiSecret } = providerConfig;

        if (!api_url || !apiKey || !apiSecret) {
            return this.failure(id, transactionId, 'Rox Pay: api_url/apiKey/apiSecret (Username/Password) ausentes');
        }

        try {
            const token = await this.getToken(providerConfig);

            const cur = String(currency ?? 'EUR').toUpperCase();
            const roxAmount = cur === 'JPY'
                ? Math.round(Number(amount) / 100)
                : Math.round(Number(amount));

            const orderRef = metadata?.order_number ?? metadata?.orderId ?? transactionId;
            const uniqueSuffix = Date.now().toString(36);
            const roxTransactionId = `${String(orderRef).slice(0, 20)}-${uniqueSuffix}`.slice(0, 30);

            // ── 1. Tokeniza ────────────────────────────────────────────────────
            const tokenizeRes = await fetch(`${api_url}/api/v4/wallet/cards`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    // dto.payment_data não carrega holderName (resolvePaymentInstrument
                    // não mapeia esse campo do envelope) — usa o nome do checkout.
                    CardHolderName: customer?.name || 'N/A',
                    CardNumber: String(payment_data.cardNumber).replace(/\s/g, ''),
                    ...(payment_data.cvv ? { Cvv: String(payment_data.cvv) } : {}),
                    ExpirationMonth: parseInt(payment_data.expMonth, 10),
                    ExpirationYear: parseInt(payment_data.expYear, 10),
                    OwnerReference: transactionId,
                }),
            });
            const tokenizeJson: any = await tokenizeRes.json().catch(() => ({}));
            if (!tokenizeRes.ok || tokenizeJson?.Result === false || !tokenizeJson?.CardAuthToken) {
                return this.failure(id, transactionId, tokenizeJson?.Message ?? `Rox Pay tokenize HTTP ${tokenizeRes.status}`, tokenizeJson);
            }
            const cardAuthToken = tokenizeJson.CardAuthToken;

            // ── 2. Autoriza ─────────────────────────────────────────────────────
            const authRes = await fetch(`${api_url}/api/v4/payments/authorize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    Items: [{
                        Amount: roxAmount,
                        CardAuthToken: cardAuthToken,
                        Currency: cur,
                        ...(customer?.email ? { Email: customer.email } : {}),
                        Purpose: metadata?.description ?? `Order ${orderRef}`,
                        Title: metadata?.description ?? `Order ${orderRef}`,
                        TransactionId: roxTransactionId,
                    }],
                }),
            });
            const authJson: any = await authRes.json().catch(() => ({}));
            const authItem = authJson?.Results?.[0];
            if (!authRes.ok || authItem?.Result === false) {
                return this.failure(id, transactionId, authItem?.Message ?? authJson?.Message ?? `Rox Pay authorize HTTP ${authRes.status}`, authJson);
            }

            // ── 3. Captura ──────────────────────────────────────────────────────
            const captureRes = await fetch(`${api_url}/api/v4/payments/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ Items: [{ TransactionId: roxTransactionId }] }),
            });
            const captureJson: any = await captureRes.json().catch(() => ({}));
            const captureItem = captureJson?.Results?.[0];
            if (!captureRes.ok || captureItem?.Result === false) {
                // Authorize teve sucesso mas capture não — cartão fica só pré-autorizado
                // (fundos retidos, não cobrados). Não tenta reverter automaticamente
                // (POST /payments/release) — loga alto pra reconciliação manual.
                console.error(`[RoxPayProvider] chargeNative: capture falhou após authorize OK — pré-autorização presa: ${roxTransactionId}`, captureJson);
                return this.failure(id, transactionId, captureItem?.Message ?? captureJson?.Message ?? `Rox Pay capture HTTP ${captureRes.status}`, captureJson);
            }

            // ── 4. Confirma resultado real ───────────────────────────────────────
            // authorize/capture só devolvem Result:boolean — não é o status real da
            // transação. Reconsulta pra saber se realmente aprovou (Settled/Success).
            const { statusDescription, raw } = await this.getTransactionStatus(roxTransactionId, providerConfig);
            const approved = ['settled', 'success'].includes(String(statusDescription ?? '').toLowerCase());

            if (!approved) {
                return this.failure(id, transactionId, `Rox Pay: status final "${statusDescription ?? 'desconhecido'}" não indica aprovação`, raw);
            }

            return {
                success: true,
                status: 'approved',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: roxTransactionId,
                providerStatus: statusDescription ?? 'approved',
                data: raw,
            };
        } catch (err: any) {
            console.error('[RoxPayProvider] chargeNative error:', err?.message);
            return this.failure(id, transactionId, err?.message ?? 'erro desconhecido');
        }
    }

    // Usado pelo WebhookService: busca o status autoritativo (GET /transactions/{id})
    // porque a Rox não assina os webhooks e o corpo do evento é enxuto.
    async getTransactionStatus(
        transactionId: string,
        providerConfig: any,
    ): Promise<{ statusDescription: string | null; raw: any }> {
        const token = await this.getToken(providerConfig);

        const res = await fetch(
            `${providerConfig.api_url}/api/v4/transactions/${encodeURIComponent(transactionId)}`,
            { headers: { 'Authorization': `Bearer ${token}` } },
        );

        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.Message ?? `Rox Pay retrieve HTTP ${res.status}`);

        return { statusDescription: json?.Status?.Description ?? null, raw: json };
    }

    private failure(accountId: string, transactionId: string, message: string, data?: any): ChargeResponse {
        return {
            success: false,
            status: 'failed',
            provider: this.name,
            accountId,
            transactionId,
            message,
            data,
        };
    }
}
