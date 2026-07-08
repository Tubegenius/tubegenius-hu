'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase'
import { useSearchParams } from 'next/navigation'

interface CreditInfo {
  balance: number
  total_used: number
  plan: string
  monthly_allowance: number
  subscription_status?: string
  stripe_customer_id?: string
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

export default function CreditsPage() {
  const [tab, setTab] = useState<'subscription' | 'topup'>('subscription')
  const [credits, setCredits] = useState<CreditInfo | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const searchParams = useSearchParams()

  const success = searchParams.get('success')
  const canceled = searchParams.get('canceled')

  const hasActiveSubscription = credits?.subscription_status === 'active' || credits?.subscription_status === 'trialing'

  useEffect(() => {
    fetch('/api/credits').then(r => r.json()).then(setCredits).catch(() => {})
  }, [])

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

  return (
    <div className="max-w-5xl mx-auto">
      {/* Success/Cancel messages */}
      {success && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22C55E' }}>
          Sikeres fizetés. A kreditjeid hamarosan frissülnek.
        </div>
      )}
      {canceled && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm font-medium" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#EF4444' }}>
          A fizetés megszakítva.
        </div>
      )}

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#FCA5A5' }}>
          <i className="ti ti-alert-circle" />
          <span>{error}</span>
        </div>
      )}
      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold mb-2" style={{ color: '#F8FAFC' }}>WillViral Credits</h1>
        <p className="text-base mb-4" style={{ color: '#CBD5E1' }}>
          Válaszd ki a céljaidnak megfelelő csomagot, és indítsd be a virális növekedésed.
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <i className="ti ti-info-circle" style={{ color: '#3B82F6' }} />
          <span className="text-sm" style={{ color: '#CBD5E1' }}>Hetente 1 validált Top Videólehetőség és az első 3 Piaci bizonyíték keresés ingyenes. Mélyebb elemzésnél vagy extra futtatásnál kredit szükséges.</span>
        </div>
      </div>

      {/* Current balance */}
      {credits && (
        <div className="flex items-center justify-center gap-8 mb-10">
          <div className="text-center px-8 py-5 rounded-2xl" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-sm mb-1" style={{ color: '#94A3B8' }}>Jelenlegi egyenleg</p>
            <p className="text-4xl font-bold" style={{ color: '#3B82F6' }}>{Math.round(credits.balance)}</p>
            <p className="text-sm" style={{ color: '#94A3B8' }}>kredit</p>
          </div>
          <div className="text-center px-8 py-5 rounded-2xl" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-sm mb-1" style={{ color: '#94A3B8' }}>Csomag</p>
            <p className="text-2xl font-bold capitalize" style={{ color: '#F8FAFC' }}>{credits.plan || 'Free'}</p>
            <p className="text-sm" style={{ color: '#94A3B8' }}>
              {hasActiveSubscription ? 'Aktív előfizetés' : `${Math.round(credits.total_used)} kredit felhasználva`}
            </p>
          </div>
          {hasActiveSubscription && (
            <div className="text-center">
              <button
                onClick={handleManageSubscription}
                disabled={loading === 'portal'}
                className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#CBD5E1' }}
              >
                {loading === 'portal' ? 'Betöltés...' : 'Előfizetés kezelése'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tab toggle */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setTab('subscription')}
            className="px-6 py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{ background: tab === 'subscription' ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'transparent', color: tab === 'subscription' ? '#fff' : '#94A3B8' }}>
            Havi előfizetés
          </button>
          <button onClick={() => setTab('topup')}
            className="px-6 py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{ background: tab === 'topup' ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'transparent', color: tab === 'topup' ? '#fff' : '#94A3B8' }}>
            Kredit feltöltés
          </button>
        </div>
      </div>

      {/* Pricing cards */}
      {tab === 'subscription' ? (
        <div className="grid grid-cols-3 gap-4 mb-12">
          {PLANS.map(plan => {
            const isCurrentPlan = credits?.plan === plan.key && hasActiveSubscription
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
                  onClick={() => handleSubscription(plan.key)}
                  disabled={loading !== null || isCurrentPlan}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                  style={{
                    background: isCurrentPlan ? 'rgba(34,197,94,0.15)' : plan.featured ? 'linear-gradient(135deg, #3B82F6, #8B5CF6)' : 'rgba(255,255,255,0.06)',
                    border: isCurrentPlan ? '1px solid rgba(34,197,94,0.3)' : plan.featured ? 'none' : '1px solid rgba(255,255,255,0.1)',
                    color: isCurrentPlan ? '#22C55E' : plan.featured ? '#fff' : '#CBD5E1',
                    boxShadow: plan.featured && !isCurrentPlan ? '0 0 20px rgba(59,130,246,0.3)' : 'none',
                  }}>
                  {loading === plan.key ? 'Betöltés...' : isCurrentPlan ? 'Jelenlegi csomag' : plan.featured ? 'Előfizetek' : 'Kiválasztom'}
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div>
          {!hasActiveSubscription && (
            <div className="mb-6 px-4 py-3 rounded-xl text-sm" style={{ background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.3)', color: '#EAB308' }}>
              Kredit feltöltéshez aktív előfizetés szükséges. Válassz előbb egy havi csomagot.
            </div>
          )}
          <div className="grid grid-cols-3 gap-4 mb-12">
            {TOPUP_PACKS.map(pack => (
              <div key={pack.key} className="rounded-2xl p-6 text-center transition-all duration-200 hover:-translate-y-1 relative"
                style={{
                  background: pack.featured ? 'linear-gradient(180deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08), rgba(255,255,255,0.04))' : 'rgba(255,255,255,0.04)',
                  border: pack.featured ? '2px solid rgba(59,130,246,0.5)' : '1px solid rgba(255,255,255,0.08)',
                  boxShadow: pack.featured ? '0 0 32px rgba(59,130,246,0.2), 0 0 64px rgba(139,92,246,0.1)' : 'none',
                  opacity: hasActiveSubscription ? 1 : 0.5,
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
                  disabled={loading !== null || !hasActiveSubscription}
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
        </div>
      )}

      {/* What you get */}
      <div className="rounded-2xl p-6 mb-8" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 className="text-lg font-semibold mb-5" style={{ color: '#F8FAFC' }}>Mit kapsz a kreditjeidért?</h3>
        <div className="grid grid-cols-2 gap-3">
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
