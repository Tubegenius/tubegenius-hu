-- A refresh token kizárólag service_role-lal érhető el. A korábbi tábla
-- grantje önmagában nem volt elég explicit védelem a public sémában.
ALTER TABLE public.youtube_oauth_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.youtube_oauth_tokens FROM anon, authenticated;
GRANT ALL ON TABLE public.youtube_oauth_tokens TO service_role;

NOTIFY pgrst, 'reload schema';
