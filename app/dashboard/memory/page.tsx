'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { CreatorMemoryItem, TopicState } from '@/types'
import { scoreLabel, scoreLabelColor } from '@/lib/score-utils'

type MemoryItemExtended = CreatorMemoryItem & {
  audit_score?: number | null
  audit_id?: string | null
  video_package_id?: string | null
}

interface AuditSummary {
  id: string
  platform: string
  video_title: string
  overall_score: number
  confidence: string
  decision: string
  decision_label: string
  created_at: string
}

interface PackageSummary {
  id: string
  topic: string
  search_keyword: string | null
  platform: string
  video_length: string
  narration_style: string | null
  title_variations: string[]
  created_at: string
  updated_at: string
}

const STATE_CONFIG: Record<TopicState, { label: string; icon: string; color: string; bg: string; border: string }> = {
  saved:       { label: 'Mentett',      icon: '📌', color: '#3B82F6', bg: 'rgba(59,130,246,0.08)',    border: 'rgba(59,130,246,0.2)' },
  in_progress: { label: 'Folyamatban',  icon: '🛠',  color: '#F59E0B', bg: 'rgba(245,158,11,0.08)',   border: 'rgba(245,158,11,0.2)' },
  completed:   { label: 'Kész',         icon: '✅', color: '#22C55E', bg: 'rgba(34,197,94,0.08)',    border: 'rgba(34,197,94,0.2)' },
  rejected:    { label: 'Elutasított',  icon: '⛔', color: '#CBD5E1', bg: 'rgba(139,155,180,0.05)', border: 'rgba(139,155,180,0.15)' },
}

const TABS: { value: TopicState | 'all' | 'packages' | 'audits'; label: string }[] = [
  { value: 'all',         label: 'Összes' },
  { value: 'saved',       label: 'Mentett' },
  { value: 'in_progress', label: 'Folyamatban' },
  { value: 'completed',   label: 'Kész' },
  { value: 'rejected',    label: 'Elutasított' },
  { value: 'packages',    label: '🎁 Videócsomagok' },
  { value: 'audits',      label: '🔍 Auditok' },
]

const PLATFORM_ICONS: Record<string, string> = {
  youtube_shorts: '▶',
  tiktok: '🎵',
  instagram_reels: '📸',
  youtube_long: '🎬',
  facebook_reels: '📘',
}

