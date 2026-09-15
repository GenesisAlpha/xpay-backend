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

    // E.164 (+5511999999999). Opcional para o onboarding atual seguir
    // funcionando; a conta conectada da Whop exige.
    @IsOptional() @IsString()
    @Matches(/^\+[1-9]\d{7,14}$/, { message: 'Telefone deve estar no formato internacional (+5511999999999)' })
    phone?: string;
}

class OfferDto {
    @IsString() @IsNotEmpty() @MaxLength(200)
    name!: string;

    @IsUrl({}, { message: 'URL da página de vendas inválida' })
    salesPageUrl!: string;

    @IsIn(['WHITE', 'GRAY'])
    riskLevel!: 'WHITE' | 'GRAY';
}

export class OperationDto {
    @IsOptional() @IsString() @MaxLength(1000)
    description: string;

    @IsIn(['WHITE', 'GRAY'])
    overallRiskLevel!: 'WHITE' | 'GRAY';

    @IsBoolean()
    termsAccepted!: boolean;

    @IsArray()
    requestedMethods: string[]

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => OfferDto)
    offers!: OfferDto[];
}

// ─── DOCUMENTOS ───────────────────────────────────────────────────────────────
export class DocumentFileDto {
    @IsString() @IsNotEmpty()
    base64!: string;

    @IsString() @IsNotEmpty()
    mime!: string;

    @IsOptional() @IsString() @MaxLength(255)
    name?: string;
}

export class DocumentsDto {
    // US (LLC) é o padrão. BR só com a ativação por CNPJ liberada no CRM.
    @IsIn(['BR', 'US'])
    companyType!: 'BR' | 'US';

    // BR
    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    contratoSocial?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    cartaoCnpj?: DocumentFileDto;

    // US — dados da LLC usados na verificação de empresa da Whop
    @IsOptional() @IsString() @MaxLength(200)
    companyLegalName?: string;

    @IsOptional() @Matches(/^\d{2}-?\d{7}$/, { message: 'EIN deve ter 9 dígitos (XX-XXXXXXX)' })
    companyEin?: string;

    @IsOptional() @IsIn(['single_member_llc', 'multi_member_llc'])
    companyStructure?: 'single_member_llc' | 'multi_member_llc';

    @IsOptional() @Matches(/^[A-Z]{2}$/, { message: 'Estado de abertura deve ser a sigla (ex.: WY)' })
    companyFormationState?: string;

    @IsOptional() @IsString() @MaxLength(200)
    companyAddressLine1?: string;

    @IsOptional() @IsString() @MaxLength(200)
    companyAddressLine2?: string;

    @IsOptional() @IsString() @MaxLength(100)
    companyCity?: string;

    @IsOptional() @Matches(/^[A-Z]{2}$/, { message: 'Estado do endereço da LLC deve ser a sigla (ex.: WY)' })
    companyState?: string;

    @IsOptional() @Matches(/^\d{5}(-\d{4})?$/, { message: 'ZIP code da LLC inválido' })
    companyPostalCode?: string;

    @IsOptional() @IsUrl({}, { message: 'Site da empresa inválido' })
    companyWebsite?: string;

    // Carta do EIN (IRS Letter 147C, CP 575 ou SS-4)
    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    einDocument?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    articlesOfOrganization?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    operatingAgreement?: DocumentFileDto;

    // Pessoais — identidade em arquivo único só no fluxo BR
    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    identityDocument?: DocumentFileDto;

    @ValidateNested() @Type(() => DocumentFileDto)
    proofOfResidence!: DocumentFileDto;

    // Verificação da Whop (LLC): tipo do documento, frente/verso separados e
    // selfie.
    @IsOptional() @IsIn(['ID_CARD', 'DRIVERS', 'RESIDENCE_PERMIT', 'PASSPORT'])
    identityDocumentType?: 'ID_CARD' | 'DRIVERS' | 'RESIDENCE_PERMIT' | 'PASSPORT';

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    identityFront?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    identityBack?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    selfie?: DocumentFileDto;
}

// ─── PENDÊNCIAS ───────────────────────────────────────────────────────────────
// O seller corrige só o que falta (cadastro ou pedido da Whop), sem reenviar a
// etapa inteira. Tudo opcional: vem apenas o que o painel pediu.

export class RfiAnswerDto {
    @IsString() @IsNotEmpty() @MaxLength(100)
    id!: string;

    @IsOptional() @IsString() @MaxLength(2000)
    value?: string;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    file?: DocumentFileDto;
}

export class RequirementsDto {
    @IsOptional() @IsString()
    @Matches(/^\+[1-9]\d{7,14}$/, { message: 'Telefone deve estar no formato internacional (+5511999999999)' })
    phone?: string;

    @IsOptional() @IsString() @MaxLength(200)
    companyLegalName?: string;

    @IsOptional() @Matches(/^\d{2}-?\d{7}$/, { message: 'EIN deve ter 9 dígitos (XX-XXXXXXX)' })
    companyEin?: string;

    @IsOptional() @IsIn(['single_member_llc', 'multi_member_llc'])
    companyStructure?: 'single_member_llc' | 'multi_member_llc';

    @IsOptional() @Matches(/^[A-Z]{2}$/, { message: 'Estado de abertura deve ser a sigla (ex.: WY)' })
    companyFormationState?: string;

    @IsOptional() @IsString() @MaxLength(200)
    companyAddressLine1?: string;

    @IsOptional() @IsString() @MaxLength(200)
    companyAddressLine2?: string;

    @IsOptional() @IsString() @MaxLength(100)
    companyCity?: string;

    @IsOptional() @Matches(/^[A-Z]{2}$/, { message: 'Estado do endereço da LLC deve ser a sigla (ex.: WY)' })
    companyState?: string;

    @IsOptional() @Matches(/^\d{5}(-\d{4})?$/, { message: 'ZIP code da LLC inválido' })
    companyPostalCode?: string;

    @IsOptional() @IsUrl({}, { message: 'Site da empresa inválido' })
    companyWebsite?: string;

    @IsOptional() @IsIn(['ID_CARD', 'DRIVERS', 'RESIDENCE_PERMIT', 'PASSPORT'])
    identityDocumentType?: 'ID_CARD' | 'DRIVERS' | 'RESIDENCE_PERMIT' | 'PASSPORT';

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    einDocument?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    articlesOfOrganization?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    operatingAgreement?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    identityFront?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    identityBack?: DocumentFileDto;

    @IsOptional() @ValidateNested() @Type(() => DocumentFileDto)
    selfie?: DocumentFileDto;

    // Campos corrigidos por outra rota (ex.: dados pessoais pelo /kyc) que
    // devem reenviar à Whop os pedidos ligados a eles.
    @IsOptional() @IsArray() @IsIn(['kyc', 'phone'], { each: true })
    refresh?: Array<'kyc' | 'phone'>;

    // Pedidos da Whop sem campo no cadastro: respondidos direto pelo seller.
    @IsOptional() @IsArray()
    @ValidateNested({ each: true })
    @Type(() => RfiAnswerDto)
    rfi?: RfiAnswerDto[];
}
