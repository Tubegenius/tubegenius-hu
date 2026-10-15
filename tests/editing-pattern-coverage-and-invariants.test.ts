// Editing Pattern Engine 1B (algorithm v2): time-based coverage and the structural invariants.
//   * `complete` means >= 95 % of the TIME is covered; `covers_full_duration` is stricter: hole-free and the
//     last shot reaches the declared duration;
//   * frames squeezed into part of the video cannot look complete;
//   * a frame outside [0, duration) is invalid input, an equal timestamp is `timestamp_not_increasing`;
//   * no result with metrics may break the structural invariants (also checked as a property).
import { describe, expect, it } from 'vitest'
import { analyzeEditingPattern, emittedCoverageRatio } from '@/lib/editing-pattern/analyzer'
import { EDITING_ALGORITHM_VERSION, type EditingAnalysisResult, type FrameSignature } from '@/lib/editing-pattern/contract'
import { checkEditingResultInvariants } from '@/lib/editing-pattern/invariants'
import {
  FixtureFrameSource,
  buildFixture,
  fastMontage,
  independentCoveredMs,
  inputFor,
  mulberry32,
  sceneBase,
  slowTalkingHead,
  steadyPacing,
  type Fixture,
  type FixtureSpec,
} from './support/editing-pattern-fixtures'

async function analyze(frames: FrameSignature[], fixture: Fixture, over: Record<string, unknown> = {}) {
  const source = new FixtureFrameSource({ vid: frames })
  const result = await analyzeEditingPattern(inputFor(fixture, 'vid', over), source)
  return { result, source }
}

const slowSpec = (extra: Partial<FixtureSpec> = {}): FixtureSpec => ({
  shots: [14_000, 9_000, 12_000, 8_000, 10_000, 7_000].map((d, i) => ({ duration_ms: d, scene: i })),
  sample_interval_ms: 250,
  noise: 0.08,
  seed: 11,
  ...extra,
})

/** independent expectation of the emitted ratio: the exact ratio TRUNCATED to 3 decimals (never rounded up) */
const floor3 = (covered: number, duration: number) => Math.floor((covered * 1000) / duration) / 1000

/** nominal frames repeated on a finer time grid (strictly increasing, much denser than declared) */
function densify(f: Fixture, stepMs: number): FrameSignature[] {
  const out: FrameSignature[] = []
  for (let t = 0; t < f.duration_ms; t += stepMs) {
    const nominal = f.frames[Math.min(f.frames.length - 1, Math.floor(t / f.sample_interval_ms))]
    out.push({ t_ms: t, bins: nominal.bins.slice() })
  }
  return out
}

describe('algorithm version', () => {
  it('the coverage change is a new algorithm version, so results of the old definition are never reused', async () => {
    expect(EDITING_ALGORITHM_VERSION).toBe('hist-delta-hard-cut.v2')
    const f = slowTalkingHead()
    expect((await analyze(f.frames, f)).result.algorithm_version).toBe('hist-delta-hard-cut.v2')
  })
})

