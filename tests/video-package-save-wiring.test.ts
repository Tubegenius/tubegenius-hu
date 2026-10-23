// A Video Package oldal mentési huzalozásának statikus ellenőrzése (a viselkedést a
// tests/video-package-save-client.test.ts és a tests/video-packages-route-post.test.ts bizonyítja).
//
//   * a mentés CSAK a védett mentő modulon megy át (lib/paid-results/video-package-save-client.ts),
//     a teljes eredményt tartalmazó régi törzs már sehol sincs az oldalban;
//   * a `saved` állapot csak sikeres kimenetel után áll be, a Memory-kapcsolat a modulban csak sikeres mentés után indul;
//   * nincs automatikus újrapróbálás (időzítő/ciklus), a kézi mentés csak gombkattintásra fut, és csak akkor
//     jelenik meg, ha a hibás kimenetel újrapróbálása biztonságos (nincs dupla mentés);
//   * a mentési ág nem érinti a generáló végpontot (/api/video-package), nem von le kreditet.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (...p: string[]) => readFileSync(path.resolve(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n')
const PAGE = read('app', 'dashboard', 'video-package', 'page.tsx')
const code = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

function functionBlock(source: string, header: string): string {
  const start = source.indexOf(header)
  expect(start, `${header} must exist`).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start + header.length)
  const nextFn = rest.search(/\n  (async )?function |\n  const [a-zA-Z]+ = /)
  return source.slice(start, start + header.length + (nextFn > 0 ? nextFn : rest.length))
}

