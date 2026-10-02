import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  // tsconfig.json sets "jsx": "preserve" (correct for Next.js's own
  // build, which does the JSX transform itself) -- Vite's default esbuild
  // transform, absent this override, reads that same setting and leaves
  // JSX untouched, which vitest's own pipeline cannot then parse. This
  // override is scoped to vitest's esbuild step only; it does not touch
  // tsconfig.json or Next's own build in any way. Needed starting with the
  // new RTL component-interaction suite (the first test file to import a
  // .tsx component tree rather than plain .ts modules).
  // Vite 8's default transform is oxc (not esbuild) -- oxc reads the same
  // tsconfig "jsx": "preserve" and needs the identical override, on its own
  // key, or it silently wins over an `esbuild` override and this whole
  // block would be a no-op.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    // .tsx added alongside the pre-existing .ts glob specifically for the
    // new RTL component-interaction suite (per-file `// @vitest-environment
    // jsdom` pragma) -- every other existing test file is still a plain
    // .test.ts and is unaffected by this widening.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // The -db-integration suites share ONE real local Postgres instance with
    // no per-file fixture isolation at the "due row" query level (e.g.
    // prepareObservationBatches scans the whole signal_observation_schedule
    // table). Running test FILES in parallel worker processes (vitest's
    // default) lets one file's still-uncleaned fixture rows leak into
    // another file's due-row query mid-run. Serializing file execution
    // removes that cross-file race entirely; it predates the 066 hardening
    // round and was only newly exposed by it, not caused by it.
    fileParallelism: false,
  },
})