describe('coverage is measured in TIME, not in frame count', () => {
  const sixty = () => buildFixture({ shots: new Array<number>(12).fill(5_000).map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 250, noise: 0.05, seed: 2 })

  it('240 frames squeezed into the first half of a 60 s video are PARTIAL, never complete or full-duration', async () => {
    const f = sixty()
    const squeezed = f.frames.slice(0, 240).map((fr, i) => ({ ...fr, t_ms: i * 125 }))
    const { result } = await analyze(squeezed, f)
    expect(result.status).toBe('partial')
    expect(result.coverage!.sampled_frames).toBe(240)
    expect(result.coverage!.coverage_ratio).toBe(floor3(30_125, 60_000))
    expect(result.coverage!.gaps).toEqual([{ start_ms: 30_125, end_ms: 60_000 }])
    expect(result.metrics!.scope).toEqual({ from_ms: 0, to_ms: 30_125, covers_full_duration: false })
    expect(result.warnings).toContain('data_gaps_present')
    // the cut density is per COVERED minute: 11 cuts in 30.125 s, not in 60 s
    expect(result.metrics!.cut_density_per_min).toBeCloseTo(11 / (30_125 / 60_000), 2)
    expect(checkEditingResultInvariants(result)).toEqual([])
  })

  it('240 frames within the first 240 ms are insufficient_data (coverage below the minimum)', async () => {
    const f = sixty()
    const squeezed = f.frames.slice(0, 240).map((fr, i) => ({ ...fr, t_ms: i }))
    const { result } = await analyze(squeezed, f)
    expect(result).toMatchObject({ status: 'insufficient_data', reason_code: 'coverage_below_minimum', metrics: null })
    expect(result.coverage!.coverage_ratio).toBeLessThan(0.02)
  })

  it('strictly increasing but far too dense timestamps over the WHOLE video are accepted, covered once, and flagged', async () => {
    const f = slowTalkingHead() // 60 s, nominal 250 ms
    const dense = densify(f, 15) // 4 000 frames
    expect(dense).toHaveLength(4_000)
    const { result } = await analyze(dense, f)
    expect(result.status).toBe('complete')
    expect(result.metrics!.scope.covers_full_duration).toBe(true)
    expect(result.warnings).toContain('sampling_denser_than_declared')
    expect(result.cost!.units_consumed).toBeGreaterThan(result.cost!.units_estimated)
    // the content is unchanged, only the grid is finer: each cut lands on the first grid point at or after the truth
    expect(result.cuts).toHaveLength(f.cuts_ms.length)
    result.cuts.forEach((c, i) => {
      expect(c.t_ms - f.cuts_ms[i]).toBeGreaterThanOrEqual(0)
      expect(c.t_ms - f.cuts_ms[i]).toBeLessThan(15)
    })
    expect(checkEditingResultInvariants(result)).toEqual([])
  })

  it('dense frames do not count twice: a dense burst plus a long hole is still mostly uncovered', async () => {
    const f = slowTalkingHead()
    const frames = [...densify(f, 5).filter((fr) => fr.t_ms < 10_000)] // 2 000 frames in the first 10 s
    const { result } = await analyze(frames, f)
    expect(result).toMatchObject({ status: 'insufficient_data', reason_code: 'coverage_below_minimum' })
    expect(result.coverage!.coverage_ratio).toBeCloseTo((10_000 + 250 - 5) / 60_000, 1)
  })

  it('the runtime compute budget stops a source that delivers far more signature data than declared', async () => {
    const f = slowTalkingHead() // declared estimate: 240 x 32 = 7 680 units
    const { result, source } = await analyze(densify(f, 15), f, { limits: { max_compute_units: 20_000 } })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'compute_budget', metrics: null })
    expect(source.framesYielded).toBeLessThanOrEqual(626)
  })

  it('an EQUAL timestamp is still a timestamp_not_increasing failure (not a coverage question)', async () => {
    const f = slowTalkingHead()
    const frames = f.frames.map((fr, i) => (i === 1 ? { ...fr, t_ms: 0 } : fr))
    const { result } = await analyze(frames, f)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'invalid_frame_data', issues: [{ path: 'frames[1]', code: 'timestamp_not_increasing' }] })
  })

  it('a timestamp that goes BACKWARDS is the same failure', async () => {
    const f = slowTalkingHead()
    const frames = f.frames.map((fr, i) => (i === 7 ? { ...fr, t_ms: f.frames[5].t_ms } : fr))
    expect((await analyze(frames, f)).result.issues).toEqual([{ path: 'frames[7]', code: 'timestamp_not_increasing' }])
  })
})

