'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { scoreColor } from '@/lib/score-utils'

interface ActivityItem {
  type: 'video_package' | 'video_audit' | 'memory' | 'opportunity' | 'similar_videos' | 'script_extract' | 'viral_score'
  title: string
  topic: string
  date: string
  status: string | null
  score: number | null
  href: string
  trend_status: string | null
  views_delta: number | null
}

interface DashboardSummary {
  has_data: boolean
  packages: { total: number; shorts: number; long: number }
  audits: { total: number; avg_score: number | null }
  credits: { balance: number; used_total: number }
  memory: { saved: number; in_progress: number; completed: number; rejected: number }
  fact_safety: {
    verified: number
    verified_with_limits: number
    insufficient_sources: number
    standard_news: number
    high_risk: number
  }
  recent_activity: ActivityItem[]
  content_direction_insight: string
  youtube_signals: {
    videos_seen: number
    snapshots_count: number
    top_viral_score: number | null
    fresh_ratio: number | null
  }
}

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(12px)',
}

const ACTIVITY_ICON: Record<ActivityItem['type'], { icon: string; color: string }> = {
  video_package: { icon: 'ti-package', color: '#EC4899' },
  video_audit: { icon: 'ti-stethoscope', color: '#22C55E' },
  memory: { icon: 'ti-brain', color: '#3B82F6' },
  opportunity: { icon: 'ti-bulb', color: '#3B82F6' },
  similar_videos: { icon: 'ti-player-play', color: '#8B5CF6' },
  script_extract: { icon: 'ti-file-text', color: '#F59E0B' },
  viral_score: { icon: 'ti-chart-bar', color: '#8B5CF6' },
}

const ACTIVITY_TYPE_LABEL: Record<ActivityItem['type'], string> = {
  video_package: 'Videócsomag',
  video_audit: 'Audit',
  memory: 'Téma',
  opportunity: 'Opportunity',
  similar_videos: 'Similar Videos',
  script_extract: 'Script',
  viral_score: 'Viral Score',
}

const TREND_BADGE: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  rising: { label: 'Erősödik', color: '#4ADE80', bg: 'rgba(34,197,94,0.12)', icon: 'ti-trending-up' },
  stable: { label: 'Stabil', color: '#FBBF24', bg: 'rgba(245,158,11,0.12)', icon: 'ti-minus' },
  declining: { label: 'Lassul', color: '#F87171', bg: 'rgba(239,68,68,0.12)', icon: 'ti-trending-down' },
}

function KpiCard({ icon, color, label, value, sub }: { icon: string; color: string; label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl p-4" style={{ background: `${color}0D`, border: `1px solid ${color}22` }}>
      <div className="w-9 h-9 rounded-full flex items-center justify-center mb-3" style={{ background: `${color}26` }}>
        <i className={`ti ${icon} text-base`} style={{ color }} />
      </div>
      <div className="text-2xl font-black mb-0.5" style={{ color: '#F8FAFC' }}>{value}</div>
      <div className="text-xs" style={{ color: '#CBD5E1' }}>{label}</div>
      {sub && <div className="text-xs mt-1" style={{ color: '#64748B' }}>{sub}</div>}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm py-4 text-center" style={{ color: '#64748B' }}>{text}</p>
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `ma ${time}`
  return `${d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })} ${time}`
}

const STATUS_BADGE: Record<string, { color: string; bg: string }> = {
  verified: { color: '#4ADE80', bg: 'rgba(34,197,94,0.12)' },
  verified_with_limits: { color: '#FBBF24', bg: 'rgba(245,158,11,0.12)' },
  insufficient_sources: { color: '#F87171', bg: 'rgba(239,68,68,0.12)' },
  saved: { color: '#93C5FD', bg: 'rgba(59,130,246,0.12)' },
  in_progress: { color: '#FBBF24', bg: 'rgba(245,158,11,0.12)' },
  completed: { color: '#4ADE80', bg: 'rgba(34,197,94,0.12)' },
  rejected: { color: '#F87171', bg: 'rgba(239,68,68,0.12)' },
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_BADGE[status] || { color: '#93C5FD', bg: 'rgba(139,155,180,0.12)' }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0" style={{ color: meta.color, background: meta.bg }}>
      {status}
    </span>
  )
}

