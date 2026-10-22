// lib/editing-pattern/job-runner.ts
// Editing Pattern Engine -- 1B: ASYNCHRONOUS, IDEMPOTENT execution of an EditingAnalysis.
//
//   submit   validate -> idempotency key -> insert-if-absent. The same owner + the same normalized input +
//            the same contract/algorithm version is ALWAYS the same job: a second submit never starts a
//            second analysis (and, once a billing model exists, can never be charged twice).
//   run      claim (queued, or running with an expired lease) -> analyze -> complete. A claim carries an
//            attempt number; complete/fail are fenced by it, so a worker whose lease expired cannot
//            overwrite the result of the worker that took over.
//
// The store is a PORT. The only adapter in this package is the in-memory reference adapter
// (job-store-memory.ts): state lives and dies with the process. A durable adapter needs a table, i.e. a
// migration and a data-retention decision -- deliberately NOT part of 1A-1B (see the decision points in
// docs/architecture/editing-pattern-engine-1ab.md).
import { createHash } from 'node:crypto'
import { analyzeEditingPattern, type AnalyzeTimers } from './analyzer'
import {
  EDITING_ALGORITHM_VERSION,
  EDITING_ANALYSIS_CONTRACT_VERSION,
  EDITING_ANALYSIS_HARD_LIMITS,
  type ContractIssue,
  type EditingAnalysisResult,
  type FrameSignatureSource,
  type NormalizedEditingAnalysisInput,
} from './contract'
import { validateEditingAnalysisInput } from './validate'

export type EditingJobState = 'queued' | 'running' | 'completed' | 'failed'

export interface EditingAnalysisJob {
  job_id: string
  idempotency_key: string
  owner_id: string
  input: NormalizedEditingAnalysisInput
  state: EditingJobState
  /** how many times the job was claimed */
  attempt: number
  lease_expires_at_ms: number | null
  created_at_ms: number
  updated_at_ms: number
  result: EditingAnalysisResult | null
  error_code: string | null
}

export interface EditingAnalysisJobStore {
  get(jobId: string): Promise<EditingAnalysisJob | null>
  /** Atomic: exactly one concurrent caller creates the job; the others receive it with created=false. */
  insertIfAbsent(job: EditingAnalysisJob): Promise<{ job: EditingAnalysisJob; created: boolean }>
  /**
   * Atomic transition to `running` with attempt+1 -- for a `queued` job, or a `running` job whose lease has expired.
   * Returns null when the job is not claimable (unknown, running with a live lease, terminal, or attempts exhausted).
   */
  claim(jobId: string, nowMs: number, leaseMs: number, maxAttempts: number): Promise<EditingAnalysisJob | null>
  /** Fenced by `attempt`: false when the job has been taken over or is already terminal. */
  complete(jobId: string, attempt: number, result: EditingAnalysisResult, nowMs: number): Promise<boolean>
  /** Fenced by `attempt`. `retry` puts the job back to `queued`, otherwise it becomes `failed`. */
  release(jobId: string, attempt: number, errorCode: string, retry: boolean, nowMs: number): Promise<boolean>
}

export const MAX_JOB_ATTEMPTS = 3
/** longer than the analyzer's own deadline, so a live worker never loses its lease to its own slowness */
export const DEFAULT_LEASE_MS = EDITING_ANALYSIS_HARD_LIMITS.deadline_ms * 2

export interface JobRunnerDeps {
  store: EditingAnalysisJobStore
  source: FrameSignatureSource
  now: () => number
  /** a floor of MIN_LEASE_TO_DEADLINE_RATIO x the job's deadline is applied: a configuration guard, not a guarantee */
  leaseMs?: number
  maxAttempts?: number
  /** injected so the analyzer's deadline race is testable */
  timers?: AnalyzeTimers
}

/** The lease is never shorter than this multiple of the job's own analysis deadline. */
export const MIN_LEASE_TO_DEADLINE_RATIO = 2

