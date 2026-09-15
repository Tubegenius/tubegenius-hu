// PFM Lifecycle Reviewer Self-Capability v1 -- static source-policy checks
// on migration 089's SQL text. No DB, no network. Real-DB proof of the
// same properties (grants, zero DML at runtime, response shape) lives in
// tests/lifecycle-reviewer-capability-db-integration.test.ts; this file
// documents and guards the SOURCE-level contract so a future edit cannot
// silently widen it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_FILE = join(process.cwd(), 'supabase/migrations/089_semantic_topic_lifecycle_reviewer_capability.sql')
const src = readFileSync(MIGRATION_FILE, 'utf8')

function codeOnly(text: string): string {
  return text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
}
const code = codeOnly(src)

describe('migration 089 -- get_semantic_topic_lifecycle_reviewer_capability source policy', () => {
  it('is parameterless', () => {
    expect(code).toMatch(/CREATE FUNCTION public\.get_semantic_topic_lifecycle_reviewer_capability\(\)/)
  })

  it('is STABLE, SECURITY DEFINER, with a fixed safe search_path', () => {
    expect(code).toMatch(/RETURNS BOOLEAN\s*\n\s*LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp/)
  })

  it('requires auth.uid() and fails closed (RAISE EXCEPTION) when it is NULL', () => {
    expect(code).toMatch(/v_caller_user_id\s*:=\s*auth\.uid\(\)/)
    expect(code).toMatch(/IF v_caller_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION/)
  })

  it('the only data-touching statement in the function body is a single EXISTS against semantic_topic_reviewers -- no other table, no raw SELECT of any column', () => {
    const fnBodyMatch = code.match(/CREATE FUNCTION public\.get_semantic_topic_lifecycle_reviewer_capability\(\)[\s\S]*?\$rpc\$([\s\S]*?)\$rpc\$/)
    expect(fnBodyMatch).not.toBeNull()
    const body = fnBodyMatch ? fnBodyMatch[1] : ''
    const fromClauses = [...body.matchAll(/FROM\s+public\.(\w+)/g)].map((m) => m[1])
    expect(fromClauses).toEqual(['semantic_topic_reviewers'])
    expect(body).toMatch(/RETURN EXISTS \(/)
    expect(body).not.toMatch(/SELECT\s+(?!1\b)\w+/) // only ever "SELECT 1" inside the EXISTS, never a column
  })

  it('never selects/returns a reviewer id, role, email, or any list -- the ONLY RETURN is the EXISTS boolean itself', () => {
    const fnBodyMatch = code.match(/CREATE FUNCTION public\.get_semantic_topic_lifecycle_reviewer_capability\(\)[\s\S]*?\$rpc\$([\s\S]*?)\$rpc\$/)
    const body = fnBodyMatch ? fnBodyMatch[1] : ''
    const returns = [...body.matchAll(/RETURN\s+([^;]+);/g)].map((m) => m[1].trim())
    expect(returns).toHaveLength(1)
    expect(returns[0]).toMatch(/^EXISTS \(/)
    expect(body).not.toMatch(/role|email|granted_by|provisioning_note|jsonb_build_object|jsonb_agg/i)
  })

  it('grants: REVOKE ALL FROM PUBLIC, anon, service_role and GRANT EXECUTE TO authenticated ONLY, in the CREATE branch', () => {
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.get_semantic_topic_lifecycle_reviewer_capability\(\) FROM PUBLIC, anon, service_role;/)
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_semantic_topic_lifecycle_reviewer_capability\(\) TO authenticated;/)
  })

  it('the final self-check independently re-verifies anon/service_role have NO EXECUTE and authenticated DOES', () => {
    expect(code).toMatch(/has_function_privilege\('anon', 'public\.get_semantic_topic_lifecycle_reviewer_capability\(\)'::regprocedure, 'EXECUTE'\)/)
    expect(code).toMatch(/has_function_privilege\('service_role', 'public\.get_semantic_topic_lifecycle_reviewer_capability\(\)'::regprocedure, 'EXECUTE'\)/)
    expect(code).toMatch(/NOT has_function_privilege\('authenticated', 'public\.get_semantic_topic_lifecycle_reviewer_capability\(\)'::regprocedure, 'EXECUTE'\)/)
  })

  it('contains no raw INSERT/UPDATE/DELETE SQL text anywhere in the migration', () => {
    expect(code).not.toMatch(/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i)
  })

  it('never touches, redefines, or references any 086/087/088 object', () => {
    expect(code).not.toMatch(/create_semantic_topic_lifecycle_review_request|record_semantic_topic_lifecycle_review_decision|cancel_semantic_topic_lifecycle_review_request|execute_approved_semantic_topic_lifecycle_transition|compute_topic_evidence_vector|list_semantic_topic_lifecycle_review_requests|get_semantic_topic_lifecycle_review_request|_semantic_topic_lifecycle_mechanical_check|_semantic_topic_lifecycle_snapshot_digest/)
  })

  it('has no hardcoded email address or literal user UUID anywhere in the file', () => {
    expect(code).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  })

  it('is wrapped in a single BEGIN/COMMIT transaction with NOTIFY pgrst before COMMIT', () => {
    expect(src.trim().startsWith('-- ')).toBe(true)
    expect(code).toMatch(/^\s*BEGIN;/m)
    expect(code).toMatch(/NOTIFY pgrst, 'reload schema';\s*\n\s*COMMIT;/)
  })
})
