// src/crm/crm-checkout.service.ts
//
// A visão do CHECKOUT dentro do CRM: quem é a pessoa (seller) e quais são as
// lojas dela. Esses dados são do checkout — aqui só repassamos o canal interno
// (`/internal/admin`, só leitura) e COSTURAMOS o lado do pay.
//
// A costura é o motivo deste serviço existir. O CRM enxerga o mundo pela conta
// de pagamento (seller_profiles); o checkout, pela loja. Sem juntar os dois, o
// gestor abre a ficha do seller e não descobre de qual conta sai o dinheiro das
// lojas dele — que é justamente a pergunta que ele faz.

import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { supabase } from '../lib/supabase.client'
import { normalizeEmail } from '../integration/seller-accounts'
import { checkoutFailureMessage, checkoutInternal } from './checkout-internal'

// ─── O que o checkout devolve (só o que costuramos daqui) ────────────────────
//
// As demais chaves passam intactas para a tela: o index signature evita
// reescrever aqui um contrato que é do checkout.

interface CheckoutWorkspaceRef {
  id?: string
  name?: string | null
  sellerId?: string | null
  [extra: string]: unknown
}

export interface CheckoutSellerDetail {
  seller?: { id?: string; email?: string | null; [extra: string]: unknown } | null
  workspaces?: CheckoutWorkspaceRef[] | null
  paymentAccounts?: unknown
  [extra: string]: unknown
}

export interface CheckoutStoreDetail {
  paymentAccount?: { sellerId?: string | null; [extra: string]: unknown } | null
  // Usados na troca de conta: o dono manda em quais contas podem receber as
  // vendas da loja, e o nome entra no log de ações.
  owner?: { id?: string; name?: string | null; email?: string | null } | null
  workspace?: { id?: string; name?: string | null; [extra: string]: unknown } | null
  [extra: string]: unknown
}

// ─── Linhas do pay ───────────────────────────────────────────────────────────

interface UserRow {
  id: string
  name: string | null
  email: string | null
  owner_user_id: string | null
}

interface SellerProfileRow {
  id: string
  user_id: string | null
  name: string | null
  status: string | null
  risk_level: string | null
  created_at: string | null
  provider_default?: string | null
}

interface WalletBalanceRow {
  seller_id: string
  available_balance: number | string | null
  pending_balance: number | string | null
  reserved_balance: number | string | null
  withdrawing_balance: number | string | null
}

/** Saldo em centavos, como está gravado em `wallet_balance`. */
interface AccountBalance {
  availableCents: number
  pendingCents: number
  reservedCents: number
  withdrawingCents: number
}

/** Conta de pagamento do pay, já dizendo se alguma loja do checkout a usa. */
interface PaymentAccountView {
  sellerId: string
  name: string | null
  status: string | null
  riskLevel: string | null
  /** É a conta principal do e-mail (as outras são contas a mais do mesmo dono). */
  isOwnerAccount: boolean
  balance: AccountBalance | null
  /** Alguma loja do checkout cobra por esta conta. */
  inUse: boolean
  /** Quais lojas — o gestor precisa saber qual conta mexe em qual loja. */
  workspaceIds: string[]
}

const cents = (value: number | string | null | undefined): number => Number(value ?? 0) || 0

@Injectable()
export class CrmCheckoutService {
  // ─── Repasse puro ──────────────────────────────────────────────────────────

  async overview(): Promise<unknown> {
    return this.fetchOrFail('admin/overview', 'carregar a visão geral do checkout')
  }

  /** Listagem: só repassa. Enriquecer linha a linha aqui seria um N+1 por página. */
  async listSellers(params: { search?: string; page?: string; pageSize?: string }): Promise<unknown> {
    const qs = this.query(params)
    return this.fetchOrFail(`admin/sellers${qs}`, 'listar os sellers do checkout')
  }

  async listStores(params: {
    search?: string
    status?: string
    page?: string
    pageSize?: string
  }): Promise<unknown> {
    const qs = this.query(params)
    return this.fetchOrFail(`admin/workspaces${qs}`, 'listar as lojas do checkout')
  }

  // ─── Ficha do seller: checkout + contas do pay ─────────────────────────────

