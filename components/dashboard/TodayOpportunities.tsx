'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import type { CreatorProfile, OpportunityTopic } from '@/types'

interface TodayOpportunitiesProps {
  profile: CreatorProfile | null
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? 'text-emerald' : score >= 45 ? 'text-amber' : 'text-rose'
  return <span className={`font-bold text-lg ${color}`}>{score}</span>
}

export default function TodayOpportunities({ profile }: TodayOpportunitiesProps) {
  const [topics, setTopics] = useState<OpportunityTopic[]>([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)

  async function loadOpportunities() {
    if (!profile?.niche) return
    setLoading(true)

    try {
      const res = await fetch('/api/opportunity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: profile.niche,
          platform: profile.platform,
          language: profile.language,
          region: profile.region,
          creator_level: profile.creator_level,
        }),
      })
      const data = await res.json()
      if (data.topics) {
        setTopics(data.topics.slice(0, 3))
        setGenerated(true)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="section-label">Mai lehetőségek</p>
        {generated && (
          <Link href="/dashboard/opportunities" className="text-xs text-violet hover:text-violet-glow transition-colors">
            Összes →
          </Link>
        )}
      </div>

      {!generated ? (
        <div className="card text-center py-10">
          <p className="text-4xl mb-3">🎯</p>
          <h3 className="font-semibold text-text-primary mb-1">
            {profile?.niche ? 'Készen állunk' : 'Töltsd ki a profilodat'}
          </h3>
          <p className="text-text-muted text-sm mb-5 max-w-xs mx-auto">
            {profile?.niche
              ? `${profile.niche} témában megkeressük a legjobb lehetőségeket számodra.`
              : 'A niche megadása után személyre szabott lehetőségeket mutatunk.'}
          </p>
          {profile?.niche ? (
            <button
              onClick={loadOpportunities}
              disabled={loading}
              className="btn-primary"
            >
              {loading ? 'Generálás...' : 'Lehetőségek generálása'}
            </button>
          ) : (
            <Link href="/dashboard/profile" className="btn-secondary">
              Profil kitöltése
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {topics.map((topic, i) => (
            <div key={topic.id} className="card-hover flex items-start gap-4">
              <div className="text-xs font-mono text-text-muted w-5 mt-0.5 flex-shrink-0">
                {String(i + 1).padStart(2, '0')}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-text-primary text-sm mb-1 leading-snug">
                  {topic.title}
                </h4>
                <p className="text-text-muted text-xs line-clamp-2">
                  {topic.description}
                </p>
              </div>
              <div className="flex-shrink-0 text-right">
                <ScoreBadge score={topic.opportunity_score} />
                <p className="text-text-muted text-xs">score</p>
              </div>
            </div>
          ))}
          
          <button
            onClick={loadOpportunities}
            disabled={loading}
            className="btn-ghost w-full text-sm"
          >
            {loading ? 'Frissítés...' : '↻ Új lehetőségek'}
          </button>
        </div>
      )}
    </div>
  )
}
