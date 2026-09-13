import { ChargeResponse } from './provider.types';

// ============================================================================
// SIMULATOR — provider de TESTE
// ----------------------------------------------------------------------------
// Aprova o pagamento de forma FICTÍCIA no servidor, sem chamar nenhum gateway
// externo nem mover dinheiro de verdade. Serve para demos/underwriting (ex.:
// gravar a jornada do cardholder de ponta a ponta).
//
// Como usar: associe a uma conta Koopfy setando
//   seller_profiles.provider_default = 'simulator'
// O checkout renderiza o formulário local de cartão e este provider devolve
// status 'approved' na hora — nenhuma credencial é necessária.
// ============================================================================

export class SimulatorProvider {
    name = 'simulator';

    async charge(ctx: any): Promise<ChargeResponse> {
        const { transactionId, providerConfig, method } = ctx;

        return {
            success: true,
            status: 'approved',                       // aprovação imediata (fictícia)
            provider: this.name,
            accountId: providerConfig?.id ?? 'simulator_main',
            transactionId,
            providerTransactionId: `sim_${transactionId}`,
            providerStatus: 'captured',
            data: { simulated: true, method: method ?? 'card' },
        };
    }
}
