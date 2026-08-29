// decisions_digest_v2 -- pure unit tests (no DB, no network).
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeDecisionsDigestV2, DECISIONS_DIGEST_VERSION, type DecisionDigestRow } from '@/lib/semantic-topic/decisions-digest'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('computeDecisionsDigestV2', () => {
  it('has version v2', () => {
    expect(DECISIONS_DIGEST_VERSION).toBe('v2')
  })

  it('empty input produces a stable, well-defined digest (not NULL, not an error)', () => {
    expect(computeDecisionsDigestV2([])).toBe(`v2:0:${EMPTY_SHA256}`)
  })

  it('single-row digest matches the documented formula exactly', () => {
    const row: DecisionDigestRow = { id: 'a8e5a787-0000-0000-0000-000000000001', extractionRunId: 'bd4b2cc7-0000-0000-0000-000000000001', outcome: 'QUARANTINE', decisionDigest: 'aa'.repeat(32) }
    const expectedBody = `${row.id}|${row.extractionRunId}|${row.outcome}|${row.decisionDigest}`
    const expectedHash = createHash('sha256').update(expectedBody, 'utf8').digest('hex')
    expect(computeDecisionsDigestV2([row])).toBe(`v2:1:${expectedHash}`)
  })

  it('row count is embedded in the output string', () => {
    const rows: DecisionDigestRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`,
      extractionRunId: `10000000-0000-0000-0000-00000000000${i}`,
      outcome: 'QUARANTINE',
      decisionDigest: 'bb'.repeat(32),
    }))
    expect(computeDecisionsDigestV2(rows)).toMatch(/^v2:5:[0-9a-f]{64}$/)
  })

  it('is invariant to INPUT array order -- always internally sorted by id before hashing', () => {
    const rowA: DecisionDigestRow = { id: 'aaaaaaaa-0000-0000-0000-000000000000', extractionRunId: 'x', outcome: 'QUARANTINE', decisionDigest: 'aa'.repeat(32) }
    const rowB: DecisionDigestRow = { id: 'bbbbbbbb-0000-0000-0000-000000000000', extractionRunId: 'y', outcome: 'CREATE_NEW', decisionDigest: 'bb'.repeat(32) }
    expect(computeDecisionsDigestV2([rowA, rowB])).toBe(computeDecisionsDigestV2([rowB, rowA]))
  })

  it('orders by id, NOT by any other field -- reordering created_at-like metadata (not part of the formula at all) never appears', () => {
    // The formula has no created_at field -- this test documents that fact
    // by construction: two rows differing only in id order produce
    // different digests even with identical outcome/decisionDigest values.
    const base = { outcome: 'QUARANTINE', decisionDigest: 'cc'.repeat(32) }
    const rows1: DecisionDigestRow[] = [
      { id: '11111111-0000-0000-0000-000000000000', extractionRunId: 'r1', ...base },
      { id: '22222222-0000-0000-0000-000000000000', extractionRunId: 'r2', ...base },
    ]
    const rows2: DecisionDigestRow[] = [
      { id: '22222222-0000-0000-0000-000000000000', extractionRunId: 'r1', ...base },
      { id: '11111111-0000-0000-0000-000000000000', extractionRunId: 'r2', ...base },
    ]
    expect(computeDecisionsDigestV2(rows1)).not.toBe(computeDecisionsDigestV2(rows2))
  })

  it('never mutates the input array', () => {
    const rows: DecisionDigestRow[] = [
      { id: 'bbbbbbbb-0000-0000-0000-000000000000', extractionRunId: 'y', outcome: 'CREATE_NEW', decisionDigest: 'bb'.repeat(32) },
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', extractionRunId: 'x', outcome: 'QUARANTINE', decisionDigest: 'aa'.repeat(32) },
    ]
    const snapshot = JSON.stringify(rows)
    computeDecisionsDigestV2(rows)
    expect(JSON.stringify(rows)).toBe(snapshot)
  })

  it('a different outcome or decisionDigest value changes the result (no field is silently ignored)', () => {
    const base: DecisionDigestRow = { id: '11111111-0000-0000-0000-000000000000', extractionRunId: 'r1', outcome: 'QUARANTINE', decisionDigest: 'aa'.repeat(32) }
    const changedOutcome = computeDecisionsDigestV2([{ ...base, outcome: 'CREATE_NEW' }])
    const changedDigest = computeDecisionsDigestV2([{ ...base, decisionDigest: 'ff'.repeat(32) }])
    const original = computeDecisionsDigestV2([base])
    expect(changedOutcome).not.toBe(original)
    expect(changedDigest).not.toBe(original)
  })
})
