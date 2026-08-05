import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const LEGACY_MD5 = '36ce8f65663df3b408f1d7a9db0cf252'
const CORRECTED_MD5 = '3ad82ac63b81d925176192ddb7430ce3'
const LEGACY_FRAGMENT = "WHEN 'discovery_search' THEN 300"
const CORRECTED_FRAGMENT = "WHEN 'discovery_search' THEN 3"

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
}

function reserveFunctionBody(): string {
  const migration = source('supabase/migrations/061_signal_run_provider_usage.sql')
  const match = migration.match(
    /CREATE FUNCTION public\.reserve_provider_units\([\s\S]*?AS \$body\$([\s\S]*?)\$body\$;/,
  )
  if (!match?.[1]) throw new Error('reserve_provider_units body not found')
  return match[1]
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

describe('YouTube search quota accounting migration', () => {
  it('permits exactly one audited legacy-to-current function transformation', () => {
    const legacy = reserveFunctionBody()
    expect(md5(legacy)).toBe(LEGACY_MD5)
    expect(legacy.split(LEGACY_FRAGMENT)).toHaveLength(2)

    const corrected = legacy.replace(LEGACY_FRAGMENT, CORRECTED_FRAGMENT)
    expect(md5(corrected)).toBe(CORRECTED_MD5)

    const migration = source('supabase/migrations/064_align_youtube_search_quota_accounting.sql')
    expect(migration).toContain(`v_legacy_md5 constant text := '${LEGACY_MD5}'`)
    expect(migration).toContain(`v_corrected_md5 constant text := '${CORRECTED_MD5}'`)
    expect(migration).toContain('legacy discovery quota ledger rows exist')
  })

  it('uses one ledger unit for each external search.list attempt end-to-end', () => {
    const budget = source('lib/emerging-signal/provider-budget.ts')
    const worker = source('lib/emerging-signal/discovery-worker.ts')

    expect(budget).toMatch(/discovery_search:\s*1,/)
    expect(budget).not.toMatch(/discovery_search:\s*100,/)
    expect(worker).toContain("usageType: 'discovery_search'")
    expect(worker).toContain('units: 1')
    expect(worker).not.toContain('units: 100')
    expect(worker.match(/commitProviderUnits\(reservationId, 1/g)).toHaveLength(3)
  })
})
