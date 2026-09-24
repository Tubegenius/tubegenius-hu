'use client'

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type RefObject } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  BookOpen,
  Eye,
  FileSearch,
  Info,
  MessageCircle,
  PlaySquare,
  Rocket,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react'
import { CREATOR_LANE_PRESENTATION, type CreatorLane } from '@/lib/creator-lane-presentation'
import {
  buildCreatorStudioHandoffHref,
  CREATOR_STUDIO_FORMATS,
  CREATOR_STUDIO_GOALS,
  type CreatorStudioFormatId,
  type CreatorStudioGoalId,
} from '@/lib/creator-studio-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import { useFocusTrap } from '@/lib/useFocusTrap'

function SourceAvailabilityDrawer({ onClose, returnFocusRef }: { onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null> }) {
  const panelRef = useFocusTrap(onClose, returnFocusRef)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const main = document.getElementById('willviral-main')
    const mainWasInert = main?.hasAttribute('inert') ?? false
    document.body.style.overflow = 'hidden'
    main?.setAttribute('inert', '')

    return () => {
      document.body.style.overflow = previousOverflow
      if (!mainWasInert) main?.removeAttribute('inert')
    }
  }, [])

  return createPortal(
    <div className="wv-source-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section
        ref={panelRef}
        className="wv-source-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wv-source-drawer-title"
        aria-describedby="wv-source-drawer-description"
        tabIndex={-1}
      >
        <header>
          <div><span>Kapcsolt források</span><h2 id="wv-source-drawer-title">Forrásadat még nincs betöltve</h2></div>
          <button type="button" aria-label="Forráspanel bezárása" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="wv-source-drawer-body">
          <FileSearch aria-hidden="true" />
          <p id="wv-source-drawer-description">A Workspace nem jelenít meg kitalált tanulmányt, állítást vagy ellenőrzési státuszt. A kapcsolt források akkor jelennek meg itt, amikor egy stabil projekt- és evidence-contract valós adatot ad hozzájuk.</p>
          <div className="wv-source-drawer-note"><Info aria-hidden="true" /><span>Ez tájékoztató panel. Nem hoz létre, nem módosít és nem igazol forrást.</span></div>
        </div>
        <footer><button type="button" className="wv-secondary-action" onClick={onClose}>Értem, vissza a projekthez</button></footer>
      </section>
    </div>,
    document.body,
  )
}

