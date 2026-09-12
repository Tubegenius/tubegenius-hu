'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  CheckCircle2,
  Clock3,
  FileCheck2,
  Film,
  Gauge,
  Layers3,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import {
  countCreatorMemoryStates,
  CREATOR_MEMORY_FILTERS,
  CREATOR_MEMORY_LANE_COPY,
  CREATOR_MEMORY_STATE,
  filterCreatorMemory,
  totalProofSignals,
  type CreatorMemoryFilter,
  type CreatorMemorySection,
} from '@/lib/creator-memory-presentation'
import { useFocusTrap } from '@/lib/useFocusTrap'
import type {
  CreatorMemoryItem,
  MemoryInsight,
  MemoryProofSignalSummary,
  TopicState,
  VideoIdeaEvent,
} from '@/types'

type MemoryItem = CreatorMemoryItem & {
  audit_score?: number | null
  audit_id?: string | null
  video_package_id?: string | null
  proof_signals?: MemoryProofSignalSummary
  events?: VideoIdeaEvent[]
  insight?: MemoryInsight | null
}

interface PackageSummary {
  id: string
  topic: string
  search_keyword: string | null
  platform: string
  video_length: string
  narration_style: string | null
  title_variations: string[]
  created_at: string
  updated_at: string
}

interface AuditSummary {
  id: string
  platform: string
  video_title: string
  overall_score: number
  confidence: string
  decision: string
  decision_label?: string
  created_at: string
}

const eventLabels: Record<string, string> = {
  idea_saved: 'Elmentve a memóriába',
  idea_rejected: 'Elvetett irány',
  state_changed: 'Projektállapot módosítva',
  viral_score_completed: 'Viralitási értékelés elkészült',
  similar_videos_completed: 'Piaci példák áttekintve',
  video_package_created: 'Videócsomag elkészült',
}

const dateFormatter = new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: 'short', day: 'numeric' })

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Dátum nélkül' : dateFormatter.format(date)
}

function includesQuery(query: string, ...values: Array<string | null | undefined>): boolean {
  const needle = query.toLocaleLowerCase('hu-HU').trim()
  return !needle || values.some(value => (value || '').toLocaleLowerCase('hu-HU').includes(needle))
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || 'A kérés nem sikerült.')
  return data
}

function MemorySkeleton() {
  return (
    <div className="wv-memory-skeleton" aria-label="Tartalommemória betöltése" aria-busy="true">
      <div /><div /><div />
    </div>
  )
}