describe('covers_full_duration is true only for a hole-free, complete analysis', () => {
  it('an intact video covers the full duration', async () => {
    const intact = buildFixture(slowSpec())
    const { result } = await analyze(intact.frames, intact)
    expect(result.coverage).toMatchObject({ covered_ms: 60_000, uncovered_ms: 0, coverage_ratio: 1 })
    expect(result.metrics!.scope).toMatchObject({ covers_full_duration: true, to_ms: 60_000 })
  })

  it('timestamp jitter leaves a few uncovered milliseconds: they are REPORTED exactly, and the video is complete but NOT full-duration', async () => {
    const jittered = buildFixture(slowSpec({ jitter_ms: 10 }))
    const { result } = await analyze(jittered.frames, jittered)
    const expected = independentCoveredMs(jittered.frames.map((f) => f.t_ms), 250, 60_000)
    expect(expected).toBeLessThan(60_000)
    expect(result.coverage!.covered_ms).toBe(expected)
    expect(result.coverage!.uncovered_ms).toBe(60_000 - expected)
    expect(result.coverage!.coverage_ratio).toBe(floor3(expected, 60_000))
    expect(result.coverage!.coverage_ratio).toBeLessThan(1)
    expect(result.status).toBe('complete')
    expect(result.metrics!.scope.covers_full_duration).toBe(false)
  })
  it.each([
    ['one dropped sample (a 250 ms hole)', [{ from_ms: 30_000, to_ms: 30_250 }], 'complete'],
    ['a 4 % hole in the middle', [{ from_ms: 10_000, to_ms: 12_400 }], 'complete'],
    ['exactly 5 % missing', [{ from_ms: 10_000, to_ms: 13_000 }], 'complete'],
    ['a leading hole', [{ from_ms: 0, to_ms: 1_000 }], 'complete'],
    ['a trailing hole', [{ from_ms: 59_000, to_ms: 60_000 }], 'complete'],
    ['5.2 % missing', [{ from_ms: 10_000, to_ms: 13_120 }], 'partial'],
  ])('%s: coverage >= 95 % may still be complete, but never covers the full duration', async (_name, drop, expectedStatus) => {
    const f = buildFixture(slowSpec({ drop_ranges: drop }))
    const { result } = await analyze(f.frames, f)
    expect(result.status).toBe(expectedStatus)
    expect(result.coverage!.gaps.length).toBeGreaterThan(0)
    expect(result.metrics!.scope.covers_full_duration).toBe(false)
    expect(result.warnings).toContain('data_gaps_present')
    expect(checkEditingResultInvariants(result)).toEqual([])
  })

  it('a trailing hole ends the scope where the data ends', async () => {
    const f = buildFixture(slowSpec({ drop_ranges: [{ from_ms: 59_000, to_ms: 60_000 }] }))
    const { result } = await analyze(f.frames, f)
    expect(result.metrics!.scope.to_ms).toBe(59_000)
    expect(result.shots[result.shots.length - 1].end_ms).toBe(59_000)
  })
})

