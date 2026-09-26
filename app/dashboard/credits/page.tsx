'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  CreditCard,
  Gauge,
  LockKeyhole,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react'
import CreditsHero from '@/components/credits/CreditsHero'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'
import { CREATOR_CREDIT_COSTS, CREATOR_SEARCH_ALLOWANCES } from '@/lib/creator-credit-catalog'
import {
  formatCreditPrice,
  formatCreditRenewalDate,
  toCreditAmount,
} from '@/lib/creator-credits-presentation'

const PLANS = [
  { key: 'starter', name: 'Starter', credits: 50, price: 2990, softDailyLimit: 10, featured: false, note: 'Fókuszált, induló munkaritmushoz.' },
  { key: 'creator', name: 'Creator', credits: 150, price: 5990, softDailyLimit: 30, featured: true, note: 'Rendszeres kutatáshoz és gyártáshoz.' },
  { key: 'pro', name: 'Pro', credits: 500, price: 11990, softDailyLimit: 100, featured: false, note: 'Nagyobb tartalomvolumenhez.' },
]

const TOPUP_PACKS = [
  { key: 'topup_50', name: 'Pulse', credits: 50, price: 1990, featured: false, note: 'Egy gyors extra futamhoz.' },
  { key: 'topup_150', name: 'Momentum', credits: 150, price: 4990, featured: true, note: 'Több ötlet egymás utáni kidolgozásához.' },
  { key: 'topup_500', name: 'Velocity', credits: 500, price: 11990, featured: false, note: 'Nagyobb gyártási időszakhoz.' },
]

