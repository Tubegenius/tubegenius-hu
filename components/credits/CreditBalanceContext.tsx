'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  CreditBalanceRequestCoordinator,
  fetchCreditBalance,
  type CreditBalance,
} from '@/lib/credit-balance-client'
import { CREDIT_MUTATION_COMPLETED_EVENT } from '@/lib/credit-balance-events'

type CreditBalanceStatus = 'loading' | 'ready' | 'error'

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
    } catch {
      if (!mountedRef.current || !coordinatorRef.current.isCurrent(request.id)) return null
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
