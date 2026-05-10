import { Module } from '@nestjs/common';
import { ProviderService } from './providers.service';
import { PaymentModule } from '../payments/payments.module';
import { CryptoModule } from '../crypto/crypto.module';
import { ProviderController } from './providers.controller';

@Module({
    imports: [CryptoModule, PaymentModule],
    providers: [ProviderService],
    controllers: [ProviderController],

})
export class ProviderModule { }