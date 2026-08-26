// PFM Reviewer UI -- Playwright E2E and Runtime Closure gate, Section 3:
// diagnose the Browser-pane submit failure BEFORE trusting any full E2E
// scenario. Uses only real Playwright locator actions (fill/check/select/
// click) -- never element.click()/dispatchEvent() and never a direct
// reviewer-API/wrapper call in place of the browser action.
import { test, expect } from '@playwright/test'
import { createTestUser, deleteTestUser } from './support/auth'
import { assertLocalStackAvailable, createReviewRequest, seedReviewerAllowlist, seedProfileOnboarded, cleanupRunFixtures, RUN_MARKER } from './support/db'
import { loginAs } from './support/login'

test.describe('Diagnostic: CREATE_NEW approval submit', () => {
  let reviewerId: string
  let reviewRequestId: string

  test.beforeAll(async () => {
    assertLocalStackAvailable()
    const reviewer = await createTestUser(`${RUN_MARKER}-diag-reviewer`, 'PwTest12345!')
    reviewerId = reviewer.id
    seedReviewerAllowlist(reviewerId, `${RUN_MARKER} diagnostic fixture -- not a real bootstrap`)
    seedProfileOnboarded(reviewerId)
    ;({ reviewRequestId } = createReviewRequest('diag'))
  })

  test.afterAll(async () => {
    cleanupRunFixtures([reviewerId])
    await deleteTestUser(reviewerId)
  })

  test('locator-driven submit either fires the decision request or surfaces a real diagnosable failure', async ({ page }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    await loginAs(page, `${RUN_MARKER}-diag-reviewer@example.test`, 'PwTest12345!')
    await page.goto(`/dashboard/semantic-topic-reviews?id=${reviewRequestId}`)
    await expect(page.getByRole('radio', { name: '✅ Jóváhagyás' })).toBeVisible()

    await page.getByRole('radio', { name: '✅ Jóváhagyás' }).click()

    await page.getByLabel('Kanonikus topic-címke').fill('pw diagnostic canonical label')
    await page.getByLabel('Topic definíció').fill('A clear topic definition created during the Playwright diagnostic run.')
    await page.getByLabel('Hatókör (scope)').fill('Scope text for the Playwright diagnostic fixture.')
    await page.getByLabel('Befoglalási kritériumok').fill('Includes content discussed by the diagnostic phenomenon.')
    await page.getByLabel('Kizárási kritériumok').fill('Excludes unrelated fixture content from other runs.')
    await page.getByLabel(/lane-neutrális/).check()
    await page.getByLabel(/bizonyíték elegendő/).check()
    await page.getByLabel('Duplikátum-keresés eredménye').selectOption('no_duplicate_found')
    await page.getByRole('radio', { name: '🆕 Új topic létrehozása' }).click()
    await page.getByLabel('Bizonytalansági besorolás').selectOption('low')
    await page.getByLabel('Reviewer indoklás').fill('Clear rationale written during the Playwright diagnostic run.')

    const submitButton = page.getByRole('button', { name: 'Jóváhagyás mentése' })
    await expect(submitButton).toBeVisible()

    const isDisabled = await submitButton.isDisabled()
    const formValidity = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Jóváhagyás mentése'))
      const form = btn?.closest('form')
      return form ? form.checkValidity() : 'NO_FORM_ANCESTOR'
    })

    const invalidEvents: string[] = []
    await page.exposeFunction('__pwRecordInvalid', (name: string) => invalidEvents.push(name))
    await page.evaluate(() => {
      document.addEventListener(
        'invalid',
        (e) => {
          const el = e.target as HTMLElement
          ;(window as any).__pwRecordInvalid(el.tagName + '#' + (el as HTMLInputElement).name)
        },
        true,
      )
    })

    const decisionRequestPromise = page
      .waitForRequest((req) => req.url().includes('/decision') && req.method() === 'POST', { timeout: 8_000 })
      .catch(() => null)

    await submitButton.click()

    const decisionRequest = await decisionRequestPromise
    await page.waitForTimeout(1000)

    test.info().annotations.push({ type: 'diagnostic-button-disabled', description: String(isDisabled) })
    test.info().annotations.push({ type: 'diagnostic-form-checkValidity', description: String(formValidity) })
    test.info().annotations.push({ type: 'diagnostic-invalid-events', description: JSON.stringify(invalidEvents) })
    test.info().annotations.push({ type: 'diagnostic-console-errors', description: JSON.stringify(consoleErrors) })
    test.info().annotations.push({ type: 'diagnostic-page-errors', description: JSON.stringify(pageErrors) })
    test.info().annotations.push({ type: 'diagnostic-decision-request-fired', description: String(decisionRequest !== null) })

    // The assertion itself is the diagnosis: if this fails, the annotations
    // above (visible in the HTML report / test output) carry the exact
    // root-cause signal -- disabled button, failed HTML5 validation,
    // thrown pageerror, or a genuinely silent no-op.
    expect(decisionRequest, `decision POST did not fire -- disabled=${isDisabled} validity=${formValidity} invalidEvents=${JSON.stringify(invalidEvents)} consoleErrors=${JSON.stringify(consoleErrors)} pageErrors=${JSON.stringify(pageErrors)}`).not.toBeNull()
  })
})
