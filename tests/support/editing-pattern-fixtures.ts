// FICTIONAL video fixtures for the Editing Pattern Engine tests.
// Nothing here is, or is derived from, a real creator video: a "video" is a deterministic (seeded) series of
// luminance-histogram frame signatures built from invented scenes, with a known GROUND TRUTH of cut times.
// Pure and DB-free; no file, network or decoder is involved.
import type { FrameSignature, FrameSignatureSource, NormalizedEditingAnalysisInput } from '../../lib/editing-pattern/contract'

// ───────────────────────────── deterministic randomness ─────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ───────────────────────────── scenes ─────────────────────────────
/** A scene's base histogram: two triangular peaks at scene-dependent positions, so distinct scenes are far apart. */
export function sceneBase(scene: number, bins: number): number[] {
  const out = new Array<number>(bins).fill(0.0005)
  const peak = (center: number, mass: number) => {
    for (let o = -2; o <= 2; o += 1) {
      const idx = (((center + o) % bins) + bins) % bins
      out[idx] += mass * (3 - Math.abs(o)) / 9
    }
  }
  peak(scene * 5 + 2, 0.7)
  peak(scene * 11 + 9, 0.3)
  return normalize(out)
}

function normalize(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  return values.map((v) => v / sum)
}

export function histogramDistance(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i])
  return s / 2
}

// ───────────────────────────── fixture builder ─────────────────────────────
export interface FixtureSpec {
  /** consecutive shots; the cut ground truth is where one shot ends and the next begins */
  shots: Array<{ duration_ms: number; scene: number }>
  sample_interval_ms: number
  bins?: number
  /** multiplicative per-bin noise amplitude (0 = none) */
  noise?: number
  /** slow within-shot drift (camera motion / lighting), amplitude in histogram mass */
  drift?: number
  seed?: number
  /** timestamp jitter amplitude in ms (must stay below half the interval) */
  jitter_ms?: number
  /** single bright frames (flash photography) at these times */
  flashes_ms?: number[]
  /** a crossfade of `frames` frames centred on the boundary that STARTS at at_ms */
  dissolves?: Array<{ at_ms: number; frames: number }>
  /** frames in these ranges are missing */
  drop_ranges?: Array<{ from_ms: number; to_ms: number }>
}

export interface Fixture {
  frames: FrameSignature[]
  duration_ms: number
  bins: number
  sample_interval_ms: number
  /** the exact times (ms) at which a new shot begins (excludes 0) */
  cuts_ms: number[]
}

export function buildFixture(spec: FixtureSpec): Fixture {
  const bins = spec.bins ?? 32
  const interval = spec.sample_interval_ms
  const rng = mulberry32(spec.seed ?? 1)
  const duration = spec.shots.reduce((a, s) => a + s.duration_ms, 0)
  const starts: number[] = []
  let acc = 0
  for (const s of spec.shots) { starts.push(acc); acc += s.duration_ms }
  const cuts = starts.slice(1)
  const sceneAt = (t: number) => {
    let idx = 0
    for (let i = 0; i < starts.length; i += 1) if (t >= starts[i]) idx = i
    return idx
  }
  const frameCount = Math.ceil(duration / interval)
  const frames: FrameSignature[] = []
  for (let k = 0; k < frameCount; k += 1) {
    const nominal = k * interval
    if (spec.drop_ranges?.some((r) => nominal >= r.from_ms && nominal < r.to_ms)) continue
    const shotIdx = sceneAt(nominal)
    let base = sceneBase(spec.shots[shotIdx].scene, bins)
    for (const d of spec.dissolves ?? []) {
      const half = (d.frames * interval) / 2
      if (nominal >= d.at_ms - half && nominal < d.at_ms + half) {
        const boundaryIdx = starts.findIndex((s) => s === d.at_ms)
        if (boundaryIdx > 0) {
          const from = sceneBase(spec.shots[boundaryIdx - 1].scene, bins)
          const to = sceneBase(spec.shots[boundaryIdx].scene, bins)
          const w = (nominal - (d.at_ms - half)) / (d.frames * interval)
          base = from.map((v, i) => v * (1 - w) + to[i] * w)
        }
      }
    }
    let values = base.slice()
    if (spec.drift) {
      const phase = nominal / 4000
      values = values.map((v, i) => v + spec.drift! * Math.sin(phase + i / 3) / bins)
    }
    if (spec.noise) values = values.map((v) => Math.max(0, v * (1 + spec.noise! * (rng() * 2 - 1))))
    if (spec.flashes_ms?.some((f) => nominal >= f && nominal < f + interval)) {
      values = new Array<number>(bins).fill(0.001)
      values[bins - 1] = 1
    }
    const jitter = spec.jitter_ms ? Math.round((rng() * 2 - 1) * spec.jitter_ms) : 0
    frames.push({ t_ms: Math.max(0, nominal + jitter), bins: normalize(values.map((v) => Math.max(v, 0)) ) })
  }
  return { frames, duration_ms: duration, bins, sample_interval_ms: interval, cuts_ms: cuts }
}

