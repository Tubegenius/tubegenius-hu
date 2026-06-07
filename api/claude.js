// ============================================================
// WillViral — api/claude.js v2.0
// Teljes backend: YouTube API, Claude API, Cache, Cost logging
// ============================================================

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const MODEL = 'claude-sonnet-4-6';

// ── Cache (memória alapú, Supabase nélkül is működik) ──────
const memCache = new Map();

function cacheGet(key) {
  const item = memCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { memCache.delete(key); return null; }
  return item.data;
}

function cacheSet(key, data, ttlMs) {
  memCache.set(key, { data, expires: Date.now() + ttlMs });
}

// ── Segédfüggvények ────────────────────────────────────────
function fmt(n) { return parseInt(n || 0); }

function videoType(url) {
  if (!url) return 'long';
  return url.includes('/shorts/') ? 'shorts' : 'long';
}

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function formatViews(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ── CORS headers ───────────────────────────────────────────
function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── YouTube API hívás ──────────────────────────────────────
async function ytFetch(endpoint, params) {
  const YT_KEY = process.env.YT_API_KEY;
  const url = new URL(`${YT_API}/${endpoint}`);
  url.searchParams.set('key', YT_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API hiba: ${res.status}`);
  return res.json();
}

// ── Claude API hívás ───────────────────────────────────────
async function claudeFetch(messages, maxTokens = 4000, systemPrompt = null) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API hiba: ${err}`);
  }

  const data = await res.json();

  // Cost számítás
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const costUsd = (inputTokens * 3 + outputTokens * 15) / 1_000_000;

  return {
    text: data.content?.[0]?.text || '',
    inputTokens,
    outputTokens,
    costUsd
  };
}

// ── Viral Score számítás (BACKEND számolja, nem Claude!) ───
function calculateViralScore(searchData) {
  const { avgViews, avgLikes, avgComments, videoCount, freshRatio, uploadVelocity } = searchData;

  // 1. Views Potential (0-30 pont)
  let viewsPotential = 0;
  if (avgViews >= 1_000_000) viewsPotential = 30;
  else if (avgViews >= 500_000) viewsPotential = 25;
  else if (avgViews >= 100_000) viewsPotential = 20;
  else if (avgViews >= 50_000) viewsPotential = 14;
  else if (avgViews >= 10_000) viewsPotential = 8;
  else if (avgViews >= 1_000) viewsPotential = 4;
  else viewsPotential = 1;

  // 2. Trend Score (0-25 pont) — YouTube dátum alapján
  let trendScore = 0;
  const freshPct = freshRatio || 0;
  if (freshPct >= 60) trendScore = 22;
  else if (freshPct >= 40) trendScore = 16;
  else if (freshPct >= 20) trendScore = 10;
  else trendScore = 4;
  // Upload velocity bónusz (max +3)
  const vel = uploadVelocity || 0;
  if (vel >= 50) trendScore = Math.min(25, trendScore + 3);
  else if (vel >= 20) trendScore = Math.min(25, trendScore + 2);
  else if (vel >= 5) trendScore = Math.min(25, trendScore + 1);

  // 3. Competition Score (0-20 pont)
  let competitionScore = 0;
  if (videoCount <= 5) competitionScore = 20;
  else if (videoCount <= 20) competitionScore = 16;
  else if (videoCount <= 50) competitionScore = 12;
  else if (videoCount <= 100) competitionScore = 8;
  else if (videoCount <= 200) competitionScore = 4;
  else competitionScore = 2;

  // 4. Engagement Score (0-15 pont)
  let engagementScore = 0;
  const likeRatio = avgViews > 0 ? avgLikes / avgViews : 0;
  if (likeRatio >= 0.05) engagementScore = 15;
  else if (likeRatio >= 0.03) engagementScore = 11;
  else if (likeRatio >= 0.01) engagementScore = 7;
  else if (likeRatio >= 0.005) engagementScore = 3;
  else engagementScore = 1;

  // 5. Search Interest (0-10 pont) — alap 5 pont, pytrends finomítja
  const searchInterest = 5;

  const total = viewsPotential + trendScore + competitionScore + engagementScore + searchInterest;
  const score = Math.min(100, Math.max(1, Math.round(total)));

  let szint = 'Gyenge';
  if (score >= 80) szint = 'Erős';
  else if (score >= 60) szint = 'Jó';
  else if (score >= 40) szint = 'Közepes';

  return {
    viralScore: score,
    szint,
    komponensek: {
      viewsPotential,
      trendScore,
      competitionScore,
      engagementScore,
      searchInterest
    }
  };
}

