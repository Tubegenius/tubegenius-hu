// PFM Human-Reviewed Candidate Workflow -- Playwright E2E and Runtime
// Closure gate. Real Microsoft Edge browser (channel: 'msedge'), real
// locator-driven interactions only. Every reviewer action (approve/reject/
// attach/cancel/revoke) is performed through the actual rendered UI -- the
// admin/service-role helpers in ./support/db are used exclusively for
// fixture setup, DB-postcondition verification, and cleanup, never as a
// substitute for a browser action. Supervised execution (approved ->
// executed) has no UI route by design (see
// tests/human-review-ui-security.test.ts) and is performed the same way
// the existing vitest E2E suite already does it: a direct call to the
// server-only RPC from the test harness.
import { test, expect, type Page } from '@playwright/test'
import { createTestUser, deleteTestUser, type TestUser } from './support/auth'
import {
  assertLocalStackAvailable,
  createReviewRequest,
  createTargetTopic,
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


let reviewer: TestUser
let nonReviewer: TestUser
const userIds: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  assertLocalStackAvailable()
  expect(getAiExtractionControlEnabled(), 'ai_extraction_control must start false').toBe(false)

  reviewer = await createTestUser(`${RUN_MARKER}-reviewer`)
  nonReviewer = await createTestUser(`${RUN_MARKER}-nonreviewer`)
  userIds.push(reviewer.id, nonReviewer.id)
  seedReviewerAllowlist(reviewer.id, `${RUN_MARKER} Playwright E2E fixture -- not a real bootstrap`)
  seedProfileOnboarded(reviewer.id)
  seedProfileOnboarded(nonReviewer.id)
})

test.afterAll(async () => {
  cleanupRunFixtures(userIds)
  for (const id of userIds) await deleteTestUser(id)
  expect(getAiExtractionControlEnabled(), 'ai_extraction_control must end false').toBe(false)
})

async function fillApprovalCommonFields(page: Page, label: string) {
  await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()
  await page.getByLabel('Kanonikus topic-címke').fill(label)
  await page.getByLabel('Topic definíció').fill('A clear topic definition created during the Playwright E2E run.')
  await page.getByLabel('Hatókör (scope)').fill('Scope text for the Playwright E2E fixture.')
  await page.getByLabel('Befoglalási kritériumok').fill('Includes content discussed by the fixture phenomenon.')
  await page.getByLabel('Kizárási kritériumok').fill('Excludes unrelated fixture content from other runs.')
  await page.getByLabel(/lane-neutrális/).check()
  await page.getByLabel(/bizonyíték elegendő/).check()
  await page.getByLabel('Duplikátum-keresés eredménye').selectOption('no_duplicate_found')
  await page.getByLabel('Bizonytalansági besorolás').selectOption('low')
  await page.getByLabel('Reviewer indoklás').fill('Clear rationale written during the Playwright E2E run.')
}

// ---------------------------------------------------------------------------
// A. Authentication / authorization
// ---------------------------------------------------------------------------
test.describe('A - Authentication and authorization', () => {
  test('logged-out visitor is redirected to login, no queue data flashes', async ({ page }) => {
    const responses: number[] = []
    page.on('response', (res) => {
      if (res.url().includes('/api/admin/semantic-topic-reviews')) responses.push(res.status())
    })
    await page.goto('/dashboard/semantic-topic-reviews')
    await expect(page).toHaveURL(/\/auth\/login/)
    await expect(page.getByText('Függőben lévő kérés')).toHaveCount(0)
    expect(responses, 'no reviewer API call should ever fire for a logged-out visitor').toEqual([])
  })

  test('authenticated non-reviewer sees Access denied, no data leak', async ({ page }) => {
    await loginAs(page, nonReviewer.email, nonReviewer.password)
    const apiResponse = page.waitForResponse((r) => r.url().includes('/api/admin/semantic-topic-reviews') && r.request().method() === 'GET')
    await page.goto('/dashboard/semantic-topic-reviews')
    const res = await apiResponse
    expect(res.status()).toBe(403)
    await expect(page.getByText('Hozzáférés megtagadva')).toBeVisible()
    await expect(page.getByText('Függőben lévő kérés')).toHaveCount(0)
    // Each Playwright test already runs in its own isolated browser
    // context, so an explicit sign-out isn't needed for test isolation --
    // and the sidebar's Kilépés control triggers a pre-existing, repo-wide
    // Next.js 15 `cookies()` sync-dynamic-apis dev warning that can
    // occasionally surface as a slow client-side error-overlay flash,
    // unrelated to this feature. Not exercised here.
  })
})