/** A well-formed request for a fixture (everything else defaulted by the validator). */
export function inputFor(fixture: Fixture, sourceId: string, over: Record<string, unknown> = {}) {
  return {
    contract_version: 'editing-analysis.v1',
    video: { source_kind: 'fixture', source_id: sourceId, duration_ms: fixture.duration_ms },
    sampling: { sample_interval_ms: fixture.sample_interval_ms, signature_bins: fixture.bins },
    ...over,
  }
}

// ───────────────────────────── source adapter ─────────────────────────────
export class FixtureFrameSource implements FrameSignatureSource {
  openCalls = 0
  framesYielded = 0
  constructor(
    private readonly framesBySource: Record<string, FrameSignature[]>,
    private readonly hooks: {
      /** called before each frame is yielded (e.g. to advance a fake clock) */
      beforeFrame?: (index: number) => void
      /** the iterator throws once this many frames were yielded */
      failAfter?: number
      /** transform the frame stream (corruption fixtures) */
      mutate?: (frames: FrameSignature[]) => FrameSignature[]
    } = {},
  ) {}

  open(video: NormalizedEditingAnalysisInput['video']): AsyncIterable<FrameSignature> {
    this.openCalls += 1
    const self = this
    const source = this.framesBySource[video.source_id]
    return {
      async *[Symbol.asyncIterator]() {
        if (!source) throw new Error('unknown fixture')
        const frames = self.hooks.mutate ? self.hooks.mutate(source) : source
        for (let i = 0; i < frames.length; i += 1) {
          if (self.hooks.failAfter !== undefined && i >= self.hooks.failAfter) throw new Error('simulated source failure with a /private/path inside')
          self.hooks.beforeFrame?.(i)
          self.framesYielded += 1
          yield frames[i]
        }
      },
    }
  }
}

// ───────────────────────────── the named fictional videos ─────────────────────────────
const shotsOf = (durations: number[]) => durations.map((d, i) => ({ duration_ms: d, scene: i }))

/** 60 s, six long shots: a slow talking-head style video. */
export const slowTalkingHead = () =>
  buildFixture({ shots: shotsOf([14_000, 9_000, 12_000, 8_000, 10_000, 7_000]), sample_interval_ms: 250, noise: 0.08, drift: 0.02, seed: 11 })

/** 29.5 s, 24 shots of 1.0-1.5 s: a fast montage. */
export const fastMontage = () =>
  buildFixture({
    shots: shotsOf([1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_500, 1_000, 1_250, 1_000]),
    sample_interval_ms: 200,
    noise: 0.06,
    seed: 23,
  })

/** 90 s: 6 s shots in the first third, 3 s in the middle, 1.5 s in the last third (pacing accelerates). */
export const acceleratingPacing = () => {
  const d: number[] = []
  for (let i = 0; i < 5; i += 1) d.push(6_000)
  for (let i = 0; i < 10; i += 1) d.push(3_000)
  for (let i = 0; i < 20; i += 1) d.push(1_500)
  return buildFixture({ shots: shotsOf(d), sample_interval_ms: 250, noise: 0.07, seed: 31 })
}

/** 90 s: the mirror image (pacing decelerates). */
export const deceleratingPacing = () => {
  const d: number[] = []
  for (let i = 0; i < 20; i += 1) d.push(1_500)
  for (let i = 0; i < 10; i += 1) d.push(3_000)
  for (let i = 0; i < 5; i += 1) d.push(6_000)
  return buildFixture({ shots: shotsOf(d), sample_interval_ms: 250, noise: 0.07, seed: 37 })
}

/** 90 s, even 4.5 s shots (steady pacing). */
export const steadyPacing = () => buildFixture({ shots: shotsOf(new Array<number>(20).fill(4_500)), sample_interval_ms: 250, noise: 0.07, seed: 41 })

// ───────────────────────────── independent coverage oracle ─────────────────────────────
/**
 * The covered time computed WITHOUT the analyzer's algorithm and WITHOUT any tolerance: a 1 ms bitmap of
 * [0, duration), every sample marking [t, t + interval). Valid for integer timestamps (all fixtures). Tests
 * compare the analyzer's covered_ms with this, never with the analyzer's own `gaps` list.
 */
export function independentCoveredMs(timestamps: number[], intervalMs: number, durationMs: number): number {
  const covered = new Uint8Array(durationMs)
  for (const t of timestamps) {
    const from = Math.max(0, Math.floor(t))
    const to = Math.min(durationMs, Math.floor(t) + intervalMs)
    for (let ms = from; ms < to; ms += 1) covered[ms] = 1
  }
  let total = 0
  for (let i = 0; i < covered.length; i += 1) total += covered[i]
  return total
}
