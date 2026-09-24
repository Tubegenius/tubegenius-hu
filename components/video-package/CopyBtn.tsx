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
      className={`wv-package-copy${compact ? ' is-compact' : ''}${copied ? ' is-copied' : ''}`}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {!compact && <span>{copied ? 'Másolva' : label}</span>}
    </button>
  )
}
