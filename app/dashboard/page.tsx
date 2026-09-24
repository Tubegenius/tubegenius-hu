import { createServerSupabaseClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import PremiumToday from '@/components/dashboard/PremiumToday'

export default async function DashboardPage() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  const { data: profile } = await supabase
    .from('profiles').select('*').eq('user_id', user.id).single()

  const { data: memoryItems } = await supabase
    .from('creator_memory').select('*').eq('user_id', user.id)
    .order('updated_at', { ascending: false }).limit(20)

  const displayName = profile?.channel_name || user.email?.split('@')[0] || 'Alkotó'

  return (
    <PremiumToday
      profile={profile}
      displayName={displayName}
      memoryCount={memoryItems?.length || 0}
    />
  )
}
