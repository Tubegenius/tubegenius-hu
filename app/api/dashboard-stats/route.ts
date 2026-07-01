import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminClient } from '@/lib/supabase-server'

// GET /api/dashboard-stats
// Valós adatok a Supabase-ből — nincs mock, nincs kamu szám
export async function GET() {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const userId = user.id

  // Párhuzamos lekérések
  const [
    creditsRes,
    memoryRes,
    videoPackagesRes,
    videoAuditsRes,
    opportunityCacheRes,
    usageLogsRes,
  ] = await Promise.all([
    admin.from('user_credits').select('balance, total_used, plan').eq('user_id', userId).single(),
    admin.from('creator_memory').select('state, platform, created_at').eq('user_id', userId),
    admin.from('video_packages').select('id, created_at, platform').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('video_audits').select('id, overall_score, platform, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('opportunity_cache').select('generated_at').eq('generated_by', userId).order('generated_at', { ascending: false }).limit(1),
    admin.from('ai_usage_logs').select('credits_charged, feature_name, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(500),
  ])

  const memory = memoryRes.data || []
  const packages = videoPackagesRes.data || []
  const audits = videoAuditsRes.data || []

  const totalScriptExtracts = usageLogsRes.data?.filter(l =>
    l.feature_name === 'script_extract' || l.feature_name === 'source_video_extract'
  ).length || 0
  const usageLogs = usageLogsRes.data || []

  // ─── Összesítések ───
  const totalCreditsUsed = creditsRes.data?.total_used ?? 0
  const savedTopics = memory.filter(i => i.state === 'saved').length
  const inProgressTopics = memory.filter(i => i.state === 'in_progress').length
  const completedTopics = memory.filter(i => i.state === 'completed').length
  const totalPackages = packages.length
  const totalAudits = audits.length

  // Opportunity kérések száma (cache-ből + usage logs-ból)
  const { count: oppCacheCount } = await admin
    .from('opportunity_cache')
    .select('*', { count: 'exact', head: true })
    .eq('generated_by', userId)
  const opportunityRequests = (oppCacheCount || 0) + usageLogs.filter(l => l.feature_name === 'opportunity_explain' || l.feature_name === 'opportunity').length

  // Mai aktivitás — helyi időzóna (CET/CEST) szerint, nem UTC
  const now = new Date()
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const todayLogs = usageLogs.filter(l => {
    if (!l.created_at) return false
    const logDate = l.created_at.slice(0, 10)
    return logDate === localDate || logDate === new Date().toISOString().slice(0, 10)
  })
  const todayCreditsUsed = todayLogs.reduce((sum, l) => sum + (l.credits_charged || 0), 0)
  const todayGenerations = todayLogs.length

  // Legutóbbi aktivitás
  const lastActivity = usageLogs[0]?.created_at || null
  const lastOpportunity = opportunityCacheRes.data?.[0]?.generated_at || null

  // Napi kredit felhasználás az elmúlt 7 napra (chart-hoz)
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return d.toISOString().slice(0, 10)
  })

  const dailyUsage = last7Days.map(day => {
    const dayLogs = usageLogs.filter(l => l.created_at?.slice(0, 10) === day)
    return {
      day: day.slice(5), // MM-DD
      credits: Math.round(dayLogs.reduce((sum, l) => sum + (l.credits_charged || 0), 0) * 10) / 10,
      count: dayLogs.length,
    }
  })

  // Platform eloszlás (memory alapján)
  const platformCounts: Record<string, number> = {}
  memory.forEach(item => {
    if (item.platform) platformCounts[item.platform] = (platformCounts[item.platform] || 0) + 1
  })
  const totalMemory = memory.length || 1
  const platformStats = Object.entries(platformCounts).map(([platform, count]) => ({
    label: platform.charAt(0).toUpperCase() + platform.slice(1),
    pct: Math.round((count / totalMemory) * 100),
  })).sort((a, b) => b.pct - a.pct).slice(0, 5)

  // Átlagos audit score
  const avgAuditScore = audits.length > 0
    ? Math.round(audits.reduce((sum, a) => sum + (a.overall_score || 0), 0) / audits.length)
    : null

  return NextResponse.json({
    // Kreditek
    balance: creditsRes.data?.balance ?? 50,
    total_used: totalCreditsUsed,
    plan: creditsRes.data?.plan || 'beta',

    // Aktivitás
    today_credits_used: Math.round(todayCreditsUsed * 10) / 10,
    today_generations: todayGenerations,
    last_activity: lastActivity,
    last_opportunity: lastOpportunity,

    // Tartalom
    saved_topics: savedTopics,
    in_progress_topics: inProgressTopics,
    completed_topics: completedTopics,
    total_packages: totalPackages,
    total_audits: totalAudits,
    opportunity_requests: opportunityRequests,
    avg_audit_score: avgAuditScore,

    // Chart (elmúlt 7 nap)
    daily_usage: dailyUsage,

    // Platform eloszlás
    platform_stats: platformStats,

    // Script extract
    total_script_extracts: totalScriptExtracts,

    // Van-e elég adat a dashboard-hoz
    has_data: usageLogs.length > 0 || memory.length > 0,
  })
}