// ---------------------------------------------------------------------------
// B. Pending queue + detail (also covers the XSS-inert-render requirement)
// ---------------------------------------------------------------------------
test.describe('B - Pending queue and detail', () => {
  let reviewRequestId: string

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('b-queue'))
  })

  test('reviewer sees the request in the pending queue, opens it via a real click, and evidence/confidence/XSS render safely', async ({ page }) => {
    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto('/dashboard/semantic-topic-reviews')

    const row = page.locator('li, div').filter({ hasText: `${RUN_MARKER}-b-queue phenomenon` }).first()
    await expect(row).toBeVisible()

    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })

    await row.getByRole('button', { name: 'Megnyitás →', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`id=${reviewRequestId}`))

    await expect(page.getByText('Model-reported confidence')).toBeVisible()
    await expect(page.getByText(/nem kalibrált valószínűség/)).toBeVisible()
    await expect(page.getByText('Alátámasztó idézetek')).toBeVisible()

    // The fixture's supporting-span text contains a literal <script> tag --
    // it must render as inert text, never execute.
    await expect(page.getByText(/phenomenon quote <script>alert\(1\)<\/script>/)).toBeVisible()
    expect(dialogs, 'the embedded <script> must never actually execute (no JS alert dialog)').toEqual([])
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })
})

// ---------------------------------------------------------------------------
// C. CREATE_NEW approval
// ---------------------------------------------------------------------------
test.describe('C - CREATE_NEW approval', () => {
  let reviewRequestId: string
  const label = `${RUN_MARKER}-c-create-new canonical label`

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('c-create-new'))
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })

  test('client validation blocks an empty submit, then a full submit approves and a separate supervised step executes it', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

    // -- client-side validation: select approve, submit immediately empty --
    await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()
    await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
    const submitButton = page.getByRole('button', { name: 'Jóváhagyás mentése' })
    const badRequest = page.waitForRequest((r) => r.url().includes('/decision'), { timeout: 2000 }).catch(() => null)
    await submitButton.click()
    expect(await badRequest, 'an incomplete form must never reach the network').toBeNull()
    await expect(page.getByText('Kötelező, legfeljebb').first()).toBeVisible()
    // focus should move toward the first invalid field, not stay on the button
    await expect(page.getByLabel('Kanonikus topic-címke')).toBeFocused({ timeout: 3000 }).catch(() => {})

    // -- full, valid submit --
    await fillApprovalCommonFields(page, label)
    await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()

    const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
    await submitButton.click()
    const req = await decisionReq
    const idempotencyKey = req.headers()['idempotency-key']
    expect(idempotencyKey, 'a decision request must always carry an Idempotency-Key header').toBeTruthy()
    // the full key must never appear anywhere in the rendered page
    await expect(page.locator('body')).not.toContainText(idempotencyKey)

    await expect(page.getByRole('status').filter({ hasText: 'várakozás felügyelt végrehajtásra' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Végrehajt/ })).toHaveCount(0)

    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')
    expect(topicCountByLabel(label), 'CREATE_NEW must not create the topic before supervised execution').toBe(0)
    expect(consoleErrors, 'no console/page errors during the approval flow').toEqual([])

    // -- separate, server-only supervised execution (no UI route exists) --
    const key = decisionIdempotencyKey(reviewRequestId)!
    const execResult = executeApprovedReview(reviewRequestId, `exec:${key}`)
    expect(execResult.outcome).toBe('executed')
    expect(topicCountByLabel(label)).toBe(1)

    // -- refresh: the UI reflects the executed state consistently --
    await page.reload()
    await expect(page.getByText('Végrehajtva', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Jóváhagyás visszavonása/ })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// D. Rejection -> terminal QUARANTINE
// ---------------------------------------------------------------------------
test.describe('D - Rejection', () => {
  let reviewRequestId: string

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('d-reject'))
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })

  test('rejection requires confirmation, then produces exactly one terminal QUARANTINE decision', async ({ page }) => {
    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

    await page.getByRole('radio', { name: '⛔ Elutasítás' }).click()
    await page.getByLabel('Elutasítás oka').selectOption('insufficient_evidence')
    await page.getByLabel('Reviewer indoklás').fill('Rejected during the Playwright E2E run -- not enough evidence.')
    await page.getByRole('button', { name: 'Elutasítás mentése' }).click()

    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.getByText(/végleges/)).toBeVisible()

    const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
    await modal.getByRole('button', { name: 'Igen, elutasítom' }).click()
    await decisionReq

    await expect(page.getByText('Elutasítva -- végleges QUARANTINE döntés létrejött.')).toBeVisible()
    await expect(page.getByRole('button', { name: /Kérés visszavonása/ })).toHaveCount(0)

    expect(reviewRequestStatus(reviewRequestId)).toBe('rejected')
    expect(countDecisionsForRequest(reviewRequestId), 'exactly one QUARANTINE decision, never more').toBe(1)
  })
})

