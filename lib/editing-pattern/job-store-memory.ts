// lib/editing-pattern/job-store-memory.ts
// In-memory REFERENCE adapter of EditingAnalysisJobStore. State is lost with the process: it is a specification
// of the store semantics (atomic insert-if-absent, attempt-fenced claim/complete) for tests and local use,
// NOT a production store. A durable store needs a migration + a retention decision (see the architecture doc).
import type { EditingAnalysisJob, EditingAnalysisJobStore } from './job-runner'
import type { EditingAnalysisResult } from './contract'

export class InMemoryEditingJobStore implements EditingAnalysisJobStore {
  private readonly jobs = new Map<string, EditingAnalysisJob>()

  async get(jobId: string): Promise<EditingAnalysisJob | null> {
    const job = this.jobs.get(jobId)
    return job ? structuredClone(job) : null
  }

  async insertIfAbsent(job: EditingAnalysisJob): Promise<{ job: EditingAnalysisJob; created: boolean }> {
    const existing = this.jobs.get(job.job_id)
    if (existing) return { job: structuredClone(existing), created: false }
    this.jobs.set(job.job_id, structuredClone(job))
    return { job: structuredClone(job), created: true }
  }

  async claim(jobId: string, nowMs: number, leaseMs: number, maxAttempts: number): Promise<EditingAnalysisJob | null> {
    const job = this.jobs.get(jobId)
    if (!job) return null
    const leaseExpired = job.state === 'running' && (job.lease_expires_at_ms ?? 0) <= nowMs
    if (job.state !== 'queued' && !leaseExpired) return null
    if (job.attempt >= maxAttempts) {
      job.state = 'failed'
      job.error_code = 'attempts_exhausted'
      job.lease_expires_at_ms = null
      job.updated_at_ms = nowMs
      return null
    }
    job.state = 'running'
    job.attempt += 1
    job.lease_expires_at_ms = nowMs + leaseMs
    job.updated_at_ms = nowMs
    return structuredClone(job)
  }

  async complete(jobId: string, attempt: number, result: EditingAnalysisResult, nowMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running' || job.attempt !== attempt) return false
    job.state = result.status === 'failed' ? 'failed' : 'completed'
    job.result = structuredClone(result)
    job.error_code = result.status === 'failed' ? result.reason_code : null
    job.lease_expires_at_ms = null
    job.updated_at_ms = nowMs
    return true
  }

  async release(jobId: string, attempt: number, errorCode: string, retry: boolean, nowMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.state !== 'running' || job.attempt !== attempt) return false
    job.state = retry ? 'queued' : 'failed'
    job.error_code = errorCode
    job.lease_expires_at_ms = null
    job.updated_at_ms = nowMs
    return true
  }
}
