// PFM Human-Reviewed Candidate Workflow -- Supervised Local Pilot.
//
// A technical, felügyelt (supervised) local pilot through the real reviewer
// UI (Microsoft Edge via Playwright), proving the operator workflow across
// >=10 semantically varied candidates covering every reviewer decision type
// (CREATE_NEW, ATTACH_EXISTING, REJECT, CANCEL, REVOKE) plus the existing
// eligibility-gate contract's edge cases (invalid structured output, generic
// specificity, missing supporting spans, confidence at/above the existing
// 0.8500 ceiling, already-assigned extraction, idempotent replay). No new
// confidence threshold is introduced anywhere in this file -- the 0.8500
// ceiling is read from the same RPC contract exercised in 078, never
// hardcoded as a new business rule here.
//
// Every candidate is created through the canonical RPCs
// (record_topic_extraction_run / create_topic_assignment_review_request),
// exactly like tests/semantic-topic-human-review-rpcs-db-integration.test.ts
// already does. Reviewer decisions (approve/reject/cancel/revoke) are
// performed exclusively through real browser interaction with the actual
// UI. Supervised execution (approved -> executed) has no UI route by
// design and is performed via the same direct RPC call the existing
// vitest E2E suite and the human-review-workflow.spec.ts regression suite
// already use.
import { test, expect } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/auth'
import {
  assertLocalStackAvailable,
  createExtraction,
  createReviewRequest,
  createTargetTopic,
  attemptCreateReviewRequest,
  seedReviewerAllowlist,
  seedProfileOnboarded,
  cleanupRunFixtures,
  executeApprovedReview,
  reviewRequestStatus,
  decisionIdempotencyKey,
  countDecisionsForRequest,
  membershipCountForTopic,
  topicCountByLabel,
  getAiExtractionControlEnabled,
  RUN_MARKER,
} from './support/db'
import { loginAs } from './support/login'

const REVIEW_CONFIDENCE_CEILING = 0.85 // read from the 078 RPC contract, never invented here

let reviewer: TestUser
const userIds: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  assertLocalStackAvailable()
  expect(getAiExtractionControlEnabled(), 'ai_extraction_control must start false').toBe(false)
  reviewer = await createTestUser(`${RUN_MARKER}-pilot-reviewer`)
  userIds.push(reviewer.id)
  seedReviewerAllowlist(reviewer.id, `${RUN_MARKER} supervised local pilot -- not a real bootstrap`)
  seedProfileOnboarded(reviewer.id)
})

test.afterAll(async () => {
  cleanupRunFixtures(userIds)
  for (const id of userIds) await deleteTestUser(id)
  expect(getAiExtractionControlEnabled(), 'ai_extraction_control must end false').toBe(false)
})

