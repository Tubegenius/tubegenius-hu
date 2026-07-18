import Link from 'next/link'
import { CheckCircle2, FlaskConical, Search, AlertTriangle, type LucideIcon } from 'lucide-react'
import type { ViralScoreResult } from '@/types'
import ScoreRing from '@/components/ui/ScoreRing'
import Badge from '@/components/ui/Badge'
import FeatureIcon from '@/components/icons/FeatureIcon'

// A page.tsx (Next.js App Router route-fájl) nem exportálhat tetszőleges
// named exportot, ezért ezek a statikus szöveg/szín-map-ok ide kerültek —
// ugyanaz a tartalom (szöveg, szín, küszöb), mint korábban a page.tsx-ben
// volt, csak egy helyre összevonva (a page.tsx-ből a régi Score/Creator
// döntés kártyával együtt törölve, nincs két aktív példány).
const VERDICT_CONFIG: Record<ViralScoreResult['verdict'], { label: string; badgeClass: string; ringColor: string }> = {
  strong: { label: 'Erős téma', badgeClass: 'bg-emerald/10 text-emerald border-emerald/20', ringColor: '#10B981' },
  moderate: { label: 'Közepes lehetőség', badgeClass: 'bg-amber/10 text-amber border-amber/20', ringColor: '#F59E0B' },
  weak: { label: 'Gyenge piaci igény', badgeClass: 'bg-rose/10 text-rose border-rose/20', ringColor: '#F43F5E' },
  avoid: { label: 'Nem ajánlott', badgeClass: 'bg-rose/10 text-rose border-rose/20', ringColor: '#F43F5E' },
}

const CONFIDENCE_LABEL: Record<ViralScoreResult['confidence'], string> = {
  magas: 'Magas megbízhatóság (30+ videó)',
  közepes: 'Közepes megbízhatóság (10–29 videó)',
  alacsony: 'Alacsony megbízhatóság (5–9 videó)',
  nagyon_alacsony: 'Nagyon alacsony megbízhatóság (1–4 videó)',
}

type DecisionStatus = NonNullable<ViralScoreResult['decision_status']>

const DECISION_ICON: Record<DecisionStatus, { icon: LucideIcon; color: string }> = {
  make_now: { icon: CheckCircle2, color: '#22C55E' },
  test_angle: { icon: FlaskConical, color: '#F59E0B' },
  research: { icon: Search, color: '#60A5FA' },
  avoid: { icon: AlertTriangle, color: '#F43F5E' },
}

const DECISION_FALLBACK_TEXT: Record<DecisionStatus, { label: string; reason: string; action: string }> = {
  make_now: { label: 'Gyártható téma', reason: 'A témában elég erős jel látszik ahhoz, hogy gyártási döntést hozz.', action: 'Készíts videócsomagot, majd válassz erős hookot.' },
  test_angle: { label: 'Tesztelhető szög', reason: 'Van piaci jel, de érdemes szűkebb angle-t keresni.', action: 'Nézz Piaci bizonyíték példákat és csomagold konkrétabb ígéretre.' },
  research: { label: 'Kutatás kell', reason: 'A jel még gyenge vagy bizonytalan.', action: 'Szűkítsd a keresést, majd validáld Piaci bizonyíték vagy webes forrás alapján.' },
  avoid: { label: 'Most nem ajánlott', reason: 'Nincs elég erős adat ahhoz, hogy erre építs.', action: 'Próbálj más megfogalmazást vagy tágabb témát.' },
}

// A szerver score/verdict/decision_status/confidence értéke a megjelenített
// termékadat — itt kizárólag megjelenítési védelemként korlátozzuk 0–100
// közé a Ring kitöltését, a result objektumot nem módosítjuk.
function clampDisplayScore(score: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0))
}

