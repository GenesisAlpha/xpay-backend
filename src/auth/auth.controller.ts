import {
    Controller,
    Post,
    Get,
    Body,
    Query,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jtw.auth.guard';
import {
    RegisterDto,
    LoginDto,
    ForgotPasswordDto,
    ResetPasswordDto,
    ResendVerificationDto,
} from './auth.dto';


@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    // POST /auth/register
    @Post('register')
    async register(@Body() dto: RegisterDto) {
        return this.authService.register(dto);
    }

    @Post('verify-email')
    @HttpCode(HttpStatus.OK)
    verifyEmail(@Body('token') token: string) {
        return this.authService.verifyEmail(token)
    }


    // POST /auth/resend-verification
    @Post('resend-verification')
    @HttpCode(HttpStatus.OK)
    async resendVerification(@Body() dto: ResendVerificationDto) {
        return this.authService.resendVerification(dto.email);
    }

    // POST /auth/login
    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Body() dto: LoginDto) {
        return this.authService.login(dto);
    }

    // POST /auth/forgot-password
    @Post('forgot-password')
    @HttpCode(HttpStatus.OK)
    async forgotPassword(@Body() dto: ForgotPasswordDto) {
        return this.authService.forgotPassword(dto.email);
    }

    // POST /auth/reset-password
    @Post('reset-password')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() dto: ResetPasswordDto) {
        return this.authService.resetPassword(dto.token, dto.newPassword);
    }

    // GET /auth/me  (rota protegida)
    @Get('me')
    @UseGuards(JwtAuthGuard)
    async getMe(@Req() req: any) {
        return this.authService.getMe(req.user.sub);
    }
}