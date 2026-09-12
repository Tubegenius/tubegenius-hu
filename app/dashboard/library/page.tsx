import { redirect } from 'next/navigation'
import CreatorLibrary from '@/components/dashboard/CreatorLibrary'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export default async function LibraryPage() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: items } = await supabase
    .from('creator_memory')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(6)

  return <CreatorLibrary items={items || []} />
}
