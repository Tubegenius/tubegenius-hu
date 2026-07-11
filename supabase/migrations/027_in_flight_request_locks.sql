-- ============================================================
-- Migration 027: In-flight request lock (Beta Hardening Test fix #1)
-- Cel: a Beta Hardening Test (2026-07-11) elovel megerositette, hogy ket
--      egyideju, azonos tartalmu keres (pl. ket bongeszofulben) MINDKETTO
--      sikeresen lefut es MINDKETTO kulon kreditet von le ugyanazert az
--      erdemi eredmenyert — a chargeFeature() optimista zarolasa csak a
--      balance-mezo konzisztenciajat vedi, nem azt, hogy ket fuggetlenul
--      induló keres ne fusson le ketszer. Ez a tabla egy rovid eletu
--      "foglaltsag" jelzo: mielott egy fizetos route elindítana a dragat
--      AI-hivast, probal egyet beszurni (user_id, tool_type, input_hash)
--      egyedi kulccsal — ha mar letezik, a masodik keres azonnal, AI-hivas
--      es kreditlevonas NELKUL, baratsagos hibat kap.
-- ============================================================

CREATE TABLE IF NOT EXISTS in_flight_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tool_type TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_in_flight_requests_unique
  ON in_flight_requests(user_id, tool_type, input_hash);

-- Gyors takaritas a lejart (elavult, feltehetoen lezuhant hivasbol maradt)
-- lock-okhoz — a lib/request-lock.ts is opportunistan torli ezeket beszuras
-- elott, ez csak vedohalo, ha az soha nem futna.
CREATE INDEX IF NOT EXISTS idx_in_flight_requests_created_at
  ON in_flight_requests(created_at);

-- A tabla csak a service_role kliensen (lib/request-lock.ts adminClient())
-- keresztul erheto el — kifejezett GRANT nelkul a service_role "permission
-- denied for table" hibat ad ra, mert a projekt alapertelmezesben nem ad
-- automatikus jogot uj tablakra.
GRANT ALL ON public.in_flight_requests TO service_role;

NOTIFY pgrst, 'reload schema';
