// Editing Pattern Engine 1A-1B: contract validation, shot-boundary accuracy (with timestamp tolerance),
// cut density / pacing, resource limits and the explicit error / insufficient-data states.
// DB-free, network-free, decoder-free: every "video" is a seeded, fictional frame-signature fixture.
import { describe, expect, it } from 'vitest'
import { analyzeEditingPattern } from '@/lib/editing-pattern/analyzer'
import {
  EDITING_ALGORITHM_VERSION,
  EDITING_ANALYSIS_CONTRACT_VERSION,
  EDITING_ANALYSIS_HARD_LIMITS,
  type EditingAnalysisResult,
  type FrameSignature,
} from '@/lib/editing-pattern/contract'
import { validateEditingAnalysisInput } from '@/lib/editing-pattern/validate'
import {
  FixtureFrameSource,
  acceleratingPacing,
  buildFixture,
  deceleratingPacing,
  fastMontage,
  histogramDistance,
  inputFor,
  sceneBase,
  slowTalkingHead,
  steadyPacing,
  type Fixture,
} from './support/editing-pattern-fixtures'

async function run(fixture: Fixture, over: Record<string, unknown> = {}, hooks: ConstructorParameters<typeof FixtureFrameSource>[1] = {}, options: Parameters<typeof analyzeEditingPattern>[2] = {}) {
  const source = new FixtureFrameSource({ vid: fixture.frames }, hooks)
  const result = await analyzeEditingPattern(inputFor(fixture, 'vid', over), source, options)
  return { result, source }
}

/** Greedy one-to-one matching of detected cuts to ground-truth cuts within a tolerance. */
function matchCuts(detected: number[], truth: number[], tolerance: number) {
  const used = new Set<number>()
  let tp = 0
  const errors: number[] = []
  for (const t of truth) {
    const idx = detected.findIndex((d, i) => !used.has(i) && Math.abs(d - t) <= tolerance)
    if (idx >= 0) { used.add(idx); tp += 1; errors.push(detected[idx] - t) }
  }
  return { tp, fp: detected.length - used.size, fn: truth.length - tp, errors }
}

describe('fixture validity (the ground truth is meaningful)', () => {
  it('adjacent scenes are far apart in histogram space, so every true cut is detectable in principle', () => {
    for (const f of [slowTalkingHead(), fastMontage(), acceleratingPacing(), deceleratingPacing(), steadyPacing()]) {
      const bases = f.cuts_ms.length + 1
      for (let s = 0; s + 1 < bases; s += 1) expect(histogramDistance(sceneBase(s, f.bins), sceneBase(s + 1, f.bins))).toBeGreaterThan(0.5)
    }
  })
})

