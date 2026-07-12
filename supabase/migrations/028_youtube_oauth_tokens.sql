-- ============================================================
-- Migration 028: YouTube OAuth tokenek (valos Channel Audit alapja)
-- Cel: a Channel Audit ma 100%-ban a user altal kezzel bevitt, AI-ertekelt
--      video_audits sorokra epul, nincs valos YouTube Analytics adat. Ez a
--      tabla tarolja a Google OAuth (Supabase linkIdentity) soran kapott
--      refresh tokent, hogy a szerver kesobb, a user tavolleteben is tudjon
--      friss access tokent kerni a YouTube Analytics API-hoz. A Supabase
--      session provider_refresh_token mezoje csak KOZVETLENUL az OAuth
--      redirekt utan erheto el, nem perzisztalodik automatikusan — ezert
--      kell sajat tablaba menteni azonnal a callback route-ban.
-- ============================================================

CREATE TABLE IF NOT EXISTS youtube_oauth_tokens (
  user_id UUID PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  channel_id TEXT,
  channel_title TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Csak a service_role (lib/youtube-analytics.ts adminClient()) eri el —
-- a refresh token erzekeny adat, sosem megy a bongeszonek.
GRANT ALL ON public.youtube_oauth_tokens TO service_role;

NOTIFY pgrst, 'reload schema';
