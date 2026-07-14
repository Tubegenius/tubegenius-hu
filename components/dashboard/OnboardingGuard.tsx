'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

export default function OnboardingGuard({
  onboardingCompleted,
  children,
}: {
  onboardingCompleted: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const isProfilePage = pathname.startsWith('/dashboard/profile')
  const mustCompleteOnboarding = !onboardingCompleted && !isProfilePage

  useEffect(() => {
    if (mustCompleteOnboarding) {
      router.replace('/dashboard/profile?onboarding=1')
    }
  }, [mustCompleteOnboarding, router])

  if (mustCompleteOnboarding) return null

  return children
}
