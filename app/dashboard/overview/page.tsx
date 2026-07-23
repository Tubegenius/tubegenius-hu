import { createServerSupabaseClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import OverviewClient from '@/components/dashboard/OverviewClient'

export default async function OverviewPage() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  const { data: profile } = await supabase
    .from('profiles').select('*').eq('user_id', user.id).single()

  const displayName = profile?.channel_name || user.email?.split('@')[0] || 'Creator'

  return <OverviewClient displayName={displayName} profile={profile} />
}