function MemoryCard({ item, onUpdate }: { item: MemoryItemExtended; onUpdate: () => void }) {
  const [updating, setUpdating] = useState(false)
  const config = STATE_CONFIG[item.state]
  const searchTerm = item.search_keyword || item.topic

  async function changeState(newState: TopicState) {
    setUpdating(true)
    await fetch('/api/memory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, state: newState }),
    })
    setUpdating(false)
    onUpdate()
  }

  async function deleteItem() {
    setUpdating(true)
    await fetch('/api/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    })
    onUpdate()
  }

  return (
    <div className="card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
              style={{ background: config.bg, border: `1px solid ${config.border}`, color: config.color }}>
              {config.icon} {config.label}
            </span>
            {item.platform && (
              <span className="text-xs capitalize" style={{ color: '#94A3B8' }}>{item.platform}</span>
            )}
          </div>
          <h3 className="font-medium text-sm leading-snug mb-2" style={{ color: '#F8FAFC' }}>{item.topic}</h3>

          <div className="flex gap-4 text-xs mb-3 flex-wrap" style={{ color: '#CBD5E1' }}>
            {item.opportunity_score != null && (
              <span>Opportunity: <b style={{ color: '#F8FAFC' }}>{item.opportunity_score}</b>
                <span className="ml-1 font-medium" style={{ color: scoreLabelColor(item.opportunity_score) }}>
                  ({scoreLabel(item.opportunity_score)})
                </span>
              </span>
            )}
            {item.viral_score != null && (
              <span>Viral: <b style={{ color: '#F8FAFC' }}>{item.viral_score}</b>
                <span className="ml-1 font-medium" style={{ color: scoreLabelColor(item.viral_score) }}>
                  ({scoreLabel(item.viral_score)})
                </span>
              </span>
            )}
            {item.audit_score != null && (
              <span className="flex items-center gap-1">
                <span className="px-1.5 py-0.5 rounded text-xs font-semibold"
                  style={{ background: 'rgba(139,92,246,0.15)', color: '#A78BFA' }}>Audit</span>
                <b style={{ color: '#F8FAFC' }}>{item.audit_score}</b>
                <span className="font-medium" style={{ color: scoreLabelColor(item.audit_score) }}>
                  ({scoreLabel(item.audit_score)})
                </span>
              </span>
            )}
            <span>Frissítve: {new Date(item.updated_at).toLocaleDateString('hu-HU')}</span>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Link href={`/dashboard/viral-score?topic=${encodeURIComponent(searchTerm)}`}
              className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              📈 Virális esély
            </Link>
            <Link href={`/dashboard/similar-videos?topic=${encodeURIComponent(searchTerm)}`}
              className="text-xs px-3 py-1.5 rounded-lg transition-all"
              style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
              🎬 Videók
            </Link>
            {item.video_package_id ? (
              <Link href={`/dashboard/video-package?id=${item.video_package_id}`}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                👁 Videócsomag megnyitása
              </Link>
            ) : (
              <Link href={`/dashboard/video-package?topic=${encodeURIComponent(item.topic)}&keyword=${encodeURIComponent(item.search_keyword || '')}`}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
                🎁 Új videócsomag
              </Link>
            )}
            {item.audit_id && (
              <Link href={`/dashboard/video-audit?id=${item.audit_id}`}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', color: '#A78BFA' }}>
                🔍 Audit megtekintése
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 flex-shrink-0">
          {item.state !== 'completed' && (
            <button onClick={() => changeState('completed')} disabled={updating}
              className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
              style={{ background: 'rgba(34,197,94,0.1)', color: '#22C55E', border: '1px solid rgba(34,197,94,0.2)' }}>
              ✅ Kész
            </button>
          )}
          {item.state !== 'in_progress' && item.state !== 'completed' && (
            <button onClick={() => changeState('in_progress')} disabled={updating}
              className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
              style={{ background: 'rgba(245,158,11,0.1)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.2)' }}>
              🛠 Folyamatban
            </button>
          )}
          {item.state !== 'rejected' && (
            <button onClick={() => changeState('rejected')} disabled={updating}
              className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
              style={{ background: '#121826', color: '#CBD5E1', border: '1px solid rgba(255,255,255,0.08)' }}>
              ⛔ Elutasít
            </button>
          )}
          <button onClick={deleteItem} disabled={updating}
            className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(239,68,68,0.05)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.15)' }}>
            🗑 Törlés
          </button>
        </div>
      </div>
    </div>
  )
}

function PackageCard({ pkg, onDelete }: { pkg: PackageSummary; onDelete: () => void }) {
  const [deleting, setDeleting] = useState(false)

  async function handleDelete() {
    setDeleting(true)
    await fetch('/api/video-packages', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pkg.id }),
    })
    onDelete()
  }

  return (
    <div className="card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-base">{PLATFORM_ICONS[pkg.platform] || '🎬'}</span>
            <span className="text-xs capitalize" style={{ color: '#94A3B8' }}>
              {pkg.platform.replace('_', ' ')} · {pkg.video_length}
            </span>
            {pkg.narration_style && (
              <span className="text-xs capitalize" style={{ color: '#94A3B8' }}>· {pkg.narration_style}</span>
            )}
          </div>
          <h3 className="font-medium text-sm leading-snug mb-1" style={{ color: '#F8FAFC' }}>{pkg.topic}</h3>
          {pkg.title_variations?.[0] && (
            <p className="text-xs leading-relaxed mb-2 line-clamp-1" style={{ color: '#CBD5E1' }}>
              "{pkg.title_variations[0]}"
            </p>
          )}
          <p className="text-xs" style={{ color: '#94A3B8' }}>
            Generálva: {new Date(pkg.created_at).toLocaleDateString('hu-HU')}
          </p>
        </div>

        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <Link href={`/dashboard/video-package?id=${pkg.id}`}
            className="text-xs px-3 py-1.5 rounded-lg font-medium text-center transition-all"
            style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
            👁 Megnyitás
          </Link>
          <button onClick={handleDelete} disabled={deleting}
            className="text-xs px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(239,68,68,0.05)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.15)' }}>
            🗑 Törlés
          </button>
        </div>
      </div>
    </div>
  )
}

