// A kliensoldali kreditkapu tiszta logikája (lib/video-package-credit-gate.ts) és az oldal huzalozásának STATIKUS
// ellenőrzése. A tényleges megjelenítést és az interakciót renderelt tesztek fedik:
// tests/video-package-credit-modal.test.tsx (az ablak) és tests/video-package-credit-gate-page.test.tsx (a teljes oldal).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildVideoPackageCreditCheck,
  creditModalCopy,
  insufficientCreditsNoCachedResultMessage,
  newGenerationCostNote,
} from '@/lib/video-package-credit-gate'

const FEATURE = 'Video Package (Long)'

describe('buildVideoPackageCreditCheck: three situations, never a block', () => {
  it.each([6, 6.5, 40, 1000])('balance %s covers the maximum price -> covered', (balance) => {
    expect(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance })).toEqual({ mode: 'covered', feature: FEATURE, maxCost: 6, balance })
  })

  it.each([0, 0.5, 1, 5, 5.99])('balance %s is below the maximum price -> insufficient (still goes to the server after confirmation)', (balance) => {
    expect(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance })).toEqual({ mode: 'insufficient', feature: FEATURE, maxCost: 6, balance })
  })

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('an unreadable balance (%s) -> unknown, with no made-up number', (balance) => {
    expect(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance })).toEqual({ mode: 'unknown', feature: FEATURE, maxCost: 6, balance: null })
  })

  it('shorts costs at most 2', () => {
    expect(buildVideoPackageCreditCheck({ feature: 'Video Package (Shorts)', cost: 2, balance: 1 }).mode).toBe('insufficient')
    expect(buildVideoPackageCreditCheck({ feature: 'Video Package (Shorts)', cost: 2, balance: 2 }).mode).toBe('covered')
  })
})

describe('the texts are conditional: a new generation needs AT MOST N credits, an existing result opens for 0', () => {
  it('the cost note', () => {
    expect(newGenerationCostNote(6)).toBe('Új generálás esetén legfeljebb 6 kredit szükséges; a meglévő eredmény megnyitása díjmentes.')
    expect(newGenerationCostNote(2)).toContain('legfeljebb 2 kredit')
  })

  it('modal copy per mode: always the free-opening possibility, never an unconditional price', () => {
    const covered = creditModalCopy(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance: 40 }))
    expect(covered.message).toContain('díjmentesen megnyitjuk (0 kredit)')
    expect(covered.message).toContain('legfeljebb 6 kreditbe kerül')
    expect(covered.message).not.toBe('Ez a művelet 6 kreditbe kerül.')

    const insufficient = creditModalCopy(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance: 2 }))
    expect(insufficient.message).toContain('díjmentesen megnyithatjuk')
    expect(insufficient.message).toContain('402')
    expect(insufficient.message).toContain('nincs AI-generálás és nincs kreditlevonás')
    expect(insufficient.confirmLabel).toBe('Meglévő eredmény keresése')

    const unknown = creditModalCopy(buildVideoPackageCreditCheck({ feature: FEATURE, cost: 6, balance: null }))
    expect(unknown.message).toContain('Nem tudtuk ellenőrizni az egyenlegedet')
    expect(unknown.message).toContain('legfeljebb 6 kreditbe kerül')
  })

  it('the server refusal text is explicit that there is NO existing result to open for free', () => {
    const text = insufficientCreditsNoCachedResultMessage(6)
    expect(text).toContain('6 kredit szükséges')
    expect(text).toContain('még nincs kifizetett eredményed')
  })
})

describe('page wiring (static): the confirmation comes first, whatever the balance', () => {
  const PAGE = readFileSync(path.resolve(__dirname, '..', 'app', 'dashboard', 'video-package', 'page.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const gate = code(PAGE.slice(PAGE.indexOf('async function checkCreditsBeforeAction('), PAGE.indexOf('function handleGenerate() {')))

  it('checkCreditsBeforeAction ALWAYS sets the credit check; there is no branch that starts the action directly', () => {
    expect(gate).toContain('setCreditCheck(buildVideoPackageCreditCheck({ feature: featureName, cost, balance }))')
    expect(gate).toContain('pendingActionRef.current = onConfirm')
    expect(gate).not.toMatch(/onConfirm\(\)/) // the action runs only from the modal's confirm handler
    expect(gate).not.toContain('canRun')
    expect(gate).not.toContain('Nincs elég kredited')
  })

  it('an unreadable balance (also a throwing refreshCredits) becomes balance = null, i.e. the "unknown" modal', () => {
    expect(gate).toMatch(/catch \{\s*\n\s*balance = null/)
  })

  it('the old shared modal is not used on this page any more; the dedicated one is', () => {
    expect(PAGE).not.toContain("components/CreditConfirmModal")
    expect(PAGE).toContain("from '@/components/video-package/VideoPackageCreditModal'")
    expect(PAGE).toContain('<VideoPackageCreditModal')
  })

  it('rail, banner and regenerate button state the maximum price conditionally', () => {
    expect(PAGE).toContain('const maxCredits = isShorts ? 2 : 6')
    expect(PAGE).toContain('<>Újragenerálás <span>legfeljebb {maxCredits} kredit</span></>')
    expect(PAGE).toContain('{saveError.message} {generationNote}')
    expect(PAGE).toContain('<small>Új generálás ára</small>')
    expect(code(PAGE)).not.toMatch(/Az újragenerálás (új|újabb) kreditet használ/)
    expect(code(PAGE)).not.toContain('A következő lépés előtt kreditmegerősítést kapsz.')
  })

  it('a 402 from the server is still shown to the user', () => {
    expect(code(PAGE)).toMatch(/res\.status === 402\) \{\s*\n\s*setError\(`💳 \$\{data\.error\}`\)/)
  })
})

describe('generate(): the previous result is kept until a NEW result has arrived (static)', () => {
  const PAGE = readFileSync(path.resolve(__dirname, '..', 'app', 'dashboard', 'video-package', 'page.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const generate = code(PAGE.slice(PAGE.indexOf('async function generate() {'), PAGE.indexOf('async function saveToCalendar()')))
  const beforeResponse = generate.slice(0, generate.indexOf("await fetch('/api/video-package'"))
  const afterResponse = generate.slice(generate.indexOf('const data = await res.json()'))

  it('nothing that blanks or re-labels the old result runs before the response', () => {
    expect(beforeResponse).not.toContain('setResult(')
    expect(beforeResponse).not.toContain('setFactSources(')
    expect(beforeResponse).not.toContain('beginGeneration()')
    expect(beforeResponse).not.toContain('setReopenedWithoutCharge(')
    expect(beforeResponse).not.toContain('factBlockRef.current')
  })

  it('failure branches only set the error and return; the new state is applied only after a successful response', () => {
    const failureBranch = afterResponse.slice(0, afterResponse.indexOf('const archiveToken'))
    expect(failureBranch).toContain('if (!res.ok) {')
    expect(failureBranch).not.toContain('setResult(')
    const success = afterResponse.slice(afterResponse.indexOf('const archiveToken'))
    expect(success.indexOf('archiveController.beginGeneration()')).toBeLessThan(success.indexOf('setResult(data)'))
    expect(success).toContain('setFactSources(sources)')
    expect(success).toContain('factBlockRef.current = factBlock')
  })
})
