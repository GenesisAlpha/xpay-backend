import {
  IsEmail,
  IsString,
  IsNotEmpty,
  MinLength,
  MaxLength,
  IsOptional,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class RegisterDto {
  @IsString() @IsNotEmpty() @MinLength(3) @MaxLength(120)
  name!: string;

  @IsString() @IsNotEmpty()
  @Matches(/^@[\w.]+$/, { message: 'Instagram inválido. Use @handle' })
  instagram!: string;

  @IsString() @IsNotEmpty()
  @Matches(/^\d{10,11}$/, { message: 'WhatsApp inválido. Envie só números (10-11 dígitos)' })
  whatsapp!: string;

  @IsEmail({}, { message: 'Email inválido' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;

  @IsString() @MinLength(8, { message: 'Senha deve ter no mínimo 8 caracteres' })
  password!: string;

  // Foto de perfil — opcional, enviada como base64
  @IsOptional() @IsString()
  profileImageBase64?: string;

  @IsOptional() @IsString()
  profileImageMime?: string;
}

export class LoginDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;

  @IsString() @IsNotEmpty()
  password!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;
}

export class ResetPasswordDto {
  @IsString() @IsNotEmpty()
  token!: string;

  @IsString() @MinLength(8)
  newPassword!: string;
}

export class ResendVerificationDto {
  @IsEmail()
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;
}