function MemoryDetailPanel({
  item,
  busy,
  onClose,
  onChangeState,
  onDelete,
}: {
  item: MemoryItem
  busy: boolean
  onClose: () => void
  onChangeState: (state: TopicState) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const panelRef = useFocusTrap(onClose)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const state = CREATOR_MEMORY_STATE[item.state]
  const signals = item.proof_signals
  const signalTotal = signals ? signals.strong + signals.medium + signals.weak + signals.rejected : 0
  const events = item.events || []

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  return createPortal(
    <div className="wv-memory-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={panelRef} className="wv-memory-panel" data-state={item.state} role="dialog" aria-modal="true" aria-labelledby="wv-memory-detail-title" tabIndex={-1}>
        <header className="wv-memory-panel-head">
          <div><span className="wv-eyebrow">Memóriakártya · döntési lenyomat</span><strong>{state.step}</strong></div>
          <button type="button" onClick={onClose} aria-label="Memóriakártya bezárása"><X aria-hidden="true" /></button>
        </header>

        <div className="wv-memory-panel-body">
          <span className="wv-memory-state">{state.label}</span>
          <h2 id="wv-memory-detail-title">{item.topic}</h2>
          <p className="wv-memory-panel-lead">A mentett alkotói irányhoz kapcsolódó döntések, jelek és következő lépések egy helyen.</p>

          <dl className="wv-memory-facts">
            <div><dt>Platform</dt><dd>{item.platform || 'Platformfüggetlen'}</dd></div>
            <div><dt>Frissítve</dt><dd>{formatDate(item.updated_at)}</dd></div>
            <div><dt>Lehetőségpont</dt><dd>{item.opportunity_score ?? '—'}</dd></div>
            <div><dt>Viralitáspont</dt><dd>{item.viral_score ?? '—'}</dd></div>
          </dl>

          {(item.search_keyword || item.notes) && (
            <div className="wv-memory-notes">
              {item.search_keyword && <div><span>Kiinduló keresés</span><strong>{item.search_keyword}</strong></div>}
              {item.notes && <div><span>Saját jegyzet</span><p>{item.notes}</p></div>}
            </div>
          )}

          {item.insight && (item.insight.published || item.insight.rejected) && (
            <section className="wv-memory-recall" aria-labelledby="wv-memory-recall-title">
              <ShieldCheck aria-hidden="true" />
              <div>
                <span id="wv-memory-recall-title">Korábbi döntési emlék</span>
                <p>{item.insight.published
                  ? `Hasonló publikált témát találtunk: „${item.insight.published.topic}”. Ez önmagában nem teljesítménybizonyíték.`
                  : `Hasonló, korábban elvetett témát találtunk: „${item.insight.rejected?.topic}”.`}</p>
              </div>
            </section>
          )}

          <section className="wv-memory-evidence" aria-labelledby="wv-memory-evidence-title">
            <header><div><span className="wv-eyebrow">Kapcsolódó jelek</span><h3 id="wv-memory-evidence-title">{signalTotal ? `${signalTotal} eltárolt jel` : 'Még nincs eltárolt jel'}</h3></div><Layers3 aria-hidden="true" /></header>
            {signals && signalTotal > 0 ? (
              <div className="wv-memory-signal-grid">
                <span><strong>{signals.strong}</strong>Erős</span>
                <span><strong>{signals.medium}</strong>Közepes</span>
                <span><strong>{signals.weak}</strong>Gyenge</span>
                <span><strong>{signals.rejected}</strong>Elvetett</span>
              </div>
            ) : <p>A jelréteg akkor jelenik meg, amikor a meglévő workflow bizonyítékot vagy piaci példát kapcsol ehhez az irányhoz.</p>}
          </section>

          <section className="wv-memory-timeline" aria-labelledby="wv-memory-timeline-title">
            <header><span className="wv-eyebrow">Döntési idővonal</span><h3 id="wv-memory-timeline-title">A projekt eddigi útja</h3></header>
            {events.length > 0 ? (
              <ol>{events.map(event => <li key={event.id}><i aria-hidden="true" /><div><strong>{eventLabels[event.event_type] || event.event_type}</strong><span>{formatDate(event.created_at)}</span></div></li>)}</ol>
            ) : <p>Még nincs megjeleníthető esemény ehhez az irányhoz.</p>}
          </section>

          <section className="wv-memory-tools" aria-labelledby="wv-memory-tools-title">
            <div><span className="wv-eyebrow">Következő lépés</span><h3 id="wv-memory-tools-title">Folytasd ott, ahol értéket ad.</h3></div>
            <div className="wv-memory-tool-links">
              <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(item.search_keyword || item.topic)}`}><Gauge aria-hidden="true" />Virális esély</Link>
              <Link href={`/dashboard/similar-videos?topic=${encodeURIComponent(item.search_keyword || item.topic)}`}><Film aria-hidden="true" />Piaci videók</Link>
              {item.video_package_id ? (
                <Link href={`/dashboard/video-package?id=${item.video_package_id}`}><PackageOpen aria-hidden="true" />Csomag megnyitása</Link>
              ) : (
                <Link href={`/dashboard/video-package?topic=${encodeURIComponent(item.topic)}&keyword=${encodeURIComponent(item.search_keyword || '')}`}><Box aria-hidden="true" />Videócsomag</Link>
              )}
              {item.audit_id && <Link href={`/dashboard/video-audit?id=${item.audit_id}`}><FileCheck2 aria-hidden="true" />Diagnózis</Link>}
            </div>
          </section>

          <section className="wv-memory-state-actions" aria-labelledby="wv-memory-state-title">
            <div><span className="wv-eyebrow">Projektállapot</span><h3 id="wv-memory-state-title">Mozgasd a valós munkafolyamat szerint.</h3></div>
            <div>
              {item.state !== 'in_progress' && item.state !== 'completed' && <button type="button" disabled={busy} onClick={() => onChangeState('in_progress')}>Folyamatban</button>}
              {item.state !== 'completed' && <button type="button" disabled={busy} onClick={() => onChangeState('completed')}>Publikált</button>}
              {item.state !== 'rejected' && <button type="button" disabled={busy} onClick={() => onChangeState('rejected')}>Elvetett</button>}
              {item.state !== 'saved' && <button type="button" disabled={busy} onClick={() => onChangeState('saved')}>Vissza a mentettekhez</button>}
            </div>
          </section>

          <div className="wv-memory-danger">
            {confirmDelete ? (
              <div role="alert"><span>Biztosan törlöd ezt a memóriaelemet?</span><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Mégse</button><button type="button" disabled={busy} onClick={onDelete}>Törlés</button></div>
            ) : <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />Eltávolítás a memóriából</button>}
          </div>
        </div>

        <footer className="wv-memory-panel-actions">
          <button type="button" className="wv-secondary-action" onClick={onClose}>Vissza az archívumhoz</button>
          <Link href="/dashboard/create" className="wv-primary-action">Alkotás megnyitása<ArrowRight aria-hidden="true" /></Link>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

export default function CreatorMemoryPage() {
  const searchParams = useSearchParams()
  const { creatorLane } = useCreatorOS()
  const laneCopy = CREATOR_MEMORY_LANE_COPY[creatorLane]
  const requestedTab = searchParams.get('tab')
  const initialSection: CreatorMemorySection = requestedTab === 'packages' || requestedTab === 'audits' ? requestedTab : 'ideas'
  const initialFilter: CreatorMemoryFilter = CREATOR_MEMORY_FILTERS.some(option => option.value === requestedTab) ? requestedTab as CreatorMemoryFilter : 'all'
  const [section, setSection] = useState<CreatorMemorySection>(initialSection)
  const [filter, setFilter] = useState<CreatorMemoryFilter>(initialFilter)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [packages, setPackages] = useState<PackageSummary[]>([])
  const [audits, setAudits] = useState<AuditSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmPackageId, setConfirmPackageId] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [memoryData, packageData, auditData] = await Promise.all([
        fetch('/api/memory').then(response => responseJson<{ items?: MemoryItem[] }>(response)),
        fetch('/api/video-packages').then(response => responseJson<{ packages?: PackageSummary[] }>(response)),
        fetch('/api/video-audits').then(response => responseJson<{ audits?: AuditSummary[] }>(response)),
      ])
      setItems(memoryData.items || [])
      setPackages(packageData.packages || [])
      setAudits(auditData.audits || [])
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'A tartalommemória nem tölthető be.')
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadItems = useCallback(async () => {
    const data = await fetch('/api/memory').then(response => responseJson<{ items?: MemoryItem[] }>(response))
    setItems(data.items || [])
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  const counts = useMemo(() => countCreatorMemoryStates(items), [items])
  const proofCount = useMemo(() => totalProofSignals(items), [items])
  const visibleItems = useMemo(() => filterCreatorMemory(items, filter, query) as MemoryItem[], [filter, items, query])
  const visiblePackages = useMemo(() => packages.filter(pkg => includesQuery(query, pkg.topic, pkg.search_keyword, pkg.platform, pkg.narration_style)), [packages, query])
  const visibleAudits = useMemo(() => audits.filter(audit => includesQuery(query, audit.video_title, audit.platform, audit.decision_label, audit.decision)), [audits, query])
  const selectedItem = selectedId ? items.find(item => item.id === selectedId) || null : null

  async function changeState(item: MemoryItem, state: TopicState) {
    setBusyKey(item.id)
    setStatusMessage('')
    try {
      await fetch('/api/memory', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, state }) })
        .then(response => responseJson(response))
      await reloadItems()
      setStatusMessage(`Állapot frissítve: ${CREATOR_MEMORY_STATE[state].label}.`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Az állapot nem frissíthető.')
    } finally {
      setBusyKey(null)
    }
  }

  async function deleteMemory(item: MemoryItem) {
    setBusyKey(item.id)
    setStatusMessage('')
    try {
      await fetch('/api/memory', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) })
        .then(response => responseJson(response))
      setSelectedId(null)
      await reloadItems()
      setStatusMessage('A memóriaelem eltávolítva.')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'A memóriaelem nem törölhető.')
    } finally {
      setBusyKey(null)
    }
  }

  async function deletePackage(id: string) {
    setBusyKey(id)
    setStatusMessage('')
    try {
      await fetch('/api/video-packages', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
        .then(response => responseJson(response))
      setPackages(current => current.filter(pkg => pkg.id !== id))
      setConfirmPackageId(null)
      setStatusMessage('A videócsomag eltávolítva.')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'A videócsomag nem törölhető.')
    } finally {
      setBusyKey(null)
    }
  }

  const resultCount = section === 'ideas' ? visibleItems.length : section === 'packages' ? visiblePackages.length : visibleAudits.length

  return (
    <div className="wv-destination wv-memory" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Tartalommemória</span><h1>{laneCopy.title}</h1></div>
        <span className="wv-heading-meta">{laneCopy.lens}<br />aktuális alkotói fókusz</span>
      </header>

      <section className="wv-memory-atlas" aria-labelledby="wv-memory-atlas-title">
        <div className="wv-memory-atlas-copy">
          <span className="wv-eyebrow">Alkotói archívum</span>
          <h2 id="wv-memory-atlas-title">Ne csak mentsd. Építs belőle előnyt.</h2>
          <p>{laneCopy.lead}</p>
          <Link href="/dashboard/discover" className="wv-primary-action">Új irány felfedezése<ArrowUpRight aria-hidden="true" /></Link>
        </div>
        <div className="wv-memory-atlas-field" aria-label="Memória összefoglaló">
          <div className="is-total"><Archive aria-hidden="true" /><span>Összes irány</span><strong>{items.length}</strong></div>
          <div><Sparkles aria-hidden="true" /><span>Aktív projekt</span><strong>{counts.in_progress}</strong></div>
          <div><CheckCircle2 aria-hidden="true" /><span>Publikált</span><strong>{counts.completed}</strong></div>
          <div><ShieldCheck aria-hidden="true" /><span>Tárolt jel</span><strong>{proofCount}</strong></div>
        </div>
      </section>

      <section className="wv-memory-console" aria-label="Tartalommemória keresése és szűrése">
        <div className="wv-memory-tabs" role="tablist" aria-label="Memóriatípus">
          {([
            ['ideas', 'Alkotói irányok', items.length],
            ['packages', 'Videócsomagok', packages.length],
            ['audits', 'Diagnózisok', audits.length],
          ] as Array<[CreatorMemorySection, string, number]>).map(([value, label, count]) => (
            <button key={value} type="button" role="tab" aria-selected={section === value} onClick={() => setSection(value)}>{label}<span>{count}</span></button>
          ))}
        </div>
        <label className="wv-memory-search"><Search aria-hidden="true" /><span className="sr-only">Keresés a tartalommemóriában</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Téma, kulcsszó vagy platform…" /></label>
      </section>

      <div className="wv-memory-status" aria-live="polite">{statusMessage}</div>

      {loading ? <MemorySkeleton /> : loadError ? (
        <section className="wv-error-state">
          <span className="wv-error-stitch"><X aria-hidden="true" /></span>
          <div><span className="wv-eyebrow">Betöltési hiba</span><h1>A memória most nem érhető el.</h1><p>{loadError}</p></div>
          <button type="button" className="wv-secondary-action" onClick={() => void loadAll()}><RefreshCw aria-hidden="true" />Újrapróbálás</button>
        </section>
      ) : (
        <>
          {section === 'ideas' && (
            <section className="wv-memory-archive" aria-labelledby="wv-memory-results-title">
              <div className="wv-memory-filter-row">
                <div aria-label="Alkotói irányok szűrése">{CREATOR_MEMORY_FILTERS.map(option => <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}<span>{counts[option.value]}</span></button>)}</div>
                <p id="wv-memory-results-title">{resultCount} találat</p>
              </div>
              {visibleItems.length > 0 ? (
                <div className="wv-memory-card-grid">{visibleItems.map((item, index) => {
                  const state = CREATOR_MEMORY_STATE[item.state]
                  const signals = item.proof_signals
                  const signalCount = signals ? signals.strong + signals.medium + signals.weak + signals.rejected : 0
                  return (
                    <article className="wv-memory-card" data-state={item.state} key={item.id}>
                      <button type="button" className="wv-memory-card-open" onClick={() => setSelectedId(item.id)} aria-label={`${item.topic} memóriakártyájának megnyitása`}>
                        <span className={`wv-memory-card-art tone-${(index % 3) + 1}`} aria-hidden="true"><i /><b>{state.step}</b></span>
                        <span className="wv-memory-card-copy">
                          <span className="wv-memory-card-top"><span>{state.label}</span><ArrowUpRight aria-hidden="true" /></span>
                          <strong>{item.topic}</strong>
                          <span className="wv-memory-card-description">{item.notes || item.search_keyword || 'Mentett alkotói irány a csatornád tartalommemóriájában.'}</span>
                          <span className="wv-memory-card-signals">
                            <span><Gauge aria-hidden="true" />Lehetőség <b>{item.opportunity_score ?? '—'}</b></span>
                            <span><ShieldCheck aria-hidden="true" />Jelek <b>{signalCount}</b></span>
                          </span>
                          <span className="wv-memory-card-meta"><span>{item.platform || 'Platformfüggetlen'}</span><span>{formatDate(item.updated_at)}</span></span>
                        </span>
                      </button>
                    </article>
                  )
                })}</div>
              ) : <MemoryEmpty query={query} onReset={() => { setQuery(''); setFilter('all') }} />}
            </section>
          )}

          {section === 'packages' && (
            <section className="wv-memory-collection" aria-labelledby="wv-memory-results-title">
              <header><div><span className="wv-eyebrow">Gyártási csomagok</span><h2 id="wv-memory-results-title">Előkészített alkotói anyagok.</h2></div><span>{resultCount} találat</span></header>
              {visiblePackages.length > 0 ? <div className="wv-memory-package-grid">{visiblePackages.map(pkg => (
                <article key={pkg.id} className="wv-memory-package-card">
                  <span className="wv-memory-package-icon"><PackageOpen aria-hidden="true" /></span>
                  <div><span>{pkg.platform.replace('_', ' ')} · {pkg.video_length}</span><h3>{pkg.topic}</h3>{pkg.title_variations?.[0] && <p>{pkg.title_variations[0]}</p>}</div>
                  <footer><span>{formatDate(pkg.created_at)}</span><Link href={`/dashboard/video-package?id=${pkg.id}`}>Megnyitás<ArrowRight aria-hidden="true" /></Link></footer>
                  {confirmPackageId === pkg.id ? <div className="wv-memory-inline-confirm" role="alert"><span>Biztosan törlöd?</span><button type="button" onClick={() => setConfirmPackageId(null)}>Mégse</button><button type="button" disabled={busyKey === pkg.id} onClick={() => void deletePackage(pkg.id)}>Törlés</button></div> : <button type="button" className="wv-memory-card-delete" aria-label={`${pkg.topic} videócsomag törlése`} onClick={() => setConfirmPackageId(pkg.id)}><Trash2 aria-hidden="true" /></button>}
                </article>
              ))}</div> : <MemoryEmpty query={query} onReset={() => setQuery('')} />}
            </section>
          )}

          {section === 'audits' && (
            <section className="wv-memory-collection" aria-labelledby="wv-memory-results-title">
              <header><div><span className="wv-eyebrow">Videódiagnózisok</span><h2 id="wv-memory-results-title">Korábbi értékelések, döntési kontextussal.</h2></div><span>{resultCount} találat</span></header>
              {visibleAudits.length > 0 ? <div className="wv-memory-audit-list">{visibleAudits.map(audit => (
                <article key={audit.id}>
                  <span className="wv-memory-audit-score"><strong>{audit.overall_score}</strong><small>/ 100</small></span>
                  <div><span>{audit.platform.replace('_', ' ')} · {formatDate(audit.created_at)}</span><h3>{audit.video_title}</h3><p>{audit.decision_label || audit.decision}</p></div>
                  <Link href={`/dashboard/video-audit?id=${audit.id}`}>Diagnózis megnyitása<ArrowRight aria-hidden="true" /></Link>
                </article>
              ))}</div> : <MemoryEmpty query={query} onReset={() => setQuery('')} />}
            </section>
          )}
        </>
      )}

      <section className="wv-memory-footer-rail" aria-label="Kapcsolódó alkotói terek">
        <span><BookOpen aria-hidden="true" /><strong>A memória része a napi körnek</strong></span>
        <Link href="/dashboard/library">Könyvtár</Link>
        <Link href="/dashboard/create">Alkotás</Link>
        <Link href="/dashboard/growth">Növekedés</Link>
      </section>

      {selectedItem && <MemoryDetailPanel item={selectedItem} busy={busyKey === selectedItem.id} onClose={() => setSelectedId(null)} onChangeState={state => changeState(selectedItem, state)} onDelete={() => deleteMemory(selectedItem)} />}
    </div>
  )
}

function MemoryEmpty({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <section className="wv-memory-empty" aria-live="polite">
      <span><Clock3 aria-hidden="true" /></span>
      <div><span className="wv-eyebrow">Nincs találat</span><h2>{query ? 'Más keresés vezethet tovább.' : 'Ez a memóriarész még szabad.'}</h2><p>{query ? 'Töröld a keresést, vagy próbálj rövidebb témakifejezést.' : 'A Felfedezésből mentett első irány itt válik visszakereshetővé.'}</p></div>
      {query ? <button type="button" className="wv-secondary-action" onClick={onReset}>Keresés törlése</button> : <Link href="/dashboard/discover" className="wv-primary-action">Felfedezés megnyitása<ArrowUpRight aria-hidden="true" /></Link>}
    </section>
  )
}