export default function CreatorIntelligenceSummary() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/dashboard/summary')
      .then(r => r.json())
      .then(setSummary)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-xl p-4 h-24 animate-pulse" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
        ))}
      </div>
    )
  }
  if (!summary) return null

  if (!summary.has_data) {
    return (
      <div className="mb-8 p-8 text-center" style={PANEL_STYLE}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: 'rgba(59,130,246,0.12)' }}>
          <i className="ti ti-chart-dots-3 text-xl" style={{ color: '#3B82F6' }} />
        </div>
        <p className="text-sm font-medium" style={{ color: '#F8FAFC' }}>Még nincs elég aktivitás az elemzéshez.</p>
        <p className="text-xs mt-1" style={{ color: '#64748B' }}>
          Készíts első videócsomagot vagy futtass egy auditot, hogy megjelenjenek a személyes mutatóid.
        </p>
      </div>
    )
  }

  const { packages, audits, credits, memory, fact_safety, recent_activity, content_direction_insight, youtube_signals } = summary
  const memoryTotal = memory.saved + memory.in_progress + memory.completed + memory.rejected

  return (
    <div className="mb-8">
      {/* KPI kártyák */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <KpiCard icon="ti-package" color="#EC4899" label="Videócsomagok"
          value={packages.total} sub={packages.total > 0 ? `${packages.shorts} short · ${packages.long} long` : undefined} />
        <KpiCard icon="ti-stethoscope" color="#22C55E" label="Auditok"
          value={audits.total} sub={audits.avg_score != null ? `${audits.avg_score} átlag pontszám` : undefined} />
        <KpiCard icon="ti-bolt" color="#F59E0B" label="Kredit egyenleg"
          value={Math.round(credits.balance)} sub={`${Math.round(credits.used_total)} felhasználva összesen`} />
        <KpiCard icon="ti-brain" color="#3B82F6" label="Mentett témák"
          value={memoryTotal} sub={`${memory.completed} lezárva`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Legutóbbi történeted — táblázat */}
        <div className="md:col-span-2 p-5" style={PANEL_STYLE}>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
            <i className="ti ti-clock-hour-4" style={{ color: '#94A3B8' }} />
            Legutóbbi történeted
          </h3>
          {recent_activity.length === 0 ? (
            <EmptyState text="Még nincs naplózott aktivitás." />
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr style={{ color: '#64748B' }}>
                    <th className="text-left font-medium px-1 pb-2">Téma</th>
                    <th className="text-left font-medium px-1 pb-2">Típus</th>
                    <th className="text-left font-medium px-1 pb-2">Állapot</th>
                    <th className="text-left font-medium px-1 pb-2">Trend</th>
                    <th className="text-right font-medium px-1 pb-2">Dátum</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {recent_activity.map((item, i) => {
                    const meta = ACTIVITY_ICON[item.type]
                    return (
                      <tr key={i} className="transition-colors hover:bg-white/[0.02]" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                        <td className="px-1 py-2.5 max-w-[180px]">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${meta.color}22` }}>
                              <i className={`ti ${meta.icon}`} style={{ color: meta.color, fontSize: '11px' }} />
                            </div>
                            <span className="truncate" style={{ color: '#F8FAFC' }}>{item.topic}</span>
                          </div>
                        </td>
                        <td className="px-1 py-2.5" style={{ color: '#94A3B8' }}>{ACTIVITY_TYPE_LABEL[item.type]}</td>
                        <td className="px-1 py-2.5">
                          {item.score != null ? (
                            <span className="font-semibold" style={{ color: scoreColor(item.score) }}>{item.score}</span>
                          ) : item.status ? (
                            <StatusBadge status={item.status} />
                          ) : (
                            <span style={{ color: '#64748B' }}>—</span>
                          )}
                        </td>
                        <td className="px-1 py-2.5">
                          {item.trend_status && TREND_BADGE[item.trend_status] ? (() => {
                            const t = TREND_BADGE[item.trend_status]
                            return (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium" style={{ color: t.color, background: t.bg }}>
                                <i className={`ti ${t.icon}`} style={{ fontSize: '10px' }} />
                                {t.label}
                              </span>
                            )
                          })() : (
                            <span style={{ color: '#64748B' }}>—</span>
                          )}
                        </td>
                        <td className="px-1 py-2.5 text-right whitespace-nowrap" style={{ color: '#64748B' }}>{formatDate(item.date)}</td>
                        <td className="px-1 py-2.5 text-right">
                          <Link href={item.href} style={{ color: '#3B82F6' }}>
                            <i className="ti ti-arrow-up-right" />
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Jobb oldali panel: minőség gauge + tartalomirány + fact safety */}
        <div className="flex flex-col gap-4">
          {audits.avg_score != null && (
            <div className="p-5 text-center" style={PANEL_STYLE}>
              <h3 className="text-sm font-semibold mb-3 flex items-center justify-center gap-2" style={{ color: '#F8FAFC' }}>
                <i className="ti ti-gauge" style={{ color: scoreColor(audits.avg_score) }} />
                Audit átlagpontszám
              </h3>
              <div className="relative w-24 h-24 mx-auto mb-1">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke={scoreColor(audits.avg_score)} strokeWidth="7"
                    strokeDasharray={`${audits.avg_score * 2.64} 264`} strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray 1s ease' }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-bold" style={{ color: scoreColor(audits.avg_score) }}>{audits.avg_score}</span>
                  <span className="text-xs" style={{ color: '#94A3B8' }}>/100</span>
                </div>
              </div>
              <p className="text-xs" style={{ color: '#64748B' }}>{audits.total} lefuttatott audit alapján</p>
            </div>
          )}

          <div className="p-5" style={PANEL_STYLE}>
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
              <i className="ti ti-compass" style={{ color: '#8B5CF6' }} />
              Tartalomirány
            </h3>
            <p className="text-xs leading-relaxed" style={{ color: '#94A3B8' }}>{content_direction_insight}</p>
          </div>

          <div className="p-5" style={PANEL_STYLE}>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
              <i className="ti ti-shield-check" style={{ color: '#22C55E' }} />
              Fact Safety
            </h3>
            {packages.total === 0 ? (
              <EmptyState text="Még nincs generált csomag." />
            ) : (
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span style={{ color: '#94A3B8' }}>Verified</span>
                  <span className="font-semibold" style={{ color: '#4ADE80' }}>{fact_safety.verified}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span style={{ color: '#94A3B8' }}>Verified (limitált)</span>
                  <span className="font-semibold" style={{ color: '#FBBF24' }}>{fact_safety.verified_with_limits}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span style={{ color: '#94A3B8' }}>Kevés forrás</span>
                  <span className="font-semibold" style={{ color: '#F87171' }}>{fact_safety.insufficient_sources}</span>
                </div>
                <div className="flex items-center justify-between pt-2 mt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <span style={{ color: '#94A3B8' }}>Standard hír / High risk</span>
                  <span className="font-semibold" style={{ color: '#CBD5E1' }}>{fact_safety.standard_news} / {fact_safety.high_risk}</span>
                </div>
              </div>
            )}
          </div>

          <div className="p-5" style={PANEL_STYLE}>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
              <i className="ti ti-folder" style={{ color: '#F59E0B' }} />
              Legutóbbi projektjeid
            </h3>
            {(() => {
              const projects = recent_activity.filter(a => a.type === 'video_package' || a.type === 'video_audit').slice(0, 4)
              if (projects.length === 0) return <EmptyState text="Még nincs videócsomag vagy audit." />
              return (
                <div className="space-y-1.5 mb-3">
                  {projects.map((p, i) => {
                    const meta = ACTIVITY_ICON[p.type]
                    return (
                      <Link key={i} href={p.href} className="flex items-center gap-2.5 py-1.5 -mx-1 px-1 rounded-lg transition-colors hover:bg-white/[0.03]">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${meta.color}22` }}>
                          <i className={`ti ${meta.icon}`} style={{ color: meta.color, fontSize: '11px' }} />
                        </div>
                        <span className="text-xs flex-1 min-w-0 truncate" style={{ color: '#CBD5E1' }}>{p.title.replace(/^(Videócsomag készült: |Audit lefuttatva: )/, '')}</span>
                        <span className="text-xs flex-shrink-0" style={{ color: '#64748B' }}>{formatDate(p.date)}</span>
                      </Link>
                    )
                  })}
                </div>
              )
            })()}
            <Link href="/dashboard/opportunities"
              className="block w-full text-center text-xs font-semibold py-2.5 rounded-xl transition-all hover:-translate-y-0.5"
              style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff', boxShadow: '0 0 20px rgba(59,130,246,0.25)' }}>
              Új lehetőség keresése
            </Link>
          </div>
        </div>
      </div>

      {/* Elemzett videójelek — csak ha van adat */}
      {youtube_signals.videos_seen > 0 && (
        <div className="mt-4 p-5" style={PANEL_STYLE}>
          <h3 className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: '#F8FAFC' }}>
            <i className="ti ti-brand-youtube" style={{ color: '#EF4444' }} />
            Elemzett videójelek
          </h3>
          <p className="text-xs mb-4" style={{ color: '#64748B' }}>
            A rendszer azokat a videójeleket naplózza, amelyeket keresés vagy elemzés közben amúgy is lekér.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-lg font-bold" style={{ color: '#F8FAFC' }}>{youtube_signals.videos_seen}</div>
              <div className="text-xs" style={{ color: '#94A3B8' }}>Látott videók</div>
            </div>
            <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-lg font-bold" style={{ color: '#F8FAFC' }}>{youtube_signals.snapshots_count}</div>
              <div className="text-xs" style={{ color: '#94A3B8' }}>Snapshotok</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
