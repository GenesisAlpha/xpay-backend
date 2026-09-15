import { LoginAttemptLimiter } from './crm-login-limiter'

describe('LoginAttemptLimiter', () => {
  let clock = 0
  const limiter = () => new LoginAttemptLimiter({ windowMs: 60_000, maxPerEmail: 3, maxPerIp: 5 }, () => clock)

  beforeEach(() => { clock = 1_000_000 })

  it('blocks an email after too many failures until the window passes', () => {
    const l = limiter()
    for (let i = 0; i < 3; i++) { l.recordFailure('a@x.com', '1.1.1.1'); clock += 1000 }
    // Falhas em t, t+1s e t+2s; relógio em t+3s: libera quando a de t sai da janela.
    expect(l.retryAfterMs('a@x.com', '9.9.9.9')).toBe(57_000)
    clock += 57_000
    expect(l.retryAfterMs('a@x.com', '9.9.9.9')).toBe(0)
  })

  it('blocks an IP trying many emails', () => {
    const l = limiter()
    for (let i = 0; i < 5; i++) l.recordFailure(`u${i}@x.com`, '2.2.2.2')
    expect(l.retryAfterMs('new@x.com', '2.2.2.2')).toBeGreaterThan(0)
    expect(l.retryAfterMs('new@x.com', '3.3.3.3')).toBe(0)
  })

  it('clears the email after a successful login', () => {
    const l = limiter()
    for (let i = 0; i < 3; i++) l.recordFailure('a@x.com', null)
    l.reset('a@x.com')
    expect(l.retryAfterMs('a@x.com', null)).toBe(0)
  })
})