describe('Video Package page save wiring', () => {
  const persist = code(functionBlock(PAGE, 'async function persistPackage(pkg: VideoPackageResult) {'))

  it('uses the guarded saver module; the old autoSavePackage()/savePackage() bodies are gone', () => {
    expect(PAGE).toContain("from '@/lib/paid-results/video-package-save-client'")
    expect(PAGE).toContain('createVideoPackageSaver()')
    expect(code(PAGE)).not.toMatch(/function autoSavePackage|function savePackage|autoSavePackage\(/)
  })

  it('the page no longer builds the full-result request body for /api/video-packages', () => {
    const c = code(PAGE)
    // no direct POST to /api/video-packages from the page at all (the saver owns it) ...
    expect(c).not.toMatch(/fetch\('\/api\/video-packages',\s*\{\s*method: 'POST'/)
    // ... and no request body with a paid_result_id key is assembled here any more (the legacy bodies were;
    // the remaining pkg.narration / scene_structure mapping at the GET-load path is unrelated to POST)
    expect(c).not.toMatch(/paid_result_id:/)
    expect(c).not.toContain('verified_fact_block_json:')
    expect(c).not.toContain('narration: result.narration')
    expect(c).not.toContain('generated_video_package_id: data.id')
  })

  it('saved state is set only after the saver reports success (error outcome returns first)', () => {
    const errorGuard = persist.indexOf("outcome.status !== 'saved'")
    const setSavedAt = persist.indexOf('setSaved(true)')
    const returnAt = persist.indexOf('return', errorGuard)
    expect(errorGuard).toBeGreaterThan(0)
    expect(setSavedAt).toBeGreaterThan(errorGuard)
    expect(returnAt).toBeGreaterThan(errorGuard)
    expect(returnAt).toBeLessThan(setSavedAt)
    expect(persist.match(/setSaved\(true\)/g)).toHaveLength(1)
    expect(persist).toContain('setSaveError({')
  })

  it('persistPackage has no retry loop, timer or recursion; and does not call the generation or any credit endpoint', () => {
    const body = persist.slice(persist.indexOf('{') + 1) // without the function header
    expect(body).not.toMatch(/setTimeout|setInterval|while \(|for \(|persistPackage\(/)
    expect(persist).not.toContain('/api/video-package\'')
    expect(persist).not.toMatch(/\/api\/credits|chargeFeature|spend_credits|\/api\/opportunity|\/api\/facts/)
    // the only direct fetch left in the function is the optional source-video link (unchanged behaviour)
    const fetches = [...persist.matchAll(/fetch\('([^']+)'/g)].map(m => m[1])
    expect(fetches).toEqual(['/api/source-video-analysis'])
  })

  it('the manual save (retrySave) is reachable only from a click handler, never from an effect or automatically', () => {
    const c = code(PAGE)
    const uses = [...c.matchAll(/retrySave/g)].length
    expect(uses).toBe(2) // the definition and the one onClick
    expect(c).toMatch(/onClick=\{retrySave\}/)
    // ... and it refuses to run unless the last failure was a definite pre-write one (retrySafe) -- not even by a stray call
    expect(code(functionBlock(PAGE, 'async function retrySave() {'))).toContain('if (!result || saved || !saveError?.retrySafe) return')
  })

  it('the retry button is shown only when the failed outcome is safe to retry (no duplicate-save risk)', () => {
    expect(PAGE).toMatch(/saveError\.retrySafe && <button type="button" className="wv-package-error-action" onClick=\{retrySave\}/)
    expect(PAGE).toMatch(/saveError && result && !saved/)
  })

  // Review-lelet: a sessionStorage-ból / paid_results-ból visszanyitott eredmény nem azonos a video_packages-be mentett csomaggal.
  it('the sessionStorage restore and the paid_results reopen do NOT set the saved state (no archive row is proven by reopening)', () => {
    const restore = code(PAGE.slice(PAGE.indexOf("sessionStorage.getItem('willviral_video_package_state')"), PAGE.indexOf('function loadSourceVideoContext')))
    expect(restore).toContain('setResult(state.result)')
    expect(restore).not.toContain('setSaved(true)')
    expect(restore).toContain('confirmArchivedPackage(state.result)')

    const reopen = code(functionBlock(PAGE, 'async function loadPaidResult(paidResultId: string) {'))
    expect(reopen).toContain('setResult(data)')
    expect(reopen).not.toContain('setSaved(true)')
    expect(reopen).toContain('confirmArchivedPackage(data)')
  })

  it('setSaved(true) exists in exactly three places: the confirmed fresh save, the verified-archive check and the explicit ?id= archive load', () => {
    const c = code(PAGE)
    expect([...c.matchAll(/setSaved\(true\)/g)]).toHaveLength(3)
    const inFunction = (header: string) => code(functionBlock(PAGE, header)).includes('setSaved(true)')
    expect(inFunction('async function persistPackage(pkg: VideoPackageResult) {')).toBe(true)
    expect(inFunction('async function confirmArchivedPackage(pkg: { paid_result_id?: string }) {')).toBe(true)
    expect(inFunction('async function loadSavedPackage(id: string) {')).toBe(true)
  })

  it('confirmArchivedPackage marks saved only for a stored reference of THIS paid result that the owner-scoped GET proves; it never saves', () => {
    const confirm = code(functionBlock(PAGE, 'async function confirmArchivedPackage(pkg: { paid_result_id?: string }) {'))
    expect(confirm).toContain('readArchiveRef(raw, pkg.paid_result_id)')
    expect(confirm).toContain("await verifyArchivedPackage(packageId) !== 'present'")
    expect(confirm.indexOf("!== 'present'")).toBeLessThan(confirm.indexOf('setSaved(true)'))
    expect(confirm).toContain('token !== archiveCheckRef.current') // a stale check never overrides a newer generation
    expect(confirm).not.toMatch(/\.save\(|persistPackage|fetch\(|POST/)
  })

  it('the archive reference is written only after a confirmed save, and a new generation invalidates a running check', () => {
    const persist = code(functionBlock(PAGE, 'async function persistPackage(pkg: VideoPackageResult) {'))
    expect(persist.indexOf('setSaved(true)')).toBeLessThan(persist.indexOf('serializeArchiveRef(pkg.paid_result_id, outcome.id)'))
    expect(persist.indexOf("outcome.status !== 'saved'")).toBeLessThan(persist.indexOf('serializeArchiveRef('))
    expect([...code(PAGE).matchAll(/serializeArchiveRef\(/g)]).toHaveLength(1)
    expect(code(PAGE)).toContain('archiveCheckRef.current += 1')
  })

  it('an unverified reopened result is not labelled as a saved package, and shows the regeneration (credit) wording', () => {
    expect(PAGE).toContain('Az archívum-mentés nem igazolt.')
    expect(PAGE).not.toContain('Mentett eredmény, kredit nélkül megnyitva')
    expect(PAGE).toContain("(saved ? 'Mentett csomag megnyitva — új kredit levonása nélkül.' : 'Fizetett eredmény megnyitva — új kredit levonása nélkül.')")
    expect(PAGE).toContain(': saved || reopenedWithoutCharge ? <>Újragenerálás')
  })

  it('the persistence step is called exactly once, right after a successful generation (autosave), nowhere else automatically', () => {
    const calls = [...code(PAGE).matchAll(/persistPackage\(/g)].length
    expect(calls).toBe(3) // the definition, the autosave call after generation, the call inside retrySave
    const afterGeneration = PAGE.indexOf('await persistPackage(data)')
    expect(afterGeneration).toBeGreaterThan(PAGE.indexOf('publishCreditMutationCompleted'))
  })
})
