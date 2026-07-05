'use client'

import { useState, useEffect } from 'react'

interface LoadingScreenProps {
  steps?: string[]
  currentStep?: number
  message?: string
}

const DEFAULT_STEPS = [
  'Rendszer inicializálása...',
  'Adatok betöltése...',
  'Eredmények feldolgozása...',
]

export const LOADING_STEPS = {
  opportunity: [
    'Téma értelmezése...',
    'Trendjelek keresése...',
    'YouTube bizonyítékok szűrése...',
    'Piaci score számítása...',
    'Javasolt szögek készítése...',
  ],
  videoPackage: [
    'Források ellenőrzése...',
    'Hook felépítése...',
    'Narráció generálása...',
    'Jelenetstruktúra készítése...',
    'Csomag mentése...',
  ],
  similarVideos: [
    'Téma értelmezése...',
    'YouTube keresés...',
    'Relevancia szűrés...',
    'Viral score számítás...',
  ],
  viralScore: [
    'YouTube adatok lekérése...',
    'Piaci jelek elemzése...',
    'Score számítás...',
  ],
  videoAudit: [
    'Videóadatok betöltése...',
    'Dimenziók elemzése...',
    'Döntés számítása...',
  ],
  scriptExtract: [
    'Videó betöltése...',
    'Transcript kinyerése...',
    'Struktúra elemzése...',
  ],
}

export default function LoadingScreen({ steps, currentStep, message }: LoadingScreenProps) {
  const activeSteps = steps || DEFAULT_STEPS
  const [visibleStep, setVisibleStep] = useState(0)

  useEffect(() => {
    if (currentStep !== undefined) {
      setVisibleStep(currentStep)
      return
    }
    const interval = setInterval(() => {
      setVisibleStep(prev => (prev + 1) % activeSteps.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [currentStep, activeSteps.length])

  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="relative mb-6">
        <svg viewBox="0 0 100 100" width="72" height="72" className="animate-pulse">
          <defs>
            <linearGradient id="lg-load" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="20" fill="#080B12" />
          <path
            d="M25 30 L37.5 70 L50 42 L62.5 70 L75 30"
            fill="none"
            stroke="url(#lg-load)"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="120"
            strokeDashoffset="0"
          >
            <animate attributeName="stroke-dashoffset" values="120;0;0;120" dur="2.5s" repeatCount="indefinite" />
          </path>
          <circle cx="75" cy="28" r="3" fill="#22D3EE" opacity="0.9">
            <animate attributeName="opacity" values="0;0.9;0.9;0" dur="2.5s" repeatCount="indefinite" />
          </circle>
        </svg>
      </div>

      <div className="space-y-2 mb-4 min-h-[100px]">
        {activeSteps.map((step, i) => {
          const isActive = i === visibleStep
          const isDone = i < visibleStep

          return (
            <div key={i} className="flex items-center gap-3 transition-all duration-300"
              style={{ opacity: isDone ? 0.4 : isActive ? 1 : 0.2 }}>
              <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: isDone ? 'rgba(34,197,94,0.15)' : isActive ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${isDone ? 'rgba(34,197,94,0.3)' : isActive ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.08)'}`,
                }}>
                {isDone ? (
                  <i className="ti ti-check" style={{ fontSize: '11px', color: '#22C55E' }} />
                ) : isActive ? (
                  <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: '#3B82F6' }} />
                ) : (
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.2)' }} />
                )}
              </div>
              <span className="text-sm" style={{ color: isDone ? '#22C55E' : isActive ? '#F8FAFC' : '#94A3B8' }}>
                {step}
              </span>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-center max-w-sm leading-relaxed" style={{ color: '#94A3B8' }}>
        {message || 'A prémium elemzés több forrást és több lépést ellenőriz. Ez általában 30-90 másodpercig tarthat.'}
      </p>
    </div>
  )
}