'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

interface CopyBtnProps {
  text: string
  label: string
  compact?: boolean
}

// Vágólap-másoló gomb — a viselkedés (navigator.clipboard.writeText + 2
// másodperces "Másolva" visszajelzés) byte-pontosan megegyezik a
// video-package oldal korábbi, oldal-lokális CopyBtn-jével. Nem hív
// semmilyen generálási, mentési vagy kreditlogikát.
export default function CopyBtn({ text, label, compact = false }: CopyBtnProps) {
  const [copied, setCopied] = useState(false)

  function handleClick() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={compact ? (copied ? 'Másolva' : label) : undefined}
      className={`inline-flex items-center gap-1.5 rounded-lg border transition-all ${compact ? 'p-1.5' : 'text-xs px-3 py-1.5'}`}
      style={{
        background: copied ? 'rgba(34,197,94,0.1)' : '#121826',
        border: copied ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(255,255,255,0.08)',
        color: copied ? '#22C55E' : '#CBD5E1',
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />}
      {!compact && <span>{copied ? 'Másolva' : label}</span>}
    </button>
  )
}