describe('the exact union of the sample intervals is the basis (regression: sub-tolerance gaps add up)', () => {
  const sixty = () => buildFixture(slowSpec())

  it('161 frames at 0, 374, 748 ... 59 840 ms (124 ms uncovered between neighbours, below the 125 ms listing tolerance) cover about two thirds', async () => {
    const f = sixty()
    const frames = densify(f, 374)
    expect(frames).toHaveLength(161)
    expect(frames[160].t_ms).toBe(59_840)
    const expected = independentCoveredMs(frames.map((x) => x.t_ms), 250, 60_000)
    expect(expected).toBe(160 * 250 + 160) // 160 full intervals and the last one clipped at 60 000
    const { result } = await analyze(frames, f)
    expect(result.coverage!.covered_ms).toBe(40_160)
    expect(result.coverage!.uncovered_ms).toBe(19_840)
    expect(result.coverage!.coverage_ratio).toBe(floor3(40_160, 60_000))
    // none of the 124 ms spans is long enough to be LISTED, yet they all count as uncovered time
    expect(result.coverage!.gaps).toEqual([])
    expect(result.coverage!.gap_total_ms).toBe(0)
    expect(result.status).toBe('partial')
    expect(result.metrics!.scope.covers_full_duration).toBe(false)
    expect(result.warnings).toContain('uncovered_time_below_gap_tolerance')
    expect(result.limitations).toContain('partial_coverage_metrics_describe_the_covered_part_only')
    // the cut-density denominator is the covered time, not the declared 60 s
    expect(result.metrics!.cut_density_per_min).toBeCloseTo(result.cuts.length / (40_160 / 60_000), 2)
    expect(checkEditingResultInvariants(result)).toEqual([])
  })

  it.each([262, 275, 300, 340, 374, 400, 480])('spacing %i ms against a declared 250 ms: the covered time is the exact union, listed or not', async (step) => {
    const f = sixty()
    const frames = densify(f, step)
    const expected = independentCoveredMs(frames.map((x) => x.t_ms), 250, 60_000)
    const { result } = await analyze(frames, f)
    expect(result.coverage!.covered_ms).toBe(expected)
    expect(result.coverage!.uncovered_ms).toBe(60_000 - expected)
    expect(result.coverage!.coverage_ratio).toBe(floor3(expected, 60_000))
    expect(result.metrics?.scope.covers_full_duration ?? false).toBe(false)
    const tolerance = 125
    if (step - 250 <= tolerance) expect(result.coverage!.gaps).toEqual([])
    else expect(result.coverage!.gaps.length).toBeGreaterThan(0)
    expect(result.coverage!.gap_total_ms).toBeLessThanOrEqual(result.coverage!.uncovered_ms)
    if (step - 250 > tolerance) {
      // every 150+ ms hole is LISTED, so every long shot spans a gap: no gap-free shot is left to measure.
      // The honest answer is no metrics, while the exact covered time is still reported above.
      expect(result.status).toBe('insufficient_data')
      expect(result.reason_code).toBe('no_gap_free_shots')
      expect(result.metrics).toBeNull()
    } else if (expected / 60_000 >= 0.95) expect(result.status).toBe('complete')
    else expect(result.status).toBe('partial')
  })

  it('many small gaps add up: 262 ms spacing (12 ms uncovered each, 4.6 % of the time) is complete but no longer 100 %', async () => {
    const f = sixty()
    const { result } = await analyze(densify(f, 262), f)
    expect(result.status).toBe('complete')
    expect(result.coverage!.coverage_ratio).toBeLessThan(0.96)
    expect(result.coverage!.coverage_ratio).toBeGreaterThan(0.94)
    expect(result.coverage!.uncovered_ms).toBeGreaterThan(2_500)
    expect(result.metrics!.scope.covers_full_duration).toBe(false)
  })

  it('a pacing window with less than half of its time covered is flagged partial_window; fully covered ones are not', async () => {
    const f = buildFixture(slowSpec({ drop_ranges: [{ from_ms: 1_000, to_ms: 8_000 }] }))
    const { result } = await analyze(f.frames, f)
    const windows = result.metrics!.pacing.windows
    const ts = f.frames.map((x) => x.t_ms)
    expect(windows[0].start_ms).toBe(0)
    expect(independentCoveredMs(ts.filter((t) => t < 10_000), 250, 10_000)).toBe(3_000)
    expect(windows[0].partial_window).toBe(true)
    expect(windows.slice(1).every((w) => w.partial_window === false)).toBe(true)
  })

  it('the per-window and per-third coverage use the same exact union', async () => {
    const f = sixty()
    // 400 ms spacing in the first half only; the second half is sampled normally
    const frames = [...densify(f, 400).filter((x) => x.t_ms < 30_000), ...f.frames.filter((x) => x.t_ms >= 30_000)]
    const { result } = await analyze(frames, f)
    const expected = independentCoveredMs(frames.map((x) => x.t_ms), 250, 60_000)
    expect(result.coverage!.covered_ms).toBe(expected)
    expect(expected).toBeLessThan(60_000 - 8_000) // the first half is 62.5 % covered
    // an independent per-window figure: windows of 10 s in the first half are NOT fully covered
    for (const w of result.metrics!.pacing.windows) {
      const ts = frames.map((x) => x.t_ms)
      const inWindow = independentCoveredMs(ts.filter((t) => t < w.end_ms), 250, w.end_ms) - independentCoveredMs(ts.filter((t) => t < w.start_ms), 250, w.start_ms)
      if (w.end_ms <= 30_000) expect(inWindow).toBeLessThan(w.end_ms - w.start_ms)
    }
  })
})

