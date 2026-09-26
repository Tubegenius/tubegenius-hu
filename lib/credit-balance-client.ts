export interface CreditBalance {
  balance: number
  total_available_credits: number
  subscription_credit_balance: number | null
  purchased_credit_balance: number | null
  total_used: number | null
  plan: string | null
  monthly_allowance: number | null
  renews_at: string | null
  subscription_status: string | null
}

export class CreditBalanceUnauthorizedError extends Error {
  constructor() {
    super('credit_balance_unauthorized')
    this.name = 'CreditBalanceUnauthorizedError'
  }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseCreditBalanceResponse(value: unknown): CreditBalance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const balance = finiteNonNegative(record.balance)
  if (balance === null) return null

  const totalAvailable = finiteNonNegative(record.total_available_credits)
  return {
    balance,
    total_available_credits: totalAvailable ?? balance,
    subscription_credit_balance: finiteNonNegative(record.subscription_credit_balance),
    purchased_credit_balance: finiteNonNegative(record.purchased_credit_balance),
    total_used: finiteNonNegative(record.total_used),
    plan: typeof record.plan === 'string' ? record.plan : null,
    monthly_allowance: finiteNonNegative(record.monthly_allowance),
    renews_at: typeof record.renews_at === 'string' ? record.renews_at : null,
    subscription_status: typeof record.subscription_status === 'string' ? record.subscription_status : null,
  }
}

export async function fetchCreditBalance(signal?: AbortSignal): Promise<CreditBalance> {
  const response = await fetch('/api/credits', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })
  if (response.status === 401) throw new CreditBalanceUnauthorizedError()
  if (!response.ok) throw new Error('credit_balance_unavailable')
  const parsed = parseCreditBalanceResponse(await response.json())
  if (!parsed) throw new Error('credit_balance_invalid_contract')
  return parsed
}

export interface CreditBalanceRequest {
  id: number
  promise: Promise<CreditBalance>
}

/**
 * Deduplikálja a párhuzamos olvasásokat. A supersede kérés megszakítja a
 * korábbi olvasást, és az id alapján akkor is felismerhető a későn érkező
 * válasz, ha az alatta lévő fetch-implementáció figyelmen kívül hagyja az
 * AbortSignal-t.
 */
export class CreditBalanceRequestCoordinator {
  private sequence = 0
  private current: (CreditBalanceRequest & { controller: AbortController }) | null = null

  request(fetcher: (signal: AbortSignal) => Promise<CreditBalance>, supersede = false): CreditBalanceRequest {
    if (this.current && !supersede) return this.current
    if (supersede) this.current?.controller.abort()

    const controller = new AbortController()
    const id = ++this.sequence
    const promise = fetcher(controller.signal)
    this.current = { id, promise, controller }
    void promise.finally(() => {
      if (this.current?.id === id) this.current = null
    }).catch(() => undefined)
    return { id, promise }
  }

  isCurrent(id: number): boolean {
    return id === this.sequence
  }

  abort(): void {
    this.current?.controller.abort()
    this.current = null
    this.sequence += 1
  }
}
