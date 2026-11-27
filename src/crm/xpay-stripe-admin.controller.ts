import { Body, CanActivate, Controller, ExecutionContext, Get, Header, Injectable, Post, Req, UseGuards } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { CrmAuthGuard, Roles } from './crm.module'
import { XpayStripeAdminService } from './xpay-stripe-admin.service'

@Injectable()
export class XpayStripeAdminGuard implements CanActivate {
  constructor(private readonly crm: CrmAuthGuard, private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest()
    const secret = process.env.XPAY_STRIPE_ADMIN_BRIDGE_KEY
    const authorization = req.headers.authorization
    if (secret && secret.length >= 32 && typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
      let claims: { sub?: string; scope?: string; exp?: number } | undefined
      try {
        claims = this.jwt.verify(authorization.slice(7), {
          secret, algorithms: ['HS256'], issuer: 'orbia-crm', audience: 'xpay-stripe-admin',
        })
      } catch {
        // A native CRM admin still authenticates with the existing guard.
      }
      const allowed = claims?.scope === 'stripe:manage'
        || (claims?.scope === 'stripe:read' && req.method === 'GET')
      if (claims && allowed && typeof claims.exp === 'number'
        && claims.exp <= Math.floor(Date.now() / 1000) + 60
        && typeof claims.sub === 'string' && /^[a-f0-9-]{36}$/.test(claims.sub)) {
        req.manager = { sub: claims.sub, role: 'admin' }
        return true
      }
    }
    return this.crm.canActivate(context)
  }
}

@Controller('crm/admin/xpay/stripe-accounts')
@UseGuards(XpayStripeAdminGuard)
@Roles('admin')
export class XpayStripeAdminController {
  constructor(private readonly accounts: XpayStripeAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.accounts.list()
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  connect(@Body() body: unknown, @Req() request: { manager: { sub: string } }) {
    return this.accounts.connect(body, request.manager.sub)
  }
}
