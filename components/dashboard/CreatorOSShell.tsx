'use client'

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BarChart3,
  BookOpen,
  ChevronDown,
  Compass,
  CreditCard,
  LogOut,
  Settings,
  Sparkles,
  Sun,
  UserRound,
  X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase'
import type { CreatorProfile } from '@/types'
import Logo from '@/components/brand/Logo'
import { CREATOR_OS_NAV_ITEMS, creatorOSSectionForPath, type CreatorOSSectionId } from '@/lib/creator-os-navigation'
import { CREATOR_LANE_PRESENTATION, type CreatorLane } from '@/lib/creator-lane-presentation'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'

interface CreatorOSShellProps {
  children: ReactNode
  profile: CreatorProfile | null
  userEmail?: string | null
  activeSectionOverride?: CreatorOSSectionId
  creatorLane?: CreatorLane
}

const navIcons = {
  today: Sun,
  discover: Compass,
  create: Sparkles,
  library: BookOpen,
  growth: BarChart3,
} satisfies Record<CreatorOSSectionId, typeof Sun>

export default function CreatorOSShell({ children, profile, userEmail, activeSectionOverride, creatorLane: creatorLaneOverride }: CreatorOSShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { creatorLane: contextLane } = useCreatorOS()
  const creatorLane = creatorLaneOverride ?? contextLane
  const menuRef = useRef<HTMLDivElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const activeSection = activeSectionOverride ?? creatorOSSectionForPath(pathname)
  const channelName = profile?.channel_name || userEmail?.split('@')[0] || 'Saját csatorna'
  const initials = channelName.slice(0, 2).toUpperCase()
  const laneLabel = CREATOR_LANE_PRESENTATION[creatorLane].label

  useEffect(() => setMenuOpen(false), [pathname])

  useEffect(() => {
    if (!menuOpen) return

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        accountTriggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  function focusMenuEdge(edge: 'first' | 'last') {
    window.requestAnimationFrame(() => {
      const items = accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
      if (!items?.length) return
      items[edge === 'first' ? 0 : items.length - 1].focus()
    })
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (!items.length) return
    event.preventDefault()
    const currentIndex = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Home') return items[0].focus()
    if (event.key === 'End') return items[items.length - 1].focus()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex = currentIndex < 0
      ? (direction === 1 ? 0 : items.length - 1)
      : (currentIndex + direction + items.length) % items.length
    items[nextIndex].focus()
  }

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  return (
    <div className="wv-shell" data-creator-lane={creatorLane}>
      <a href="#willviral-main" className="wv-skip-link">Ugrás a tartalomhoz</a>

      <header className="wv-topbar">
        <Link href="/dashboard" className="wv-brand-link" aria-label="WillViral – Ma">
          <Logo variant="full" size="md" />
        </Link>

        <nav className="wv-primary-nav" aria-label="Elsődleges navigáció">
          {CREATOR_OS_NAV_ITEMS.map(item => {
            const active = item.id === activeSection
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`wv-primary-link${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="wv-channel-cluster" ref={menuRef}>
          <div className="wv-channel-context" aria-label={`${channelName}, ${laneLabel.toLocaleLowerCase('hu-HU')} minta Creator Lane`}>
            <span className="wv-lane-mark" aria-hidden="true" />
            <span className="wv-channel-copy">
              <strong>{channelName}</strong>
              <small>{laneLabel} · mintanézet</small>
            </span>
          </div>
          <button
            ref={accountTriggerRef}
            type="button"
            className="wv-account-trigger"
            aria-label="Fiókmenü megnyitása"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-controls="wv-account-menu"
            onClick={() => setMenuOpen(open => !open)}
            onKeyDown={event => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              setMenuOpen(true)
              focusMenuEdge(event.key === 'ArrowDown' ? 'first' : 'last')
            }}
          >
            <span>{initials}</span>
            {menuOpen ? <X aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>

          {menuOpen && (
            <div ref={accountMenuRef} id="wv-account-menu" className="wv-account-menu" role="menu" aria-label="Fiókműveletek" onKeyDown={handleMenuKeyDown}>
              <div className="wv-account-summary">
                <strong>{channelName}</strong>
                <span>{userEmail}</span>
              </div>
              <Link href="/dashboard/profile" role="menuitem"><UserRound aria-hidden="true" />Profil és csatorna</Link>
              <Link href="/dashboard/credits" role="menuitem"><CreditCard aria-hidden="true" />Kreditek és számlázás</Link>
              <Link href="/dashboard/profile" role="menuitem"><Settings aria-hidden="true" />Beállítások</Link>
              <button type="button" role="menuitem" onClick={handleLogout}><LogOut aria-hidden="true" />Kijelentkezés</button>
            </div>
          )}
        </div>

        <div className="wv-mobile-context-bar" aria-label={`${channelName}, ${laneLabel.toLocaleLowerCase('hu-HU')} mintanézet`}>
          <span className="wv-lane-mark" aria-hidden="true" />
          <strong>{channelName}</strong>
          <span>{laneLabel} · minta</span>
        </div>
      </header>

      <main id="willviral-main" className="wv-main" tabIndex={-1}>
        {children}
      </main>

      <nav className="wv-bottom-nav" aria-label="Mobil navigáció">
        {CREATOR_OS_NAV_ITEMS.map(item => {
          const active = item.id === activeSection
          const Icon = navIcons[item.id]
          return (
            <Link
              key={item.id}
              href={item.href}
              className={`wv-bottom-link${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