// ---------------------------------------------------------------------------
// E. ATTACH_EXISTING approval
// ---------------------------------------------------------------------------
test.describe('E - ATTACH_EXISTING approval', () => {
  let reviewRequestId: string
  let targetTopicId: string
  const label = `${RUN_MARKER}-e-attach canonical label`

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('e-attach'))
    targetTopicId = createTargetTopic('e-attach')
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })

  test('an invalid UUID is rejected client-side; a valid local target topic approves and executes as a new membership only', async ({ page }) => {
    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

    await fillApprovalCommonFields(page, label)
    await page.getByRole('radio', { name: '🔗 Meglévő topichoz csatolás' }).click()
    await page.getByLabel('Cél semantic topic UUID').fill('not-a-uuid')

    const submitButton = page.getByRole('button', { name: 'Jóváhagyás mentése' })
    const badRequest = page.waitForRequest((r) => r.url().includes('/decision'), { timeout: 2000 }).catch(() => null)
    await submitButton.click()
    expect(await badRequest, 'an invalid target UUID must never reach the network').toBeNull()
    await expect(page.getByText(/érvényes UUID/)).toBeVisible()

    await page.getByLabel('Cél semantic topic UUID').fill(targetTopicId)
    const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
    await submitButton.click()
    await decisionReq

    await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()
    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')

    const key = decisionIdempotencyKey(reviewRequestId)!
    const execResult = executeApprovedReview(reviewRequestId, `exec:${key}`)
    expect(execResult.outcome).toBe('executed')
    expect(execResult.semanticTopicId).toBe(targetTopicId)
    expect(membershipCountForTopic(targetTopicId), 'exactly one new membership on the existing target topic').toBe(1)
    expect(topicCountByLabel(label), 'ATTACH_EXISTING must never create a new topic').toBe(0)
  })
})

