import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { PaymentService } from './payments.service';

// Mora aqui, e não no WebhookController, porque a confirmação da Clip é do
// PaymentService — e o PaymentsModule já importa o WebhookModule.
@Controller('webhook')
export class ClipWebhookController {
  constructor(private readonly payments: PaymentService) {}

  // Sempre 200: o desfecho vem da consulta à Clip, não do corpo. Erro aqui só
  // faria a Clip repetir o mesmo aviso.
  @Post('clip')
  @HttpCode(HttpStatus.OK)
  async handle(@Body() body: any) {
    try {
      return await this.payments.handleClipWebhook(body);
    } catch (err: any) {
      console.error('[ClipWebhook]', err?.message ?? err);
      return { received: true };
    }
  }
}
