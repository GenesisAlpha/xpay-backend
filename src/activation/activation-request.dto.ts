import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

export class ActivationRequestDto {
  @IsIn(['cnpj', 'us_company'])
  kind!: 'cnpj' | 'us_company'

  @IsOptional() @IsString() @MaxLength(1000)
  message?: string
}
