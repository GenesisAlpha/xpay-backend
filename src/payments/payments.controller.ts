import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { PaymentService } from './payments.service';
import { CreatePaymentDto } from './create-payment.dto';
import { ApiKeyGuard } from '../middleware/api-key.guard';
import { Request } from 'express';


@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Post('create')
  @UseGuards(ApiKeyGuard)
  async create(@Req() req: Request, @Body() dto: CreatePaymentDto) {
    return this.paymentService.createPayment({
      ...dto,
      sellerId: req.sellerId,
    });
  }

  @Post('tracking')
  async syncTracking(@Body() body: any) {
    return this.paymentService.uploadToNexor(body);
  }

}

