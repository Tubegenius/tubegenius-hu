-- Stripe checkout and webhook handlers use the server-only Supabase client.
-- RLS bypass alone does not replace PostgreSQL table privileges: production
-- returned 42501 while persisting a newly-created Stripe customer.

GRANT SELECT, INSERT, UPDATE ON TABLE public.user_credits TO service_role;

