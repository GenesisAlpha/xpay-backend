import { Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { CardCryptoService } from './card-crypto.service';

@Module({
  providers: [CryptoService, CardCryptoService],
  exports: [CryptoService, CardCryptoService], // 🔥 importante
})
export class CryptoModule {}