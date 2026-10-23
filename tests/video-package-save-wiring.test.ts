// A Video Package oldal archívum-huzalozásának STATIKUS ellenőrzése. A viselkedést (mentett állapot, bizonytalan kimenetel,
// újratöltés, cache-találat, késő mentés, lógó Memory-hívás) a tests/video-package-archive-controller.test.ts és a
// tests/video-package-save-client.test.ts bizonyítja, renderelés nélkül; ez a fájl csak azt rögzíti, hogy az oldal ezeket
// az (egyetlen) állapotgépet használja, és hogy a felhasználónak mutatott szövegek nem állítanak többet a kliensoldali
// védelemnél. Forrásszöveg-illesztés: egy refaktor eltörheti, de hamis biztonságot nem ad a viselkedésről.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (...p: string[]) => readFileSync(path.resolve(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n')
const PAGE = read('app', 'dashboard', 'video-package', 'page.tsx')
// kommentek nélkül: egy megjegyzésben szereplő szöveg nem elégíthet ki állítást
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
const CODE = code(PAGE)

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a + start.length)
  expect(a, `${start} must exist`).toBeGreaterThanOrEqual(0)
  expect(b, `${end} must follow`).toBeGreaterThan(a)
  return source.slice(a, b)
}

describe('page uses the single archive state machine; it keeps no archive state of its own', () => {
  it('imports the controller and creates the saver with the persistent uncertain store (localStorage) and the session storage', () => {
    expect(PAGE).toContain("from '@/lib/paid-results/video-package-archive-controller'")
    expect(PAGE).toContain('createArchiveController({')
    expect(PAGE).toContain('createStorageUncertainStore(')
    expect(PAGE).toContain('window.localStorage')
    expect(PAGE).toContain('window.sessionStorage')
  })

  it('the page has no own saved / package-id / save-error state setters (everything goes through the controller)', () => {
    expect(CODE).not.toMatch(/\bsetSaved\(/)
    expect(CODE).not.toMatch(/\bsetSavedPackageId\(/)
    expect(CODE).not.toMatch(/\bsetSaveError\(/)
    expect(CODE).not.toMatch(/useState\(false\)\s*\n\s*const \[savedPackageId/)
  })

  it('the page never POSTs the full result or calls /api/video-packages itself (the saver owns it)', () => {
    expect(CODE).not.toMatch(/fetch\('\/api\/video-packages',\s*\{\s*method: 'POST'/)
    expect(CODE).not.toMatch(/paid_result_id:/)
    expect(CODE).not.toContain('verified_fact_block_json:')
    expect(CODE).not.toContain('narration: result.narration')
  })
})

describe('F1: a cache hit (from_paid_result) never reaches the automatic archive save', () => {
  const afterGeneration = between(PAGE, 'if (data.from_paid_result) {', '} catch { setError(')

  it('the generation response branch: from_paid_result -> reconcile only; otherwise persistPackage', () => {
    const cacheBranch = afterGeneration.slice(0, afterGeneration.indexOf('} else {'))
    const freshBranch = afterGeneration.slice(afterGeneration.indexOf('} else {'))
    expect(code(cacheBranch)).toContain('archiveController.reconcileReopened(data)')
    expect(code(cacheBranch)).toContain('setReopenedWithoutCharge(true)')
    expect(code(cacheBranch)).not.toContain('persistPackage')
    expect(code(freshBranch)).toContain('await persistPackage(data, archiveToken)')
  })

  it('persistPackage is called only from that fresh-generation branch (retrySave goes through the controller guard instead)', () => {
    expect([...CODE.matchAll(/persistPackage\(/g)]).toHaveLength(2) // the definition + the fresh-generation call
    expect(CODE).toContain('archiveController.retry(')
  })

  it('the sessionStorage restore and the paid_results reopen only reconcile; they never save', () => {
    const restore = code(between(PAGE, "sessionStorage.getItem('willviral_video_package_state')", 'function loadSourceVideoContext'))
    expect(restore).toContain('archiveController.reconcileReopened(state.result)')
    expect(restore).not.toMatch(/persistPackage|\.save\(|retrySave/)
    const reopen = code(between(PAGE, 'async function loadPaidResult(paidResultId: string) {', 'async function loadSavedPackage'))
    expect(reopen).toContain('archiveController.reconcileReopened(data)')
    expect(reopen).not.toMatch(/persistPackage|\.save\(|retrySave/)
  })

  it('a new generation starts by resetting the controller (token) before anything else can write archive state', () => {
    expect(CODE).toContain('const archiveToken = archiveController.beginGeneration()')
  })

  it('the already-paid result is displayed even if the browser storage write throws (the write is guarded)', () => {
    const block = between(PAGE, "      // Mentés sessionStorage-ba", 'if (data.from_paid_result) {')
    expect(code(block)).toMatch(/try \{\s*\n\s*sessionStorage\.setItem\('willviral_video_package_state'/)
    expect(code(block)).toContain('} catch {}')
  })
})

describe('F2 / F6 / F5: what the user is told (static text checks, no rendering)', () => {
  const banner = between(PAGE, '{saveError && result && !saved && (', '{memoryLinkFailed && saved && (')
  const memoryNotice = between(PAGE, '{memoryLinkFailed && saved && (', '{result && (\n        <section className="wv-package-results"')

  it('the save-error banner separates the paid generation / the credit charge from the archive uncertainty', () => {
    expect(banner).toContain('A fizetett generálás elkészült, a kredit levonása már megtörtént.')
    expect(banner).toContain('A fizetett eredmény megnyitva, új kreditet nem vontunk le.')
    expect(banner).toContain('Az archívum-mentés nincs igazolva.')
    expect(banner).toContain('Az archívum-mentés nem történt meg.') // only for the retry-safe (pre-insert) case
    expect(banner).toContain('{saveError.message} {generationNote}') // the conditional new-generation cost note
  })

  it('"not happened" is claimed only for the retry-safe case; the uncertain case says "nincs igazolva"', () => {
    expect(banner).toMatch(/saveError\.retrySafe \? 'Az archívum-mentés nem történt meg\.' : 'Az archívum-mentés nincs igazolva\.'/)
  })

  it('the banner no longer says the credit is "not affected" and never names Tartalommemória as an archive check', () => {
    expect(banner).not.toContain('nem érintett')
    expect(banner).not.toContain('A csomag mentése nem sikerült.')
    expect(PAGE).not.toMatch(/Tartalommem[óo]ri/)
  })

  it('the retry button exists only for a retry-safe error and is disabled while a save is running', () => {
    expect(banner).toMatch(/saveError\.retrySafe && <button type="button" className="wv-package-error-action" onClick=\{retrySave\} disabled=\{archiving\}>/)
  })

  it('a Memory failure is its own notice, shown only for a saved package, and it says not to save again', () => {
    expect(memoryNotice).toContain('A Memory-kapcsolat nem jött létre.')
    expect(memoryNotice).toContain('A csomag az archívumba mentve van')
    expect(memoryNotice).toContain('Ne mentsd újra a csomagot.')
    expect(memoryNotice).not.toContain('Az archívum-mentés nincs igazolva')
  })

  it('the success check mark is shown ONLY for a saved (proven) package', () => {
    expect(PAGE).toContain('{saved ? <CheckCircle2 aria-hidden="true" /> : reopenedWithoutCharge ? <Info aria-hidden="true" /> : railFreshUnsaved ? <AlertTriangle aria-hidden="true" /> : <Zap aria-hidden="true" />}')
    expect(CODE).not.toMatch(/reopenedWithoutCharge \|\| saved \? <CheckCircle2/)
    // the only CheckCircle2 usages in the generate rail / hero label code are behind `saved`
    const rail = between(PAGE, '<footer className="wv-package-generate-rail">', '</footer>')
    expect([...rail.matchAll(/CheckCircle2/g)]).toHaveLength(1)
  })

  it('rail texts: fresh-but-unsaved shows the charge AND the unproven archive; reopened-unverified says no new charge AND unproven; both say regeneration uses new credit', () => {
    expect(PAGE).toContain("'A fizetett generálás elkészült — a kredit levonása már megtörtént.'")
    expect(PAGE).toContain('`Az archívum-mentés nincs igazolva. ${generationNote}`')
    expect(PAGE).toContain("'Fizetett eredmény megnyitva — új kredit levonása nélkül.'")
    expect(PAGE).toContain('`Az archívum-mentés nem igazolt. ${generationNote}`')
    // an unsaved fresh result does not fall back to the pre-payment "N kredit / kreditmegerősítés" wording
    expect(PAGE).toContain('railFreshUnsaved')
    expect(PAGE).toMatch(/saved \|\| reopenedWithoutCharge \|\| railFreshUnsaved \? <>Újragenerálás/)
  })

  it('hero label: "Mentett…/mentésre került" only for saved; unverified or failed-save results get the neutral info label', () => {
    const hero = between(PAGE, 'const heroSaveStatus', '// Rail:')
    const savedBranch = hero.slice(hero.indexOf('saved\n'), hero.indexOf(': reopenedWithoutCharge || result.from_paid_result'))
    expect(savedBranch).toContain('Mentett csomag megnyitva')
    expect(savedBranch).toContain('mentésre került')
    const rest = hero.slice(hero.indexOf(': reopenedWithoutCharge || result.from_paid_result'))
    expect(rest).not.toContain('mentésre került')
    expect(rest).not.toContain('Mentett csomag')
    expect(rest).toContain("variant: 'info'")
    expect(hero).toContain('Az archívum-mentés nincs igazolva.')
  })
})

describe('source-video link and stale handling in the page glue', () => {
  const finish = between(PAGE, 'async function finishArchive(', '// Kézi mentés')

  it('the source-video link is written only for a fresh, confirmed save of the CURRENT generation', () => {
    const c = code(finish)
    expect(c.indexOf("outcome.status !== 'saved'")).toBeLessThan(c.indexOf('alreadySaved'))
    expect(c.indexOf('alreadySaved')).toBeLessThan(c.indexOf('archiveController.isCurrent(token)'))
    expect(c.indexOf('archiveController.isCurrent(token)')).toBeLessThan(c.indexOf("fetch('/api/source-video-analysis'"))
    expect(c).toContain('generated_video_package_id: outcome.id')
  })

  it('there is no retry loop, timer or recursion in the save glue', () => {
    const glue = code(between(PAGE, 'async function persistPackage(', 'const producerBrief'))
    expect(glue).not.toMatch(/setTimeout|setInterval|while \(|for \(/)
    expect(glue).not.toMatch(/\/api\/video-package'/)
    expect(glue).not.toMatch(/\/api\/credits|chargeFeature|spend_credits/)
  })

  it('retrySave is reachable only from the click handler', () => {
    expect([...CODE.matchAll(/retrySave/g)]).toHaveLength(2) // the definition and the one onClick
    expect(CODE).toMatch(/onClick=\{retrySave\}/)
  })
})
