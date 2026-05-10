// provider.service.ts

import { Injectable } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';
import { CryptoService } from '../crypto/crypto.service';

@Injectable()
export class ProviderService {
    constructor(
        private readonly cryptoService: CryptoService
    ) {}

    async createProvider(dto: {
        provider: string;
        secretKey: string;
        weight?: number;
        supportedMethods: string[];
        name: string;
        type: string;
    }) {

        // 🔒 criptografa antes de salvar
        const encryptedKey = this.cryptoService.encrypt(dto.secretKey);

        const { data, error } = await supabase
            .from('provider_accounts')
            .insert({
                provider: dto.provider,
                encrypted_secret_key: encryptedKey,
                weight: dto.weight || 1,
                supported_methods: dto.supportedMethods,
                status: 'active',
                type: dto.type || 'sandbox',
                created_at: new Date().toISOString(),
            })
            .select()
            .single();

        if (error) {
            console.log(error);
            throw new Error('Failed to create provider');
        }

        return data;
    }
}