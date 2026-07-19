import { RefreshCw, CreditCard } from 'lucide-react'
import Badge from '@/components/ui/Badge'
import StatChip from '@/components/ui/StatChip'
import FeatureIcon from '@/components/icons/FeatureIcon'

interface CreditsHeroProps {
  loading: boolean
  totalAvailable: number | null
  subscriptionBalance: number | null
  purchasedBalance: number | null
  plan: string | null
  hasActiveSubscription: boolean
  totalUsed: number | null
  renewsAtLabel: string | null
  onManageSubscription: () => void
  manageLoading: boolean
}

// Tisztán prezentációs, kizárólag props-alapú komponens — nincs fetch,
// nincs API-hívás, nincs polling, nincs saját kredit/bucket-számítás.
// Minden érték már kész, biztonságos fallback-kel (null = "—") érkezik
// a page.tsx-ből. Az egyetlen interaktív elem a meglévő
// `onManageSubscription` handlert hívó gomb.
export default function CreditsHero({
  loading,
  totalAvailable,
  subscriptionBalance,
  purchasedBalance,
  plan,
  hasActiveSubscription,
  totalUsed,
  renewsAtLabel,
  onManageSubscription,
  manageLoading,
}: CreditsHeroProps) {
  return (
    <div className="card mb-6">
      <div className="flex items-center gap-2 mb-4 min-w-0">
        <FeatureIcon feature="credits" className="w-5 h-5 flex-shrink-0" />
        <span className="section-label flex-shrink-0">Kredit egyenleg</span>
      </div>

      {loading ? (
        <div className="space-y-3 animate-pulse" role="status" aria-label="Kredit egyenleg betöltése folyamatban">
          <div className="h-12 w-40 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="h-9 w-36 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)' }} aria-hidden="true" />
            <div className="h-9 w-36 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)' }} aria-hidden="true" />
          </div>
          <div className="h-4 w-48 rounded" style={{ background: 'rgba(255,255,255,0.04)' }} aria-hidden="true" />
          <span className="sr-only">Kredit egyenleg betöltése folyamatban</span>
        </div>
      ) : (
        <>
          <div className="mb-4">
            <p className="text-5xl md:text-6xl font-bold text-text-primary leading-none">
              {totalAvailable === null ? '—' : Math.round(totalAvailable)}
            </p>
            <p className="text-sm text-text-muted mt-2">elérhető kredit</p>
          </div>

          <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center gap-2 mb-4">
            <StatChip
              icon={RefreshCw}
              value={subscriptionBalance === null ? '—' : Math.round(subscriptionBalance)}
              label="előfizetői kredit"
              accentColor="#3B82F6"
            />
            <StatChip
              icon={CreditCard}
              value={purchasedBalance === null ? '—' : Math.round(purchasedBalance)}
              label="vásárolt kredit"
              accentColor="#8B5CF6"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4 text-xs text-text-muted">
            {plan && <Badge variant="neutral" className="capitalize">{plan}</Badge>}
            {hasActiveSubscription && renewsAtLabel && <span>Megújul: {renewsAtLabel}</span>}
            {totalUsed !== null && <span>{Math.round(totalUsed)} kredit felhasználva ebben a ciklusban</span>}
          </div>

          {hasActiveSubscription && (
            <button
              type="button"
              onClick={onManageSubscription}
              disabled={manageLoading}
              className="btn-secondary text-sm px-5 py-2 disabled:opacity-60"
            >
              {manageLoading ? 'Betöltés...' : 'Előfizetés kezelése'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
