'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'
import { armAuthSessionEnd, endAuthSession, rearmAuthSessionEnd } from '@/lib/auth-session-events'

/**
 * A védett dashboard-fa munkamenet-őre. Három helyzetet zár le, amelyben a
 * böngésző vagy a Next kliens a kiszolgáló ellenőrzése nélkül mutathatna
 * korábbi fiókadatot vagy egyenleget:
 *  1. a munkamenet ugyanebben vagy egy másik lapon megszűnik (SIGNED_OUT),
 *  2. a lap bfcache-ből tér vissza (pageshow, persisted),
 *  3. a Vissza/Előre lépés (popstate) a Router Cache-ből állít vissza egy
 *     védett bejegyzést ugyanazon a layouton belül, kiszolgálás nélkül.
 * A 2. és 3. eset a közös /api/credits olvasással revalidál; a 401-et a
 * kreditállapot kezeli (CreditBalanceProvider), és a munkamenetet lezárja.
 */
export default function AuthSessionGuard() {
  const { refreshCredits } = useCreditBalance()

  useEffect(() => {
    armAuthSessionEnd()
    const supabase = createClient()
    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') endAuthSession('signed-out-elsewhere')
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const revalidate = () => { void refreshCredits({ supersede: true }) }
    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted) return
      rearmAuthSessionEnd()
      revalidate()
    }
    window.addEventListener('pageshow', handlePageShow)
    window.addEventListener('popstate', revalidate)
    return () => {
      window.removeEventListener('pageshow', handlePageShow)
      window.removeEventListener('popstate', revalidate)
    }
  }, [refreshCredits])

  return null
}
