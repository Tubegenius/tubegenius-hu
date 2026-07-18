'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import PlatformIcon from '@/components/icons/PlatformIcon'
import StatusIcon from '@/components/icons/StatusIcon'
import Badge from '@/components/ui/Badge'
import { scoreColor } from '@/lib/score-utils'
import type { ChannelProfile } from './ChannelHeaderCard'

// A page.tsx (Next.js App Router route-fájl) nem exportálhat tetszőleges
// named exportot, ezért ugyanazon mezők helyi másolata szükséges itt —
// ugyanaz az alak, mint a app/dashboard/channel-audit/page.tsx belső
// típusaié, csak nem importálva (route-fájlból nem lehet).
interface DimensionAverages {
  hook_strength: number
  retention_potential: number
  engagement_quality: number
  platform_fit: number
  packaging_quality: number
}

interface AuditSummary {
  id: string
  video_title: string
  overall_score: number
  overall_label: string
  created_at: string
}

interface ChannelAuditData {
  has_enough_data: boolean
  audit_count: number
  min_required?: number
  relevant_audit_count?: number
  min_relevant_required?: number
  can_generate_suggestions?: boolean
  dimension_averages?: DimensionAverages
  weakest_dimension?: { key: string; label: string; value: number }
  top_strong?: AuditSummary[]
  top_weak?: AuditSummary[]
  workflow_completion_rhythm?: Array<{ month: string; count: number }>
  niche_review_required?: boolean
  active_channel_id?: string | null
  no_active_channel?: boolean
  legacy_unassigned_audit_count?: number
}

interface SuggestionsResult {
  suggestions: Array<{ topic: string; reasoning: string }>
  from_paid_result?: boolean
  cache_status?: 'fresh' | 'stale_saved'
  last_analyzed_at?: string
  paid_result_id?: string | null
}

const DIMENSION_LABELS: Record<keyof DimensionAverages, string> = {
  hook_strength: 'Hook erősség',
  retention_potential: 'Retenciós potenciál',
  engagement_quality: 'Engagement minőség',
  platform_fit: 'Platform illeszkedés',
  packaging_quality: 'Csomagolás minőség',
}

interface ChannelAuditHeroProps {
  channelProfile: ChannelProfile | null
  channelConnected: boolean | null
  data: ChannelAuditData | null
  suggestionsResult: SuggestionsResult | null
  generating: boolean
  loading: boolean
  connecting: boolean
  loadError: string | null
  error: string | null
  onConnectChannel: () => void
  onRequestSuggestions: () => void
  onRefreshSuggestions: () => void
}

type HeroKind =
  | 'loading'
  | 'load_error'
  | 'niche_review'
  | 'generating'
  | 'suggestion_error'
  | 'not_connected'
  | 'not_enough_data'
  | 'preflight_blocked'
  | 'ready_to_generate'
  | 'has_suggestions'
  | 'fallback'

interface HeroState {
  kind: HeroKind
  title: string
  reasoning?: string
}

