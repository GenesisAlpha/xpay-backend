jest.mock('../../lib/supabase.client', () => ({ supabase: {} }))
jest.mock('./own-account-finance.service', () => ({ OwnAccountFinanceService: class { } }))

import { PERMISSION_PROBES, probeStatus, summarizePermissions } from './own-account-permissions'
import { OwnAccountPermissionsService } from './own-account-permissions.service'

const ACCOUNTS: Record<string, any> = {
  stripel_1: { id: 'stripel_1', provider: 'stripe' },
  whopl_biz_1: { id: 'whopl_biz_1', provider: 'whop' },
}

function setup(statusOf: (url: string) => number) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = []
  const finance: any = {
    resolveAccount: jest.fn(async (_seller: string, id: string) => ({
      account: ACCOUNTS[id],
      credentials: { id, apiKey: `key-${id}`, config: { seller_id: 's-1', company_id: 'biz_1' } },
    })),
  }
  const service = new OwnAccountPermissionsService(finance)
  service.fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers ?? {} })
    const status = statusOf(url)
    if (status === 0) throw new Error('rede fora')
    return { ok: status < 400, status, json: async () => ({}) }
  }
  return { service, calls }
}

describe('permissões da chave das contas próprias', () => {
  it('só 403 (e 401 na Whop) acusa falta de permissão', () => {
    expect(probeStatus('stripe', 200)).toBe('ok')
    expect(probeStatus('stripe', 403)).toBe('missing')
    expect(probeStatus('stripe', 401)).toBe('unknown')
    expect(probeStatus('whop', 401)).toBe('missing')
    expect(probeStatus('paypal', 403)).toBe('missing')
    expect(probeStatus('stripe', 500)).toBe('unknown')
    expect(probeStatus('stripe', null)).toBe('unknown')
  })

  it('todas as leituras são GET e não mudam nada na conta dele', async () => {
    const { service, calls } = setup(() => 200)
    const result = await service.check('s-1', 'stripel_1')
    expect(calls.every(call => call.method === 'GET')).toBe(true)
    expect(calls.map(call => call.url)).toEqual(PERMISSION_PROBES.stripe.map(probe => `https://api.stripe.com${probe.path}`))
    expect(result).toEqual({
      accountId: 'stripel_1',
      provider: 'stripe',
      complete: true,
      checks: [{ key: 'finance', status: 'ok', missing: [] }, { key: 'wallets', status: 'ok', missing: [] }],
    })
  })

  it('Stripe com chave restrita sem repasses e sem domínios: diz o que ativar', async () => {
    const { service } = setup(url => url.includes('/v1/balance') ? 200 : 403)
    const result = await service.check('s-1', 'stripel_1')
    expect(result.complete).toBe(false)
    expect(result.checks).toEqual([
      { key: 'finance', status: 'missing', missing: ['Payouts — Write'] },
      { key: 'wallets', status: 'missing', missing: ['Payment Method Domains — Write'] },
    ])
  })

  it('Whop sem saldo: pede as de saldo e, junto, a de saque (que não dá para conferir lendo)', async () => {
    const { service, calls } = setup(url => url.includes('ledger_accounts') ? 403 : 200)
    const result = await service.check('s-1', 'whopl_biz_1')
    expect(calls[0].url).toBe('https://api.whop.com/api/v1/ledger_accounts/biz_1')
    expect(calls[0].headers.Authorization).toBe('Bearer key-whopl_biz_1')
    expect(result.checks[0]).toEqual({ key: 'finance', status: 'missing', missing: ['company:balance:read', 'payout:withdraw_funds'] })
    expect(result.checks[1]).toEqual({ key: 'wallets', status: 'ok', missing: [] })
  })

  it('provedor fora do ar não vira "falta permissão"', async () => {
    const { service } = setup(() => 0)
    const result = await service.check('s-1', 'stripel_1')
    expect(result.complete).toBe(true)
    expect(result.checks.every(item => item.status === 'unknown' && item.missing.length === 0)).toBe(true)
  })

  it('um grupo só fica ok com todas as leituras dele certas', () => {
    const [finance] = PERMISSION_PROBES.stripe
    expect(summarizePermissions('stripe', [
      { probe: finance, status: 'ok' },
      { probe: PERMISSION_PROBES.stripe[1], status: 'unknown' },
    ])).toEqual([{ key: 'finance', status: 'unknown', missing: [] }])
  })
})