// ── YouTube Search + Stats ─────────────────────────────────
async function youtubeSearch(query, regionCode = 'HU', mode = 'hu') {
  const cacheKey = `search_${query}_${regionCode}_${mode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const relevanceLang = regionCode === 'HU' ? 'hu' : 'en';

  // 1. Keresés
  const searchData = await ytFetch('search', {
    q: query,
    part: 'snippet',
    type: 'video',
    maxResults: 10,
    regionCode,
    relevanceLanguage: relevanceLang,
    order: 'relevance'
  });

  if (!searchData.items?.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, videoCount: 0, freshRatio: 0, uploadVelocity: 0, topVideos: [] };
  }

  // 2. Video ID-k + dátumok
  const videoIds = searchData.items.map(i => i.id?.videoId).filter(Boolean);
  const publishDates = searchData.items.map(i => i.snippet?.publishedAt).filter(Boolean);

  // 3. Statisztikák batch lekérése
  const statsData = await ytFetch('videos', {
    id: videoIds.join(','),
    part: 'statistics,snippet,contentDetails'
  });

  if (!statsData.items?.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, videoCount: 0, freshRatio: 0, uploadVelocity: 0, topVideos: [] };
  }

  // 4. Számítások
  const views = statsData.items.map(v => fmt(v.statistics?.viewCount));
  const likes = statsData.items.map(v => fmt(v.statistics?.likeCount));
  const comments = statsData.items.map(v => fmt(v.statistics?.commentCount));

  const avgViews = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
  const avgLikes = Math.round(likes.reduce((a, b) => a + b, 0) / likes.length);
  const avgComments = Math.round(comments.reduce((a, b) => a + b, 0) / comments.length);

  // 5. Fresh ratio (utolsó 7 nap %)
  const freshCount = publishDates.filter(d => daysSince(d) <= 7).length;
  const freshRatio = Math.round((freshCount / publishDates.length) * 100);

  // 6. Upload velocity (utolsó 7 nap feltöltések száma)
  const uploadVelocity = freshCount;

  // 7. Top videók (thumbnail + link + minden adat)
  const topVideos = statsData.items.slice(0, 6).map(v => {
    const isShorts = fmt(v.contentDetails?.duration?.match(/PT(\d+)S/)?.[1]) < 60
      || v.snippet?.title?.toLowerCase().includes('#shorts');
    return {
      videoId: v.id,
      title: v.snippet?.title || '',
      channel: v.snippet?.channelTitle || '',
      views: fmt(v.statistics?.viewCount),
      viewsFormatted: formatViews(fmt(v.statistics?.viewCount)),
      likes: fmt(v.statistics?.likeCount),
      comments: fmt(v.statistics?.commentCount),
      thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || '',
      url: `https://youtube.com/watch?v=${v.id}`,
      publishedAt: v.snippet?.publishedAt,
      daysSince: daysSince(v.snippet?.publishedAt),
      isShorts,
      region: regionCode
    };
  });

  const result = {
    avgViews,
    avgLikes,
    avgComments,
    videoCount: statsData.items.length,
    freshRatio,
    uploadVelocity,
    topVideos,
    regionCode
  };

  // Cache 6 óra
  cacheSet(cacheKey, result, 6 * 60 * 60 * 1000);
  return result;
}

