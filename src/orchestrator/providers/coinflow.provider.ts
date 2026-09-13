import { ChargeResponse } from './provider.types';

// ============================================================================
// COINFLOW — https://docs.coinflow.cash   (base sandbox: api-sandbox.coinflow.cash)
// ----------------------------------------------------------------------------
// Modelo confirmado empiricamente com a chave sandbox:
//
//   • Auth do MERCHANT:  header  Authorization: <api_key>   (SEM "Bearer")
//   • Auth do usuário:   header  x-coinflow-auth-user-id: <id>   (fluxo fiat)
//   • Session key:       GET  /api/auth/session-key  → { key: <JWT> }
//   • Cobrança recorrente (card on file): POST /api/checkout/card-on-file
//
// PRIMEIRA compra de cartão: é dirigida pelo SDK CLIENT da Coinflow
// (CoinflowPurchase / Card Form), que gerencia a sessão/wallet + tokeniza o
// cartão (PCI) e dispara a cobrança. O endpoint server-to-server de cartão novo
// (/api/checkout/card/token) exige x-coinflow-auth-wallet (contexto que o SDK
// administra). Por isso, no fluxo de cartão NOVO o nosso `charge` apenas:
//   1. minta a session key (server),
//   2. devolve status 'requires_action' + a config p/ o front montar o SDK.
// O status final de settlement chega por WEBHOOK (webhookInfo.reference = txId).
//
// Cobrança com cartão já salvo (token/originalPaymentId) é feita server-side
// direto no card-on-file.
//
// Credenciais/host vêm de provider-accounts.config.ts → env COINFLOW_*.
// ============================================================================

export class CoinflowProvider {
    name = 'coinflow';

    async charge(ctx: any): Promise<ChargeResponse> {
        const { customer, transactionId, providerConfig, payment_data } = ctx;
        const { id, api_url, apiKey, mid } = providerConfig ?? {};

        // Apple/Google Pay (Coinflow): o BOTÃO já cobrou no client e devolveu o
        // paymentId. Aqui só REGISTRAMOS (sem novo charge) → aprovado síncrono.
        const walletPaymentId = payment_data?.coinflowPaymentId ?? null;
        if (walletPaymentId) {
            return {
                success: true,
                status: 'approved',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: walletPaymentId,
                providerStatus: 'wallet_paid',
                data: { paymentId: walletPaymentId },
            };
        }

        if (!api_url || !apiKey) {
            return this.failure(id, transactionId, 'config', 'Coinflow: api_url/apiKey ausentes (COINFLOW_API_URL / COINFLOW_API_KEY)');
        }
        if (!mid) {
            return this.failure(id, transactionId, 'config', 'Coinflow: merchantId ausente (COINFLOW_MERCHANT_ID)');
        }

        const authUserId = customer?.id ?? customer?.email ?? ctx?.metadata?.user_id ?? transactionId;
        const cardToken = payment_data?.coinflowToken ?? payment_data?.token ?? null;
        const originalPaymentId = payment_data?.originalPaymentId ?? null;

        // Cartão salvo (cobrança recorrente): card-on-file por originalPaymentId.
        if (originalPaymentId) {
            return this.chargeCardOnFile(ctx, String(authUserId));
        }
        // Cartão NOVO: token do CardForm → POST /api/checkout/card/{merchantId}
        // com a session key (JWT) no header x-coinflow-auth-session-key.
        if (cardToken) {
            return this.chargeNewCard(ctx, String(authUserId), cardToken);
        }
        return this.failure(id, transactionId, 'missing_token', 'Coinflow: token do cartão ausente — tokenize no client (CardForm).');
    }

