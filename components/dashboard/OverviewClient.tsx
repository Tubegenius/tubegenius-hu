'use client'

import Link from 'next/link'
import CreatorIntelligenceSummary from '@/components/dashboard/CreatorIntelligenceSummary'
import TrackedTrendsPanel from '@/components/dashboard/TrackedTrendsPanel'
import TopOpportunitiesRow from '@/components/dashboard/TopOpportunitiesRow'
import { getDailyTip, getCategoryIcon, getCategoryColor } from '@/lib/viral-tips'
import type { CreatorProfile } from '@/types'

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 10) return 'Jó reggelt'
  if (hour >= 10 && hour < 18) return 'Szia'
  if (hour >= 18 && hour < 23) return 'Jó estét'
  return 'Szia'
}

const quickActions = [
  { icon: 'ti-chart-dots-3', label: 'Trend Feed', sub: 'Mai ajánlás', href: '/dashboard', color: '#3B82F6' },
  { icon: 'ti-bulb', label: 'Videólehetőségek', sub: 'Elemzés', href: '/dashboard/opportunities', color: '#3B82F6' },
  { icon: 'ti-player-play', label: 'Piaci bizonyítékok', sub: 'Keresés', href: '/dashboard/similar-videos', color: '#3B82F6' },
  { icon: 'ti-package', label: 'Videócsomag', sub: 'Generálás', href: '/dashboard/video-package', color: '#EC4899' },
  { icon: 'ti-stethoscope', label: 'Videódiagnózis', sub: 'Elemzés', href: '/dashboard/video-audit', color: '#22C55E' },
  { icon: 'ti-chart-bar', label: 'Virális esély', sub: 'Elemzés', href: '/dashboard/viral-score', color: '#8B5CF6' },
  { icon: 'ti-file-text', label: 'Script', sub: 'Kinyerés', href: '/dashboard/script-extractor', color: '#F59E0B' },
  { icon: 'ti-brain', label: 'Tartalommemória', sub: 'Témák', href: '/dashboard/memory', color: '#3B82F6' },
]

export default function OverviewClient({ displayName, profile }: { displayName: string; profile: CreatorProfile | null }) {
  const tip = getDailyTip(profile?.platform)
  const tipIcon = getCategoryIcon(tip.category)
  const tipColor = getCategoryColor(tip.category)

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-2xl font-bold" style={{ color: '#F8FAFC' }}>{getGreeting()}, {displayName}!</h1>
        <p className="text-sm" style={{ color: '#94A3B8' }}>Így halad a saját aktivitásod alapján a tartalomgyártásod.</p>
      </div>

      <TopOpportunitiesRow profile={profile} />

      <CreatorIntelligenceSummary />

      <TrackedTrendsPanel />

      {/* Gyors műveletek */}
      <div className="mb-6">
        <h3 className="font-semibold text-sm mb-3" style={{ color: '#F8FAFC' }}>Gyors műveletek</h3>
        <div className="grid grid-cols-3 lg:grid-cols-4 gap-2">
          {quickActions.map(action => (
            <Link key={action.href} href={action.href}
              className="rounded-xl p-3 text-center transition-all duration-150 hover:-translate-y-0.5"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center mx-auto mb-2" style={{ background: `${action.color}15` }}>
                <i className={`ti ${action.icon}`} style={{ color: action.color, fontSize: '18px' }} />
              </div>
              <div className="text-xs font-semibold" style={{ color: '#F8FAFC' }}>{action.label}</div>
              <div className="text-xs" style={{ color: '#64748B' }}>{action.sub}</div>
            </Link>
          ))}
        </div>
      </div>

      {/* Napi Creator Tipp */}
      <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${tipColor}15` }}>
            <i className={`ti ${tipIcon}`} style={{ color: tipColor, fontSize: '20px' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: tipColor }}>Napi tipp</span>
              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.04)', color: '#64748B' }}>{tip.category}</span>
            </div>
            <h4 className="text-sm font-semibold mb-1" style={{ color: '#F8FAFC' }}>{tip.title}</h4>
            <p className="text-xs leading-relaxed mb-2" style={{ color: '#94A3B8' }}>{tip.body}</p>
            <p className="text-xs font-medium" style={{ color: tipColor }}>
              <i className="ti ti-arrow-right mr-1" style={{ fontSize: '12px' }} />{tip.action}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
