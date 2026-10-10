// LR-1 census runner -- the only place that starts a psql process.
// The census SQL reaches psql through STDIN, from the very bytes that were hashed
// and approved (`-f -`): the file path is never handed to psql, so the file can
// change on disk after the hash check without changing what runs. The password is
// typed into psql's own -W prompt; this module never sees it and never sets
// PGPASSWORD. The child gets a minimal private environment, not the parent's.
import { spawn } from 'node:child_process'
import { devNull } from 'node:os'

export interface PsqlTarget {
  host: string
  port: string
  database: string
}

export interface PsqlRun {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface PsqlOptions {
  /** 'psql' in production; tests point it at a local stand-in (no database involved). */
  executable?: string
  argPrefix?: readonly string[]
  timeoutMs: number
}

export function buildChildEnv(target: PsqlTarget, role: string, parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: parentEnv.PATH,
    PGHOST: target.host.trim(),
    PGPORT: target.port.trim() === '' ? '5432' : target.port.trim(),
    PGDATABASE: target.database.trim(),
    PGUSER: role.trim(),
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '10',
    PGPASSFILE: devNull,
    PSQLRC: devNull,
  }
  if (parentEnv.SystemRoot) env.SystemRoot = parentEnv.SystemRoot
  if (parentEnv.TEMP) env.TEMP = parentEnv.TEMP
  return env
}

export const CENSUS_PSQL_ARGS: readonly string[] = ['-X', '-q', '--no-psqlrc', '-W', '-v', 'ON_ERROR_STOP=1', '--csv', '-f', '-']

export function probePsqlArgs(probeSql: string): string[] {
  return ['-X', '-q', '--no-psqlrc', '-W', '-v', 'ON_ERROR_STOP=1', '--csv', '-t', '-c', probeSql]
}

function run(args: readonly string[], env: Record<string, string | undefined>, stdinBytes: Uint8Array | null, options: PsqlOptions): Promise<PsqlRun> {
  return new Promise((resolveRun) => {
    const child = spawn(options.executable ?? 'psql', [...(options.argPrefix ?? []), ...args], {
      env: env as NodeJS.ProcessEnv,
      stdio: [stdinBytes ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', () => {
      clearTimeout(timer)
      resolveRun({ exitCode: null, stdout: '', stderr: 'psql could not be started', timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ exitCode: code, stdout, stderr, timedOut })
    })
    if (stdinBytes && child.stdin) {
      child.stdin.on('error', () => { /* a closed pipe surfaces through the exit code */ })
      child.stdin.end(Buffer.from(stdinBytes))
    }
  })
}

/** Runs the approved census bytes (stdin). Nothing else is ever sent. */
export function runCensusPsql(target: PsqlTarget, role: string, sqlBytes: Uint8Array, options: PsqlOptions): Promise<PsqlRun> {
  return run(CENSUS_PSQL_ARGS, buildChildEnv(target, role), sqlBytes, options)
}

/** Runs the fixed second-factor probe (a constant passed by the caller). */
export function runProbePsql(target: PsqlTarget, role: string, probeSql: string, options: PsqlOptions): Promise<PsqlRun> {
  return run(probePsqlArgs(probeSql), buildChildEnv(target, role), null, options)
}
