import { supabase } from '../../lib/supabase.client';
import { ChargeResponse } from './sibs.provider';

const NEXFLOW_PROXY_KEY = process.env.NEXFLOW_APIKEY
    ?? (() => { throw new Error('NEXFLOW_PROXY_KEY env var is required') })()

export class StripeProvider {
    name = 'stripe';

    async charge(ctx: any): Promise<ChargeResponse> {

        const {
            sellerId,
            amount,
            currency,
            method,
            customer,
            paymentData,
            context,
            returnUrl,
            transactionId,
            providerConfig
        } = ctx;

        const { api_url, id } = providerConfig;

        const customerId = await this.getOrCreateCustomer({
            api_url,
            sellerId,
            providerId: ctx.providerConfig.id,
            email: customer.email,
            name: customer.name,
            phone: customer?.phone || 'N/A',
            metadata: {
                ip: context?.ip,
                user_agent: context?.userAgent,
            },
        });

        const paymentMethodTypes = this.getPaymentMethodTypes(method);

        const isWallet = ['apple_pay', 'google_pay', 'link'].includes(method);

        let intent: any = {
            amount,
            currency,
            payment_method_types: paymentMethodTypes,
            capture_method: 'automatic',
            confirmation_method: 'automatic',
            metadata: {
                email: customer.email,
                phone: customer?.phone || 'N/A',
                cart_value: amount, // em centavos
                ip_address: context?.ip || 'unknown',
                user_agent: context?.userAgent || 'unknown',
                order_id: transactionId ?? context?.orderId,
            },
        };

        if (customerId) {
            intent.customer = customerId;
        }

        // 🔥 opcional: anexar payment_method (caso específico)
        if (paymentData?.payment_method) {
            intent.payment_method = paymentData.payment_method;
            intent.confirm = true;
            intent.return_url = returnUrl;

            // Habilita 3DS automaticamente quando o emissor exigir
            intent.payment_method_options = {
                ...intent.payment_method_options,
                card: {
                    request_three_d_secure: 'automatic',
                },
            };
        }

        // Antes do paymentIntents.create, garante o PaymentMethod pra multibanco
        if (method === 'multibanco' && !paymentData?.payment_method) {
            intent.payment_method_data = {
                type: 'multibanco',
                billing_details: {
                    email: customer.email,
                    name: customer.name,
                },
            }

            intent.confirm = true;
        }

        // 🔥 opcional: idioma para métodos específicos (mantido se quiser)
        if (paymentMethodTypes?.includes('bancontact')) {
            intent.payment_method_options = {
                bancontact: {
                    preferred_language: 'nl',
                },
            };
        }

        if (isWallet) {
            intent = {
                amount,
                currency,
            };
        }

        console.log(intent)

        // ── Chama proxy nexflowx ────────────────────────────────────────────
        const url = `${api_url.replace(/\/$/, '')}/payment_intents`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-proxy-key': NEXFLOW_PROXY_KEY,
                },
                body: JSON.stringify(intent),
            })

            const json = await res.json()

            console.log(json)

            if (!res.ok || !json?.client_secret) {
                return this.failure(id, transactionId,
                    json?.error?.message ?? json?.message ?? 'Stripe Crypto proxy did not return client_secret',
                    json,
                )
            }

            return {
                ...this.normalizeResponse(json, method),
                provider: 'stripe',
                accountId: ctx.providerConfig.id,
            }
        } catch (err: any) {
            console.error('[StripeProvider] charge error:', err?.message)
            return this.failure(id, transactionId, err?.message ?? 'Stripe proxy network error')
        }

    }

    // normaliza resposta (PADRÃO DO SISTEMA)
    private normalizeResponse(res: any, method: string) {
        switch (res.status) {
            case 'succeeded':
                return {
                    success: true,
                    status: 'approved',
                    transactionId: res.id

                };

            case 'processing':
                return {
                    success: true,
                    status: 'processing',
                    transactionId: res.id,
                };

            case 'requires_action':
            case 'requires_payment_method':
            case 'requires_confirmation':
                return this.handleNextAction(res, method);

            default:
                return {
                    success: false,
                    status: 'failed',
                    transactionId: res.id,
                };
        }
    }

    private handleNextAction(res: any, method: string) {

        if (res.next_action && res.next_action.type === 'redirect_to_url') {
            return {
                success: true,
                status: 'pending',
                redirectUrl: res.next_action.redirect_to_url?.url,
                transactionId: res.id,
                next_action: res.next_action
            };
        }

        if (method === 'multibanco') {
            return {
                success: true,
                status: 'pending',
                next_action: res.next_action,
                transactionId: res.id,
            };
        }

        // 3DS / wallet
        return {
            success: true,
            status: 'requires_action',
            clientSecret: res.client_secret,
            transactionId: res.id,
            next_action: res?.next_action
        };
    }

    private getPaymentMethodTypes(method: string): string[] {
        const map: Record<string, string[]> = {
            card: ['card'],
            apple_pay: ['card'],
            google_pay: ['card'],
            link: ['link', 'card'],
            amazon_pay: ['amazon_pay'],
            paypal: ['paypal'],
            klarna: ['klarna'],
            ideal: ['ideal'],
            bancontact: ['bancontact'],
            multibanco: ['multibanco'],
            eps: ['eps'],
            p24: ['p24'],
            blik: ['blik'],
            twint: ['twint'],
            swish: ['swish'],
            mbway: ['mb_way'],
            revolut_pay: ['revolut_pay'],
            bizum: ['bizum'],
        };
        return map[method] ?? ['card'];
    }


    async getOrCreateCustomer({
        api_url,
        sellerId,
        providerId,
        email,
        name,
        phone,
        metadata,
    }: {
        api_url: string;
        sellerId: string;
        providerId: string;
        email: string;
        name: string;
        phone?: string;
        metadata?: Record<string, string>;
    }): Promise<string | null> {

        try {
            // 1) Cache local — evita chamada ao proxy se já existe
            const { data } = await supabase
                .from('customers')
                .select('provider_customer_id')
                .eq('provider_account_id', providerId)
                .eq('email', email)
                .maybeSingle();

            if (data?.provider_customer_id) {
                return data.provider_customer_id;
            }

            // 2) Cria via proxy — Stripe espera form-urlencoded
            const body = new URLSearchParams();
            body.append('email', email);
            body.append('name', name);
            if (phone) body.append('phone', phone);

            body.append('metadata[seller_id]', sellerId);
            body.append('metadata[provider_id]', providerId);
            for (const [k, v] of Object.entries(metadata ?? {})) {
                if (v != null) body.append(`metadata[${k}]`, String(v));
            }

            const url = `${api_url.replace(/\/$/, '')}/customers`;

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });

            const customer = await res.json().catch(() => ({}));

            if (!res.ok || !customer?.id) {
                console.error(
                    `[getOrCreateCustomer] Proxy failed (status ${res.status}): ` +
                    `${customer?.error?.message ?? 'unknown error'} — ` +
                    `email=${email} provider=${providerId}`
                );
                return null;
            }

            // 3) Upsert no cache — falha aqui também não derruba o fluxo
            const { error: upsertErr } = await supabase
                .from('customers')
                .upsert(
                    {
                        seller_id: sellerId,
                        provider_account_id: providerId,
                        email,
                        name,
                        phone: phone ?? null,
                        provider_customer_id: customer.id,
                    },
                    { onConflict: 'provider_account_id,email' },
                );

            if (upsertErr) {
                console.error(
                    `[getOrCreateCustomer] Customer ${customer.id} created on Stripe ` +
                    `but failed to cache: ${upsertErr.message}`
                );
                // Customer existe na Stripe — retorna mesmo sem cache
            }

            return customer.id;

        } catch (err: any) {
            console.error(
                `[getOrCreateCustomer] Unexpected error for email=${email} ` +
                `provider=${providerId}: ${err?.message ?? err}`
            );
            return null;
        }
    }

    private failure(accountId: string, transactionId: string, message: string, data?: any): ChargeResponse {
        return {
            success: false,
            status: 'failed',
            provider: 'stripe',
            accountId,
            transactionId,
            message,
            data,
        }
    }

}
