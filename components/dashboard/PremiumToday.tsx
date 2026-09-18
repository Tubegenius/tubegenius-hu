'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, BookOpen, CircleDot, Compass, UserRound } from 'lucide-react'
import type { CreatorProfile } from '@/types'
import { CREATOR_LANE_PRESENTATION, type CreatorLane } from '@/lib/creator-lane-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

interface PremiumTodayProps {
  profile: CreatorProfile | null
  displayName: string
  memoryCount: number
  creatorLane?: CreatorLane
}

function localGreeting(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 10) return 'Jó reggelt'
  if (hour >= 18 && hour < 23) return 'Jó estét'
  return 'Szia'
}

export default function PremiumToday({ profile, displayName, memoryCount, creatorLane: creatorLaneOverride }: PremiumTodayProps) {
  const { creatorLane: contextLane } = useCreatorOS()
  const creatorLane = creatorLaneOverride ?? contextLane
  const [greeting, setGreeting] = useState('Szia')
  const profileReady = Boolean(profile?.niche || profile?.specific_focus)
  const hasMemory = memoryCount > 0
  const lane = CREATOR_LANE_PRESENTATION[creatorLane]

  useEffect(() => setGreeting(localGreeting()), [])

  return (
    <div className="wv-today" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">{greeting}, {displayName}</span>
          <h1>A következő biztos lépésed innen indul.</h1>
        </div>
        <span className="wv-heading-meta">
          Creator workspace<br />
          {lane.label} alkotói mód
        </span>
      </header>

      <section className="wv-truth-hero" aria-labelledby="wv-today-state-title">
        <div className="wv-truth-hero-copy">
          <span className="wv-empty-mark"><Compass aria-hidden="true" /></span>
          <div>
            <span className="wv-eyebrow">Mai fókusz</span>
            <h2 id="wv-today-state-title">Még nincs valós adatokból meghatározott aktív projekt vagy napi opportunity.</h2>
            <p>A WillViral csak akkor mutat személyes következő lépést, amikor azt a csatornaprofilod, a mentett tartalmaid vagy egy működő opportunity-adatforrás ténylegesen alátámasztja.</p>
          </div>
        </div>

        <div className="wv-truth-status-grid" aria-label="Elérhető alkotói kontextus">
          <article>
            <UserRound aria-hidden="true" />
            <span><small>Creator Profile</small><strong>{profileReady ? 'Rögzítve' : 'Kiegészítés szükséges'}</strong></span>
            <p>{profileReady ? (profile?.specific_focus || profile?.niche) : 'Add meg a csatornád fókuszát, hogy a későbbi ajánlások valódi kontextusból induljanak.'}</p>
          </article>
          <article>
            <BookOpen aria-hidden="true" />
            <span><small>Alkotói memória</small><strong>{hasMemory ? `${memoryCount} mentett elem` : 'Még üres'}</strong></span>
            <p>{hasMemory ? 'A meglévő elemeket a Tartalmak munkatérben folytathatod.' : 'Mentett tartalom nélkül nem állítunk elő személyre szabott előzményt.'}</p>
          </article>
          <article>
            <CircleDot aria-hidden="true" />
            <span><small>Aktív projekt</small><strong>Nincs biztonságosan betöltve</strong></span>
            <p>Nem mutatunk kitalált projektállapotot vagy becsült előrehaladást.</p>
          </article>
        </div>

        <div className="wv-truth-actions">
          {!profileReady ? (
            <Link href="/dashboard/profile" className="wv-primary-action">Creator Profile beállítása<ArrowRight aria-hidden="true" /></Link>
          ) : hasMemory ? (
            <Link href="/dashboard/library" className="wv-primary-action">Mentett tartalmak megnyitása<ArrowRight aria-hidden="true" /></Link>
          ) : (
            <Link href="/dashboard/channel-audit" className="wv-primary-action">Csatornaaudit megnyitása<ArrowRight aria-hidden="true" /></Link>
          )}
          <Link href="/dashboard/create" className="wv-secondary-action">Saját ötlet előkészítése</Link>
        </div>
      </section>
    </div>
  )
}
