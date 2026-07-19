'use client'

import { Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { CreditCard } from 'lucide-react'
import CreditsHero from '@/components/credits/CreditsHero'
import EmptyState from '@/components/ui/EmptyState'
import ActionButton from '@/components/ui/ActionButton'
import StatusIcon from '@/components/icons/StatusIcon'

interface CreditInfo {
  balance: number
  total_used: number
  plan: string
  monthly_allowance: number
  subscription_status?: string
  stripe_customer_id?: string
  subscription_credit_balance?: number
  purchased_credit_balance?: number
  renews_at?: string | null
  total_available_credits?: number
}

const PLANS = [
  { key: 'starter', name: 'Starter', credits: 50, price: 2990, softDailyLimit: 10, featured: false },
  { key: 'creator', name: 'Creator', credits: 150, price: 5990, softDailyLimit: 30, featured: true },
  { key: 'pro', name: 'Pro', credits: 500, price: 11990, softDailyLimit: 100, featured: false },
]

const TOPUP_PACKS = [
  { key: 'topup_50', name: '50 kredit', credits: 50, price: 1990, featured: false },
  { key: 'topup_150', name: '150 kredit', credits: 150, price: 4990, featured: true },
  { key: 'topup_500', name: '500 kredit', credits: 500, price: 11990, featured: false },
]

// Ez a lista a lib/stripe.ts PLANS/TOPUPS árait és kreditmennyiségeit tükrözi
// (szerver-only fájl, kliens-oldalról nem importálható). Ár/kredit-szám
// változtatás esetén mindkét helyen frissíteni kell.
const CREDIT_COSTS = [
  { feature: 'Gyártási csomag (Shorts)', cost: 2, icon: 'ti-device-mobile' },
  { feature: 'Gyártási csomag (Long)', cost: 6, icon: 'ti-player-play' },
  { feature: 'Auto Transcript', cost: 3, icon: 'ti-microphone' },
  { feature: 'Script Extract', cost: 3, icon: 'ti-file-text' },
  { feature: 'Videódiagnózis', cost: 4, icon: 'ti-stethoscope' },
  { feature: 'Virális esély', cost: 1, icon: 'ti-chart-bar' },
  { feature: 'Videólehetőségek', cost: 2, icon: 'ti-bulb' },
  { feature: 'Heti Top Videólehetőség', cost: 0, icon: 'ti-chart-dots-3' },
  { feature: 'Extra videólehetőség-keresés', cost: 2, icon: 'ti-refresh' },
  { feature: 'Piaci bizonyíték (napi 3 ingyenes)', cost: 0, icon: 'ti-player-play' },
  { feature: 'Piaci bizonyíték (napi 3 felett)', cost: 1, icon: 'ti-player-play' },
]

function formatPrice(n: number) {
  return n.toLocaleString('hu-HU')
}

function toBucketValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export default function CreditsPage() {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto"><div className="card mb-6 animate-pulse h-40" /></div>}>
      <CreditsPageContent />
    </Suspense>
  )
}

