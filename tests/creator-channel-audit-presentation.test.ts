import { describe, expect, it } from 'vitest'
import {
  CHANNEL_AUDIT_LANE_COPY,
  deriveChannelAuditFocus,
  presentChannelAuditDimensions,
  type ChannelAuditFocusInput,
} from '@/lib/creator-channel-audit-presentation'

const ready: ChannelAuditFocusInput = {
  loading: false, loadError: false, generating: false, suggestionError: false, nicheReviewRequired: false,
  channelConnected: true, hasChannelProfile: true, hasEnoughData: true, canGenerateSuggestions: true,
  auditCount: 6, minimumAudits: 3, relevantAuditCount: 4, minimumRelevantAudits: 3, suggestionCount: 0,
}

describe('Creator channel audit presentation', () => {
  it('keeps the highest-priority safety gate visible', () => {
    expect(deriveChannelAuditFocus({ ...ready, nicheReviewRequired: true, suggestionCount: 10 }).kind).toBe('niche_review')
    expect(deriveChannelAuditFocus({ ...ready, loadError: true }).kind).toBe('load_error')
  })

  it('separates public identity from private analytics availability', () => {
    const focus = deriveChannelAuditFocus({ ...ready, channelConnected: false, hasChannelProfile: true })
    expect(focus.kind).toBe('connect')
    expect(focus.label).toBe('Publikus csatornakép')
  })

  it('reports actual audit progress without inventing a composite score', () => {
    const focus = deriveChannelAuditFocus({ ...ready, hasEnoughData: false, auditCount: 2, minimumAudits: 3 })
    expect(focus.kind).toBe('build_evidence')
    expect(focus.progressCurrent).toBe(2)
    expect(focus.progressTarget).toBe(3)
  })

  it('clamps only visual dimension values and identifies the weakest supplied key', () => {
    const dimensions = presentChannelAuditDimensions({ hook_strength: 110, retention_potential: -2, engagement_quality: 63, platform_fit: 71, packaging_quality: 68 }, 'retention_potential')
    expect(dimensions[0].value).toBe(100)
    expect(dimensions[1]).toMatchObject({ value: 0, isWeakest: true })
  })

  it('frames the same data differently for the two creator lanes', () => {
    expect(CHANNEL_AUDIT_LANE_COPY.evidence.headline).not.toBe(CHANNEL_AUDIT_LANE_COPY.entertainment.headline)
    expect(CHANNEL_AUDIT_LANE_COPY.evidence.lens).toContain('Bizonyítékvezérelt')
    expect(CHANNEL_AUDIT_LANE_COPY.entertainment.lens).toContain('Élményvezérelt')
  })
})
