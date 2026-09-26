'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CreditBalanceRequestCoordinator,
  CreditBalanceUnauthorizedError,
  fetchCreditBalance,
  type CreditBalance,
} from '@/lib/credit-balance-client'
import { AUTH_SESSION_ENDED_EVENT, endAuthSession } from '@/lib/auth-session-events'
import { CREDIT_MUTATION_COMPLETED_EVENT } from '@/lib/credit-balance-events'

type CreditBalanceStatus = 'loading' | 'ready' | 'error' | 'signed-out'

interface CreditBalanceContextValue {
  credits: CreditBalance | null
  status: CreditBalanceStatus
  refreshCredits: (options?: { supersede?: boolean }) => Promise<CreditBalance | null>
}

const CreditBalanceContext = createContext<CreditBalanceContextValue | null>(null)

export function CreditBalanceProvider({ children }: { children: ReactNode }) {
  const coordinatorRef = useRef(new CreditBalanceRequestCoordinator())
  const mountedRef = useRef(true)
  const [credits, setCredits] = useState<CreditBalance | null>(null)
  const [status, setStatus] = useState<CreditBalanceStatus>('loading')

  const refreshCredits = useCallback(async (options?: { supersede?: boolean }) => {
    const request = coordinatorRef.current.request(fetchCreditBalance, options?.supersede === true)
    try {
      const nextCredits = await request.promise
      if (!mountedRef.current || !coordinatorRef.current.isCurrent(request.id)) return null
      setCredits(nextCredits)
      setStatus('ready')
      return nextCredits
    } catch (error) {
      if (!mountedRef.current || !coordinatorRef.current.isCurrent(request.id)) return null
      if (error instanceof CreditBalanceUnauthorizedError) {
        // A védett fa munkamenet nélkül él tovább (visszaállított oldal, lejárt
        // vagy máshol megszüntetett munkamenet): az egyenleg nem maradhat meg.
        setCredits(null)
        setStatus('signed-out')
        endAuthSession('unauthorized')
        return null
      }
      setStatus('error')
      return null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refreshCredits()
    return () => {
      mountedRef.current = false
      coordinatorRef.current.abort()
    }
  }, [refreshCredits])

  useEffect(() => {
    const clear = () => {
      coordinatorRef.current.abort()
      setCredits(null)
      setStatus('signed-out')
    }
    window.addEventListener(AUTH_SESSION_ENDED_EVENT, clear)
    return () => window.removeEventListener(AUTH_SESSION_ENDED_EVENT, clear)
  }, [])

  useEffect(() => {
    const reconcile = () => { void refreshCredits({ supersede: true }) }
    window.addEventListener(CREDIT_MUTATION_COMPLETED_EVENT, reconcile)
    return () => window.removeEventListener(CREDIT_MUTATION_COMPLETED_EVENT, reconcile)
  }, [refreshCredits])

  return (
    <CreditBalanceContext.Provider value={{ credits, status, refreshCredits }}>
      {children}
    </CreditBalanceContext.Provider>
  )
}

export function useCreditBalance(): CreditBalanceContextValue {
  const value = useContext(CreditBalanceContext)
  if (!value) throw new Error('useCreditBalance must be used inside CreditBalanceProvider')
  return value
}
