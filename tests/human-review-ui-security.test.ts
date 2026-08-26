// Semantic Topic Identity v0 -- Human-Reviewed Candidate Workflow, minimal
// reviewer UI (Local Implementation Phase 4). Static source-scan security
// regression tests -- no DOM, no network, no DB. These are the concrete
// proof behind this gate's Section 7/11 requirements: the reviewer UI must
// never be able to reach the service-role layer, never render raw HTML from
// reviewer/source text, and never expose an execute action.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const UI_DIRS = [join(process.cwd(), 'components', 'semantic-topic-reviews'), join(process.cwd(), 'app', 'dashboard', 'semantic-topic-reviews')]

function listFilesRecursively(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursively(full))
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) out.push(full)
  }
  return out
}

const uiFiles = UI_DIRS.flatMap(listFilesRecursively)

// A kommentsorok (beleértve ennek a fájlnak és a forrásfájloknak a saját,
// a tiltott mintákat MAGYARÁZÓ header-kommentjeit) kihagyása, hogy a scan
// ne adjon önhivatkozó álpozitívot -- csak a tényleges kódsorokat vizsgáljuk.
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('//') && !(t.startsWith('{/*') && t.endsWith('*/}'))
    })
    .join('\n')
}

describe('reviewer UI import-graph security boundary', () => {
  it('found at least the expected reviewer UI files (sanity check the scan itself is not vacuous)', () => {
    expect(uiFiles.length).toBeGreaterThanOrEqual(8)
  })

  it('no file under the reviewer UI ever imports anything from lib/semantic-topic/* (the service-role/RPC layer)', () => {
    const offenders: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      if (/from\s+['"]@\/lib\/semantic-topic\//.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('no file under the reviewer UI imports createAdminClient, createServerSupabaseClient, or human-review-service/human-review-reviewer directly', () => {
    const offenders: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      if (/createAdminClient|createServerSupabaseClient|human-review-service|human-review-reviewer/.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('no file under the reviewer UI calls executeApprovedReview/execute_approved_topic_assignment_review or contains an "execute" action string', () => {
    const offenders: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      if (/executeApprovedReview|execute_approved_topic_assignment_review|semantic-topic-reviews\/[^'"`]*\/execute/i.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('no file under the reviewer UI uses dangerouslySetInnerHTML anywhere', () => {
    const offenders: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      if (/dangerouslySetInnerHTML/.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('the reviewer UI only ever talks to the backend via fetch() against /api/admin/semantic-topic-reviews -- every fetch() call target is that prefix (or a relative continuation of it)', () => {
    const fetchTargets: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      const matches = src.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g)
      for (const m of matches) fetchTargets.push(m[1])
    }
    expect(fetchTargets.length).toBeGreaterThan(0)
    for (const target of fetchTargets) {
      expect(target.startsWith('/api/admin/semantic-topic-reviews')).toBe(true)
    }
  })

  it('the review detail view never renders supporting-span or evidence text via anything other than plain JSX text content (grep-level proof: no innerHTML/outerHTML/insertAdjacentHTML assignment)', () => {
    const offenders: string[] = []
    for (const file of uiFiles) {
      const src = codeOnly(readFileSync(file, 'utf8'))
      if (/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(/.test(src)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})

describe('server-only build boundary remains intact for the reviewer UI addition', () => {
  it('human-review-service.ts still imports server-only near the top of the file (unchanged by this gate)', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'semantic-topic', 'human-review-service.ts'), 'utf8')
    const firstImportLine = src.split('\n').findIndex(line => line.trim().startsWith('import '))
    expect(firstImportLine).toBeGreaterThanOrEqual(0)
    expect(src.split('\n')[firstImportLine].trim()).toBe("import 'server-only'")
  })
})
