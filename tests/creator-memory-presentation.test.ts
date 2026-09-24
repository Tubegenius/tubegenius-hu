import { describe, expect, it } from 'vitest'
import {
  countCreatorMemoryStates,
  CREATOR_MEMORY_LANE_COPY,
  filterCreatorMemory,
  totalProofSignals,
} from '@/lib/creator-memory-presentation'
import type { CreatorMemoryItem } from '@/types'

function memoryItem(overrides: Partial<CreatorMemoryItem> = {}): CreatorMemoryItem {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    topic: 'Miért marad forró a lakás éjjel is?',
    search_keyword: 'városi hősziget',
    platform: 'youtube_long',
    state: 'saved',
    opportunity_score: 82,
    viral_score: null,
    notes: 'Nyitókép: a város hőtérképe',
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-08T10:00:00.000Z',
    ...overrides,
  }
}

describe('Creator memory presentation', () => {
  it('searches only the existing read-only memory fields', () => {
    const items = [
      memoryItem(),
      memoryItem({ id: 'memory-2', topic: 'Három ritmusváltás egy rövid videóban', search_keyword: 'shorts pacing', platform: 'youtube_shorts', notes: null }),
    ]

    expect(filterCreatorMemory(items, 'all', 'hősziget')).toHaveLength(1)
    expect(filterCreatorMemory(items, 'all', 'shorts')).toHaveLength(1)
    expect(filterCreatorMemory(items, 'all', 'hőtérképe')).toHaveLength(1)
  })

  it('combines state and text filters without changing the underlying records', () => {
    const items = [
      memoryItem(),
      memoryItem({ id: 'memory-2', state: 'completed', topic: 'Publikált hősziget-videó' }),
    ]

    const result = filterCreatorMemory(items, 'completed', 'hősziget')
    expect(result.map(item => item.id)).toEqual(['memory-2'])
    expect(items[1].state).toBe('completed')
  })

  it('counts real states and proof summaries without filling missing data', () => {
    const items = [
      memoryItem(),
      memoryItem({ id: 'memory-2', state: 'in_progress' }),
      memoryItem({ id: 'memory-3', state: 'completed' }),
    ]
    expect(countCreatorMemoryStates(items)).toEqual({ all: 3, saved: 1, in_progress: 1, completed: 1, rejected: 0 })
    expect(totalProofSignals([
      { ...items[0], proof_signals: { strong: 2, medium: 1, weak: 0, rejected: 1 } },
      items[1],
    ])).toBe(4)
  })

  it('keeps the two creator lanes as different viewing contexts, not claimed data filters', () => {
    expect(CREATOR_MEMORY_LANE_COPY.evidence.lens).toContain('Bizonyítékvezérelt')
    expect(CREATOR_MEMORY_LANE_COPY.entertainment.lens).toContain('Élményvezérelt')
    expect(CREATOR_MEMORY_LANE_COPY.evidence.lead).not.toBe(CREATOR_MEMORY_LANE_COPY.entertainment.lead)
  })
})
