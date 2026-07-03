import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard/trend-feed-history
// Az utolsó néhány napi Trend Feed snapshot (lásd app/api/opportunity/route.ts
// mentési lépését) — ingyenes, csak DB-olvasás, nincs új keresés/kreditlevonás.
// A user így vissza tudja nézni a tegnapi (vagy korábbi) ajánlást is.
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()

  const { data } = await admin
    .from('trend_feed_daily_snapshots')
    .select('snapshot_date, niche, topics, created_at')
    .eq('user_id', user.id)
    .order('snapshot_date', { ascending: false })
    .limit(7)

  return NextResponse.json({ snapshots: data || [] })
}
