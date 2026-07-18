'use client'

import StatusIcon from '@/components/icons/StatusIcon'

interface NicheReviewBannerProps {
  onKeepCurrent: () => void | Promise<void>
  onReanalyze: () => void | Promise<void>
  loading?: boolean
  id?: string
}

// Megosztott, tisztán prezentációs komponens — a Command Center és a Profil
// oldal is ezt rendereli, saját handlerekkel. A komponens maga nem hív API-t.
export default function NicheReviewBanner({ onKeepCurrent, onReanalyze, loading = false, id }: NicheReviewBannerProps) {
  return (
    <div
      id={id}
      className="p-4 rounded-lg"
      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)' }}
    >
      <div className="flex items-start gap-3">
        <StatusIcon kind="needs_review" className="w-5 h-5 mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">Új YouTube-csatornát választottál</p>
          <p className="text-xs text-text-secondary mt-1">
            A jelenlegi Creator Profile niche-t nem módosítottuk automatikusan. Döntsd el, hogy megtartod-e ehhez a csatornához, vagy újraelemezzük az új csatorna alapján.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" onClick={() => onKeepCurrent()} disabled={loading} className="btn-secondary text-xs px-3 py-1.5">
              Jelenlegi niche megtartása
            </button>
            <button type="button" onClick={() => onReanalyze()} disabled={loading} className="btn-secondary text-xs px-3 py-1.5">
              {loading ? 'Feldolgozás...' : 'Új csatorna alapján újraelemzés'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
