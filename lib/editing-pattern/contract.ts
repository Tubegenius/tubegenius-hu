// lib/editing-pattern/contract.ts
// Editing Pattern Engine -- 1A: the VERSIONED EditingAnalysis input/output contract.
//
// What this contract is, and is not:
//   * It describes an analysis of a SERIES OF FRAME SIGNATURES (small per-frame luminance histograms)
//     of one video: shot boundaries (hard cuts), cut density and pacing.
//   * It is NOT a retention estimate and NOT a style classification. Both are present in the output
//     only as explicit `not_available` markers (see EditingNotAvailable), so a frontend cannot render
//     them as results. Their measurement plan is in docs/product/editing-pattern-measurement-plan.md.
//   * It does not decode video. Frames reach the analyzer through a FrameSignatureSource port; a real
//     decoder (a worker with ffmpeg, a rights/storage model) is a separate, undecided infrastructure
//     step (docs/architecture/editing-pattern-engine-1ab.md, "Decision points").
//   * It is pure: no network, no database, no file system, no credit charge.

export const EDITING_ANALYSIS_CONTRACT_VERSION = 'editing-analysis.v1' as const
export const EDITING_ALGORITHM_VERSION = 'hist-delta-hard-cut.v2' as const

/** Where the frame signatures come from. A YouTube URL is deliberately NOT a source kind: no video is downloaded from YouTube. */
export type VideoSourceKind = 'fixture' | 'user_upload'
export const VIDEO_SOURCE_KINDS: readonly VideoSourceKind[] = ['fixture', 'user_upload']

export type CutSensitivity = 'low' | 'normal' | 'high'
export const CUT_SENSITIVITIES: readonly CutSensitivity[] = ['low', 'normal', 'high']

/** Resource and cost limits of one analysis. A request may only TIGHTEN the hard caps, never raise them. */
export interface EditingAnalysisLimits {
  max_duration_ms: number
  /** frame signatures read from the source */
  max_frames: number
  max_signature_bins: number
  /** frames x bins: the deterministic cost unit of the analysis (no monetary price is defined yet) */
  max_compute_units: number
  /** wall-clock budget of the analysis loop */
  deadline_ms: number
  /** shots listed in the output (metrics always use ALL shots) */
  max_output_shots: number
}

export const EDITING_ANALYSIS_HARD_LIMITS: Readonly<EditingAnalysisLimits> = Object.freeze({
  max_duration_ms: 30 * 60 * 1000,
  max_frames: 6_000,
  max_signature_bins: 64,
  max_compute_units: 6_000 * 64,
  deadline_ms: 20_000,
  max_output_shots: 2_000,
})

export const MIN_SIGNATURE_BINS = 8
export const MIN_SAMPLE_INTERVAL_MS = 100
export const MAX_SAMPLE_INTERVAL_MS = 5_000
/** declared durations above this are an invalid input, not a limit overrun (sanity bound: 24 h) */
export const MAX_DECLARED_DURATION_MS = 24 * 60 * 60 * 1000
/** minimum evidence before any metric is reported */
export const MIN_ANALYSIS_FRAMES = 8
export const MIN_ANALYSIS_DURATION_MS = 2_000
/** below this coverage the metrics are not reported; below COMPLETE_COVERAGE they are reported as `partial` */
export const MIN_COVERAGE_RATIO = 0.5
export const COMPLETE_COVERAGE_RATIO = 0.95

// ───────────────────────────── input ─────────────────────────────
export interface EditingAnalysisInput {
  contract_version: typeof EDITING_ANALYSIS_CONTRACT_VERSION
  video: {
    source_kind: VideoSourceKind
    /** opaque id of the source object (a fixture name, an upload id). Never a URL. */
    source_id: string
    duration_ms: number
  }
  sampling: {
    /** nominal distance between two frame signatures */
    sample_interval_ms: number
    /** length of every signature (luminance histogram bins) */
    signature_bins: number
  }
  params?: {
    cut_sensitivity?: CutSensitivity
    /** shots shorter than this are treated as flash artifacts or merged (default: max(300, 2 x interval)) */
    min_shot_length_ms?: number
  }
  limits?: Partial<EditingAnalysisLimits>
}

