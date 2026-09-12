'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowUpRight,
  Brain,
  Check,
  FileCheck2,
  Link2,
  Pause,
  Play,
  Radar,
} from 'lucide-react'
import type { CreatorProfile } from '@/types'
import { CREATOR_LANE_PRESENTATION, type CreatorLane } from '@/lib/creator-lane-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

interface PremiumTodayProps {
  profile: CreatorProfile | null
  displayName: string
  memoryCount: number
  creatorLane?: CreatorLane
}

const pulseItems = [
  ['Oktatási alkotó', 'Egyesült Királyság', 'Formátumjel · 26 óra'],
  ['Dokumentumalkotó', 'Egyesült Államok', 'Megugró megtartás'],
  ['Tudományos alkotó', 'Németország', 'Új vizuális minta'],
] as const

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
  const [pulsePaused, setPulsePaused] = useState(false)
  const lane = CREATOR_LANE_PRESENTATION[creatorLane]

  useEffect(() => setGreeting(localGreeting()), [])

  return (
    <div className="wv-today">
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">{greeting}, {displayName}</span>
          <h1>A következő videód itt kezdődik.</h1>
        </div>
        <span className="wv-heading-meta">
          Szemléltető munkatér<br />
          {profile?.niche ? `Profilirány: ${profile.niche}` : 'A profilirány még nincs rögzítve'}
        </span>
      </header>

      <section className="wv-stage" aria-label="Mai alkotói munkatér">
        <aside className="wv-command">
          <span className="wv-eyebrow">Mai irány</span>
          <h2>{lane.todayDirection}</h2>
          <p>{lane.todaySupport}</p>
          <Link href="/dashboard/create" className="wv-primary-action">
            <span>Folytatom az alkotást</span>
            <ArrowUpRight aria-hidden="true" />
          </Link>
          <div className="wv-proof-summary">
            <span className="wv-proof-icon"><Link2 aria-hidden="true" /></span>
            <span className="wv-proof-copy">
              <strong>{creatorLane === 'evidence' ? '5 forrás kapcsolódik' : '4 élménypont kapcsolódik'}</strong>
              <span>{creatorLane === 'evidence' ? 'Egy ellenőrzés szükséges' : 'Egy ritmusváltás erősíthető'}</span>
            </span>
          </div>
        </aside>

        <article className="wv-video-artifact">
          <header className="wv-artifact-head">
            <span className="wv-artifact-title">
              <strong>Miért nem hűt minden városi fa ugyanannyit?</strong>
              <span>Aktív mintaprojekt · legutóbbi állapot</span>
            </span>
            <span className="wv-artifact-phase">Állítások · 2/4</span>
          </header>
          <div className="wv-project-visual" role="img" aria-label="Szemléltető városi hőtérképes videóképkocka">
            <div className="wv-heat" />
            <div className="wv-city" />
            <div className="wv-tree" />
            <div className="wv-frame-note">
              <strong>Állítás 02 · 04:18</strong>
              <span>Lombkorona és felszíni hőmérséklet</span>
            </div>
          </div>
          <div className="wv-timeline">
            <div className="wv-timeline-head"><span>Magyarázó képsor</span><span>Vázlat · 01:24</span></div>
            <div className="wv-shots" aria-hidden="true">
              <span className="wv-shot" /><span className="wv-shot" /><span className="wv-shot is-current" /><span className="wv-shot" />
            </div>
          </div>
        </article>

        <aside className="wv-project-spine">
          <div>
            <div className="wv-spine-head"><span>Projektút</span><span>58%</span></div>
            <h3>Innen folytatod</h3>
          </div>
          <div className="wv-steps">
            <div className="wv-step is-done"><i><Check aria-hidden="true" /></i><span>Kutatás</span></div>
            <div className="wv-step is-current"><i>2</i><span>Állítások</span></div>
            <div className="wv-step"><i>3</i><span>Magyarázat</span></div>
            <div className="wv-step"><i>4</i><span>Publikálás</span></div>
          </div>
        </aside>
      </section>

      <section className="wv-intelligence" aria-label="Háttérfigyelés">
        <article className="wv-intel"><span className="wv-intel-icon"><Radar aria-hidden="true" /></span><span className="wv-intel-copy"><strong>Nyitott lehetőségablak</strong><span>Becsült idő: 31 óra · mintaadat</span></span></article>
        <article className="wv-intel"><span className="wv-intel-icon"><FileCheck2 aria-hidden="true" /></span><span className="wv-intel-copy"><strong>Új megerősítő forrás</strong><span>Az árnyékolás hatásáról</span></span></article>
        <article className="wv-intel"><span className="wv-intel-icon"><Brain aria-hidden="true" /></span><span className="wv-intel-copy"><strong>Közönségmemória</strong><span>{memoryCount > 0 ? `${memoryCount} mentett témához kapcsolódik` : 'Az összehasonlítás erős minta'}</span></span></article>
      </section>

      <section className="wv-secondary-grid">
        <article className="wv-secondary-panel">
          <h3>Következő lehetőségek</h3>
          <div className="wv-opportunity-row"><span className="wv-opportunity-copy"><strong>A lakások hőcsapdái</strong><span>Erős csatornailleszkedés · minta</span></span><Link href="/dashboard/opportunities">Megnézem</Link></div>
          <div className="wv-opportunity-row"><span className="wv-opportunity-copy"><strong>Mit mér valójában a hőérzet?</strong><span>Friss összehasonlítás · minta</span></span><Link href="/dashboard/opportunities">Megnézem</Link></div>
        </article>
        <aside className="wv-secondary-panel wv-editorial-tip">
          <span className="wv-tip-label">Mai alkotói előny</span>
          <strong>A szám előtt mutasd meg, mit változtat meg a néző életében.</strong>
          <p>„Ez a két fa hat fok különbséget jelenthet.”</p>
        </aside>
      </section>

      <section className={`wv-pulse${pulsePaused ? ' is-paused' : ''}`} aria-label="Alkotói pulzus">
        <header className="wv-pulse-head">
          <span className="wv-pulse-copy"><strong>Alkotói pulzus</strong><span>Szemléltető nemzetközi profilok · valós adatok csak jogtiszta forrásból kerülnek ide</span></span>
          <button type="button" className="wv-pulse-button" aria-pressed={pulsePaused} onClick={() => setPulsePaused(paused => !paused)}>
            {pulsePaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            <span>{pulsePaused ? 'Mozgás folytatása' : 'Mozgás megállítása'}</span>
          </button>
        </header>
        <div className="wv-pulse-track">
          {[...pulseItems, ...pulseItems].map((item, index) => (
            <div className="wv-pulse-item" key={`${item[0]}-${index}`} aria-hidden={index >= pulseItems.length}>
              <span className="wv-pulse-media" />
              <span><strong>{item[0]}</strong><small>{item[1]}</small><em>{item[2]}</em></span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
