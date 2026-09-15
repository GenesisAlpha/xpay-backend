import { AsyncLocalStorage } from 'async_hooks'

// IP e navegador de quem fez a requisição no CRM. O middleware do CrmModule
// abre o contexto e o log de ações do seller lê daqui, sem precisar passar o
// request por todos os métodos do service.
export interface CrmRequestMeta {
  ip: string | null
  userAgent: string | null
}

const storage = new AsyncLocalStorage<CrmRequestMeta>()

export function requestMetaFrom(req: any): CrmRequestMeta {
  const forwarded = String(req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
  return {
    ip: forwarded || req?.ip || null,
    userAgent: req?.headers?.['user-agent'] ?? null,
  }
}

export function crmRequestContext(req: any, _res: any, next: () => void) {
  storage.run(requestMetaFrom(req), next)
}

export function currentCrmRequest(): CrmRequestMeta | null {
  return storage.getStore() ?? null
}