    // POST /api/checkout/card/{merchantId} — cartão novo (cardToken do CardForm).
    // Auth: x-coinflow-auth-session-key = JWT mintada em /api/auth/session-key.
    private async chargeNewCard(ctx: any, authUserId: string, cardToken: string): Promise<ChargeResponse> {
        const { amount, currency, customer, transactionId, providerConfig, metadata, payment_data, billing_address } = ctx;
        const { id, api_url, apiKey, mid } = providerConfig;

        const sessionKey = await this.mintSessionKey(api_url, apiKey, authUserId);
        if (!sessionKey) {
            return this.failure(id, transactionId, 'auth', 'Coinflow: falha ao gerar session key');
        }

        const fullName = String(customer?.name ?? '').trim();
        const parts = fullName.split(/\s+/).filter(Boolean);
        const firstName = (parts[0] && parts[0].length >= 2) ? parts[0] : (fullName || 'Customer');
        const lastName = parts.slice(1).join(' ') || firstName;
        const addr = billing_address ?? {};
        // Headers de proteção (x-device-id, x-session-id, x-coinflow-referrer) do
        // script da Chargeback Protection no client.
        const protectionHeaders = payment_data?.coinflowProtectionHeaders ?? null;

        const body: Record<string, any> = {
            subtotal: { cents: Math.round(Number(amount)), currency: currency ?? 'USD' },
            card: {
                cardToken,
                // expYear precisa ter 2 dígitos (a API rejeita 4).
                ...(payment_data?.expMonth ? { expMonth: String(payment_data.expMonth) } : {}),
                ...(payment_data?.expYear ? { expYear: String(payment_data.expYear).slice(-2) } : {}),
                email: customer?.email,
                firstName,
                lastName,
                ...(addr.address ?? addr.address1 ? { address1: addr.address ?? addr.address1 } : {}),
                ...(addr.city ? { city: addr.city } : {}),
                ...(addr.state ? { state: addr.state } : {}),
                ...(addr.zipcode ?? addr.zip ? { zip: addr.zipcode ?? addr.zip } : {}),
                country: addr.country ?? customer?.country ?? undefined,
            },
            // Chargeback Protection da Coinflow (obrigatório quando ativado no
            // merchant). Representamos o pedido como 1 item; pra produção dá pra
            // mapear as linhas reais do carrinho (mais preciso na cobertura).
            chargebackProtectionAccountType: 'guest',
            chargebackProtectionData: [{
                itemClass: 'giftCard',
                productType: 'giftCard',
                id: String(metadata?.order_number ?? transactionId),
                quantity: 1,
                itemFulfillment: 'physical',
                sellingPrice: {
                    valueInCurrency: Math.round(Number(amount)) / 100,
                    currency: currency ?? 'USD',
                },
                rawProductData: { order_number: metadata?.order_number ?? null },
            }],
            webhookInfo: { reference: transactionId, order_number: metadata?.order_number ?? null },
        };

        // Remove valores nulos/vazios dos headers de proteção — senão um
        // device-id/session-id null sobrescreveria o fallback (e o fetch mandaria
        // a string "null").
        const cleanProtection: Record<string, string> = protectionHeaders && typeof protectionHeaders === 'object'
            ? Object.fromEntries(
                Object.entries(protectionHeaders).filter(([, v]) => v != null && v !== '') as [string, string][],
              )
            : {};

        const reqHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-coinflow-auth-session-key': sessionKey,
            // Headers de proteção (device/session fingerprint) gerados pelo
            // script da Chargeback Protection no client. SEM eles a CBP
            // recusa (code 999). Fallback: device-id estável p/ não quebrar.
            'x-device-id': String(transactionId),
            ...cleanProtection,
            ...(customer?.ip ? { 'x-coinflow-client-ip': String(customer.ip) } : {}),
        };

        // 🐞 Diagnóstico CBP: mostra se os headers de proteção REAIS chegaram.
        console.log('[CoinflowProvider] protection headers:', {
            received: protectionHeaders ?? null,
            sent_device_id: reqHeaders['x-device-id'],
            sent_session_id: reqHeaders['x-session-id'] ?? null,
            sent_referrer: reqHeaders['x-coinflow-referrer'] ?? null,
        });