describe('the emitted coverage_ratio can never round across a status threshold', () => {
  // 60 000 ms video, 250 ms interval. The first N frames cover [0, 250 * N); the last frame can be moved back by
  // some ms so that it overlaps its neighbour and the exact union loses those ms.
  const base = () => buildFixture(slowSpec())
  function framesCovering(f: Fixture, coveredMs: number): FrameSignature[] {
    const full = Math.floor(coveredMs / 250)
    const out = f.frames.slice(0, full).map((x) => ({ t_ms: x.t_ms, bins: x.bins.slice() }))
    const rest = coveredMs - full * 250
    if (rest > 0) out.push({ t_ms: full * 250 - (250 - rest), bins: f.frames[full].bins.slice() })
    return out
  }
  const withDuration = (f: Fixture, durationMs: number): Fixture => ({ ...f, duration_ms: durationMs })

  it('the helper truncates: 94.998 % is 0.949, and exactly 95 % stays 0.95', () => {
    expect(emittedCoverageRatio(56_999, 60_000)).toBe(0.949)
    expect(emittedCoverageRatio(57_000, 60_000)).toBe(0.95)
    expect(emittedCoverageRatio(57_000, 60_001)).toBe(0.949) // 94.99992 %: round-to-3 would say 0.950
    expect(emittedCoverageRatio(57_001, 60_001)).toBe(0.95)
    expect(emittedCoverageRatio(30_000, 60_000)).toBe(0.5)
    expect(emittedCoverageRatio(29_999, 60_000)).toBe(0.499)
    expect(emittedCoverageRatio(60_000, 60_000)).toBe(1)
    expect(emittedCoverageRatio(0, 60_000)).toBe(0)
  })

  it('property: the emitted ratio is never above the exact one, less than 0.001 below it, and orders the same as the thresholds', () => {
    const rng = mulberry32(95)
    for (let n = 0; n < 5_000; n += 1) {
      const duration = 2_000 + Math.floor(rng() * 1_000_000)
      const covered = Math.floor(rng() * (duration + 1))
      const exact = covered / duration
      const emitted = emittedCoverageRatio(covered, duration)
      expect(emitted).toBeLessThanOrEqual(exact + 1e-12)
      expect(exact - emitted).toBeLessThan(0.001 + 1e-9)
      if (exact < 0.95) expect(emitted).toBeLessThan(0.95)
      if (exact >= 0.95) expect(emitted).toBeGreaterThanOrEqual(0.95)
      if (exact < 0.5) expect(emitted).toBeLessThan(0.5)
    }
  })

  it.each([
    // [label, duration, covered, status, emitted ratio]
    ['just below 95 % (56 999 / 60 000 = 94.9983 %)', 60_000, 56_999, 'partial', 0.949],
    ['exactly 95 % (57 000 / 60 000)', 60_000, 57_000, 'complete', 0.95],
    ['above 95 % (57 250 / 60 000 = 95.42 %)', 60_000, 57_250, 'complete', 0.954],
    ['94.99992 % of 60 001 ms: would round to 0.950 but is NOT complete', 60_001, 57_000, 'partial', 0.949],
  ] as const)('%s', async (_label, duration, covered, status, emitted) => {
    const f = withDuration(base(), duration)
    const frames = framesCovering(base(), covered)
    expect(independentCoveredMs(frames.map((x) => x.t_ms), 250, duration)).toBe(covered)
    const { result } = await analyze(frames, f)
    expect(result.status).toBe(status)
    expect(result.coverage!.covered_ms).toBe(covered)
    expect(result.coverage!.coverage_ratio).toBe(emitted)
    // the contract, stated once: complete <=> the EMITTED ratio is at least 0.95
    expect(result.status === 'complete').toBe(result.coverage!.coverage_ratio >= 0.95)
    expect(checkEditingResultInvariants(result)).toEqual([])
  })

  it.each([
    ['just below 50 % (29 999 / 60 000)', 29_999, 'insufficient_data', 0.499],
    ['exactly 50 % (30 000 / 60 000)', 30_000, 'partial', 0.5],
  ] as const)('minimum coverage: %s', async (_label, covered, status, emitted) => {
    const f = base()
    const { result } = await analyze(framesCovering(f, covered), f)
    expect(result.status).toBe(status)
    expect(result.coverage!.coverage_ratio).toBe(emitted)
    if (status === 'insufficient_data') expect(result.reason_code).toBe('coverage_below_minimum')
  })

  it('the checker flags a complete result whose emitted ratio is below 0.95 and a ratio above the exact one', async () => {
    const f = base()
    const { result } = await analyze(f.frames, f)
    const below = structuredClone(result)
    below.coverage!.coverage_ratio = 0.949
    below.coverage!.covered_ms = 56_940
    below.coverage!.uncovered_ms = 3_060
    expect(checkEditingResultInvariants(below).map((i) => i.code)).toContain('complete_below_the_coverage_threshold')
    const above = structuredClone(result)
    above.coverage!.covered_ms = 56_999
    above.coverage!.uncovered_ms = 3_001
    above.coverage!.coverage_ratio = 0.95 // the round-to-3 value of 94.9983 %
    expect(checkEditingResultInvariants(above).map((i) => i.code)).toContain('differs_from_covered_time')
  })
})

