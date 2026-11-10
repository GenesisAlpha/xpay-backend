import { Body, Controller, Post, Req, Headers, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WhopConnectedWebhookService } from './whop-connected-webhook.service';

@Controller('webhook')
export class WebhookController {
    constructor(
        private readonly webhookService: WebhookService,
        private readonly whopConnectedWebhook: WhopConnectedWebhookService,
    ) { }

    // NEXFLOW
    @Post('nexflow')
    async handleNexflorWebhook(@Req() req: any) {
        return this.webhookService.handleWebhookProvider(req.body);
    }

    // SENTINEL GATE
    @Post('sentinel')
    async handleSentinelWebhook(@Req() req: any, @Headers() headers: Record<string, string>) {
        // req.body é Buffer (express.raw) — preciso do corpo BRUTO para a assinatura HMAC.
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        let parsed: any = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { /* payload inválido */ }

        return this.webhookService.handleSentinelWebhook(parsed, raw, headers);
    }

    // COINFLOW
    @Post('coinflow')
    async handleCoinflowWebhook(@Req() req: any, @Headers() headers: Record<string, string>) {
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        let parsed: any = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { /* payload inválido */ }

        return this.webhookService.handleCoinflowWebhook(parsed, raw, headers);
    }

    // KONTINO CONNECT (SPEI e Pix com confirmação automática)
    @Post('kontino')
    @HttpCode(200)
    async handleKontinoWebhook(@Req() req: any, @Headers() headers: Record<string, string>) {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});
        return this.webhookService.handleKontinoWebhook(raw, headers);
    }

    // ROX PAY
    @Post('roxpay')
    async handleRoxPayWebhook(@Req() req: any, @Headers() headers: Record<string, string>) {
        return this.webhookService.handleRoxPayWebhook(req.body, headers);
    }

    // SLASH — um endpoint só (uma conta). O corpo tem que chegar BRUTO: a
    // assinatura RSA é sobre os bytes exatos — ver express.raw em main.ts.
    @Post('slash')
    async handleSlashWebhook(@Req() req: any, @Headers() headers: Record<string, string>) {
        const raw: Buffer | string = Buffer.isBuffer(req.body)
            ? req.body
            : (req.rawBody ?? JSON.stringify(req.body ?? {}));
        return this.webhookService.handleSlashWebhook(raw, headers);
    }

    // WHOP — endpoint compartilhado configurado no dashboard da Whop.
    // A conta é recuperada do metadata que nós mesmos gravamos na checkout
    // configuration; o WebhookService ainda valida a assinatura com o segredo
    // daquela conta antes de processar qualquer evento.
    @Post('whop')
    async handleSharedWhopWebhook(
        @Req() req: any,
        @Headers() headers: Record<string, string>,
    ) {
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        let parsed: any = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { /* payload inválido */ }

        // Webhook da master com "eventos de contas conectadas" ligado: o evento
        // de uma conta conectada chega aqui e segue o fluxo dela (posse, risco,
        // cobertura do negativo), não o da master.
        if (await this.whopConnectedWebhook.isConnectedEvent(parsed)) {
            return this.whopConnectedWebhook.handle(parsed, raw, headers);
        }

        const shared = await this.webhookService.handleSharedWhopWebhook(parsed, raw, headers);
        // Venda da master: garante o descritor no produto da loja (um por loja).
        if (parsed?.type === 'payment.succeeded') {
            await this.whopConnectedWebhook.ensureMasterCheckoutProduct(parsed);
        }
        return shared;
    }

    // WHOP — contas conectadas (webhook da master com child_resource_events).
    //
    // ⚠️ DECLARADO ANTES de 'whop/:accountId': as rotas casam na ordem de
    // registro, e depois dele 'connected' viraria um accountId. O prefixo
    // /webhook/whop já recebe express.raw em main.ts.
    @Post('whop/connected')
    async handleWhopConnectedWebhook(
        @Req() req: any,
        @Headers() headers: Record<string, string>,
    ) {
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        let parsed: any = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { /* payload inválido */ }

        return this.whopConnectedWebhook.handle(parsed, raw, headers);
    }

    // WHOP legado — a conta vai no PATH.
    //
    // Cada company do pool tem webhook e segredo PRÓPRIOS. Um endpoint único
    // não teria como saber com qual segredo validar a assinatura (e testar
    // todos, além de lento, aceitaria um payload assinado pela conta errada).
    @Post('whop/:accountId')
    async handleWhopWebhook(
        @Param('accountId') accountId: string,
        @Req() req: any,
        @Headers() headers: Record<string, string>,
    ) {
        // Assinatura Standard Webhooks é sobre o corpo BRUTO — re-serializar o
        // JSON parseado muda bytes (ordem de chaves, escapes) e invalida tudo.
        // main.ts registra express.raw em /webhook/whop por causa disto.
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        let parsed: any = {};
        try { parsed = JSON.parse(raw || '{}'); } catch { /* payload inválido */ }

        // Mesmo desvio da rota compartilhada: evento de conta conectada vindo
        // pelo webhook da master.
        if (await this.whopConnectedWebhook.isConnectedEvent(parsed)) {
            return this.whopConnectedWebhook.handle(parsed, raw, headers);
        }

        const result = await this.webhookService.handleWhopWebhook(accountId, parsed, raw, headers);
        if (parsed?.type === 'payment.succeeded') {
            await this.whopConnectedWebhook.ensureMasterCheckoutProduct(parsed);
        }
        return result;
    }

    // STRIPE — a conta vai no PATH, pela mesma razão da Whop.
    //
    // Cada titular do pool tem endpoint e signing secret PRÓPRIOS. Um endpoint
    // único não teria como saber com qual segredo validar — e testar todos
    // aceitaria um payload assinado pela conta errada, deixando uma conta
    // confirmar pagamento de outra.
    @Post('stripe/:accountId')
    async handleStripeWebhook(
        @Param('accountId') accountId: string,
        @Req() req: any,
        @Headers() headers: Record<string, string>,
    ) {
        // A assinatura da Stripe é sobre o corpo BRUTO — re-serializar o JSON
        // parseado muda bytes (ordem de chaves, escapes) e invalida tudo.
        // main.ts registra express.raw em /webhook/stripe por causa disto.
        const raw = Buffer.isBuffer(req.body)
            ? req.body.toString('utf8')
            : JSON.stringify(req.body ?? {});

        return this.webhookService.handleStripeWebhook(accountId, raw, headers);
    }

    // PAYPAL — conta do próprio seller, também no PATH (`paypall_<id>`): cada
    // app tem o seu webhook_id, e é ele que o PayPal usa para verificar a
    // assinatura (verify-webhook-signature). O corpo segue como JSON: a
    // verificação é pela API do PayPal, não por HMAC local sobre os bytes.
    @Post('paypal/:accountId')
    @HttpCode(HttpStatus.OK)
    async handlePaypalWebhook(
        @Param('accountId') accountId: string,
        @Body() body: any,
        @Headers() headers: Record<string, string>,
    ) {
        return this.webhookService.handlePaypalWebhook(accountId, body ?? {}, headers);
    }
}
