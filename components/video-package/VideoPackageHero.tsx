import { Calendar } from 'lucide-react'
import Badge, { type BadgeVariant } from '@/components/ui/Badge'
import FeatureIcon from '@/components/icons/FeatureIcon'

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

// Tisztán prezentációs, kizárólag props-alapú komponens — nincs fetch,
// nincs API-hívás, nincs state/useEffect, nincs storage- vagy
// kreditlogika, nincs saját quality/forrás/mentés-számítás. Minden
// megjelenítendő érték már kész, előre eldöntött formában érkezik a
// page.tsx-ből. Az egyetlen interaktív elem a meglévő `onSaveToCalendar`
// handlert hívó gomb.
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
  // Egyértelmű, kimerítő leképezés a Calendar CTA állapotaira — a handler,
  // a disabled-logika és az API-flow a page.tsx-ben nem változik, csak ez
  // a megjelenítési szöveg/disabled pár.
  let calendarLabel: string
  let calendarDisabled: boolean
  switch (calendarStatus) {
    case 'saving':
      calendarLabel = 'Mentés...'
      calendarDisabled = true
      break
    case 'saved':
      calendarLabel = 'Naptárba mentve'
      calendarDisabled = true
      break
    case 'error':
      calendarLabel = 'Hiba, próbáld újra'
      calendarDisabled = false
      break
    case 'idle':
    default:
      calendarLabel = 'Naptárba mentés'
      calendarDisabled = false
      break
  }

  return (
    <div className="card mb-4">
      <div className="grid grid-cols-1 md:grid-cols-[65fr_35fr] gap-6">
        {/* Domináns oszlop — döntés + indoklás */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-3 min-w-0">
            <FeatureIcon feature="video-package" className="w-5 h-5 flex-shrink-0" />
            <span className="section-label flex-shrink-0">Gyártási csomag</span>
          </div>

          <h2 className="text-xl font-bold text-text-primary mb-2 break-words">{topic}</h2>

          {metaBadges.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {metaBadges.map(badge => (
                <Badge key={badge.label} variant="neutral" className="break-words">{badge.value}</Badge>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 mb-2">
            <Badge variant={qualityMeta.variant} className="break-words">{qualityMeta.label}</Badge>
            {productionStatusLabel && (
              <Badge variant="info" className="break-words">{productionStatusLabel}</Badge>
            )}
          </div>

          {preparationModeNote && (
            <p className="text-sm text-text-secondary mt-2 break-words">{preparationModeNote}</p>
          )}
          {intensityNote && (
            <p className="text-sm text-text-secondary mt-2 break-words">Intenzitás visszavéve: {intensityNote}</p>
          )}

          {riskFlags.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-amber mb-1.5">Figyelendő pontok</p>
              <div className="flex flex-wrap gap-1.5">
                {riskFlags.map(flag => (
                  <Badge key={flag} variant="warning" className="break-words">{flag}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Másodlagos oszlop — források, célhossz, mentés-státusz */}
        <div className="flex flex-col gap-2 opacity-95">
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-text-muted mb-1">Források</p>
            <p className="text-sm font-bold text-text-primary">{sourceCounts.webCount} web · {sourceCounts.videoCount} video</p>
          </div>

          {targetLengthLabel && (
            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <p className="text-xs text-text-muted mb-1">Célhossz</p>
              <p className="text-sm font-bold text-text-primary break-words">{targetLengthLabel}</p>
            </div>
          )}

          {saveStatus && (
            <Badge variant={saveStatus.variant} className="break-words">{saveStatus.label}</Badge>
          )}

          {creditsRemaining !== null && (
            <p className="text-xs text-text-muted">Maradék kredit: <span className="text-primary font-semibold">{creditsRemaining.toFixed(1)}</span></p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={onSaveToCalendar}
          disabled={calendarDisabled}
          className="btn-secondary text-sm px-5 py-2 inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          <Calendar className="w-4 h-4" aria-hidden="true" />
          {calendarLabel}
        </button>
      </div>
    </div>
  )
}
