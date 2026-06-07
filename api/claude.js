// ============================================================
// WillViral — api/claude.js v3.0
// ============================================================

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const YT_API = 'https://www.googleapis.com/youtube/v3';
const MODEL = 'claude-sonnet-4-6';

// ── Cache ──────────────────────────────────────────────────
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

// ── Helpers ────────────────────────────────────────────────
function fmt(n) { return parseInt(n || 0); }
function formatViews(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}
function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}
function parseDuration(duration) {
  const m = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}
function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}
function videoIsShorts(url, duration) {
  return url?.includes('/shorts/') || duration <= 60;
}

// ── Confidence számítás ────────────────────────────────────
function getConfidence(videoCount) {
  if (videoCount >= 30) return { szint: 'Magas', dots: 4, color: '#22C55E' };
  if (videoCount >= 10) return { szint: 'Közepes', dots: 3, color: '#F59E0B' };
  if (videoCount >= 5)  return { szint: 'Alacsony', dots: 2, color: '#F97316' };
  return { szint: 'Nagyon alacsony', dots: 1, color: '#EF4444' };
}

// ── CORS ───────────────────────────────────────────────────
function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── YouTube API ────────────────────────────────────────────
async function ytFetch(endpoint, params) {
  const url = new URL(`${YT_API}/${endpoint}`);
  url.searchParams.set('key', process.env.YT_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`YouTube API hiba: ${res.status}`);
  return res.json();
}

// ── Claude API ─────────────────────────────────────────────
async function claudeFetch(messages, maxTokens = 4000, systemPrompt = null) {
  const body = { model: MODEL, max_tokens: maxTokens, messages };
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
  if (!res.ok) throw new Error(`Claude API hiba: ${await res.text()}`);
  const data = await res.json();
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  return {
    text: data.content?.[0]?.text || '',
    inputTokens,
    outputTokens,
    costUsd: (inputTokens * 3 + outputTokens * 15) / 1_000_000
  };
}

// ── Master System Prompt ───────────────────────────────────
const MASTER_PROMPT = `Te a WillViral Creator Intelligence Platform AI motorja vagy.

SZEMÉLYISÉGED:
Tapasztalt creator barát vagy, nem AI asszisztens.
Rövid, tömör mondatok. Magyar köznyelv. Közvetlen hangnem.

TILOS: "kiemelkedő", "hatékony", "stratégiai", "optimális",
"komprehenzív", "innovatív", körülírás, AI szagú megfogalmazás.

KÖTELEZŐ: konkrét számok, emberi hangnem, rövid mondatok.

ADATKEZELÉS:
- CSAK a backend által átadott valós YouTube adatokat használd
- Ha nincs adat: mondd meg őszintén, NE becsülj
- A Viral Score-t a BACKEND számolta, te csak magyarázod
- Soha ne írj felül backend adatot

FŐ KÉRDÉS: "Érdemes-e egyáltalán erről videót készítened?"`;

// ── Viral Score számítás (backend!) ───────────────────────
function calculateViralScore(searchData) {
  const { avgViews, avgLikes, videoCount, freshRatio, uploadVelocity } = searchData;

  let viewsPotential = 0;
  if (avgViews >= 1_000_000) viewsPotential = 30;
  else if (avgViews >= 500_000) viewsPotential = 25;
  else if (avgViews >= 100_000) viewsPotential = 20;
  else if (avgViews >= 50_000) viewsPotential = 14;
  else if (avgViews >= 10_000) viewsPotential = 8;
  else if (avgViews >= 1_000) viewsPotential = 4;
  else viewsPotential = 1;

  let trendScore = 0;
  const freshPct = freshRatio || 0;
  if (freshPct >= 60) trendScore = 22;
  else if (freshPct >= 40) trendScore = 16;
  else if (freshPct >= 20) trendScore = 10;
  else trendScore = 4;
  const vel = uploadVelocity || 0;
  if (vel >= 50) trendScore = Math.min(25, trendScore + 3);
  else if (vel >= 20) trendScore = Math.min(25, trendScore + 2);
  else if (vel >= 5) trendScore = Math.min(25, trendScore + 1);

  let competitionScore = 0;
  if (videoCount <= 5) competitionScore = 20;
  else if (videoCount <= 20) competitionScore = 16;
  else if (videoCount <= 50) competitionScore = 12;
  else if (videoCount <= 100) competitionScore = 8;
  else if (videoCount <= 200) competitionScore = 4;
  else competitionScore = 2;

  let engagementScore = 0;
  const likeRatio = avgViews > 0 ? avgLikes / avgViews : 0;
  if (likeRatio >= 0.05) engagementScore = 15;
  else if (likeRatio >= 0.03) engagementScore = 11;
  else if (likeRatio >= 0.01) engagementScore = 7;
  else if (likeRatio >= 0.005) engagementScore = 3;
  else engagementScore = 1;

  const searchInterest = 5;
  const total = viewsPotential + trendScore + competitionScore + engagementScore + searchInterest;
  const score = Math.min(100, Math.max(1, Math.round(total)));

  let szint = 'Gyenge';
  if (score >= 80) szint = 'Erős';
  else if (score >= 60) szint = 'Jó';
  else if (score >= 40) szint = 'Közepes';

  return { viralScore: score, szint, komponensek: { viewsPotential, trendScore, competitionScore, engagementScore, searchInterest } };
}

