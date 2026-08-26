'use client'

import { useId } from 'react'

interface TextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  maxLength: number
  multiline?: boolean
  required?: boolean
  disabled?: boolean
  error?: string | null
  placeholder?: string
  rows?: number
}

// Egységes, accessible szöveges mező karakterszámlálóval -- a meglévő
// .input osztályra épül (app/globals.css), hibaüzenetnél aria-describedby
// köti össze a mezőt a hibaszöveggel, és a hibaüzenet id-je alapján a
// szülő form tudja rá fókuszálni az első hibás mezőt submitkor.
export default function FormField({ label, value, onChange, maxLength, multiline, required, disabled, error, placeholder, rows = 3 }: TextFieldProps) {
  const inputId = useId()
  const errorId = useId()
  const counterColor = value.length > maxLength ? '#EF4444' : '#64748B'

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label htmlFor={inputId} className="text-sm font-medium" style={{ color: '#CBD5E1' }}>
          {label}
          {required && <span style={{ color: '#EF4444' }}> *</span>}
        </label>
        <span className="text-xs" style={{ color: counterColor }} aria-hidden="true">
          {value.length}/{maxLength}
        </span>
      </div>
      {multiline ? (
        <textarea
          id={inputId}
          className="input resize-y"
          rows={rows}
          value={value}
          onChange={e => onChange(e.target.value)}
          maxLength={maxLength + 50 /* enged rövid túllépést, hogy a hiba látszódjon, de submit blokkolva marad */}
          disabled={disabled}
          placeholder={placeholder}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          className="input"
          value={value}
          onChange={e => onChange(e.target.value)}
          maxLength={maxLength + 50}
          disabled={disabled}
          placeholder={placeholder}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs mt-1.5" style={{ color: '#EF4444' }}>
          {error}
        </p>
      )}
    </div>
  )
}
