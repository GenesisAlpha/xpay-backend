// checkout-session.controller.ts

import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { CheckoutService } from './  checkout-session.service';
import { ApiKeyGuard } from '../middleware/api-key.guard';
import { Request } from 'express';

@Controller('checkout')
export class CheckoutSessionController {
    constructor(
        private readonly checkoutService: CheckoutService,
    ) { }

    // =========================================
    // CREATE SESSION
    // =========================================
    @Post('session')
    @UseGuards(ApiKeyGuard)
    async createSession(@Req() req: Request, @Body() dto: any) {
        return this.checkoutService.createSession({ ...dto, sellerId: req.sellerId });
    }

   
}