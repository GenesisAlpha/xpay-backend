import { Module } from '@nestjs/common'
import { AffiliateCommissionService } from './affiliate-commission.service'
import { AffiliateSettlementCron } from './affiliate-settlement.cron'
import { AffiliatesInternalController } from './affiliates-internal.controller'

@Module({
  controllers: [AffiliatesInternalController],
  providers: [AffiliateCommissionService, AffiliateSettlementCron],
  exports: [AffiliateCommissionService],
})
export class AffiliatesModule {}
