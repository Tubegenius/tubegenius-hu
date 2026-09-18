import { describe, expect, it } from 'vitest'
import {
  creditPlanLabel,
  formatCreditAmount,
  formatCreditPrice,
  formatCreditRenewalDate,
  toCreditAmount,
} from '@/lib/creator-credits-presentation'

describe('creator credits presentation', () => {
  it('accepts finite balances and rejects missing or invalid values', () => {
    expect(toCreditAmount(42.5)).toBe(42.5)
    expect(toCreditAmount(-3)).toBe(0)
    expect(toCreditAmount(Number.NaN)).toBeNull()
    expect(toCreditAmount('42')).toBeNull()
  })

  it('formats credit values without inventing a fallback balance', () => {
    expect(formatCreditAmount(null)).toBe('—')
    expect(formatCreditAmount(12.6)).toBe('13')
  })

  it('keeps prices and known plan names presentation-only', () => {
    expect(formatCreditPrice(5990)).toContain('5')
    expect(formatCreditPrice(5990)).toContain('990 Ft')
    expect(creditPlanLabel('creator')).toBe('Creator')
    expect(creditPlanLabel(null)).toBe('Nincs aktív csomag')
    expect(creditPlanLabel('custom')).toBe('custom')
  })

  it('does not display invalid renewal timestamps', () => {
    expect(formatCreditRenewalDate(null)).toBeNull()
    expect(formatCreditRenewalDate('not-a-date')).toBeNull()
    expect(formatCreditRenewalDate('2026-09-20T12:00:00.000Z')).toMatch(/2026/)
  })
})
