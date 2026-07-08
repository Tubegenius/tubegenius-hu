'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { CreatorProfile, OpportunityTopic } from '@/types'
import { scoreColor } from '@/lib/score-utils'

const PANEL_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.045)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(12px)',
}

function isProductionCandidate(topic: OpportunityTopic) {
  return topic.ready_to_produce_status === 'ready' || topic.ready_to_produce_status === 'watch'
}

function demandLabel(breakdown: OpportunityTopic['score_breakdown']): { label: string; color: string } {
  const v = breakdown?.trend_momentum ?? breakdown?.niche_match ?? 0
  if (v >= 70) return { label: 'Magas', color: '#4ADE80' }
  if (v >= 40) return { label: 'Közepes', color: '#FBBF24' }
  return { label: 'Alacsony', color: '#F87171' }
}

function competitionLabel(breakdown: OpportunityTopic['score_breakdown']): { label: string; color: string } {
  const competition = breakdown?.competition ?? 50
  const freeMarket = 100 - competition // alacsony verseny = jó, fordított logika
  if (freeMarket >= 70) return { label: 'Alacsony', color: '#4ADE80' }
  if (freeMarket >= 40) return { label: 'Közepes', color: '#FBBF24' }
  return { label: 'Magas', color: '#F87171' }
}

function buildPackageUrl(topic: OpportunityTopic) {
  const params = new URLSearchParams({
    topic: topic.title,
    keyword: topic.keyword || '',
    opportunity_id: topic.id,
    source_context: 'opportunity_engine',
  })
  return `/dashboard/video-package?${params.toString()}`
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'ma frissítve'
  const days = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (days <= 1) return 'tegnap frissítve'
  return `${days} napja frissítve`
}

export default function TopOpportunitiesRow({ profile }: { profile: CreatorProfile | null }) {
  const [topics, setTopics] = useState<OpportunityTopic[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  useEffect(() => {
    if (!profile?.niche) { setLoading(false); return }
    fetch('/api/opportunity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        niche: profile.niche, platform: profile.platform,
        language: profile.language, region: profile.region,
        creator_level: profile.creator_level,
        main_category: profile.main_category,
        specific_focus: profile.specific_focus,
        cache_only: true,
      }),
    })
      .then(r => r.json())
      .then(data => {
        const all = (data.topics || []) as OpportunityTopic[]
        const production = all.filter(isProductionCandidate)
        setTopics((production.length > 0 ? production : all).slice(0, 4))
        setGeneratedAt(data.generated_at || null)
      })
      .catch(() => setTopics([]))
      .finally(() => setLoading(false))
  }, [profile?.niche])

  if (loading) {
    return (
      <div className="mb-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-2xl h-56 animate-pulse" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }} />
        ))}
      </div>
    )
  }

  if (!topics || topics.length === 0) {
    return (
      <div className="mb-6 p-6 text-center" style={PANEL_STYLE}>
        <p className="text-sm font-medium" style={{ color: '#F8FAFC' }}>
          <i className="ti ti-flame mr-1" style={{ color: '#F59E0B' }} />
          Top lehetőségek most
        </p>
        <p className="text-xs mt-2" style={{ color: '#64748B' }}>
          Még nincs friss, validált találat. Tölts be egy ajánlást a Trend Feed-en vagy a Videólehetőségeknél.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold flex items-center gap-1.5" style={{ color: '#F8FAFC' }}>
          <i className="ti ti-flame" style={{ color: '#F59E0B' }} />
          Top lehetőségek most
          {generatedAt && (
            <span className="text-xs font-normal" style={{ color: '#64748B' }}>· {formatGeneratedAt(generatedAt)}</span>
          )}
        </h3>
        <Link href="/dashboard/opportunities" className="text-xs font-medium" style={{ color: '#3B82F6' }}>
          Több megtekintése →
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {topics.map(topic => {
          const thumb = topic.evidence_videos?.[0]?.thumbnail_url || null
          const demand = demandLabel(topic.score_breakdown)
          const competition = competitionLabel(topic.score_breakdown)
          return (
            <div key={topic.id} className="rounded-2xl overflow-hidden flex flex-col" style={PANEL_STYLE}>
              <div className="relative h-24 flex-shrink-0" style={{ background: thumb ? undefined : 'linear-gradient(135deg, rgba(59,130,246,0.15), rgba(139,92,246,0.1))' }}>
                {thumb ? (
                  <img src={thumb} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <i className="ti ti-bulb text-2xl" style={{ color: 'rgba(255,255,255,0.2)' }} />
                  </div>
                )}
                <div className="absolute top-2 left-2 w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ background: 'rgba(8,11,20,0.85)', color: scoreColor(topic.opportunity_score), border: `2px solid ${scoreColor(topic.opportunity_score)}` }}>
                  {topic.opportunity_score}
                </div>
              </div>
              <div className="p-3 flex-1 flex flex-col">
                <p className="text-xs font-semibold leading-snug mb-2 flex-1" style={{ color: '#F8FAFC' }}>{topic.title}</p>
                <div className="grid grid-cols-2 gap-1.5 text-xs mb-3">
                  <div>
                    <div style={{ color: '#64748B', fontSize: '10px' }}>Kereslet</div>
                    <div className="font-semibold" style={{ color: demand.color }}>{demand.label}</div>
                  </div>
                  <div>
                    <div style={{ color: '#64748B', fontSize: '10px' }}>Verseny</div>
                    <div className="font-semibold" style={{ color: competition.color }}>{competition.label}</div>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Link href={`/dashboard/opportunities?highlight=${encodeURIComponent(topic.id)}`}
                    onClick={() => sessionStorage.setItem('willviral_highlight_candidate', JSON.stringify(topic))}
                    className="flex-1 text-center text-xs py-1.5 rounded-lg"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#CBD5E1' }}>
                    Részletek
                  </Link>
                  {isProductionCandidate(topic) && (
                    <Link href={buildPackageUrl(topic)}
                      className="flex-1 text-center text-xs py-1.5 rounded-lg font-semibold"
                      style={{ background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
                      Csomag
                    </Link>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