// ---------------------------------------------------------------------------
// Section 1: eligibility gate -- RPC-level, exactly as the real
// human-review-extraction-hook.ts caller would exercise it. No browser
// involved: these are not reviewer decisions, they are the pipeline's own
// eligibility gate proving candidates never reach the queue when they
// shouldn't.
// ---------------------------------------------------------------------------
test.describe('Eligibility gate (pipeline-level, pre-queue)', () => {
  test('invalid structured output (null specificity) is ineligible', () => {
    // The extraction-run table's own completed_fields_pairing constraint
    // requires a non-null top-level confidence column (derived from
    // structured_output.confidence) whenever status='completed' -- so a
    // null *confidence* can never even reach a completed extraction row.
    // The review-request RPC's own INVALID_STRUCTURED_OUTPUT guard is for
    // the JSONB payload itself being malformed in a way that check doesn't
    // cover: here, a present-but-null specificity field (kept confidence
    // valid so the extraction row itself is legally completed).
    const { extractionRunId } = createExtraction('pilot-06-invalid-output', {
      canonical_phenomenon_label: 'Malformed extraction fixture',
      specificity: null,
    })
    const result = attemptCreateReviewRequest(extractionRunId, `${RUN_MARKER}-pilot-06-req`)
    expect(result.ok).toBe(false)
    expect(result.outcome_kind).toBe('ineligible')
    expect(result.reason_code).toBe('INVALID_STRUCTURED_OUTPUT')
  })

  test('generic specificity is ineligible', () => {
    const { extractionRunId } = createExtraction('pilot-07-generic', {
      canonical_phenomenon_label: 'Generic platform trend',
      specificity: 'generic',
    })
    const result = attemptCreateReviewRequest(extractionRunId, `${RUN_MARKER}-pilot-07-req`)
    expect(result.ok).toBe(false)
    expect(result.outcome_kind).toBe('ineligible')
    expect(result.reason_code).toBe('NOT_SPECIFIC')
  })

  test('no supporting spans is ineligible', () => {
    const { extractionRunId } = createExtraction('pilot-08-no-spans', {
      canonical_phenomenon_label: 'Unsupported claim phenomenon',
      supporting_spans: [],
    })
    const result = attemptCreateReviewRequest(extractionRunId, `${RUN_MARKER}-pilot-08-req`)
    expect(result.ok).toBe(false)
    expect(result.outcome_kind).toBe('ineligible')
    expect(result.reason_code).toBe('NO_SUPPORTING_SPANS')
  })

  test(`confidence at/above the existing ${REVIEW_CONFIDENCE_CEILING} ceiling is ineligible (automatic path, not human review)`, () => {
    const { extractionRunId } = createExtraction('pilot-11-high-confidence', {
      canonical_phenomenon_label: 'High-confidence automatic-path phenomenon',
      confidence: 0.9,
    })
    const result = attemptCreateReviewRequest(extractionRunId, `${RUN_MARKER}-pilot-11-req`)
    expect(result.ok).toBe(false)
    expect(result.outcome_kind).toBe('ineligible')
    expect(result.reason_code).toBe('CONFIDENCE_NOT_REVIEW_ELIGIBLE')
  })

  test('idempotent replay: the same idempotency key on the same extraction returns the same review request, never a duplicate', () => {
    const { extractionRunId } = createExtraction('pilot-10-replay', {
      canonical_phenomenon_label: 'Replay-fixture niche hobby community',
      confidence: 0.68,
    })
    const key = `${RUN_MARKER}-pilot-10-req`
    const first = attemptCreateReviewRequest(extractionRunId, key)
    expect(first.ok).toBe(true)
    expect(first.outcome_kind).toBe('created')

    const second = attemptCreateReviewRequest(extractionRunId, key)
    expect(second.ok).toBe(true)
    expect(second.outcome_kind).toBe('replayed')
    expect(second.review_request_id).toBe(first.review_request_id)
  })
})

