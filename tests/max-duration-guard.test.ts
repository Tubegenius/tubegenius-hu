// Guard for the stale-lock TTL assumption (lib/request-lock.ts): the TTL is only safe while NO request can
// outlive it. This test checks the EXPLICIT limits that live in the repository (route-level
// `export const maxDuration` and vercel.json function settings) against ROUTE_MAX_DURATION_MS.
//
// WHAT IT PROVES: every `export const maxDuration[: T] = <value>` under app/ (ts/tsx/js/jsx/mjs) is a numeric
// literal <= ROUTE_MAX_DURATION_MS (a non-literal value or `60 as const` fails closed), every
// vercel.json `functions[*].maxDuration` is <= ROUTE_MAX_DURATION_MS, and LOCK_TTL_MS keeps at least a 60 s
// margin above the largest explicit duration found.
//
// WHAT IT DOES NOT PROVE (read this):
//   * the external Vercel project setting ("Default Max Duration", plan, Fluid compute): it lives in the Vercel
//     dashboard, not in the repo, and was only observed once (2026-10-03: Hobby, Fluid on, empty override =>
//     default 300 s). A change there is NOT detected; keep ROUTE_MAX_DURATION_MS in sync by hand;
//   * other declaration forms: `export let/var maxDuration`, `export { maxDuration }`, re-exports, a
//     `config` object, or source roots other than app/ (there is no src/ or pages/ today);
//   * the real platform kill latency or the DB-clock vs app-clock difference.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCK_STALE_MARGIN_MS, LOCK_TTL_MS, ROUTE_MAX_DURATION_MS } from '@/lib/request-lock'

type Found = { file: string; raw: string; seconds: number | null }

export function findMaxDurations(file: string, source: string): Found[] {
  const out: Found[] = []
  for (const m of source.matchAll(/export\s+const\s+maxDuration\s*(?::\s*[\w<>[\]| ]+)?=\s*([^\n;]+)/g)) {
    const raw = m[1].trim()
    out.push({ file, raw, seconds: /^\d[\d_]*$/.test(raw) ? Number(raw.replace(/_/g, '')) : null })
  }
  return out
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) acc.push(p)
  }
  return acc
}

const found = walk('app').flatMap(f => findMaxDurations(f.replace(/\\/g, '/'), readFileSync(f, 'utf8')))

describe('explicit maxDuration values stay below the stale-lock ceiling', () => {
  it('the scanner itself recognises the supported declaration forms (sanity)', () => {
    expect(findMaxDurations('x', 'export const maxDuration = 60')).toEqual([{ file: 'x', raw: '60', seconds: 60 }])
    expect(findMaxDurations('x', 'export const maxDuration: number = 3_00')).toEqual([{ file: 'x', raw: '3_00', seconds: 300 }])
    expect(findMaxDurations('x', 'export const maxDuration = SOME_CONST')[0].seconds).toBeNull()
    expect(findMaxDurations('x', 'const maxDuration = 900')).toEqual([])
  })

  it('every route-level maxDuration is a literal number <= ROUTE_MAX_DURATION_MS', () => {
    expect(found.length, 'the repo currently declares maxDuration in at least transcript and the cron route').toBeGreaterThan(0)
    for (const f of found) {
      expect(f.seconds, `${f.file}: maxDuration must be a numeric literal so the guard can check it (got "${f.raw}")`).not.toBeNull()
      expect(f.seconds! * 1000, `${f.file}: maxDuration ${f.seconds}s exceeds ROUTE_MAX_DURATION_MS (${ROUTE_MAX_DURATION_MS / 1000}s) -- raise the lock TTL first`).toBeLessThanOrEqual(ROUTE_MAX_DURATION_MS)
    }
  })

  it('no function-level maxDuration in vercel.json exceeds ROUTE_MAX_DURATION_MS', () => {
    if (!existsSync('vercel.json')) return
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { functions?: Record<string, { maxDuration?: number }> }
    for (const [pattern, fn] of Object.entries(cfg.functions ?? {})) {
      if (fn.maxDuration != null) expect(fn.maxDuration * 1000, `vercel.json functions["${pattern}"].maxDuration`).toBeLessThanOrEqual(ROUTE_MAX_DURATION_MS)
    }
  })

  it('the lock TTL keeps at least a 60 s margin above the largest EXPLICIT maxDuration found in the repo', () => {
    // Computed from the scanned values only (not from ROUTE_MAX_DURATION_MS), so it is not true by construction.
    const largestExplicit = Math.max(0, ...found.map(f => (f.seconds ?? 0) * 1000))
    expect(largestExplicit).toBeGreaterThan(0)
    expect(LOCK_TTL_MS - largestExplicit).toBeGreaterThanOrEqual(60_000)
  })

  it('the declared margin constants are consistent (TTL = ceiling + margin, margin >= 60 s)', () => {
    expect(LOCK_TTL_MS).toBe(ROUTE_MAX_DURATION_MS + LOCK_STALE_MARGIN_MS)
    expect(LOCK_STALE_MARGIN_MS).toBeGreaterThanOrEqual(60_000)
  })
})
