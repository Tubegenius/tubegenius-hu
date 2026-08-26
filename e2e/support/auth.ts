// PFM Reviewer UI -- Playwright E2E and Runtime Closure gate.
//
// Local-only GoTrue admin-API helpers for creating/deleting disposable test
// users against the local Supabase Auth stack (127.0.0.1:54321). The
// service-role JWT used here is minted at call time from the well-known
// local Supabase CLI signing secret (see playwright.config.ts) and is only
// ever used from this Node-side helper -- never passed into a browser
// context or page.
import crypto from 'node:crypto'

const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321'
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

function serviceRoleHeaders(): Record<string, string> {
  const key = signLocalJwt('service_role')
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

export interface TestUser {
  id: string
  email: string
  password: string
}

export async function createTestUser(emailPrefix: string, password: string): Promise<TestUser> {
  const email = `${emailPrefix}@example.test`
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: serviceRoleHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const body = await res.json()
  if (!res.ok || !body.id) {
    throw new Error(`createTestUser(${email}) failed: ${res.status} ${JSON.stringify(body)}`)
  }
  return { id: body.id as string, email, password }
}

export async function deleteTestUser(userId: string): Promise<void> {
  const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceRoleHeaders(),
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.text()
    throw new Error(`deleteTestUser(${userId}) failed: ${res.status} ${body}`)
  }
}
