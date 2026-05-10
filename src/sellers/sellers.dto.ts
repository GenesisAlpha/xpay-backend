export class CreateSellerDto {
    name!: string;
    email!: string;
    country!: string;
    instagram?: string;
    userId!: string;
    enabledMethods!: (
        | 'card'
        | 'pix'
        | 'mbway'
        | 'multibanco'
        | 'ideal'
        | 'bancontact'
        | 'apple_pay'
        | 'google_pay'
    )[];

    metadata?: Record<string, any>;

    fees!: Array<{
        paymentMethod?: string | null;
        feeType: 'percentage' | 'fixed' | 'mixed';
        percentage?: number;
        fixed?: number;
        minFee?: number;
        maxFee?: number;
        isDefault?: boolean;
    }>;

    config!: {
        reserve: {
            percentage: number;
            holdDays: number;
        };

        settlement: {
            delayDays: number;
        };

        riskLevel?: 'low' | 'medium' | 'high';
    };
}