'use client'

import { useId } from 'react'
import { useFocusTrap } from '@/lib/useFocusTrap'

interface ConfirmActionModalProps {
  titleText: string
  bodyText: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

// Egyetlen újrafelhasználható megerősítő modal a cancel / revoke / rejection
// megerősítéshez -- ugyanaz a fókusz-csapda + role="dialog" minta, mint a
// meglévő components/CreditConfirmModal.tsx-ben.
export default function ConfirmActionModal({
  titleText,
  bodyText,
  confirmLabel,
  cancelLabel = 'Mégse',
  tone = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmActionModalProps) {
  const titleId = useId()
  const bodyId = useId()
  const containerRef = useFocusTrap(onCancel)
  const confirmColor = tone === 'danger' ? '#EF4444' : '#3B82F6'
  const confirmBg = tone === 'danger' ? 'rgba(239,68,68,0.1)' : 'rgba(59,130,246,0.1)'
  const confirmBorder = tone === 'danger' ? 'rgba(239,68,68,0.3)' : 'rgba(59,130,246,0.3)'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(8,11,18,0.7)' }} onClick={onCancel}>
      <div
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="rounded-2xl p-6 max-w-md w-full"
        style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 id={titleId} className="font-semibold text-lg mb-2" style={{ color: '#F8FAFC' }}>
          {titleText}
        </h3>
        <p id={bodyId} className="text-sm mb-5 whitespace-pre-line" style={{ color: '#CBD5E1' }}>
          {bodyText}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2 rounded-lg text-sm font-medium"
            style={{ background: '#121826', border: '1px solid rgba(255,255,255,0.08)', color: '#CBD5E1' }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 py-2 rounded-lg text-sm font-medium"
            style={{ background: confirmBg, border: `1px solid ${confirmBorder}`, color: confirmColor }}
          >
            {loading ? 'Feldolgozás...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
