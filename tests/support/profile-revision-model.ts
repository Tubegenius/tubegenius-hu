// A TypeScript REFERENCE MODEL of the profiles field-revision trigger (migration 094). It is the SPECIFICATION of the
// intended behaviour, written down as executable code so the invariants can be tested without a database.
//
// IT IS NOT THE SQL. A passing test of this model proves that the specification is consistent and that the decision
// core (lib/creator-focus) behaves correctly on revisions that follow it. It does NOT prove that the migration's
// plpgsql behaves like this: that needs a real database (open item, see docs/operations/profiles-field-revision.md).
// The source-policy test (094-...-source-policy.test.ts) pins the SQL text to the same rules.
//
// The model uses JS numbers (safe integers) for the sequence: the project's TypeScript target has no BigInt literals,
// and the model never needs more than a few thousand values. The real column is bigint; its text form is checked
// against the decision core's canonical-decimal contract separately (isCanonicalRevisionText).
import { REVISION_PATTERN } from '@/lib/creator-focus'

export interface ModelRow {
  user_id: string
  specific_focus: string | null
  main_category: string | null
  specific_focus_revision: number
  main_category_revision: number
}

export interface ModelInput {
  specific_focus?: string | null
  main_category?: string | null
  /** what a (malicious or confused) client tries to write: the trigger must ignore it */
  specific_focus_revision?: number
  main_category_revision?: number
}

export class ProfileRevisionModel {
  /** last value handed out (is_called = lastIssued > 0) */
  lastIssued = 0
  /** every value nextval() ever returned, in order (aborted transactions included) */
  readonly everIssued: number[] = []
  readonly rows = new Map<string, ModelRow>()
  /** ALTER TABLE ... DISABLE TRIGGER / session_replication_role = replica: the documented limit of the guarantee */
  triggersDisabled = false

  /** @param maxValue the sequence's MAXVALUE; NO CYCLE: reaching it is an error, never a wrap-around */
  constructor(readonly maxValue: number = Number.MAX_SAFE_INTEGER) {}

  nextval(): number {
    if (this.lastIssued >= this.maxValue) throw new Error('nextval: reached maximum value of sequence (NO CYCLE)')
    this.lastIssued += 1
    this.everIssued.push(this.lastIssued)
    return this.lastIssued
  }

  /** an aborted transaction: it called nextval() and rolled back; sequences are not transactional */
  abortedTransaction(calls = 1): void {
    for (let i = 0; i < calls; i++) this.nextval()
  }

  insert(userId: string, input: ModelInput = {}): ModelRow {
    if (this.rows.has(userId)) throw new Error('duplicate key')
    const row: ModelRow = {
      user_id: userId,
      specific_focus: input.specific_focus ?? null,
      main_category: input.main_category ?? null,
      specific_focus_revision: input.specific_focus_revision ?? 0,
      main_category_revision: input.main_category_revision ?? 0,
    }
    if (!this.triggersDisabled) {
      // BEFORE INSERT: always fresh, whatever the client sent
      row.specific_focus_revision = this.nextval()
      row.main_category_revision = this.nextval()
    } else if (row.specific_focus_revision === 0 || row.main_category_revision === 0) {
      throw new Error('null value in column violates not-null constraint (no DEFAULT, trigger disabled)')
    }
    this.afterAssert(null, row)
    this.rows.set(userId, row)
    return { ...row }
  }

  /** an UPDATE statement as the app issues it: a patch of columns (the form writes every field on every save) */
  update(userId: string, patch: ModelInput): ModelRow {
    const old = this.rows.get(userId)
    if (!old) throw new Error('no such row')
    const next: ModelRow = { ...old, ...definedOnly(patch) }
    if (!this.triggersDisabled) {
      // BEFORE UPDATE, field by field
      next.specific_focus_revision = next.specific_focus !== old.specific_focus ? this.nextval() : old.specific_focus_revision
      next.main_category_revision = next.main_category !== old.main_category ? this.nextval() : old.main_category_revision
    }
    this.afterAssert(old, next)
    this.rows.set(userId, next)
    return { ...next }
  }

  /** the AFTER trigger: fail-closed. Throws; the statement (and so the whole row change) does not happen. */
  afterAssert(old: ModelRow | null, next: ModelRow): void {
    const violations = revisionViolations(old, next, this.lastIssued)
    if (violations.length > 0) throw new Error(violations[0])
  }

  /** what the future snapshot reader gets: revisions read as TEXT (::text) */
  snapshot(userId: string): { value: { specific_focus: string | null; main_category: string | null }; revision: { specific_focus: string; main_category: string } } {
    const row = this.rows.get(userId)
    if (!row) throw new Error('no such row')
    return {
      value: { specific_focus: row.specific_focus, main_category: row.main_category },
      revision: { specific_focus: String(row.specific_focus_revision), main_category: String(row.main_category_revision) },
    }
  }
}

function definedOnly(patch: ModelInput): Partial<ModelRow> {
  // JS undefined = column not in the SET list; null is a real value
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<ModelRow>
}

/** mirrors public.profiles_field_revision_assert(): the list of violated invariants (empty = fine) */
export function revisionViolations(old: ModelRow | null, next: ModelRow, issued: number): string[] {
  const out: string[] = []
  const revisions = [next.specific_focus_revision, next.main_category_revision]
  if (revisions.some(r => r < 1 || r > issued)) out.push('a revision is missing, not positive, or was never issued')
  if (next.specific_focus_revision === next.main_category_revision) out.push('two fields share one revision')
  if (old) {
    const check = (field: 'specific_focus' | 'main_category') => {
      const rev = `${field}_revision` as 'specific_focus_revision' | 'main_category_revision'
      if (next[field] !== old[field]) {
        if (next[rev] === old[rev]) out.push(`${field} changed without a new revision`)
      } else if (next[rev] !== old[rev]) {
        out.push(`${field} revision changed without a value change`)
      }
    }
    check('specific_focus')
    check('main_category')
  }
  return out
}

/** the contract of the text form: canonical decimal, at most 19 digits (a bigint's full range) */
export const isCanonicalRevisionText = (text: string): boolean => REVISION_PATTERN.test(text)
