'use client'

import { useEffect } from 'react'

export default function DailySoftLimitGuard() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init)
      if (response.status !== 429) return response
      const body = await response.clone().json().catch(() => null) as {
        requires_soft_limit_override?: boolean
        requiresSoftLimitOverride?: boolean
        message?: string
      } | null
      if (!body?.requires_soft_limit_override && !body?.requiresSoftLimitOverride) return response
      if (!window.confirm(`${body.message || 'Elérted a napi ajánlott keretet.'}\n\nSzeretnéd ennek ellenére folytatni?`)) return response
      const headers = new Headers(init?.headers)
      headers.set('x-daily-soft-limit-override', 'true')
      return originalFetch(input, { ...init, headers })
    }
    return () => { window.fetch = originalFetch }
  }, [])
  return null
}