// A CTA-leképezés kizárólag a ténylegesen létező decision_status
// union-értékekre épül. Ismeretlen, hiányzó vagy jövőben bővülő érték
// esetén nincs CTA — nincs alapértelmezett route. Ugyanazokat a href-eket
// és topic-kódolást használja, mint az oldal alsó akciógombjai.
function getPrimaryCta(result: ViralScoreResult): { label: string; href: string } | null {
  switch (result.decision_status) {
    case 'make_now':
      return { label: 'Videócsomag készítése →', href: `/dashboard/video-package?topic=${encodeURIComponent(result.topic)}` }
    case 'test_angle':
    case 'research':
      return { label: 'Piaci bizonyítékok megnézése →', href: `/dashboard/similar-videos?topic=${encodeURIComponent(result.topic)}` }
    case 'avoid':
      return null
    default:
      return null
  }
}

interface ViralScoreHeroProps {
  result: ViralScoreResult
}

// Tisztán prezentációs, kizárólag props-alapú komponens — nincs fetch,
// nincs API-hívás, nincs state/useEffect, nincs storage- vagy
// kreditlogika. A cache-banner és a "frissítés" gomb a page.tsx-ben marad.
export default function ViralScoreHero({ result }: ViralScoreHeroProps) {
  const verdict = VERDICT_CONFIG[result.verdict]
  const displayScore = clampDisplayScore(result.score)
  const cta = getPrimaryCta(result)

  const status = result.decision_status
  const decisionVisual = status ? DECISION_ICON[status] : null
  const decisionFallback = status ? DECISION_FALLBACK_TEXT[status] : null
  const DecisionIcon = decisionVisual?.icon

  const decisionLabel = result.decision_label || decisionFallback?.label || 'Elemzés kész'
  const decisionReason = result.decision_reason || decisionFallback?.reason
  const decisionAction = result.next_action || decisionFallback?.action

  return (
    <div className="card mb-4">
      <div className="grid grid-cols-1 md:grid-cols-[65fr_35fr] gap-6">
        {/* Domináns oszlop — döntés + indoklás */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-3 min-w-0">
            <FeatureIcon feature="viral-score" className="w-5 h-5 flex-shrink-0" />
            <span className="section-label flex-shrink-0">Virális esély</span>
            <span className="text-sm text-text-secondary truncate min-w-0">· {result.topic}</span>
          </div>

          <div className="flex items-start gap-3">
            {DecisionIcon && (
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }}>
                <DecisionIcon className="w-5 h-5" style={{ color: decisionVisual!.color }} strokeWidth={2} aria-hidden="true" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-bold text-text-primary mb-1 break-words">{decisionLabel}</h2>
              {decisionReason && <p className="text-sm text-text-secondary break-words">{decisionReason}</p>}
              {decisionAction && <p className="text-sm mt-2 font-medium text-text-primary break-words">{decisionAction}</p>}

              {result.risk_flags && result.risk_flags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {result.risk_flags.map(flag => (
                    <Badge key={flag} variant="warning" className="break-words">{flag}</Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Másodlagos oszlop — score, verdict, confidence */}
        <div className="flex flex-col items-center text-center opacity-95">
          <ScoreRing score={displayScore} size={144} color={verdict.ringColor} />
          <span className="text-xs text-text-muted -mt-2">/ 100</span>

          <span className={`inline-block mt-2 px-3 py-1 rounded-full text-sm font-medium border ${verdict.badgeClass}`}>
            {verdict.label}
          </span>

          {result.recommendation && (
            <p className="text-text-secondary text-sm mt-3 max-w-sm leading-relaxed break-words">
              {result.recommendation}
            </p>
          )}

          <p className="text-text-muted text-xs mt-3">{CONFIDENCE_LABEL[result.confidence]}</p>
          <div className="mt-2">
            <Badge variant="neutral">{result.video_count} videó alapján</Badge>
          </div>
        </div>
      </div>

      {/* CTA mindig a grid alatt, külön sorban — mobilon a score/confidence
          oszlop DOM-sorrendben megelőzi, sosem kerül elé. */}
      {cta && (
        <div className="mt-4">
          <Link href={cta.href} className="btn-primary text-sm px-5 py-2 inline-block">
            {cta.label}
          </Link>
        </div>
      )}
    </div>
  )
}
