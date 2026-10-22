// lib/editing-pattern/validate.ts
// Strict runtime validation of the EditingAnalysis input (the codebase has no schema library, and the
// contract is versioned: unknown keys are rejected so a future field cannot be silently ignored).
import {
  CUT_SENSITIVITIES,
  EDITING_ANALYSIS_CONTRACT_VERSION,
  EDITING_ANALYSIS_HARD_LIMITS,
  MAX_DECLARED_DURATION_MS,
  MAX_SAMPLE_INTERVAL_MS,
  MIN_SAMPLE_INTERVAL_MS,
  MIN_SIGNATURE_BINS,
  VIDEO_SOURCE_KINDS,
  type ContractIssue,
  type CutSensitivity,
  type EditingAnalysisLimits,
  type NormalizedEditingAnalysisInput,
  type VideoSourceKind,
} from './contract'

const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const LIMIT_KEYS: ReadonlyArray<keyof EditingAnalysisLimits> = [
  'max_duration_ms', 'max_frames', 'max_signature_bins', 'max_compute_units', 'deadline_ms', 'max_output_shots',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: ContractIssue[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: path ? `${path}.${key}` : key, code: 'unknown_field' })
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export type InputValidation =
  | { ok: true; input: NormalizedEditingAnalysisInput }
  | { ok: false; issues: ContractIssue[] }

export function validateEditingAnalysisInput(raw: unknown): InputValidation {
  const issues: ContractIssue[] = []
  if (!isRecord(raw)) return { ok: false, issues: [{ path: '', code: 'not_an_object' }] }
  unknownKeys(raw, ['contract_version', 'video', 'sampling', 'params', 'limits'], '', issues)

  if (raw.contract_version !== EDITING_ANALYSIS_CONTRACT_VERSION) issues.push({ path: 'contract_version', code: 'unsupported_contract_version' })

  // video
  let source_kind: VideoSourceKind = 'fixture'
  let source_id = ''
  let duration_ms = 0
  if (!isRecord(raw.video)) issues.push({ path: 'video', code: 'required' })
  else {
    unknownKeys(raw.video, ['source_kind', 'source_id', 'duration_ms'], 'video', issues)
    if (!VIDEO_SOURCE_KINDS.includes(raw.video.source_kind as VideoSourceKind)) issues.push({ path: 'video.source_kind', code: 'invalid_value' })
    else source_kind = raw.video.source_kind as VideoSourceKind
    if (typeof raw.video.source_id !== 'string' || !SOURCE_ID_PATTERN.test(raw.video.source_id)) issues.push({ path: 'video.source_id', code: 'invalid_value' })
    else source_id = raw.video.source_id
    if (!positiveInteger(raw.video.duration_ms) || raw.video.duration_ms > MAX_DECLARED_DURATION_MS) issues.push({ path: 'video.duration_ms', code: 'invalid_value' })
    else duration_ms = raw.video.duration_ms
  }

  // sampling
  let sample_interval_ms = 0
  let signature_bins = 0
  if (!isRecord(raw.sampling)) issues.push({ path: 'sampling', code: 'required' })
  else {
    unknownKeys(raw.sampling, ['sample_interval_ms', 'signature_bins'], 'sampling', issues)
    const interval = raw.sampling.sample_interval_ms
    if (!positiveInteger(interval) || interval < MIN_SAMPLE_INTERVAL_MS || interval > MAX_SAMPLE_INTERVAL_MS) issues.push({ path: 'sampling.sample_interval_ms', code: 'out_of_range' })
    else sample_interval_ms = interval
    const bins = raw.sampling.signature_bins
    if (!positiveInteger(bins) || bins < MIN_SIGNATURE_BINS || bins > EDITING_ANALYSIS_HARD_LIMITS.max_signature_bins) issues.push({ path: 'sampling.signature_bins', code: 'out_of_range' })
    else signature_bins = bins
  }

  // params
  let cut_sensitivity: CutSensitivity = 'normal'
  let min_shot_length_ms = Math.max(300, 2 * sample_interval_ms)
  if (raw.params !== undefined) {
    if (!isRecord(raw.params)) issues.push({ path: 'params', code: 'invalid_value' })
    else {
      unknownKeys(raw.params, ['cut_sensitivity', 'min_shot_length_ms'], 'params', issues)
      if (raw.params.cut_sensitivity !== undefined) {
        if (!CUT_SENSITIVITIES.includes(raw.params.cut_sensitivity as CutSensitivity)) issues.push({ path: 'params.cut_sensitivity', code: 'invalid_value' })
        else cut_sensitivity = raw.params.cut_sensitivity as CutSensitivity
      }
      if (raw.params.min_shot_length_ms !== undefined) {
        const v = raw.params.min_shot_length_ms
        if (!positiveInteger(v) || v < 100 || v > 10_000) issues.push({ path: 'params.min_shot_length_ms', code: 'out_of_range' })
        else min_shot_length_ms = v
      }
    }
  }

  // limits: a request may only tighten the hard caps
  const limits: EditingAnalysisLimits = { ...EDITING_ANALYSIS_HARD_LIMITS }
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) issues.push({ path: 'limits', code: 'invalid_value' })
    else {
      unknownKeys(raw.limits, LIMIT_KEYS as readonly string[], 'limits', issues)
      for (const key of LIMIT_KEYS) {
        const v = raw.limits[key]
        if (v === undefined) continue
        if (!positiveInteger(v)) issues.push({ path: `limits.${key}`, code: 'invalid_value' })
        else if (v > EDITING_ANALYSIS_HARD_LIMITS[key]) issues.push({ path: `limits.${key}`, code: 'above_hard_cap' })
        else limits[key] = v
      }
    }
  }

  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    input: {
      contract_version: EDITING_ANALYSIS_CONTRACT_VERSION,
      video: { source_kind, source_id, duration_ms },
      sampling: { sample_interval_ms, signature_bins },
      params: { cut_sensitivity, min_shot_length_ms },
      limits,
    },
  }
}
