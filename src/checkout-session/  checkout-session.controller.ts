// checkout-session.controller.ts

import { Controller, Post, Get, Param, Body, UseGuards, Req } from '@nestjs/common';
import { CheckoutService } from './  checkout-session.service';
import { PaymentService } from '../payments/payments.service';
import { ApiKeyGuard } from '../middleware/api-key.guard';
import { Request } from 'express';

@Controller('checkout')
export class CheckoutSessionController {
    constructor(
        private readonly checkoutService: CheckoutService,
        private readonly paymentService: PaymentService,
    ) { }

    // =========================================
    // CREATE SESSION
    // =========================================
    @Post('session')
    @UseGuards(ApiKeyGuard)
    async createSession(@Req() req: Request, @Body() dto: any) {
        return this.checkoutService.createSession({ ...dto, sellerId: req.sellerId });
    }


    // ─────────────────────────────────────────────────────────────────────
    // EMBED — config pública da sessão
    //
    // ⚠️ SEM ApiKeyGuard de propósito: quem chama é o iframe no browser, e a
    // sk_live_ do seller não pode ir para lá. O sessionId é o que autentica, e
    // ele já nasce escopado a um seller, um valor e uma moeda.
    // ─────────────────────────────────────────────────────────────────────
    @Get('session/:sessionId/embed-config')
    async embedConfig(@Param('sessionId') sessionId: string) {
        return this.checkoutService.getEmbedConfig(sessionId);
    }

    // ─────────────────────────────────────────────────────────────────────
    // EMBED — reserva a conta antes de montar o formulário de cartão
    //
    // ⚠️ O VALOR NÃO VEM DO BROWSER. Ele é lido da sessão, que nasceu no
    // backend do seller com a sk_live_. Aceitar um `amount` daqui deixaria o
    // comprador reservar (e cobrar) o valor que quisesse.
    // ─────────────────────────────────────────────────────────────────────
    @Post('session/:sessionId/route')
    async embedRoute(
        @Param('sessionId') sessionId: string,
        @Body() body: { method?: 'card' | 'spei' },
    ) {
        const { sellerId, amount, country, currency } = await this.checkoutService.resolveSession(sessionId);
        return this.paymentService.clipRoute(sellerId, {
            method: body?.method ?? 'card',
            amount,
            // País e moeda vêm da SESSÃO, não de geolocalização por IP. Quem cria
            // a sessão é o backend do seller, que sabe para onde está vendendo —
            // o IP do comprador é palpite sobre um fato já conhecido, e erra
            // sempre que ele viaja, usa VPN ou o embed é testado de fora.
            country,
            currency,
            external_reference: sessionId,
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // EMBED — cria o pagamento
    //
    // Mesma regra: valor, moeda e seller saem da SESSÃO. Do browser vem só o
    // instrumento (token do cartão + a reserva que o originou) e os dados do
    // comprador, que não movem dinheiro.
    // ─────────────────────────────────────────────────────────────────────
    @Post('session/:sessionId/pay')
    async embedPay(@Param('sessionId') sessionId: string, @Body() body: any) {
        const s = await this.checkoutService.resolveSession(sessionId);
        return this.paymentService.createPayment({
            sellerId: s.sellerId,
            amount: s.amount,
            currency: s.currency,
            method: body?.method === 'spei' ? 'spei' : 'card',
            external_reference: sessionId,
            // Dedup pela sessão: dois cliques no botão não viram duas cobranças.
            idempotencyKey: `embed:${sessionId}`,
            customer: body?.customer ?? {},
            clip: body?.clip ?? undefined,
        });
    }
}