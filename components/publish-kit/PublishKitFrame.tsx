'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Image, PenLine, Send, Sparkles } from 'lucide-react'
import { useCreatorOS } from '@/components/dashboard/CreatorOSContext'
import { buildPublishKitHref } from '@/lib/publish-kit-presentation'

export type PublishKitStage = 'title' | 'thumbnail' | 'seo'

const STAGES = [
  { id: 'title' as const, number: '01', label: 'Címirány', note: 'Ígéret és kíváncsiság', href: '/dashboard/title-studio', icon: PenLine },
  { id: 'thumbnail' as const, number: '02', label: 'Vizuális ígéret', note: 'Koncepció és fókusz', href: '/dashboard/thumbnail-studio', icon: Image },
  { id: 'seo' as const, number: '03', label: 'Feltöltési csomag', note: 'Metaadat és publikálás', href: '/dashboard/seo-optimizer', icon: Send },
]

interface PublishKitFrameProps {
  active: PublishKitStage
  title: string
  description: string
  topic: string
  existingTitle?: string
  children: ReactNode
}

export default function PublishKitFrame({ active, title, description, topic, existingTitle, children }: PublishKitFrameProps) {
  const { creatorLane } = useCreatorOS()
  const activeIndex = STAGES.findIndex(stage => stage.id === active)

  return (
    <div className="wv-publish-page" data-creator-lane={creatorLane}>
      <header className="wv-publish-intro">
        <span className="wv-eyebrow"><Sparkles aria-hidden="true" />Creator Studio · Publish Kit</span>
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>

      <nav className="wv-publish-journey" aria-label="Publish Kit munkafolyamat">
        {STAGES.map((stage, index) => {
          const Icon = stage.icon
          const isActive = stage.id === active
          const isPast = index < activeIndex
          return (
            <Link
              key={stage.id}
              href={buildPublishKitHref(stage.href, { topic, existingTitle })}
              className={`${isActive ? 'is-active' : ''}${isPast ? ' is-past' : ''}`}
              aria-current={isActive ? 'step' : undefined}
            >
              <span>{stage.number}</span>
              <Icon aria-hidden="true" />
              <span><strong>{stage.label}</strong><small>{stage.note}</small></span>
              {isPast ? <i aria-hidden="true">✓</i> : <ArrowRight aria-hidden="true" />}
            </Link>
          )
        })}
      </nav>

      {children}
    </div>
  )
}
