'use client'

import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import type { CreatorProfile } from '@/types'

interface HeaderProps {
  user: User
  profile: CreatorProfile | null
}

export default function DashboardHeader({ user, profile }: HeaderProps) {
  const initials = (profile?.channel_name || user.email || 'U').slice(0, 2).toUpperCase()
  const [credits, setCredits] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/credits').then(r => r.json()).then(d => setCredits(d.balance)).catch(() => {})
  }, [])

  return (
    <header className="flex items-center justify-between px-8 sticky top-0 z-10"
      style={{ height: 72, background: 'rgba(7,10,18,0.82)', backdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>

      <div className="flex items-center gap-2 text-sm text-text-muted">
        {/* breadcrumb placeholder */}
      </div>

      <div className="flex items-center gap-3">
        {/* Credit pill */}
        <div className="flex items-center gap-2 px-4 py-2 rounded-full text-sm"
          style={{ background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)', boxShadow: '0 0 16px rgba(59,130,246,0.08)' }}>
          <i className="ti ti-bolt text-sm" style={{ color: '#3B82F6' }} />
          <span className="font-semibold" style={{ color: '#3B82F6' }}>
            {credits !== null ? credits.toFixed(1) : '...'} kredit
          </span>
        </div>

        {/* Notification */}
        <button className="relative w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary transition-colors"
          style={{ background: '#0F1420', border: '1px solid rgba(255,255,255,0.08)' }}>
          <i className="ti ti-bell text-base" />
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full" style={{ background: '#3B82F6' }} />
        </button>

        {/* Avatar */}
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-surface-2 transition-colors">
          <div className="rounded-full flex items-center justify-center text-xs font-bold"
            style={{ width: 36, height: 36, background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)', color: '#fff' }}>
            {initials}
          </div>
          <span className="text-sm font-medium text-text-primary hidden sm:block">
            {profile?.channel_name || user.email?.split('@')[0]}
          </span>
          <i className="ti ti-chevron-down text-text-muted text-xs" />
        </div>
      </div>
    </header>
  )
}