describe('a frame outside [0, duration) is invalid input', () => {
  it.each([
    ['half an interval beyond the duration', 60_125],
    ['exactly at the duration', 60_000],
    ['a full interval beyond the duration', 60_250],
  ])('%s -> failed / timestamp_beyond_duration, and no shot with a non-positive length exists', async (_name, t) => {
    const f = buildFixture(slowSpec())
    const frames = [...f.frames, { t_ms: t, bins: sceneBase(9, f.bins) }]
    const { result } = await analyze(frames, f)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'invalid_frame_data', issues: [{ path: `frames[${f.frames.length}]`, code: 'timestamp_beyond_duration' }], metrics: null, shots: [], cuts: [] })
  })

  it('a final frame just inside the duration is valid, and its one-millisecond shot is still positive', async () => {
    const f = buildFixture(slowSpec())
    const frames = [...f.frames, { t_ms: 59_999, bins: sceneBase(9, f.bins) }]
    const { result } = await analyze(frames, f)
    expect(['complete', 'partial']).toContain(result.status)
    expect(result.shots[result.shots.length - 1]).toMatchObject({ start_ms: 59_999, end_ms: 60_000, duration_ms: 1 })
    expect(checkEditingResultInvariants(result)).toEqual([])
  })
})

describe('structural invariants of every result with metrics', () => {
  const sources: Array<[string, () => Fixture]> = [
    ['slow talking head', slowTalkingHead],
    ['fast montage', fastMontage],
    ['steady pacing', steadyPacing],
  ]

  it.each(sources)('%s satisfies the invariants', async (_name, make) => {
    const f = make()
    const { result } = await analyze(f.frames, f)
    expect(checkEditingResultInvariants(result)).toEqual([])
    expect(result.shots.every((s) => s.duration_ms > 0)).toBe(true)
    expect(result.cuts.every((c) => c.t_ms > 0 && c.t_ms < f.duration_ms)).toBe(true)
    expect(result.metrics!.pacing.windows.reduce((a, w) => a + w.cut_count, 0)).toBe(result.metrics!.cut_count)
  })

  it('property: random drops and jitter never break an invariant, and complete / full-duration keep their definitions', async () => {
    const rng = mulberry32(2026)
    let withMetrics = 0
    for (let n = 0; n < 90; n += 1) {
      const base = sources[n % sources.length][1]()
      const drops: Array<{ from_ms: number; to_ms: number }> = []
      for (let k = Math.floor(rng() * 4); k > 0; k -= 1) {
        const from = Math.floor(rng() * (base.duration_ms - 1_000))
        drops.push({ from_ms: from, to_ms: from + Math.floor(rng() * 6_000) })
      }
      const spec: FixtureSpec = {
        shots: [],
        sample_interval_ms: base.sample_interval_ms,
        drop_ranges: drops,
        jitter_ms: Math.floor(rng() * Math.floor(base.sample_interval_ms * 0.4)),
        noise: 0.06,
        seed: n + 1,
      }
      // rebuild the same shots as the base video, with the random damage applied
      const dur = base.duration_ms
      const cuts = [0, ...base.cuts_ms, dur]
      spec.shots = cuts.slice(0, -1).map((c, i) => ({ duration_ms: cuts[i + 1] - c, scene: i }))
      const f = buildFixture(spec)
      const { result } = await analyze(f.frames, f)
      // the expectation comes from the frame timestamps through an independent 1 ms bitmap, NOT from `gaps`
      const oracle = independentCoveredMs(f.frames.map((x) => x.t_ms), f.sample_interval_ms, f.duration_ms)
      if (result.status === 'complete' || result.status === 'partial') {
        withMetrics += 1
        expect(checkEditingResultInvariants(result), `case ${n}`).toEqual([])
        expect(result.coverage!.covered_ms, `case ${n} covered_ms`).toBe(oracle)
        expect(result.coverage!.coverage_ratio, `case ${n} ratio`).toBe(floor3(oracle, f.duration_ms))
        expect(result.metrics!.cut_density_per_min, `case ${n} density`).toBeCloseTo(result.cuts.length / (oracle / 60_000), 2)
        if (result.status === 'complete') expect(oracle / f.duration_ms).toBeGreaterThanOrEqual(0.95)
        if (result.status === 'partial') expect(oracle / f.duration_ms).toBeLessThan(0.95)
        if (result.metrics!.scope.covers_full_duration) {
          expect(result.status).toBe('complete')
          expect(oracle, `case ${n} full duration`).toBe(f.duration_ms)
          expect(result.metrics!.scope.to_ms).toBe(f.duration_ms)
        }
        if (oracle === f.duration_ms && result.status === 'complete') expect(result.metrics!.scope.covers_full_duration).toBe(true)
      } else if (result.coverage) {
        expect(result.coverage.covered_ms, `case ${n} insufficient`).toBe(oracle)
        expect(result.metrics).toBeNull()
      } else {
        expect(result.metrics).toBeNull()
      }
    }
    expect(withMetrics).toBeGreaterThan(40) // the property is not vacuous
  })
})

