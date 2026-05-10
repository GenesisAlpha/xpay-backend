// nexor/src/orchestrator/providers/stripe-crypto.provider.ts

import { ChargeResponse, RetrieveResponse } from './viva.provider'

interface StripeCryptoConfig {
    wallet_address: string
    network: string
    currency: string  // 'usdc' | 'usdt' | etc.
    // publishable_key e secret_key não são necessários aqui — a proxy nexflowx
    // já tem as credenciais Stripe configuradas do seu lado.
}


const NEXFLOW_PROXY_KEY = process.env.NEXFLOW_APIKEY
    ?? (() => { throw new Error('NEXFLOW_PROXY_KEY env var is required') })()

export class StripeCryptoProvider {

    // ─── charge: cria OnrampSession via proxy nexflowx ────────────────────────
    //
    // Diferenças vs VivaProvider:
    //   • Endpoint: /relay/STRIPE_CRYPTO/payments (proxy nexflowx)
    //   • Body: JSON simplificado (proxy traduz pra formato Stripe internamente)
    //   • Lê wallet/network/currency da provider_account.config (seguro)
    //   • Retorna client_secret (não checkout_url) — frontend monta widget Onramp

    async charge(ctx: any): Promise<ChargeResponse> {
        const { amount, currency, transactionId, providerConfig } = ctx
        const { id, config, api_url } = providerConfig as { id: string; config: StripeCryptoConfig; api_url: string }

        // ── Validação defensiva ────────────────────────────────────────────
        if (!config?.wallet_address || !config?.network || !config?.currency) {
            return this.failure(id, transactionId,
                `Stripe Crypto config incomplete: ` +
                `wallet=${!!config?.wallet_address} network=${!!config?.network} currency=${!!config?.currency}`)
        }

        // ── Monta body simplificado (formato que a nexflowx espera) ─────────
        const customer = ctx.customer ?? {}
        const name = customer.name
            || [customer.firstName, customer.lastName].filter(Boolean).join(' ')
            || ''

        const body: any = {
            amount: amount / 100,                     // proxy espera em unidade principal
            currency: currency.toUpperCase(),
            crypto_currency: config.currency.toUpperCase(),    // ex: 'USDT'
            network: config.network.toLowerCase(),     // ex: 'polygon' | 'trc20'
            target_address: config.wallet_address,
            customer: {
                name,
                email: customer.email,
                phone: customer.phone,
            },
            // Metadata pra reconciliação Nexor ↔ Stripe (caso a proxy repasse)
            metadata: {
                nexor_transaction_id: transactionId,
            },
        }

        // ── Chama proxy nexflowx ────────────────────────────────────────────
        try {
            const res = await fetch(`${api_url}/payment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-proxy-key': NEXFLOW_PROXY_KEY,
                },
                body: JSON.stringify(body),
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
                success: true,
                status: 'pending',
                provider: 'stripe_crypto',
                accountId: id,
                transactionId,
                clientSecret: json.client_secret,
                gateway_id: json.gateway_id,           // cos_xxx
                data: json.raw_crypto_data ?? json,
            }
        } catch (err: any) {
            console.error('[StripeCryptoProvider] charge error:', err?.message)
            return this.failure(id, transactionId, err?.message ?? 'Stripe Crypto proxy network error')
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private mapStatus(status: string | undefined): RetrieveResponse['status'] {
        switch (status) {
            case 'fulfillment_complete':
                return 'paid'
            case 'rejected':
                return 'failed'
            case 'initialized':
            case 'requires_payment':
            case 'payment':
            case 'processing':
            case 'fulfillment_processing':
                return 'pending'
            default:
                return 'unknown'
        }
    }

    private parseMethod(session: any): string {
        const pm = session?.payment_method
        if (pm?.type === 'card') return 'card'
        if (pm?.type === 'apple_pay') return 'apple_pay'
        if (pm?.type === 'google_pay') return 'google_pay'
        return 'crypto'
    }

    private failure(accountId: string, transactionId: string, message: string, data?: any): ChargeResponse {
        return {
            success: false,
            status: 'failed',
            provider: 'stripe_crypto',
            accountId,
            transactionId,
            message,
            data,
        }
    }
}