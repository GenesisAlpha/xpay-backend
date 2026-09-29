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

    // País do cliente (ISO-2). Salvo em customer_country e exibido na dash.
    @IsOptional() @IsString() @MaxLength(2)
    country?: string;
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

    // Wallet — token (objeto) do SDK do Apple Pay / Google Pay
    @IsOptional()
    walletToken?: any;

    // MBWay
    @IsOptional() @IsString() @MaxLength(20)
    phone?: string;
}

// ─── Main DTO ──────────────────────────────────────────────────────────────────

// 🔥 FIX #9: todos os campos decorados com class-validator
export class CreatePaymentDto {

    @IsNumber() @Min(1)
    amount!: number;

    @IsString() @IsIn(['EUR', 'BRL', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'PLN', 'NOK', 'MXN'])
    currency!: string;

    @IsString() @IsIn([
        'card', 'pix', 'mbway', 'multibanco',
        'ideal', 'bancontact', 'apple_pay', 'google_pay',
        'eps', 'p24', 'swish', 'twint', 'blik', 'mobile_pay', 'klarna', 'spei',
        // Whop Elements: o PaymentElement também oferece cripto.
        'crypto',
        // PayPal na conta do próprio seller (botões do PayPal no checkout).
        'paypal',
    ])
    method!: string;

    // Whop Elements (Payments + PaymentElement): token `ctok_` que o navegador
    // gerou com o método escolhido. O WhopProvider confirma com POST /payments
    // em vez de criar uma checkout configuration pro embed.
    @IsOptional() @IsString() @MaxLength(200)
    confirmation_token?: string;

    // Roteamento da página hosted (Sentinel): 'apple_pay'/'google_pay' abrem a
    // página unificada com o botão da carteira + fallback de cartão, SEM mudar o
    // `method` gravado (que fica 'card'). Só afeta qual página hosted é criada.
    @IsOptional() @IsString() @IsIn(['apple_pay', 'google_pay'])
    hosted_method?: string;

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
