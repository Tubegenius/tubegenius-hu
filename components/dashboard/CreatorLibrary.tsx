'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  FolderOpen,
  Search,
  X,
} from 'lucide-react'
import { useFocusTrap } from '@/lib/useFocusTrap'
import {
  countCreatorLibraryStages,
  CREATOR_LIBRARY_FLOW,
  CREATOR_LIBRARY_LABELS,
  presentCreatorMemory,
  type CreatorLibraryEntry,
  type CreatorLibraryStage,
} from '@/lib/creator-library-presentation'
import type { CreatorMemoryItem } from '@/types'

interface CreatorLibraryProps { items: CreatorMemoryItem[] }
type LibraryFilter = 'all' | CreatorLibraryStage

const dateFormatter = new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' })

function formatLibraryDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Dátum nélkül' : dateFormatter.format(date)
}

function LibraryDetail({ entry, onClose }: { entry: CreatorLibraryEntry; onClose: () => void }) {
  const panelRef = useFocusTrap(onClose)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  return createPortal(
    <div className="wv-library-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section
        ref={panelRef}
        className="wv-library-panel"
        data-state={entry.state}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wv-library-detail-title"
        tabIndex={-1}
      >
        <header className="wv-library-panel-head">
          <div>
            <span className="wv-eyebrow">Alkotói memória · csak olvasható</span>
            <span className="wv-library-panel-number">{entry.stageIndex}</span>
          </div>
          <button type="button" aria-label="Könyvtári részletek bezárása" onClick={onClose}><X aria-hidden="true" /></button>
        </header>

        <div className="wv-library-panel-body">
          <span className="wv-library-state">{entry.stateLabel}</span>
          <h2 id="wv-library-detail-title">{entry.title}</h2>
          <p className="wv-library-panel-lead">Ez az alkotói irány a meglévő memóriádból jelenik meg. Itt a helye és a következő biztonságos lépése látható.</p>

          <dl className="wv-library-facts">
            <div><dt>Platform</dt><dd>{entry.platformLabel}</dd></div>
            <div><dt>Frissítve</dt><dd>{formatLibraryDate(entry.updatedAt)}</dd></div>
            <div><dt>Lehetőségpont</dt><dd>{entry.opportunityScore ?? '—'}</dd></div>
            <div><dt>Viralitáspont</dt><dd>{entry.viralScore ?? '—'}</dd></div>
          </dl>

          {entry.keyword && <div className="wv-library-note"><span>Kiinduló jel</span><strong>{entry.keyword}</strong></div>}
          {entry.notes && <div className="wv-library-note"><span>Saját jegyzet</span><p>{entry.notes}</p></div>}

          <div className="wv-library-next">
            <CheckCircle2 aria-hidden="true" />
            <div><span>Következő fókusz</span><strong>{entry.nextActionLabel}</strong></div>
          </div>
        </div>

        <footer className="wv-library-panel-actions">
          <button type="button" className="wv-secondary-action" onClick={onClose}>Vissza a könyvtárhoz</button>
          <Link href={entry.nextActionHref} className="wv-primary-action">{entry.nextActionLabel}<ArrowRight aria-hidden="true" /></Link>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export default function CreatorLibrary({ items }: CreatorLibraryProps) {
  const entries = useMemo(() => presentCreatorMemory(items), [items])
  const counts = useMemo(() => countCreatorLibraryStages(entries), [entries])
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [selected, setSelected] = useState<CreatorLibraryEntry | null>(null)
  const visibleEntries = filter === 'all' ? entries : entries.filter(entry => entry.state === filter)

  return (
    <div className="wv-destination">
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Könyvtár</span><h1>A csatornád alkotói memóriája.</h1></div>
        <span className="wv-heading-meta">{entries.length} legutóbbi irány<br />állapot szerint rendezve</span>
      </header>

      {entries.length > 0 ? (
        <>
          <section className="wv-library-flow" aria-labelledby="wv-library-flow-title">
            <div className="wv-library-flow-intro">
              <span className="wv-eyebrow">Alkotói állapotfolyam</span>
              <h2 id="wv-library-flow-title">Lásd, hol tart minden ötlet.</h2>
              <button type="button" className="wv-library-all" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                Összes <span>{entries.length}</span>
              </button>
            </div>
            <div className="wv-library-stage-list" aria-label="Könyvtár szűrése állapot szerint">
              {CREATOR_LIBRARY_FLOW.map((stage, index) => (
                <button type="button" data-state={stage} aria-pressed={filter === stage} onClick={() => setFilter(stage)} key={stage}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{CREATOR_LIBRARY_LABELS[stage]}</strong>
                  <em>{counts[stage]}</em>
                </button>
              ))}
            </div>
          </section>

          {visibleEntries.length > 0 ? (
            <section className="wv-library-grid" aria-label={`${filter === 'all' ? 'Összes' : CREATOR_LIBRARY_LABELS[filter]} könyvtári elem`}>
              {visibleEntries.map((entry, index) => (
                <article className="wv-library-item" data-state={entry.state} key={entry.id}>
                  <button type="button" onClick={() => setSelected(entry)} aria-label={`${entry.title} részleteinek megnyitása`}>
                    <span className={`wv-library-visual tone-${(index % 3) + 1}`} aria-hidden="true">
                      <i />
                      <b>{entry.stageIndex}</b>
                    </span>
                    <span className="wv-library-copy">
                      <span className="wv-library-card-head"><span className="wv-library-state">{entry.stateLabel}</span><ArrowUpRight aria-hidden="true" /></span>
                      <strong>{entry.title}</strong>
                      <span className="wv-library-description">{entry.notes || entry.keyword || 'Mentett alkotói irány a csatornád memóriájában.'}</span>
                      <span className="wv-library-meta"><span>{entry.platformLabel}</span><span>{formatLibraryDate(entry.updatedAt)}</span></span>
                    </span>
                  </button>
                </article>
              ))}
            </section>
          ) : (
            <section className="wv-library-filter-empty" aria-live="polite">
              <div><span className="wv-eyebrow">Ebben az állapotban nincs elem</span><h2>A folyamat ezen pontja most szabad.</h2><p>Válassz másik állapotot, vagy térj vissza az összes alkotói irányhoz.</p></div>
              <button type="button" className="wv-secondary-action" onClick={() => setFilter('all')}>Összes megjelenítése</button>
            </section>
          )}
        </>
      ) : (
        <section className="wv-library-empty">
          <span className="wv-empty-mark"><BookOpen aria-hidden="true" /></span>
          <div><span className="wv-eyebrow">A memória innen épül</span><h2>Még nincs mentett alkotói irány.</h2><p>A Felfedezésből ments el egy lehetőséget, vagy folytasd a szemléltető projektet.</p></div>
          <Link href="/dashboard/discover" className="wv-primary-action">Lehetőség keresése<ArrowUpRight aria-hidden="true" /></Link>
        </section>
      )}

      <section className="wv-tool-rail" aria-label="Könyvtári eszközök">
        <span><FolderOpen aria-hidden="true" /><strong>Kapcsolódó terek</strong></span>
        <Link href="/dashboard/memory"><BookOpen aria-hidden="true" />Teljes tartalommemória</Link>
        <Link href="/dashboard/calendar"><CalendarDays aria-hidden="true" />Alkotói naptár</Link>
        <Link href="/dashboard/memory" className="wv-library-search"><Search aria-hidden="true" />Keresés a teljes memóriában</Link>
      </section>

      {selected && <LibraryDetail entry={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
