// lib/editing-pattern/analyzer.ts
// Editing Pattern Engine -- 1B: shot-boundary, cut-density and pacing analysis over a frame-signature series.
//
// PURE and deterministic: the same input and the same frames always give the same result (no clock value,
// no random value and no elapsed time ends up in the result). The side channels are the injected `now`
// clock and the injected timers, used for the wall-clock deadline.
//
// Algorithm (hist-delta-hard-cut.v2): the distance of two consecutive luminance histograms is half their L1
// distance (0..1). A cut is a consecutive-frame jump above an adaptive threshold
// max(absolute floor, median + k * 1.4826 * MAD). Two jumps that are adjacent or closer than the minimum shot
// length are a single-sample flash artifact (the frame after them matches the frame before them) or are merged
// to the stronger one. What it does NOT see: gradual transitions (dissolves, fades), content, motion, audio.
// That is stated in every result (BASE_LIMITATIONS) -- the output must never claim more than was measured.
//
// v2 (this file): COVERAGE IS TIME-BASED. A frame signature stands for [t, t + interval); the covered time is
// the EXACT union of those intervals clipped to [0, duration). The old frame COUNT let a video whose frames
// were squeezed into its first seconds pass as `complete` / `covers_full_duration`, and a half-interval
// tolerance must not hide many small uncovered spans either: the tolerance only decides which uncovered spans
// are LISTED as holes and which shots are kept out of the length statistics.
//
// DEADLINE (what is and is not guaranteed): every iterator.next() races a timer, so a source that stops
// answering cannot keep the ANALYSIS open past the deadline, provided the event loop is free. That is all it
// proves. It does not stop the source: AbortSignal is cooperative, return() on a suspended async generator is
// queued behind the pending next(), and a synchronous CPU-bound decoder blocks every timer. Real resource
// release needs an isolated worker (decision D1).
import {
  BASE_LIMITATIONS,
  COMPLETE_COVERAGE_RATIO,
  EDITING_ALGORITHM_VERSION,
  EDITING_ANALYSIS_CONTRACT_VERSION,
  MIN_ANALYSIS_DURATION_MS,
  MIN_ANALYSIS_FRAMES,
  MIN_COVERAGE_RATIO,
  NOT_AVAILABLE,
  type ContractIssue,
  type CutSensitivity,
  type EditingAnalysisResult,
  type EditingAnalysisStatus,
  type EditingCoverage,
  type EditingCut,
  type EditingMetrics,
  type EditingPacingWindow,
  type EditingReasonCode,
  type EditingShot,
  type FrameSignature,
  type FrameSignatureSource,
  type NormalizedEditingAnalysisInput,
  type PacingTrend,
} from './contract'
import { checkEditingResultInvariants } from './invariants'
import { validateEditingAnalysisInput } from './validate'

export interface AnalyzeTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface AnalyzeOptions {
  /** wall-clock in ms; injected so the deadline is testable */
  now?: () => number
  /** injected so the deadline race is testable without waiting */
  timers?: AnalyzeTimers
  signal?: AbortSignal
}

/** cuts are not assessed across a spacing larger than this many intervals */
const ASSESS_GAP_FACTOR = 2.5
/** uncovered spans of at most half an interval are not LISTED as holes (they still count as uncovered time) */
const HOLE_TOLERANCE_FACTOR = 0.5
/** more signature time than the union of the sampled intervals by this factor: the sampling is denser than declared */
const DENSE_SAMPLING_FACTOR = 1.25
const THRESHOLD_FLOOR: Record<CutSensitivity, number> = { low: 0.45, normal: 0.35, high: 0.25 }
const THRESHOLD_K: Record<CutSensitivity, number> = { low: 8, normal: 6, high: 4 }
const MAX_GAPS_LISTED = 20
const OPENING_WINDOW_MS = 3_000
const MIN_DISTANCES = 7
const SIGNATURE_SUM_TOLERANCE = 0.05
const TREND_MIN_CUTS = 6
const TREND_MIN_THIRD_COVERAGE = 0.8
const TREND_RELATIVE_CHANGE = 0.3

