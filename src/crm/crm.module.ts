// crm-backend/crm-auth.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Reflector } from '@nestjs/core'

@Injectable()
export class CrmAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req    = ctx.switchToHttp().getRequest()
    const header = req.headers['authorization'] ?? ''
    const token  = header.replace(/^Bearer\s+/i, '').trim()

    if (!token) throw new UnauthorizedException('Token ausente')

    try {
      const payload = this.jwtService.verify(token, { secret: process.env.CRM_JWT_SECRET })
      req.manager   = payload

      // Verifica roles se decorador @Roles() estiver presente
      const roles = this.reflector.get<string[]>('roles', ctx.getHandler())
      if (roles?.length && !roles.includes(payload.role)) {
        throw new ForbiddenException('Permissão insuficiente')
      }

      return true
    } catch (e: any) {
      if (e instanceof ForbiddenException) throw e
      throw new UnauthorizedException('Token inválido ou expirado')
    }
  }
}

// crm-backend/crm-roles.decorator.ts
import { SetMetadata } from '@nestjs/common'
export const Roles = (...roles: string[]) => SetMetadata('roles', roles)

// crm-backend/crm.module.ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { CrmController } from './crm.controller'
import { CrmService }    from './crm.service'

@Module({
  imports: [
    JwtModule.register({
      secret:       process.env.CRM_JWT_SECRET ?? 'crm-secret-change-me',
      signOptions:  { expiresIn: '8h' },
    }),
  ],
  controllers: [CrmController],
  providers:   [CrmService, CrmAuthGuard],
  exports:     [CrmService],
})
export class CrmModule {}