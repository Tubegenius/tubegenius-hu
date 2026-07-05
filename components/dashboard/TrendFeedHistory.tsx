'use client'

import { useEffect, useState } from 'react'
import { scoreColor } from '@/lib/score-utils'

interface HistoryTopic {
  id: string
  title: string
  opportunity_score: number
}

interface Snapshot {
  snapshot_date: string
  niche: string | null
  topics: HistoryTopic[]
}

function formatDateLabel(dateStr: string): string {
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (dateStr === today) return 'Ma'
  if (dateStr === yesterday) return 'Tegnap'
  return new Date(dateStr).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
}

export default function TrendFeedHistory() {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    fetch('/api/dashboard/trend-feed-history')
      .then(r => r.json())
      .then(d => setSnapshots(d.snapshots || []))
      .catch(() => setSnapshots([]))
  }, [])

  // Csak a mai napon kívüli snapshotokat mutatjuk itt (a mai már a fő kártyán látszik)
  const past = (snapshots || []).filter(s => s.snapshot_date !== new Date().toISOString().slice(0, 10))
  if (!snapshots || past.length === 0) return null

  return (
    <div className="mb-6 rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between">
        <span className="text-sm font-semibold flex items-center gap-2" style={{ color: '#F8FAFC' }}>
          <i className="ti ti-history" style={{ color: '#94A3B8' }} />
          Korábbi heti ajánlások
        </span>
        <i className={`ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ color: '#64748B' }} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {past.map(s => (
            <div key={s.snapshot_date} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <p className="text-xs font-semibold mb-2" style={{ color: '#94A3B8' }}>{formatDateLabel(s.snapshot_date)}</p>
              <div className="space-y-1.5">
                {s.topics.slice(0, 3).map(t => (
                  <div key={t.id} className="flex items-center gap-2">
                    <span className="text-xs font-bold w-7 flex-shrink-0" style={{ color: scoreColor(t.opportunity_score) }}>{t.opportunity_score}</span>
                    <span className="text-xs truncate" style={{ color: '#CBD5E1' }}>{t.title}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
