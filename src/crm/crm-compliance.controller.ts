import { BadGatewayException, BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { CrmAuthGuard, Roles } from './crm.module'

/**
 * Compliance no CRM (Política de Uso Aceitável — exigência da Kaja Payments).
 *
 * Fila de revisão, casos e reembolsos ficam no checkout (internal/compliance);
 * este controller só repassa com a chave interna e assina cada ação com o
 * gestor logado (actor = "crm:<e-mail>"). Supervisor lê; só admin age.
 */
const base = () => (process.env.CHECKOUT_API_BASE ?? 'http://127.0.0.1:3006').replace(/\/+$/, '')

async function checkout<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
  const key = process.env.CHECKOUT_INTERNAL_KEY ?? ''
  if (!key) throw new BadGatewayException('CHECKOUT_INTERNAL_KEY não configurada no serviço de pagamentos.')
  const qs = new URLSearchParams(Object.entries(init.query ?? {}).filter(([, v]) => v) as Array<[string, string]>).toString()
  const res = await fetch(`${base()}/internal/compliance/${path}${qs ? `?${qs}` : ''}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // Remover produto cancela pedidos e pede reembolsos: pode passar de 8 s.
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const message = data?.message ?? `o checkout respondeu HTTP ${res.status}`
    if (res.status === 400) throw new BadRequestException(message)
    throw new BadGatewayException(message)
  }
  return data as T
}

function actorOf(req: any): string {
  const m = req.manager
  if (!m) throw new Error('req.manager está vazio — CrmAuthGuard não foi aplicado?')
  return `crm:${m.email ?? m.sub}`
}

@Controller('crm/compliance')
@UseGuards(CrmAuthGuard)
@Roles('admin', 'supervisor')
export class CrmComplianceController {
  @Get('queue')
  queue() { return checkout('queue') }

  @Get('cases')
  cases(@Query('workspaceId') workspaceId?: string, @Query('productId') productId?: string) {
    return checkout('cases', { query: { workspaceId, productId } })
  }

  @Get('refunds')
  refunds(@Query('status') status?: string) { return checkout('refunds', { query: { status } }) }

  @Post('refunds/run')
  @Roles('admin')
  @HttpCode(200)
  runRefunds() { return checkout('refunds/run', { method: 'POST', body: {} }) }

  @Post('products/:id/review')
  @Roles('admin')
  @HttpCode(200)
  review(@Req() req: any, @Param('id') id: string, @Body() body: { decision?: string; reason?: string; brandAuthorizationUrl?: string }) {
    return checkout(`products/${encodeURIComponent(id)}/review`, { method: 'POST', body: { ...body, actor: actorOf(req) } })
  }

  @Post('products/:id/remove')
  @Roles('admin')
  @HttpCode(200)
  remove(@Req() req: any, @Param('id') id: string, @Body() body: { reason?: string; source?: string; evidence?: unknown }) {
    return checkout(`products/${encodeURIComponent(id)}/remove`, { method: 'POST', body: { ...body, actor: actorOf(req) } })
  }

  /** Aviso de bandeira, parceiro de pagamento ou autoridade: age na hora. */
  @Post('notices')
  @Roles('admin')
  @HttpCode(200)
  notice(@Req() req: any, @Body() body: { source?: string; reason?: string; productId?: string; workspaceId?: string; evidence?: unknown }) {
    return checkout('notices', { method: 'POST', body: { ...body, actor: actorOf(req) } })
  }

  @Post('sellers/:workspaceId/terminate')
  @Roles('admin')
  @HttpCode(200)
  terminate(@Req() req: any, @Param('workspaceId') workspaceId: string, @Body() body: { reason?: string; source?: string; identifiers?: Record<string, string[]>; evidence?: unknown }) {
    return checkout(`sellers/${encodeURIComponent(workspaceId)}/terminate`, { method: 'POST', body: { ...body, actor: actorOf(req) } })
  }
}
