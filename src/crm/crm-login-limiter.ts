// Limite de tentativas de login do CRM, em memória (o pay roda numa instância).
// Conta falhas por e-mail e por IP dentro da janela; login certo zera o e-mail.

export interface LoginLimiterOptions {
  windowMs: number
  maxPerEmail: number
  maxPerIp: number
}

const DEFAULTS: LoginLimiterOptions = { windowMs: 15 * 60_000, maxPerEmail: 5, maxPerIp: 20 }
const MAX_KEYS = 10_000

export class LoginAttemptLimiter {
  private readonly failures = new Map<string, number[]>()

  constructor(
    private readonly options: LoginLimiterOptions = DEFAULTS,
    private readonly now: () => number = Date.now,
  ) { }

  /** Milissegundos até poder tentar de novo; 0 quando está liberado. */
  retryAfterMs(email: string, ip: string | null): number {
    const waits = [
      this.waitFor(`email:${email}`, this.options.maxPerEmail),
      ip ? this.waitFor(`ip:${ip}`, this.options.maxPerIp) : 0,
    ]
    return Math.max(...waits)
  }

  recordFailure(email: string, ip: string | null) {
    if (this.failures.size > MAX_KEYS) this.sweep()
    const at = this.now()
    this.push(`email:${email}`, at)
    if (ip) this.push(`ip:${ip}`, at)
  }

  reset(email: string) {
    this.failures.delete(`email:${email}`)
  }

  private waitFor(key: string, max: number): number {
    const recent = this.recent(key)
    if (recent.length < max) return 0
    return Math.max(0, recent[recent.length - max] + this.options.windowMs - this.now())
  }

  private push(key: string, at: number) {
    this.failures.set(key, [...this.recent(key), at])
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.options.windowMs
    const list = (this.failures.get(key) ?? []).filter(at => at > cutoff)
    if (list.length) this.failures.set(key, list)
    else this.failures.delete(key)
    return list
  }

  private sweep() {
    for (const key of [...this.failures.keys()]) this.recent(key)
  }
}
