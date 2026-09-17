'use client'

import Link from 'next/link'
import { ArrowRight, Compass, Radar, ShieldCheck } from 'lucide-react'
import type { CreatorLane } from '@/lib/creator-lane-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

interface CreatorDiscoverProps {
  creatorLane?: CreatorLane
}

export default function CreatorDiscover({ creatorLane }: CreatorDiscoverProps) {
  const { creatorLane: contextLane } = useCreatorOS()
  const activeLane = creatorLane ?? contextLane
  const laneLabel = activeLane === 'evidence' ? 'bizonyítékvezérelt' : 'élményvezérelt'

  return (
    <div className="wv-destination" data-creator-lane={activeLane}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">Felfedezés · {laneLabel}</span>
          <h1>Csak valódi jelből lesz személyes lehetőség.</h1>
        </div>
        <span className="wv-heading-meta">Opportunity workspace<br />ellenőrzött adatokra vár</span>
      </header>

      <section className="wv-truth-hero" aria-labelledby="wv-discover-empty-title">
        <div className="wv-truth-hero-copy">
          <span className="wv-empty-mark"><Radar aria-hidden="true" /></span>
          <div>
            <span className="wv-eyebrow">Opportunity feed</span>
            <h2 id="wv-discover-empty-title">Még nincs biztonságosan betöltött, csatornádra szabott opportunity.</h2>
            <p>Nem helyettesítjük a hiányzó opportunity-adatforrást statikus trendekkel, kitalált score-okkal vagy személyre szabottnak látszó briefekkel.</p>
          </div>
        </div>

        <div className="wv-truth-explainer">
          <article>
            <Compass aria-hidden="true" />
            <div><strong>Mi jelenik majd meg itt?</strong><p>Csak olyan lehetőség, amelyhez valós jel, csatornailleszkedés és értelmezhető időzítés tartozik.</p></div>
          </article>
          <article>
            <ShieldCheck aria-hidden="true" />
            <div><strong>Miért üres most?</strong><p>A jelenlegi frontendhez nincs jóváhagyott opportunity-lista contract. Emiatt nincs aktív mentés, elutasítás vagy projektindítás.</p></div>
          </article>
        </div>

        <div className="wv-truth-actions">
          <Link href="/dashboard/channel-audit" className="wv-primary-action">Csatornaaudit megnyitása<ArrowRight aria-hidden="true" /></Link>
          <Link href="/dashboard/profile" className="wv-secondary-action">Creator Profile áttekintése</Link>
        </div>
      </section>
    </div>
  )
}
