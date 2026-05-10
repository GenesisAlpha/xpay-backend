import { Controller, Post, Req, Headers, BadRequestException } from '@nestjs/common';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
export class WebhookController {
    constructor(private readonly webhookService: WebhookService) { }

    // NEXFLOW 
    @Post('nexflow')
    async handleNexflorWebhook(@Req() req: any) {
        return this.webhookService.handleWebhookProvider(req.body);
    }

        @Post('teste')
    async handleNexfloTeste(@Req() req: any) {
        return this.webhookService.replayWaylinxWebhooks();
    }
}