/** The input after validation: every default filled, every limit resolved against the hard caps. */
export interface NormalizedEditingAnalysisInput {
  contract_version: typeof EDITING_ANALYSIS_CONTRACT_VERSION
  video: EditingAnalysisInput['video']
  sampling: EditingAnalysisInput['sampling']
  params: { cut_sensitivity: CutSensitivity; min_shot_length_ms: number }
  limits: EditingAnalysisLimits
}

export interface ContractIssue {
  path: string
  code: string
}

// ───────────────────────────── frame source port ─────────────────────────────
/** One frame's signature: a normalized luminance histogram (sums to ~1) at a timestamp. */
export interface FrameSignature {
  t_ms: number
  bins: number[]
}

export interface FrameSignatureSource {
  /** Frames in ascending timestamp order. May be arbitrarily long: the analyzer enforces its own budgets and stops reading. */
  open(video: NormalizedEditingAnalysisInput['video'], options?: { signal?: AbortSignal }): AsyncIterable<FrameSignature>
}

// ───────────────────────────── output ─────────────────────────────
/**
 * complete           frames cover >= 95 % of the declared duration; all metrics are reported
 * partial            50-95 % coverage (gaps in the data); metrics are reported for the covered part and say so
 * insufficient_data  too little evidence: NO metric is reported
 * limit_exceeded     a resource or cost limit stopped the analysis: NO metric is reported
 * failed             invalid input, invalid frame data, a source error or a cancellation: NO metric is reported
 */
export type EditingAnalysisStatus = 'complete' | 'partial' | 'insufficient_data' | 'limit_exceeded' | 'failed'

export type EditingReasonCode =
  // insufficient_data
  | 'duration_too_short'
  | 'too_few_frames'
  | 'coverage_below_minimum'
  | 'no_gap_free_shots'
  | 'too_few_distances'
  // limit_exceeded
  | 'duration_limit'
  | 'bin_budget'
  | 'frame_budget'
  | 'frame_budget_runtime'
  | 'compute_budget'
  | 'deadline_exceeded'
  // failed
  | 'invalid_input'
  | 'invalid_frame_data'
  | 'source_error'
  | 'cancelled'
  /** the analyzer's own result broke a structural invariant (a defect, never a measurement) */
  | 'invariant_violation'

export type CutConfidence = 'high' | 'medium' | 'low'

export interface EditingCut {
  /** the timestamp of the FIRST frame of the new shot */
  t_ms: number
  /** the true cut lies within (t_ms - uncertainty_ms, t_ms] */
  uncertainty_ms: number
  /** 0..1, how far the frame difference exceeds the adaptive threshold */
  strength: number
  confidence: CutConfidence
}

export interface EditingShot {
  index: number
  start_ms: number
  end_ms: number
  duration_ms: number
  /** a data gap lies inside this shot: it is excluded from the shot-length statistics */
  spans_gap: boolean
}

export interface EditingCoverage {
  declared_duration_ms: number
  sampled_frames: number
  expected_frames: number
  /** length of the EXACT union of the sample intervals [t, t + interval), clipped to [0, duration) */
  covered_ms: number
  /** declared duration - covered_ms: ALL uncovered time, including every span below the hole-listing tolerance */
  uncovered_ms: number
  /**
   * TIME-based: covered_ms / declared duration, TRUNCATED (never rounded up) to three decimals, so it can never
   * reach a status threshold the exact coverage has not reached: status is `complete` exactly when
   * coverage_ratio >= 0.95. The frame COUNT does not enter it, and neither does any tolerance: many small
   * uncovered spans reduce it exactly as one large hole does.
   */
  coverage_ratio: number
  /**
   * the HOLES that are LISTED: uncovered spans longer than half a sample interval. A display and shot-assessment
   * rule only; shorter spans are not listed but are counted in uncovered_ms and coverage_ratio.
   */
  gaps: Array<{ start_ms: number; end_ms: number }>
  gaps_truncated: boolean
  /** the total length of the LISTED holes (at most uncovered_ms) */
  gap_total_ms: number
}