// ───────────────────────────── idempotency ─────────────────────────────
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/** The key covers everything that can change the result: owner, versions and the NORMALIZED input (defaults and limits resolved). */
export function editingIdempotencyKey(ownerId: string, input: NormalizedEditingAnalysisInput): string {
  return createHash('sha256')
    .update(canonicalJson({ v: 1, owner: ownerId, contract: EDITING_ANALYSIS_CONTRACT_VERSION, algorithm: EDITING_ALGORITHM_VERSION, input }))
    .digest('hex')
}

export function editingJobIdFor(key: string): string {
  return `eaj_${key.slice(0, 32)}`
}

// ───────────────────────────── submit ─────────────────────────────
export type SubmitResult =
  | { ok: true; job_id: string; state: EditingJobState; created: boolean }
  | { ok: false; code: 'invalid_input' | 'invalid_owner'; issues: ContractIssue[] }

export async function submitEditingAnalysis(deps: Pick<JobRunnerDeps, 'store' | 'now'>, ownerId: string, rawInput: unknown): Promise<SubmitResult> {
  if (typeof ownerId !== 'string' || ownerId.length === 0 || ownerId.length > 128) {
    return { ok: false, code: 'invalid_owner', issues: [{ path: 'owner_id', code: 'invalid_value' }] }
  }
  const validated = validateEditingAnalysisInput(rawInput)
  if (!validated.ok) return { ok: false, code: 'invalid_input', issues: validated.issues }
  const key = editingIdempotencyKey(ownerId, validated.input)
  const nowMs = deps.now()
  const candidate: EditingAnalysisJob = {
    job_id: editingJobIdFor(key),
    idempotency_key: key,
    owner_id: ownerId,
    input: validated.input,
    state: 'queued',
    attempt: 0,
    lease_expires_at_ms: null,
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    result: null,
    error_code: null,
  }
  const { job, created } = await deps.store.insertIfAbsent(candidate)
  return { ok: true, job_id: job.job_id, state: job.state, created }
}

// ───────────────────────────── run ─────────────────────────────
export type RunOutcome =
  | { ran: false; reason: 'not_claimable' }
  | { ran: true; state: EditingJobState; status: EditingAnalysisResult['status'] | null; requeued: boolean }

/** Failures that may be transient (the source could not deliver). Every other outcome is a deterministic function of the input. */
const RETRYABLE_REASONS = new Set<string>(['source_error'])

export async function runEditingAnalysisJob(deps: JobRunnerDeps, jobId: string, options: { signal?: AbortSignal } = {}): Promise<RunOutcome> {
  const maxAttempts = deps.maxAttempts ?? MAX_JOB_ATTEMPTS
  // the configured lease can only be raised to a multiple of the deadline, never lowered below it. It remains
  // a configuration guard: a slow store call can still outlast the lease, and the fenced complete() then refuses.
  const peek = await deps.store.get(jobId)
  const deadlineMs = peek?.input.limits.deadline_ms ?? EDITING_ANALYSIS_HARD_LIMITS.deadline_ms
  const leaseMs = Math.max(deps.leaseMs ?? DEFAULT_LEASE_MS, deadlineMs * MIN_LEASE_TO_DEADLINE_RATIO)
  const job = await deps.store.claim(jobId, deps.now(), leaseMs, maxAttempts)
  if (!job) return { ran: false, reason: 'not_claimable' }

  const result = await analyzeEditingPattern(job.input, deps.source, { now: deps.now, signal: options.signal, timers: deps.timers })
  const retryable = result.status === 'failed' && result.reason_code !== null && RETRYABLE_REASONS.has(result.reason_code)
  if (retryable && job.attempt < maxAttempts) {
    await deps.store.release(job.job_id, job.attempt, result.reason_code as string, true, deps.now())
    return { ran: true, state: 'queued', status: null, requeued: true }
  }
  const stored = await deps.store.complete(job.job_id, job.attempt, result, deps.now())
  // a false here means the lease expired and another worker took over: this result is discarded, theirs stands
  if (!stored) return { ran: true, state: 'running', status: null, requeued: false }
  return { ran: true, state: result.status === 'failed' ? 'failed' : 'completed', status: result.status, requeued: false }
}
