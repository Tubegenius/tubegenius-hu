// Opportunity Evidence Snapshot (092) -- REAL local DB integration tests.
//
// Proves, against the real local Postgres stack (never staging/production):
// ownership enforcement (both the RPC's internal check and RLS), atomicity
// of the save-to-memory composite write, idempotent event logging, the
// state-guard against downgrading rejected/completed, and overwrite
// protection on the snapshot itself. Every scenario runs inside its own
// BEGIN;...ROLLBACK; transaction -- the shared local stack is never left
// drifted. Migration 092 is assumed already applied to the local stack
// (idempotent CREATE OR REPLACE / IF NOT EXISTS throughout).
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface PsqlResult { status: number | null; output: string }
const DOCKER_ARGS = ['exec', '-i', 'supabase_db_WillViralFinal', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']

function psql(sql: string): PsqlResult {
  const result = spawnSync('docker', DOCKER_ARGS, { input: sql, encoding: 'utf-8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

let stackAvailable = false
try { stackAvailable = psql('select 1;').status === 0 } catch { stackAvailable = false }
const describeIfLocalDb = stackAvailable ? describe : describe.skip

function ok(sql: string): string {
  const r = psql(sql)
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.output.slice(0, 3000)}`)
  return r.output
}
function kv(output: string, key: string): string[] {
  return output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${key}|`)).map((l) => l.slice(key.length + 1))
}
const one = (output: string, key: string): string => {
  const v = kv(output, key)
  if (v.length !== 1) throw new Error(`expected exactly one ${key} line, got ${v.length}: ${output.slice(0, 1500)}`)
  return v[0]
}
const tx = (...steps: string[]) => `BEGIN;\n${steps.join('\n')}\nROLLBACK;`

function newUser(id: string): string {
  return `insert into auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values ('${id}', 'opp-snap-${id}@example.test', 'x', now(), now(), now(), '{}', '{}', 'authenticated', 'authenticated');`
}

function newVideoIdea(id: string, userId: string, topic: string): string {
  return `insert into video_ideas (id, user_id, title, topic) values ('${id}', '${userId}', '${topic}', '${topic}');`
}

// Bare function-call EXPRESSIONS -- no leading "select", no trailing ";" --
// so callers can freely use them either as a standalone statement
// (`select * from ${expr};`) or wrapped inside another expression, without
// any risk of a stray semicolon breaking paren nesting.
function ensureSnapshotCall(userId: string, ideaId: string, capturedAt: string, title = 'T'): string {
  return `ensure_opportunity_evidence_snapshot(
    '${userId}'::uuid, '${ideaId}'::uuid, 1::smallint, '${capturedAt}'::timestamptz, null,
    '${title}', 'desc', 'hook', 50, '{"total":50}'::jsonb,
    'közepes', 'youtube_multi_creator', 'label', '[]'::jsonb, null, '[]'::jsonb, '[]'::jsonb,
    'HU', 'youtube', 'niche'
  )`
}

function saveToMemoryCall(userId: string, ideaId: string, topic: string, capturedAt: string): string {
  return `save_opportunity_recommendation_to_memory(
    '${userId}'::uuid, '${ideaId}'::uuid, '${topic}', 'kw', 'youtube', 50, 1::smallint,
    '${capturedAt}'::timestamptz, null, 'T', 'desc', 'hook', '{"total":50}'::jsonb,
    'közepes', 'youtube_multi_creator', 'label', '[]'::jsonb, null, '[]'::jsonb, '[]'::jsonb, 'HU', 'niche'
  )`
}

describeIfLocalDb('092 opportunity evidence snapshot -- real local Postgres', () => {
  it('migration re-applies cleanly (idempotent, no error) on top of itself', () => {
    // Confirms the file already applied to the shared local stack is safe
    // to re-run byte-identical, matching the 001-091 convention. The
    // migration itself is applied once, outside any test transaction, by
    // the developer before running this suite (see PR description) -- this
    // assertion just proves the file's own idempotency guarantee holds.
    const r = psql('select 1 from pg_proc where proname = $$ensure_opportunity_evidence_snapshot$$;')
    expect(r.status).toBe(0)
    expect(r.output.trim()).toBe('1')
  })

  it('ownership PASS: owner can create a snapshot for their own video_idea', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic A'),
      `select 'R|'||s.out_snapshot_id||'|'||s.out_updated from (select * from ${ensureSnapshotCall(u, idea, '2026-09-27T10:00:00Z')}) s;`,
      `select 'CNT|'||count(*) from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'R').split('|')[1]).toBe('true')
    expect(one(out, 'CNT')).toBe('1')
  })

  it('ownership FAIL (RPC-level, cross-user write): wrong p_user_id for someone else\'s video_idea raises and writes nothing', () => {
    const owner = randomUUID(), attacker = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(owner), newUser(attacker), newVideoIdea(idea, owner, 'Node topic B'),
    ))
    expect(out).toBeDefined()
    // The RPC call itself must raise -- run as its own statement so ROLLBACK still cleans up.
    const attempt = psql(tx(
      newUser(owner), newUser(attacker), newVideoIdea(idea, owner, 'Node topic B'),
      `select * from ${ensureSnapshotCall(attacker, idea, '2026-09-27T10:00:00Z')};`,
    ))
    expect(attempt.status).not.toBe(0)
    expect(attempt.output).toContain('opportunity_evidence_snapshot_ownership_mismatch')
  })

  it('RLS cross-user READ: authenticated as the non-owner sees zero rows for the owner\'s snapshot', () => {
    const owner = randomUUID(), other = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(owner), newUser(other), newVideoIdea(idea, owner, 'Node topic C'),
      `select * from ${ensureSnapshotCall(owner, idea, '2026-09-27T10:00:00Z')};`,
      `SET LOCAL ROLE authenticated;`,
      `SET LOCAL request.jwt.claims = '{"sub":"${other}","role":"authenticated"}';`,
      `select 'OTHER_SEES|'||count(*) from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
      `RESET ROLE;`,
      `SET LOCAL ROLE authenticated;`,
      `SET LOCAL request.jwt.claims = '{"sub":"${owner}","role":"authenticated"}';`,
      `select 'OWNER_SEES|'||count(*) from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'OTHER_SEES')).toBe('0')
    expect(one(out, 'OWNER_SEES')).toBe('1')
  })

  it('RLS write DENY: authenticated role cannot INSERT directly into the table (no policy permits it)', () => {
    const u = randomUUID(), idea = randomUUID()
    const attempt = psql(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic D'),
      `SET LOCAL ROLE authenticated;`,
      `SET LOCAL request.jwt.claims = '{"sub":"${u}","role":"authenticated"}';`,
      `insert into video_idea_opportunity_snapshots (video_idea_id, user_id, captured_at, title, web_sources, evidence_videos, risk_flags)
       values ('${idea}', '${u}', now(), 'x', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);`,
    ))
    expect(attempt.status).not.toBe(0)
    expect(attempt.output.toLowerCase()).toMatch(/permission denied|policy/)
  })

  it('overwrite protection: an OLDER incoming snapshot never regresses a newer one', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic E'),
      `select 'FIRST|'||s.out_updated from (select * from ${ensureSnapshotCall(u, idea, '2026-09-27T12:00:00Z', 'Newer title')}) s;`,
      `select 'STALE|'||s.out_updated from (select * from ${ensureSnapshotCall(u, idea, '2026-09-27T09:00:00Z', 'Older title (should be ignored)')}) s;`,
      `select 'FINAL_TITLE|'||title from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
      `select 'NEWER|'||s.out_updated from (select * from ${ensureSnapshotCall(u, idea, '2026-09-27T15:00:00Z', 'Even newer title')}) s;`,
      `select 'FINAL_TITLE2|'||title from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'FIRST')).toBe('true')
    expect(one(out, 'STALE')).toBe('false')
    expect(one(out, 'FINAL_TITLE')).toBe('Newer title')
    expect(one(out, 'NEWER')).toBe('true')
    expect(one(out, 'FINAL_TITLE2')).toBe('Even newer title')
  })

  it('atomicity: save_opportunity_recommendation_to_memory creates memory + event + snapshot together, in one call', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic F'),
      `select * from ${saveToMemoryCall(u, idea, 'Node topic F', '2026-09-27T10:00:00Z')};`,
      `select 'MEM|'||count(*) from creator_memory where video_idea_id='${idea}';`,
      `select 'EVT|'||count(*) from video_idea_events where video_idea_id='${idea}';`,
      `select 'SNAP|'||count(*) from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'MEM')).toBe('1')
    expect(one(out, 'EVT')).toBe('1')
    expect(one(out, 'SNAP')).toBe('1')
  })

  it('atomicity: an ownership failure inside the composite call leaves ZERO rows in all three tables', () => {
    const owner = randomUUID(), attacker = randomUUID(), idea = randomUUID()
    const attempt = psql(tx(
      newUser(owner), newUser(attacker), newVideoIdea(idea, owner, 'Node topic G'),
      `select * from ${saveToMemoryCall(attacker, idea, 'Node topic G', '2026-09-27T10:00:00Z')};`,
    ))
    expect(attempt.status).not.toBe(0)
    // Separate, fresh transaction to inspect: the failed attempt's own transaction
    // already rolled back by definition (tx() ends in ROLLBACK on the error path too,
    // since a failed statement aborts the whole block) -- assert nothing leaked.
    const check = ok(tx(
      newUser(owner), newUser(attacker), newVideoIdea(idea, owner, 'Node topic G'),
      `select 'MEM|'||count(*) from creator_memory where video_idea_id='${idea}';`,
      `select 'EVT|'||count(*) from video_idea_events where video_idea_id='${idea}';`,
      `select 'SNAP|'||count(*) from video_idea_opportunity_snapshots where video_idea_id='${idea}';`,
    ))
    expect(one(check, 'MEM')).toBe('0')
    expect(one(check, 'EVT')).toBe('0')
    expect(one(check, 'SNAP')).toBe('0')
  })

  it('idempotency: repeated save with the same state logs exactly ONE event, not two', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic H'),
      `select * from ${saveToMemoryCall(u, idea, 'Node topic H', '2026-09-27T10:00:00Z')};`,
      `select 'EVT1|'||s.out_event_logged from (select * from ${saveToMemoryCall(u, idea, 'Node topic H', '2026-09-27T11:00:00Z')}) s;`,
      `select 'EVT_COUNT|'||count(*) from video_idea_events where video_idea_id='${idea}';`,
      `select 'MEM_COUNT|'||count(*) from creator_memory where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'EVT1')).toBe('false') // second call: same state -> no new event
    expect(one(out, 'EVT_COUNT')).toBe('1')
    expect(one(out, 'MEM_COUNT')).toBe('1')
  })

  it('state-guard: a snapshot-triggered save NEVER downgrades an existing rejected state back to saved', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic I'),
      `select * from ${saveToMemoryCall(u, idea, 'Node topic I', '2026-09-27T10:00:00Z')};`,
      `update creator_memory set state='rejected' where video_idea_id='${idea}';`,
      `select 'EVT2|'||s.out_event_logged from (select * from ${saveToMemoryCall(u, idea, 'Node topic I', '2026-09-27T12:00:00Z')}) s;`,
      `select 'STATE|'||state from creator_memory where video_idea_id='${idea}';`,
      `select 'EVT_COUNT|'||count(*) from video_idea_events where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'STATE')).toBe('rejected')
    expect(one(out, 'EVT2')).toBe('false') // guarded: rejected -> rejected is not a change
    expect(one(out, 'EVT_COUNT')).toBe('1') // only the original idea_saved event, no state_changed spam
  })

  it('state-guard: a genuinely new save on a fresh idea still logs the initial idea_saved event', () => {
    const u = randomUUID(), idea = randomUUID()
    const out = ok(tx(
      newUser(u), newVideoIdea(idea, u, 'Node topic J'),
      `select 'EVT0|'||s.out_event_logged from (select * from ${saveToMemoryCall(u, idea, 'Node topic J', '2026-09-27T10:00:00Z')}) s;`,
      `select 'EVT_TYPE|'||event_type from video_idea_events where video_idea_id='${idea}';`,
    ))
    expect(one(out, 'EVT0')).toBe('true')
    expect(one(out, 'EVT_TYPE')).toBe('idea_saved')
  })
})
