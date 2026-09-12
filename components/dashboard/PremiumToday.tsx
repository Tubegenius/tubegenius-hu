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
import { CREATOR_TODAY_PRESENTATION } from '@/lib/creator-today-presentation'
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
  const today = CREATOR_TODAY_PRESENTATION[creatorLane]

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
              <strong>{today.proofTitle}</strong>
              <span>{today.proofDetail}</span>
            </span>
          </div>
        </aside>

        <article className="wv-video-artifact">
          <header className="wv-artifact-head">
            <span className="wv-artifact-title">
              <strong>{today.projectTitle}</strong>
              <span>Aktív mintaprojekt · legutóbbi állapot</span>
            </span>
            <span className="wv-artifact-phase">{today.artifactPhase}</span>
          </header>
          <div className={`wv-project-visual${creatorLane === 'entertainment' ? ' is-entertainment' : ''}`} role="img" aria-label={today.visualLabel}>
            <div className="wv-heat" />
            <div className="wv-city" />
            <div className="wv-tree" />
            <div className="wv-frame-note">
              <strong>{today.frameMoment}</strong>
              <span>{today.frameLabel}</span>
            </div>
          </div>
          <div className="wv-timeline">
            <div className="wv-timeline-head"><span>{today.timelineLabel}</span><span>{today.timelineState}</span></div>
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
            {lane.stages.map((stage, index) => (
              <div className={`wv-step${index === 0 ? ' is-done' : ''}${index === 1 ? ' is-current' : ''}`} key={stage.id}>
                <i>{index === 0 ? <Check aria-hidden="true" /> : stage.number}</i><span>{stage.label}</span>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="wv-intelligence" aria-label="Háttérfigyelés">
        <article className="wv-intel"><span className="wv-intel-icon"><Radar aria-hidden="true" /></span><span className="wv-intel-copy"><strong>{today.intelligence[0].title}</strong><span>{today.intelligence[0].detail}</span></span></article>
        <article className="wv-intel"><span className="wv-intel-icon"><FileCheck2 aria-hidden="true" /></span><span className="wv-intel-copy"><strong>{today.intelligence[1].title}</strong><span>{today.intelligence[1].detail}</span></span></article>
        <article className="wv-intel"><span className="wv-intel-icon"><Brain aria-hidden="true" /></span><span className="wv-intel-copy"><strong>{today.intelligence[2].title}</strong><span>{memoryCount > 0 ? `${memoryCount} mentett témához kapcsolódik` : today.intelligence[2].emptyDetail}</span></span></article>
      </section>

      <section className="wv-secondary-grid">
        <article className="wv-secondary-panel">
          <h3>Következő lehetőségek</h3>
          {today.opportunities.map(opportunity => (
            <div className="wv-opportunity-row" key={opportunity.title}><span className="wv-opportunity-copy"><strong>{opportunity.title}</strong><span>{opportunity.detail}</span></span><Link href="/dashboard/discover">Megnézem</Link></div>
          ))}
        </article>
        <aside className="wv-secondary-panel wv-editorial-tip">
          <span className="wv-tip-label">Mai alkotói előny</span>
          <strong>{today.tip}</strong>
          <p>{today.tipExample}</p>
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