        try {
            const res = await fetch(`${api_url}/api/checkout/card/${mid}`, {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify(body),
            });

            const json: any = await res.json().catch(() => ({}));

            if (res.status === 412) {
                return {
                    success: true,
                    status: 'requires_action',
                    provider: this.name,
                    accountId: id,
                    transactionId,
                    providerTransactionId: json?.transactionId ?? null,
                    providerStatus: '3ds_required',
                    next_action: { type: '3ds', url: json?.url, creq: json?.creq, transactionId: json?.transactionId },
                    data: json,
                };
            }

            if (!res.ok || !json?.paymentId) {
                console.error('[CoinflowProvider] card HTTP', res.status, '→', JSON.stringify(json), '| sent card keys:', Object.keys(body.card ?? {}));
                // A razão REAL da Coinflow costuma vir em `details` (a `message` é um
                // wrapper genérico "Error Processing your request").
                const detail = typeof json?.details === 'string' ? json.details : null;
                return this.failure(
                    id, transactionId,
                    json?.reason ?? json?.code ?? `http_${res.status}`,
                    detail ?? json?.message ?? json?.error ?? `Coinflow card HTTP ${res.status}`,
                    json,
                );
            }

            // paymentId criado; settlement final chega por webhook → pending.
            return {
                success: true,
                status: 'pending',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: json.paymentId,
                providerStatus: 'created',
                data: json,
            };
        } catch (err: any) {
            console.error('[CoinflowProvider] new-card error:', err?.message);
            return this.failure(id, transactionId, 'provider_error', err?.message ?? 'erro desconhecido');
        }
    }

    // GET /api/auth/session-key — Authorization: <key> + x-coinflow-auth-user-id.
    private async mintSessionKey(apiUrl: string, apiKey: string, userId: string): Promise<string | null> {
        try {
            const res = await fetch(`${apiUrl}/api/auth/session-key`, {
                method: 'GET',
                headers: {
                    'Authorization': apiKey,
                    'x-coinflow-auth-user-id': userId,
                },
            });
            const json: any = await res.json().catch(() => ({}));
            if (!res.ok) {
                console.error('[CoinflowProvider] session-key error:', res.status, json?.message);
                return null;
            }
            return json?.key ?? null;
        } catch (err: any) {
            console.error('[CoinflowProvider] session-key fetch error:', err?.message);
            return null;
        }
    }

    // POST /api/checkout/card-on-file — cobrança server-side de cartão salvo.
    private async chargeCardOnFile(ctx: any, authUserId: string): Promise<ChargeResponse> {
        const { amount, currency, customer, transactionId, providerConfig, metadata, payment_data } = ctx;
        const { id, api_url, apiKey } = providerConfig;

        const originalPaymentId = payment_data?.originalPaymentId ?? null;
        const token = payment_data?.coinflowToken ?? payment_data?.token ?? null;

        const body: Record<string, any> = {
            subtotal: { cents: Math.round(Number(amount)), currency: currency ?? 'USD' },
            ...(originalPaymentId ? { originalPaymentId } : { token }),
            customerInfo: { email: customer?.email, name: customer?.name },
            webhookInfo: { reference: transactionId, order_number: metadata?.order_number ?? null },
            ...(payment_data?.authentication3DS ? { authentication3DS: payment_data.authentication3DS } : {}),
        };

        try {
            const res = await fetch(`${api_url}/api/checkout/card-on-file`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': apiKey,
                    'x-coinflow-auth-user-id': authUserId,
                    ...(customer?.ip ? { 'x-coinflow-client-ip': String(customer.ip) } : {}),
                },
                body: JSON.stringify(body),
            });

            const json: any = await res.json().catch(() => ({}));

            // 3DS challenge → cliente completa a autenticação no SDK.
            if (res.status === 412) {
                return {
                    success: true,
                    status: 'requires_action',
                    provider: this.name,
                    accountId: id,
                    transactionId,
                    providerTransactionId: json?.transactionId ?? null,
                    providerStatus: '3ds_required',
                    next_action: { type: '3ds', url: json?.url, creq: json?.creq, transactionId: json?.transactionId },
                    data: json,
                };
            }

            if (!res.ok || !json?.paymentId) {
                return this.failure(
                    id, transactionId,
                    json?.reason ?? json?.code ?? `http_${res.status}`,
                    json?.message ?? json?.error ?? `Coinflow card-on-file HTTP ${res.status}`,
                    json,
                );
            }

            // paymentId criado; settlement final chega por webhook → pending.
            return {
                success: true,
                status: 'pending',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: json.paymentId,
                providerStatus: json?.status ?? 'created',
                data: json,
            };
        } catch (err: any) {
            console.error('[CoinflowProvider] card-on-file error:', err?.message);
            return this.failure(id, transactionId, 'provider_error', err?.message ?? 'erro desconhecido');
        }
    }

    private failure(
        accountId: string,
        transactionId: string,
        code: string,
        message: string,
        data?: any,
    ): ChargeResponse {
        return {
            success: false,
            status: 'failed',
            provider: this.name,
            accountId,
            transactionId,
            providerStatus: 'failed',
            failureCode: code,
            failureMessage: message,
            message,
            data,
        };
    }
}