function CreditsPageContent() {
  const [tab, setTab] = useState<'subscription' | 'topup'>('subscription')
  const [credits, setCredits] = useState<CreditInfo | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchParams = useSearchParams()

  const success = searchParams.get('success')
  const canceled = searchParams.get('canceled')

  const hasActiveSubscription = credits?.subscription_status === 'active' || credits?.subscription_status === 'trialing'

  async function fetchCredits(): Promise<boolean> {
    try {
      const res = await fetch('/api/credits')
      if (!res.ok) return false
      const data = await res.json()
      setCredits(data)
      return true
    } catch {
      return false
    }
  }

  useEffect(() => {
    fetchCredits().then(ok => { if (!ok) setLoadError(true) })
  }, [])

  async function handleRetryInitialLoad() {
    setLoadError(false)
    const ok = await fetchCredits()
    if (!ok) setLoadError(true)
  }

  async function handleManualRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    const ok = await fetchCredits()
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
      if (data.url) {
        window.location.href = data.url
      } else {
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
      if (data.url) {
        window.location.href = data.url
      } else {
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
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || 'Nem sikerült elindítani a fizetést.')
        setLoading(null)
      }
    } catch {
      setError('Nem sikerült kapcsolódni a fizetési rendszerhez.')
      setLoading(null)
    }
  }

  const totalAvailable = toBucketValue(credits?.total_available_credits) ?? toBucketValue(credits?.balance)
  const subscriptionBalance = toBucketValue(credits?.subscription_credit_balance)
  const purchasedBalance = toBucketValue(credits?.purchased_credit_balance)
  const totalUsedValue = toBucketValue(credits?.total_used)
  const renewsAtLabel = credits?.renews_at
    ? new Date(credits.renews_at).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })
    : null

  return (
    <div className="max-w-5xl mx-auto">
      {/* Success/Cancel — kizárólag informatív, nem pénzügyi bizonyíték */}
      {success && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#CBD5E1' }}>
          <p>A fizetési folyamatról visszatértél. A legfrissebb elérhető egyenlegedet mutatjuk. Ha a jóváírás még nem látható, frissítsd az egyenleget néhány másodperc múlva.</p>
          <div className="flex items-center flex-wrap gap-3 mt-3">
            <ActionButton variant="secondary" onClick={handleManualRefresh} disabled={refreshing} className="text-xs px-4 py-1.5">
              {refreshing ? 'Frissítés...' : 'Egyenleg frissítése'}
            </ActionButton>
            {refreshError && <span className="text-xs" style={{ color: '#F59E0B' }}>{refreshError}</span>}
          </div>
        </div>
      )}
      {canceled && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
          Visszatértél a megszakított fizetési folyamatból. Ha bizonytalan vagy az állapotában, ellenőrizd az aktuális egyenlegedet.
        </div>
      )}

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#FCA5A5' }}>
          <i className="ti ti-alert-circle" />
          <span>{error}</span>
        </div>
      )}

      {/* Credits Hero — az egyenleg a legerősebb elem az oldalon */}
      {loadError ? (
        <>
          <EmptyState
            icon={CreditCard}
            title="Nem sikerült betölteni a kredit egyenleget"
            description="Ellenőrizd a kapcsolatot, majd próbáld újra."
          />
          <div className="flex justify-center mt-4 mb-6">
            <ActionButton variant="secondary" onClick={handleRetryInitialLoad}>
              Újrapróbálkozás
            </ActionButton>
          </div>
        </>
      ) : (
        <CreditsHero
          loading={credits === null}
          totalAvailable={totalAvailable}
          subscriptionBalance={subscriptionBalance}
          purchasedBalance={purchasedBalance}
          plan={credits?.plan ?? null}
          hasActiveSubscription={hasActiveSubscription}
          totalUsed={totalUsedValue}
          renewsAtLabel={renewsAtLabel}
          onManageSubscription={handleManageSubscription}
          manageLoading={loading === 'portal'}
        />
      )}

      {/* Info csík */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <i className="ti ti-info-circle" style={{ color: '#3B82F6' }} />
          <span className="text-sm" style={{ color: '#CBD5E1' }}>Hetente 1 validált Top Videólehetőség és az első 3 Piaci bizonyíték keresés ingyenes. Mélyebb elemzésnél vagy extra futtatásnál kredit szükséges.</span>
        </div>
      </div>

      {/* Tab toggle */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setTab('subscription')}
            className="px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg text-xs sm:text-sm font-medium transition-all"
            style={{ background: tab === 'subscription' ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'transparent', color: tab === 'subscription' ? '#fff' : '#94A3B8' }}>
            Havi előfizetés
          </button>
          <button onClick={() => setTab('topup')}
            className="px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg text-xs sm:text-sm font-medium transition-all"
            style={{ background: tab === 'topup' ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'transparent', color: tab === 'topup' ? '#fff' : '#94A3B8' }}>
            Kredit feltöltés
          </button>
        </div>
      </div>

      {/* Pricing cards */}
      {tab === 'subscription' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {PLANS.map(plan => {
            const isCurrentPlan = credits?.plan === plan.key && hasActiveSubscription
            const isOtherPlanWhileSubscribed = hasActiveSubscription && !isCurrentPlan
            const buttonLoadingKey = isOtherPlanWhileSubscribed ? 'portal' : plan.key
            return (
              <div key={plan.key} className="rounded-2xl p-6 text-center transition-all duration-200 hover:-translate-y-1 relative"
                style={{
                  background: plan.featured ? 'linear-gradient(180deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08), rgba(255,255,255,0.04))' : 'rgba(255,255,255,0.04)',
                  border: plan.featured ? '2px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: plan.featured ? '0 0 32px rgba(59,130,246,0.2), 0 0 64px rgba(139,92,246,0.1)' : 'none',
                }}>
                {plan.featured && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-semibold"
                    style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
                    Ajánlott
                  </div>
                )}
                <p className="text-sm font-medium mb-3 mt-1" style={{ color: '#CBD5E1' }}>{plan.name}</p>
                <p className="text-4xl font-bold mb-1" style={{ color: '#F8FAFC' }}>{plan.credits}</p>
                <p className="text-sm mb-4" style={{ color: '#94A3B8' }}>kredit/hó</p>
                <p className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>{formatPrice(plan.price)} Ft</p>
                <p className="text-xs mb-1" style={{ color: '#94A3B8' }}>/ hó</p>
                <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>Napi soft limit: {plan.softDailyLimit} kredit</p>
                <ul className="text-left text-xs space-y-2 mb-5" style={{ color: '#CBD5E1' }}>
                  <li className="flex items-center gap-2"><i className="ti ti-check text-xs" style={{ color: '#22C55E' }} /> Automatikus feltöltés</li>
                  <li className="flex items-center gap-2"><i className="ti ti-check text-xs" style={{ color: '#22C55E' }} /> Bármikor lemondható</li>
                  <li className="flex items-center gap-2"><i className="ti ti-check text-xs" style={{ color: '#22C55E' }} /> Minden funkció</li>
                </ul>
                <button
                  onClick={isOtherPlanWhileSubscribed ? handleManageSubscription : () => handleSubscription(plan.key)}
                  disabled={loading !== null || isCurrentPlan}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                  style={{
                    background: isCurrentPlan ? 'rgba(34,197,94,0.15)' : plan.featured ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'rgba(255,255,255,0.06)',
                    border: isCurrentPlan ? '1px solid rgba(34,197,94,0.3)' : plan.featured ? 'none' : '1px solid rgba(255,255,255,0.1)',
                    color: isCurrentPlan ? '#22C55E' : plan.featured ? '#fff' : '#CBD5E1',
                    boxShadow: plan.featured && !isCurrentPlan ? '0 0 20px rgba(59,130,246,0.3)' : 'none',
                  }}>
                  {loading === buttonLoadingKey ? 'Betöltés...' : isCurrentPlan ? 'Jelenlegi csomag' : isOtherPlanWhileSubscribed ? 'Előfizetés kezelése' : plan.featured ? 'Előfizetek' : 'Kiválasztom'}
                </button>
                {isOtherPlanWhileSubscribed && (
                  <p className="text-xs mt-2" style={{ color: '#94A3B8' }}>A csomagoddal kapcsolatos lehetőségeket a Stripe ügyfélportálon kezelheted.</p>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div>
          {!hasActiveSubscription ? (
            <div className="card flex flex-col items-center text-center py-10 px-6 mb-12">
              <div className="w-12 h-12 rounded-full flex items-center justify-center mb-4" style={{ background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)' }}>
                <StatusIcon kind="locked" className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold text-text-primary mb-1">Kredit feltöltéshez aktív előfizetés szükséges</p>
              <p className="text-xs text-text-muted max-w-sm mb-4">Válassz előbb egy havi csomagot — utána bármikor tölthetsz fel extra kreditet.</p>
              <ActionButton variant="secondary" onClick={() => setTab('subscription')}>
                Válassz előfizetést
              </ActionButton>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
              {TOPUP_PACKS.map(pack => (
                <div key={pack.key} className="rounded-2xl p-6 text-center transition-all duration-200 hover:-translate-y-1 relative"
                  style={{
                    background: pack.featured ? 'linear-gradient(180deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08), rgba(255,255,255,0.04))' : 'rgba(255,255,255,0.04)',
                    border: pack.featured ? '2px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.08)',
                    boxShadow: pack.featured ? '0 0 32px rgba(59,130,246,0.2), 0 0 64px rgba(139,92,246,0.1)' : 'none',
                  }}>
                  {pack.featured && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-xs font-semibold"
                      style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
                      Legjobb érték
                    </div>
                  )}
                  <p className="text-sm font-medium mb-3 mt-1" style={{ color: '#CBD5E1' }}>{pack.name}</p>
                  <p className="text-4xl font-bold mb-1" style={{ color: '#F8FAFC' }}>{pack.credits}</p>
                  <p className="text-sm mb-4" style={{ color: '#94A3B8' }}>kredit</p>
                  <p className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>{formatPrice(pack.price)} Ft</p>
                  <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>egyszeri vásárlás</p>
                  <button
                    onClick={() => handleTopup(pack.key)}
                    disabled={loading !== null}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                    style={{
                      background: pack.featured ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'rgba(255,255,255,0.06)',
                      border: pack.featured ? 'none' : '1px solid rgba(255,255,255,0.1)',
                      color: pack.featured ? '#fff' : '#CBD5E1',
                      boxShadow: pack.featured ? '0 0 20px rgba(59,130,246,0.3)' : 'none',
                    }}>
                    {loading === pack.key ? 'Betöltés...' : 'Vásárlás'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* What you get */}
      <div className="rounded-2xl p-6 mb-8" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 className="text-lg font-semibold mb-5" style={{ color: '#F8FAFC' }}>Mit kapsz a kreditjeidért?</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CREDIT_COSTS.map(item => (
            <div key={item.feature} className="flex items-center justify-between px-4 py-3 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: item.cost === 0 ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)' }}>
                  <i className={`ti ${item.icon} text-sm`} style={{ color: item.cost === 0 ? '#22C55E' : '#3B82F6' }} />
                </div>
                <span className="text-sm" style={{ color: '#CBD5E1' }}>{item.feature}</span>
              </div>
              <span className="text-sm font-semibold" style={{ color: item.cost === 0 ? '#22C55E' : '#F8FAFC' }}>
                {item.cost === 0 ? 'Ingyenes' : `${item.cost} kredit`}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs mt-4 text-center" style={{ color: '#94A3B8' }}>
          Kreditet generálásnál, mélyebb elemzésnél és extra keresésnél használsz. A böngészés, a heti Top Videólehetőség és a napi Piaci bizonyíték alapkeret ingyenes.
        </p>
      </div>
    </div>
  )
}
