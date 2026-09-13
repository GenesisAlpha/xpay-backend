import { ChargeResponse } from './provider.types';

// ============================================================================
// SENTINEL GATE
// ----------------------------------------------------------------------------
// - Cartão:        POST /v1/hosted/create   (página hosted + redirect)
// - MB Way:        POST /v1/hosted/create   (página hosted + redirect)
// - Apple/Google:  POST /v1/wallets/decrypt (body com payment_token)
//
// Cartão e MB Way usam o fluxo HOSTED: criamos a sessão, devolvemos o
// redirect_url e o cliente confirma na página da Sentinel. O status final
// (captured/failed) chega por webhook (handleSentinelWebhook).
//
// Auth (hosted): header X-API-Key (+ X-API-Secret no cartão). As credenciais
// vêm do MID do seller (providerConfig) ou, na ausência, do env default.
// MB Way usa uma chave própria (mbwayApiKey / env SENTINEL_MBWAY_API_KEY).
// ============================================================================

export class SetinelGateProvider {
    name = 'setinel_gate';

    async charge(ctx: any): Promise<ChargeResponse> {
        // hosted_method roteia SÓ a página hosted (Apple/Google Pay + cartão do
        // painel unificado) — ctx.method continua 'card' pro registro/KPI, então a
        // venda é gravada como cartão mesmo escolhendo a carteira pra abrir a página.
        const method = String(ctx?.hosted_method ?? ctx?.method ?? 'card').toLowerCase();

        if (method === 'apple_pay' || method === 'google_pay') {
            return this.chargeWallet(ctx, method);
        }
        if (method === 'mbway') {
            return this.chargeMbway(ctx);
        }
        return this.chargeCard(ctx);
    }

    // ─── Cartão (hosted) ──────────────────────────────────────────────────────
    // POST /v1/hosted/create com payment_method: 'card'. Auth com X-API-Key +
    // X-API-Secret do MID. Devolve redirect_url → o cliente preenche o cartão na
    // página hosted da Sentinel. Status final chega por webhook.
    private async chargeCard(ctx: any): Promise<ChargeResponse> {
        const { transactionId, providerConfig } = ctx;
        const { id, api_url, apiKey, apiSecret } = providerConfig;

        if (!api_url || !apiKey || !apiSecret) {
            return this.failure(id, transactionId, 'config', 'Sentinel Gate: credenciais de cartão ausentes (api_url/apiKey/apiSecret)');
        }

        return this.postHosted({
            ctx,
            apiKey,
            apiSecret,
            extraBody: { payment_method: 'card' },
            label: 'card',
        });
    }

    // ─── MB Way (hosted) ──────────────────────────────────────────────────────
    // POST /v1/hosted/create com mb_way_payment: true. Auth só com X-API-Key
    // (chave própria do MB Way). Cliente confirma no app MB Way.
    private async chargeMbway(ctx: any): Promise<ChargeResponse> {
        const { transactionId, providerConfig } = ctx;
        const { id, api_url, apiKey, mbwayApiKey } = providerConfig;

        // MB Way tem chave própria; cai pra apiKey de cartão só por segurança.
        const key = mbwayApiKey ?? apiKey;
        if (!api_url || !key) {
            return this.failure(id, transactionId, 'config', 'Sentinel Gate: credenciais MB Way ausentes (api_url/SENTINEL_MBWAY_API_KEY)');
        }

        // Diagnóstico: mostra QUAL chave o MB Way está usando. Se cair no fallback de
        // cartão (usingDedicated=false), a conta de cartão não tem MB Way habilitado
        // → a página hosted mostra "No available payment provider".
        console.log('[SetinelGateProvider] mbway key →', {
            usingDedicated: !!mbwayApiKey,
            keyPrefix: String(key).slice(0, 12),
            api_url,
        });

        return this.postHosted({
            ctx,
            apiKey: key,
            // MB Way na Sentinel é acionado pelo flag `mb_way_payment: true` — NÃO
            // por payment_method (a API rejeita `payment_method:'mbway'` com
            // "Invalid payment_method provided"). Provider/disponibilidade dependem
            // da chave (mbwayApiKey) e do provisionamento do MID na STR Bank.
            extraBody: { mb_way_payment: true },
            label: 'mbway',
        });
    }