  /**
   * O elo entre os dois lados é o E-MAIL (login unificado). A partir dele achamos
   * o usuário do pay e as contas a mais que ele criou (`users.owner_user_id`),
   * cada uma com o seu `seller_profiles`.
   */
  async seller(userId: string): Promise<CheckoutSellerDetail> {
    const detail = await this.fetchOrFail<CheckoutSellerDetail>(
      `admin/sellers/${encodeURIComponent(userId)}`,
      'carregar o seller no checkout',
    )

    const email = normalizeEmail(detail.seller?.email)
    const stores = (detail.workspaces ?? []).filter(Boolean)

    // Lojas por conta de pagamento: é o que marca quais contas estão em uso.
    const storesByAccount = new Map<string, string[]>()
    for (const store of stores) {
      const account = String(store.sellerId ?? '').trim()
      if (!account || !store.id) continue
      storesByAccount.set(account, [...(storesByAccount.get(account) ?? []), String(store.id)])
    }
    for (const account of Array.isArray(detail.paymentAccounts) ? detail.paymentAccounts : []) {
      const id = String(account ?? '').trim()
      if (id && !storesByAccount.has(id)) storesByAccount.set(id, [])
    }

    return {
      ...detail,
      paymentAccounts: await this.paymentAccountsOf(email, storesByAccount),
    }
  }

  // ─── Ficha da loja: checkout + a conta que ela usa ─────────────────────────

