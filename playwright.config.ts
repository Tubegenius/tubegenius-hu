import { defineConfig, devices } from '@playwright/test'
import crypto from 'node:crypto'

// PFM Reviewer UI -- Playwright E2E and Runtime Closure gate.
//
// This config deliberately never reads .env.local. It mints its own
// short-lived local anon/service-role JWTs from the well-known Supabase CLI
// default signing secret ('super-secret-jwt-token-with-at-least-32-characters-long'
// -- the public, documented default every `supabase start` stack uses
// locally, never a real secret and never valid against any deployed
// project) instead of hardcoding the token strings themselves. That
// guarantees the signature always matches whatever local stack is actually
// running -- a hand-copied token string silently going stale (wrong
// signature against this machine's stack) is exactly the failure mode a
// prior round of this gate hit and had to re-diagnose.
const LOCAL_SUPABASE_JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'

function signLocalJwt(role: 'anon' | 'service_role'): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { role, iss: 'supabase-demo', iat: now, exp: now + 60 * 60 * 6 }
  const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const data = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  const sig = b64url(crypto.createHmac('sha256', LOCAL_SUPABASE_JWT_SECRET).update(data).digest())
  return `${data}.${sig}`
}

const PORT = 3200
const BASE_URL = `http://127.0.0.1:${PORT}`
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  // The human-review specs share one local Postgres fixture set with
  // marker-scoped cleanup, not per-worker isolation -- serialize to avoid
  // cross-test fixture races, matching vitest.config.ts's own
  // fileParallelism:false rationale for the same DB.
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Never record video: a reviewer session's screen could transiently
    // show real evidence/quote text, and video is not needed on top of
    // trace + failure screenshots for this suite's diagnostic value.
    video: 'off',
  },
  projects: [
    {
      name: 'edge',
      // Uses the already-installed system Microsoft Edge (channel
      // 'msedge') -- no Chromium binary is downloaded by this config.
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: signLocalJwt('anon'),
      // Server-only: consumed exclusively by lib/supabase-server.ts's admin
      // client inside API routes. Never forwarded to the browser context or
      // to any `use.extraHTTPHeaders` -- Playwright's browser pages never
      // see process.env, so this cannot leak into page/network traces.
      SUPABASE_SERVICE_ROLE_KEY: signLocalJwt('service_role'),
      SEMANTIC_TOPIC_HUMAN_REVIEW_ENABLED: 'true',
    },
  },
})
