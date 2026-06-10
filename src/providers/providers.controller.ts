// provider.controller.ts

import { Controller, Post, Body } from '@nestjs/common';
import { ProviderService } from './providers.service';

@Controller('providers')
export class ProviderController {
    constructor(private readonly providerService: ProviderService) { }

    @Post('create')
    async createProvider(@Body() body: any) {
        console.log(body);
        return this.providerService.createProvider(body);
    }

}