// ── Trending videók ────────────────────────────────────────
async function getTrending(regionCode = 'HU', categoryId = '0') {
  const cacheKey = `trending_${regionCode}_${categoryId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await ytFetch('videos', {
    chart: 'mostPopular',
    regionCode,
    videoCategoryId: categoryId,
    maxResults: 12,
    part: 'snippet,statistics,contentDetails'
  });

  const videos = (data.items || []).map(v => {
    const duration = v.contentDetails?.duration || '';
    const seconds = parseDuration(duration);
    const isShorts = seconds <= 60;
    return {
      videoId: v.id,
      title: v.snippet?.title || '',
      channel: v.snippet?.channelTitle || '',
      views: fmt(v.statistics?.viewCount),
      viewsFormatted: formatViews(fmt(v.statistics?.viewCount)),
      likes: fmt(v.statistics?.likeCount),
      thumbnail: v.snippet?.thumbnails?.medium?.url || '',
      url: `https://youtube.com/watch?v=${v.id}`,
      publishedAt: v.snippet?.publishedAt,
      daysSince: daysSince(v.snippet?.publishedAt),
      isShorts,
      region: regionCode
    };
  });

  // Cache 1 óra
  cacheSet(cacheKey, videos, 60 * 60 * 1000);
  return videos;
}

