
const API_KEY = process.env.NEXFLOW_APIKEY;

export type ChargeResponse =
    {
        valid?: true;
        message?: string;
        success: boolean;
        status: string;
        provider: string;
        accountId: string;
        transactionId: string;
        redirectUrl?: string;
        entity?: string;
        reference?: string;
        clientSecret?: string;
        data?: any;
    };


export class SibsProvider {

    async charge(ctx: any): Promise<ChargeResponse> {

        const {
            amount,
            transactionId,
            method,
            customer,
            providerConfig
        } = ctx;

        const { api_url, id } = providerConfig;

        const intent: any = {
            amount: amount / 100,
            reference: transactionId,
            method
        };

        if (method === 'mbway' && customer.phone) {
            intent.phone = customer.phone.replace(/[^\d]/g, '');
        }


        const res = await fetch(`${api_url}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-proxy-key': API_KEY
            },
            body: JSON.stringify(intent)
        });


        const json = await res.json();
        const { status, entity, reference }  = json;


        return {
            success: true,
            status: status === 'PENDING' ? 'pending' : 'failed',
            entity,
            reference,
            provider: 'sibs',
            accountId: id,
            transactionId
        }


    }


}