    // ─── Hosted helper ────────────────────────────────────────────────────────
    // Cria a sessão hosted (cartão ou MB Way) e mapeia o redirect_url.
    //   • order_id  = order_number (humano, exibido ao cliente). Webhook associa
    //                 primário por sentinel_transaction_id; order_id é só fallback.
    //   • return_url usa metadata.order_number (humano)
    //   • status final (captured/failed) chega por webhook → 'requires_action'
    private async postHosted(args: {
        ctx: any;
        apiKey: string;
        apiSecret?: string;
        extraBody: Record<string, any>;
        label: string;
    }): Promise<ChargeResponse> {
        const { ctx, apiKey, apiSecret, extraBody, label } = args;
        const { amount, currency, customer, transactionId, providerConfig, metadata } = ctx;
        const { id, api_url, config } = providerConfig;

        const orderNumber = metadata?.order_number ?? metadata?.orderId ?? transactionId;
        const checkoutBase = process.env.CHECKOUT_PUBLIC_URL ?? 'https://checkout.koopfy.com';
        // Callback PÚBLICO que o Sentinel chama de volta (captured/failed). Tem que
        // bater na rota do PAY: nginx roteia /pay/ -> pay:3007 e o controller é
        // @Controller('webhooks') + @Post('sentinel'). Logo: /pay/webhooks/sentinel.
        // (o default antigo '/webhook/sentinel' caía no checkout -> 404 -> webhook perdido)
        const callbackUrl = process.env.SENTINEL_CALLBACK_URL
            ?? config?.callback_url
            ?? 'https://api.koopfy.com/pay/webhooks/sentinel';

        const body: Record<string, any> = {
            amount: (Number(amount) / 100).toFixed(2),   // string em unidade maior, ex: "50.00"
            currency: currency ?? 'EUR',
            // order_id é o que a Sentinel EXIBE pro cliente na página hosted → usamos
            // o número do pedido (numérico, bonito), não o UUID interno. A associação
            // do webhook é primária por sentinel_transaction_id (provider_transaction_id);
            // o order_id/external_reference é só fallback.
            order_id: orderNumber,
            description: metadata?.description ?? `Order ${orderNumber}`,
            callback_url: callbackUrl,
            // return_url do seller (MB Way por API) tem prioridade; senão, página
            // de resultado padrão do checkout Koopfy.
            return_url: metadata?.return_url ?? `${checkoutBase}/payment-result?orderId=${orderNumber}`,
            // cancel_url (usado pelo hosted de wallet quando o cliente cancela).
            cancel_url: metadata?.cancel_url ?? `${checkoutBase}/payment-result?orderId=${orderNumber}&status=cancelled`,
            // email tb no formato curto (o hosted de wallet do STR Bank usa `email`).
            ...(customer?.email ? { customer_email: customer.email, email: customer.email } : {}),
            ...extraBody,
        };

        const headers: Record<string, string> = {
            'X-API-Key': apiKey,
            'Content-Type': 'application/json',
        };
        if (apiSecret) headers['X-API-Secret'] = apiSecret;

        try {
            const res = await fetch(`${api_url}/hosted/create`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            const json: any = await res.json().catch(() => ({}));

            if (!res.ok) {
                return this.failure(
                    id, transactionId,
                    json?.decline_code ?? json?.code ?? `http_${res.status}`,
                    json?.message ?? json?.error ?? `Sentinel Gate ${label} HTTP ${res.status}`,
                    json,
                );
            }

            const redirectUrl: string | undefined = json?.redirect_url ?? json?.hosted_url;
            // Wallet hosted devolve `session_id`; cartão devolve sentinel_transaction_id.
            const providerTxnId: string | undefined =
                json?.sentinel_transaction_id ?? json?.transaction_id ?? json?.session_id;

            if (!redirectUrl) {
                return this.failure(id, transactionId, 'invalid_response', `Sentinel Gate ${label}: redirect_url ausente`, json);
            }

            // Cliente precisa ser redirecionado pra página hosted → requires_action.
            return {
                success: true,
                status: 'requires_action',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: providerTxnId,
                providerStatus: json?.status ?? 'pending',
                redirectUrl,
                checkout_url: redirectUrl,
                data: json,
            };
        } catch (err: any) {
            console.error(`[SetinelGateProvider] charge (${label}) error:`, err?.message);
            return this.failure(id, transactionId, 'provider_error', err?.message ?? 'erro desconhecido');
        }
    }

    // ─── Apple Pay / Google Pay (HOSTED via STR Bank) ─────────────────────────
    // POST /hosted/create com payment_method google_pay/apple_pay → hosted_url.
    // O cliente paga na página hosted (botão da carteira quando o device/wallet é
    // elegível; senão o fallback de cartão da própria página). Status final
    // (captured/failed) chega por webhook → 'requires_action' (mesmo do cartão).
    private async chargeWallet(ctx: any, method: string): Promise<ChargeResponse> {
        const { transactionId, providerConfig } = ctx;
        const { id, api_url } = providerConfig;

        // Apple/Google Pay usam uma CONTA SEPARADA da de cartão (KOPY PayG) —
        // credenciais próprias (SENTINEL_WALLET_*). Fallback pras de cartão só se
        // as de wallet não estiverem configuradas.
        const apiKey = process.env.SENTINEL_WALLET_API_KEY || providerConfig.apiKey;
        const apiSecret = process.env.SENTINEL_WALLET_API_SECRET || providerConfig.apiSecret;

        if (!api_url || !apiKey || !apiSecret) {
            return this.failure(id, transactionId, 'config', 'Sentinel Gate: credenciais de wallet ausentes (SENTINEL_WALLET_API_KEY / SENTINEL_WALLET_API_SECRET)');
        }

        return this.postHosted({
            ctx,
            apiKey,
            apiSecret,
            extraBody: { payment_method: method }, // 'google_pay' | 'apple_pay'
            label: method,
        });
    }

    private failure(
        accountId: string,
        transactionId: string,
        code: string,
        message: string,
        data?: any,
        providerStatus?: string,
        providerTxnId?: string,
    ): ChargeResponse {
        return {
            success: false,
            status: 'failed',
            provider: this.name,
            accountId,
            transactionId,
            providerTransactionId: providerTxnId,
            providerStatus: providerStatus ?? 'failed',
            failureCode: code,
            failureMessage: message,
            message,
            data,
        };
    }
}
