'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import type { CreatorProfile } from '@/types'
import Logo from '@/components/brand/Logo'

interface SidebarProps {
  profile: CreatorProfile | null
}

const navItems = [
  { label: 'Creator központ', href: '/dashboard/overview', icon: 'ti-layout-dashboard' },
  { label: 'Trend Feed', href: '/dashboard', icon: 'ti-chart-dots-3' },
  { label: 'Videólehetőségek', href: '/dashboard/opportunities', icon: 'ti-bulb' },
  { label: 'Piaci bizonyítékok', href: '/dashboard/similar-videos', icon: 'ti-player-play' },
  { label: 'Gyártási csomag', href: '/dashboard/video-package', icon: 'ti-package' },
  { label: 'Videódiagnózis', href: '/dashboard/video-audit', icon: 'ti-stethoscope' },
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

  useEffect(() => {
    fetch('/api/credits').then(r => r.json()).then(setCredits).catch(() => {})
  }, [pathname])

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  const balance = credits?.balance ?? 50
  const allowance = credits?.monthly_allowance ?? 50
  const pct = Math.max(0, Math.min(100, (balance / allowance) * 100))

  return (
    <aside className="min-h-screen flex flex-col flex-shrink-0" style={{ width: 260, background: '#080B14', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="px-5 py-5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Link href="/dashboard">
          <Logo variant="full" size="md" />
        </Link>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-0.5">
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
  )
}