// Egyetlen, rögzített prioritási sorrend — a legelső illeszkedő feltétel
// nyer. Minden szöveg kizárólag már meglévő state-ekből vezethető le, nincs
// új számított érték (pl. összesített audit-pontszám vagy confidence).
function deriveHeroState(props: ChannelAuditHeroProps): HeroState {
  const { loading, channelConnected, loadError, data, generating, error, suggestionsResult, channelProfile } = props

  if (loading || channelConnected === null) {
    return { kind: 'loading', title: '' }
  }
  if (loadError) {
    return { kind: 'load_error', title: 'Hiba történt az audit betöltésekor.' }
  }
  if (data?.niche_review_required) {
    return {
      kind: 'niche_review',
      title: 'Erősítsd meg a niche-t a folytatáshoz',
      reasoning: 'Amíg nincs döntés, nem indul új témagenerálás ehhez a csatornához.',
    }
  }
  if (generating) {
    return { kind: 'generating', title: 'Elemzés folyamatban...' }
  }
  if (error) {
    return { kind: 'suggestion_error', title: 'A javaslat generálása sikertelen.' }
  }
  if (channelConnected === false) {
    return channelProfile
      ? {
          kind: 'not_connected',
          title: 'Mélyebb elemzéshez kösd össze a fiókod',
          reasoning: 'Valós nézettség, watch time és feliratkozó-adatok jelennek meg a kézi audit-mintázat mellett.',
        }
      : {
          kind: 'not_connected',
          title: 'Kösd össze a csatornád a pontos audithoz',
          reasoning: 'Valós nézettség, watch time és feliratkozó-adatok jelennek meg a kézi audit-mintázat mellett.',
        }
  }
  if (data && !data.has_enough_data) {
    return {
      kind: 'not_enough_data',
      title: 'Még nem elég az adat egy megbízható audithoz',
      reasoning: `Jelenleg ${data.audit_count} Videódiagnózisod van, legalább ${data.min_required ?? '?'} szükséges a mintázat-elemzéshez.`,
    }
  }
  if (data?.has_enough_data && !suggestionsResult && !data.can_generate_suggestions) {
    const required = data.min_relevant_required ?? 3
    const relevant = data.relevant_audit_count ?? 0
    return {
      kind: 'preflight_blocked',
      title: `Még ${Math.max(0, required - relevant)} niche-releváns audit kell a javaslatokhoz`,
      reasoning: `Jelenleg ${relevant}/${required} releváns audit van — ez az ellenőrzés ingyenes.`,
    }
  }
  if (data?.has_enough_data && !suggestionsResult && data.can_generate_suggestions) {
    return {
      kind: 'ready_to_generate',
      title: 'Készen állsz a következő 10 videótéma lekérésére',
      reasoning: `${data.audit_count} audit mintázata alapján.`,
    }
  }
  if (suggestionsResult) {
    return {
      kind: 'has_suggestions',
      title: 'Megvan a következő 10 videótémád',
      reasoning: suggestionsResult.from_paid_result ? 'Mentett elemzésből nyitottuk meg, kredit nélkül.' : undefined,
    }
  }
  return { kind: 'fallback', title: 'Állapot ellenőrzése...' }
}

function renderCta(state: HeroState, props: ChannelAuditHeroProps): ReactNode {
  switch (state.kind) {
    case 'niche_review':
      return (
        <Link href="/dashboard/profile" className="btn-secondary text-sm px-4 py-2 inline-block">
          Niche megerősítése →
        </Link>
      )
    case 'generating':
      return (
        <button type="button" disabled className="btn-primary text-sm px-5 py-2 opacity-60 cursor-not-allowed">
          Feldolgozás...
        </button>
      )
    case 'not_connected':
      return (
        <button type="button" onClick={props.onConnectChannel} disabled={props.connecting} className="btn-primary text-sm px-5 py-2">
          {props.connecting ? 'Átirányítás...' : 'Csatorna összekapcsolása'}
        </button>
      )
    case 'not_enough_data':
    case 'preflight_blocked':
      return (
        <Link href="/dashboard/video-audit" className="btn-secondary text-sm px-4 py-2 inline-block">
          Audit folytatása →
        </Link>
      )
    case 'ready_to_generate':
      return (
        <button type="button" onClick={props.onRequestSuggestions} className="btn-primary text-sm px-5 py-2">
          Kérem a 10 videótémát
        </button>
      )
    case 'has_suggestions':
      return (
        <button type="button" onClick={props.onRefreshSuggestions} className="btn-secondary text-sm px-4 py-2">
          Javaslat frissítése
        </button>
      )
    default:
      return null
  }
}

