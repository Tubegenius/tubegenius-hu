'use client'

import { useEffect } from 'react'

/**
 * Az auth-oldalak őre. Ha a dokumentum eredetileg védett /dashboard oldalként
 * töltődött be, és soft navigációval (pl. a szerver redirectjével) került
 * ide, akkor a lapon még ott marad a korábbi oldal RSC-payloadja (fiókadat) a
 * memóriában és a DOM script-elemeiben. Egyetlen újratöltés eldobja.
 * Nincs hurok: az újratöltés után a navigációs bejegyzés már az auth oldal.
 */
export default function StaleSessionDocumentPurge() {
  useEffect(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (!entry) return
    let loadedPath: string
    try { loadedPath = new URL(entry.name).pathname } catch { return }
    if (loadedPath.startsWith('/dashboard') && window.location.pathname.startsWith('/auth/')) {
      window.location.reload()
    }
  }, [])

  return null
}