export default function CreditsPage() {
  const [tab, setTab] = useState<'subscription' | 'topup'>('subscription')
  const { credits, status, refreshCredits } = useCreditBalance()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchParams = useSearchParams()

  const success = searchParams.get('success')
  const canceled = searchParams.get('canceled')
  const hasActiveSubscription = credits?.subscription_status === 'active' || credits?.subscription_status === 'trialing'

  async function handleRetryInitialLoad() {
    await refreshCredits({ supersede: true })
  }

  async function handleManualRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    const ok = await refreshCredits({ supersede: true })
    if (!ok) setRefreshError('Nem sikerült frissíteni az egyenleget. Próbáld újra.')
    setRefreshing(false)
  }

  async function handleSubscription(plan: string) {
    setLoading(plan)
    setError(null)
    try {
      const res = await fetch('/api/stripe/create-subscription-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else {
        setError(data.error || 'Nem sikerült elindítani a fizetést.')
        setLoading(null)
      }
    } catch {
      setError('Nem sikerült kapcsolódni a fizetési rendszerhez.')
      setLoading(null)
    }
  }

  async function handleTopup(pkg: string) {
    setLoading(pkg)
    setError(null)
    try {
      const res = await fetch('/api/stripe/create-topup-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: pkg }),
      })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else {
        setError(data.error || 'Nem sikerült elindítani a fizetést.')
        setLoading(null)
      }
    } catch {
      setError('Nem sikerült kapcsolódni a fizetési rendszerhez.')
      setLoading(null)
    }
  }

  async function handleManageSubscription() {
    setLoading('portal')
    setError(null)
    try {
      const res = await fetch('/api/stripe/customer-portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) window.location.href = data.url
      else {
        setError(data.error || 'Nem sikerült elindítani a fizetést.')
        setLoading(null)
      }
    } catch {
      setError('Nem sikerült kapcsolódni a fizetési rendszerhez.')
      setLoading(null)
    }
  }

  const totalAvailable = toCreditAmount(credits?.total_available_credits) ?? toCreditAmount(credits?.balance)
  const subscriptionBalance = toCreditAmount(credits?.subscription_credit_balance)
  const purchasedBalance = toCreditAmount(credits?.purchased_credit_balance)
  const totalUsedValue = toCreditAmount(credits?.total_used)
  const monthlyAllowance = toCreditAmount(credits?.monthly_allowance)
  const renewsAtLabel = formatCreditRenewalDate(credits?.renews_at)
  const loadError = status === 'error'

  return (
    <div className="wv-credits-page">
      <header className="wv-credits-intro">
        <div>
          <span className="wv-eyebrow"><Sparkles aria-hidden="true" /> Kapacitás és számlázás</span>
          <h1>A lendület ne a kreditnél álljon meg.</h1>
          <p>Lásd tisztán a keretedet, válassz a munkaritmusodhoz illő csomagot, és tudd előre, melyik alkotói lépés mennyibe kerül.</p>
        </div>
        <aside>
          <ShieldCheck aria-hidden="true" />
          <span><strong>Átlátható folyamat</strong>A fizetés és az előfizetés kezelése külön Stripe-felületen folytatódik.</span>
        </aside>
      </header>

      {(success || canceled || error) && (
        <div className="wv-credit-feedback-stack">
          {success && (
            <div className="wv-credit-feedback is-success" role="status">
              <CircleCheck aria-hidden="true" />
              <div>
                <strong>Visszaérkeztél a fizetési folyamatból.</strong>
                <p>A legfrissebb elérhető egyenleget mutatjuk. Ha a jóváírás még nem látható, frissíts néhány másodperc múlva.</p>
                <button type="button" onClick={handleManualRefresh} disabled={refreshing}>
                  <RefreshCw aria-hidden="true" />{refreshing ? 'Frissítés…' : 'Egyenleg frissítése'}
                </button>
                {refreshError && <span role="alert">{refreshError}</span>}
              </div>
            </div>
          )}
          {canceled && (
            <div className="wv-credit-feedback is-neutral" role="status">
              <X aria-hidden="true" />
              <div><strong>A fizetési folyamat megszakadt.</strong><p>Nem kell új állapotot feltételezned: az aktuális egyenlegedet látod az oldalon.</p></div>
            </div>
          )}
          {error && (
            <div className="wv-credit-feedback is-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <div><strong>A művelet most nem indítható el.</strong><p>{error}</p></div>
            </div>
          )}
        </div>
      )}

      {loadError ? (
        <section className="wv-credit-load-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <div><span className="wv-credit-kicker">Kapcsolati hiba</span><h2>Az egyenleg most nem olvasható.</h2><p>A csomagválasztás előtt töltsd újra az adatokat, hogy biztosan az aktuális állapotból indulj.</p></div>
          <button type="button" onClick={handleRetryInitialLoad}><RefreshCw aria-hidden="true" /> Újrapróbálkozás</button>
        </section>
      ) : (
        <CreditsHero
          loading={status === 'loading'}
          totalAvailable={totalAvailable}
          subscriptionBalance={subscriptionBalance}
          purchasedBalance={purchasedBalance}
          plan={credits?.plan ?? null}
          monthlyAllowance={monthlyAllowance}
          hasActiveSubscription={hasActiveSubscription}
          totalUsed={totalUsedValue}
          renewsAtLabel={renewsAtLabel}
          onManageSubscription={handleManageSubscription}
          manageLoading={loading === 'portal'}
        />
      )}

      <section className="wv-credit-included" aria-label="Kredit nélküli alapkeret">
        <div><BadgeCheck aria-hidden="true" /><span><strong>1 / hét</strong>validált Top Videólehetőség</span></div>
        <div><ScanSearch aria-hidden="true" /><span><strong>3 / nap</strong>Piaci bizonyíték keresés</span></div>
        <div><Sparkles aria-hidden="true" /><span><strong>Szabad böngészés</strong>kredit levonása nélkül</span></div>
      </section>
      <p className="wv-credit-allowance-note"><Gauge aria-hidden="true" /> A csomag napi kerete ajánlott költési határ, nem lejárat: elérésekor a folytatáshoz külön megerősítés szükséges.</p>

      <section className="wv-credit-market" aria-labelledby="credit-market-title">
        <header>
          <div>
            <span className="wv-credit-kicker">Válaszd meg a ritmust</span>
            <h2 id="credit-market-title">Keret az alkotói rendszeredhez</h2>
            <p>A havi csomag adja az alapkapacitást. Aktív előfizetés mellett egyszeri kredittel bővítheted.</p>
          </div>
          <div className="wv-credit-tabs" role="tablist" aria-label="Kreditvásárlási mód">
            <button type="button" role="tab" aria-selected={tab === 'subscription'} onClick={() => setTab('subscription')}>Havi keret</button>
            <button type="button" role="tab" aria-selected={tab === 'topup'} onClick={() => setTab('topup')}>Egyszeri feltöltés</button>
          </div>
        </header>

        {tab === 'subscription' ? (
          <div className="wv-credit-plan-grid" role="tabpanel">
            {PLANS.map((plan, index) => {
              const isCurrentPlan = credits?.plan === plan.key && hasActiveSubscription
              const isOtherPlanWhileSubscribed = hasActiveSubscription && !isCurrentPlan
              const buttonLoadingKey = isOtherPlanWhileSubscribed ? 'portal' : plan.key
              return (
                <article key={plan.key} className="wv-credit-plan-card" data-featured={plan.featured || undefined} data-current={isCurrentPlan || undefined}>
                  <div className="wv-credit-plan-index"><span>0{index + 1}</span>{plan.featured && <b>Kiemelt keret</b>}{isCurrentPlan && <b>Aktív</b>}</div>
                  <span className="wv-credit-plan-name">{plan.name}</span>
                  <h3>{plan.credits}<small> kredit / hó</small></h3>
                  <p>{plan.note}</p>
                  <div className="wv-credit-plan-price"><strong>{formatCreditPrice(plan.price)}</strong><span>/ hó</span></div>
                  <ul>
                    <li><Gauge aria-hidden="true" /><span>Napi soft limit</span><strong>{plan.softDailyLimit} kredit</strong></li>
                    <li><RefreshCw aria-hidden="true" /><span>Havi kreditfrissítés</span><Check aria-label="Elérhető" /></li>
                    <li><ShieldCheck aria-hidden="true" /><span>Bármikor lemondható</span><Check aria-label="Elérhető" /></li>
                  </ul>
                  <button
                    type="button"
                    onClick={isOtherPlanWhileSubscribed ? handleManageSubscription : () => handleSubscription(plan.key)}
                    disabled={loading !== null || isCurrentPlan}
                  >
                    {loading === buttonLoadingKey ? 'Megnyitás…' : isCurrentPlan ? 'Jelenlegi csomag' : isOtherPlanWhileSubscribed ? 'Csomag kezelése' : 'Ezt a keretet választom'}
                    {!isCurrentPlan && loading !== buttonLoadingKey && <ArrowRight aria-hidden="true" />}
                  </button>
                  {isOtherPlanWhileSubscribed && <small>A váltás lehetőségeit az előfizetési portálon látod.</small>}
                </article>
              )
            })}
          </div>
        ) : !hasActiveSubscription ? (
          <div className="wv-credit-topup-lock" role="tabpanel">
            <div><LockKeyhole aria-hidden="true" /></div>
            <span className="wv-credit-kicker">Előfizetői kiegészítés</span>
            <h3>Az extra kredit az aktív havi keretet egészíti ki.</h3>
            <p>Válassz előbb előfizetést, utána bármikor adhatsz egyszeri kapacitást az egyenlegedhez.</p>
            <button type="button" onClick={() => setTab('subscription')}>Havi keretek megtekintése <ArrowRight aria-hidden="true" /></button>
          </div>
        ) : (
          <div className="wv-credit-plan-grid" role="tabpanel">
            {TOPUP_PACKS.map((pack, index) => (
              <article key={pack.key} className="wv-credit-plan-card is-topup" data-featured={pack.featured || undefined}>
                <div className="wv-credit-plan-index"><span>0{index + 1}</span>{pack.featured && <b>Kiemelt feltöltés</b>}</div>
                <span className="wv-credit-plan-name">{pack.name}</span>
                <h3>{pack.credits}<small> kredit</small></h3>
                <p>{pack.note}</p>
                <div className="wv-credit-plan-price"><strong>{formatCreditPrice(pack.price)}</strong><span>egyszeri vásárlás</span></div>
                <button type="button" onClick={() => handleTopup(pack.key)} disabled={loading !== null}>
                  {loading === pack.key ? 'Megnyitás…' : 'Feltöltés kiválasztása'}
                  {loading !== pack.key && <ArrowRight aria-hidden="true" />}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="wv-credit-costs" aria-labelledby="credit-costs-title">
        <header>
          <div><span className="wv-credit-kicker">Kiszámítható működés</span><h2 id="credit-costs-title">Mire elég egy kredit?</h2></div>
          <p>Az ingyenes keresési keretet és a fix költségű alkotói műveleteket külön mutatjuk. Indítás előtt mindig a konkrét művelet ára az irányadó.</p>
        </header>
        <div className="wv-credit-search-rules" aria-label="Ingyenes és fizetős keresések">
          {CREATOR_SEARCH_ALLOWANCES.map(item => (
            <article key={item.key}>
              <ScanSearch aria-hidden="true" />
              <span><strong>{item.feature}</strong><small>{item.included}</small></span>
              <b>{item.paid}</b>
            </article>
          ))}
        </div>
        <div className="wv-credit-cost-grid">
          {CREATOR_CREDIT_COSTS.map(item => (
            <article key={item.key}>
              <div>{item.group === 'create' ? <Sparkles aria-hidden="true" /> : item.group === 'analyse' ? <BarChart3 aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}</div>
              <span><strong>{item.feature}</strong><small>{item.detail}</small></span>
              <b>{item.cost} kredit</b>
            </article>
          ))}
        </div>
      </section>

      <footer className="wv-credit-assurance">
        <WalletCards aria-hidden="true" />
        <p><strong>A kredit az alkotói döntések üzemanyaga, nem homályos pontszám.</strong> Böngészhetsz és tervezhetsz szabadon; kreditet generálásnál, mélyebb elemzésnél és extra keresésnél használsz.</p>
        <span><Clock3 aria-hidden="true" /> A művelet költsége indítás előtt látható</span>
      </footer>
    </div>
  )
}
