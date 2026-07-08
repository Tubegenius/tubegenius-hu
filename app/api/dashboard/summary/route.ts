import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'
import { polishStatusLabel } from '@/lib/hungarian-output-polish'

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
    paidResultsRes,
    videoIdeasRes,
  ] = await Promise.all([
    admin.from('user_credits').select('balance, total_used, plan').eq('user_id', userId).single(),
    admin.from('creator_memory').select('id, topic, state, platform, opportunity_score, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }),
    admin.from('video_packages').select('id, topic, platform, video_length, quality_status, strict_fact_mode, fact_strictness_level, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('video_audits').select('id, video_title, topic, platform, overall_score, decision, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('ai_usage_logs').select('feature_name, credits_charged, metadata, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    admin.from('youtube_videos').select('*', { count: 'exact', head: true }),
    admin.from('youtube_video_snapshots').select('*', { count: 'exact', head: true }),
    admin.from('tracked_trend_candidates').select('id, candidate_topic').eq('user_id', userId).eq('status', 'active'),
    admin.from('paid_results').select('id, tool_type, original_input, created_at, last_opened_at, credit_cost, status').eq('user_id', userId).eq('status', 'completed').order('last_opened_at', { ascending: false, nullsFirst: false }).limit(30),
    admin.from('video_ideas').select('id, title, topic, platform, language, market, content_format, viral_score, opportunity_score, competition_score, proof_summary, video_package_id, calendar_status, publish_status, workflow_status, updated_at, created_at').eq('user_id', userId).order('updated_at', { ascending: false }).limit(25),
  ])

  const memory = memoryRes.data || []
  const packages = packagesRes.data || []
  const audits = auditsRes.data || []
  const usageLogs = usageLogsRes.data || []
  const tracked = trackedRes.data || []
  const paidResults = paidResultsRes.data || []
  const videoIdeas = videoIdeasRes.data || []

  // Proof signal aggregáció a command centerhez — a cél, hogy a rangsorolás
  // ne csak a score mezőket, hanem a ténylegesen mögé gyűjtött bizonyítékok
  // mennyiségét/erősségét is figyelembe vegye (lásd Similar Videos / Viral
  // Score proof signal bekötés).
  const videoIdeaIds = videoIdeas.map((idea: { id: string }) => idea.id)
  const proofSignalsRes = videoIdeaIds.length > 0
    ? await admin.from('video_idea_proof_signals').select('video_idea_id, strength').in('video_idea_id', videoIdeaIds)
    : { data: [] as Array<{ video_idea_id: string; strength: string | null }> }
  const proofSignalMap = new Map<string, { total: number; strong: number; medium: number; weak: number }>()
  for (const signal of proofSignalsRes.data || []) {
    const entry = proofSignalMap.get(signal.video_idea_id) || { total: 0, strong: 0, medium: 0, weak: 0 }
    entry.total += 1
    if (signal.strength === 'strong') entry.strong += 1
    else if (signal.strength === 'medium') entry.medium += 1
    else if (signal.strength === 'weak') entry.weak += 1
    proofSignalMap.set(signal.video_idea_id, entry)
  }

  function normalizeActivityKey(value: string | null | undefined): string {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  const paidActivityKeys = new Set(
    paidResults.map(p => `${p.tool_type}:${normalizeActivityKey(p.original_input)}`)
  )
  const hasPaidResultForTopic = (toolTypes: string[], value: string | null | undefined): boolean => {
    const key = normalizeActivityKey(value)
    if (!key) return false
    return paidResults.some(p => toolTypes.includes(p.tool_type) && normalizeActivityKey(p.original_input) === key)
  }
  const hasNearbyPaidResult = (toolType: string, date: string | null | undefined): boolean => {
    if (!date) return false
    const t = new Date(date).getTime()
    if (!Number.isFinite(t)) return false
    return paidResults.some(p => {
      if (p.tool_type !== toolType) return false
      const paidTime = new Date(p.last_opened_at || p.created_at).getTime()
      return Number.isFinite(paidTime) && Math.abs(paidTime - t) <= 10 * 60 * 1000
    })
  }
  const hasAnyActivity = memory.length > 0 || packages.length > 0 || audits.length > 0 || usageLogs.length > 0 || paidResults.length > 0 || videoIdeas.length > 0

  // ── Trend alakulás — a témák egy részéhez tartozik tracked_trend_candidate ──
  // (lásd lib/trend-tracking.ts). Ha van hozzá legutóbbi snapshot, azt a
  // trend_status-t (rising/stable/declining) mutatjuk a témák mellett.
  type TrendInfo = { trend_status: string | null; views_delta: number | null; view_history: number[] }
  const trackedTrendByTopic = new Map<string, TrendInfo>()
  if (tracked.length > 0) {
    const { data: snapshots } = await admin
      .from('trend_candidate_snapshots')
      .select('tracked_candidate_id, trend_status, views_delta, total_views, checked_at')
      .in('tracked_candidate_id', tracked.map(t => t.id))
      .order('checked_at', { ascending: false })
      .limit(500)
    const byCandidate = new Map<string, typeof snapshots>()
    for (const s of snapshots || []) {
      const arr = byCandidate.get(s.tracked_candidate_id) || []
      if (arr.length < 10) arr.push(s)
      byCandidate.set(s.tracked_candidate_id, arr)
    }
    for (const t of tracked) {
      const snaps = byCandidate.get(t.id) || []
      if (snaps.length === 0) continue
      trackedTrendByTopic.set(t.candidate_topic.toLowerCase().trim(), {
        trend_status: snaps[0].trend_status,
        views_delta: snaps[0].views_delta,
        view_history: [...snaps].reverse().map(s => s.total_views ?? 0),
      })
    }
  }

  function findTrend(topic: string | null | undefined): TrendInfo | null {
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
    shorts: packages.filter(p => ['short', '30sec', '45sec', '60sec'].includes(String(p.video_length))).length,
    long: packages.filter(p => ['long', 'medium', '3-5min', '6-10min'].includes(String(p.video_length))).length,
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
    type: 'video_package' | 'video_audit' | 'memory' | 'opportunity' | 'similar_videos' | 'script_extract' | 'transcript_extract' | 'viral_score'
    title: string
    topic: string
    date: string
    status: string | null
    score: number | null
    href: string
    trend_status: string | null
    views_delta: number | null
    view_history: number[]
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
    transcript_extract: { type: 'transcript_extract', label: 'Transcript kinyerve', href: '/dashboard/transcript' },
    source_video_extract: { type: 'script_extract', label: 'Script kinyerve', href: '/dashboard/script-extractor' },
    viral_score: { type: 'viral_score', label: 'Viral Score elemzés', href: '/dashboard/viral-score' },
  }

  const activity: ActivityItem[] = [
    ...packages.filter(p => !hasPaidResultForTopic(['video_package'], p.topic)).map(p => {
      const trend = findTrend(p.topic)
      return {
        type: 'video_package' as const,
        title: `Videócsomag készült: ${p.topic || 'Cím nélkül'}`,
        topic: p.topic || 'Cím nélkül',
        date: p.created_at,
        status: polishStatusLabel(p.quality_status),
        score: null,
        href: `/dashboard/video-package?id=${p.id}`,
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
        view_history: trend?.view_history ?? [],
      }
    }),
    ...audits.filter(a => !hasPaidResultForTopic(['video_audit'], a.video_title || a.topic)).map(a => {
      const trend = findTrend(a.video_title || a.topic)
      return {
        type: 'video_audit' as const,
        title: `Audit lefuttatva: ${a.video_title || a.topic || 'Cím nélkül'}`,
        topic: a.video_title || a.topic || 'Cím nélkül',
        date: a.created_at,
        status: a.decision || (a.overall_score != null ? `${a.overall_score} pont` : null),
        score: a.overall_score ?? null,
        href: `/dashboard/video-audit?id=${a.id}`,
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
        view_history: trend?.view_history ?? [],
      }
    }),
    ...memory.filter(m => !hasPaidResultForTopic(['video_package', 'video_audit'], m.topic)).map(m => {
      const trend = findTrend(m.topic)
      return {
        type: 'memory' as const,
        title: `Téma ${m.state === 'saved' ? 'mentve' : m.state === 'completed' ? 'lezárva' : m.state === 'rejected' ? 'elutasítva' : 'folyamatban'}: ${m.topic}`,
        topic: m.topic,
        date: m.updated_at,
        status: polishStatusLabel(m.state),
        score: m.opportunity_score ?? null,
        href: '/dashboard/memory',
        trend_status: trend?.trend_status ?? null,
        views_delta: trend?.views_delta ?? null,
        view_history: trend?.view_history ?? [],
      }
    }),
    ...paidResults.map(p => {
      const toolHref: Record<string, string> = {
        viral_score: '/dashboard/viral-score',
        similar_videos: '/dashboard/similar-videos',
        opportunity_engine: '/dashboard/opportunities',
        video_audit: '/dashboard/video-audit',
        video_package: '/dashboard/video-package',
        content_gap: '/dashboard',
        script_extract: '/dashboard/script-extractor',
        transcript_extract: '/dashboard/transcript',
        analyzer: '/dashboard',
      }
      const toolTypeMap: Record<string, ActivityItem['type']> = {
        viral_score: 'viral_score',
        similar_videos: 'similar_videos',
        opportunity_engine: 'opportunity',
        video_audit: 'video_audit',
        video_package: 'video_package',
        content_gap: 'opportunity',
        script_extract: 'script_extract',
        transcript_extract: 'transcript_extract',
        analyzer: 'script_extract',
      }
      const labelMap: Record<string, string> = {
        viral_score: 'Viral Score elemzés',
        similar_videos: 'Similar Videos keresés',
        opportunity_engine: 'Opportunity Engine keresés',
        video_audit: 'Videó audit',
        video_package: 'Videócsomag',
        script_extract: 'Script Extractor',
        transcript_extract: 'Auto Transcript',
        content_gap: 'Content Gap',
        analyzer: 'Elemzés',
      }
      const paidParams = new URLSearchParams({ paidResultId: p.id })
      const inputParam = p.tool_type === 'opportunity_engine' ? 'niche' : 'topic'
      if (p.original_input && ['viral_score', 'similar_videos', 'opportunity_engine'].includes(p.tool_type)) {
        paidParams.set(inputParam, p.original_input)
      }
      return {
        type: toolTypeMap[p.tool_type] || 'memory',
        title: `${labelMap[p.tool_type] || p.tool_type}: ${p.original_input}`,
        topic: p.original_input,
        date: p.last_opened_at || p.created_at,
        status: p.credit_cost > 0 ? polishStatusLabel('completed_paid') : polishStatusLabel('completed_free'),
        score: null,
        href: `${toolHref[p.tool_type] || '/dashboard'}?${paidParams.toString()}`,
        trend_status: null,
        views_delta: null,
        view_history: [],
      }
    }),
    ...usageLogs
      .filter(l => {
        if (!FEATURE_MAP[l.feature_name]) return false
        if (!((l.credits_charged || 0) > 0 || (l.metadata as { type?: string } | null)?.type === 'free_quota_use')) return false
        const metadata = l.metadata as { topic?: string; niche?: string } | null
        const searchTopic = metadata?.topic || metadata?.niche
        const paidToolType = l.feature_name === 'opportunity_engine' || l.feature_name === 'opportunity_explain'
          ? 'opportunity_engine'
          : l.feature_name
        const paidResultOnlyFeatures = new Set(['script_extract', 'transcript_extract', 'source_video_extract'])
        if (paidResultOnlyFeatures.has(l.feature_name)) {
          return false
        }
        const meta = FEATURE_MAP[l.feature_name]
        const paidUsageLogOnlyFeatures = new Set(['opportunity_engine', 'opportunity_explain'])
        if ((paidUsageLogOnlyFeatures.has(l.feature_name) || meta.type === 'opportunity') && (l.credits_charged || 0) > 0) {
          return false
        }
        if ((l.credits_charged || 0) > 0 && hasNearbyPaidResult(paidToolType, l.created_at)) {
          return false
        }
        return !paidActivityKeys.has(paidToolType + ':' + normalizeActivityKey(searchTopic))
      })
      .map(l => {
        const meta = FEATURE_MAP[l.feature_name]
        const metadata = l.metadata as { topic?: string; niche?: string } | null
        const searchTopic = metadata?.topic || metadata?.niche
        // Similar Videos és Viral Score ?topic= paraméterből, az Opportunity
        // Engine ?niche= paraméterből tud ingyenesen (cache-first) visszanyitni
        // egy korábbi eredményt — a többi eszköz oldala egyelőre nem támogatja ezt.
        const deepLinkParam: string | null =
          l.feature_name === 'similar_videos' || l.feature_name === 'viral_score' ? 'topic'
          : l.feature_name === 'opportunity_engine' || l.feature_name === 'opportunity_explain' ? 'niche'
          : null
        return {
          type: meta.type,
          title: searchTopic ? `${meta.label}: ${searchTopic}` : meta.label,
          topic: searchTopic || meta.label,
          date: l.created_at,
          status: (l.credits_charged || 0) > 0 ? `${l.credits_charged} kredit` : 'Ingyenes',
          score: null,
          href: searchTopic && deepLinkParam ? `${meta.href}?${deepLinkParam}=${encodeURIComponent(searchTopic)}` : meta.href,
          trend_status: null,
          views_delta: null,
          view_history: [],
        }
      }),
  ]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .filter((item, index, arr) => {
      const key = `${item.type}:${normalizeActivityKey(item.topic)}`
      return arr.findIndex(other => `${other.type}:${normalizeActivityKey(other.topic)}` === key) === index
    })
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

  type VideoIdeaSummary = {
    id: string
    title: string | null
    topic: string | null
    platform: string | null
    language: string | null
    market: string | null
    content_format: string | null
    viral_score: number | null
    opportunity_score: number | null
    competition_score: number | null
    proof_summary: string | null
    video_package_id: string | null
    calendar_status: string | null
    publish_status: string | null
    workflow_status: string | null
    updated_at: string
    created_at: string
  }

  function proofBoostFor(idea: VideoIdeaSummary): number {
    const proof = proofSignalMap.get(idea.id)
    if (!proof) return 0
    // Erős bizonyíték számít a legtöbbet, de a darabszám (akár gyenge jelekből
    // is) önmagában is jelzi, hogy a téma mögött már van valós kutatás — ezért
    // mindkettő számít, sapkázva, hogy egy témát ne lehessen pusztán sok gyenge
    // jellel a top fölé tolni egy kevés, de erős jelű téma elé.
    const weighted = proof.strong * 6 + proof.medium * 3 + proof.weak * 1
    return Math.min(35, weighted)
  }

  function ideaScore(idea: VideoIdeaSummary): number {
    const opportunity = Number(idea.opportunity_score || 0)
    const viral = Number(idea.viral_score || 0)
    const statusBoost: Record<string, number> = {
      ready_to_produce: 45,
      validated: 35,
      validating: 20,
      new_idea: 10,
      scheduled: 5,
      published: 0,
      audited: 0,
      rejected: -80,
      archived: -100,
    }
    const packageBoost = idea.video_package_id ? 30 : 0
    return Math.round((opportunity * 0.55) + (viral * 0.35) + (statusBoost[String(idea.workflow_status || 'new_idea')] || 0) + packageBoost + proofBoostFor(idea))
  }

  function ideaHref(idea: VideoIdeaSummary): string {
    if (idea.video_package_id) return `/dashboard/video-package?id=${idea.video_package_id}`
    if (idea.workflow_status === 'ready_to_produce') return `/dashboard/video-package?topic=${encodeURIComponent(idea.topic || idea.title || '')}`
    if (idea.viral_score != null) return `/dashboard/video-package?topic=${encodeURIComponent(idea.topic || idea.title || '')}`
    return `/dashboard/similar-videos?topic=${encodeURIComponent(idea.topic || idea.title || '')}`
  }

  function nextActionForIdea(idea: VideoIdeaSummary) {
    if (idea.video_package_id || idea.workflow_status === 'ready_to_produce') {
      return {
        label: 'Gyártási csomag megnyitása',
        reason: 'Ez az ötlet már gyártásra kész állapotban van.',
        href: ideaHref(idea),
        tone: 'ready',
      }
    }
    if (idea.workflow_status === 'validated' || (idea.viral_score || 0) >= 70 || (idea.opportunity_score || 0) >= 75) {
      return {
        label: 'Videócsomag készítése',
        reason: 'Elég erős jel látszik ahhoz, hogy csomag készüljön belőle.',
        href: `/dashboard/video-package?topic=${encodeURIComponent(idea.topic || idea.title || '')}`,
        tone: 'package',
      }
    }
    return {
      label: 'Piaci bizonyíték keresése',
      reason: 'Még validálni kell hasonló videókkal vagy Viral Score-ral.',
      href: `/dashboard/similar-videos?topic=${encodeURIComponent(idea.topic || idea.title || '')}`,
      tone: 'validate',
    }
  }

  const activeIdeas = (videoIdeas as VideoIdeaSummary[])
    .filter(idea => !['rejected', 'archived', 'published'].includes(String(idea.workflow_status)))
    .sort((a, b) => ideaScore(b) - ideaScore(a))

  const readyIdeas = activeIdeas.filter(idea => idea.video_package_id || idea.workflow_status === 'ready_to_produce').slice(0, 4)
  const topIdea = activeIdeas[0] || null
  const topIdeaAction = topIdea ? nextActionForIdea(topIdea) : null
  const commandCenter = {
    has_video_ideas: videoIdeas.length > 0,
    top_idea: topIdea ? {
      id: topIdea.id,
      title: topIdea.title || topIdea.topic || 'Cím nélkül',
      topic: topIdea.topic || topIdea.title || 'Cím nélkül',
      platform: topIdea.platform || 'youtube',
      workflow_status: topIdea.workflow_status || 'new_idea',
      opportunity_score: topIdea.opportunity_score,
      viral_score: topIdea.viral_score,
      proof_summary: topIdea.proof_summary,
      proof_signal_count: proofSignalMap.get(topIdea.id)?.total || 0,
      video_package_id: topIdea.video_package_id,
      href: ideaHref(topIdea),
      next_action: topIdeaAction,
    } : null,
    ready_to_create: readyIdeas.map(idea => ({
      id: idea.id,
      title: idea.title || idea.topic || 'Cím nélkül',
      topic: idea.topic || idea.title || 'Cím nélkül',
      href: ideaHref(idea),
      video_package_id: idea.video_package_id,
      opportunity_score: idea.opportunity_score,
      viral_score: idea.viral_score,
      proof_signal_count: proofSignalMap.get(idea.id)?.total || 0,
      updated_at: idea.updated_at,
    })),
    pipeline: {
      total: videoIdeas.length,
      new_idea: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'new_idea').length,
      validating: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'validating').length,
      validated: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'validated').length,
      ready_to_produce: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'ready_to_produce').length,
      scheduled: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'scheduled').length,
      published: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'published').length,
      rejected: videoIdeas.filter((idea: VideoIdeaSummary) => idea.workflow_status === 'rejected').length,
    },
    next_best_action: topIdeaAction || {
      label: 'Videólehetőségek keresése',
      reason: 'Még nincs központi Video Idea adat. Indíts egy validált témakeresést.',
      href: '/dashboard/opportunities',
      tone: 'start',
    },
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
    command_center: commandCenter,
    content_direction_insight: contentDirectionInsight,
    youtube_signals: youtubeSignals,
  })
}
