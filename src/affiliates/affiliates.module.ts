import { Module } from '@nestjs/common'
import { AffiliateCommissionService } from './affiliate-commission.service'
import { AffiliateSettlementCron } from './affiliate-settlement.cron'
import { AffiliatesInternalController } from './affiliates-internal.controller'
import { AffiliateEarningsController } from './affiliate-earnings.controller'
import { AffiliateEarningsService } from './affiliate-earnings.service'
import { AffiliateCrmService } from './affiliate-crm.service'

@Module({
  controllers: [AffiliatesInternalController, AffiliateEarningsController],
  providers: [AffiliateCommissionService, AffiliateSettlementCron, AffiliateEarningsService, AffiliateCrmService],
  // AffiliateCrmService é usado pelo controller do CRM, que mora no CrmModule
  // (é lá que vivem o CrmAuthGuard e o JwtModule com o CRM_JWT_SECRET).
  exports: [AffiliateCommissionService, AffiliateCrmService],
})
export class AffiliatesModule {}