const DEFAULT_TIMERS: AnalyzeTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// ───────────────────────────── helpers ─────────────────────────────
function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function distance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / 2
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/**
 * The coverage ratio as EMITTED: truncated (never rounded up) to three decimals, so a 94.96 % coverage is
 * 0.949 and not 0.950. The status thresholds are compared against THIS value, so the emitted ratio can never
 * contradict the status (complete <=> coverage_ratio >= 0.95). Exact boundaries such as 57 000 / 60 000 divide
 * exactly in binary floating point (checked over all integer-ms durations up to 200 s), so no epsilon is needed.
 */
export function emittedCoverageRatio(coveredMs: number, durationMs: number): number {
  return Math.min(1, Math.max(0, Math.floor((coveredMs / durationMs) * 1000) / 1000))
}

interface Span {
  start_ms: number
  end_ms: number
}

/**
 * The EXACT union of the sample intervals, clipped to [0, duration). A sample stands for [t, t + interval).
 * Overlapping (dense) samples do not count twice. This is the ONLY basis of the covered time: no tolerance
 * enters it, so many small uncovered spans add up in the coverage instead of disappearing.
 */
function coveredSpans(frames: FrameSignature[], intervalMs: number, durationMs: number): Span[] {
  const spans: Span[] = []
  for (const frame of frames) {
    const start = frame.t_ms
    const end = Math.min(durationMs, frame.t_ms + intervalMs)
    if (end <= start) continue
    const last = spans[spans.length - 1]
    if (last && start <= last.end_ms) last.end_ms = Math.max(last.end_ms, end)
    else spans.push({ start_ms: start, end_ms: end })
  }
  return spans
}

const lengthOf = (spans: Span[]) => spans.reduce((a, s) => a + (s.end_ms - s.start_ms), 0)

/** Covered time inside [from, to): measured on the exact union. */
function coveredIn(spans: Span[], from: number, to: number): number {
  let total = 0
  for (const s of spans) total += Math.max(0, Math.min(to, s.end_ms) - Math.max(from, s.start_ms))
  return total
}

/**
 * The uncovered spans LONGER than half an interval: what is listed as a hole and what keeps a shot out of the
 * length statistics. This tolerance is a DISPLAY and shot-assessment rule only. It never reduces the uncovered
 * time that is reported (uncovered_ms), and it never touches coverage_ratio or the cut-density denominator.
 */
function listedHoles(spans: Span[], intervalMs: number, durationMs: number): Span[] {
  const tolerance = intervalMs * HOLE_TOLERANCE_FACTOR
  const holes: Span[] = []
  let cursor = 0
  for (const s of spans) {
    if (s.start_ms - cursor > tolerance) holes.push({ start_ms: cursor, end_ms: s.start_ms })
    cursor = Math.max(cursor, s.end_ms)
  }
  if (durationMs - cursor > tolerance) holes.push({ start_ms: cursor, end_ms: durationMs })
  return holes
}

/** Sum of the distinct sampled time: each frame contributes at most its own interval, never beyond the next frame. */
function sampledUnionMs(frames: FrameSignature[], intervalMs: number): number {
  let total = 0
  for (let i = 0; i < frames.length; i += 1) {
    const next = frames[i + 1]
    total += next ? Math.min(intervalMs, next.t_ms - frames[i].t_ms) : intervalMs
  }
  return total
}

interface Context {
  input: NormalizedEditingAnalysisInput | null
  framesExamined: number
  unitsEstimated: number
  coverage: EditingCoverage | null
}

function withoutMetrics(
  status: Exclude<EditingAnalysisStatus, 'complete' | 'partial'>,
  reason: EditingReasonCode,
  ctx: Context,
  issues: ContractIssue[] = [],
): EditingAnalysisResult {
  return {
    contract_version: EDITING_ANALYSIS_CONTRACT_VERSION,
    algorithm_version: EDITING_ALGORITHM_VERSION,
    status,
    reason_code: reason,
    issues,
    evidence_basis: {
      kind: 'frame_signature_series',
      frame_analysis_performed: ctx.framesExamined > 0,
      frames_examined: ctx.framesExamined,
      source_kind: ctx.input?.video.source_kind ?? null,
    },
    coverage: ctx.coverage,
    timestamp_resolution_ms: ctx.input?.sampling.sample_interval_ms ?? null,
    cuts: [],
    shots: [],
    shots_truncated: false,
    metrics: null,
    limitations: [...BASE_LIMITATIONS],
    warnings: [],
    limits_applied: ctx.input?.limits ?? null,
    cost: ctx.input ? { units_estimated: ctx.unitsEstimated, units_consumed: ctx.framesExamined * ctx.input.sampling.signature_bins } : null,
    not_available: NOT_AVAILABLE,
  }
}

