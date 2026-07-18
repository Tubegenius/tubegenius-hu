'use client'

import { useState, type ReactNode } from 'react'

export interface OnboardingStep {
  key: string
  label: string
  content: ReactNode
}

interface OnboardingStepperProps {
  steps: OnboardingStep[]
  submitSlot: ReactNode
}

// Tisztán UX-particionálás: első futáskor (?onboarding=1) egyszerre csak
// egy lépés kártyája látszik, "Vissza/Tovább" navigációval. A tényleges
// mentés (submitSlot) az utolsó lépésen jelenik meg — ugyanaz a submit
// gomb, ugyanaz a handleSave, csak máshol renderelve.
export default function OnboardingStepper({ steps, submitSlot }: OnboardingStepperProps) {
  const [index, setIndex] = useState(0)
  const step = steps[index]
  const isLast = index === steps.length - 1
  const progressPct = ((index + 1) / steps.length) * 100

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="section-label">{step.label}</p>
        <span className="text-xs text-text-muted">{index + 1}/{steps.length}</span>
      </div>
      <div className="w-full h-1 rounded-full mb-6" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #3B82F6, #8B5CF6)' }} />
      </div>

      <div className="space-y-6">{step.content}</div>

      <div className="flex items-center gap-3 mt-6">
        <button
          type="button"
          onClick={() => setIndex(i => Math.max(0, i - 1))}
          disabled={index === 0}
          className="btn-secondary text-sm px-4 py-2 disabled:opacity-40"
        >
          Vissza
        </button>
        {isLast ? (
          <div className="flex-1">{submitSlot}</div>
        ) : (
          <button
            type="button"
            onClick={() => setIndex(i => Math.min(steps.length - 1, i + 1))}
            className="btn-primary flex-1 text-sm px-5 py-2"
          >
            Tovább
          </button>
        )}
      </div>
    </div>
  )
}
