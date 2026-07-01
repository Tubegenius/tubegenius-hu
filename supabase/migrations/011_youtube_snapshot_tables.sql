-- ============================================================
-- Migration 011: YouTube snapshot adatvagyon — passzív gyűjtés
-- Csak azt mentjük, amit a rendszer amúgy is lekér a YouTube API-ból.
-- Nincs extra API-hívás, nincs külön crawler.
-- ============================================================

-- VIDEÓ IDENTITÁS — egyszer mentve, videónként egy sor
CREATE TABLE IF NOT EXISTS youtube_videos (
  video_id      TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  channel_id    TEXT,
  channel_title TEXT,
  published_at  TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_seen_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel ON youtube_videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_published ON youtube_videos(published_at);

-- VIDEÓ SNAPSHOT — minden lekérdezéskor egy új sor (nézettség idősor)
CREATE TABLE IF NOT EXISTS youtube_video_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
  view_count    BIGINT DEFAULT 0,
  like_count    BIGINT DEFAULT 0,
  comment_count BIGINT DEFAULT 0,
  checked_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yt_video_snapshots_video ON youtube_video_snapshots(video_id);
CREATE INDEX IF NOT EXISTS idx_yt_video_snapshots_checked ON youtube_video_snapshots(checked_at);

-- CSATORNA IDENTITÁS — passzívan a videó snippetekből (channelId/channelTitle),
-- nincs külön channels.list hívás, tehát csak azonosító adat, nem subscriber-szám.
CREATE TABLE IF NOT EXISTS youtube_channels (
  channel_id    TEXT PRIMARY KEY,
  channel_title TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_seen_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- CSATORNA SNAPSHOT — séma előkészítve, egyelőre nincs írás rá
-- (subscriber/összesített csatorna-statisztika lekéréséhez külön API hívás kellene,
-- ami nem passzív — ezt tudatosan NEM implementáljuk most).
CREATE TABLE IF NOT EXISTS youtube_channel_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        TEXT NOT NULL REFERENCES youtube_channels(channel_id) ON DELETE CASCADE,
  subscriber_count  BIGINT,
  video_count       BIGINT,
  view_count        BIGINT,
  checked_at        TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_yt_channel_snapshots_channel ON youtube_channel_snapshots(channel_id);

-- TREND CANDIDATES — a Trend Radar/Opportunity Engine kiértékelt jelöltjei,
-- passzívan mentve (ugyanaz az adat, ami amúgy is kiszámolódik és cache-elődik).
CREATE TABLE IF NOT EXISTS trend_candidates (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_topic        TEXT NOT NULL,
  category               TEXT,
  region                 TEXT,
  trend_source_type      TEXT,
  confidence             TEXT,
  opportunity_type       TEXT,
  relevance_average      NUMERIC,
  freshness_score        NUMERIC,
  seed_keyword           TEXT,
  market_type            TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trend_candidates_created ON trend_candidates(created_at);
CREATE INDEX IF NOT EXISTS idx_trend_candidates_category ON trend_candidates(category);

-- TOPIC CLUSTERS — séma előkészítve jövőbeli klaszterezéshez.
-- Jelenleg nincs klaszterező logika a kódban, ezért egyelőre nem íródik.
CREATE TABLE IF NOT EXISTS topic_clusters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_label TEXT NOT NULL,
  niche         TEXT,
  region        TEXT,
  topic_ids     JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ── RLS — csak service_role írhat/olvashat, user-nek nincs közvetlen elérése ──

ALTER TABLE youtube_videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE youtube_video_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE youtube_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE youtube_channel_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE trend_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_clusters ENABLE ROW LEVEL SECURITY;

GRANT ALL ON youtube_videos TO service_role;
GRANT ALL ON youtube_video_snapshots TO service_role;
GRANT ALL ON youtube_channels TO service_role;
GRANT ALL ON youtube_channel_snapshots TO service_role;
GRANT ALL ON trend_candidates TO service_role;
GRANT ALL ON topic_clusters TO service_role;

NOTIFY pgrst, 'reload schema';