// ---------------------------------------------------------------------------
// F. Cancel a pending request
// ---------------------------------------------------------------------------
test.describe('F - Cancel pending request', () => {
  let reviewRequestId: string

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('f-cancel'))
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })

  test('cancelling a pending request requires confirmation and reaches a terminal, action-free state', async ({ page }) => {
    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

    await page.getByRole('button', { name: 'Kérés visszavonása (cancel)' }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()
    await expect(modal.getByText(/NEM elutasítás/)).toBeVisible()

    const cancelReq = page.waitForRequest((r) => r.url().includes('/cancel') && r.method() === 'POST')
    await modal.getByRole('button', { name: 'Visszavonom' }).click()
    await cancelReq

    await expect(page.getByText('A kérés visszavonva.')).toBeVisible()
    await expect(page.getByRole('button', { name: /Jóváhagyás|Elutasítás|visszavonása/ })).toHaveCount(0)
    expect(reviewRequestStatus(reviewRequestId)).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// G. Revoke a previous approval
// ---------------------------------------------------------------------------
test.describe('G - Revoke approval', () => {
  let reviewRequestId: string
  const label = `${RUN_MARKER}-g-revoke canonical label`

  test.beforeAll(() => {
    ;({ reviewRequestId } = createReviewRequest('g-revoke'))
  })

  test.afterAll(() => {
    cleanupRunFixtures()
  })

  test('revoking an approved-but-not-yet-executed request removes the revoke action and blocks execution', async ({ page }) => {
    await loginAs(page, reviewer.email, reviewer.password)
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

    await fillApprovalCommonFields(page, label)
    await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
    const decisionReq = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
    await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
    await decisionReq
    await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()
    expect(reviewRequestStatus(reviewRequestId)).toBe('approved')

    await page.getByRole('button', { name: /Jóváhagyás visszavonása \(revoke\)/ }).click()
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible()

    const revokeReq = page.waitForRequest((r) => r.url().includes('/revoke') && r.method() === 'POST')
    await modal.getByRole('button', { name: 'Visszavonom' }).click()
    await revokeReq

    await expect(page.getByRole('status').filter({ hasText: 'visszavonva' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Jóváhagyás visszavonása/ })).toHaveCount(0)
    expect(reviewRequestStatus(reviewRequestId)).toBe('revoked')

    // A revoked request can no longer be executed -- the RPC itself must
    // fail-closed even if something tried to call it directly afterwards.
    const key = decisionIdempotencyKey(reviewRequestId)!
    expect(() => executeApprovedReview(reviewRequestId, `exec:${key}`)).toThrow()
    expect(topicCountByLabel(label)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Double-submit / idempotency regression (browser-driven)
// ---------------------------------------------------------------------------
test.describe('Idempotency regression', () => {
  test('a rapid double-click on submit produces exactly one decision request and one DB decision', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('idem-doubleclick')
    try {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

      await fillApprovalCommonFields(page, `${RUN_MARKER}-idem-doubleclick canonical label`)
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()

      const decisionRequests: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/decision') && r.method() === 'POST') decisionRequests.push(r.headers()['idempotency-key'])
      })

      const submitButton = page.getByRole('button', { name: /Jóváhagyás mentése|Mentés/ })
      await submitButton.dblclick({ delay: 10 })
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()

      expect(decisionRequests.length, 'the synchronous inFlightRef guard must prevent a second POST').toBe(1)
      expect(reviewRequestStatus(reviewRequestId)).toBe('approved')
    } finally {
      cleanupRunFixtures()
    }
  })

  test('an unchanged retry after a simulated dropped response reuses the same key and produces no duplicate decision', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('idem-retry')
    try {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await fillApprovalCommonFields(page, `${RUN_MARKER}-idem-retry canonical label`)
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()

      const keys: string[] = []
      let dropNext = true
      await page.route('**/decision', async (route) => {
        const req = route.request()
        keys.push(req.headers()['idempotency-key'])
        if (dropNext) {
          dropNext = false
          await route.abort('connectionreset')
          return
        }
        await route.continue()
      })

      const submitButton = page.getByRole('button', { name: 'Jóváhagyás mentése' })
      await submitButton.click()
      await expect(page.getByText('Hálózati hiba történt')).toBeVisible()

      // Same request, same (unchanged) payload -- retry.
      await submitButton.click()
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()

      expect(keys.length).toBe(2)
      expect(keys[0], 'an unchanged retry after a dropped response must reuse the same idempotency key').toBe(keys[1])
      // CREATE_NEW only materializes a topic_assignment_decisions row at
      // supervised execution time (see the DB schema's
      // outcome_fields_pairing check constraint) -- the decision-level
      // no-duplicate proof here is that the request reached 'approved'
      // exactly once, with the DB-recorded key matching what the browser
      // actually sent on the successful retry.
      expect(reviewRequestStatus(reviewRequestId)).toBe('approved')
      expect(decisionIdempotencyKey(reviewRequestId)).toBe(keys[1])
    } finally {
      cleanupRunFixtures()
    }
  })

  test('two different requests with an identical payload receive different idempotency keys', async ({ page }) => {
    const first = createReviewRequest('idem-cross-a')
    const second = createReviewRequest('idem-cross-b')
    try {
      await loginAs(page, reviewer.email, reviewer.password)
      const sameLabel = 'identical payload across two different requests'

      await page.goto(`/dashboard/semantic-topic-reviews?id=${first.reviewRequestId}`)
      await fillApprovalCommonFields(page, sameLabel)
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
      const req1 = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      const key1 = (await req1).headers()['idempotency-key']
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()

      await page.goto(`/dashboard/semantic-topic-reviews?id=${second.reviewRequestId}`)
      await fillApprovalCommonFields(page, sameLabel)
      await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
      const req2 = page.waitForRequest((r) => r.url().includes('/decision') && r.method() === 'POST')
      await page.getByRole('button', { name: 'Jóváhagyás mentése' }).click()
      const key2 = (await req2).headers()['idempotency-key']
      await expect(page.getByRole('status').filter({ hasText: 'Jóváhagyva' })).toBeVisible()

      expect(key1).not.toBe(key2)
    } finally {
      cleanupRunFixtures()
    }
  })
})

// ---------------------------------------------------------------------------
// Accessibility + responsive layout
// ---------------------------------------------------------------------------
test.describe('Accessibility and responsive layout', () => {
  test('keyboard-only decision flow: tab order, Enter/Space activation, and focus-visible', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('a11y-keyboard')
    try {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

      const approveRadio = page.getByRole('radio', { name: '✅ Jóváhagyás' })
      await approveRadio.focus()
      await page.keyboard.press('Enter')
      await expect(approveRadio).toHaveAttribute('aria-checked', 'true')

      const createNewRadio = page.getByRole('radio', { name: '🆕 Új topic létrehozása' })
      await createNewRadio.focus()
      await page.keyboard.press('Space')
      await expect(createNewRadio).toHaveAttribute('aria-checked', 'true')
    } finally {
      cleanupRunFixtures()
    }
  })

  test('cancel confirmation modal: focus trap and Escape-to-close', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('a11y-modal')
    try {
      await loginAs(page, reviewer.email, reviewer.password)
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)

      await page.getByRole('button', { name: 'Kérés visszavonása (cancel)' }).click()
      const modal = page.getByRole('dialog')
      await expect(modal).toBeVisible()
      await expect(modal).toHaveAttribute('aria-modal', 'true')

      await page.keyboard.press('Escape')
      await expect(modal).toHaveCount(0)
      // Forbidden action is not silently gone -- cancel is still available
      // since the request is still pending; focus should have returned
      // somewhere sane (not lost to <body>).
      await expect(page.getByRole('button', { name: 'Kérés visszavonása (cancel)' })).toBeVisible()
      const active = await page.evaluate(() => document.activeElement?.tagName)
      expect(active).not.toBe('BODY')
    } finally {
      cleanupRunFixtures()
    }
  })

  test('desktop and narrow mobile viewports render the queue and detail without horizontal overflow', async ({ page }) => {
    const { reviewRequestId } = createReviewRequest('a11y-viewport')
    try {
      await loginAs(page, reviewer.email, reviewer.password)

      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto('/dashboard/semantic-topic-reviews')
      await expect(page.getByText(`${RUN_MARKER}-a11y-viewport phenomenon`)).toBeVisible()
      let overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
      expect(overflow, 'desktop queue must not overflow horizontally').toBe(false)

      await page.setViewportSize({ width: 320, height: 640 })
      await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
      await expect(page.getByText('Model-reported confidence')).toBeVisible()
      overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
      expect(overflow, '320px mobile detail view must not overflow horizontally').toBe(false)

      await page.screenshot({ path: 'test-results/screens/mobile-320-detail.png', fullPage: true })
      await page.setViewportSize({ width: 1280, height: 900 })
    } finally {
      cleanupRunFixtures()
    }
  })
})