describe('input contract (versioned, strict)', () => {
  const base = { contract_version: 'editing-analysis.v1', video: { source_kind: 'fixture', source_id: 'vid', duration_ms: 60_000 }, sampling: { sample_interval_ms: 250, signature_bins: 32 } }

  it('accepts a minimal request and resolves every default and limit', () => {
    const v = validateEditingAnalysisInput(base)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.input.params).toEqual({ cut_sensitivity: 'normal', min_shot_length_ms: 500 })
    expect(v.input.limits).toEqual(EDITING_ANALYSIS_HARD_LIMITS)
  })

  it.each([
    ['another contract version', { ...base, contract_version: 'editing-analysis.v2' }, 'contract_version', 'unsupported_contract_version'],
    ['an unknown top-level field', { ...base, extra: 1 }, 'extra', 'unknown_field'],
    ['an unknown video field', { ...base, video: { ...base.video, url: 'https://youtube.com/watch?v=x' } }, 'video.url', 'unknown_field'],
    ['a URL-like source id', { ...base, video: { ...base.video, source_id: 'https://example.com/v' } }, 'video.source_id', 'invalid_value'],
    ['an unsupported source kind', { ...base, video: { ...base.video, source_kind: 'youtube' } }, 'video.source_kind', 'invalid_value'],
    ['a non-integer duration', { ...base, video: { ...base.video, duration_ms: 1000.5 } }, 'video.duration_ms', 'invalid_value'],
    ['an absurd duration', { ...base, video: { ...base.video, duration_ms: 90_000_000 } }, 'video.duration_ms', 'invalid_value'],
    ['a too small interval', { ...base, sampling: { ...base.sampling, sample_interval_ms: 10 } }, 'sampling.sample_interval_ms', 'out_of_range'],
    ['too few bins', { ...base, sampling: { ...base.sampling, signature_bins: 4 } }, 'sampling.signature_bins', 'out_of_range'],
    ['too many bins', { ...base, sampling: { ...base.sampling, signature_bins: 256 } }, 'sampling.signature_bins', 'out_of_range'],
    ['an unknown sensitivity', { ...base, params: { cut_sensitivity: 'extreme' } }, 'params.cut_sensitivity', 'invalid_value'],
    ['a limit above the hard cap', { ...base, limits: { max_frames: 6_001 } }, 'limits.max_frames', 'above_hard_cap'],
    ['an unknown limit', { ...base, limits: { max_gpu_hours: 1 } }, 'limits.max_gpu_hours', 'unknown_field'],
  ])('rejects %s', (_name, raw, path, code) => {
    const v = validateEditingAnalysisInput(raw)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.issues).toContainEqual({ path, code })
  })

  it('a request may tighten a limit but its effective value is reported', () => {
    const v = validateEditingAnalysisInput({ ...base, limits: { max_frames: 500 } })
    expect(v.ok && v.input.limits.max_frames).toBe(500)
  })

  it('rejects a non-object', () => {
    expect(validateEditingAnalysisInput(null)).toEqual({ ok: false, issues: [{ path: '', code: 'not_an_object' }] })
    expect(validateEditingAnalysisInput([])).toEqual({ ok: false, issues: [{ path: '', code: 'not_an_object' }] })
  })
})

