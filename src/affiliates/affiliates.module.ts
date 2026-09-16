import { Module } from '@nestjs/common'
import { AffiliateCommissionService } from './affiliate-commission.service'
import { AffiliateSettlementCron } from './affiliate-settlement.cron'
import { AffiliatesInternalController } from './affiliates-internal.controller'
import { AffiliateEarningsController } from './affiliate-earnings.controller'
import { AffiliateEarningsService } from './affiliate-earnings.service'

@Module({
  controllers: [AffiliatesInternalController, AffiliateEarningsController],
  providers: [AffiliateCommissionService, AffiliateSettlementCron, AffiliateEarningsService],
  exports: [AffiliateCommissionService],
})
export class AffiliatesModule {}
