import { createServerSupabaseClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'

export default async function Home() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  } else {
    redirect('/auth/login')
  }
}
