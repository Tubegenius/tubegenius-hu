-- The API links a saved package to its canonical video idea after insert.
-- Production had INSERT/DELETE access for service_role, but UPDATE was missing,
-- so the compensating rollback deleted every newly saved package.
GRANT UPDATE ON TABLE public.video_packages TO service_role;

NOTIFY pgrst, 'reload schema';
