import { Module } from '@nestjs/common';
import { SellersService } from './sellers.service';
import { SellersController } from './sellers.controller';
import { CheckoutFeeInternalController } from './checkout-fee-internal.controller';

@Module({
    controllers: [SellersController, CheckoutFeeInternalController],
    providers: [SellersService],
    exports: [SellersService],
})
export class SellersModule {}