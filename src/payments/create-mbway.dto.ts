import {
    IsNumber, IsString, IsOptional, IsEmail, IsIn, IsObject, IsUrl,
    IsNotEmpty, Min, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Cliente ─────────────────────────────────────────────────────────────────

export class MbwayCustomerDto {
    @IsString() @IsNotEmpty() @MaxLength(120)
    name!: string;

    @IsEmail()
    email!: string;

    // Telefone MB Way (opcional): no fluxo hosted o cliente confirma o número na
    // própria página da Sentinel. Se enviado, é validado (PT/ES).
    @IsOptional() @IsString() @MaxLength(20)
    phone?: string;

    @IsOptional() @IsString() @MaxLength(30)
    document?: string;

    // País do cliente (ISO-2). MB Way é PT; default PT se não enviado.
    @IsOptional() @IsString() @MaxLength(2)
    country?: string;
}

// ─── Payload do MB Way por API ───────────────────────────────────────────────
//
// Rota pública pro seller (autenticado com sk_live_) gerar um pagamento MB Way e
// receber a URL de redirecionamento (página hosted da Sentinel).

export class CreateMbwayDto {
    // Valor em CENTAVOS (ex.: 500 = €5,00).
    @IsNumber() @Min(1)
    amount!: number;

    // MB Way é zona euro — default EUR.
    @IsOptional() @IsString() @IsIn(['EUR'])
    currency?: string;

    @ValidateNested() @Type(() => MbwayCustomerDto)
    customer!: MbwayCustomerDto;

    // URL de retorno após o pagamento (para onde o cliente volta). Se ausente,
    // usa a página de resultado padrão do checkout Koopfy.
    @IsOptional() @IsUrl()
    return_url?: string;

    // Webhook do seller p/ receber o resultado (payment.approved/failed/refunded).
    @IsOptional() @IsUrl()
    postback_url?: string;

    // Referência livre do seller (aparece no webhook como externalReference/metadata).
    @IsOptional() @IsString() @MaxLength(120)
    reference?: string;

    @IsOptional() @IsObject()
    metadata?: Record<string, any>;

    @IsOptional() @IsString() @MaxLength(64)
    idempotencyKey?: string;
}