  async store(workspaceId: string): Promise<CheckoutStoreDetail> {
    const detail = await this.fetchOrFail<CheckoutStoreDetail>(
      `admin/workspaces/${encodeURIComponent(workspaceId)}`,
      'carregar a loja no checkout',
    )

    const sellerId = String(detail.paymentAccount?.sellerId ?? '').trim()
    if (!sellerId) return detail

    // O checkout só sabe o id da conta. De quem ela é, e em que estado está,
    // quem responde é o pay.
    const { data } = await supabase
      .from('seller_profiles')
      .select('id, name, status, risk_level, provider_default')
      .eq('id', sellerId)
      .maybeSingle()
    const account = data as SellerProfileRow | null

    return {
      ...detail,
      paymentAccount: {
        ...(detail.paymentAccount ?? {}),
        account: account
          ? {
            sellerId: account.id,
            name: account.name ?? null,
            status: account.status ?? null,
            riskLevel: account.risk_level ?? null,
            providerDefault: account.provider_default ?? null,
          }
          : null,
      },
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Contas Koopfy Payments do e-mail: a principal e as contas a mais criadas por
   * ela. As que alguma loja usa e não são dele (conta de sócio, por exemplo)
   * entram no fim — o gestor precisa ver que a loja cobra por uma conta de fora.
   */
  private async paymentAccountsOf(
    email: string,
    storesByAccount: Map<string, string[]>,
  ): Promise<PaymentAccountView[]> {
    const ownAccounts = await this.accountsOfEmail(email)
    const known = new Set(ownAccounts.map(account => account.id))

    const foreignIds = [...storesByAccount.keys()].filter(id => !known.has(id))
    const foreign = foreignIds.length ? await this.accountsByIds(foreignIds) : []

    const rows = [...ownAccounts, ...foreign]
    const balances = await this.balancesOf(rows.map(row => row.id))

    return rows.map(row => ({
      sellerId: row.id,
      name: row.name ?? null,
      status: row.status ?? null,
      riskLevel: row.risk_level ?? null,
      isOwnerAccount: row.isOwnerAccount,
      balance: balances.get(row.id) ?? null,
      inUse: storesByAccount.has(row.id),
      workspaceIds: storesByAccount.get(row.id) ?? [],
    }))
  }

  private async accountsOfEmail(email: string): Promise<Array<SellerProfileRow & { isOwnerAccount: boolean }>> {
    if (!email) return []

    const { data: ownerRow } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    const owner = ownerRow as { id: string } | null
    if (!owner) return []

    // A conta principal é o usuário do e-mail; as contas a mais são usuários
    // internos criados por ele (owner_user_id), cada um com o seu seller.
    const { data: userRows } = await supabase
      .from('users')
      .select('id, name, email, owner_user_id')
      .or(`id.eq.${owner.id},owner_user_id.eq.${owner.id}`)
    const users = (userRows ?? []) as UserRow[]
    if (!users.length) return []

    const { data: sellerRows } = await supabase
      .from('seller_profiles')
      .select('id, user_id, name, status, risk_level, created_at')
      .in('user_id', users.map(user => user.id))

    const byUser = new Map(users.map(user => [user.id, user]))

    return ((sellerRows ?? []) as SellerProfileRow[])
      .map(seller => ({
        ...seller,
        name: seller.name ?? byUser.get(String(seller.user_id))?.name ?? null,
        isOwnerAccount: seller.user_id === owner.id,
      }))
      .sort((a, b) =>
        Number(b.isOwnerAccount) - Number(a.isOwnerAccount) ||
        String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
  }

  private async accountsByIds(ids: string[]): Promise<Array<SellerProfileRow & { isOwnerAccount: boolean }>> {
    const { data } = await supabase
      .from('seller_profiles')
      .select('id, user_id, name, status, risk_level, created_at')
      .in('id', ids)

    return ((data ?? []) as SellerProfileRow[]).map(seller => ({ ...seller, isOwnerAccount: false }))
  }

  private async balancesOf(sellerIds: string[]): Promise<Map<string, AccountBalance>> {
    const map = new Map<string, AccountBalance>()
    if (!sellerIds.length) return map

    const { data } = await supabase
      .from('wallet_balance')
      .select('seller_id, available_balance, pending_balance, reserved_balance, withdrawing_balance')
      .in('seller_id', sellerIds)

    for (const row of (data ?? []) as WalletBalanceRow[]) {
      map.set(String(row.seller_id), {
        availableCents: cents(row.available_balance),
        pendingCents: cents(row.pending_balance),
        reservedCents: cents(row.reserved_balance),
        withdrawingCents: cents(row.withdrawing_balance),
      })
    }
    return map
  }

  /** Query string só com o que veio preenchido. */
  private query(params: Record<string, string | undefined>): string {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      const clean = String(value ?? '').trim()
      if (clean) qs.set(key, clean)
    }
    const text = qs.toString()
    return text ? `?${text}` : ''
  }

  /**
   * Checkout fora do ar é 503 com a causa provável, não uma tela vazia: o gestor
   * precisa saber que o dado não existe HOJE, e não que o seller não tem lojas.
   */
  private async fetchOrFail<T>(path: string, acao: string): Promise<T> {
    const res = await checkoutInternal<T>(path)
    if (res === null) throw new ServiceUnavailableException(checkoutFailureMessage(acao))
    return res
  }

  // ─── Ações (só admin; o controller cuida do papel) ─────────────────────────

  /**
   * Troca, ou desfaz, a conta Koopfy Payments que a loja usa.
   *
   * Isto redireciona dinheiro: as vendas da loja passam a cair na conta nova.
   * Por isso a conta precisa ser do MESMO dono da loja — a conta principal do
   * e-mail dele ou uma das contas a mais (`users.owner_user_id`). Apontar a loja
   * de um seller para a conta de outro é sempre engano ou fraude.
   */
  async setStoreAccount(workspaceId: string, sellerId: string | null, ctx: { managerId: string }) {
    const store = await this.fetchOrFail<CheckoutStoreDetail>(
      `admin/workspaces/${encodeURIComponent(workspaceId)}`,
      'carregar a loja no checkout',
    )

    const ownerEmail = normalizeEmail(store.owner?.email as string | undefined)
    let account: (SellerProfileRow & { isOwnerAccount: boolean }) | undefined

    if (sellerId) {
      if (!ownerEmail) {
        throw new BadRequestException('A loja não tem dono com e-mail no checkout: não dá para conferir a conta.')
      }
      const allowed = await this.accountsOfEmail(ownerEmail)
      account = allowed.find((candidate) => candidate.id === sellerId)
      if (!account) {
        throw new BadRequestException(
          'Esta conta de pagamento não é do dono da loja. Só a conta principal dele ou uma das contas a mais pode receber as vendas desta loja.',
        )
      }
    }

    const result = await checkoutInternal<{ workspaceId: string; previousSellerId: string | null; sellerId: string | null; unlinked: boolean }>(
      `admin/workspaces/${encodeURIComponent(workspaceId)}/payment-account`,
      { sellerId, managerId: ctx.managerId },
    )
    if (result === null) {
      throw new ServiceUnavailableException(checkoutFailureMessage('mudar a conta de pagamento da loja'))
    }

    return { ...result, accountName: account?.name ?? null, storeName: store.workspace?.name ?? null }
  }

  /**
   * Reenvia à Shopify um pedido pago que não chegou lá. O checkout recusa pedido
   * já sincronizado, então clicar duas vezes não cria pedido duplicado na loja.
   */
  async resendOrderToShopify(orderId: string, workspaceId: string) {
    if (!workspaceId) throw new BadRequestException('Informe a loja do pedido.')

    const result = await checkoutInternal<Record<string, unknown>>(
      `admin/orders/${encodeURIComponent(orderId)}/shopify`,
      { workspaceId },
    )
    if (result === null) throw new ServiceUnavailableException(checkoutFailureMessage('reenviar o pedido para a Shopify'))
    return result
  }
}
