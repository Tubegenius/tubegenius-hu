// Creator Intelligence 2B: source-level guards for the decision core. They pin the properties the behaviour tests
// cannot show from the outside. They are deliberately simple text checks (a refactor that keeps the property may
// need the pattern adjusted; a change that breaks the property should fail here).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DECISION_FIELDS } from '@/lib/creator-focus'

const DIR = join(process.cwd(), 'lib', 'creator-focus')
const DECISION_FILES = ['decision-command.ts', 'decision-contract.ts', 'decision-events.ts', 'decision-reduce.ts', 'fingerprint.ts', 'sha256.ts']
const code = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('a revision is compared for EQUALITY only and never converted', () => {
  it.each(DECISION_FILES)('%s has no ordering comparison and no numeric conversion on a revision', (file) => {
    const lines = code(file).split('\n').filter(l => /revision/i.test(l))
    for (const line of lines) {
      expect(line, `${file}: ${line.trim()}`).not.toMatch(/\s<=?\s|\s>=?\s/)
      expect(line, `${file}: ${line.trim()}`).not.toMatch(/\bNumber\s*\(|\bBigInt\s*\(|\bparseInt\s*\(|\bparseFloat\s*\(|\bMath\.(max|min)\s*\(/)
      expect(line, `${file}: ${line.trim()}`).not.toMatch(/\bBigInt\b/)
    }
  })

  it('the validity test in the reducer is an equality on the revision', () => {
    expect(code('decision-reduce.ts')).toMatch(/e\.field_revision === snap\.revision/)
  })
})

describe('the decision core carries no words and uses no runtime dependency', () => {
  it('an event has no value text key (validity needs only the fingerprint and the revision, whatever is later decided about retention)', () => {
    const events = code('decision-events.ts')
    const keys = events.match(/const EVENT_KEYS = \[([\s\S]*?)\]/)![1]
    expect(keys).not.toMatch(/value_text|'value'|text/)
    expect(keys).toContain("'value_fingerprint'")
    expect(keys).toContain("'field_revision'")
  })

  it('the fingerprint and hashing do not import node:crypto or any package', () => {
    for (const file of ['fingerprint.ts', 'sha256.ts']) {
      expect(code(file)).not.toMatch(/node:crypto|from\s+['"]crypto['"]|require\s*\(/)
    }
  })

  it('no decision file writes anywhere or names a table (it is a pure model; there is no store)', () => {
    for (const file of DECISION_FILES) {
      const source = code(file)
      expect(source, file).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/)
      expect(source, file).not.toMatch(/from\(\s*['"]/)
    }
  })

  it('the decisions cover exactly the two approved fields (audience and avoid_topics are NOT part of this version)', () => {
    expect([...DECISION_FIELDS]).toEqual(['specific_focus', 'main_category'])
  })
})

describe('2A is untouched by the 2B files', () => {
  it('the 2A modules do not import any 2B module (the dependency points one way only)', () => {
    const twoA = readdirSync(DIR).filter(f => ['contract.ts', 'eligibility.ts', 'fit.ts', 'profile-adapter.ts', 'profile-validate.ts', 'text.ts', 'transitions.ts'].includes(f))
    for (const file of twoA) {
      expect(readFileSync(join(DIR, file), 'utf8'), file).not.toMatch(/from\s+['"]\.\/(decision-|fingerprint|sha256)/)
    }
  })
})
