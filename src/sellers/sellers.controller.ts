import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { SellersService } from './sellers.service';
import { CreateSellerDto } from './sellers.dto';

@Controller('sellers')
export class SellersController {

    constructor(private readonly sellersService: SellersService) {}

    @Post("create")
    async create(@Body() dto: CreateSellerDto) {
        return this.sellersService.create(dto);
    }

    @Get(':id')
    async getById(@Param('id') id: string) {
        return this.sellersService.getById(id);
    }
}