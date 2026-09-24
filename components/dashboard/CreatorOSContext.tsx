'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { CreatorLane } from '@/lib/creator-lane-presentation'

interface CreatorOSContextValue {
  creatorLane: CreatorLane
  setCreatorLane: (lane: CreatorLane) => void
}

const CreatorOSContext = createContext<CreatorOSContextValue>({
  creatorLane: 'evidence',
  setCreatorLane: () => undefined,
})

export function CreatorOSProvider({ children }: { children: ReactNode }) {
  const [creatorLane, setCreatorLane] = useState<CreatorLane>('evidence')
  const value = useMemo(() => ({ creatorLane, setCreatorLane }), [creatorLane])

  return <CreatorOSContext.Provider value={value}>{children}</CreatorOSContext.Provider>
}

export function useCreatorOS(): CreatorOSContextValue {
  return useContext(CreatorOSContext)
}