export interface EditingPacingWindow {
  start_ms: number
  end_ms: number
  cut_count: number
  cut_density_per_min: number
  /** less than half of the window has frame data */
  partial_window: boolean
}

export type PacingTrend = 'accelerating' | 'steady' | 'decelerating' | 'not_determinable'

export interface EditingMetrics {
  /**
   * what part of the video the numbers describe. `covers_full_duration` is true ONLY for a `complete` analysis
   * whose sample intervals cover [0, duration) EXACTLY (uncovered_ms = 0). Coverage >= 95 % alone is not enough,
   * and a source with timestamp jitter will usually have a few uncovered milliseconds: it is then reported as
   * complete with an exact coverage_ratio below 1, not as covering the full duration.
   */
  scope: { from_ms: number; to_ms: number; covers_full_duration: boolean }
  shot_count: number
  cut_count: number
  /** over the shots that have no data gap inside */
  avg_shot_length_ms: number
  median_shot_length_ms: number
  min_shot_length_ms: number
  max_shot_length_ms: number
  /** cuts per minute of ANALYSED time */
  cut_density_per_min: number
  /** how many shots entered the length statistics */
  shots_in_stats: number
  opening: { window_ms: number; cut_count: number; first_cut_ms: number | null }
  pacing: {
    window_ms: number
    windows: EditingPacingWindow[]
    /** first third vs last third of the analysed time; DESCRIPTIVE, not a quality or retention claim */
    trend: PacingTrend
    trend_basis: string
  }
}

export interface EditingNotAvailable {
  retention_curve: { status: 'not_available'; reason: 'no_training_data_baseline_calibration' }
  style_cluster: { status: 'not_available'; reason: 'no_training_data_baseline_calibration' }
}

export interface EditingAnalysisResult {
  contract_version: typeof EDITING_ANALYSIS_CONTRACT_VERSION
  algorithm_version: typeof EDITING_ALGORITHM_VERSION
  status: EditingAnalysisStatus
  reason_code: EditingReasonCode | null
  /** machine-readable details of a `failed`/`limit_exceeded` outcome (paths and codes only, never raw text) */
  issues: ContractIssue[]
  evidence_basis: {
    kind: 'frame_signature_series'
    /** true only when at least one frame signature was actually examined */
    frame_analysis_performed: boolean
    frames_examined: number
    source_kind: VideoSourceKind | null
  }
  coverage: EditingCoverage | null
  /** the cut timestamps are accurate to +/- this */
  timestamp_resolution_ms: number | null
  cuts: EditingCut[]
  shots: EditingShot[]
  shots_truncated: boolean
  metrics: EditingMetrics | null
  limitations: string[]
  warnings: string[]
  limits_applied: EditingAnalysisLimits | null
  cost: { units_estimated: number; units_consumed: number } | null
  not_available: EditingNotAvailable
}

export const NOT_AVAILABLE: Readonly<EditingNotAvailable> = Object.freeze({
  retention_curve: Object.freeze({ status: 'not_available' as const, reason: 'no_training_data_baseline_calibration' as const }),
  style_cluster: Object.freeze({ status: 'not_available' as const, reason: 'no_training_data_baseline_calibration' as const }),
})

/** What this version of the algorithm cannot see. Always listed in the result, so a UI cannot present more than was measured. */
export const BASE_LIMITATIONS: readonly string[] = Object.freeze([
  'hard_cuts_only',
  'gradual_transitions_not_detected',
  'sampled_signatures_not_every_frame',
  'luminance_histogram_only_no_content_understanding',
])