function parseDuration(duration) {
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// ── MASTER SYSTEM PROMPT ───────────────────────────────────
const MASTER_PROMPT = `Te a WillViral Creator Intelligence Platform AI motorja vagy.

SZEMÉLYISÉGED:
Tapasztalt creator barát vagy, nem AI. Rövid, tömör mondatok. Magyar köznyelv.
TILOS: "kiemelkedő", "hatékony", "stratégiai", "optimális", "komprehenzív", "innovatív"
TILOS: körülírás, AI szagú megfogalmazás, dagályos mondatok
KÖTELEZŐ: konkrét számok, emberi hangnem, rövid mondatok

ADATKEZELÉS:
- CSAK a backend által átadott valós YouTube adatokat használd
- Ha nincs adat: mondd meg őszintén, NE becsülj
- A Viral Score-t a BACKEND számolta, te csak magyarázod
- Soha ne írj felül backend adatot

A FŐ KÉRDÉS AMIT MEGVÁLASZOLSZ:
"Érdemes-e egyáltalán erről videót készítened?"`;

// ── Főbb logikák ───────────────────────────────────────────

// VÉGPONT: youtube (egyetlen videó adatai)
async function handleYoutube(body, res) {
  const { videoId } = body;
  if (!videoId) return res.status(400).json({ error: 'videoId kötelező' });

  const cacheKey = `video_${videoId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);

  const data = await ytFetch('videos', {
    id: videoId,
    part: 'snippet,statistics,contentDetails'
  });

  if (!data.items?.length) return res.status(404).json({ error: 'Videó nem található' });

  const video = data.items[0];
  cacheSet(cacheKey, video, 6 * 60 * 60 * 1000);
  return res.status(200).json(video);
}

// VÉGPONT: youtube_search (téma alapú keresés)
async function handleYoutubeSearch(body, res) {
  const { searchQuery, regionCode = 'HU', mode = 'hu' } = body;
  if (!searchQuery) return res.status(400).json({ error: 'searchQuery kötelező' });

  // Ha mindkettő kell: párhuzamos lekérdezés
  if (mode === 'both') {
    const [huData, globalData] = await Promise.all([
      youtubeSearch(searchQuery, 'HU', 'hu'),
      youtubeSearch(searchQuery, 'US', 'en')
    ]);

    // Összefésülés: HU videók + global videók, jelölve
    const allVideos = [
      ...huData.topVideos.map(v => ({ ...v, region: 'hu' })),
      ...globalData.topVideos.map(v => ({ ...v, region: 'global' }))
    ].slice(0, 8);

    return res.status(200).json({
      hu: huData,
      global: globalData,
      topVideos: allVideos,
      mode: 'both'
    });
  }

  const data = await youtubeSearch(searchQuery, regionCode, mode);
  return res.status(200).json(data);
}

// VÉGPONT: viral_score_calc (Viral Score számítás)
async function handleViralScoreCalc(body, res) {
  const { searchData } = body;
  if (!searchData) return res.status(400).json({ error: 'searchData kötelező' });

  const result = calculateViralScore(searchData);
  return res.status(200).json(result);
}

// VÉGPONT: trending (Trend Radar)
async function handleTrending(body, res) {
  const { regionCode = 'HU', categoryId = '0' } = body;
  const videos = await getTrending(regionCode, categoryId);
  return res.status(200).json({ videos });
}

// VÉGPONT: viral_score_full (teljes Viral Score flow)
async function handleViralScoreFull(body, res) {
  const { query, regionCode = 'HU', mode = 'hu', creatorProfile = {} } = body;
  if (!query) return res.status(400).json({ error: 'query kötelező' });

  // 1. YouTube adatok lekérése
  let searchData;
  let globalData = null;

  if (mode === 'both') {
    const [hu, global] = await Promise.all([
      youtubeSearch(query, 'HU', 'hu'),
      youtubeSearch(query, 'US', 'en')
    ]);
    searchData = hu;
    globalData = global;
  } else {
    searchData = await youtubeSearch(query, regionCode, mode);
  }

  // 2. Viral Score számítás (backend!)
  const scoreResult = calculateViralScore(searchData);
  let globalScoreResult = null;
  if (globalData) globalScoreResult = calculateViralScore(globalData);

  // 3. pytrends próbálkozás (opcionális)
  let trendBonus = 0;
  try {
    const trendRes = await fetch(`${process.env.VERCEL_URL || ''}/api/trends?q=${encodeURIComponent(query)}&geo=${regionCode}`);
    if (trendRes.ok) {
      const trendData = await trendRes.json();
      trendBonus = trendData.score || 0; // 0-5 pont
      scoreResult.viralScore = Math.min(100, scoreResult.viralScore + trendBonus);
      scoreResult.komponensek.searchInterest = Math.min(10, 5 + trendBonus);
    }
  } catch {
    // Silent fallback — pytrends nem működött, semmi baj
  }

  // 4. Claude magyarázat
  const dataContext = `
VALÓS YOUTUBE ADATOK (${regionCode === 'HU' ? 'Magyar' : 'Globális'} adatbázis):
- Viral Score: ${scoreResult.viralScore}/100 (${scoreResult.szint})
- Átlag nézettség: ${searchData.avgViews.toLocaleString()}
- Átlag like: ${searchData.avgLikes.toLocaleString()}
- Hasonló videók száma: ${searchData.videoCount}
- Friss tartalom arány (7 nap): ${searchData.freshRatio}%
- Feltöltési sebesség (7 nap): ${searchData.uploadVelocity} videó
- Komponensek: Nézettség ${scoreResult.komponensek.viewsPotential}/30, Trend ${scoreResult.komponensek.trendScore}/25, Verseny ${scoreResult.komponensek.competitionScore}/20, Engagement ${scoreResult.komponensek.engagementScore}/15
${globalScoreResult ? `\nGLOBÁLIS ADATOK:\n- Viral Score: ${globalScoreResult.viralScore}/100 (${globalScoreResult.szint})\n- Átlag nézettség: ${globalData.avgViews.toLocaleString()}` : ''}`;

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([
    {
      role: 'user',
      content: `${dataContext}

CREATOR PROFIL:
- Platform: ${creatorProfile.platform || 'YouTube'}
- Niche: ${creatorProfile.niche || 'általános'}
- Stílus: ${creatorProfile.style || 'vegyes'}
- Célközönség: ${creatorProfile.audience || 'általános'}

FELADAT: Magyarázd el emberi hangon (max 3-4 rövid mondat) mit jelent ez a Viral Score.
Mondd meg konkrétan: megéri-e erről videót csinálni.
Hivatkozz a valós számokra. Ne általánosíts.
Csak a magyarázatot írd, semmi mást.`
    }
  ], 500, MASTER_PROMPT);

  // 5. Top videók (thumbnail-lel!)
  const topVideos = (mode === 'both'
    ? [
        ...searchData.topVideos.slice(0, 3).map(v => ({ ...v, region: 'hu' })),
        ...(globalData?.topVideos || []).slice(0, 3).map(v => ({ ...v, region: 'global' }))
      ]
    : searchData.topVideos
  );

  return res.status(200).json({
    viralScore: scoreResult.viralScore,
    szint: scoreResult.szint,
    komponensek: scoreResult.komponensek,
    magyarazat: text,
    topVideos,
    searchData: {
      avgViews: searchData.avgViews,
      avgLikes: searchData.avgLikes,
      videoCount: searchData.videoCount,
      freshRatio: searchData.freshRatio,
      uploadVelocity: searchData.uploadVelocity
    },
    globalScore: globalScoreResult?.viralScore || null,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// VÉGPONT: video_analyze (Video Analyzer)
async function handleVideoAnalyze(body, res) {
  const { url, creatorProfile = {} } = body;
  if (!url) return res.status(400).json({ error: 'url kötelező' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Érvénytelen YouTube URL' });

  const isShorts = videoType(url) === 'shorts';

  // YouTube adatok
  const ytData = await ytFetch('videos', {
    id: videoId,
    part: 'snippet,statistics,contentDetails'
  });

  if (!ytData.items?.length) return res.status(404).json({ error: 'Videó nem található' });

  const video = ytData.items[0];
  const sn = video.snippet;
  const st = video.statistics;

  const views = fmt(st.viewCount);
  const likes = fmt(st.likeCount);
  const comments = fmt(st.commentCount);
  const likeRatio = views > 0 ? ((likes / views) * 100).toFixed(2) : 0;

  // Claude elemzés
  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([
    {
      role: 'user',
      content: `VIDEÓ ADATOK (VALÓS):
Cím: ${sn.title}
Csatorna: ${sn.channelTitle}
Típus: ${isShorts ? 'YouTube Shorts' : 'YouTube videó'}
Nézettség: ${views.toLocaleString()}
Like: ${likes.toLocaleString()} (${likeRatio}% arány)
Komment: ${comments.toLocaleString()}
Feltöltve: ${sn.publishedAt} (${daysSince(sn.publishedAt)} napja)
Leírás (első 500 kar): ${(sn.description || '').substring(0, 500)}
Tagek: ${(sn.tags || []).slice(0, 10).join(', ')}

CREATOR PROFIL: ${creatorProfile.niche || 'általános'} / ${creatorProfile.platform || 'YouTube'}

FELADAT: Elemezd ezt a videót. Adj JSON választ:
{
  "hook_score": 0-100,
  "hook_mi_mukodik": "egy mondat",
  "hook_problema": "egy mondat",
  "hook_javitas": "egy mondat",
  "story_score": 0-100,
  "story_mi_mukodik": "egy mondat",
  "story_problema": "egy mondat",
  "story_javitas": "egy mondat",
  "retention_score": 0-100,
  "retention_mi_mukodik": "egy mondat",
  "retention_problema": "egy mondat",
  "retention_javitas": "egy mondat",
  "cta_score": 0-100,
  "cta_mi_mukodik": "egy mondat",
  "cta_problema": "egy mondat",
  "cta_javitas": "egy mondat",
  "viral_score": 0-100,
  "viral_mi_mukodik": "egy mondat",
  "viral_problema": "egy mondat",
  "viral_javitas": "egy mondat",
  "osszes_ertekeles": "2-3 mondat összefoglaló emberi hangon",
  "legfobb_tanacs": "egyetlen legfontosabb tanács",
  "javitott_cimek": ["jobb cím 1", "jobb cím 2", "jobb cím 3"]
}
Csak JSON, semmi más.`
    }
  ], 1500, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    parsed = JSON.parse(clean.substring(s, e + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    videoInfo: {
      videoId,
      title: sn.title,
      channel: sn.channelTitle,
      thumbnail: sn.thumbnails?.medium?.url || '',
      views,
      likes,
      comments,
      likeRatio,
      publishedAt: sn.publishedAt,
      daysSince: daysSince(sn.publishedAt),
      isShorts,
      url: `https://youtube.com/watch?v=${videoId}`
    },
    audit: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// VÉGPONT: content_generate (Content Generator)
async function handleContentGenerate(body, res) {
  const { topic, platform = 'youtube', length = 'medium', tone = 'informativ', creatorProfile = {}, regionCode = 'HU', mode = 'hu' } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  // 1. YouTube ellenőrzés előbb!
  const searchData = await youtubeSearch(topic, regionCode, mode);
  const scoreResult = calculateViralScore(searchData);

  // 2. Claude generál az adatok alapján
  const lenMap = { short: 'rövid Shorts/TikTok (30-60 mp)', medium: 'közepes (2-5 perc)', long: 'hosszú YouTube (8-15 perc)' };
  const toneMap = { megdobbento: 'megdöbbentő sokkos', informativ: 'informatív oktatói', vicces: 'vicces szórakoztató', komoly: 'komoly elemző', motivalo: 'motiváló inspiráló' };

  const ytContext = searchData.avgViews > 0
    ? `VALÓS YOUTUBE ADATOK: ${searchData.videoCount} hasonló videó, átlag nézettség: ${searchData.avgViews.toLocaleString()}, Viral Score: ${scoreResult.viralScore}/100`
    : 'YouTube adat nem elérhető ehhez a témához.';

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([
    {
      role: 'user',
      content: `${ytContext}

CREATOR PROFIL:
- Platform: ${creatorProfile.platform || platform}
- Niche: ${creatorProfile.niche || 'általános'}
- Célközönség: ${creatorProfile.audience || 'általános'}
- Stílus: ${creatorProfile.style || tone}
- Tapasztalat: ${creatorProfile.experience || 'haladó'}
- Cél: ${creatorProfile.goal || 'nézettség növelés'}

GENERÁLÁSI PARAMÉTEREK:
- Téma: ${topic}
- Hossz: ${lenMap[length] || lenMap.medium}
- Hangvétel: ${toneMap[tone] || toneMap.informativ}
- Mai dátum: ${new Date().toLocaleDateString('hu-HU')}

FELADAT: Generálj teljes tartalomcsomagot. Csak JSON:
{
  "cimek": ["cím1", "cím2", "cím3", "cím4", "cím5"],
  "narracio": "Teljes narráció erős hookkal és CTA-val",
  "youtube_leiras": "SEO leírás 150-200 szóban",
  "tiktok_caption": "TikTok caption hashtagekkel",
  "instagram_caption": "Instagram caption",
  "facebook_post": "Facebook poszt",
  "tagek": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8", "tag9", "tag10"],
  "thumbnail_szoveg": "THUMBNAIL FŐ SZÖVEG",
  "thumbnail_tip": "Design tipp",
  "pinned_komment": "Pinned komment kérdéssel",
  "legjobb_feltoltes_yt": "Hétfő 10:00",
  "legjobb_feltoltes_tt": "Kedd 19:00",
  "legjobb_feltoltes_fb": "Szerda 12:00"
}
Csak JSON, semmi más.`
    }
  ], 4000, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    parsed = JSON.parse(clean.substring(s, e + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    viralScore: scoreResult.viralScore,
    szint: scoreResult.szint,
    topVideos: searchData.topVideos,
    searchData: {
      avgViews: searchData.avgViews,
      videoCount: searchData.videoCount
    },
    tartalom: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// VÉGPONT: content_gap (Content Gap Analysis)
async function handleContentGap(body, res) {
  const { topic, regionCode = 'HU', mode = 'hu', creatorProfile = {} } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  // Top videók lekérése
  const searchData = await youtubeSearch(topic, regionCode, mode);
  const topVideos = searchData.topVideos.slice(0, 5);

  if (!topVideos.length) return res.status(200).json({ error: 'Nem találhatók videók ehhez a témához' });

  const videoList = topVideos.map((v, i) =>
    `${i + 1}. "${v.title}" — ${v.channel} (${v.viewsFormatted} nézés, ${v.daysSince} napja)`
  ).join('\n');

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([
    {
      role: 'user',
      content: `TOP VIDEÓK ERRŐL A TÉMÁRÓL (valós YouTube adatok):
${videoList}

CREATOR PROFIL: ${creatorProfile.niche || topic} / ${creatorProfile.audience || 'általános'}

FELADAT: Elemezd mit csinálnak ezek a videók és mit NEM.
Csak JSON:
{
  "mit_mondanak": ["3-5 leggyakoribb nézőpont amit feldolgoznak"],
  "mit_nem_mondanak": ["3-5 hiányzó nézőpont amit SENKI nem dolgozott fel"],
  "ajanlott_iranyok": [
    {"cim": "Javasolt videó cím", "indok": "Miért hiányzik a piacon"},
    {"cim": "Javasolt videó cím 2", "indok": "Miért hiányzik a piacon"},
    {"cim": "Javasolt videó cím 3", "indok": "Miért hiányzik a piacon"}
  ],
  "legjobb_szog": "Egyetlen legjobb feldolgozatlan szög egy mondatban",
  "osszes_elemzes": "2-3 mondatos összefoglaló emberi hangon"
}
Csak JSON, semmi más.`
    }
  ], 1500, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    parsed = JSON.parse(clean.substring(s, e + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    topVideos,
    gap: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// VÉGPONT: video_package (Video Package Generator)
async function handleVideoPackage(body, res) {
  const { topic, platform = 'youtube', length = 'medium', creatorProfile = {} } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  const isShorts = length === 'short';

  const struktura = isShorts
    ? 'Hook (0-3mp), Tartalom (3-50mp), CTA (50-60mp)'
    : 'Hook (0-30mp), Intro (30mp-2p), Főtartalom (2p-vége), CTA+Outro (utolsó 1p)';

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([
    {
      role: 'user',
      content: `CREATOR PROFIL:
- Platform: ${creatorProfile.platform || platform}
- Niche: ${creatorProfile.niche || 'általános'}
- Stílus: ${creatorProfile.style || 'informatív'}
- Célközönség: ${creatorProfile.audience || 'általános'}

VIDEÓ PARAMÉTEREK:
- Téma: ${topic}
- Hossz: ${length === 'short' ? 'Shorts (60 mp)' : length === 'long' ? 'Hosszú (10-15 perc)' : 'Közepes (3-8 perc)'}
- Struktúra: ${struktura}

FELADAT: Generálj teljes videócsomagot. Csak JSON:
{
  "jelenetek": [
    {
      "sorszam": 1,
      "ido": "0-3 mp",
      "nev": "Hook",
      "narracio": "Szöveg amit mond a creator",
      "vizual": "Mit mutat a kamera / képernyő",
      "broll": "B-roll javaslat",
      "grafika": "Felirat / szöveg overlay"
    }
  ],
  "teljes_narracio": "Az összes jelenet narrációja egyben",
  "ossz_hossz": "Becsült teljes hossz"
}
${isShorts ? 'SHORTS: 3 jelenet (Hook, Tartalom, CTA)' : 'LONG: 6-8 jelenet részletesen'}
Csak JSON, semmi más.`
    }
  ], 5000, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    parsed = JSON.parse(clean.substring(s, e + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    csomag: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// VÉGPONT: claude (általános, visszafelé kompatibilis)
async function handleClaude(body, res) {
  const { messages, maxTokens = 4000 } = body;
  if (!messages) return res.status(400).json({ error: 'messages kötelező' });

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch(messages, maxTokens, MASTER_PROMPT);

  // JSON parse próbálkozás (visszafelé kompatibilis)
  try {
    let clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s !== -1 && e !== -1) clean = clean.substring(s, e + 1);
    const parsed = JSON.parse(clean);
    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
      _cost: { inputTokens, outputTokens, costUsd }
    });
  } catch {
    return res.status(200).json({
      content: [{ type: 'text', text }],
      _cost: { inputTokens, outputTokens, costUsd }
    });
  }
}

// ── FŐ HANDLER ─────────────────────────────────────────────
module.exports = async (req, res) => {
  corsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { type } = body;

    switch (type) {
      case 'youtube':
        return await handleYoutube(body, res);

      case 'youtube_search':
        return await handleYoutubeSearch(body, res);

      case 'viral_score_calc':
        return await handleViralScoreCalc(body, res);

      case 'viral_score_full':
        return await handleViralScoreFull(body, res);

      case 'trending':
        return await handleTrending(body, res);

      case 'video_analyze':
        return await handleVideoAnalyze(body, res);

      case 'content_generate':
        return await handleContentGenerate(body, res);

      case 'content_gap':
        return await handleContentGap(body, res);

      case 'video_package':
        return await handleVideoPackage(body, res);

      case 'claude':
      default:
        return await handleClaude(body, res);
    }
  } catch (error) {
    console.error('WillViral API hiba:', error.message);
    return res.status(500).json({
      error: error.message || 'Szerver hiba',
      type: req.body?.type || 'unknown'
    });
  }
};
