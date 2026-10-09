// LR-1 census runner -- exclusive (create-once) approval claim.
//
// The approval JSON is never rewritten. Its single use is decided by the
// atomic EXCLUSIVE CREATION of a sibling claim file (open flag "wx" ==
// O_CREAT|O_EXCL, CreateFile CREATE_NEW on Windows): when two runners race,
// exactly one create succeeds and the other gets EEXIST (verified by a
// two-process race test). The runner never deletes the claim file. A claim file
// that exists is a claim, whatever it contains.
//
// NOT claimed, NOT verified: survival of the claim after a crash or a power loss.
// The file content is fsynced on a best-effort basis, the directory entry is not,
// and there is no crash / power-loss test. Do not describe the claim as durable
// across such events without separate verification.
//
// Limit: this is atomic on a local file system. It is not a distributed lock
// and must not be used on a network share that does not honour O_EXCL.
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'

export type ClaimState = 'used' | 'burned'
export type ClaimResult = { ok: true } | { ok: false; reason: 'exists' | 'io_error' }

export function claimPathFor(approvalPath: string): string {
  return `${approvalPath}.claim`
}

/** Returns null only when the claim file does not exist. Anything else that exists counts as claimed. */
export function readClaimFile(claimPath: string): { state: ClaimState } | null {
  let text: string
  try {
    text = readFileSync(claimPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // exists but cannot be read: still a claim (fail closed)
    return { state: 'used' }
  }
  try {
    const parsed = JSON.parse(text) as { state?: unknown }
    return { state: parsed.state === 'burned' ? 'burned' : 'used' }
  } catch {
    return { state: 'used' }
  }
}

export function claimExclusive(claimPath: string, state: ClaimState, info: Record<string, string>): ClaimResult {
  let fd: number
  try {
    fd = openSync(claimPath, 'wx', 0o600)
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'io_error' }
  }
  // From here the claim EXISTS; a failed content write cannot undo it.
  try {
    writeSync(fd, `${JSON.stringify({ state, ...info })}\n`)
    fsyncSync(fd)
  } catch {
    /* the file's existence is the claim */
  }
  try {
    closeSync(fd)
  } catch {
    /* same */
  }
  return { ok: true }
}
