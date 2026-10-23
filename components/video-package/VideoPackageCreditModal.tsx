'use client'

// A Video Package indítás előtti kreditablaka. KÜLÖN komponens a közös CreditConfirmModal-tól: az ott látható
// "Művelet költsége" / "Futtatás után marad" sorok feltétel nélküli költséget és biztos egyenleget állítanának, itt viszont
// cache-találat (0 kredit) és új generálás (legfeljebb N kredit) is lehetséges. A szövegek: lib/video-package-credit-gate.ts.
import { useId } from 'react'
import { useFocusTrap } from '@/lib/useFocusTrap'
import { formatCreditAmount } from '@/lib/creator-credits-presentation'
import { creditModalCopy, type VideoPackageCreditCheck } from '@/lib/video-package-credit-gate'

interface Props {
  check: VideoPackageCreditCheck
  onConfirm: () => void
  onCancel: () => void
}

const row = 'flex justify-between text-sm mb-1'

export default function VideoPackageCreditModal({ check, onConfirm, onCancel }: Props) {
  const titleId = useId()
  const containerRef = useFocusTrap(onCancel)
  const copy = creditModalCopy(check)
  const featureLabel = check.feature === 'Video Package (Shorts)' ? 'Gyártási csomag (Shorts)' : check.feature === 'Video Package (Long)' ? 'Gyártási csomag (Long)' : check.feature
  const balanceText = check.balance === null ? '—' : formatCreditAmount(check.balance)
  const worstCaseLeft = check.balance === null ? null : Math.max(0, check.balance - check.maxCost)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onCancel}>
      <div ref={containerRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-credit-mode={check.mode}
        className="rounded-2xl p-6 max-w-sm w-full" style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }} onClick={e => e.stopPropagation()}>
        <h3 id={titleId} className="font-semibold text-lg mb-1" style={{ color: '#F8FAFC' }}>{copy.title}</h3>
        <p className="text-xs mb-2" style={{ color: '#94A3B8' }}>{featureLabel}</p>
        <p className="text-sm mb-4" style={{ color: '#CBD5E1' }}>{copy.message}</p>

        <div className="rounded-lg px-4 py-3 mb-4" style={{ background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)' }}>
          <div className={row}>
            <span style={{ color: '#CBD5E1' }}>Meglévő eredmény megnyitása</span>
            <span style={{ color: '#22C55E' }} className="font-semibold">0 kredit</span>
          </div>
          <div className={row}>
            <span style={{ color: '#CBD5E1' }}>Új generálás</span>
            <span style={{ color: check.mode === 'insufficient' ? '#EF4444' : '#3B82F6' }} className="font-semibold">
              {check.mode === 'insufficient' ? `${formatCreditAmount(check.maxCost)} kredit szükséges` : `legfeljebb ${formatCreditAmount(check.maxCost)} kredit`}
            </span>
          </div>
          <div className={row}>
            <span style={{ color: '#CBD5E1' }}>Jelenlegi kredited</span>
            <span style={{ color: check.mode === 'insufficient' ? '#EF4444' : '#F8FAFC' }} className="font-semibold">{balanceText}</span>
          </div>
          {check.mode === 'covered' && worstCaseLeft !== null && (
            <div className="flex justify-between text-sm pt-2" style={{ borderTop: '1px solid rgba(59,130,246,0.1)' }}>
              <span style={{ color: '#CBD5E1' }}>Új generálás esetén legalább ennyi marad</span>
              <span style={{ color: '#22C55E' }} className="font-semibold">{formatCreditAmount(worstCaseLeft)}</span>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}>
            Mégse
          </button>
          <button type="button" onClick={onConfirm} className="flex-1 py-2 rounded-lg text-sm font-medium" style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#93C5FD' }}>
            {copy.confirmLabel}
          </button>
        </div>
        {check.mode === 'insufficient' && (
          <a href="/dashboard/credits" className="block text-center text-xs mt-3" style={{ color: '#3B82F6' }}>Kredit feltöltése</a>
        )}
      </div>
    </div>
  )
}
