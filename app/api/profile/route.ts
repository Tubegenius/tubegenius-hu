import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(request: NextRequest) {
  try {
    const cookieStore = cookies()
    
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll() {},
        },
      }
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError) {
      console.error('Auth error:', authError)
      return NextResponse.json({ error: 'Auth hiba: ' + authError.message }, { status: 401 })
    }
    
    if (!user) {
      return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })
    }

    const body = await request.json()
    console.log('Updating profile for user:', user.id)

    const { error } = await supabase
      .from('profiles')
      .update({ ...body, onboarding_completed: true })
      .eq('user_id', user.id)

    if (error) {
      console.error('Update error:', error)
      return NextResponse.json({ error: 'A profil frissítése sikertelen. Próbáld újra.' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('Unexpected error:', e)
    return NextResponse.json({ error: 'Váratlan hiba' }, { status: 500 })
  }
}