import {
    IsNumber,
    IsString,
    IsIn,
    IsEmail,
    IsOptional,
    IsNotEmpty,
    IsUrl,
    IsObject,
    Min,
    ValidateNested,
    MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Sub-DTOs ──────────────────────────────────────────────────────────────────

export class CustomerDto {
    @IsString() @IsNotEmpty() @MaxLength(120)
    name!: string;

    @IsEmail()
    email!: string;

    @IsOptional() @IsString() @MaxLength(30)
    document?: string;

    @IsOptional() @IsString() @MaxLength(20)
    phone?: string;
}

export class BillingAddressDto {
    @IsOptional() @IsString() @MaxLength(200)
    line1?: string;

    @IsOptional() @IsString() @MaxLength(100)
    city?: string;

    @IsOptional() @IsString() @MaxLength(100)
    state?: string;

    @IsString() @IsNotEmpty() @MaxLength(2)
    country!: string;

    @IsOptional() @IsString() @MaxLength(20)
    postalCode?: string;
}

export class PaymentDataDto {
    // Card
    @IsOptional() @IsString() @MaxLength(19)
    cardNumber?: string;

    @IsOptional() @IsString() @MaxLength(2)
    expMonth?: string;

    @IsOptional() @IsString() @MaxLength(4)
    expYear?: string;

    @IsOptional() @IsString() @MaxLength(4)
    cvv?: string;

    // Wallet
    @IsOptional() @IsString()
    walletToken?: string;

    // MBWay
    @IsOptional() @IsString() @MaxLength(20)
    phone?: string;
}

// ─── Main DTO ──────────────────────────────────────────────────────────────────

// 🔥 FIX #9: todos os campos decorados com class-validator
export class CreatePaymentDto {

    @IsNumber() @Min(1)
    amount!: number;

    @IsString() @IsIn(['EUR', 'BRL', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'PLN', 'NOK'])
    currency!: string;

    @IsString() @IsIn([
        'card', 'pix', 'mbway', 'multibanco',
        'ideal', 'bancontact', 'apple_pay', 'google_pay',
        'eps', 'p24', 'swish', 'twint', 'blik', 'mobile_pay', 'klarna',
    ])
    method!: string;

    @ValidateNested() @Type(() => CustomerDto)
    customer!: CustomerDto;

    @IsOptional() @ValidateNested() @Type(() => BillingAddressDto)
    billing_address?: BillingAddressDto;

    @IsOptional() @ValidateNested() @Type(() => PaymentDataDto)
    payment_data?: PaymentDataDto;

    @IsUrl()
    postback_url!: string;

    @IsOptional() @IsObject()
    metadata?: Record<string, any>;

    @IsOptional() @IsString() @MaxLength(64)
    idempotencyKey?: string;

    // Checkout flow
    @IsOptional() @IsString()
    sessionId?: string;

    @IsOptional() @IsString()
    providerAccountId?: string;
}