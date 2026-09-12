import { describe, expect, it } from 'vitest'
import {
  presentVideoAuditDecision,
  presentVideoAuditScore,
  videoAuditFormReadiness,
  videoAuditScoreTone,
  VIDEO_AUDIT_LANE_COPY,
} from '@/lib/creator-video-audit-presentation'

describe('Creator video audit presentation', () => {
  it('does not allow an incomplete manual audit to appear ready', () => {
    expect(videoAuditFormReadiness({ platform: 'tiktok', videoUrl: '', topic: 'Fókusz', title: '', durationSeconds: 45 }).ready).toBe(false)
    expect(videoAuditFormReadiness({ platform: 'tiktok', videoUrl: '', topic: 'Fókusz', title: 'Egy hét értesítések nélkül', durationSeconds: 45 }).ready).toBe(true)
  })

  it('keeps URL and manual input readiness separate', () => {
    expect(videoAuditFormReadiness({ platform: 'youtube_long', videoUrl: 'https://youtube.com/watch?v=test', topic: '', title: '', durationSeconds: 0 }).ready).toBe(true)
    expect(videoAuditFormReadiness({ platform: 'youtube_long', videoUrl: ' ', topic: 'Nem számít', title: 'Nem számít', durationSeconds: 60 }).ready).toBe(false)
  })

  it('clamps score only for presentation', () => {
    expect(presentVideoAuditScore(118)).toBe(100)
    expect(presentVideoAuditScore(-4)).toBe(0)
    expect(presentVideoAuditScore(Number.NaN)).toBe(0)
  })

  it('maps score tones consistently', () => {
    expect(videoAuditScoreTone(75)).toBe('strong')
    expect(videoAuditScoreTone(60)).toBe('developing')
    expect(videoAuditScoreTone(59)).toBe('critical')
  })

  it('preserves a supplied backend decision and evidence reason', () => {
    const presented = presentVideoAuditDecision({ decision: 'Rehook', weakestDimension: 'Hook erőssége', reason: 'A nyitás túl lassú.' })
    expect(presented.decision).toBe('Rehook')
    expect(presented.weakest).toBe('Hook erőssége')
    expect(presented.reason).toBe('A nyitás túl lassú.')
  })

  it('frames the result differently without claiming different scoring', () => {
    expect(VIDEO_AUDIT_LANE_COPY.evidence.headline).not.toBe(VIDEO_AUDIT_LANE_COPY.entertainment.headline)
    expect(VIDEO_AUDIT_LANE_COPY.evidence.support).toContain('pontozását nem írja át')
    expect(VIDEO_AUDIT_LANE_COPY.entertainment.support).toContain('pontozását nem írja át')
  })
})