function DimensionMiniBars({ averages, weakestKey }: { averages: DimensionAverages; weakestKey?: string }) {
  const entries = Object.keys(averages) as (keyof DimensionAverages)[]
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted uppercase tracking-wide">5 dimenziós auditprofil</p>
      {entries.map(key => {
        const rawValue = averages[key]
        // Kizárólag megjelenítési védelem — nem új számítás/üzleti logika,
        // csak a sáv és a kijelzett szám nem futhat ki a 0–100 tartományból.
        const displayValue = Math.max(0, Math.min(100, Number.isFinite(rawValue) ? rawValue : 0))
        const color = scoreColor(displayValue)
        const isWeakest = key === weakestKey
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="text-xs text-text-secondary w-28 truncate flex-shrink-0">{DIMENSION_LABELS[key]}</span>
            <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <div className="h-full rounded-full" style={{ width: `${displayValue}%`, background: color }} />
            </div>
            <span className="text-xs font-semibold w-7 text-right flex-shrink-0" style={{ color }}>{displayValue}</span>
            {isWeakest && (
              <span className="flex items-center gap-1 text-xs flex-shrink-0" style={{ color: '#F59E0B' }}>
                <StatusIcon kind="warning" className="w-3.5 h-3.5" /> figyelendő
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function ChannelAuditHero(props: ChannelAuditHeroProps) {
  const { channelProfile, channelConnected, data, suggestionsResult } = props
  const state = deriveHeroState(props)
  const isSkeleton = state.kind === 'loading'
  const cta = isSkeleton ? null : renderCta(state, props)

  return (
    <div className="card mb-6">
      <div className="flex items-center gap-2 mb-4 min-w-0">
        <PlatformIcon platform="youtube" className="w-5 h-5 flex-shrink-0" />
        <span className="section-label flex-shrink-0">Channel Audit</span>
        {channelProfile?.channel_name && (
          <span className="text-sm text-text-secondary truncate min-w-0">· {channelProfile.channel_name}</span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[65fr_35fr] gap-6">
        {/* Domináns oszlop — döntés + indoklás */}
        <div className="min-w-0">
          {isSkeleton ? (
            <div className="space-y-2 animate-pulse" role="status" aria-label="Channel Audit betöltése folyamatban">
              <div className="h-6 w-3/4 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />
              <div className="h-4 w-1/2 rounded" style={{ background: 'rgba(255,255,255,0.04)' }} aria-hidden="true" />
              <span className="sr-only">Channel Audit betöltése folyamatban</span>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold text-text-primary mb-1 break-words">{state.title}</h2>
              {state.reasoning && <p className="text-sm text-text-secondary break-words">{state.reasoning}</p>}
            </>
          )}
        </div>

        {/* Másodlagos oszlop — dimenzió-profil + badge-ek */}
        {!isSkeleton && (
          <div className="opacity-90">
            {data?.dimension_averages ? (
              <DimensionMiniBars averages={data.dimension_averages} weakestKey={data.weakest_dimension?.key} />
            ) : (
              <p className="text-xs text-text-muted">Még nincs elég adat a dimenzió-profilhoz.</p>
            )}

            <div className="flex flex-wrap gap-1.5 mt-3">
              {typeof data?.audit_count === 'number' && data.audit_count > 0 && (
                <Badge variant="neutral">{data.audit_count} audit alapján</Badge>
              )}
              {channelConnected && <Badge variant="success">Valós YouTube-adat</Badge>}
              {channelConnected === false && channelProfile && <Badge variant="info">Publikus adat</Badge>}
              {suggestionsResult && (
                <Badge variant={suggestionsResult.cache_status === 'fresh' ? 'success' : 'info'}>
                  {suggestionsResult.from_paid_result ? 'Mentett elemzés megnyitva' : 'Friss'}
                </Badge>
              )}
            </div>

            {suggestionsResult?.last_analyzed_at && (
              <p className="text-xs text-text-muted mt-2">
                Utolsó elemzés: {new Date(suggestionsResult.last_analyzed_at).toLocaleDateString('hu-HU')}
              </p>
            )}
          </div>
        )}
      </div>

      {cta && <div className="mt-4">{cta}</div>}
    </div>
  )
}
