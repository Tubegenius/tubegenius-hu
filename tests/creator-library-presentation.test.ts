import { describe, expect, it } from 'vitest'
import {
  countCreatorLibraryStages,
  presentCreatorMemory,
  presentCreatorMemoryItem,
} from '@/lib/creator-library-presentation'
import type { CreatorMemoryItem } from '@/types'

function memoryItem(overrides: Partial<CreatorMemoryItem> = {}): CreatorMemoryItem {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    topic: 'Miért marad forró a lakás éjjel is?',
    state: 'saved',
    opportunity_score: 82,
    viral_score: null,
    notes: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-08T10:00:00.000Z',
    ...overrides,
  }
}

describe('Creator library presentation', () => {
  it('derives display stages only from the existing creator_memory contract', () => {
    expect(presentCreatorMemoryItem(memoryItem(), 0).state).toBe('brief')
    expect(presentCreatorMemoryItem(memoryItem({ video_idea_id: 'idea-1' }), 1).state).toBe('draft')
    expect(presentCreatorMemoryItem(memoryItem({ state: 'in_progress' }), 2).state).toBe('active')
    expect(presentCreatorMemoryItem(memoryItem({ state: 'completed' }), 3).state).toBe('published')
    expect(presentCreatorMemoryItem(memoryItem({ state: 'rejected' }), 4).state).toBe('rejected')
  })

  it('keeps missing scores explicit instead of inventing data', () => {
    const entry = presentCreatorMemoryItem(memoryItem({ opportunity_score: null, viral_score: null }), 0)
    expect(entry.opportunityScore).toBeNull()
    expect(entry.viralScore).toBeNull()
    expect(entry.stageIndex).toBe('01')
  })

  it('counts the normalized creator workflow states', () => {
    const entries = presentCreatorMemory([
      memoryItem(),
      memoryItem({ id: 'memory-2', video_idea_id: 'idea-1' }),
      memoryItem({ id: 'memory-3', state: 'in_progress' }),
      memoryItem({ id: 'memory-4', state: 'completed' }),
    ])
    expect(countCreatorLibraryStages(entries)).toEqual({ brief: 1, draft: 1, active: 1, published: 1, rejected: 0 })
  })
})
