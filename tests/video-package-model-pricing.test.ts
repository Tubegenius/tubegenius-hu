// A naplózott AI-költségbecslés (ai_usage_logs.estimated_cost_usd, paid_results.estimated_cost)
// árlistája. A Haiku 4.5 sor korábban a Haiku 3.5 árát ($0.25 / $1.25) hordozta: a valós ár
// $1 / $5 per MTok (Anthropic Pricing, 2026-10-22), vagyis a becslés negyedannyi volt.
// KIZÁRÓLAG naplózott becslés — a kredit-termékár (6 / 2) és a levonás nem függ tőle.
//
// A "megfigyelt futás" számai az egyetlen valódi staging Video Package hívásból (2026-10-22,
// 21:54–21:56 UTC) származnak: core Sonnet 4.6 = 2291 in / 5463 out, csomagolás Haiku 4.5 =
// 1602 in / 2764 out (ai_usage_logs sorok).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const state = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; row: any }> }))

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    from: (table: string) => ({
      insert: async (row: any) => { state.inserts.push({ table, row }); return { error: null } },
    }),
  })),
}))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ getAll: () => [], set: () => {} })) }))

import { CREDIT_COSTS, estimateCost, logUsage } from '@/lib/credits'
import { MODELS } from '@/lib/models'

const OBSERVED = {
  core: { model: MODELS.primary, inputTokens: 2291, outputTokens: 5463 },
  packaging: { model: MODELS.fast, inputTokens: 1602, outputTokens: 2764 },
}

describe('estimateCost -- Anthropic list prices (USD per 1M tokens)', () => {
  it('Haiku 4.5 is $1 input / $5 output', () => {
    expect(estimateCost(MODELS.fast, 1_000_000, 0)).toBe(1)
    expect(estimateCost(MODELS.fast, 0, 1_000_000)).toBe(5)
  })

  it('Sonnet 4.6 stays $3 input / $15 output (unchanged)', () => {
    expect(estimateCost(MODELS.primary, 1_000_000, 0)).toBe(3)
    expect(estimateCost(MODELS.primary, 0, 1_000_000)).toBe(15)
  })

  it('an unknown model still falls back to the primary (Sonnet) price (unchanged behaviour)', () => {
    expect(estimateCost('some-unknown-model', 1_000_000, 1_000_000)).toBe(18)
  })

  it('the model ids in the table are the ones the app actually calls', () => {
    expect(MODELS.primary).toBe('claude-sonnet-4-6')
    expect(MODELS.fast).toBe('claude-haiku-4-5-20251001')
  })
})

describe('the observed staging run: logged estimates before vs after the price fix', () => {
  const OLD_HAIKU = { input: 0.25, output: 1.25 }
  const oldHaikuEstimate = (i: number, o: number) => (i / 1_000_000) * OLD_HAIKU.input + (o / 1_000_000) * OLD_HAIKU.output

  it('core (Sonnet) is unchanged: 0.088818', () => {
    expect(estimateCost(OBSERVED.core.model, OBSERVED.core.inputTokens, OBSERVED.core.outputTokens)).toBeCloseTo(0.088818, 6)
  })

  it('packaging (Haiku) is now 0.015422; the old table gave 0.003855 -- exactly one quarter', () => {
    const now = estimateCost(OBSERVED.packaging.model, OBSERVED.packaging.inputTokens, OBSERVED.packaging.outputTokens)
    const before = oldHaikuEstimate(OBSERVED.packaging.inputTokens, OBSERVED.packaging.outputTokens)
    expect(now).toBeCloseTo(0.015422, 6)
    expect(before).toBeCloseTo(0.003855, 6)
    expect(now / before).toBeCloseTo(4, 9)
  })

  it('the paid_results.estimated_cost sum (core + packaging) moves from 0.092674 to 0.104240; the real total is ~$0.104', () => {
    const sumNow = estimateCost(OBSERVED.core.model, OBSERVED.core.inputTokens, OBSERVED.core.outputTokens)
      + estimateCost(OBSERVED.packaging.model, OBSERVED.packaging.inputTokens, OBSERVED.packaging.outputTokens)
    const sumBefore = estimateCost(OBSERVED.core.model, OBSERVED.core.inputTokens, OBSERVED.core.outputTokens)
      + oldHaikuEstimate(OBSERVED.packaging.inputTokens, OBSERVED.packaging.outputTokens)
    expect(sumBefore).toBeCloseTo(0.0926735, 6)
    expect(sumNow).toBeCloseTo(0.10424, 6)
  })
})

describe('logUsage writes the corrected estimate and never a credit charge', () => {
  beforeEach(() => { state.inserts.length = 0 })

  it('packaging telemetry row: estimated_cost_usd = 0.015422, credits_charged = 0', async () => {
    await logUsage('user-1', 'video_package_long', MODELS.fast, 1602, 2764, { sub_step: 'packaging' })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].table).toBe('ai_usage_logs')
    expect(state.inserts[0].row.estimated_cost_usd).toBeCloseTo(0.015422, 6)
    expect(state.inserts[0].row.credits_charged).toBe(0)
    expect(state.inserts[0].row.model).toBe(MODELS.fast)
  })

  it('core telemetry row is unchanged: estimated_cost_usd = 0.088818', async () => {
    await logUsage('user-1', 'video_package_long', MODELS.primary, 2291, 5463, { sub_step: 'core' })
    expect(state.inserts[0].row.estimated_cost_usd).toBeCloseTo(0.088818, 6)
  })
})

describe('the product price (credits) does not depend on the cost estimate', () => {
  it('Video Package prices are unchanged: long = 6, shorts = 2', () => {
    expect(CREDIT_COSTS.video_package_long).toBe(6)
    expect(CREDIT_COSTS.video_package_shorts).toBe(2)
  })

  it('chargeFeature takes the cost from CREDIT_COSTS and never calls estimateCost', () => {
    const src = readFileSync(path.resolve(__dirname, '..', 'lib', 'credits.ts'), 'utf8').replace(/\r\n/g, '\n')
    const start = src.indexOf('export async function chargeFeature(')
    expect(start).toBeGreaterThan(0)
    const end = src.indexOf('\nexport ', start + 10)
    const body = src.slice(start, end > 0 ? end : undefined)
    expect(body).toMatch(/const cost = CREDIT_COSTS\[feature\]/)
    expect(body).not.toMatch(/estimateCost\(/)
  })
})

describe('lib/credits.ts documents the CURRENT prices (the stale header note is gone)', () => {
  const src = readFileSync(path.resolve(__dirname, '..', 'lib', 'credits.ts'), 'utf8').replace(/\r\n/g, '\n')
  const header = src.slice(0, src.indexOf("import { createServerClient }"))

  it('the file header states Sonnet $3/$15 and Haiku $1/$5 and no longer the old Haiku 3.5 figures or the ~12x claim', () => {
    expect(header).toContain('Sonnet 4.6: $3 input / $15 output')
    expect(header).toContain('Haiku 4.5:  $1 input / $5 output')
    expect(header).not.toContain('0.25')
    expect(header).not.toContain('1.25')
    expect(header).not.toContain('12x')
  })

  it('the header agrees with the price table the code actually uses', () => {
    expect(estimateCost(MODELS.primary, 1_000_000, 0)).toBe(3)
    expect(estimateCost(MODELS.primary, 0, 1_000_000)).toBe(15)
    expect(estimateCost(MODELS.fast, 1_000_000, 0)).toBe(1)
    expect(estimateCost(MODELS.fast, 0, 1_000_000)).toBe(5)
  })
})
