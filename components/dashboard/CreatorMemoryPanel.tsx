'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { CreatorMemoryItem } from '@/types'

const stateConfig = {
  saved: { label: 'Mentett', color: 'text-violet', bg: 'bg-violet/10', border: 'border-violet/20' },
  in_progress: { label: 'Folyamatban', color: 'text-amber', bg: 'bg-amber/10', border: 'border-amber/20' },
  completed: { label: 'Kész', color: 'text-emerald', bg: 'bg-emerald/10', border: 'border-emerald/20' },
  rejected: { label: 'Elutasított', color: 'text-text-muted', bg: 'bg-surface-2', border: 'border-border' },
}

export default function CreatorMemoryPanel({ items: initialItems }: { items: CreatorMemoryItem[] }) {
  const [items, setItems] = useState<CreatorMemoryItem[]>(initialItems)

  // Frissítés minden 30 másodpercben
  useEffect(() => {
    async function refresh() {
      const res = await fetch('/api/memory')
      const data = await res.json()
      if (data.items) setItems(data.items)
    }
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [])

  const saved = items.filter(i => i.state === 'saved')
  const inProgress = items.filter(i => i.state === 'in_progress')
  const completed = items.filter(i => i.state === 'completed')
  const activeItems = [...inProgress, ...saved].slice(0, 5)

  return (
    <div className="space-y-4">
      <div>
        <p className="section-label mb-3">Creator Memory</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Mentett', count: saved.length, color: 'text-violet' },
            { label: 'Folyamat', count: inProgress.length, color: 'text-amber' },
            { label: 'Kész', count: completed.length, color: 'text-emerald' },
          ].map(stat => (
            <div key={stat.label} className="card text-center py-3 px-2">
              <p className={`text-xl font-bold ${stat.color}`}>{stat.count}</p>
              <p className="text-text-muted text-xs mt-0.5">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="section-label mb-3">Aktív témák</p>
        {activeItems.length === 0 ? (
          <div className="card text-center py-6">
            <p className="text-2xl mb-2">📌</p>
            <p className="text-text-muted text-sm">Mentsd el az Opportunity Engine témáit.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeItems.map(item => {
              const config = stateConfig[item.state]
              return (
                <div key={item.id} className="card py-3 px-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-text-primary leading-snug flex-1 min-w-0">{item.topic}</p>
                    <span className={`flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${config.bg} ${config.color} ${config.border}`}>
                      {config.label}
                    </span>
                  </div>
                  {(item.viral_score || item.opportunity_score) && (
                    <div className="flex gap-3 mt-2">
                      {item.viral_score && <span className="text-xs text-text-muted">Viral: <span className="text-text-secondary font-medium">{item.viral_score}</span></span>}
                      {item.opportunity_score && <span className="text-xs text-text-muted">Lehetőség: <span className="text-text-secondary font-medium">{item.opportunity_score}</span></span>}
                    </div>
                  )}
                  {/* Gyors akciók */}
                  <div className="flex gap-2 mt-2">
                    <a href={`/dashboard/viral-score?topic=${encodeURIComponent(item.topic)}`}
                      className="text-xs text-text-muted hover:text-violet transition-colors">📈 Viral Score</a>
                    <a href={`/dashboard/similar-videos?topic=${encodeURIComponent(item.topic)}`}
                      className="text-xs text-text-muted hover:text-violet transition-colors ml-2">🎬 Videók</a>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {items.length > 0 && (
        <Link href="/dashboard/memory" className="btn-ghost w-full text-sm text-center block">
          Összes téma →
        </Link>
      )}
    </div>
  )
}
