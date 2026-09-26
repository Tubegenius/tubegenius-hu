export const CREDIT_BALANCE_UPDATED_EVENT = 'willviral:credit-balance-updated'
export const CREDIT_MUTATION_COMPLETED_EVENT = 'willviral:credit-mutation-completed'

export const CREDIT_MUTATION_RESPONSE_CONTRACTS = {
  '/api/channel-audit': { balanceField: '_credits_remaining' },
  '/api/video-audit': { balanceField: null },
  '/api/video-package': { balanceField: '_credits_remaining' },
  '/api/title-studio': { balanceField: '_credits_remaining' },
  '/api/thumbnail-studio': { balanceField: '_credits_remaining' },
  '/api/seo-optimizer': { balanceField: '_credits_remaining' },
  '/api/youtube/discover-niche': { balanceField: '_credits_remaining', chargedField: 'charged' },
  '/api/dashboard/tracked-trends/deep-refresh': { balanceField: 'new_balance' },
  '/api/viral-score': { balanceField: null },
  '/api/transcript': { balanceField: '_credits_remaining' },
  '/api/script-extract': { balanceField: '_credits_remaining' },
  '/api/content-gap': { balanceField: '_credits_remaining' },
  '/api/keyword-research': { balanceField: '_credits_remaining' },
  '/api/competitors': { balanceField: '_credits_remaining' },
  '/api/competitors/[id]/refresh': { balanceField: '_credits_remaining' },
  '/api/opportunity': { balanceField: null, chargedField: 'charged' },
  '/api/opportunity-similar': { balanceField: null },
  '/api/opportunity-explain': { balanceField: null },
  '/api/similar-videos': { balanceField: null },
} as const

export type CreditMutationRoute = keyof typeof CREDIT_MUTATION_RESPONSE_CONTRACTS

export interface CreditMutationResponseAudit {
  route: CreditMutationRoute
  declaredBalance: number | null
  charged: boolean | null
}

export function auditCreditMutationResponse(route: CreditMutationRoute, payload: unknown): CreditMutationResponseAudit {
  const contract = CREDIT_MUTATION_RESPONSE_CONTRACTS[route]
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const rawBalance = contract.balanceField ? record[contract.balanceField] : null
  const declaredBalance = typeof rawBalance === 'number' && Number.isFinite(rawBalance) && rawBalance >= 0
    ? rawBalance
    : null
  const chargedField = 'chargedField' in contract ? contract.chargedField : null
  const charged = chargedField && typeof record[chargedField] === 'boolean' ? record[chargedField] as boolean : null
  return { route, declaredBalance, charged }
}

// A response auditált egyenlegmezője diagnosztikai információ. A látható
// egyenleget soha nem ebből becsüljük: az esemény a közös /api/credits
// újraolvasását indítja el.
export function publishCreditMutationCompleted(route: CreditMutationRoute, payload: unknown) {
  if (typeof window === 'undefined') return
  const audit = auditCreditMutationResponse(route, payload)
  window.dispatchEvent(new CustomEvent<CreditMutationResponseAudit>(CREDIT_MUTATION_COMPLETED_EVENT, { detail: audit }))
}

export function publishCreditBalance(balance: number) {
  if (typeof window === 'undefined' || !Number.isFinite(balance)) return

  window.dispatchEvent(new CustomEvent<number>(CREDIT_BALANCE_UPDATED_EVENT, {
    detail: balance,
  }))
}

