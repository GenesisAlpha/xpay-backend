// Tipos compartilhados pelos providers de pagamento.

export type ChargeResponse = {
    valid?:          true
    message?:        string
    success:         boolean
    status:          string
    provider:        string
    accountId:       string
    transactionId:   string   // nossa referência interna (txId)
    providerTransactionId?: string  // id do provider (vira provider_transaction_id)
    redirectUrl?:    string
    entity?:         string
    reference?:      string
    clientSecret?:   string
    data?:           any
    checkout_url?:   string
    gateway_id?:     string
    // detalhes lidos pelo PaymentService
    providerStatus?: string
    failureCode?:    string
    failureMessage?: string
    next_action?:    any
}

export type RetrieveResponse = {
    success:                boolean
    status:                 'paid' | 'failed' | 'pending' | 'unknown'
    providerTransactionId?: string
    method?:                string
    raw?:                   any
}