describe('shot boundaries: accuracy against the ground truth, with timestamp tolerance', () => {
  const clean: Array<[string, () => Fixture]> = [
    ['slow talking head', slowTalkingHead],
    ['fast montage', fastMontage],
    ['accelerating pacing', acceleratingPacing],
    ['decelerating pacing', deceleratingPacing],
    ['steady pacing', steadyPacing],
  ]

  it.each(clean)('%s: every true cut is found, nothing else is, and each timestamp is within one sample interval (never earlier)', async (_name, make) => {
    const f = make()
    const { result } = await run(f)
    expect(result.status).toBe('complete')
    const m = matchCuts(result.cuts.map((c) => c.t_ms), f.cuts_ms, f.sample_interval_ms)
    expect(m).toMatchObject({ tp: f.cuts_ms.length, fp: 0, fn: 0 })
    for (const e of m.errors) {
      expect(e).toBeGreaterThanOrEqual(0) // the reported time is the FIRST frame of the new shot
      expect(e).toBeLessThan(f.sample_interval_ms)
    }
    expect(result.timestamp_resolution_ms).toBe(f.sample_interval_ms)
    for (const c of result.cuts) expect(c.uncertainty_ms).toBe(f.sample_interval_ms)
  })

  it.each([200, 500, 1000])('the tolerance scales with the sampling interval (%i ms) and the cut count stays exact', async (interval) => {
    const f = buildFixture({ shots: [8_000, 6_000, 9_000, 7_000, 10_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: interval, noise: 0.06, seed: 5 })
    const { result } = await run(f)
    const m = matchCuts(result.cuts.map((c) => c.t_ms), f.cuts_ms, interval)
    expect(m).toMatchObject({ tp: f.cuts_ms.length, fp: 0, fn: 0 })
    for (const e of m.errors) expect(e).toBeLessThan(interval)
  })

  it('timestamp jitter of up to 20 % of the interval moves a cut by at most interval + jitter, and creates no false cut', async () => {
    const f = buildFixture({ shots: [8_000, 6_000, 9_000, 7_000, 10_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 500, noise: 0.06, seed: 9, jitter_ms: 100 })
    const { result } = await run(f)
    const m = matchCuts(result.cuts.map((c) => c.t_ms), f.cuts_ms, 500 + 100)
    expect(m).toMatchObject({ tp: 4, fp: 0, fn: 0 })
  })

  it('noise and slow drift inside a shot do not create cuts', async () => {
    const f = buildFixture({ shots: [{ duration_ms: 40_000, scene: 0 }], sample_interval_ms: 250, noise: 0.25, drift: 0.2, seed: 77 })
    const { result } = await run(f)
    expect(result.cuts).toHaveLength(0)
    expect(result.metrics?.shot_count).toBe(1)
  })

  it('a single-sample flash is not reported as two cuts', async () => {
    const f = buildFixture({ shots: [14_000, 9_000, 12_000, 8_000, 10_000, 7_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 250, noise: 0.08, seed: 11, flashes_ms: [5_000, 18_000, 40_000] })
    const { result } = await run(f)
    expect(matchCuts(result.cuts.map((c) => c.t_ms), f.cuts_ms, 250)).toMatchObject({ tp: f.cuts_ms.length, fp: 0 })
  })

  it('a slow dissolve is NOT detected, and the result says so up front (documented limitation, not silent)', async () => {
    const shots = [14_000, 9_000, 12_000, 8_000].map((d, i) => ({ duration_ms: d, scene: i }))
    const f = buildFixture({ shots, sample_interval_ms: 250, noise: 0.05, seed: 3, dissolves: [{ at_ms: 14_000, frames: 12 }] })
    const { result } = await run(f)
    const detected = result.cuts.map((c) => c.t_ms)
    expect(detected.some((t) => Math.abs(t - 14_000) <= 1_000)).toBe(false) // the dissolved boundary is missed
    expect(matchCuts(detected, [23_000, 35_000], 250)).toMatchObject({ tp: 2, fp: 0 }) // the hard cuts are still found
    expect(result.limitations).toContain('gradual_transitions_not_detected')
    expect(result.limitations).toContain('hard_cuts_only')
  })

  it('a stricter sensitivity finds no more cuts than a looser one on the same video', async () => {
    const f = slowTalkingHead()
    const low = (await run(f, { params: { cut_sensitivity: 'low' } })).result.cuts.length
    const high = (await run(f, { params: { cut_sensitivity: 'high' } })).result.cuts.length
    expect(low).toBeLessThanOrEqual(high)
  })
})

describe('shot length, cut density and pacing', () => {
  it('fast montage: shot count, average shot length and cut density follow the ground truth', async () => {
    const f = fastMontage()
    const { result } = await run(f)
    const m = result.metrics!
    expect(m.shot_count).toBe(f.cuts_ms.length + 1)
    expect(m.cut_count).toBe(f.cuts_ms.length)
    expect(m.avg_shot_length_ms).toBe(Math.round(f.duration_ms / (f.cuts_ms.length + 1)))
    expect(m.cut_density_per_min).toBeCloseTo(f.cuts_ms.length / (f.duration_ms / 60_000), 2)
    expect(m.scope).toEqual({ from_ms: 0, to_ms: f.duration_ms, covers_full_duration: true })
    expect(m.shots_in_stats).toBe(m.shot_count)
  })

  it('slow talking head has a much lower cut density than the montage', async () => {
    const slow = (await run(slowTalkingHead())).result.metrics!
    const fast = (await run(fastMontage())).result.metrics!
    expect(slow.cut_density_per_min).toBeLessThan(6)
    expect(fast.cut_density_per_min).toBeGreaterThan(30)
    expect(slow.median_shot_length_ms).toBeGreaterThan(fast.median_shot_length_ms)
  })

  it('shots tile the video without overlap or hole', async () => {
    const { result } = await run(fastMontage())
    expect(result.shots[0].start_ms).toBe(0)
    for (let i = 1; i < result.shots.length; i += 1) expect(result.shots[i].start_ms).toBe(result.shots[i - 1].end_ms)
    expect(result.shots[result.shots.length - 1].end_ms).toBe(fastMontage().duration_ms)
  })

  it('pacing trend: accelerating, decelerating and steady videos are told apart', async () => {
    expect((await run(acceleratingPacing())).result.metrics!.pacing.trend).toBe('accelerating')
    expect((await run(deceleratingPacing())).result.metrics!.pacing.trend).toBe('decelerating')
    expect((await run(steadyPacing())).result.metrics!.pacing.trend).toBe('steady')
  })

  it('pacing trend is NOT claimed when there are too few cuts to support it', async () => {
    const p = (await run(slowTalkingHead())).result.metrics!.pacing
    expect(p.trend).toBe('not_determinable')
    expect(p.trend_basis).toBe('not_determinable:too_few_cuts')
  })

  it('opening window counts the cuts of the first 3 seconds', async () => {
    const f = buildFixture({ shots: [1_000, 1_000, 5_000, 8_000, 8_000, 9_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 250, noise: 0.05, seed: 8 })
    const m = (await run(f)).result.metrics!
    expect(m.opening).toEqual({ window_ms: 3_000, cut_count: 2, first_cut_ms: 1_000 })
  })

  it('pacing windows cover the whole duration', async () => {
    const m = (await run(steadyPacing())).result.metrics!
    expect(m.pacing.windows[0].start_ms).toBe(0)
    expect(m.pacing.windows[m.pacing.windows.length - 1].end_ms).toBe(90_000)
    expect(m.pacing.windows.reduce((a, w) => a + w.cut_count, 0)).toBe(m.cut_count)
  })
})

describe('resource and cost limits', () => {
  it('a video above the duration limit is refused BEFORE the source is opened', async () => {
    const f = slowTalkingHead()
    const { result, source } = await run(f, { limits: { max_duration_ms: 30_000 } })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'duration_limit', metrics: null })
    expect(source.openCalls).toBe(0)
  })

  it('a frame budget below the expected frame count is refused before reading', async () => {
    const { result, source } = await run(slowTalkingHead(), { limits: { max_frames: 100 } })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'frame_budget' })
    expect(source.openCalls).toBe(0)
  })

  it('the hard frame cap applies to an over-long fine-grained request', async () => {
    const raw = { contract_version: 'editing-analysis.v1', video: { source_kind: 'fixture', source_id: 'vid', duration_ms: 700_000 }, sampling: { sample_interval_ms: 100, signature_bins: 32 } }
    const source = new FixtureFrameSource({})
    const result = await analyzeEditingPattern(raw, source)
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'frame_budget' })
    expect(result.cost).toEqual({ units_estimated: 7_000 * 32, units_consumed: 0 })
    expect(source.openCalls).toBe(0)
  })

  it('a compute budget (frames x bins) is enforced and reported in cost units', async () => {
    const f = slowTalkingHead() // 240 frames x 32 bins = 7 680 units
    const { result, source } = await run(f, { limits: { max_compute_units: 5_000 } })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'compute_budget', cost: { units_estimated: 7_680, units_consumed: 0 } })
    expect(source.openCalls).toBe(0)
  })

  it('a source that delivers more frames than declared is stopped at the frame budget', async () => {
    const f = buildFixture({ shots: [{ duration_ms: 10_000, scene: 0 }], sample_interval_ms: 250, noise: 0.02, seed: 4 }) // 40 frames
    const { result, source } = await run(f, { sampling: { sample_interval_ms: 500, signature_bins: 32 }, limits: { max_frames: 25 } })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'frame_budget_runtime', metrics: null })
    expect(source.framesYielded).toBeLessThanOrEqual(26)
  })

  it('the wall-clock deadline stops the analysis and reports no metrics (a prefix is never presented as the video)', async () => {
    const f = slowTalkingHead()
    let clock = 0
    const { result, source } = await run(f, { limits: { deadline_ms: 5_000 } }, { beforeFrame: () => { clock += 500 } }, { now: () => clock })
    expect(result).toMatchObject({ status: 'limit_exceeded', reason_code: 'deadline_exceeded', metrics: null, cuts: [], shots: [] })
    expect(result.evidence_basis.frames_examined).toBeGreaterThan(0)
    // the loop itself stops reading: an endless or very slow source cannot hold the worker past the deadline
    expect(source.framesYielded).toBeLessThan(60)
    expect(source.framesYielded).toBeLessThan(f.frames.length)
  })

  it('the shot LIST is capped but the metrics use every shot', async () => {
    const f = fastMontage()
    const { result } = await run(f, { limits: { max_output_shots: 5 } })
    expect(result.shots).toHaveLength(5)
    expect(result.shots_truncated).toBe(true)
    expect(result.warnings).toContain('shots_truncated')
    expect(result.metrics!.shot_count).toBe(f.cuts_ms.length + 1)
  })

  it('cost consumed equals frames x bins and never exceeds the estimate for a complete run', async () => {
    const f = slowTalkingHead()
    const { result } = await run(f)
    expect(result.cost).toEqual({ units_estimated: 240 * 32, units_consumed: 240 * 32 })
  })
})

