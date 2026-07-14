import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createServerSupabaseClient() {
  // Next 15 still exposes synchronous cookie access for compatibility, while
  // its type is already Promise-based. Keeping this helper synchronous avoids
  // changing every caller until the full Next 16 async-request migration.
  const cookieStore = (cookies as unknown as () => {
    getAll(): ReturnType<Awaited<ReturnType<typeof cookies>>['getAll']>
    set(name: string, value: string, options?: Parameters<Awaited<ReturnType<typeof cookies>>['set']>[2]): void
  })()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )
}

export function createAdminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() {},
      },
    }
  )
}
