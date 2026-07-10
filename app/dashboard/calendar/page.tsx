'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { VideoIdea } from '@/types'

function formatDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('hu-HU')
}

function IdeaCard({ idea, onUpdate }: { idea: VideoIdea; onUpdate: () => void }) {
  const [date, setDate] = useState(idea.scheduled_publish_date || '')
  const [notes, setNotes] = useState(idea.calendar_notes || '')
  const [saving, setSaving] = useState(false)

  async function saveSchedule() {
    setSaving(true)
    await fetch('/api/video-ideas', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idea.id, calendar_status: 'scheduled', scheduled_publish_date: date || null, calendar_notes: notes || null }),
    })
    setSaving(false)
    onUpdate()
  }

  async function markPublished() {
    setSaving(true)
    await fetch('/api/video-ideas', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: idea.id, workflow_status: 'published', publish_status: 'published' }),
    })
    setSaving(false)
    onUpdate()
  }

  return (
    <div className="card-hover">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="font-medium text-sm flex-1" style={{ color: '#F8FAFC' }}>{idea.title || idea.topic}</h3>
        {idea.video_package_id && (
          <Link href={`/dashboard/video-package?id=${idea.video_package_id}`} className="text-xs px-2 py-1 rounded-lg whitespace-nowrap" style={{ background: 'rgba(59,130,246,0.1)', color: '#3B82F6' }}>
            🎁 Csomag
          </Link>
        )}
      </div>

      <div className="flex gap-2 mb-3">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-xs"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Megjegyzés (kampány, platform...)"
          className="flex-1 px-3 py-1.5 rounded-lg text-xs"
          style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#F8FAFC' }}
        />
      </div>

      <div className="flex gap-2">
        <button onClick={saveSchedule} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', color: '#3B82F6' }}>
          📅 Ütemezés mentése
        </button>
        <button onClick={markPublished} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22C55E' }}>
          ✓ Publikáltnak jelölés
        </button>
      </div>
    </div>
  )
}

export default function CalendarPage() {
  const [ideas, setIdeas] = useState<VideoIdea[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/video-ideas?limit=100')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'A naptár betöltése sikertelen. Próbáld újra később.')
        return
      }
      setIdeas(data.ideas || [])
    } catch {
      setError('Kapcsolati hiba. Próbáld újra később.')
    } finally {
      setLoading(false)
    }
  }

  const scheduled = ideas.filter(i => i.calendar_status === 'scheduled' && i.workflow_status !== 'published')
    .sort((a, b) => (a.scheduled_publish_date || '9999').localeCompare(b.scheduled_publish_date || '9999'))
  const readyNotScheduled = ideas.filter(i => i.workflow_status === 'ready_to_produce' && i.calendar_status !== 'scheduled')
  const published = ideas.filter(i => i.workflow_status === 'published').slice(0, 10)

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#F8FAFC' }}>🗓️ Tartalom naptár</h1>
        <p className="text-sm" style={{ color: '#CBD5E1' }}>Gyártásra kész ötletek ütemezése és publikálás nyomon követése.</p>
      </div>

      {error && (
        <div className="card mb-6" style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <p className="text-sm mb-2" style={{ color: '#EF4444' }}>{error}</p>
          <button onClick={load} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>Újrapróbálás</button>
        </div>
      )}

      {loading && (
        <div className="card text-center py-12">
          <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3B82F6', borderTopColor: 'transparent' }} />
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-6">
          <div>
            <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>📅 ÜTEMEZVE ({scheduled.length})</p>
            {scheduled.length === 0 ? (
              <div className="card text-center py-6">
                <p style={{ color: '#CBD5E1' }} className="text-sm">Még nincs ütemezett videó.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {scheduled.map(idea => <IdeaCard key={idea.id} idea={idea} onUpdate={load} />)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>🎁 GYÁRTÁSRA KÉSZ, MÉG NINCS ÜTEMEZVE ({readyNotScheduled.length})</p>
            {readyNotScheduled.length === 0 ? (
              <div className="card text-center py-6">
                <p style={{ color: '#CBD5E1' }} className="text-sm">Nincs gyártásra kész, ütemezetlen videócsomagod.</p>
                <Link href="/dashboard/video-package" className="btn-primary inline-block mt-3 text-sm">Videócsomag készítése →</Link>
              </div>
            ) : (
              <div className="space-y-3">
                {readyNotScheduled.map(idea => <IdeaCard key={idea.id} idea={idea} onUpdate={load} />)}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>✓ LEGUTÓBB PUBLIKÁLT</p>
            {published.length === 0 ? (
              <div className="card text-center py-6">
                <p style={{ color: '#CBD5E1' }} className="text-sm">Még nincs publikáltnak jelölt videód.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {published.map(idea => (
                  <div key={idea.id} className="card py-3 px-4 flex items-center justify-between">
                    <p className="text-sm" style={{ color: '#F8FAFC' }}>{idea.title || idea.topic}</p>
                    <span className="text-xs" style={{ color: '#94A3B8' }}>{formatDate(idea.updated_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
