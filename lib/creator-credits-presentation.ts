const CREDIT_PLAN_LABELS: Record<string, string> = {
  beta: 'Beta',
  starter: 'Starter',
  creator: 'Creator',
  pro: 'Pro',
}

export function toCreditAmount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, value)
}

export function formatCreditAmount(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('hu-HU')
}

export function formatCreditPrice(value: number): string {
  return `${value.toLocaleString('hu-HU')} Ft`
}

export function creditPlanLabel(plan: string | null): string {
  if (!plan) return 'Nincs aktív csomag'
  return CREDIT_PLAN_LABELS[plan.toLowerCase()] ?? plan
}

export function formatCreditRenewalDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })
}
