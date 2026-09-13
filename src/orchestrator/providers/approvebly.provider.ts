import { ChargeResponse } from './provider.types';

// ============================================================================
// APPROVEBLY — API direta com chave própria.
// Credenciais: providerConfig.apiKey / providerConfig.api_url (vêm da config
// in-project em provider-accounts.config.ts → env APPROVEBLY_*).
//
// TODO: ajustar endpoint, payload e parsing da resposta conforme a doc real.
// ============================================================================

export class ApproveblyProvider {
    name = 'approvebly';

    async charge(ctx: any): Promise<ChargeResponse> {
        const {
            amount,
            currency,
            method,
            customer,
            transactionId,
            providerConfig,
        } = ctx;

        const { id, api_url, apiKey } = providerConfig;

        if (!api_url || !apiKey) {
            return this.failure(id, transactionId, 'Approvebly: api_url/apiKey ausentes');
        }

        try {
            const res = await fetch(`${api_url}/payments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    amount,            // centavos
                    currency,
                    method,
                    reference: transactionId,
                    customer: {
                        name: customer?.name,
                        email: customer?.email,
                        phone: customer?.phone,
                        document: customer?.document,
                    },
                }),
            });

            const json: any = await res.json().catch(() => ({}));

            if (!res.ok) {
                return this.failure(id, transactionId, json?.message ?? `HTTP ${res.status}`, json);
            }

            // TODO: mapear o status real do provider.
            const paid = json?.status === 'approved' || json?.status === 'paid';

            return {
                success: true,
                status: paid ? 'approved' : 'pending',
                provider: this.name,
                accountId: id,
                transactionId,
                providerTransactionId: json?.transaction_id ?? json?.id,
                checkout_url: json?.checkout_url,
                redirectUrl: json?.redirect_url,
                data: json,
            };
        } catch (err: any) {
            console.error('[ApproveblyProvider] charge error:', err?.message);
            return this.failure(id, transactionId, err?.message ?? 'erro desconhecido');
        }
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
