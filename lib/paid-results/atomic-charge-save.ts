// ============================================================
// WILLVIRAL -- Video Package atomic charge+save (2026-10-01 incident follow-up)
// ============================================================
// Thin TS wrapper around the new spend_credits_and_save_paid_result RPC
// (migration 093). This is deliberately a NEW, separate file rather than an
// addition to lib/credits.ts or lib/paid-results/paid-results-service.ts --
// it touches neither, and no other route imports it. ONLY
// app/api/video-package/route.ts uses this.
//
// SCOPE CONTRACT: see migration 093's header comment for the full
// reasoning. In short -- this is safe ONLY because Video Package's existing
// pre-flight cache check (getPaidResultByHashStrict) never re-charges for
// an identical input once a completed paid_results row exists. Do not reuse
// this wrapper, or the RPC it calls, for another route without
// independently verifying that same contract holds there.
import { createServerClient } from '@supabase/ssr'
import type { PaidResultRecord, PaidToolType } from './paid-results-service'

function adminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll() { return [] }, setAll() {} } }
  )
}

export interface AtomicChargeAndSaveInput {
  userId: string
  feature: string
  cost: number
  chargeMetadata: Record<string, unknown>
  toolType: PaidToolType
  inputHash: string
  normalizedInput: string
  originalInput: string
  mainCategory?: string | null
  specificFocus?: string | null
  region?: string | null
  language?: string | null
  platform?: string | null
  resultJson: unknown
  summaryJson?: unknown
  creditCost: number
  freshForHours?: number
  sourceRunId?: string | null
  linkedVideoIdeaId?: string | null
  provider?: string | null
  model?: string | null
  promptTemplateId?: string | null
  promptVersion?: string | null
  estimatedCost?: number | null
}

export type AtomicChargeAndSaveErrorCode =
  | 'insufficient_credits'
  | 'conflicting_incomplete_result'
  | 'unknown'
  // A genuinely AMBIGUOUS outcome: the RPC call failed in a way that is NOT
  // a confirmed Postgres-side rejection -- it may have reached Postgres,
  // committed, and only the RESPONSE was lost (network drop, timeout,
  // DNS failure, connection reset). Unlike every other error code here,
  // this does NOT mean "no charge happened" -- it means "we genuinely don't
  // know." See the `error` branch below for how this is detected.
  | 'uncertain_outcome'

export interface AtomicChargeAndSaveResult {
  success: boolean
  duplicate?: boolean
  paidResult?: PaidResultRecord
  newBalance?: number
  creditTransactionId?: string
  error?: string
  errorCode?: AtomicChargeAndSaveErrorCode
}

// Postgres error code raised by the RPC (migration 093) when a paid_results
// row already exists for (user_id, tool_type, input_hash) with a
// non-'completed' status -- explicit stop, no charge, no overwrite.
const CONFLICTING_INCOMPLETE_RESULT_SQLSTATE = 'P0003'

// CORRECTED (first version was wrong): "non-empty code" is NOT proof of a
// Postgres-side rollback. PostgREST's OWN layer raises its OWN, ALSO
// non-empty error codes (the "PGRST..." family -- e.g. PGRST202 "function
// not found in the schema cache", PGRST003 a PostgREST-side
// connection/pool problem) for failures that happen BEFORE or INSTEAD OF
// our function ever running -- those are not a confirmed Postgres rollback
// of THIS RPC's transaction, they are PostgREST refusing or failing to even
// reach it.
//
// So the check here is an EXPLICIT ALLOWLIST of the exact SQLSTATEs THIS
// RPC (migration 093's spend_credits_and_save_paid_result, including its
// nested call to the existing spend_credits) is actually known to raise
// from inside an executed, then-aborted transaction:
//   P0001 -- generic RAISE EXCEPTION default (our own guard clauses, and
//            spend_credits' own "insufficient credits" with explicit
//            USING ERRCODE = 'P0001')
//   P0003 -- our own "conflicting incomplete result" (step 2)
//   P0004 -- our own feature/cost self-consistency guard (step 0)
//   23505 -- unique_violation from the plain, no-ON-CONFLICT paid_results
//            INSERT colliding with a concurrent writer (step 5)
// Anything else -- a PGRST* code, an unrecognized/unexpected SQLSTATE we
// have no documented reason to expect from this function, or no code at
// all -- is treated as UNCERTAIN, not confirmed. This fails CLOSED on the
// side of caution: a code we don't specifically recognize might indicate
// the request never reached our function (PostgREST-layer), so defaulting
// to "confirmed no charge" for anything unfamiliar would risk the exact
// mistake this exists to prevent. If a future change to the migration adds
// a new RAISE EXCEPTION ... USING ERRCODE, it must be added here too, or
// that new failure mode will be (safely, conservatively) reported as
// uncertain rather than confirmed.
const KNOWN_ROLLBACK_SQLSTATES = new Set(['P0001', 'P0003', 'P0004', '23505'])

