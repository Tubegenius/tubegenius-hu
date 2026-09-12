'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import {
  ArrowRight,
  Bookmark,
  Check,
  Compass,
  Lightbulb,
  Radar,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import type { CreatorLane } from '@/lib/creator-lane-presentation'
import {
  CREATOR_OPPORTUNITIES,
  creatorOpportunityStarterHref,
  type CreatorOpportunity,
} from '@/lib/creator-opportunity-presentation'

interface CreatorDiscoverProps {
  creatorLane?: CreatorLane
  createHrefBase?: string
}

interface OpportunityPanelProps {
  opportunity: CreatorOpportunity
  saved: boolean
  onClose: () => void
  onSave: () => void
  onStart: () => void
  createHrefBase: string
}

function OpportunityPanel({ opportunity, saved, onClose, onSave, onStart, createHrefBase }: OpportunityPanelProps) {
  const panelRef = useFocusTrap(onClose)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  return createPortal(
    <div
      className="wv-brief-layer"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        ref={panelRef}
        className="wv-brief-panel"
        data-accent={opportunity.accent}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wv-brief-title"
        tabIndex={-1}
      >
        <header className="wv-brief-head">
          <div>
            <span className="wv-eyebrow">Opportunity Brief · mintaadat</span>
            <span className="wv-brief-number">{opportunity.index}</span>
          </div>
          <button type="button" aria-label="Opportunity Brief bezárása" onClick={onClose}><X aria-hidden="true" /></button>
        </header>

        <div className="wv-brief-body">
          <div className="wv-brief-title-block">
            <span>{opportunity.lane === 'evidence' ? 'Bizonyítékvezérelt irány' : 'Élményvezérelt irány'}</span>
            <h2 id="wv-brief-title">{opportunity.title}</h2>
            <p>{opportunity.description}</p>
          </div>

          <div className="wv-brief-signals" aria-label="Lehetőségjelzések">
            <div><span>Időablak</span><strong>{opportunity.horizon}</strong></div>
            <div><span>Impulzus</span><strong>{opportunity.momentum}</strong></div>
            <div><span>Csatornailleszkedés</span><strong>{opportunity.channelFit}</strong></div>
          </div>

          <div className="wv-brief-section">
            <span className="wv-brief-label">Miért most?</span>
            <p>{opportunity.whyNow}</p>
          </div>
          <div className="wv-brief-section is-promise">
            <span className="wv-brief-label">Nézői ígéret</span>
            <strong>{opportunity.audiencePromise}</strong>
          </div>
          <div className="wv-brief-section">
            <span className="wv-brief-label">Következő alkotói döntés</span>
            <p>{opportunity.nextMove}</p>
          </div>
        </div>

        <footer className="wv-brief-actions">
          <button type="button" className="wv-brief-save" aria-pressed={saved} onClick={onSave}>
            {saved ? <Check aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
            {saved ? 'Mentve a mintába' : 'Mentés a könyvtárba'}
          </button>
          <Link href={creatorOpportunityStarterHref(opportunity, createHrefBase)} className="wv-primary-action" onClick={onStart}>Projektvázlat indítása<ArrowRight aria-hidden="true" /></Link>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export default function CreatorDiscover({ creatorLane, createHrefBase = '/dashboard/create' }: CreatorDiscoverProps) {
  const { creatorLane: contextLane, setCreatorLane } = useCreatorOS()
  const activeLane = creatorLane ?? contextLane
  const opportunities = CREATOR_OPPORTUNITIES[activeLane]
  const [selected, setSelected] = useState<CreatorOpportunity | null>(null)
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (!status) return
    const timer = window.setTimeout(() => setStatus(null), 1800)
    return () => window.clearTimeout(timer)
  }, [status])

  function toggleSaved(opportunity: CreatorOpportunity) {
    const isSaved = savedIds.has(opportunity.id)
    setSavedIds(current => {
      const next = new Set(current)
      if (next.has(opportunity.id)) next.delete(opportunity.id)
      else next.add(opportunity.id)
      return next
    })
    setStatus(isSaved ? 'Eltávolítva a szemléltető könyvtárból.' : 'Mentve a szemléltető könyvtárba.')
  }

  return (
    <div className="wv-destination" data-creator-lane={activeLane}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">Felfedezés · {activeLane === 'evidence' ? 'bizonyítékvezérelt' : 'élményvezérelt'}</span>
          <h1>{activeLane === 'evidence' ? 'Ne trendet keress. Saját lehetőséget ismerj fel.' : 'Ne formátumot másolj. Saját élményígéretet találj.'}</h1>
        </div>
        <span className="wv-heading-meta">3 szemléltető jel<br />csatornádhoz rendezve</span>
      </header>

      <div className="wv-discover-layout">
        <section className="wv-opportunity-list" aria-label="Szemléltető lehetőségek">
          {opportunities.map(opportunity => (
            <article className="wv-discovery-item" data-accent={opportunity.accent} key={opportunity.id}>
              <span className="wv-discovery-cut" aria-hidden="true" />
              <div>
                <span className="wv-discovery-index">{opportunity.index}</span>
                <h2>{opportunity.title}</h2>
                <p>{opportunity.description}</p>
                <div className="wv-discovery-tags">{opportunity.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
              </div>
              <button type="button" className={opportunity.index === '01' ? 'wv-primary-action' : 'wv-secondary-action'} onClick={() => setSelected(opportunity)}>
                Brief megnyitása<ArrowRight aria-hidden="true" />
              </button>
            </article>
          ))}
        </section>

        <aside className="wv-opportunity-map">
          <span className="wv-eyebrow">Lehetőségtér</span>
          <h2>A csatornádhoz közel</h2>
          <div className="wv-radar-map" role="group" aria-label="Három lehetőség helyzete a csatorna ismert témái körül">
            {opportunities.map((opportunity, index) => (
              <button
                type="button"
                className={['one', 'two', 'three'][index]}
                aria-label={`${opportunity.index}. lehetőség: ${opportunity.title}`}
                onClick={() => setSelected(opportunity)}
                key={opportunity.id}
              />
            ))}
          </div>
          <p>A középpont a csatornád ismert témáit és közönségmintáit jelzi. A pontok szemléltető lehetőségek.</p>
        </aside>
      </div>

      <section className="wv-tool-rail" aria-label="Felfedezési eszközök">
        <span><Compass aria-hidden="true" /><strong>Felfedezési mélység</strong></span>
        <Link href="/dashboard/opportunities"><Lightbulb aria-hidden="true" />Videólehetőségek</Link>
        <Link href="/dashboard/trend-alerts"><Radar aria-hidden="true" />Trendfigyelés</Link>
        <Link href="/dashboard/keyword-research"><Search aria-hidden="true" />Kulcsszókutatás</Link>
        <Link href="/dashboard/content-gap"><Sparkles aria-hidden="true" />Tartalmi rések</Link>
      </section>

      {selected && (
        <OpportunityPanel
          opportunity={selected}
          saved={savedIds.has(selected.id)}
          onClose={() => setSelected(null)}
          onSave={() => toggleSaved(selected)}
          onStart={() => setCreatorLane(selected.lane)}
          createHrefBase={createHrefBase}
        />
      )}
      {status && <div className="wv-toast" role="status" aria-live="polite"><Check aria-hidden="true" /><span>{status}</span></div>}
    </div>
  )
}