describe('the invariant checker has teeth (hand-made broken results)', () => {
  async function good(): Promise<EditingAnalysisResult> {
    const f = fastMontage()
    return (await analyze(f.frames, f)).result
  }
  const clone = (r: EditingAnalysisResult) => structuredClone(r)

  it('accepts a genuine result', async () => {
    expect(checkEditingResultInvariants(await good())).toEqual([])
  })

  it.each([
    ['a negative shot', (r: EditingAnalysisResult) => { r.shots[r.shots.length - 1].duration_ms = -125; r.shots[r.shots.length - 1].end_ms = r.shots[r.shots.length - 1].start_ms - 125 }, 'not_positive'],
    ['a cut beyond the duration', (r: EditingAnalysisResult) => { r.cuts[r.cuts.length - 1].t_ms = r.coverage!.declared_duration_ms + 125 }, 'outside_the_video'],
    ['a window sum that differs from the cut count', (r: EditingAnalysisResult) => { r.metrics!.pacing.windows[0].cut_count += 1 }, 'cut_sum_differs_from_cut_count'],
    ['a shot count that is not cuts + 1', (r: EditingAnalysisResult) => { r.metrics!.shot_count += 1 }, 'differs_from_cut_count_plus_one'],
    ['complete below the coverage threshold', (r: EditingAnalysisResult) => { r.coverage!.coverage_ratio = 0.5 }, 'complete_below_the_coverage_threshold'],
    ['full duration with a hole', (r: EditingAnalysisResult) => { r.coverage!.gaps = [{ start_ms: 1000, end_ms: 2000 }]; r.coverage!.gap_total_ms = 1000 }, 'full_duration_with_holes'],
    ['full duration with a partial status', (r: EditingAnalysisResult) => { r.status = 'partial' }, 'full_duration_without_complete_status'],
    ['a coverage ratio that differs from the covered time', (r: EditingAnalysisResult) => { r.coverage!.coverage_ratio = 1; r.coverage!.covered_ms = 40_000; r.coverage!.uncovered_ms = r.coverage!.declared_duration_ms - 40_000 }, 'differs_from_covered_time'],
    ['full duration with uncovered time below the listing tolerance', (r: EditingAnalysisResult) => { r.coverage!.uncovered_ms = 30; r.coverage!.covered_ms = r.coverage!.declared_duration_ms - 30; r.coverage!.coverage_ratio = r.coverage!.covered_ms / r.coverage!.declared_duration_ms }, 'full_duration_with_uncovered_time'],
    ['listed holes longer than the uncovered time', (r: EditingAnalysisResult) => { r.coverage!.gap_total_ms = 500 }, 'exceeds_the_uncovered_time'],
    ['a shot that does not reach the scope end', (r: EditingAnalysisResult) => { r.metrics!.scope.to_ms -= 500 }, 'does_not_reach_the_scope_end'],
  ])('flags %s', async (_name, mutate, code) => {
    const r = clone(await good())
    mutate(r)
    expect(checkEditingResultInvariants(r).map((i) => i.code)).toContain(code)
  })

  it('flags metrics on a non-measurement status', async () => {
    const r = clone(await good())
    r.status = 'failed'
    expect(checkEditingResultInvariants(r)).toEqual([{ path: 'metrics', code: 'metrics_without_a_measurement_status' }])
  })
})
