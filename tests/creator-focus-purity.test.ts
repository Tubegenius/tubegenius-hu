// Creator Intelligence 2A: the module has no database, network, AI, credit, clock or randomness side effect.
// DB-free by construction: the forbidden modules are replaced with trip-wires that only record a load.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { loaded, trip } = vi.hoisted(() => {
  const state = { modules: [] as string[] }
  const make = (name: string) => () => {
    state.modules.push(name)
    return new Proxy({}, { get: () => { throw new Error(`forbidden module used: ${name}`) } })
  }
  return { loaded: state, trip: make }
})
vi.mock('@/lib/supabase-server', trip('lib/supabase-server'))
vi.mock('@/lib/supabase', trip('lib/supabase'))
vi.mock('@/lib/credits', trip('lib/credits'))
vi.mock('@/lib/services/ai-provider-service', trip('lib/services/ai-provider-service'))
vi.mock('@supabase/supabase-js', trip('@supabase/supabase-js'))
vi.mock('@supabase/ssr', trip('@supabase/ssr'))
vi.mock('@anthropic-ai/sdk', trip('@anthropic-ai/sdk'))

const MODULE_DIR = join(process.cwd(), 'lib', 'creator-focus')
const ALLOWED_IMPORTS = new Set(['@/lib/channel-scope', '@/lib/niche-relevance', '@/types'])

describe('static: what the module may import and call', () => {
  const files = readdirSync(MODULE_DIR).filter(f => f.endsWith('.ts'))

  it('has the expected files only', () => {
    expect(files.sort()).toEqual([
      'contract.ts', 'decision-command.ts', 'decision-contract.ts', 'decision-events.ts', 'decision-reduce.ts', 'eligibility.ts',
      'fingerprint.ts', 'fit.ts', 'index.ts', 'profile-adapter.ts', 'profile-validate.ts', 'sha256.ts', 'text.ts', 'transitions.ts',
    ])
  })

  it.each(files)('%s imports only relative modules and the allow-listed pure helpers', (file) => {
    const source = readFileSync(join(MODULE_DIR, file), 'utf8')
    const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    for (const specifier of specifiers) {
      expect(specifier.startsWith('./') || ALLOWED_IMPORTS.has(specifier), `${file}: ${specifier}`).toBe(true)
    }
  })

  it.each(files)('%s contains no I/O, environment, clock, randomness or logging', (file) => {
    // strip comments so the explanations above do not trip the scan
    const code = readFileSync(join(MODULE_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const forbidden: Array<[string, RegExp]> = [
      ['process.env', /process\.env/],
      ['fetch', /\bfetch\s*\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
      ['WebSocket', /WebSocket/],
      ['Date.now', /Date\.now\s*\(/],
      ['new Date', /new Date\s*\(/],
      ['Math.random', /Math\.random\s*\(/],
      ['console', /\bconsole\./],
      ['fs', /\bnode:fs\b|\brequire\s*\(/],
      ['database client', /createAdminClient|createServerClient|createClient|\.from\(\s*['"]/],
      ['credit operation', /chargeFeature|refundCredits|checkPaidFeatureAccess/],
      ['AI call', /callAIProvider|anthropic|messages\.create/i],
      ['the unapproved candidates[0] shortcut', /candidates\s*\[\s*0\s*\]|detected_niche_candidates\s*\[\s*0\s*\]/],
    ]
    for (const [label, pattern] of forbidden) expect(pattern.test(code), `${file}: ${label}`).toBe(false)
  })
})

describe('runtime: a full scenario triggers no side effect', () => {
  afterEach(() => vi.restoreAllMocks())

  it('loads no forbidden module and calls no fetch, clock or random source', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('network used') })
    vi.stubGlobal('fetch', fetchSpy)
    const now = vi.spyOn(Date, 'now')
    const random = vi.spyOn(Math, 'random')
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')

    const api = await import('@/lib/creator-focus')
    const { row, candidate, CHANNEL_A, AT } = await import('./support/creator-focus-fixtures')

    const profile = api.adaptProfileRow(row({
      specific_focus: 'otthoni edzés kezdőknek', audience: 'kezdők', avoid_topics: 'politika', channel_usage_mode: 'primary_profile',
      detected_niche_candidates: [candidate('főzés gyorsan', 'lifestyle')], active_channel_id: CHANNEL_A,
    }))
    const confirmed = api.confirmSuggestion(profile, 0, AT)
    const corrected = api.declareOrCorrectClaim(profile, 'audience', 'haladók', AT)
    api.dismissSuggestion(profile, 0, AT)
    const result = api.assessFocusFit({ contract_version: 'creator-focus.v1', profile: confirmed.ok ? confirmed.profile : profile, topic: { text: 'főzés gyorsan és egyszerűen otthon' } })
    api.assessFocusFit({ contract_version: 'creator-focus.v1', profile: corrected.ok ? corrected.profile : profile, topic: { text: 'politika hírek elemzés' } })

    expect(result.status).toBe('fits')
    expect(loaded.modules).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(now).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
