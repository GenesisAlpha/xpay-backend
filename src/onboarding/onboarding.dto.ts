import {
    IsString, IsNotEmpty, IsOptional, IsIn,
    IsBoolean, IsArray, ValidateNested, IsUrl, MaxLength, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class KycDto {
    @IsString() @IsNotEmpty() @MaxLength(120)
    fullName!: string;

    @IsString()
    @Matches(/^\d{11}$/, { message: 'CPF deve conter 11 dígitos numéricos' })
    cpf!: string;

    @IsString() @IsNotEmpty()
    birthDate!: string; // YYYY-MM-DD

    @IsString()
    @Matches(/^\d{8}$/, { message: 'CEP deve conter 8 dígitos numéricos' })
    cep!: string;

    @IsString() @IsNotEmpty() @MaxLength(200)
    street!: string;

    @IsString() @IsNotEmpty() @MaxLength(20)
    number!: string;

    @IsOptional() @IsString() @MaxLength(100)
    complement?: string;

    @IsString() @IsNotEmpty() @MaxLength(100)
    neighborhood!: string;

    @IsString() @IsNotEmpty() @MaxLength(100)
    city!: string;

    @IsString() @IsNotEmpty() @MaxLength(2)
    state!: string;
}

class OfferDto {
    @IsString() @IsNotEmpty() @MaxLength(200)
    name!: string;

    @IsUrl({}, { message: 'URL da página de vendas inválida' })
    salesPageUrl!: string;

    @IsIn(['WHITE', 'GRAY', 'BLACK'])
    riskLevel!: 'WHITE' | 'GRAY' | 'BLACK';
}

export class OperationDto {
    @IsOptional() @IsString() @MaxLength(1000)
    description: string;

    @IsIn(['WHITE', 'GRAY', 'BLACK'])
    overallRiskLevel!: 'WHITE' | 'GRAY' | 'BLACK';

    @IsBoolean()
    termsAccepted!: boolean;

    @IsArray()
    requestedMethods: string[]

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OfferDto)
    offers!: OfferDto[];
}