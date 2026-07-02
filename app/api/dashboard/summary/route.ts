import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard/summary
// Creator Intelligence Dashboard — kizárólag a user saját, meglévő adataiból
// számolt összegzés. Nincs mock adat, nincs új AI-hívás, nincs élő web/YouTube
// lekérdezés. A YouTube snapshot adatok is csak passzívan, korábban gyűjtött
// sorokból olvasódnak ki.
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const userId = user.id

  const [
    creditsRes,
    memoryRes,
    packagesRes,
    auditsRes,
    usageLogsRes,
    videosSeenRes,
    snapshotsCountRes,
    trackedRes,
  ] = await Promise.all([
    admin.from('user_credits').select('balance, total_used, plan').eq('user_id', userId).single(),
    admin.from('creator_memory').select('id, topic, state, platform, opportunity_score, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }),
    admin.from('video_packages').select('id, topic, platform, video_length, quality_status, strict_fact_mode, fact_strictness_level, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('video_audits').select('id, video_title, topic, platform, overall_score, decision, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('ai_usage_logs').select('feature_name, credits_charged, metadata, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    admin.from('youtube_videos').select('*', { count: 'exact', head: true }),
    admin.from('youtube_video_snapshots').select('*', { count: 'exact', head: true }),
    admin.from('tracked_trend_candidates').select('id, candidate_topic').eq('user_id', userId).eq('status', 'active'),
  ])

  const memory = memoryRes.data || []
  const packages = packagesRes.data || []
  const audits = auditsRes.data || []
  const usageLogs = usageLogsRes.data || []
  const tracked = trackedRes.data || []

  const hasAnyActivity = memory.length > 0 || packages.length > 0 || audits.length > 0 || usageLogs.length > 0

  // ── Trend alakulás — a témák egy részéhez tartozik tracked_trend_candidate ──
  // (lásd lib/trend-tracking.ts). Ha van hozzá legutóbbi snapshot, azt a
  // trend_status-t (rising/stable/declining) mutatjuk a témák mellett.
  const trackedTrendByTopic = new Map<string, { trend_status: string | null; views_delta: number | null }>()
  if (tracked.length > 0) {
    const { data: snapshots } = await admin
      .from('trend_candidate_snapshots')
      .select('tracked_candidate_id, trend_status, views_delta, checked_at')
      .in('tracked_candidate_id', tracked.map(t => t.id))
      .order('checked_at', { ascending: false })
    const latestByCandidate = new Map<string, { trend_status: string | null; views_delta: number | null }>()
    for (const s of snapshots || []) {
      if (!latestByCandidate.has(s.tracked_candidate_id)) {
        latestByCandidate.set(s.tracked_candidate_id, { trend_status: s.trend_status, views_delta: s.views_delta })
      }
    }
    for (const t of tracked) {
      const latest = latestByCandidate.get(t.id)
      if (latest) trackedTrendByTopic.set(t.candidate_topic.toLowerCase().trim(), latest)
    }
  }

  function findTrend(topic: string | null | undefined): { trend_status: string | null; views_delta: number | null } | null {
    if (!topic) return null
    const key = topic.toLowerCase().trim()
    if (trackedTrendByTopic.has(key)) return trackedTrendByTopic.get(key)!
    // Laza egyezés — a mentett topic gyakran hosszabb/rövidebb, mint a tracked candidate_topic
    for (const [candidateTopic, trend] of trackedTrendByTopic.entries()) {
      if (candidateTopic.length > 4 && (key.includes(candidateTopic) || candidateTopic.includes(key))) return trend
    }
    return null
  }

  // ── 1. Videócsomagok ──
  const packagesSummary = {
    total: packages.length,
    shorts: packages.filter(p => p.video_length === 'short').length,
    long: packages.filter(p => p.video_length === 'long' || p.video_length === 'medium').length,
  }

  // ── 2. Auditok ──
  const auditScores = audits.map(a => a.overall_score).filter((s): s is number => s != null)
  const auditsSummary = {
    total: audits.length,
    avg_score: auditScores.length > 0 ? Math.round(auditScores.reduce((s, v) => s + v, 0) / auditScores.length) : null,
  }

  // ── 3. Kreditek ──
  const creditsSummary = {
    balance: creditsRes.data?.balance ?? 0,
    used_total: creditsRes.data?.total_used ?? 0,
  }

  // ── 4. Creator Memory ──
  const memorySummary = {
    saved: memory.filter(m => m.state === 'saved').length,
    in_progress: memory.filter(m => m.state === 'in_progress').length,
    completed: memory.filter(m => m.state === 'completed').length,
    rejected: memory.filter(m => m.state === 'rejected').length,
  }

  // ── 6. Fact Safety összegzés ──
  const factSafety = {
    verified: packages.filter(p => p.quality_status === 'verified').length,
    verified_with_limits: packages.filter(p => p.quality_status === 'verified_with_limits').length,
    insufficient_sources: packages.filter(p => p.quality_status === 'insufficient_sources').length,
    standard_news: packages.filter(p => p.fact_strictness_level === 'standard_news').length,
    high_risk: packages.filter(p => p.fact_strictness_level === 'high_risk').length,
  }

  // ── Legutóbbi elemzéseid — max 10, összefésülve, dátum szerint ──
  // Csak valódi TERMÉK-kimenetek jelennek meg (videócsomag, audit, mentett
  // téma, Opportunity Engine, Similar Videos, Script Extractor, Viral Score).
  // A puszta kredit-tranzakció naplósorokat (amik már egy fenti termék-sorral
  // duplikálnának, pl. video_package/video_audit) kiszűrjük.
  type ActivityItem = {
    type: 'video_package' | 'video_audit' | 'memory' | 'opportunity' | 'similar_videos' | 'script_extract' | 'viral_score'
    title: string
    topic: string
    date: string
    status: string | null
    score: number | null
    href: string
    trend_status: string | null
    views_delta: number | null
  }

  // feature_name → { type, label, href } — csak azok a funkciók, amiknek NINCS
  // már dedikált tábla-alapú sora fent (video_package_shorts/long, video_audit
  // már megvan a packages/audits táblákból).
  const FEATURE_MAP: Record<string, { type: ActivityItem['type']; label: string; href: string }> = {
    opportunity_engine: { type: 'opportunity', label: 'Opportunity Engine keresés', href: '/dashboard/opportunities' },
    opportunity_explain: { type: 'opportunity', label: 'Opportunity Engine keresés', href: '/dashboard/opportunities' },
    trend_feed_refresh: { type: 'opportunity', label: 'Trend Feed frissítés', href: '/dashboard' },
    similar_videos: { type: 'similar_videos', label: 'Similar Videos keresés', href: '/dashboard/similar-videos' },
    script_extract: { type: 'script_extract', label: 'Script kinyerve', href: '/dashboard/script-extractor' },
    source_video_extract: { type: 'script_extract', label: 'Script kinyerve', href: '/dashboard/script-extractor' },
    viral_score: { type: 'viral_score', label: 'Viral Score elemzés', href: '/dashboard/viral-score' },
  }

  const activity: ActivityItem[] = [
    ...packages.map(p => {
      const trend = findTrend(p.topic)
      return {
        type: 'video_package' as const,
        title: `Videócsomag készült: ${p.topic || 'Cím nélkül'}`,
        topic: p.topic || 'Cím nélkül',
        date: p.created_at,
        status: p.quality_status,
        score: null,
        href: '/dashboard/video-package',
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
      }
    }),
    ...audits.map(a => {
      const trend = findTrend(a.video_title || a.topic)
      return {
        type: 'video_audit' as const,
        title: `Audit lefuttatva: ${a.video_title || a.topic || 'Cím nélkül'}`,
        topic: a.video_title || a.topic || 'Cím nélkül',
        date: a.created_at,
        status: a.decision || (a.overall_score != null ? `${a.overall_score} pont` : null),
        score: a.overall_score ?? null,
        href: '/dashboard/video-audit',
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
      }
    }),
    ...memory.map(m => {
      const trend = findTrend(m.topic)
      return {
        type: 'memory' as const,
        title: `Téma ${m.state === 'saved' ? 'mentve' : m.state === 'completed' ? 'lezárva' : m.state === 'rejected' ? 'elutasítva' : 'folyamatban'}: ${m.topic}`,
        topic: m.topic,
        date: m.updated_at,
        status: m.state,
        score: m.opportunity_score ?? null,
        href: '/dashboard/memory',
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
      }
    }),
    ...usageLogs
      .filter(l => (l.credits_charged || 0) > 0 && FEATURE_MAP[l.feature_name])
      .map(l => {
        const meta = FEATURE_MAP[l.feature_name]
        return {
          type: meta.type,
          title: meta.label,
          topic: meta.label,
          date: l.created_at,
          status: `${l.credits_charged} kredit`,
          score: null,
          href: meta.href,
          trend_status: null,
          views_delta: null,
        }
      }),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)

  // ── Tartalomirány insight — egyszerű szabályalapú logika ──
  let contentDirectionInsight = 'Kezdj egy trendtéma kereséssel vagy videóaudit futtatással.'
  if (hasAnyActivity) {
    const savedCount = memorySummary.saved
    const completedCount = memorySummary.completed
    const rejectedCount = memorySummary.rejected
    const insufficientCount = factSafety.insufficient_sources

    if (insufficientCount >= 2) {
      contentDirectionInsight = 'Több témánál kevés volt az ellenőrzött forrás. Factual témáknál adj meg konkrétabb forrást vagy válassz validált trendet.'
    } else if (rejectedCount >= 3 && rejectedCount > completedCount) {
      contentDirectionInsight = 'Sok témát elutasítottál. A következő kereséseknél szűkebb niche vagy konkrétabb input segíthet.'
    } else if (savedCount >= 3 && completedCount === 0) {
      contentDirectionInsight = 'Sok ötletet mentettél, de kevésből készült csomag. Érdemes 1 témát végigvinni videócsomagig.'
    } else if (!hasAnyActivity) {
      contentDirectionInsight = 'Kezdj egy trendtéma kereséssel vagy videóaudit futtatással.'
    } else {
      contentDirectionInsight = 'Jó ütemben haladsz — folytasd a témák végigvitelét videócsomagig vagy auditig.'
    }
  }

  // ── YouTube jelek — passzívan gyűjtött snapshot adatvagyon (globális, nem user-specifikus) ──
  const youtubeSignals = {
    videos_seen: videosSeenRes.count ?? 0,
    snapshots_count: snapshotsCountRes.count ?? 0,
    top_viral_score: null as number | null,
    fresh_ratio: null as number | null,
  }

  return NextResponse.json({
    has_data: hasAnyActivity,
    packages: packagesSummary,
    audits: auditsSummary,
    credits: creditsSummary,
    memory: memorySummary,
    fact_safety: factSafety,
    recent_activity: activity,
    content_direction_insight: contentDirectionInsight,
    youtube_signals: youtubeSignals,
  })
}
