import { ArrowUpRight, CalendarClock, CreditCard, Gauge, RefreshCw, ShieldCheck, WalletCards } from 'lucide-react'
import { creditPlanLabel, formatCreditAmount } from '@/lib/creator-credits-presentation'

interface CreditsHeroProps {
  loading: boolean
  totalAvailable: number | null
  subscriptionBalance: number | null
  purchasedBalance: number | null
  plan: string | null
  monthlyAllowance: number | null
  hasActiveSubscription: boolean
  totalUsed: number | null
  renewsAtLabel: string | null
  onManageSubscription: () => void
  manageLoading: boolean
}

// Tisztán prezentációs komponens: minden pénzügyi állapot a meglévő
// /api/credits válaszából érkezik, és egyetlen számot sem becsül meg.
export default function CreditsHero({
  loading,
  totalAvailable,
  subscriptionBalance,
  purchasedBalance,
  plan,
  monthlyAllowance,
  hasActiveSubscription,
  totalUsed,
  renewsAtLabel,
  onManageSubscription,
  manageLoading,
}: CreditsHeroProps) {
  if (loading) {
    return (
      <section className="wv-credit-balance is-loading" role="status" aria-label="Kredit egyenleg betöltése folyamatban">
        <div className="wv-credit-skeleton-main" aria-hidden="true">
          <i />
          <span />
          <strong />
          <span />
        </div>
        <div className="wv-credit-skeleton-side" aria-hidden="true">
          <span />
          <i />
          <i />
          <i />
        </div>
        <span className="sr-only">Kredit egyenleg betöltése folyamatban</span>
      </section>
    )
  }

  return (
    <section className="wv-credit-balance" aria-labelledby="credit-balance-title">
      <div className="wv-credit-balance-main">
        <div className="wv-credit-balance-heading">
          <span><WalletCards aria-hidden="true" /> Alkotói kapacitás</span>
          <span className={hasActiveSubscription ? 'is-active' : ''}>
            <i aria-hidden="true" />
            {hasActiveSubscription ? 'Aktív előfizetés' : 'Nincs aktív előfizetés'}
          </span>
        </div>

        <div className="wv-credit-balance-number">
          <strong id="credit-balance-title">{formatCreditAmount(totalAvailable)}</strong>
          <span>elérhető kredit</span>
        </div>

        <div className="wv-credit-buckets" aria-label="Kreditegyenleg bontása">
          <div>
            <RefreshCw aria-hidden="true" />
            <span>Előfizetői</span>
            <strong>{formatCreditAmount(subscriptionBalance)}</strong>
          </div>
          <div>
            <CreditCard aria-hidden="true" />
            <span>Vásárolt</span>
            <strong>{formatCreditAmount(purchasedBalance)}</strong>
          </div>
        </div>
      </div>

      <aside className="wv-credit-plan-status" aria-label="Aktuális csomag">
        <div className="wv-credit-plan-orbit" aria-hidden="true">
          <span />
          <i />
          <Gauge />
        </div>
        <span className="wv-credit-kicker">Jelenlegi keret</span>
        <h2>{creditPlanLabel(plan)}</h2>
        <div className="wv-credit-plan-facts">
          <p><Gauge aria-hidden="true" /><span>Havi keret</span><strong>{formatCreditAmount(monthlyAllowance)} kredit</strong></p>
          <p><ArrowUpRight aria-hidden="true" /><span>Felhasználva</span><strong>{formatCreditAmount(totalUsed)} összesen</strong></p>
          <p><CalendarClock aria-hidden="true" /><span>Következő megújulás</span><strong>{renewsAtLabel ?? '—'}</strong></p>
        </div>

        {hasActiveSubscription ? (
          <button type="button" onClick={onManageSubscription} disabled={manageLoading} className="wv-credit-manage">
            <ShieldCheck aria-hidden="true" />
            {manageLoading ? 'Megnyitás…' : 'Előfizetés kezelése'}
          </button>
        ) : (
          <p className="wv-credit-plan-note">Válassz havi keretet az alkotói munkafolyamatodhoz.</p>
        )}
      </aside>
    </section>
  )
}