/**
 * Frame-level contract: 0 <= t_ms < duration_ms (a frame at or beyond the declared duration is the source
 * adapter's job to clip), strictly increasing timestamps (an equal timestamp is NOT increasing), a signature of
 * the declared length that is finite, non-negative and normalised.
 */
function frameIssue(frame: FrameSignature, bins: number, previousT: number, durationMs: number): string | null {
  if (!frame || typeof frame !== 'object') return 'frame_not_an_object'
  if (typeof frame.t_ms !== 'number' || !Number.isFinite(frame.t_ms) || frame.t_ms < 0) return 'invalid_timestamp'
  if (frame.t_ms >= durationMs) return 'timestamp_beyond_duration'
  if (frame.t_ms <= previousT) return 'timestamp_not_increasing'
  if (!Array.isArray(frame.bins) || frame.bins.length !== bins) return 'wrong_signature_length'
  let sum = 0
  for (const v of frame.bins) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'invalid_signature_value'
    sum += v
  }
  if (Math.abs(sum - 1) > SIGNATURE_SUM_TOLERANCE) return 'signature_not_normalized'
  return null
}

type Step = { kind: 'value'; result: IteratorResult<FrameSignature> } | { kind: 'timeout' }

/**
 * iterator.next() raced against a timer. The timer is ALWAYS cleared once the race is decided. A next() that
 * settles after the timeout (resolved or rejected) is observed and discarded, so it can neither change the
 * analysis nor surface as an unhandled rejection.
 */
function nextWithin(iterator: AsyncIterator<FrameSignature>, ms: number, timers: AnalyzeTimers): Promise<Step> {
  return new Promise<Step>((resolve, reject) => {
    let decided = false
    const handle = timers.setTimeout(() => {
      if (decided) return
      decided = true
      resolve({ kind: 'timeout' })
    }, ms)
    let pending: Promise<IteratorResult<FrameSignature>>
    try {
      pending = Promise.resolve(iterator.next())
    } catch (error) {
      decided = true
      timers.clearTimeout(handle)
      reject(error)
      return
    }
    pending.then(
      (result) => {
        if (decided) return
        decided = true
        timers.clearTimeout(handle)
        resolve({ kind: 'value', result })
      },
      (error) => {
        if (decided) return // late rejection after the timeout: observed here, deliberately discarded
        decided = true
        timers.clearTimeout(handle)
        reject(error)
      },
    )
  })
}