export default function CreatorWorkspace({ creatorLane: creatorLaneOverride }: { creatorLane?: CreatorLane }) {
  const { creatorLane: contextLane, setCreatorLane } = useCreatorOS()
  const [creatorLane, setProjectLane] = useState<CreatorLane>(creatorLaneOverride ?? contextLane)
  const [draftTitle, setDraftTitle] = useState('')
  const [format, setFormat] = useState<CreatorStudioFormatId>('long')
  const [goal, setGoal] = useState<CreatorStudioGoalId>('views')
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false)
  const sourceDrawerTriggerRef = useRef<HTMLButtonElement>(null)
  const lane = CREATOR_LANE_PRESENTATION[creatorLane]
  const selectedFormat = CREATOR_STUDIO_FORMATS[format]
  const handoffHref = buildCreatorStudioHandoffHref({ title: draftTitle, lane: creatorLane, format, goal })

  function selectLane(nextLane: CreatorLane) {
    setProjectLane(nextLane)
    setCreatorLane(nextLane)
  }

  function rememberStudioHandoff() {
    if (!handoffHref) return
    sessionStorage.setItem('willviral_creator_studio_handoff', JSON.stringify({
      title: draftTitle.trim(),
      lane: creatorLane,
      format,
      goal,
    }))
  }

  return (
    <div className="wv-workshop" data-creator-lane={creatorLane}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">Alkotás · Creator Studio</span>
          <h1>Készíts elő egy valós gyártási indítást.</h1>
        </div>
        <span className="wv-heading-meta">Nincs aktív projekt betöltve<br />{lane.label} alkotói mód</span>
      </header>

      <section className="wv-studio-launch" aria-labelledby="wv-studio-launch-title">
        <div className="wv-studio-launch-main">
          <header>
            <span className="wv-eyebrow"><Rocket aria-hidden="true" /> Biztonságos előkészítés</span>
            <h2 id="wv-studio-launch-title">Add meg a saját ötletedet. Innen valódi működő eszközbe lépsz tovább.</h2>
            <p>A beállítások ezen a képernyőn lokális előkészítést jelentenek. A Gyártási csomag következő képernyőjén ellenőrizheted őket, és ott indulhat tényleges backendművelet.</p>
          </header>

          <label className="wv-studio-title-field">
            <span>Projekt témája vagy munkacíme</span>
            <input
              value={draftTitle}
              onChange={event => setDraftTitle(event.target.value)}
              placeholder="Írd be a saját videóötletedet"
              maxLength={180}
            />
            <small>{draftTitle.trim().length}/180 · csak az általad megadott szöveget adjuk tovább</small>
          </label>

          <div className="wv-studio-choice-block">
            <div className="wv-studio-choice-heading"><span>01</span><div><strong>Creator Lane</strong><small>Lokális alkotói beállítás ehhez az indításhoz</small></div></div>
            <div className="wv-studio-lane-grid">
              <button type="button" aria-pressed={creatorLane === 'evidence'} onClick={() => selectLane('evidence')}>
                <span><ShieldCheck aria-hidden="true" /> Bizonyítékvezérelt</span>
                <strong>Kutatásból, állításokból és érthető magyarázatból épít.</strong>
                <small>Tények · oktatás · elemzés · dokumentarista tartalom</small>
              </button>
              <button type="button" aria-pressed={creatorLane === 'entertainment'} onClick={() => selectLane('entertainment')}>
                <span><Sparkles aria-hidden="true" /> Élményvezérelt</span>
                <strong>Nyitásból, jelenetritmusból és kifizetésből épít.</strong>
                <small>Humor · karakter · történet · szórakoztatás</small>
              </button>
            </div>
          </div>

          <div className="wv-studio-config-grid">
            <div className="wv-studio-choice-block">
              <div className="wv-studio-choice-heading"><span>02</span><div><strong>Formátum</strong><small>A következő működő route bemenete</small></div></div>
              <div className="wv-studio-format-grid">
                {(Object.entries(CREATOR_STUDIO_FORMATS) as [CreatorStudioFormatId, typeof CREATOR_STUDIO_FORMATS[CreatorStudioFormatId]][]).map(([id, item]) => (
                  <button type="button" key={id} aria-pressed={format === id} onClick={() => setFormat(id)}>
                    {id === 'short' ? <Smartphone aria-hidden="true" /> : <PlaySquare aria-hidden="true" />}
                    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  </button>
                ))}
              </div>
            </div>

            <div className="wv-studio-choice-block">
              <div className="wv-studio-choice-heading"><span>03</span><div><strong>Elsődleges cél</strong><small>Lokális kreatív fókusz</small></div></div>
              <div className="wv-studio-goal-grid">
                {(Object.entries(CREATOR_STUDIO_GOALS) as [CreatorStudioGoalId, string][]).map(([id, label]) => {
                  const Icon = id === 'views' ? Eye : id === 'comments' ? MessageCircle : Share2
                  return <button type="button" key={id} aria-pressed={goal === id} onClick={() => setGoal(id)}><Icon aria-hidden="true" /><span>{label}</span></button>
                })}
              </div>
            </div>
          </div>
        </div>

        <aside className="wv-studio-launch-summary">
          <span className="wv-eyebrow">Indítási összegzés</span>
          <h3>{draftTitle.trim() || 'A saját videóötleted még hiányzik'}</h3>
          <dl>
            <div><dt>Alkotói logika</dt><dd>{lane.label}</dd></div>
            <div><dt>Gyártási forma</dt><dd>{selectedFormat.label}</dd></div>
            <div><dt>Elsődleges cél</dt><dd>{CREATOR_STUDIO_GOALS[goal]}</dd></div>
          </dl>
          <Link
            href={handoffHref ?? '#'}
            className={`wv-studio-launch-action${handoffHref ? '' : ' is-disabled'}`}
            aria-disabled={!handoffHref}
            onClick={event => {
              if (!handoffHref) event.preventDefault()
              else rememberStudioHandoff()
            }}
          >
            <span>{handoffHref ? 'Tovább a Gyártási csomagba' : 'Adj címet a projektnek'}</span>
            <ArrowRight aria-hidden="true" />
          </Link>
          <p>A generálás nem ezen a gombon történik. A következő képernyőn a meglévő Video Package folyamat veszi át a beállításokat.</p>
        </aside>
      </section>

      <section className="wv-truth-hero wv-workspace-empty" aria-labelledby="wv-workspace-empty-title">
        <div className="wv-truth-hero-copy">
          <span className="wv-empty-mark"><BookOpen aria-hidden="true" /></span>
          <div>
            <span className="wv-eyebrow">Projekt Workspace</span>
            <h2 id="wv-workspace-empty-title">Nincs betöltött, perzisztens content project.</h2>
            <p>Állításokat, forrásokat, készültségi százalékot és publikálási kaput csak valódi projektadat alapján jelenítünk meg.</p>
          </div>
        </div>
        <div className="wv-truth-actions">
          <button ref={sourceDrawerTriggerRef} type="button" className="wv-secondary-action" onClick={() => setSourceDrawerOpen(true)}><FileSearch aria-hidden="true" />Kapcsolt források állapota</button>
          <Link href="/dashboard/memory" className="wv-secondary-action">Tartalommemória megnyitása</Link>
        </div>
      </section>

      {sourceDrawerOpen ? <SourceAvailabilityDrawer onClose={() => setSourceDrawerOpen(false)} returnFocusRef={sourceDrawerTriggerRef} /> : null}
    </div>
  )
}
