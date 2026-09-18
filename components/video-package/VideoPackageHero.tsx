import { Calendar, CheckCircle2, Clock3, Coins, FileCheck2, Globe2, PlayCircle } from 'lucide-react'
import type { BadgeVariant } from '@/components/ui/Badge'

export interface MetaBadge {
  label: string
  value: string
}

export interface QualityMetaDisplay {
  label: string
  variant: BadgeVariant
}

export interface SourceCounts {
  webCount: number
  videoCount: number
}

export interface SaveStatusDisplay {
  label: string
  variant: 'success' | 'info'
}

export type CalendarStatus = 'idle' | 'saving' | 'saved' | 'error'

interface VideoPackageHeroProps {
  topic: string
  metaBadges: MetaBadge[]
  qualityMeta: QualityMetaDisplay
  productionStatusLabel: string | null
  preparationModeNote: string | null
  intensityNote: string | null
  riskFlags: string[]
  sourceCounts: SourceCounts
  targetLengthLabel: string | null
  saveStatus: SaveStatusDisplay | null
  creditsRemaining: number | null
  calendarStatus: CalendarStatus
  onSaveToCalendar: () => void
}

// Prezentációs komponens: minden státusz és érték a meglévő oldal-logikából
// érkezik. Nem számol minőséget, nem ment és nem indít generálást.
export default function VideoPackageHero({
  topic,
  metaBadges,
  qualityMeta,
  productionStatusLabel,
  preparationModeNote,
  intensityNote,
  riskFlags,
  sourceCounts,
  targetLengthLabel,
  saveStatus,
  creditsRemaining,
  calendarStatus,
  onSaveToCalendar,
}: VideoPackageHeroProps) {
  let calendarLabel: string
  let calendarDisabled: boolean
  switch (calendarStatus) {
    case 'saving':
      calendarLabel = 'Mentés…'
      calendarDisabled = true
      break
    case 'saved':
      calendarLabel = 'Naptárba mentve'
      calendarDisabled = true
      break
    case 'error':
      calendarLabel = 'Újrapróbálás'
      calendarDisabled = false
      break
    case 'idle':
    default:
      calendarLabel = 'Naptárba mentés'
      calendarDisabled = false
  }

  return (
    <section className="wv-package-result-hero" aria-labelledby="wv-package-result-topic">
      <div className="wv-package-result-main">
        <header>
          <span><FileCheck2 aria-hidden="true" /> Gyártásra rendezett projekt</span>
          <div>
            <b data-variant={qualityMeta.variant}>{qualityMeta.label}</b>
            {productionStatusLabel && <b>{productionStatusLabel}</b>}
          </div>
        </header>
        <h2 id="wv-package-result-topic">{topic}</h2>
        {metaBadges.length > 0 && <dl className="wv-package-result-meta">{metaBadges.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}

        {(preparationModeNote || intensityNote) && (
          <div className="wv-package-result-notes">
            {preparationModeNote && <p>{preparationModeNote}</p>}
            {intensityNote && <p><strong>Intenzitás visszavéve:</strong> {intensityNote}</p>}
          </div>
        )}

        {riskFlags.length > 0 && <div className="wv-package-result-risks"><span>Figyelendő pontok</span><div>{riskFlags.map(flag => <b key={flag}>{flag}</b>)}</div></div>}
      </div>

      <aside className="wv-package-result-status">
        <div className="wv-package-result-orbit" aria-hidden="true"><i /><span /><CheckCircle2 /></div>
        <span className="wv-credit-kicker">Csomagállapot</span>
        <h3>{saveStatus?.label ?? 'A gyártási dosszié elkészült'}</h3>
        <div className="wv-package-result-facts">
          <div><Globe2 aria-hidden="true" /><span><small>Webes forrás</small><strong>{sourceCounts.webCount}</strong></span></div>
          <div><PlayCircle aria-hidden="true" /><span><small>Bizonyíték videó</small><strong>{sourceCounts.videoCount}</strong></span></div>
          <div><Clock3 aria-hidden="true" /><span><small>Célhossz</small><strong>{targetLengthLabel ?? '—'}</strong></span></div>
          <div><Coins aria-hidden="true" /><span><small>Maradék kredit</small><strong>{creditsRemaining === null ? '—' : creditsRemaining.toFixed(1)}</strong></span></div>
        </div>
        <button type="button" onClick={onSaveToCalendar} disabled={calendarDisabled} data-state={calendarStatus}>
          <Calendar aria-hidden="true" />{calendarLabel}
        </button>
      </aside>
    </section>
  )
}