describe('explicit non-result states', () => {
  const noMetrics = (r: EditingAnalysisResult) => {
    expect(r.metrics).toBeNull()
    expect(r.cuts).toEqual([])
    expect(r.shots).toEqual([])
  }

  it('a video shorter than the minimum duration is insufficient_data, without reading the source', async () => {
    const f = buildFixture({ shots: [{ duration_ms: 1_500, scene: 0 }], sample_interval_ms: 250, seed: 1 })
    const { result, source } = await run(f)
    expect(result).toMatchObject({ status: 'insufficient_data', reason_code: 'duration_too_short' })
    expect(source.openCalls).toBe(0)
    noMetrics(result)
  })

  it('too few frames are insufficient_data', async () => {
    const f = buildFixture({ shots: [{ duration_ms: 1_500, scene: 0 }, { duration_ms: 1_500, scene: 1 }], sample_interval_ms: 500, seed: 1 }) // 6 frames
    const { result } = await run(f)
    expect(result).toMatchObject({ status: 'insufficient_data', reason_code: 'too_few_frames' })
    expect(result.evidence_basis).toMatchObject({ frames_examined: 6, frame_analysis_performed: true })
    noMetrics(result)
  })

  it('coverage below 50 % is insufficient_data with the coverage reported', async () => {
    const f = buildFixture({ shots: [10_000, 10_000, 10_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 250, noise: 0.05, seed: 6, drop_ranges: [{ from_ms: 4_000, to_ms: 26_000 }] })
    const { result } = await run(f)
    expect(result).toMatchObject({ status: 'insufficient_data', reason_code: 'coverage_below_minimum' })
    expect(result.coverage!.coverage_ratio).toBeLessThan(0.5)
    expect(result.coverage!.gaps.length).toBeGreaterThan(0)
    noMetrics(result)
  })

  it('a data gap makes the result PARTIAL: metrics describe the covered part, the gap is listed, and a cut inside a gap is not invented', async () => {
    const f = buildFixture({ shots: [14_000, 9_000, 12_000, 8_000, 10_000, 7_000].map((d, i) => ({ duration_ms: d, scene: i })), sample_interval_ms: 250, noise: 0.08, seed: 11, drop_ranges: [{ from_ms: 20_000, to_ms: 24_000 }] })
    const { result } = await run(f)
    expect(result.status).toBe('partial')
    expect(result.coverage!.coverage_ratio).toBeLessThan(0.95)
    // frames at 20 000 ... 23 750 are missing: the last frame before the gap is at 19 750, its sample ends at 20 000
    expect(result.coverage!.gaps).toEqual([{ start_ms: 20_000, end_ms: 24_000 }])
    expect(result.warnings).toContain('data_gaps_present')
    expect(result.limitations).toContain('partial_coverage_metrics_describe_the_covered_part_only')
    expect(result.metrics!.scope.covers_full_duration).toBe(false)
    expect(result.metrics!.shots_in_stats).toBeLessThan(result.metrics!.shot_count)
    // the cut at 23 000 lies inside the gap: it is not reported, and nothing false is reported either
    const m = matchCuts(result.cuts.map((c) => c.t_ms), f.cuts_ms, 250)
    expect(m.fp).toBe(0)
    expect(m.fn).toBe(1)
    expect(result.shots.some((s) => s.spans_gap)).toBe(true)
  })

  it.each([
    ['NaN in a signature', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, bins: fr.bins.map((v, j) => (j === 0 ? Number.NaN : v)) } : fr)), 'invalid_signature_value'],
    ['a negative signature value', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, bins: fr.bins.map((v, j) => (j === 0 ? -0.5 : v)) } : fr)), 'invalid_signature_value'],
    ['a wrong signature length', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, bins: fr.bins.slice(1) } : fr)), 'wrong_signature_length'],
    ['an un-normalised signature', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, bins: fr.bins.map((v) => v * 3) } : fr)), 'signature_not_normalized'],
    ['a duplicated timestamp', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, t_ms: frames[9].t_ms } : fr)), 'timestamp_not_increasing'],
    ['a timestamp beyond the declared duration', (frames: FrameSignature[]) => frames.map((fr, i) => (i === 10 ? { ...fr, t_ms: 9_999_999 } : fr)), 'timestamp_beyond_duration'],
  ])('%s is a failed state naming the frame, with no metric', async (_name, mutate, code) => {
    const f = slowTalkingHead()
    const { result } = await run(f, {}, { mutate })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'invalid_frame_data', issues: [{ path: 'frames[10]', code }] })
    expect(result.evidence_basis.frames_examined).toBe(10)
    noMetrics(result)
  })

  it('a source error is a failed state that does not leak the raw error text', async () => {
    const { result } = await run(slowTalkingHead(), {}, { failAfter: 50 })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'source_error' })
    expect(JSON.stringify(result)).not.toContain('/private/path')
    noMetrics(result)
  })

  it('an unknown source id is a failed state, not a crash', async () => {
    const source = new FixtureFrameSource({})
    const result = await analyzeEditingPattern(inputFor(slowTalkingHead(), 'missing'), source)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'source_error' })
  })

  it('a cancelled analysis is a failed state', async () => {
    const ac = new AbortController()
    ac.abort()
    const { result } = await run(slowTalkingHead(), {}, {}, { signal: ac.signal })
    expect(result).toMatchObject({ status: 'failed', reason_code: 'cancelled' })
    noMetrics(result)
  })

  it('an invalid request is a failed state, the source is never opened and no frame analysis is claimed', async () => {
    const source = new FixtureFrameSource({})
    const result = await analyzeEditingPattern({ contract_version: 'x' }, source)
    expect(result).toMatchObject({ status: 'failed', reason_code: 'invalid_input', evidence_basis: { frame_analysis_performed: false, frames_examined: 0, source_kind: null } })
    expect(result.issues.length).toBeGreaterThan(0)
    expect(source.openCalls).toBe(0)
  })
})

