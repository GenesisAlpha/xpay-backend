// sellers/sellers.service.ts
import { Injectable } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';

@Injectable()
export class SellersService {

    async create(dto: any) {

        const { data: seller } = await supabase
            .from('seller_profiles')
            .insert({
                user_id: dto.userId,
                name: dto.name,
                email: dto.email,
                country: dto.country,
                instagram: dto.instagram,
                enabled_methods: dto.enabledMethods,
                risk_level: dto.config.riskLevel,
                kyc_status: 'pending',
                metadata: dto.metadata,
                config: {
                    reserve: dto.config.reserve,
                    settlement: dto.config.settlement,
                    risk: {
                        level: dto.config.riskLevel,
                    },
                },

                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        const sellerId = seller.id;

        // FEES
        await supabase.from('seller_fees').insert(
            dto.fees.map((f: any) => ({
                seller_id: sellerId,
                payment_method: f.paymentMethod ?? null,
                fee_type: f.feeType,
                percentage: f.percentage ?? 0,
                fixed: f.fixed ?? 0,
                is_default: f.isDefault ?? false,
                currency: 'USD',
            }))
        );

        // WALLET
        await supabase.from('wallet_balance').insert({
            seller_id: sellerId,
            available_balance: 0,
            pending_balance: 0,
            reserved_balance: 0,
            updated_at: new Date().toISOString(),
        });

        return {
            seller
        }
    }


    async getById(id: string) {
        const { data, error } = await supabase
            .from('seller_profiles')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw new Error('Seller not found');

        return data;
    }

    async getSellerByUserId(userId: string): Promise<string> {
        const { data } = await supabase
            .from('seller_profiles')
            .select('id')
            .eq('user_id', userId)
            .single()
        if (!data) throw new Error('Seller profile not found')
        return data.id
    }
}