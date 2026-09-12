'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  PackageOpen,
  Play,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import {
  buildCreatorCalendarWeek,
  calendarDateKey,
  calendarWeekLabel,
  CREATOR_CALENDAR_LANE_COPY,
  groupCalendarIdeas,
  nextScheduledIdea,
  shiftCalendarWeek,
} from '@/lib/creator-calendar-presentation'
import { useFocusTrap } from '@/lib/useFocusTrap'
import type { VideoIdea } from '@/types'

const dateFormatter = new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })

function ideaTitle(idea: VideoIdea): string {
  return idea.title || idea.topic
}

function formatDate(value: string | null): string {
  if (!value) return 'Dátum nélkül'
  const key = calendarDateKey(value)
  if (!key) return 'Dátum nélkül'
  const [year, month, day] = key.split('-').map(Number)
  return dateFormatter.format(new Date(year, month - 1, day, 12))
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || 'A kérés nem sikerült.')
  return data
}

function CalendarEditor({
  idea,
  busy,
  onClose,
  onSave,
  onPublish,
}: {
  idea: VideoIdea
  busy: boolean
  onClose: () => void
  onSave: (date: string, notes: string) => Promise<void>
  onPublish: () => Promise<void>
}) {
  const panelRef = useFocusTrap(onClose)
  const [date, setDate] = useState(calendarDateKey(idea.scheduled_publish_date) || '')
  const [notes, setNotes] = useState(idea.calendar_notes || '')
  const [confirmPublish, setConfirmPublish] = useState(false)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [])

  return createPortal(
    <div className="wv-calendar-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={panelRef} className="wv-calendar-panel" role="dialog" aria-modal="true" aria-labelledby="wv-calendar-editor-title" tabIndex={-1}>
        <header className="wv-calendar-panel-head">
          <div><span className="wv-eyebrow">Publikálási fókusz</span><CalendarClock aria-hidden="true" /></div>
          <button type="button" onClick={onClose} aria-label="Ütemezőpanel bezárása"><X aria-hidden="true" /></button>
        </header>

        <div className="wv-calendar-panel-body">
          <span className="wv-calendar-panel-state">{idea.calendar_status === 'scheduled' ? 'Ütemezett projekt' : 'Gyártásra kész projekt'}</span>
          <h2 id="wv-calendar-editor-title">{ideaTitle(idea)}</h2>
          <p>A premier időpontját és az alkotói emlékeztetőt a meglévő projektadatokhoz mentjük.</p>

          <dl className="wv-calendar-project-facts">
            <div><dt>Platform</dt><dd>{idea.platform || 'Platformfüggetlen'}</dd></div>
            <div><dt>Formátum</dt><dd>{idea.content_format || 'Nincs megadva'}</dd></div>
            <div><dt>Lehetőségpont</dt><dd>{idea.opportunity_score ?? '—'}</dd></div>
            <div><dt>Viralitáspont</dt><dd>{idea.viral_score ?? '—'}</dd></div>
          </dl>

          <form className="wv-calendar-form" onSubmit={event => { event.preventDefault(); void onSave(date, notes) }}>
            <label><span>Premier dátuma</span><input type="date" value={date} onChange={event => setDate(event.target.value)} required /></label>
            <label><span>Alkotói emlékeztető</span><textarea value={notes} onChange={event => setNotes(event.target.value)} placeholder="Kampány, platform, utolsó ellenőrzés…" rows={4} maxLength={5000} /></label>
            <button type="submit" className="wv-primary-action" disabled={busy || !date}>{busy ? 'Mentés…' : 'Ütemezés mentése'}<ArrowRight aria-hidden="true" /></button>
          </form>

          {idea.proof_summary && <div className="wv-calendar-proof"><span className="wv-eyebrow">Projektkontextus</span><p>{idea.proof_summary}</p></div>}

          <div className="wv-calendar-panel-links">
            {idea.video_package_id && <Link href={`/dashboard/video-package?id=${idea.video_package_id}`}><PackageOpen aria-hidden="true" />Videócsomag megnyitása</Link>}
            <Link href="/dashboard/create"><Sparkles aria-hidden="true" />Alkotás megnyitása</Link>
          </div>

          <div className="wv-calendar-publish">
            {confirmPublish ? (
              <div role="alert"><p><strong>Valóban publikált?</strong><span>Ez a projekt a publikált tartalmak közé kerül.</span></p><button type="button" disabled={busy} onClick={() => setConfirmPublish(false)}>Mégse</button><button type="button" disabled={busy} onClick={() => void onPublish()}>Igen, publikált</button></div>
            ) : <button type="button" disabled={busy} onClick={() => setConfirmPublish(true)}><Check aria-hidden="true" />Publikáltnak jelölés</button>}
          </div>
        </div>

        <footer><button type="button" className="wv-secondary-action" onClick={onClose}><ArrowLeft aria-hidden="true" />Vissza a naptárhoz</button></footer>
      </section>
    </div>,
    document.body,
  )
}

