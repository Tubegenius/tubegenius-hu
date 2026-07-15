export async function fetchWithDailySoftLimit(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status !== 429) return response

  const body = await response.clone().json().catch(() => null) as {
    requires_soft_limit_override?: boolean
    requiresSoftLimitOverride?: boolean
    message?: string
  } | null
  if (!body?.requires_soft_limit_override && !body?.requiresSoftLimitOverride) return response
  if (typeof window === 'undefined' || !window.confirm(`${body.message || 'Elérted a napi ajánlott keretet.'}\n\nSzeretnéd ennek ellenére folytatni?`)) return response

  const headers = new Headers(init?.headers)
  headers.set('x-daily-soft-limit-override', 'true')
  return fetch(input, { ...init, headers })
}
