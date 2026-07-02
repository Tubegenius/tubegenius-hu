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
  ] = await Promise.all([
    admin.from('user_credits').select('balance, total_used, plan').eq('user_id', userId).single(),
    admin.from('creator_memory').select('id, topic, state, platform, updated_at').eq('user_id', userId).order('updated_at', { ascending: false }),
    admin.from('video_packages').select('id, topic, platform, video_length, quality_status, strict_fact_mode, fact_strictness_level, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('video_audits').select('id, video_title, topic, platform, overall_score, decision, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('ai_usage_logs').select('feature_name, credits_charged, metadata, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
    admin.from('youtube_videos').select('*', { count: 'exact', head: true }),
    admin.from('youtube_video_snapshots').select('*', { count: 'exact', head: true }),
  ])

  const memory = memoryRes.data || []
  const packages = packagesRes.data || []
  const audits = auditsRes.data || []
  const usageLogs = usageLogsRes.data || []

  const hasAnyActivity = memory.length > 0 || packages.length > 0 || audits.length > 0 || usageLogs.length > 0

  // ── 1. Videócsomagok ──
  const packagesSummary = {
    total: packages.length,
    shorts: packages.filter(p => p.video_length === 'short').length,
    long: packages.filter(p => p.video_length === 'long' || p.video_length === 'medium').length,
  }

  // ── 2. Auditok ──
  const auditsSummary = { total: audits.length }

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

  // ── Legutóbbi aktivitás — max 10, összefésülve, dátum szerint ──
  type ActivityItem = {
    type: 'video_package' | 'video_audit' | 'memory' | 'credit_usage'
    title: string
    date: string
    status: string | null
  }

  const activity: ActivityItem[] = [
    ...packages.map(p => ({
      type: 'video_package' as const,
      title: `Videócsomag készült: ${p.topic || 'Cím nélkül'}`,
      date: p.created_at,
      status: p.quality_status,
    })),
    ...audits.map(a => ({
      type: 'video_audit' as const,
      title: `Audit lefuttatva: ${a.video_title || a.topic || 'Cím nélkül'}`,
      date: a.created_at,
      status: a.decision || (a.overall_score != null ? `${a.overall_score} pont` : null),
    })),
    ...memory.map(m => ({
      type: 'memory' as const,
      title: `Téma ${m.state === 'saved' ? 'mentve' : m.state === 'completed' ? 'lezárva' : m.state === 'rejected' ? 'elutasítva' : 'folyamatban'}: ${m.topic}`,
      date: m.updated_at,
      status: m.state,
    })),
    ...usageLogs
      .filter(l => (l.credits_charged || 0) > 0)
      .map(l => ({
        type: 'credit_usage' as const,
        title: `Kredit felhasználva: ${l.feature_name}`,
        date: l.created_at,
        status: `${l.credits_charged} kredit`,
      })),
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
