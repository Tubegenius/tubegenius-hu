import { createServerSupabaseClient } from '@/lib/supabase-server'
import DashboardClient from '@/components/dashboard/DashboardClient'

export default async function DashboardPage() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: profile } = await supabase
    .from('profiles').select('*').eq('user_id', user!.id).single()

  const { data: memoryItems } = await supabase
    .from('creator_memory').select('*').eq('user_id', user!.id)
    .order('updated_at', { ascending: false }).limit(20)

  const displayName = profile?.channel_name || user!.email?.split('@')[0] || 'Creator'

  return (
    <DashboardClient
      profile={profile}
      memoryItems={memoryItems || []}
      displayName={displayName}
    />
  )
}
