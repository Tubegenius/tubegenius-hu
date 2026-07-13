import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith('/api/cron/')) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const isPublicPath = request.nextUrl.pathname.startsWith('/auth')
    || request.nextUrl.pathname === '/privacy'
    || request.nextUrl.pathname === '/terms'

  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL('/auth/login', request.url))
  }

  if (user && request.nextUrl.pathname.startsWith('/auth')) {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // Onboarding-kenyszer: befejezetlen profillal (onboarding_completed=false)
  // minden /dashboard/* utvonal /dashboard/profile-ra iranyul, MAGAT a
  // profil oldalt kiveve (kulonben vegtelen redirect-hurok lenne). A
  // korabbi, app/dashboard/layout.tsx-ben levo ellenorzes holt kod volt
  // (ures if-ag, sosem hivott redirect()) — ez a pathname-tudatos
  // middleware a biztonsagos hely erre, mert mar amugy is minden
  // navigacion lefut.
  if (user
    && request.nextUrl.pathname.startsWith('/dashboard')
    && !request.nextUrl.pathname.startsWith('/dashboard/profile')
  ) {
    const { data: profile } = await supabase.from('profiles').select('onboarding_completed').eq('user_id', user.id).single()
    if (profile && !profile.onboarding_completed) {
      return NextResponse.redirect(new URL('/dashboard/profile?onboarding=1', request.url))
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