// Where the manual reconciliation protocol for an uncertain outcome lives.
const RECONCILIATION_RUNBOOK = 'docs/operations/video-package-uncertain-outcome-reconciliation.md'

function isConfirmedRollback(errorCode: unknown): boolean {
  return typeof errorCode === 'string' && KNOWN_ROLLBACK_SQLSTATES.has(errorCode)
}

export async function chargeFeatureAndSavePaidResult(input: AtomicChargeAndSaveInput): Promise<AtomicChargeAndSaveResult> {
  const admin = adminClient()
  const freshUntil = input.freshForHours
    ? new Date(Date.now() + input.freshForHours * 3600000).toISOString()
    : null

  // This function must NEVER let an exception propagate to its caller --
  // route.ts has its own OUTER catch that responds with a generic
  // "Generálás sikertelen. Próbáld újra." (see app/api/video-package/
  // route.ts), which is WRONG specifically for an uncertain-outcome case
  // (it would encourage an immediate retry right when we must not). An
  // unexpectedly thrown/rejected call here (not even a resolved {error}
  // shape -- e.g. the underlying fetch promise itself rejecting in a way
  // the Supabase client doesn't normalize) is the MOST ambiguous case of
  // all: there is no `code` to inspect at all, so it is always uncertain.
  // Recorded so a later, manual reconciliation (see RECONCILIATION_RUNBOOK)
  // can bound WHEN the attempt may have written -- the log alone proves nothing.
  const attemptStartedAtMs = Date.now()
  const attemptStartedAt = new Date(attemptStartedAtMs).toISOString()
  let data: unknown
  let error: { code?: string; message?: string } | null
  try {
    const rpcResult = await admin.rpc('spend_credits_and_save_paid_result', {
      p_user_id: input.userId,
      p_feature: input.feature,
      p_cost: input.cost,
      p_charge_metadata: input.chargeMetadata,
      p_tool_type: input.toolType,
      p_input_hash: input.inputHash,
      p_normalized_input: input.normalizedInput,
      p_original_input: input.originalInput,
      p_main_category: input.mainCategory ?? null,
      p_specific_focus: input.specificFocus ?? null,
      p_region: input.region ?? null,
      p_language: input.language ?? null,
      p_platform: input.platform ?? null,
      p_result_json: input.resultJson,
      p_summary_json: input.summaryJson ?? {},
      p_credit_cost: input.creditCost,
      p_fresh_until: freshUntil,
      p_provider: input.provider ?? null,
      p_model: input.model ?? null,
      p_prompt_template_id: input.promptTemplateId ?? null,
      p_prompt_version: input.promptVersion ?? null,
      p_estimated_cost: input.estimatedCost ?? null,
      p_source_run_id: input.sourceRunId ?? null,
      p_linked_video_idea_id: input.linkedVideoIdeaId ?? null,
    })
    data = rpcResult.data
    error = rpcResult.error
  } catch (thrown) {
    console.error('[AtomicChargeAndSave] BIZONYTALAN KIMENET -- a híváskísérlet váratlanul kivételt dobott (nem strukturált {error} válasz). NEM állapítható meg, hogy a tranzakció ténylegesen commitolt-e. Kézi ellenőrzés szükséges, mielőtt bármilyen újrapróbálás történne.', {
      userId: input.userId,
      feature: input.feature,
      toolType: input.toolType,
      inputHash: input.inputHash,
      attemptStartedAt,
      elapsedMs: Date.now() - attemptStartedAtMs,
      thrown: thrown instanceof Error ? thrown.message : String(thrown),
      reconciliation: RECONCILIATION_RUNBOOK,
    })
    return {
      success: false,
      error: 'A kérés állapota bizonytalan -- nem lehet megállapítani, hogy a mentés megtörtént-e. Ne indíts új kísérletet; az esetet naplóztuk, és kézi ellenőrzés szükséges.',
      errorCode: 'uncertain_outcome',
    }
  }

  if (error) {
    // This log always runs OUTSIDE the RPC's own transaction (which, if it
    // ran at all, is already either committed or rolled back by the time we
    // see this) -- our own separate call, as required. No secrets, no full
    // generated content (resultJson is deliberately NOT included).
    const message = String(error.message || '')
    const logContext: Record<string, unknown> = {
      userId: input.userId,
      feature: input.feature,
      toolType: input.toolType,
      inputHash: input.inputHash,
      postgresCode: error.code,
      message,
      attemptStartedAt,
      elapsedMs: Date.now() - attemptStartedAtMs,
    }

    if (!isConfirmedRollback(error.code)) {
      // UNCERTAIN: not a confirmed Postgres-side rejection (see
      // isConfirmedRollback). We do NOT know whether the charge+save
      // committed, is still running, or will commit later -- a lost response
      // does not stop the original transaction. Do not claim anything to the
      // log or the user, and trigger no automatic retry, refund or new
      // generation. Neither "a paid_results row exists" nor "none exists
      // right now" settles it on its own: see the careful primary-DB
      // reconciliation protocol in the runbook named by
      // RECONCILIATION_RUNBOOK. This console.error is NOT a durable incident
      // log -- it is a best-effort, retention-bounded platform log that only
      // says where to start looking.
      logContext.reconciliation = RECONCILIATION_RUNBOOK
      console.error('[AtomicChargeAndSave] BIZONYTALAN KIMENET -- hálózati/timeout jellegű hiba, NEM állapítható meg, hogy a tranzakció ténylegesen commitolt-e. Kézi ellenőrzés szükséges, mielőtt bármilyen újrapróbálás történne.', logContext)
      return {
        success: false,
        error: 'A kérés állapota bizonytalan -- nem lehet megállapítani, hogy a mentés megtörtént-e. Ne indíts új kísérletet; az esetet naplóztuk, és kézi ellenőrzés szükséges.',
        errorCode: 'uncertain_outcome',
      }
    }

    // CONFIRMED: a genuine, Postgres-raised error -- the whole transaction,
    // debit included, is definitely rolled back.
    const insufficientCredits = message.includes('insufficient credits')
    const conflictingIncomplete = error.code === CONFLICTING_INCOMPLETE_RESULT_SQLSTATE
    console.error('[AtomicChargeAndSave] KRITIKUS: a tranzakció megerősítetten visszagördült, nincs levonás', logContext)
    return {
      success: false,
      error: insufficientCredits
        ? 'Nincs elég kredited ehhez a művelethez.'
        : conflictingIncomplete
        ? 'Ehhez a bemenethez már létezik egy korábbi, nem befejezett mentés. Az eset naplózva, kredit nem került levonásra.'
        : 'A mentés sikertelen volt. Kredit nem került levonásra.',
      errorCode: insufficientCredits ? 'insufficient_credits' : conflictingIncomplete ? 'conflicting_incomplete_result' : 'unknown',
    }
  }

  const r = data as Record<string, unknown>
  return {
    success: true,
    duplicate: !!r.duplicate,
    paidResult: r.paid_result as PaidResultRecord,
    newBalance: Number(r.total_balance),
    creditTransactionId: r.credit_transaction_id ? String(r.credit_transaction_id) : undefined,
  }
}
