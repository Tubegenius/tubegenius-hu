'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import type { CreatorProfile } from '@/types'
import Logo from '@/components/brand/Logo'
import { CREDIT_BALANCE_UPDATED_EVENT } from '@/lib/credit-balance-events'

interface SidebarProps {
  profile: CreatorProfile | null
}

const navItems = [
  { label: 'Creator központ', href: '/dashboard/overview', icon: 'ti-layout-dashboard' },
  { label: 'Trend Feed', href: '/dashboard', icon: 'ti-chart-dots-3' },
  { label: 'Trend riasztások', href: '/dashboard/trend-alerts', icon: 'ti-bell' },
  { label: 'Videólehetőségek', href: '/dashboard/opportunities', icon: 'ti-bulb' },
  { label: 'Kulcsszókutató', href: '/dashboard/keyword-research', icon: 'ti-tags' },
  { label: 'Versenytársfigyelő', href: '/dashboard/competitors', icon: 'ti-target-arrow' },
  { label: 'Title Studio', href: '/dashboard/title-studio', icon: 'ti-edit' },
  { label: 'Thumbnail Studio', href: '/dashboard/thumbnail-studio', icon: 'ti-photo' },
  { label: 'SEO Optimalizáló', href: '/dashboard/seo-optimizer', icon: 'ti-seo' },
  { label: 'Tartalom naptár', href: '/dashboard/calendar', icon: 'ti-calendar' },
  { label: 'Content Gap Finder', href: '/dashboard/content-gap', icon: 'ti-search-off' },
  { label: 'Piaci bizonyítékok', href: '/dashboard/similar-videos', icon: 'ti-player-play' },
  { label: 'Gyártási csomag', href: '/dashboard/video-package', icon: 'ti-package' },
  { label: 'Videódiagnózis', href: '/dashboard/video-audit', icon: 'ti-stethoscope' },
  { label: 'Channel Audit', href: '/dashboard/channel-audit', icon: 'ti-chart-histogram' },
  { label: 'Virális esély', href: '/dashboard/viral-score', icon: 'ti-chart-bar' },
  { label: 'Auto Transcript', href: '/dashboard/transcript', icon: 'ti-microphone' },
  { label: 'Script Extractor', href: '/dashboard/script-extractor', icon: 'ti-file-text' },
  { label: 'Tartalommemória', href: '/dashboard/memory', icon: 'ti-brain' },
  { label: 'Kreditek', href: '/dashboard/credits', icon: 'ti-bolt' },
]

export default function DashboardSidebar({ profile }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const [credits, setCredits] = useState<{ balance: number; monthly_allowance: number; plan: string } | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    fetch('/api/credits').then(r => r.json()).then(setCredits).catch(() => {})
  }, [pathname])

  useEffect(() => {
    const handleCreditUpdate = (event: Event) => {
      const balance = (event as CustomEvent<number>).detail
      setCredits(current => current ? { ...current, balance } : current)
    }
    window.addEventListener(CREDIT_BALANCE_UPDATED_EVENT, handleCreditUpdate)
    return () => window.removeEventListener(CREDIT_BALANCE_UPDATED_EVENT, handleCreditUpdate)
  }, [])

  // Route váltáskor mobilon automatikusan záródjon a drawer, hogy ne kelljen
  // külön becsukni minden navigáció után.
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // Nyitott drawer alatt a háttér ne görgethető mobilon.
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [mobileOpen])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  const balance = credits?.balance ?? 50
  const allowance = credits?.monthly_allowance ?? 50
  const pct = Math.max(0, Math.min(100, (balance / allowance) * 100))

  return (
    <>
      {/* Hamburger — csak mobilon/tableten látszik, a fix sidebar helyett nyitja a drawert */}
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="Menü megnyitása"
        className="lg:hidden fixed top-4 left-4 z-40 w-10 h-10 rounded-lg flex items-center justify-center"
        style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.1)', color: '#F8FAFC' }}
      >
        <i className="ti ti-menu-2 text-lg" />
      </button>

      {/* Backdrop — mobilon a nyitott drawer mögött, kattintásra zár */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="lg:hidden fixed inset-0 z-40"
          style={{ background: 'rgba(3,5,10,0.6)' }}
        />
      )}

      <aside
        className={`min-h-screen flex flex-col flex-shrink-0 fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out lg:static lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{ width: 260, background: '#080B14', borderRight: '1px solid rgba(255,255,255,0.06)' }}
      >
      <div className="px-5 py-5 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Link href="/dashboard">
          <Logo variant="full" size="md" />
        </Link>
        <button
          onClick={() => setMobileOpen(false)}
          aria-label="Menü bezárása"
          className="lg:hidden w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary"
          style={{ background: 'rgba(255,255,255,0.04)' }}
        >
          <i className="ti ti-x text-base" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {navItems.map(item => {
          const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
          return (
            <Link key={item.href} href={item.href} className={isActive ? 'nav-item-active' : 'nav-item'}>
              <i className={`ti ${item.icon} text-base w-5 text-center`} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="mx-4 my-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }} />

      <div className="mx-3 mb-4 rounded-xl p-5" style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.08))', border: '1px solid rgba(59,130,246,0.2)', boxShadow: '0 0 20px rgba(59,130,246,0.08)' }}>
        <div className="flex items-center gap-2 mb-2">
          <i className="ti ti-bolt text-amber text-sm" />
          <span className="text-sm font-semibold text-text-primary capitalize">{credits?.plan || 'Beta'}</span>
        </div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-text-muted"><i className="ti ti-bolt text-xs" /> {balance.toFixed(1)} kredit</span>
          <span className="text-xs text-text-muted">{balance.toFixed(0)}/{allowance.toFixed(0)}</span>
        </div>
        <div className="w-full h-1.5 rounded-full mb-3" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: pct < 20 ? '#EF4444' : 'linear-gradient(90deg, #3B82F6, #8B5CF6)' }} />
        </div>
        <Link href="/dashboard/credits" className="block w-full text-xs py-2 rounded-lg font-semibold transition-all text-center" style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff', boxShadow: '0 0 15px rgba(59,130,246,0.2)' }}>
          Kreditek vásárlása
        </Link>
      </div>

      <div className="px-3 pb-5 space-y-0.5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
        <Link href="/dashboard/profile" className="nav-item">
          <i className="ti ti-user text-base w-5 text-center" />
          <span>Profilom</span>
        </Link>
        <button onClick={handleLogout} className="nav-item w-full text-left hover:text-rose hover:bg-rose/5">
          <i className="ti ti-logout text-base w-5 text-center" />
          <span>Kilépés</span>
        </button>
      </div>
      </aside>
    </>
  )
}