// ── YouTube Search ─────────────────────────────────────────
async function youtubeSearch(query, regionCode = 'HU', maxResults = 10) {
  const cacheKey = `search_${query}_${regionCode}_${maxResults}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const lang = regionCode === 'HU' ? 'hu' : 'en';
  const searchData = await ytFetch('search', {
    q: query, part: 'snippet', type: 'video',
    maxResults, regionCode, relevanceLanguage: lang, order: 'relevance'
  });

  if (!searchData.items?.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, videoCount: 0, freshRatio: 0, uploadVelocity: 0, topVideos: [] };
  }

  const videoIds = searchData.items.map(i => i.id?.videoId).filter(Boolean);
  const publishDates = searchData.items.map(i => i.snippet?.publishedAt).filter(Boolean);
  const statsData = await ytFetch('videos', { id: videoIds.join(','), part: 'statistics,snippet,contentDetails' });

  if (!statsData.items?.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, videoCount: 0, freshRatio: 0, uploadVelocity: 0, topVideos: [] };
  }

  const views = statsData.items.map(v => fmt(v.statistics?.viewCount));
  const likes = statsData.items.map(v => fmt(v.statistics?.likeCount));
  const comments = statsData.items.map(v => fmt(v.statistics?.commentCount));
  const avgViews = Math.round(views.reduce((a, b) => a + b, 0) / views.length);
  const avgLikes = Math.round(likes.reduce((a, b) => a + b, 0) / likes.length);
  const avgComments = Math.round(comments.reduce((a, b) => a + b, 0) / comments.length);
  const freshCount = publishDates.filter(d => daysSince(d) <= 7).length;
  const freshRatio = Math.round((freshCount / publishDates.length) * 100);
  const uploadVelocity = freshCount;

  const topVideos = statsData.items.slice(0, 6).map(v => {
    const duration = parseDuration(v.contentDetails?.duration || '');
    const isShorts = videoIsShorts('', duration);
    return {
      videoId: v.id,
      title: v.snippet?.title || '',
      channel: v.snippet?.channelTitle || '',
      views: fmt(v.statistics?.viewCount),
      viewsFormatted: formatViews(fmt(v.statistics?.viewCount)),
      likes: fmt(v.statistics?.likeCount),
      comments: fmt(v.statistics?.commentCount),
      thumbnail: v.snippet?.thumbnails?.medium?.url || '',
      url: `https://youtube.com/watch?v=${v.id}`,
      publishedAt: v.snippet?.publishedAt,
      daysSince: daysSince(v.snippet?.publishedAt),
      isShorts,
      region: regionCode
    };
  });

  const result = { avgViews, avgLikes, avgComments, videoCount: statsData.items.length, freshRatio, uploadVelocity, topVideos, regionCode };
  cacheSet(cacheKey, result, 6 * 60 * 60 * 1000);
  return result;
}

// ── VÉGPONTOK ──────────────────────────────────────────────

