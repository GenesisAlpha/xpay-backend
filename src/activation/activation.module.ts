import { Module } from '@nestjs/common'
import { ActivationRequestsService } from './activation-requests.service'
import { MailService } from '../utils/mail'

// Usado pelo onboarding (seller pede e o cadastro com CNPJ consulta a
// liberação) e pelo CRM (fila e decisão).
@Module({
  providers: [ActivationRequestsService, MailService],
  exports: [ActivationRequestsService],
})
export class ActivationModule { }