export default function CreatorMemoryPage() {
  const [items, setItems] = useState<MemoryItemExtended[]>([])
  const [packages, setPackages] = useState<PackageSummary[]>([])
  const [audits, setAudits] = useState<AuditSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TopicState | 'all' | 'packages' | 'audits'>('all')

  useEffect(() => { loadItems(); loadPackages(); loadAudits() }, [])

  async function loadItems() {
    setLoading(true)
    try {
      const res = await fetch('/api/memory')
      const data = await res.json()
      setItems(data.items || [])
    } finally {
      setLoading(false)
    }
  }

  async function loadPackages() {
    try {
      const res = await fetch('/api/video-packages')
      const data = await res.json()
      setPackages(data.packages || [])
    } catch {}
  }

  async function loadAudits() {
    try {
      const res = await fetch('/api/video-audits')
      const data = await res.json()
      setAudits(data.audits || [])
    } catch {}
  }

  // audits tab esetén filtered = [] — a creator_memory tételek nem jelennek meg
  const filtered: MemoryItemExtended[] = activeTab === 'all' || activeTab === 'packages'
    ? items
    : activeTab === 'audits'
    ? []
    : items.filter(i => i.state === activeTab)

  const counts = {
    all:         items.length,
    saved:       items.filter(i => i.state === 'saved').length,
    in_progress: items.filter(i => i.state === 'in_progress').length,
    completed:   items.filter(i => i.state === 'completed').length,
    rejected:    items.filter(i => i.state === 'rejected').length,
    packages:    packages.length,
    audits:      audits.length,
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🧠 Tartalommemória</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Minden mentett témád és generált videócsomagod egy helyen.</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map(tab => (
          <button key={tab.value} onClick={() => setActiveTab(tab.value)}
            className="px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5"
            style={{
              background: activeTab === tab.value ? 'rgba(59,130,246,0.1)' : '#0F1420',
              border: activeTab === tab.value ? '1px solid rgba(59,130,246,0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: activeTab === tab.value ? '#3B82F6' : '#CBD5E1',
            }}>
            {tab.label}
            <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#121826', color: '#94A3B8' }}>
              {counts[tab.value as keyof typeof counts]}
            </span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="card text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        </div>
      )}

      {/* Auditok tab — csak video_audits tábla adatai */}
      {!loading && activeTab === 'audits' && (
        audits.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-3xl mb-3">🔍</p>
            <p style={{ color: '#CBD5E1' }}>Még nincs elvégzett Videódiagnózis.</p>
            <Link href="/dashboard/video-audit" className="btn-primary inline-block mt-4">
              Videódiagnózis indítása →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {audits.map(audit => {
              const scoreCol = audit.overall_score >= 70 ? '#22C55E' : audit.overall_score >= 45 ? '#F59E0B' : '#EF4444'
              const scoreText = audit.overall_score >= 85 ? 'Kiváló'
                : audit.overall_score >= 70 ? 'Jó'
                : audit.overall_score >= 55 ? 'Közepes'
                : audit.overall_score >= 40 ? 'Gyenge'
                : 'Kritikus'
              return (
                <div key={audit.id} className="card-hover">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs capitalize px-2 py-0.5 rounded-full"
                          style={{ background: 'rgba(139,92,246,0.1)', color: '#A78BFA', border: '1px solid rgba(139,92,246,0.2)' }}>
                          {audit.platform.replace('_', ' ')}
                        </span>
                        <span className="text-xs" style={{ color: '#94A3B8' }}>
                          {new Date(audit.created_at).toLocaleDateString('hu-HU')}
                        </span>
                      </div>
                      <h3 className="font-medium text-sm leading-snug mb-2" style={{ color: '#F8FAFC' }}>
                        {audit.video_title}
                      </h3>
                      <p className="text-xs font-medium" style={{ color: '#CBD5E1' }}>
                        {audit.decision_label || audit.decision}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <div className="text-2xl font-bold" style={{ color: scoreCol }}>{audit.overall_score}</div>
                      <div className="text-xs font-medium" style={{ color: scoreCol }}>{scoreText}</div>
                      <Link href={`/dashboard/video-audit?id=${audit.id}`}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium mt-1"
                        style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', color: '#A78BFA' }}>
                        👁 Megtekintés
                      </Link>
                      <Link href="/dashboard/video-audit"
                        className="text-xs px-3 py-1.5 rounded-lg font-medium mt-1"
                        style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
                        🔍 Új audit
                      </Link>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* Videócsomagok tab */}
      {!loading && activeTab === 'packages' && (
        packages.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-3xl mb-3">🎁</p>
            <p style={{ color: '#CBD5E1' }}>Még nincs generált videócsomagod.</p>
            <Link href="/dashboard/video-package" className="btn-primary inline-block mt-4">
              Videócsomag készítése →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {packages.map(pkg => <PackageCard key={pkg.id} pkg={pkg} onDelete={loadPackages} />)}
          </div>
        )
      )}

      {/* Témák tabok — packages és audits esetén NEM jelenik meg */}
      {!loading && activeTab !== 'packages' && activeTab !== 'audits' && (
        filtered.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-3xl mb-3">🔭</p>
            <p style={{ color: '#CBD5E1' }}>
              {activeTab === 'all'
                ? 'Még nincs mentett témád.'
                : `Nincs "${TABS.find(t => t.value === activeTab)?.label}" állapotú téma.`}
            </p>
            <Link href="/dashboard/opportunities" className="btn-primary inline-block mt-4">
              Lehetőségek felfedezése →
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(item => <MemoryCard key={item.id} item={item} onUpdate={loadItems} />)}
          </div>
        )
      )}
    </div>
  )
}
