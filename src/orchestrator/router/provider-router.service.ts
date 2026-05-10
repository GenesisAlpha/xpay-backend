import { Injectable } from '@nestjs/common';
import { AccountRouterService } from './account-router.service';
import { PaymentContext } from '../payment-context.interface';

@Injectable()
export class ProviderRouterService {
    constructor(
        private readonly accountRouter: AccountRouterService,
    ) { }

    async route(ctx: PaymentContext) {
        return this.accountRouter.getCandidateAccounts(ctx);
    }

    markAsFailed(accountId: string) {
        // depois vamos ligar isso em métricas
        console.log('failed account:', accountId);
    }
}