import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
