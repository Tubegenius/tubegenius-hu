'use client'

import Link from 'next/link'
import { CheckCircle2, Circle } from 'lucide-react'
import type { CreatorProfile } from '@/types'
import { isNicheReviewRequired } from '@/lib/channel-scope'

interface SetupStatusPanelProps {
  profile: CreatorProfile | null
  hasPackage: boolean
}

interface SetupStep {
  key: string
  label: string
  done: boolean
  href: string
}

// A 4 lépés kizárólag már meglévő, a Command Center által amúgy is
// betöltött adatokból számolódik — nincs új API-hívás.
export default function SetupStatusPanel({ profile, hasPackage }: SetupStatusPanelProps) {
  if (!profile) return null

  const channelConnected = !!(profile.active_channel_id || profile.youtube_channel_id)
  const nicheNeedsReview = isNicheReviewRequired({
    storedReviewFlag: !!profile.niche_needs_review,
    validatedForChannelId: profile.niche_validated_for_channel_id,
    candidates: profile.detected_niche_candidates,
    activeChannelId: profile.active_channel_id,
  })
  const nicheConfirmed = !!profile.main_category && !nicheNeedsReview
  const channelAuditDone = !!profile.last_channel_audit_at

  const steps: SetupStep[] = [
    { key: 'channel', label: 'YouTube csatorna csatlakoztatva', done: channelConnected, href: '/dashboard/profile' },
    { key: 'niche', label: 'Niche megerősítve', done: nicheConfirmed, href: '/dashboard/profile' },
    { key: 'audit', label: 'Channel Audit elkészült', done: channelAuditDone, href: '/dashboard/channel-audit' },
    { key: 'package', label: 'Első videócsomag elkészült', done: hasPackage, href: '/dashboard/video-package' },
  ]

  const doneCount = steps.filter(step => step.done).length

  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between mb-3">
        <p className="section-label">Setup állapot</p>
        <span className="text-xs text-text-muted">{doneCount}/{steps.length} kész</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map(step => (
          <Link
            key={step.key}
            href={step.href}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors"
            style={{
              background: step.done ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${step.done ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.08)'}`,
            }}
          >
            {step.done ? (
              <CheckCircle2 className="w-4 h-4 text-emerald flex-shrink-0" strokeWidth={2} aria-hidden="true" />
            ) : (
              <Circle className="w-4 h-4 text-text-muted flex-shrink-0" strokeWidth={2} aria-hidden="true" />
            )}
            <span className={step.done ? 'text-text-secondary' : 'text-text-primary'}>{step.label}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
