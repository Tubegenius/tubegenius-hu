import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { checkUsagePermission, type ProtectedFeature } from '@/lib/usage-protection'

export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Nem vagy bejelentkezve' }, { status: 401 })

    const { feature, override_soft_limit } = await request.json() as { feature: ProtectedFeature; override_soft_limit?: boolean }
    if (!feature) return NextResponse.json({ error: 'Feature megadása kötelező' }, { status: 400 })
    if (!['similar_videos', 'opportunity_engine'].includes(feature)) {
      return NextResponse.json({ error: 'Érvénytelen feature' }, { status: 400 })
    }

    const result = await checkUsagePermission(user.id, feature, override_soft_limit === true)
    return NextResponse.json(result)
  } catch (error) {
    console.error('Credit check error:', error)
    return NextResponse.json({ error: 'Ellenőrzés sikertelen' }, { status: 500 })
  }
}
