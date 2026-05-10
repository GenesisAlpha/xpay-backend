// nexor/src/providers/viva.provider.ts

import { toIsoLocale } from "../../utils/iso"

const API_KEY = process.env.NEXFLOW_APIKEY

export type ChargeResponse = {
    valid?:        true
    message?:      string
    success:       boolean
    status:        string
    provider:      string
    accountId:     string
    transactionId: string
    redirectUrl?:  string
    entity?:       string
    reference?:    string
    clientSecret?: string
    data?:         any
    checkout_url?: string
    gateway_id?:   string
}

export type RetrieveResponse = {
    success:                boolean
    status:                 'paid' | 'failed' | 'pending' | 'unknown'
    providerTransactionId?: string
    method?:                string
    raw?:                   any
}

const VIVA_STATUS_MAP: Record<string, RetrieveResponse['status']> = {
    F:  'paid',
    MV: 'paid',
    A:  'pending',
    E:  'pending',
    R:  'failed',
    X:  'failed',
    D:  'failed',
}

export class VivaProvider {

    // ─── Cria Payment Order via Nexflow proxy ──────────────────────────────────
    //
    // 🔥 NOVO: agora o body inclui `settlement` com recipients (3-way split).
    //         O Nexflow é responsável por:
    //           1. Validar a soma dos amount_cents == total_net_cents
    //           2. Validar que todas wallet_references existem
    //           3. Distribuir o dinheiro nas wallets quando a Viva confirmar
    //
    // O `payment_reference` continua sendo o transactionId da Nexor —
    // assim o Nexflow consegue correlacionar webhook ↔ transaction Nexor.

    async charge(ctx: any): Promise<ChargeResponse> {

        const { amount, transactionId, providerConfig, settlement } = ctx
        const { api_url, id } = providerConfig

        const payment_reference = ctx.payment_reference ?? 'Secure Checkout'

        // 🔥 Body enriquecido com settlement
        const intent: any = {
            amount: amount / 100,
            reference: payment_reference,
            method: 'SMART_CHECKOUT',
            payment_reference: transactionId,
            customer:{
              fullName: ctx.customer?.name,
              email: ctx.customer?.email,
              phone: ctx.customer?.phone,
              countryCode: ctx.customer?.country,
              requestLang: toIsoLocale(ctx?.customer?.language)
            } 
        }

        // Settlement só vai se foi montado no PaymentService.
        // (Defensivo: providers que ainda não suportam split podem não receber.)
        if (settlement) {
            intent.settlement = settlement
        }

        const res = await fetch(`${api_url}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-proxy-key':  API_KEY,
            },
            body: JSON.stringify(intent),
        })

        const json = await res.json()
        console.log(json);
        const { status, gateway_id } = json

        if (!gateway_id) {
            return {
                success: false,
                status: 'failed',
                provider: 'viva',
                accountId: id,
                transactionId,
                message: json?.error?.message
                      ?? json?.message
                      ?? 'Nexflow proxy did not return gateway_id',
                data: json,
            }
        }

        const checkout_url = `https://pay.nexorpayments.com/pay/${gateway_id}`

        return {
            success:       true,
            status:        (status === 'CREATED' || status === 'PENDING') ? 'pending' : 'failed',
            provider:      'viva',
            accountId:     id,
            transactionId,
            checkout_url,
            gateway_id,
        }
    }

    // ─── Retrieve Transaction (inalterado) ─────────────────────────────────────

    async retrieveTransaction(ctx: {
        providerTransactionId: string
        providerConfig: { retrieve_url: string }
    }): Promise<RetrieveResponse> {

        const { providerTransactionId, providerConfig } = ctx

        try {
            const res = await fetch(`${providerConfig.retrieve_url}/${providerTransactionId}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'x-proxy-key':  API_KEY,
                },
            })

            if (!res.ok) {
                return {
                    success: false,
                    status:  'unknown',
                    raw:     await res.text().catch(() => null),
                }
            }

            const json = await res.json()

            const tx = Array.isArray(json) ? (json[0] ?? null) : json
            if (!tx) {
                return { success: false, status: 'unknown', raw: json }
            }

            const statusId = String(tx.StatusId ?? '').toUpperCase()
            const mapped   = VIVA_STATUS_MAP[statusId] ?? 'unknown'

            return {
                success:               mapped === 'paid',
                status:                mapped,
                providerTransactionId: tx.TransactionId ?? providerTransactionId,
                method:                this.parseMethod(tx),
                raw:                   tx,
            }
        } catch (err: any) {
            console.error('[VivaProvider] retrieveTransaction error:', err?.message)
            return { success: false, status: 'unknown', raw: { error: err?.message } }
        }
    }

    private parseMethod(tx: any): string {
        const raw = String(
            tx.PaymentMethod
            ?? tx.PaymentMethodName
            ?? tx.PaymentMethodId
            ?? ''
        ).toLowerCase()

        if (!raw) return 'card'

        if (raw.includes('mb way') || raw === 'mbway' || raw === 'mb_way') return 'mbway'
        if (raw.includes('multibanco')) return 'multibanco'
        if (raw.includes('apple'))      return 'apple_pay'
        if (raw.includes('google'))     return 'google_pay'
        if (raw.includes('paypal'))     return 'paypal'
        if (raw.includes('klarna'))     return 'klarna'
        if (raw.includes('ideal'))      return 'ideal'
        if (raw.includes('blik'))       return 'blik'

        return 'card'
    }
}