// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, feature
// flag unit tests. Confirms the default-false, fail-closed contract exactly.
import { afterEach, describe, expect, it } from 'vitest'

const ENV_KEY = 'SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED'
const originalValue = process.env[ENV_KEY]

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalValue
})

async function freshFlagModule() {
  vi_resetModules()
  return import('@/lib/semantic-topic/human-review-flag')
}
// vitest's vi.resetModules must be imported directly -- kept as a tiny
// indirection so the import block above stays readable.
import { vi } from 'vitest'
function vi_resetModules() {
  vi.resetModules()
}

describe('isHumanReviewEnabled', () => {
  it('defaults to false when the env var is unset', async () => {
    delete process.env[ENV_KEY]
    const { isHumanReviewEnabled } = await freshFlagModule()
    expect(isHumanReviewEnabled()).toBe(false)
  })

  it('is false for any value other than the exact literal string "true"', async () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'enabled', ' true', 'true ', '']) {
      process.env[ENV_KEY] = value
      const { isHumanReviewEnabled } = await freshFlagModule()
      expect(isHumanReviewEnabled(), `value=${JSON.stringify(value)}`).toBe(false)
    }
  })

  it('is true only for the exact literal string "true"', async () => {
    process.env[ENV_KEY] = 'true'
    const { isHumanReviewEnabled } = await freshFlagModule()
    expect(isHumanReviewEnabled()).toBe(true)
  })
})