// ───────────────────────────── the analysis ─────────────────────────────
export async function analyzeEditingPattern(
  raw: unknown,
  source: FrameSignatureSource,
  options: AnalyzeOptions = {},
): Promise<EditingAnalysisResult> {
  const now = options.now ?? (() => Date.now())
  const timers = options.timers ?? DEFAULT_TIMERS

  const validated = validateEditingAnalysisInput(raw)
  if (!validated.ok) {
    return withoutMetrics('failed', 'invalid_input', { input: null, framesExamined: 0, unitsEstimated: 0, coverage: null }, validated.issues)
  }
  const input = validated.input
  const { limits, sampling, video, params } = input
  const intervalMs = sampling.sample_interval_ms
  const expectedFrames = Math.ceil(video.duration_ms / intervalMs)
  const ctx: Context = { input, framesExamined: 0, unitsEstimated: expectedFrames * sampling.signature_bins, coverage: null }

  // pre-flight: nothing is read from the source when a limit is already known to be exceeded
  if (video.duration_ms > limits.max_duration_ms) return withoutMetrics('limit_exceeded', 'duration_limit', ctx)
  if (sampling.signature_bins > limits.max_signature_bins) return withoutMetrics('limit_exceeded', 'bin_budget', ctx)
  if (expectedFrames > limits.max_frames) return withoutMetrics('limit_exceeded', 'frame_budget', ctx)
  if (ctx.unitsEstimated > limits.max_compute_units) return withoutMetrics('limit_exceeded', 'compute_budget', ctx)
  if (video.duration_ms < MIN_ANALYSIS_DURATION_MS) return withoutMetrics('insufficient_data', 'duration_too_short', ctx)
  if (options.signal?.aborted) return withoutMetrics('failed', 'cancelled', ctx)

  // read the frames, enforcing the budgets while reading
  const frames: FrameSignature[] = []
  const startedAt = now()
  let previousT = -1
  const internalAbort = new AbortController()
  const forwardAbort = () => internalAbort.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  let iterator: AsyncIterator<FrameSignature> | null = null
  /** best effort only: it is NOT evidence that the source released anything (see the header) */
  const stopSource = () => {
    internalAbort.abort()
    try {
      const pending = iterator?.return?.()
      if (pending && typeof (pending as Promise<unknown>).then === 'function') void (pending as Promise<unknown>).then(undefined, () => {})
    } catch {
      /* ignored */
    }
  }

  const early = await (async (): Promise<EditingAnalysisResult | null> => {
    try {
      iterator = source.open(video, { signal: internalAbort.signal })[Symbol.asyncIterator]()
      for (;;) {
        if (options.signal?.aborted) { stopSource(); return withoutMetrics('failed', 'cancelled', ctx) }
        const remaining = limits.deadline_ms - (now() - startedAt)
        if (remaining <= 0) { stopSource(); return withoutMetrics('limit_exceeded', 'deadline_exceeded', ctx) }
        const step = await nextWithin(iterator, remaining, timers)
        if (step.kind === 'timeout') { stopSource(); return withoutMetrics('limit_exceeded', 'deadline_exceeded', ctx) }
        if (step.result.done) return null
        const frame = step.result.value
        if (frames.length >= limits.max_frames) {
          stopSource()
          return withoutMetrics('limit_exceeded', 'frame_budget_runtime', ctx)
        }
        if ((frames.length + 1) * sampling.signature_bins > limits.max_compute_units) {
          stopSource()
          return withoutMetrics('limit_exceeded', 'compute_budget', ctx)
        }
        const issue = frameIssue(frame, sampling.signature_bins, previousT, video.duration_ms)
        if (issue) {
          stopSource()
          return withoutMetrics('failed', 'invalid_frame_data', ctx, [{ path: `frames[${frames.length}]`, code: issue }])
        }
        frames.push({ t_ms: frame.t_ms, bins: frame.bins.slice() })
        previousT = frame.t_ms
        ctx.framesExamined = frames.length
      }
    } catch {
      // the raw error text is never copied into the result
      return withoutMetrics('failed', 'source_error', ctx)
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
    }
  })()
  if (early) return early
  if (options.signal?.aborted) return withoutMetrics('failed', 'cancelled', ctx)
  if (now() - startedAt > limits.deadline_ms) return withoutMetrics('limit_exceeded', 'deadline_exceeded', ctx)

  // time-based coverage and holes
  const sampled = frames.length
  const spans = coveredSpans(frames, intervalMs, video.duration_ms)
  const coveredMs = lengthOf(spans)
  const uncoveredMs = Math.max(0, video.duration_ms - coveredMs)
  const coverageRatio = emittedCoverageRatio(coveredMs, video.duration_ms)
  const holes = listedHoles(spans, intervalMs, video.duration_ms)
  const holeTotalMs = holes.reduce((a, h) => a + (h.end_ms - h.start_ms), 0)
  ctx.coverage = {
    declared_duration_ms: video.duration_ms,
    sampled_frames: sampled,
    expected_frames: expectedFrames,
    covered_ms: Math.round(coveredMs * 1000) / 1000,
    uncovered_ms: Math.round(uncoveredMs * 1000) / 1000,
    coverage_ratio: coverageRatio,
    gaps: holes.slice(0, MAX_GAPS_LISTED),
    gaps_truncated: holes.length > MAX_GAPS_LISTED,
    gap_total_ms: holeTotalMs,
  }
  if (sampled < MIN_ANALYSIS_FRAMES) return withoutMetrics('insufficient_data', 'too_few_frames', ctx)
  if (coverageRatio < MIN_COVERAGE_RATIO) return withoutMetrics('insufficient_data', 'coverage_below_minimum', ctx)

  // frame-to-frame distances (null across a large spacing: nothing is assessed over missing data)
  const d: Array<number | null> = new Array(sampled).fill(null)
  const valid: number[] = []
  for (let i = 1; i < sampled; i += 1) {
    if (frames[i].t_ms - frames[i - 1].t_ms > ASSESS_GAP_FACTOR * intervalMs) continue
    const v = distance(frames[i - 1].bins, frames[i].bins)
    d[i] = v
    valid.push(v)
  }
  if (valid.length < MIN_DISTANCES) return withoutMetrics('insufficient_data', 'too_few_distances', ctx)

  const med = median(valid)
  const mad = median(valid.map((v) => Math.abs(v - med)))
  const threshold = Math.max(THRESHOLD_FLOOR[params.cut_sensitivity], med + THRESHOLD_K[params.cut_sensitivity] * 1.4826 * mad)

  // candidates: every consecutive-frame jump above the threshold
  const candidates: number[] = []
  for (let i = 1; i < sampled; i += 1) {
    const v = d[i]
    if (v !== null && v >= threshold) candidates.push(i)
  }

  // A flash (a single bright sample) produces an "in" and an "out" jump: both are dropped when the frame after the
  // pair matches the frame before it. Otherwise the stronger of two close or adjacent jumps is kept (a fast fade).
  const minShot = params.min_shot_length_ms
  const kept: number[] = []
  for (let k = 0; k < candidates.length;) {
    const a = candidates[k]
    const b = candidates[k + 1]
    if (b !== undefined && (b === a + 1 || frames[b].t_ms - frames[a].t_ms < minShot)) {
      if (distance(frames[a - 1].bins, frames[b].bins) < threshold * 0.5) { k += 2; continue }
      kept.push((d[a] as number) >= (d[b] as number) ? a : b)
      k += 2
      continue
    }
    kept.push(a)
    k += 1
  }
  const finalIdx: number[] = []
  for (const i of kept) {
    const last = finalIdx[finalIdx.length - 1]
    if (last !== undefined && frames[i].t_ms - frames[last].t_ms < minShot) {
      if ((d[i] as number) > (d[last] as number)) finalIdx[finalIdx.length - 1] = i
    } else finalIdx.push(i)
  }

  const cuts: EditingCut[] = finalIdx.map((i) => {
    const v = d[i] as number
    const ratio = v / threshold
    return {
      t_ms: frames[i].t_ms,
      uncertainty_ms: frames[i].t_ms - frames[i - 1].t_ms,
      strength: round3(clamp01((v - threshold) / Math.max(1 - threshold, 1e-9))),
      confidence: ratio >= 1.5 ? 'high' : ratio >= 1.15 ? 'medium' : 'low',
    }
  })

  // shots tile [0, end]; with no hole at the end the last shot runs to the declared duration
  const lastFrameT = frames[sampled - 1].t_ms
  const tailHole = holes.find((h) => h.end_ms === video.duration_ms && h.start_ms > lastFrameT)
  const endMs = tailHole ? tailHole.start_ms : video.duration_ms
  const boundaries = [0, ...cuts.map((c) => c.t_ms), endMs]
  const shots: EditingShot[] = []
  for (let j = 0; j + 1 < boundaries.length; j += 1) {
    const start = boundaries[j]
    const end = boundaries[j + 1]
    shots.push({
      index: j,
      start_ms: start,
      end_ms: end,
      duration_ms: end - start,
      spans_gap: holes.some((h) => h.start_ms < end && h.end_ms > start),
    })
  }
  const inStats = shots.filter((s) => !s.spans_gap && s.duration_ms > 0)
  if (!inStats.length) return withoutMetrics('insufficient_data', 'no_gap_free_shots', ctx)
  const lengths = inStats.map((s) => s.duration_ms)

  // pacing: every coverage figure is time-based
  const windowMs = video.duration_ms < 60_000 ? 5_000 : 10_000
  const windows: EditingPacingWindow[] = []
  for (let start = 0; start < video.duration_ms; start += windowMs) {
    const end = Math.min(video.duration_ms, start + windowMs)
    const cutCount = cuts.filter((c) => c.t_ms >= start && c.t_ms < end).length
    windows.push({
      start_ms: start,
      end_ms: end,
      cut_count: cutCount,
      cut_density_per_min: round3(cutCount / ((end - start) / 60_000)),
      partial_window: coveredIn(spans, start, end) < 0.5 * (end - start),
    })
  }
  const third = video.duration_ms / 3
  const thirdStats = [0, 2].map((t) => {
    const from = third * t
    const to = third * (t + 1)
    const cutCount = cuts.filter((c) => c.t_ms >= from && c.t_ms < to).length
    return { cutCount, rate: cutCount / (third / 60_000), coverage: coveredIn(spans, from, to) / third }
  })
  let trend: PacingTrend = 'not_determinable'
  let trendBasis = 'not_determinable:too_few_cuts'
  if (cuts.length >= TREND_MIN_CUTS) {
    if (thirdStats[0].coverage < TREND_MIN_THIRD_COVERAGE || thirdStats[1].coverage < TREND_MIN_THIRD_COVERAGE) {
      trendBasis = 'not_determinable:thirds_coverage'
    } else {
      const [first, last] = thirdStats
      const rel = (last.rate - first.rate) / Math.max(first.rate, last.rate, 1e-9)
      trend = rel > TREND_RELATIVE_CHANGE ? 'accelerating' : rel < -TREND_RELATIVE_CHANGE ? 'decelerating' : 'steady'
      trendBasis = 'first_vs_last_third_cut_rate'
    }
  }

  const status: EditingAnalysisStatus = coverageRatio >= COMPLETE_COVERAGE_RATIO ? 'complete' : 'partial'
  // exact: not a single uncovered millisecond (a listed hole implies uncovered time, so holes need no extra check)
  const fullyCovered = uncoveredMs <= 1e-6 && endMs === video.duration_ms
  const metrics: EditingMetrics = {
    // true ONLY for a COMPLETE analysis whose sample intervals cover the whole [0, duration) exactly
    scope: { from_ms: 0, to_ms: endMs, covers_full_duration: status === 'complete' && fullyCovered },
    shot_count: shots.length,
    cut_count: cuts.length,
    avg_shot_length_ms: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
    median_shot_length_ms: Math.round(median(lengths)),
    min_shot_length_ms: Math.min(...lengths),
    max_shot_length_ms: Math.max(...lengths),
    // cuts per minute of COVERED time
    cut_density_per_min: round3(cuts.length / (coveredMs / 60_000)),
    shots_in_stats: inStats.length,
    opening: {
      window_ms: OPENING_WINDOW_MS,
      cut_count: cuts.filter((c) => c.t_ms < OPENING_WINDOW_MS).length,
      first_cut_ms: cuts.length ? cuts[0].t_ms : null,
    },
    pacing: { window_ms: windowMs, windows, trend, trend_basis: trendBasis },
  }

  const warnings: string[] = []
  if (holes.length) warnings.push('data_gaps_present')
  else if (uncoveredMs > 1e-6) warnings.push('uncovered_time_below_gap_tolerance')
  if (sampled * intervalMs > DENSE_SAMPLING_FACTOR * sampledUnionMs(frames, intervalMs)) warnings.push('sampling_denser_than_declared')
  const truncated = shots.length > limits.max_output_shots
  if (truncated) warnings.push('shots_truncated')
  const limitations = [...BASE_LIMITATIONS]
  if (status === 'partial') limitations.push('partial_coverage_metrics_describe_the_covered_part_only')

  const result: EditingAnalysisResult = {
    contract_version: EDITING_ANALYSIS_CONTRACT_VERSION,
    algorithm_version: EDITING_ALGORITHM_VERSION,
    status,
    reason_code: null,
    issues: [],
    evidence_basis: { kind: 'frame_signature_series', frame_analysis_performed: true, frames_examined: sampled, source_kind: video.source_kind },
    coverage: ctx.coverage,
    timestamp_resolution_ms: intervalMs,
    cuts,
    shots: truncated ? shots.slice(0, limits.max_output_shots) : shots,
    shots_truncated: truncated,
    metrics,
    limitations,
    warnings,
    limits_applied: limits,
    cost: { units_estimated: ctx.unitsEstimated, units_consumed: sampled * sampling.signature_bins },
    not_available: NOT_AVAILABLE,
  }

  // defensive: a result that breaks its own contract is never handed out as a measurement
  const broken = checkEditingResultInvariants(result)
  if (broken.length) return withoutMetrics('failed', 'invariant_violation', ctx, broken)
  return result
}