// 1. youtube — egyetlen videó
async function handleYoutube(body, res) {
  const { videoId } = body;
  if (!videoId) return res.status(400).json({ error: 'videoId kötelező' });
  const cacheKey = `video_${videoId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);
  const data = await ytFetch('videos', { id: videoId, part: 'snippet,statistics,contentDetails' });
  if (!data.items?.length) return res.status(404).json({ error: 'Videó nem található' });
  cacheSet(cacheKey, data.items[0], 6 * 60 * 60 * 1000);
  return res.status(200).json(data.items[0]);
}

// 2. youtube_search — téma keresés
async function handleYoutubeSearch(body, res) {
  const { searchQuery, regionCode = 'HU', maxResults = 10 } = body;
  if (!searchQuery) return res.status(400).json({ error: 'searchQuery kötelező' });
  const data = await youtubeSearch(searchQuery, regionCode, maxResults);
  return res.status(200).json(data);
}

// 3. onboarding_suggestions — YouTube alapú téma javaslatok
async function handleOnboardingSuggestions(body, res) {
  const { niche, regionCode = 'HU' } = body;
  if (!niche) return res.status(400).json({ error: 'niche kötelező' });
  const cacheKey = `onboard_${niche}_${regionCode}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);

  const data = await youtubeSearch(niche, regionCode, 5);
  const suggestions = (data.topVideos || []).slice(0, 3).map(v => ({
    title: v.title,
    views: v.viewsFormatted,
    thumbnail: v.thumbnail,
    url: v.url,
    channel: v.channel
  }));

  const result = { suggestions, niche, regionCode };
  cacheSet(cacheKey, result, 3 * 60 * 60 * 1000);
  return res.status(200).json(result);
}

