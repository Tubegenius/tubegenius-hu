'use client'

import Link from 'next/link'
import { WalletCards } from 'lucide-react'
import { useCreditBalance } from '@/components/credits/CreditBalanceContext'
import { formatCreditAmount } from '@/lib/creator-credits-presentation'

export default function CreditBalanceIndicator() {
  const { credits, status } = useCreditBalance()
  const label = status === 'loading'
    ? 'Betöltés…'
    : status === 'error'
      ? 'Nem elérhető'
      : `${formatCreditAmount(credits?.total_available_credits ?? null)} kredit`

  return (
    <Link
      href="/dashboard/credits"
      className="wv-credit-indicator"
      data-state={status}
      aria-label={status === 'ready' ? `Kreditek és számlázás, ${label}` : `Kreditek és számlázás, egyenleg ${label.toLocaleLowerCase('hu-HU')}`}
    >
      <WalletCards aria-hidden="true" />
      <span>{label}</span>
    </Link>
  )
}