describe('what the result must never claim', () => {
  it('every outcome carries the not_available markers for the retention curve and the style cluster, and no value for them', async () => {
    const outcomes = [
      (await run(slowTalkingHead())).result,
      (await run(slowTalkingHead(), { limits: { max_frames: 10 } })).result,
      await analyzeEditingPattern({}, new FixtureFrameSource({})),
    ]
    for (const r of outcomes) {
      expect(r.not_available).toEqual({
        retention_curve: { status: 'not_available', reason: 'no_training_data_baseline_calibration' },
        style_cluster: { status: 'not_available', reason: 'no_training_data_baseline_calibration' },
      })
      const text = JSON.stringify(r)
      expect(text).not.toMatch(/retention_estimate|retention_curve_points|style_label|cluster_id/)
    }
  })

  it('every result states what the algorithm cannot see', async () => {
    const r = (await run(slowTalkingHead())).result
    expect(r.limitations).toEqual(expect.arrayContaining(['hard_cuts_only', 'gradual_transitions_not_detected', 'sampled_signatures_not_every_frame', 'luminance_histogram_only_no_content_understanding']))
    expect(r.contract_version).toBe(EDITING_ANALYSIS_CONTRACT_VERSION)
    expect(r.algorithm_version).toBe(EDITING_ALGORITHM_VERSION)
  })

  it('the result is deterministic: the same input and frames give a deep-equal result', async () => {
    const a = (await run(fastMontage())).result
    const b = (await run(fastMontage())).result
    expect(b).toEqual(a)
  })

  it('does not mutate the frames the source delivered', async () => {
    const f = slowTalkingHead()
    const snapshot = JSON.stringify(f.frames)
    await run(f)
    expect(JSON.stringify(f.frames)).toBe(snapshot)
  })
})
