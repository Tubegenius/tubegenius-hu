import { createServerSupabaseClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import OnboardingGuard from '@/components/dashboard/OnboardingGuard'
import DailySoftLimitGuard from '@/components/dashboard/DailySoftLimitGuard'
import CreatorOSShell from '@/components/dashboard/CreatorOSShell'
import { CreatorOSProvider } from '@/components/dashboard/CreatorOSContext'
import { CreditBalanceProvider } from '@/components/credits/CreditBalanceContext'
import AuthSessionGuard from '@/components/auth/AuthSessionGuard'
import './creator-os.css'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  // Profil betöltése
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single()

  // Onboarding-kényszer: lásd middleware.ts (pathname-tudatos, itt a
  // layoutban self-redirect hurkot okozna a /dashboard/profile oldalon).

  return (
    <CreditBalanceProvider key={user.id}>
      <CreatorOSProvider>
        <AuthSessionGuard />
        <DailySoftLimitGuard />
        <CreatorOSShell profile={profile} userEmail={user.email}>
          <OnboardingGuard onboardingCompleted={profile?.onboarding_completed === true}>
            {children}
          </OnboardingGuard>
        </CreatorOSShell>
      </CreatorOSProvider>
    </CreditBalanceProvider>
  )
}
