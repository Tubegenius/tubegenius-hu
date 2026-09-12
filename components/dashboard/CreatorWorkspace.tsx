'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clapperboard,
  Eye,
  FileText,
  Flame,
  Link2,
  MessageCircle,
  PlaySquare,
  Plus,
  Radar,
  Rocket,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Target,
  X,
} from 'lucide-react'
import { CREATOR_LANE_PRESENTATION, type CreatorLane, type CreatorLaneStageId } from '@/lib/creator-lane-presentation'
import type { CreatorOpportunity } from '@/lib/creator-opportunity-presentation'
import {
  buildCreatorStudioHandoffHref,
  CREATOR_STUDIO_FORMATS,
  CREATOR_STUDIO_GOALS,
  type CreatorStudioFormatId,
  type CreatorStudioGoalId,
} from '@/lib/creator-studio-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

type StageId = CreatorLaneStageId
type SourceKind = 'confirmed' | 'review'

interface CreatorWorkspaceProps {
  creatorLane?: CreatorLane
  starter?: CreatorOpportunity | null
  discoverHref?: string
}

export default function CreatorWorkspace({ creatorLane: creatorLaneOverride, starter = null, discoverHref = '/dashboard/discover' }: CreatorWorkspaceProps) {
  const { creatorLane: contextLane, setCreatorLane } = useCreatorOS()
  const [creatorLane, setProjectLane] = useState<CreatorLane>(starter?.lane ?? creatorLaneOverride ?? contextLane)
  const lane = CREATOR_LANE_PRESENTATION[creatorLane]
  const stages = lane.stages
  const [activeStage, setActiveStage] = useState<StageId>('research')
  const [sourceOpen, setSourceOpen] = useState(false)
  const [sourceKind, setSourceKind] = useState<SourceKind>('review')
  const [verified, setVerified] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [starterAccepted, setStarterAccepted] = useState(false)
  const [draftTitle, setDraftTitle] = useState(starter?.title ?? '')
  const [format, setFormat] = useState<CreatorStudioFormatId>(starter?.tags.includes('Rövid videó') ? 'short' : 'long')
  const [goal, setGoal] = useState<CreatorStudioGoalId>('views')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const lastSourceButtonRef = useRef<HTMLButtonElement | null>(null)
  const publishReady = creatorLane === 'entertainment' || verified
  const projectTitle = draftTitle.trim() || 'Új alkotói projekt'
  const selectedFormat = CREATOR_STUDIO_FORMATS[format]
  const handoffHref = buildCreatorStudioHandoffHref({ title: draftTitle, lane: creatorLane, format, goal })
  const starterStructure = creatorLane === 'evidence'
    ? ['Megfigyelés', 'Bizonyítási irány', 'Nézői következmény']
    : ['Belépés', 'Eszkaláció', 'Kifizetés']

  useEffect(() => {
    if (!starter) return
    setProjectLane(starter.lane)
    setCreatorLane(starter.lane)
    setDraftTitle(starter.title)
    setFormat(starter.tags.includes('Rövid videó') ? 'short' : 'long')
    setActiveStage('research')
    setSourceOpen(false)
    setVerified(false)
    setStarterAccepted(false)
  }, [starter, setCreatorLane])

  useEffect(() => {
    if (sourceOpen) closeButtonRef.current?.focus()
  }, [sourceOpen])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 1600)
    return () => window.clearTimeout(timer)
  }, [toast])

  function closeSource(restoreFocus = true) {
    setSourceOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => lastSourceButtonRef.current?.focus())
  }

  function openSource(kind: SourceKind, button: HTMLButtonElement) {
    setSourceKind(kind)
    lastSourceButtonRef.current = button
    setSourceOpen(true)
  }

  function verifySource() {
    setVerified(true)
    closeSource(false)
    setToast('A forrás ellenőrzött. A projekt megmaradt a fókuszban.')
  }

  function selectLane(nextLane: CreatorLane) {
    setProjectLane(nextLane)
    setCreatorLane(nextLane)
    setSourceOpen(false)
  }

  function rememberStudioHandoff() {
    if (!handoffHref) return
    sessionStorage.setItem('willviral_creator_studio_handoff', JSON.stringify({
      title: draftTitle.trim(),
      lane: creatorLane,
      format,
      goal,
      starterId: starter?.id ?? null,
    }))
  }

  function handleStageKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = stages.length - 1
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = lastIndex
    if (nextIndex === null) return

    event.preventDefault()
    const nextStage = stages[nextIndex]
    setActiveStage(nextStage.id)
    setSourceOpen(false)
    window.requestAnimationFrame(() => document.getElementById(`wv-tab-${nextStage.id}`)?.focus())
  }

  return (
    <div className="wv-workshop" data-creator-lane={creatorLane} onKeyDown={event => {
      if (event.key === 'Escape' && sourceOpen) closeSource()
    }}>
      <header className="wv-page-heading">
        <div>
          <span className="wv-eyebrow">Alkotás · Creator Studio</span>
          <h1>{projectTitle}</h1>
        </div>
        <span className="wv-heading-meta">{starter ? 'Opportunity Briefből indítva' : 'Új projekt'}<br />{lane.label} Lane</span>
      </header>

      <section className="wv-studio-launch" aria-labelledby="wv-studio-launch-title">
        <div className="wv-studio-launch-main">
          <header>
            <span className="wv-eyebrow"><Rocket aria-hidden="true" /> Új projekt indítása</span>
            <h2 id="wv-studio-launch-title">Adj irányt. A rendszer továbbviszi.</h2>
            <p>A Lane a projekt alkotói logikája. A formátum és a cél közvetlenül átkerül a Gyártási csomagba.</p>
          </header>

          <label className="wv-studio-title-field">
            <span>Projekt témája vagy munkacíme</span>
            <input
              value={draftTitle}
              onChange={event => setDraftTitle(event.target.value)}
              placeholder="Például: Miért nézzük újra ugyanazokat a videókat?"
              maxLength={180}
            />
            <small>{draftTitle.trim().length}/180 · ezt a témát kapja meg a gyártási folyamat</small>
          </label>

          <div className="wv-studio-choice-block">
            <div className="wv-studio-choice-heading"><span>01</span><div><strong>Creator Lane</strong><small>Projektenként választott alkotói gondolkodás</small></div></div>
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
              <div className="wv-studio-choice-heading"><span>02</span><div><strong>Formátum</strong><small>A gyártási mélységet is meghatározza</small></div></div>
              <div className="wv-studio-format-grid">
                {(Object.entries(CREATOR_STUDIO_FORMATS) as [CreatorStudioFormatId, typeof CREATOR_STUDIO_FORMATS[CreatorStudioFormatId]][]).map(([id, item]) => (
                  <button type="button" key={id} aria-pressed={format === id} onClick={() => setFormat(id)}>
                    {id === 'short' ? <Smartphone aria-hidden="true" /> : <PlaySquare aria-hidden="true" />}
                    <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                    <b>{item.creditCost} kredit</b>
                  </button>
                ))}
              </div>
            </div>

            <div className="wv-studio-choice-block">
              <div className="wv-studio-choice-heading"><span>03</span><div><strong>Elsődleges cél</strong><small>A csomag kreatív fókusza</small></div></div>
              <div className="wv-studio-goal-grid">
                {(Object.entries(CREATOR_STUDIO_GOALS) as [CreatorStudioGoalId, string][]).map(([id, label]) => {
                  const Icon = id === 'views' ? Eye : id === 'comments' ? MessageCircle : Share2
                  return <button type="button" key={id} aria-pressed={goal === id} onClick={() => setGoal(id)}><Icon aria-hidden="true" /><span>{label}</span></button>
                })}
              </div>
            </div>
          </div>

          <div className="wv-studio-context-row">
            <Target aria-hidden="true" />
            <span><strong>{starter ? 'Opportunity Brief kapcsolva' : 'Saját ötletből indul'}</strong><small>{starter ? `${starter.horizon} időablak · ${starter.channelFit} csatornailleszkedés` : 'A projekt a Creator Profile jelenlegi csatornakörnyezetében nyílik meg.'}</small></span>
            <div><Link href={discoverHref}><Radar aria-hidden="true" />Lehetőség választása</Link><Link href="/dashboard/memory"><BookOpen aria-hidden="true" />Memória megnyitása</Link></div>
          </div>
        </div>

        <aside className="wv-studio-launch-summary">
          <div className="wv-studio-launch-orbit" aria-hidden="true"><i /><span /><Rocket /></div>
          <span className="wv-eyebrow">Indítási összegzés</span>
          <h3>{draftTitle.trim() || 'A projekt címe még hiányzik'}</h3>
          <ol className="wv-studio-launch-path" aria-label="Projektindítási útvonal">
            <li className={draftTitle.trim() ? 'is-ready' : 'is-pending'}><i>01</i><span><strong>Projektmag</strong><small>{draftTitle.trim() ? 'A munkacím rögzítve' : 'Munkacím szükséges'}</small></span></li>
            <li className="is-ready"><i>02</i><span><strong>Lane-logika</strong><small>{lane.label} döntési rend</small></span></li>
            <li className="is-ready"><i>03</i><span><strong>Gyártási forma</strong><small>{selectedFormat.detail}</small></span></li>
            <li><i>04</i><span><strong>Beállítás-ellenőrzés</strong><small>A következő képernyőn történik</small></span></li>
          </ol>
          <dl>
            <div><dt>Alkotói logika</dt><dd>{lane.label}</dd></div>
            <div><dt>Gyártási forma</dt><dd>{selectedFormat.label}</dd></div>
            <div><dt>Elsődleges cél</dt><dd>{CREATOR_STUDIO_GOALS[goal]}</dd></div>
            <div><dt>Indítási költség</dt><dd>{selectedFormat.creditCost} kredit</dd></div>
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
          <p>A generálás nem ezen a gombon történik. A következő képernyőn még ellenőrizheted a teljes beállítást.</p>
        </aside>
      </section>

      <div className="wv-studio-workspace-label"><span>Projektváz és alkotói kapuk</span><p>Az alábbi munkatér szemlélteti, hogyan különül el a két Lane kidolgozási logikája.</p></div>

      <div className={`wv-workspace-layout${sourceOpen ? ' has-panel' : ''}`}>
        <section className="wv-workspace" aria-label="Projektműhely">
          <header className="wv-workspace-head">
            <div><strong>Projektműhely</strong><span>{creatorLane === 'evidence' ? 'A nézőnek szánt mondat és a mögötte álló bizonyíték együtt marad.' : 'Az élményígéret, a ritmus és a kifizetés együtt marad.'}</span></div>
            <Link href={starter ? discoverHref : '/dashboard'} className="wv-workspace-back"><ArrowLeft aria-hidden="true" />{starter ? 'Vissza a Felfedezéshez' : 'Vissza a Mai irányhoz'}</Link>
          </header>

          {starter && <div className="wv-project-inheritance">
            <span className="wv-inheritance-icon"><Sparkles aria-hidden="true" /></span>
            <div><span>Projektöröklés · szemléltető adapter</span><strong>A brief döntései veled jöttek.</strong><p>A nézői ígéret, az időzítés és a következő alkotói lépés nem veszett el az oldalváltásban.</p></div>
            <em className={starterAccepted ? 'is-ready' : ''}>{starterAccepted ? 'Projektmag rögzítve' : 'Még nincs mentve'}</em>
          </div>}

          <div className="wv-stage-tabs" role="tablist" aria-label="Alkotási szakaszok">
            {stages.map((stage, index) => (
              <button
                key={stage.id}
                type="button"
                role="tab"
                id={`wv-tab-${stage.id}`}
                aria-controls={`wv-panel-${stage.id}`}
                aria-selected={activeStage === stage.id}
                tabIndex={activeStage === stage.id ? 0 : -1}
                className={activeStage === stage.id ? 'is-active' : ''}
                onKeyDown={event => handleStageKeyDown(event, index)}
                onClick={() => {
                  setActiveStage(stage.id)
                  setSourceOpen(false)
                }}
              >
                <span>{stage.number}</span>{stage.label}
              </button>
            ))}
          </div>

          <section id="wv-panel-research" role="tabpanel" aria-labelledby="wv-tab-research" hidden={activeStage !== 'research'} className="wv-workspace-panel">
            {starter ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Örökölt projektmag</span><h2>{creatorLane === 'evidence' ? 'Előbb rögzítsd, mit kell bizonyítani.' : 'Előbb rögzítsd, mit kell éreztetni.'}</h2><p>A brief irányt ad, de nem tesz úgy, mintha a kutatás vagy a kreatív kidolgozás már elkészült volna.</p></div><button type="button" className={`wv-primary-button${starterAccepted ? ' is-complete' : ''}`} aria-pressed={starterAccepted} onClick={() => { setStarterAccepted(true); setToast('A projektmag helyben rögzítve. Ez továbbra is szemléltető állapot.') }}><Check aria-hidden="true" />{starterAccepted ? 'Projektmag rögzítve' : 'Projektmag rögzítése'}</button></div>
              <div className="wv-research-grid wv-starter-grid"><article><Radar aria-hidden="true" /><span><strong>Miért most?</strong><small>{starter.whyNow}</small></span></article><article><Sparkles aria-hidden="true" /><span><strong>Nézői ígéret</strong><small>{starter.audiencePromise}</small></span></article></div>
            </> : creatorLane === 'evidence' ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Kutatási térkép</span><h2>A projektbe emelt bizonyítékok</h2><p>A kapcsolatok vizuálisan is megmaradnak az állítások mellett.</p></div><button type="button" className="wv-secondary-button" onClick={() => setToast('A minta nem kapcsolódik külső adatforráshoz.')}><Plus aria-hidden="true" />Forrás hozzáadása</button></div>
              <div className="wv-research-grid"><article><FileText aria-hidden="true" /><span><strong>Felületi hőmérséklet</strong><small>3 forrás · 2 megerősített kapcsolat</small></span></article><article><ShieldCheck aria-hidden="true" /><span><strong>Lombkorona és utcaszerkezet</strong><small>2 forrás · 1 ellenőrzés szükséges</small></span></article></div>
            </> : <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Koncepciómag</span><h2>Egy azonnal érthető komikus ígéret</h2><p>Nem bizonyítást építünk, hanem helyzetet, karaktert és felismerhető feszültséget.</p></div><button type="button" className="wv-secondary-button" onClick={() => setToast('Új koncepcióváltozat hozzáadva a szemléltető projekthez.')}><Plus aria-hidden="true" />Variáció hozzáadása</button></div>
              <div className="wv-research-grid wv-experience-grid"><article><Sparkles aria-hidden="true" /><span><strong>Ismerős kudarc</strong><small>Minden lakás tökéletes — amíg belépünk az ajtón.</small></span></article><article><Flame aria-hidden="true" /><span><strong>Karakterígéret</strong><small>Túl magabiztos néző, egyre rosszabb döntésekkel.</small></span></article></div>
            </>}
          </section>

          <section id="wv-panel-claims" role="tabpanel" aria-labelledby="wv-tab-claims" hidden={activeStage !== 'claims'} className="wv-workspace-panel">
            {starter ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">{creatorLane === 'evidence' ? 'Állításszerkezet' : 'Élményív'}</span><h2>{creatorLane === 'evidence' ? 'Három hely a bizonyítható gondolatmenetnek' : 'Három hely az emelkedő élménynek'}</h2><p>A szerkezet átjött a briefből; a tényleges tartalmat csak az alkotói kidolgozás töltheti ki.</p></div></div>
              <div className={`wv-claim-list${creatorLane === 'entertainment' ? ' wv-experience-list' : ''}`}>
                {starterStructure.map((label, index) => {
                  const copy = [starter.audiencePromise, starter.whyNow, starter.nextMove][index]
                  return <article className={`wv-claim${index === 1 ? ' is-warning' : ''}`} key={label}><i>{index + 1}</i><div><strong>{label}</strong><span>{copy}</span></div><em className={index === 0 && starterAccepted ? 'is-verified' : 'is-review'}>{index === 0 && starterAccepted ? 'Örökölt' : 'Kidolgozandó'}</em></article>
                })}
              </div>
            </> : creatorLane === 'evidence' ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Állítástérkép</span><h2>Három mondat, három ellenőrizhető kapcsolat</h2><p>A bizonytalanság látható marad, de nem töri szét a munkafolyamatot.</p></div><button type="button" className="wv-secondary-button" onClick={() => setToast('Az új állítás szerkesztője a következő integrációs mélység része.')}><Plus aria-hidden="true" />Új állítás</button></div>
              <div className="wv-claim-list">
                <article className="wv-claim"><i>1</i><div><strong>Nem a fák száma, hanem az árnyékolt felület aránya döntő.</strong><span>Két egymást erősítő forrás kapcsolódik.</span><button type="button" onClick={event => openSource('confirmed', event.currentTarget)}><Link2 aria-hidden="true" />Forráskapcsolat megnyitása</button></div><em className="is-verified">Ellenőrzött</em></article>
                <article className={`wv-claim${verified ? '' : ' is-warning'}`}><i>2</i><div><strong>A lombkorona alatt akár hat fokkal alacsonyabb lehet a felszíni hőmérséklet.</strong><span>A tartomány hely- és mérési módszerfüggő. Pontosítás szükséges.</span><button type="button" onClick={event => openSource('review', event.currentTarget)}><Link2 aria-hidden="true" />Forráskapcsolat megnyitása</button></div><em className={verified ? 'is-verified' : 'is-review'}>{verified ? 'Ellenőrzött' : 'Ellenőrzendő'}</em></article>
                <article className="wv-claim"><i>3</i><div><strong>Az esti visszahűléshez a burkolatok hőtárolása is hozzájárul.</strong><span>Egy elsődleges és egy összefoglaló forrás kapcsolódik.</span><button type="button" onClick={event => openSource('confirmed', event.currentTarget)}><Link2 aria-hidden="true" />Forráskapcsolat megnyitása</button></div><em className="is-verified">Ellenőrzött</em></article>
              </div>
            </> : <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Élményív</span><h2>Feszültség, gyorsulás, kifizetés</h2><p>Minden pontnak új energiát kell adnia; itt a nézői figyelem ritmusa a kontroll.</p></div><button type="button" className="wv-secondary-button" onClick={() => setToast('Új élménypont hozzáadva a szemléltető ívhez.')}><Plus aria-hidden="true" />Élménypont hozzáadása</button></div>
              <div className="wv-claim-list wv-experience-list">
                <article className="wv-claim"><i>1</i><div><strong>Azonnali tévedés</strong><span>A karakter három másodperc alatt rosszul értelmezi az első lakást.</span></div><em>Belépés</em></article>
                <article className="wv-claim is-warning"><i>2</i><div><strong>Egyre gyorsabb rossz döntések</strong><span>A második jelenet rövidítésével erősebb lesz az impulzusváltás.</span></div><em className="is-review">Finomítandó</em></article>
                <article className="wv-claim"><i>3</i><div><strong>Visszafordított kifizetés</strong><span>A végén kiderül: az egyetlen jó lakást ő beszélte le.</span></div><em>Payoff</em></article>
              </div>
            </>}
          </section>

          <section id="wv-panel-explanation" role="tabpanel" aria-labelledby="wv-tab-explanation" hidden={activeStage !== 'explanation'} className="wv-workspace-panel">
            {starter ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">{creatorLane === 'evidence' ? 'Magyarázati váz' : 'Jelenetváz'}</span><h2>A briefből alkotói szerkezet lesz.</h2><p>Az örökölt döntések kapaszkodók; a kész videó hangját nem írják meg helyetted.</p></div><button type="button" className="wv-secondary-button" onClick={() => setToast('A részletes szerkesztés a következő frontendmélységben nyílik meg.')}><ArrowUpRight aria-hidden="true" />Részletes szerkesztés</button></div>
              <div className={`wv-story-grid${creatorLane === 'entertainment' ? ' wv-scene-grid' : ''}`}><article><span className="wv-eyebrow">Nyitás alapja</span><strong>{starter.audiencePromise}</strong><p>{starter.tags.join(' · ')}</p></article><article><span className="wv-eyebrow">Következő döntés</span><strong>{starter.nextMove}</strong><p>A rendszer ezt a döntést viszi tovább, nem egy késznek állított szöveget.</p></article></div>
            </> : creatorLane === 'evidence' ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Magyarázat és képsor</span><h2>A bizonyítékból nézőbarát gondolatmenet</h2><p>Előbb a tét, utána a mérés és csak ezután a részletek.</p></div><button type="button" className="wv-primary-button" onClick={() => setToast('A nyitás szerkesztési pontja működésre előkészítve.')}><span>Nyitás kidolgozása</span><ArrowUpRight aria-hidden="true" /></button></div>
              <div className="wv-story-grid"><article><span className="wv-eyebrow">Nyitás</span><strong>Ugyanaz az utca. Hat fok különbség.</strong><p>Az eredmény látszik, mielőtt a magyarázat elkezdődik.</p></article><article><span className="wv-eyebrow">Fordulópont</span><strong>Nem minden zöldfelület hűt ugyanúgy.</strong><p>A lombkorona és a burkolat együtt adja meg az okot.</p></article></div>
            </> : <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Jelenetritmus</span><h2>A poén nem kártya, hanem időzítés</h2><p>A jelenetek külön blokkok, de az energia egyetlen folyamatos ívben emelkedik.</p></div><button type="button" className="wv-primary-button" onClick={() => setToast('A jelenetritmus előnézete elindult.')}><span>Ritmus előnézete</span><ArrowUpRight aria-hidden="true" /></button></div>
              <div className="wv-story-grid wv-scene-grid"><article><span className="wv-eyebrow">00:00 · Cold open</span><Clapperboard aria-hidden="true" /><strong>„Ez biztosan csak hangulatos.”</strong><p>Vágás az ajtó mögötti teljes káoszra.</p></article><article><span className="wv-eyebrow">00:18 · Fordítás</span><Flame aria-hidden="true" /><strong>A néző már előbb tudja, hogy baj lesz.</strong><p>A vágás fél ütemmel megelőzi a karakter felismerését.</p></article></div>
            </>}
          </section>

          <section id="wv-panel-publish" role="tabpanel" aria-labelledby="wv-tab-publish" hidden={activeStage !== 'publish'} className="wv-workspace-panel">
            {starter ? <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Publikálási ellenőrzés</span><h2>A projektmag még nem kész videó.</h2><p>A publikálás addig zárva marad, amíg a Lane saját alkotói és biztonsági kapui nem teljesülnek.</p></div><button type="button" className="wv-primary-button" disabled><span>Kidolgozás szükséges</span><Check aria-hidden="true" /></button></div>
              <div className="wv-publish-checks"><div className={starterAccepted ? '' : 'is-pending'}>{starterAccepted ? <CheckCircle2 aria-hidden="true" /> : <Sparkles aria-hidden="true" />}<span><strong>Projektmag</strong><small>{starterAccepted ? 'A nézői ígéret és az irány rögzítve' : 'A projektmag még nincs rögzítve'}</small></span></div><div className="is-pending"><Link2 aria-hidden="true" /><span><strong>{creatorLane === 'evidence' ? 'Bizonyíték és magyarázat' : 'Élményív és jelenetritmus'}</strong><small>A részletes kidolgozás még hátravan</small></span></div></div>
            </> : <>
              <div className="wv-panel-intro"><div><span className="wv-eyebrow">Publikálási ellenőrzés</span><h2>{creatorLane === 'evidence' ? 'A cím, a vizuális ígéret és a tényállítások együtt' : 'A nyitás, a ritmus és a kifizetés együtt'}</h2><p>{creatorLane === 'evidence' ? 'A felület megmutatja, pontosan mi tartja zárva a következő lépést.' : 'A kreatív kapu az élmény koherenciáját ellenőrzi; bizonyíték csak tényállításnál szükséges.'}</p></div><button type="button" className="wv-primary-button" disabled={!publishReady} onClick={() => setToast(creatorLane === 'evidence' ? 'A minta publikálási kapuja megnyílt.' : 'Az élményív készen áll a következő lépésre.')}><span>{creatorLane === 'evidence' ? (verified ? 'Ellenőrzés lezárása' : 'Még 1 forrás szükséges') : 'Élményív lezárása'}</span><Check aria-hidden="true" /></button></div>
              {creatorLane === 'evidence' ? <div className="wv-publish-checks"><div><CheckCircle2 aria-hidden="true" /><span><strong>Címirány</strong><small>Érthető ígéret, a tartalommal összhangban</small></span></div><div className={verified ? '' : 'is-pending'}>{verified ? <CheckCircle2 aria-hidden="true" /> : <Link2 aria-hidden="true" />}<span><strong>Biztonsági kapu</strong><small>{verified ? '3/3 kulcsállítás ellenőrzött' : '2/3 kulcsállítás ellenőrzött'}</small></span></div></div> : <div className="wv-publish-checks wv-experience-checks"><div><CheckCircle2 aria-hidden="true" /><span><strong>Nyitási impulzus</strong><small>Az első három másodpercben megszületik a helyzet</small></span></div><div><CheckCircle2 aria-hidden="true" /><span><strong>Kifizetés</strong><small>A befejezés visszafordítja a karakter magabiztosságát</small></span></div></div>}
            </>}
          </section>
        </section>

        {creatorLane === 'evidence' && <aside className="wv-source-panel" aria-hidden={!sourceOpen}>
          <header><div><span>Bizonyítékkapocs</span><h2>Forrás részletei</h2></div><button ref={closeButtonRef} type="button" aria-label="Forráspanel bezárása" onClick={() => closeSource()}><X aria-hidden="true" /></button></header>
          <div className="wv-source-body"><h3>{sourceKind === 'review' ? 'Városi lombkorona és felszíni hőmérséklet' : 'Árnyékolt felület és városi hőterhelés'}</h3><p>{sourceKind === 'review' ? 'A mért eltérés helyszínenként változik. A „hat fok” a bemutatott vizsgálat tartományán belül igaz.' : 'A forrás közvetlenül összeveti az árnyékolt felület arányát a nappali felszíni hőmérséklettel.'}</p><dl><div><dt>Típus</dt><dd>Kutatási tanulmány</dd></div><div><dt>Kiadás</dt><dd>2025</dd></div><div><dt>Kapcsolat</dt><dd>{sourceKind === 'review' ? 'Állítás 02' : 'Ellenőrzött'}</dd></div></dl><div className="wv-source-guidance"><strong>WillViral-értelmezés</strong><span>{sourceKind === 'review' ? 'A narrációban nevezd meg, hogy felszíni — nem levegő — hőmérsékletről van szó.' : 'A kapcsolat elég erős ahhoz, hogy a magyarázat szerkezetében is megtartsd.'}</span></div>{sourceKind === 'review' && !verified && <button type="button" className="wv-source-verify" onClick={verifySource}><span>Megjelölöm ellenőrzöttnek</span><Check aria-hidden="true" /></button>}</div>
        </aside>}
      </div>

      {toast && <div className="wv-toast" role="status" aria-live="polite"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>}
    </div>
  )
}