// 4. viral_score_full — teljes Viral Score flow
async function handleViralScoreFull(body, res) {
  const { query, regionCode = 'HU', mode = 'hu', creatorProfile = {} } = body;
  if (!query) return res.status(400).json({ error: 'query kötelező' });

  let searchData, globalData = null;
  if (mode === 'both') {
    const [hu, global] = await Promise.all([
      youtubeSearch(query, 'HU'),
      youtubeSearch(query, 'US')
    ]);
    searchData = hu;
    globalData = global;
  } else {
    searchData = await youtubeSearch(query, regionCode);
  }

  const scoreResult = calculateViralScore(searchData);
  let globalScoreResult = null;
  if (globalData) globalScoreResult = calculateViralScore(globalData);

  // Confidence
  const confidence = getConfidence(searchData.videoCount);

  // pytrends (silent fallback)
  try {
    const trendRes = await fetch(`/api/trends?q=${encodeURIComponent(query)}&geo=${regionCode}`);
    if (trendRes.ok) {
      const td = await trendRes.json();
      const bonus = td.score || 0;
      scoreResult.viralScore = Math.min(100, scoreResult.viralScore + bonus);
      scoreResult.komponensek.searchInterest = Math.min(10, 5 + bonus);
    }
  } catch { /* silent */ }

  const dataContext = `
VALÓS YOUTUBE ADATOK (${regionCode === 'HU' ? 'Magyar' : 'Globális'} adatbázis):
- Viral Score: ${scoreResult.viralScore}/100 (${scoreResult.szint})
- Confidence: ${confidence.szint} (${searchData.videoCount} videó alapján)
- Átlag nézettség: ${searchData.avgViews.toLocaleString()}
- Átlag like: ${searchData.avgLikes.toLocaleString()}
- Hasonló videók száma: ${searchData.videoCount}
- Friss tartalom arány (7 nap): ${searchData.freshRatio}%
- Feltöltési sebesség: ${searchData.uploadVelocity} videó/hét
${globalScoreResult ? `\nGLOBÁLIS ADATOK:\n- Score: ${globalScoreResult.viralScore}/100\n- Átlag nézettség: ${globalData.avgViews.toLocaleString()}` : ''}`;

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `${dataContext}

CREATOR PROFIL: ${creatorProfile.niche || 'általános'} / ${creatorProfile.platform || 'YouTube'} / ${creatorProfile.audience?.join(', ') || 'általános'}

FELADAT: Max 3-4 rövid mondat emberi hangon.
Mondd meg konkrétan: megéri-e erről videót csinálni.
Hivatkozz a számokra. Rövid mondatok. Magyar köznyelv.
Csak a magyarázatot írd, semmi mást.`
  }], 400, MASTER_PROMPT);

  const topVideos = mode === 'both'
    ? [
        ...searchData.topVideos.slice(0, 3).map(v => ({ ...v, region: 'hu' })),
        ...(globalData?.topVideos || []).slice(0, 3).map(v => ({ ...v, region: 'global' }))
      ]
    : searchData.topVideos;

  return res.status(200).json({
    viralScore: scoreResult.viralScore,
    szint: scoreResult.szint,
    komponensek: scoreResult.komponensek,
    confidence,
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
    globalSzint: globalScoreResult?.szint || null,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 5. trending — Trend Radar
async function handleTrending(body, res) {
  const { regionCode = 'HU', categoryId = '0' } = body;
  const cacheKey = `trending_${regionCode}_${categoryId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json({ videos: cached });

  const data = await ytFetch('videos', {
    chart: 'mostPopular', regionCode, videoCategoryId: categoryId,
    maxResults: 12, part: 'snippet,statistics,contentDetails'
  });

  const videos = (data.items || []).map(v => {
    const duration = parseDuration(v.contentDetails?.duration || '');
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
      isShorts: duration <= 60,
      region: regionCode
    };
  });

  cacheSet(cacheKey, videos, 60 * 60 * 1000);
  return res.status(200).json({ videos });
}

// 6. script_extract — Script kinyerés
async function handleScriptExtract(body, res) {
  const { url } = body;
  if (!url) return res.status(400).json({ error: 'url kötelező' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Érvénytelen YouTube URL' });

  const isShorts = url.includes('/shorts/');

  // Videó adatok
  const ytData = await ytFetch('videos', { id: videoId, part: 'snippet,statistics,contentDetails' });
  if (!ytData.items?.length) return res.status(404).json({ error: 'Videó nem található' });

  const video = ytData.items[0];
  const sn = video.snippet;
  const duration = parseDuration(video.contentDetails?.duration || '');

  // Transcript próbálkozás YouTube captions API nélkül
  // A leírásból kivonjuk ami használható
  const description = sn.description || '';
  const hasTranscript = description.length > 200;

  // Ha van részletes leírás: azt adjuk vissza strukturáltan
  // Ha nincs: jelezzük
  if (!hasTranscript) {
    return res.status(200).json({
      videoInfo: {
        videoId,
        title: sn.title,
        channel: sn.channelTitle,
        thumbnail: sn.thumbnails?.medium?.url || '',
        duration,
        isShorts,
        url: `https://youtube.com/watch?v=${videoId}`
      },
      transcript: null,
      message: 'Ehhez a videóhoz nem érhető el szöveges tartalom. Próbálj egy másik videót!',
      hasTranscript: false
    });
  }

  // Claude strukturálja a leírást
  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `VIDEÓ ADATOK:
Cím: ${sn.title}
Csatorna: ${sn.channelTitle}
Típus: ${isShorts ? 'Shorts' : 'Long form'}
Hossz: ${Math.round(duration / 60)} perc

LEÍRÁS (ez az elérhető szöveges tartalom):
${description.substring(0, 2000)}

FELADAT: Strukturáld ezt a tartalmat tiszta szöveggé.
Adj vissza egy másolható szöveget ami a videó fő mondanivalóját tartalmazza.
Emberi hangon, tömören. Max 400 szó.
NE adj formázást, NE adj magyarázatot — csak a tiszta szöveget.`
  }], 600, MASTER_PROMPT);

  return res.status(200).json({
    videoInfo: {
      videoId,
      title: sn.title,
      channel: sn.channelTitle,
      thumbnail: sn.thumbnails?.medium?.url || '',
      views: fmt(video.statistics?.viewCount),
      duration,
      isShorts,
      url: `https://youtube.com/watch?v=${videoId}`
    },
    transcript: text,
    hasTranscript: true,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 7. video_inspect — Video Inspector (volt Analyzer)
async function handleVideoInspect(body, res) {
  const { url, creatorProfile = {} } = body;
  if (!url) return res.status(400).json({ error: 'url kötelező' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Érvénytelen YouTube URL' });

  const isShorts = url.includes('/shorts/');
  const ytData = await ytFetch('videos', { id: videoId, part: 'snippet,statistics,contentDetails' });
  if (!ytData.items?.length) return res.status(404).json({ error: 'Videó nem található' });

  const video = ytData.items[0];
  const sn = video.snippet;
  const st = video.statistics;
  const views = fmt(st.viewCount);
  const likes = fmt(st.likeCount);
  const comments = fmt(st.commentCount);
  const likeRatio = views > 0 ? ((likes / views) * 100).toFixed(2) : 0;

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `VIDEÓ METAADATOK (cím + leírás + tagek alapján dolgozom, NEM a videó képi/hang tartalma):
Cím: ${sn.title}
Csatorna: ${sn.channelTitle}
Típus: ${isShorts ? 'YouTube Shorts' : 'YouTube videó'}
Nézettség: ${views.toLocaleString()}
Like: ${likes.toLocaleString()} (${likeRatio}% arány)
Komment: ${comments.toLocaleString()}
Feltöltve: ${daysSince(sn.publishedAt)} napja
Leírás (első 600 kar): ${(sn.description || '').substring(0, 600)}
Tagek: ${(sn.tags || []).slice(0, 10).join(', ')}

CREATOR PROFIL: ${creatorProfile.niche || 'általános'}

FELADAT: Elemezd ezt a videót a metaadatok alapján. Csak JSON:
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
  "osszes_ertekeles": "2-3 mondat összefoglaló",
  "legfobb_tanacs": "egyetlen legfontosabb tanács",
  "javitott_cimek": ["jobb cím 1", "jobb cím 2", "jobb cím 3"]
}
Csak JSON, semmi más.`
  }], 1500, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean.substring(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    videoInfo: {
      videoId, title: sn.title, channel: sn.channelTitle,
      thumbnail: sn.thumbnails?.medium?.url || '',
      views, likes, comments, likeRatio,
      publishedAt: sn.publishedAt,
      daysSince: daysSince(sn.publishedAt),
      isShorts, url: `https://youtube.com/watch?v=${videoId}`
    },
    audit: parsed,
    disclaimer: 'Az elemzés a videó metaadatai (cím, leírás, tagek) alapján készült.',
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 8. content_gap — Content Gap Analysis
async function handleContentGap(body, res) {
  const { topic, regionCode = 'HU', creatorProfile = {} } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  const searchData = await youtubeSearch(topic, regionCode, 10);
  const topVideos = searchData.topVideos.slice(0, 6);

  if (!topVideos.length) return res.status(200).json({ error: 'Nem találhatók videók' });

  const videoList = topVideos.map((v, i) =>
    `${i+1}. "${v.title}" — ${v.channel} (${v.viewsFormatted}, ${v.daysSince} napja)`
  ).join('\n');

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `TOP VIDEÓK (valós YouTube adatok — cím és csatorna alapján elemzem):
${videoList}

CREATOR PROFIL: ${creatorProfile.niche || topic} / ${creatorProfile.audience?.join(', ') || 'általános'}

FELADAT: Mit dolgoznak fel és mit NEM? Csak JSON:
{
  "mit_mondanak": ["3-5 leggyakoribb nézőpont"],
  "mit_nem_mondanak": ["3-5 hiányzó nézőpont"],
  "ajanlott_iranyok": [
    {"cim": "Videó cím javaslat", "indok": "Miért hiányzik"},
    {"cim": "Videó cím javaslat 2", "indok": "Miért hiányzik"},
    {"cim": "Videó cím javaslat 3", "indok": "Miért hiányzik"}
  ],
  "legjobb_szog": "Egyetlen legjobb feldolgozatlan szög",
  "osszes_elemzes": "2-3 mondatos összefoglaló"
}
Csak JSON, semmi más.`
  }], 1200, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean.substring(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    topVideos,
    gap: parsed,
    disclaimer: 'Az elemzés a videók címe és leírása alapján készült — nem teljes videóelemzés.',
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 9. content_generate — Content Generator
async function handleContentGenerate(body, res) {
  const { topic, length = 'medium', tone = 'informativ', regionCode = 'HU', creatorProfile = {} } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  const searchData = await youtubeSearch(topic, regionCode);
  const scoreResult = calculateViralScore(searchData);

  const lenMap = { short: 'Shorts (30-60 mp)', medium: 'Közepes (2-5 perc)', long: 'Hosszú (8-15 perc)' };
  const toneMap = { megdobbento: 'megdöbbentő', informativ: 'informatív', vicces: 'vicces', komoly: 'komoly', motivalo: 'motiváló' };

  const platforms = Array.isArray(creatorProfile.platform)
    ? creatorProfile.platform.join(', ')
    : (creatorProfile.platform || 'YouTube, TikTok, Instagram, Facebook');

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `YOUTUBE ADATOK:
${searchData.videoCount} hasonló videó, átlag nézettség: ${searchData.avgViews.toLocaleString()}
Viral Score: ${scoreResult.viralScore}/100 (${scoreResult.szint})

CREATOR PROFIL:
- Niche: ${creatorProfile.niche || 'általános'}
- Célközönség: ${Array.isArray(creatorProfile.audience) ? creatorProfile.audience.join(', ') : (creatorProfile.audience || 'általános')}
- Stílus: ${Array.isArray(creatorProfile.style) ? creatorProfile.style.join(', ') : (creatorProfile.style || toneMap[tone])}
- Cél: ${Array.isArray(creatorProfile.goal) ? creatorProfile.goal.join(', ') : (creatorProfile.goal || 'nézettség')}
- Tapasztalat: ${creatorProfile.experience || 'haladó'}

GENERÁLÁSI PARAMÉTEREK:
- Téma: ${topic}
- Hossz: ${lenMap[length] || lenMap.medium}
- Hangvétel: ${toneMap[tone] || 'informatív'}
- Platformok: ${platforms}
- Dátum: ${new Date().toLocaleDateString('hu-HU')}

FELADAT: Generálj tartalomcsomagot. Csak JSON:
{
  "cimek": ["cím1","cím2","cím3","cím4","cím5"],
  "youtube_leiras": "SEO leírás 150-200 szóban",
  "tiktok_caption": "TikTok caption hashtagekkel",
  "instagram_caption": "Instagram caption",
  "facebook_post": "Facebook poszt",
  "tagek": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10"],
  "thumbnail_szoveg": "THUMBNAIL FŐ SZÖVEG",
  "thumbnail_tip": "Design tipp egy mondatban",
  "feltoltes_youtube": {
    "hetfo": "10:00", "kedd": "—", "szerda": "18:00",
    "csutortok": "—", "pentek": "17:00", "szombat": "—", "vasarnap": "12:00"
  },
  "feltoltes_tiktok": {
    "hetfo": "19:00", "kedd": "20:00", "szerda": "—",
    "csutortok": "19:00", "pentek": "20:00", "szombat": "15:00", "vasarnap": "—"
  },
  "feltoltes_instagram": {
    "hetfo": "—", "kedd": "12:00", "szerda": "18:00",
    "csutortok": "—", "pentek": "17:00", "szombat": "11:00", "vasarnap": "—"
  },
  "feltoltes_facebook": {
    "hetfo": "13:00", "kedd": "—", "szerda": "13:00",
    "csutortok": "—", "pentek": "13:00", "szombat": "—", "vasarnap": "15:00"
  }
}
Csak JSON, semmi más.`
  }], 3000, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean.substring(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    viralScore: scoreResult.viralScore,
    szint: scoreResult.szint,
    confidence: getConfidence(searchData.videoCount),
    topVideos: searchData.topVideos,
    searchData: { avgViews: searchData.avgViews, videoCount: searchData.videoCount },
    tartalom: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 10. video_package — Video Package Generator
async function handleVideoPackage(body, res) {
  const { topic, baseScript = '', length = 'medium', platform = 'youtube', creatorProfile = {}, viralScoreData = null } = body;
  if (!topic) return res.status(400).json({ error: 'topic kötelező' });

  const isShorts = length === 'short';
  const struktura = isShorts
    ? 'Hook (0-3mp), Tartalom (3-50mp), CTA (50-60mp)'
    : length === 'long'
      ? 'Hook (0-30mp), Intro (30mp-2p), Főtartalom (2p-12p), CTA+Outro (12p-13p)'
      : 'Hook (0-30mp), Intro (30mp-1p), Főtartalom (1p-4p), CTA+Outro (4p-5p)';

  const viralContext = viralScoreData
    ? `VIRAL SCORE ADATOK: ${viralScoreData.viralScore}/100 (${viralScoreData.szint}), átlag nézettség: ${viralScoreData.avgViews?.toLocaleString()}`
    : '';

  const scriptContext = baseScript
    ? `\nALAP SCRIPT (ezt alakítsd át a creator profil alapján):\n${baseScript.substring(0, 2000)}`
    : '';

  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch([{
    role: 'user',
    content: `${viralContext}${scriptContext}

CREATOR PROFIL:
- Platform: ${platform}
- Niche: ${creatorProfile.niche || 'általános'}
- Célközönség: ${Array.isArray(creatorProfile.audience) ? creatorProfile.audience.join(', ') : (creatorProfile.audience || 'általános')}
- Stílus: ${Array.isArray(creatorProfile.style) ? creatorProfile.style.join(', ') : (creatorProfile.style || 'informatív')}
- Tapasztalat: ${creatorProfile.experience || 'haladó'}
- Cél: ${Array.isArray(creatorProfile.goal) ? creatorProfile.goal.join(', ') : (creatorProfile.goal || 'nézettség')}

VIDEÓ PARAMÉTEREK:
- Téma: ${topic}
- Hossz: ${isShorts ? 'Shorts (60 mp)' : length === 'long' ? 'Hosszú (10-15 perc)' : 'Közepes (3-8 perc)'}
- Struktúra: ${struktura}

FELADAT: Generálj teljes videócsomagot. Csak JSON:
{
  "jelenetek": [
    {
      "sorszam": 1,
      "ido": "0-3 mp",
      "nev": "Hook",
      "narracio": "Szöveg",
      "vizual": "Mit mutat",
      "broll": "B-roll javaslat",
      "grafika": "Felirat/overlay"
    }
  ],
  "teljes_narracio": "Az összes jelenet narrációja egyben",
  "ossz_hossz": "Becsült hossz"
}
${isShorts ? '3 jelenet: Hook, Tartalom, CTA' : length === 'long' ? '7-8 jelenet részletesen' : '5-6 jelenet'}
Csak JSON, semmi más.`
  }], 5000, MASTER_PROMPT);

  let parsed;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean.substring(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
  } catch {
    return res.status(500).json({ error: 'Claude válasz feldolgozási hiba' });
  }

  return res.status(200).json({
    csomag: parsed,
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// 11. claude — általános (visszafelé kompatibilis)
async function handleClaude(body, res) {
  const { messages, maxTokens = 4000 } = body;
  if (!messages) return res.status(400).json({ error: 'messages kötelező' });
  const { text, inputTokens, outputTokens, costUsd } = await claudeFetch(messages, maxTokens, MASTER_PROMPT);
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
    if (s !== -1 && e !== -1) {
      return res.status(200).json({
        content: [{ type: 'text', text: JSON.stringify(JSON.parse(clean.substring(s, e+1))) }],
        _cost: { inputTokens, outputTokens, costUsd }
      });
    }
  } catch {}
  return res.status(200).json({
    content: [{ type: 'text', text }],
    _cost: { inputTokens, outputTokens, costUsd }
  });
}

// ── FŐ HANDLER ─────────────────────────────────────────────
module.exports = async (req, res) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    switch (body.type) {
      case 'youtube':                return await handleYoutube(body, res);
      case 'youtube_search':         return await handleYoutubeSearch(body, res);
      case 'onboarding_suggestions': return await handleOnboardingSuggestions(body, res);
      case 'viral_score_full':       return await handleViralScoreFull(body, res);
      case 'trending':               return await handleTrending(body, res);
      case 'script_extract':         return await handleScriptExtract(body, res);
      case 'video_inspect':          return await handleVideoInspect(body, res);
      case 'video_audit':            return await handleVideoInspect(body, res);
      case 'content_gap':            return await handleContentGap(body, res);
      case 'content_generate':       return await handleContentGenerate(body, res);
      case 'video_package':          return await handleVideoPackage(body, res);
      case 'claude':
      default:                       return await handleClaude(body, res);
    }
  } catch (error) {
    console.error('WillViral API hiba:', error.message);
    return res.status(500).json({ error: error.message || 'Szerver hiba' });
  }
};