// ---------------------------------------------------------------------------
// Section 2: real browser-driven reviewer decisions.
// ---------------------------------------------------------------------------
test.describe('Reviewer decisions (real browser)', () => {
  test('CREATE_NEW: approve a genuinely new topic candidate and execute it', async ({ page }) => {
    const { reviewRequestId, extractionRunId: _r1 } = createReviewRequest('pilot-01-create-new')
    const label = `${RUN_MARKER}-pilot-01 Urban beekeeping renaissance`

    await test.step('reviewer logs in and opens the candidate', async () => {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await expect(page.getByRole('radio', { name: '✅ Jóváhagyás' })).toBeVisible()
    })

    await test.step('reviewer fills the structured approval form for CREATE_NEW', async () => {
      await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()
      await page.getByLabel('Kanonikus topic-címke').fill(label)
      await page.getByLabel('Topic definíció').fill('A community-driven movement of hobbyist urban beekeepers sharing techniques for city rooftop apiaries.')
      await page.getByLabel('Hatókör (scope)').fill('Covers urban/rooftop beekeeping practices, equipment, and community organization.')
      await page.getByLabel('Befoglalási kritériumok').fill('Content specifically about keeping bees in urban/city environments.')
      await page.getByLabel('Kizárási kritériumok').fill('Excludes rural/commercial apiculture unrelated to urban settings.')
      await page.getByLabel(/lane-neutrális/).check()
      await page.getByLabel(/bizonyíték elegendő/).check()
      await page.getByLabel('Duplikátum-keresés eredménye').selectOption('no_duplicate_found')
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
      await page.getByLabel('Bizonytalansági besorolás').selectOption('low')
      await page.getByLabel('Reviewer indoklás').fill('Clear, specific, well-evidenced niche community topic -- approving as a new candidate_singleton.')
    })

    await test.step('reviewer submits and the request reaches approved/awaiting-execution', async () => {
      const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      await decisionReq
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()
      await expect(page.getByRole('button', { name: /Végrehajt/ })).toHaveCount(0)
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')
    expect(topicCountByLabel(label)).toBe(0)

    await test.step('separate supervised execution creates the topic', () => {
      const key = decisionIdempotencyKey(reviewRequestId)!
      const execResult = executeApprovedReview(reviewRequestId, `exec:${key}`)
      expect(execResult.outcome).toBe('executed')
      expect(topicCountByLabel(label)).toBe(1)
    })

    await test.step('page refresh shows the executed state consistently', async () => {
      await page.reload()
      await expect(page.getByText('Végrehajtva', { exact: true })).toBeVisible()
    })
  })

  test('ATTACH_EXISTING: approve attaching a candidate to a genuinely pre-existing topic', async ({ page }) => {
    const targetTopicId = createTargetTopic('pilot-02-target')
    const { reviewRequestId } = createReviewRequest('pilot-02-attach-existing')

    await test.step('reviewer opens the candidate and fills the approval form for ATTACH_EXISTING', async () => {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()
      await page.getByLabel('Kanonikus topic-címke').fill(`${RUN_MARKER}-pilot-02 Sourdough starter maintenance ritual`)
      await page.getByLabel('Topic definíció').fill('Home bakers documenting daily sourdough starter feeding and maintenance routines.')
      await page.getByLabel('Hatókör (scope)').fill('Home sourdough starter care, feeding schedules, and troubleshooting.')
      await page.getByLabel('Befoglalási kritériumok').fill('Directly discusses starter maintenance.')
      await page.getByLabel('Kizárási kritériumok').fill('Excludes general bread-baking content unrelated to starter care.')
      await page.getByLabel(/lane-neutrális/).check()
      await page.getByLabel(/bizonyíték elegendő/).check()
      await page.getByLabel('Duplikátum-keresés eredménye').selectOption('possible_duplicate_reviewed_and_distinct')
      await page.getByRole('radio', { name: '🔗 Meglévő topichoz csatolás' }).click()
      await page.getByLabel('Bizonytalansági besorolás').selectOption('medium')
      await page.getByLabel('Reviewer indoklás').fill('Closely related to an existing fermentation-science topic -- attaching rather than fragmenting.')
    })

    await test.step('an invalid target UUID is rejected client-side before a valid one is accepted', async () => {
      await page.getByLabel('Cél semantic topic UUID').fill('not-a-real-uuid')
      const badReq = page.waitForRequest((r) => r.url().includes('/decision'), { timeout: 2000 }).catch(() => null)
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      expect(await badReq).toBeNull()
      await page.getByLabel('Cél semantic topic UUID').fill(targetTopicId)
    })

    await test.step('valid target submits and approves', async () => {
      const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      await decisionReq
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')

    await test.step('supervised execution creates exactly one new membership on the existing topic, no new topic', () => {
      const key = decisionIdempotencyKey(reviewRequestId)!
      const execResult = executeApprovedReview(reviewRequestId, `exec:${key}`)
      expect(execResult.outcome).toBe('executed')
      expect(execResult.semanticTopicId).toBe(targetTopicId)
      expect(membershipCountForTopic(targetTopicId)).toBe(1)
    })
  })

  let rejectedExtractionRunId: string

  test('REJECT: a fabricated/low-quality candidate is rejected with an audited terminal QUARANTINE', async ({ page }) => {
    const { reviewRequestId, extractionRunId } = createReviewRequest('pilot-03-reject')
    rejectedExtractionRunId = extractionRunId

    await test.step('reviewer selects rejection with a documented reason and rationale', async () => {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await page.getByRole('radio', { name: '⛔ Elutasítás' }).click()
      await page.getByLabel('Elutasítás oka').selectOption('duplicate_without_valid_target')
      await page.getByLabel('Reviewer indoklás').fill('Appears to be a fabricated/astroturfed trend without a credible, distinct target topic.')
      await page.getByRole('button', { name: 'Elutasítás mentése' }).click()
    })

    await test.step('confirmation modal requires explicit confirmation', async () => {
      const modal = page.getByRole('dialog')
      await expect(modal).toBeVisible()
      const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await modal.getByRole('button', { name: 'Igen, elutasítom' }).click()
      await decisionReq
      await expect(page.getByText('Elutasítva -- végleges QUARANTINE döntés létrejött.')).toBeVisible()
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('rejected')
    expect(countDecisionsForRequest(reviewRequestId)).toBe(1)
  })

  test('already-assigned: a second review-request attempt on the now-decided extraction is blocked', () => {
    expect(rejectedExtractionRunId, 'depends on the REJECT case above having run first (serial mode)').toBeTruthy()
    const result = attemptCreateReviewRequest(rejectedExtractionRunId, `${RUN_MARKER}-pilot-09-req`)
    expect(result.ok).toBe(false)
    expect(result.outcome_kind).toBe('blocked')
    expect(result.reason_code).toBe('ALREADY_ASSIGNED')
  })

  test('CANCEL: a pending candidate is withdrawn from the queue without a decision', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('pilot-04-cancel')

    await test.step('reviewer cancels the pending request with confirmation', async () => {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await page.getByRole('button', { name: 'Kérés visszavonása (cancel)' }).click()
      const modal = page.getByRole('dialog')
      await expect(modal).toBeVisible()
      const cancelReq = page.waitForRequest((r) => r.url().includes('/cancel') && r.method() === 'POST')
      await modal.getByRole('button', { name: 'Visszavonom' }).click()
      await cancelReq
      await expect(page.getByText('A kérés visszavonva.')).toBeVisible()
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('cancelled')
    expect(countDecisionsForRequest(reviewRequestId), 'cancel must never produce a decision').toBe(0)
  })

  test('REVOKE: an approved-but-not-yet-executed candidate is pulled back, blocking execution', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('pilot-05-revoke')
    const label = `${RUN_MARKER}-pilot-05 Competitive speedcubing technique innovations`

    await test.step('reviewer approves as CREATE_NEW', async () => {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()
      await page.getByLabel('Kanonikus topic-címke').fill(label)
      await page.getByLabel('Topic definíció').fill('New finger-trick and lubrication techniques emerging in competitive speedcubing.')
      await page.getByLabel('Hatókör (scope)').fill('Competitive speedcubing technique and equipment innovation.')
      await page.getByLabel('Befoglalási kritériumok').fill('Directly discusses competitive solving technique.')
      await page.getByLabel('Kizárási kritériumok').fill('Excludes casual/recreational cubing content.')
      await page.getByLabel(/lane-neutrális/).check()
      await page.getByLabel(/bizonyíték elegendő/).check()
      await page.getByLabel('Duplikátum-keresés eredménye').selectOption('no_duplicate_found')
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
      await page.getByLabel('Bizonytalansági besorolás').selectOption('low')
      await page.getByLabel('Reviewer indoklás').fill('Approving, but flagging for a second opinion before execution -- will revoke pending that.')
      const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      await decisionReq
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')

    await test.step('reviewer revokes before execution', async () => {
      await page.getByRole('button', { name: /Jóváhagyás visszavonása \(revoke\)/ }).click()
      const modal = page.getByRole('dialog')
      await expect(modal).toBeVisible()
      const revokeReq = page.waitForRequest((r) => r.url().includes('/revoke') && r.method() === 'POST')
      await modal.getByRole('button', { name: 'Visszavonom' }).click()
      await revokeReq
      await expect(page.getByRole('status').filter({ hasText: 'visszavonva' })).toBeVisible()
    })

    expect(reviewRequestStatus(reviewRequestId)).toBe('revoked')

    await test.step('execution now fails closed', () => {
      const key = decisionIdempotencyKey(reviewRequestId)!
      expect(() => executeApprovedReview(reviewRequestId, `exec:${key}`)).toThrow()
      expect(topicCountByLabel(label)).toBe(0)
    })
  })
})