function CalendarLoading() {
  return <div className="wv-calendar-loading" aria-label="Alkotói naptár betöltése" aria-busy="true"><div /><div /><div /></div>
}

export default function CalendarPage() {
  const { creatorLane } = useCreatorOS()
  const laneCopy = CREATOR_CALENDAR_LANE_COPY[creatorLane]
  const [ideas, setIdeas] = useState<VideoIdea[]>([])
  const [anchorDate, setAnchorDate] = useState(() => new Date())
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetch('/api/video-ideas?view=calendar').then(response => responseJson<{ ideas?: VideoIdea[] }>(response))
      setIdeas(data.ideas || [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'A naptár betöltése sikertelen.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => groupCalendarIdeas(ideas), [ideas])
  const week = useMemo(() => buildCreatorCalendarWeek(groups.scheduled, anchorDate), [anchorDate, groups.scheduled])
  const nextIdea = useMemo(() => nextScheduledIdea(ideas), [ideas])
  const selectedIdea = selectedId ? ideas.find(idea => idea.id === selectedId) || null : null
  const visibleScheduled = selectedDay ? groups.scheduled.filter(idea => calendarDateKey(idea.scheduled_publish_date) === selectedDay) : groups.scheduled

  async function patchIdea(idea: VideoIdea, update: Record<string, unknown>, success: string) {
    setBusy(true)
    setStatusMessage('')
    try {
      const data = await fetch('/api/video-ideas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idea.id, ...update }),
      }).then(response => responseJson<{ idea: VideoIdea }>(response))
      setIdeas(current => current.map(currentIdea => currentIdea.id === data.idea.id ? data.idea : currentIdea))
      setStatusMessage(success)
      if (update.workflow_status === 'published') setSelectedId(null)
    } catch (saveError) {
      setStatusMessage(saveError instanceof Error ? saveError.message : 'A módosítás nem menthető.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wv-destination wv-calendar" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div><span className="wv-eyebrow">Alkotói naptár</span><h1>A csatornád alkotói ritmusa.</h1></div>
        <span className="wv-heading-meta">{laneCopy.lens}<br />aktuális alkotói fókusz</span>
      </header>

      {loading ? <CalendarLoading /> : error ? (
        <section className="wv-error-state">
          <span className="wv-error-stitch"><CircleAlert aria-hidden="true" /></span>
          <div><span className="wv-eyebrow">Betöltési hiba</span><h1>A naptár most nem érhető el.</h1><p>{error}</p></div>
          <button type="button" className="wv-secondary-action" onClick={() => void load()}><RefreshCw aria-hidden="true" />Újrapróbálás</button>
        </section>
      ) : (
        <>
          <section className="wv-calendar-stage" aria-labelledby="wv-calendar-stage-title">
            <div className="wv-calendar-focus">
              <span className="wv-eyebrow">Következő premier</span>
              {nextIdea ? (
                <>
                  <span className="wv-calendar-focus-date"><strong>{formatDate(nextIdea.scheduled_publish_date)}</strong><em>{nextIdea.platform || 'Platformfüggetlen'}</em></span>
                  <h2 id="wv-calendar-stage-title">{ideaTitle(nextIdea)}</h2>
                  <p>{nextIdea.calendar_notes || laneCopy.focus}</p>
                  <button type="button" className="wv-primary-action" onClick={() => setSelectedId(nextIdea.id)}>Premierfókusz megnyitása<ArrowUpRight aria-hidden="true" /></button>
                </>
              ) : (
                <>
                  <span className="wv-calendar-focus-date"><strong>Szabad premierhely</strong><em>{groups.ready.length} gyártásra kész projekt</em></span>
                  <h2 id="wv-calendar-stage-title">Adj időpontot a következő erős iránynak.</h2>
                  <p>{laneCopy.focus}</p>
                  {groups.ready[0] ? <button type="button" className="wv-primary-action" onClick={() => setSelectedId(groups.ready[0].id)}>Projekt ütemezése<ArrowUpRight aria-hidden="true" /></button> : <Link href="/dashboard/discover" className="wv-primary-action">Irány felfedezése<ArrowUpRight aria-hidden="true" /></Link>}
                </>
              )}
            </div>

            <div className="wv-calendar-week">
              <header>
                <div><span className="wv-eyebrow">Heti runway</span><h2>{calendarWeekLabel(week)}</h2></div>
                <div><button type="button" aria-label="Előző hét" onClick={() => { setAnchorDate(date => shiftCalendarWeek(date, -1)); setSelectedDay(null) }}><ChevronLeft aria-hidden="true" /></button><button type="button" onClick={() => { setAnchorDate(new Date()); setSelectedDay(null) }}>Ma</button><button type="button" aria-label="Következő hét" onClick={() => { setAnchorDate(date => shiftCalendarWeek(date, 1)); setSelectedDay(null) }}><ChevronRight aria-hidden="true" /></button></div>
              </header>
              <div className="wv-calendar-day-grid" aria-label="Hét napjai">
                {week.map(day => <button type="button" key={day.key} data-today={day.isToday || undefined} aria-pressed={selectedDay === day.key} onClick={() => setSelectedDay(current => current === day.key ? null : day.key)}><span>{day.weekday}</span><strong>{day.dayNumber}</strong><em>{day.month}</em><i data-count={day.ideas.length}>{day.ideas.length ? `${day.ideas.length} premier` : 'szabad'}</i></button>)}
              </div>
              <p>{laneCopy.support}</p>
            </div>
          </section>

          <div className="wv-calendar-status" aria-live="polite">{statusMessage}</div>

          <section className="wv-calendar-board" aria-label="Aktív publikálási terv">
            <div className="wv-calendar-runway">
              <header><div><span className="wv-eyebrow">Publikálási sor</span><h2>{selectedDay ? formatDate(selectedDay) : 'Következő premierek'}</h2></div><span>{visibleScheduled.length} projekt</span></header>
              {visibleScheduled.length > 0 ? <div>{visibleScheduled.map((idea, index) => (
                <article key={idea.id}>
                  <span className="wv-calendar-runway-index">{String(index + 1).padStart(2, '0')}</span>
                  <span className="wv-calendar-runway-line" aria-hidden="true"><i /></span>
                  <div><span>{formatDate(idea.scheduled_publish_date)} · {idea.platform || 'Platformfüggetlen'}</span><h3>{ideaTitle(idea)}</h3><p>{idea.calendar_notes || 'A premierhez még nincs külön alkotói emlékeztető.'}</p><button type="button" onClick={() => setSelectedId(idea.id)}>Ütemezés és fókusz<ArrowRight aria-hidden="true" /></button></div>
                </article>
              ))}</div> : <CalendarEmpty title={selectedDay ? 'Ezen a napon még szabad a premierhely.' : 'Még nincs ütemezett premier.'} copy="Válassz a gyártásra kész projektek közül, és adj neki publikálási időpontot." />}
            </div>

            <aside className="wv-calendar-ready" aria-labelledby="wv-calendar-ready-title">
              <header><PackageOpen aria-hidden="true" /><div><span className="wv-eyebrow">Gyártási sor</span><h2 id="wv-calendar-ready-title">Készen áll az ütemezésre.</h2></div><strong>{groups.ready.length}</strong></header>
              {groups.ready.length > 0 ? <div>{groups.ready.map(idea => (
                <article key={idea.id}><span>{idea.platform || 'Platformfüggetlen'}</span><h3>{ideaTitle(idea)}</h3><p>{idea.content_format || 'Formátum nélkül'}{idea.video_package_id ? ' · csomag elkészült' : ''}</p><button type="button" onClick={() => setSelectedId(idea.id)}>Időpont hozzáadása<CalendarClock aria-hidden="true" /></button></article>
              ))}</div> : <CalendarEmpty title="Nincs várakozó projekt." copy="A következő videócsomag elkészülése után itt jelenik meg az ütemezhető projekt." compact />}
              <Link href="/dashboard/create">Alkotási tér megnyitása<ArrowUpRight aria-hidden="true" /></Link>
            </aside>
          </section>

          <section className="wv-calendar-published" aria-labelledby="wv-calendar-published-title">
            <header><div><span className="wv-eyebrow">Publikált lenyomat</span><h2 id="wv-calendar-published-title">A ritmus, amit már felépítettél.</h2></div><Link href="/dashboard/growth">Visszacsatolás megnyitása<ArrowUpRight aria-hidden="true" /></Link></header>
            {groups.published.length > 0 ? <div>{groups.published.slice(0, 8).map((idea, index) => (
              <article key={idea.id}><span className={`tone-${(index % 3) + 1}`}><Play aria-hidden="true" /></span><div><small>{formatDate(idea.updated_at)} · {idea.platform || 'Platformfüggetlen'}</small><h3>{ideaTitle(idea)}</h3></div><Check aria-hidden="true" /></article>
            ))}</div> : <CalendarEmpty title="Az első publikált projekt itt hagy majd nyomot." copy="A publikált állapot nem teljesítményállítás, hanem a workflow lezárt lépése." />}
          </section>
        </>
      )}

      {selectedIdea && <CalendarEditor idea={selectedIdea} busy={busy} onClose={() => setSelectedId(null)} onSave={(date, notes) => patchIdea(selectedIdea, { calendar_status: 'scheduled', scheduled_publish_date: date, calendar_notes: notes || null }, 'A premier időpontja elmentve.')} onPublish={() => patchIdea(selectedIdea, { workflow_status: 'published', publish_status: 'published' }, 'A projekt publikált állapotba került.')} />}
    </div>
  )
}

function CalendarEmpty({ title, copy, compact = false }: { title: string; copy: string; compact?: boolean }) {
  return <div className={`wv-calendar-empty${compact ? ' is-compact' : ''}`}><span><Clock3 aria-hidden="true" /></span><div><h3>{title}</h3><p>{copy}</p></div></div>
}
