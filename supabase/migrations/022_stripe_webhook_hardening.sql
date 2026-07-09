-- ============================================================
-- Migration 022: Stripe webhook hardening
-- Cel: a webhook idempotens legyen (egy Stripe retry ne irjon jova ketszer
--      kreditet), es a kredit-matek atomi legyen (ne veszhessen el update
--      versenyhelyzetben ket kozel egyideju esemenynel).
-- ============================================================

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      TEXT UNIQUE NOT NULL,
  event_type    TEXT NOT NULL,
  -- 'processing' amig a switch fut, 'completed' siker utan, 'failed' hiba
  -- eseten — igy egy Stripe-retry nem probalja ujra vakon a mar egyszer
  -- (akar reszlegesen) feldolgozott esemenyt, ami duplikalt jovairast
  -- okozhatna; a 'failed' allapot helyette kezi kivizsgalast jelez.
  status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_created
  ON stripe_webhook_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status
  ON stripe_webhook_events(status) WHERE status != 'completed';

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Csak a service_role (a webhook admin klienese) fer hozza — usernek nincs
-- oka kozvetlenul olvasni vagy irni ezt a tablat.
GRANT ALL ON stripe_webhook_events TO service_role;

-- ── Atomi kredit-increment RPC-k ────────────────────────────────
-- A korabbi webhook logika select-elte a jelenlegi erteket, majd update-elte
-- azt (read-then-write) — ket kozel egyideju esemeny (pl. gyors egymasutani
-- ket topup vasarlas) igy elveszithetett egy frissitest. Az alabbi
-- fuggvenyek egyetlen atomi UPDATE ... SET x = x + delta utasitassal
-- dolgoznak, amit Postgres soronkent zarol — versenyhelyzetben sem veszhet
-- el increment.
--
-- FONTOS: a user_credits tabla valojaban NEM tartalmaz kulon topup_credits/
-- subscription_credits oszlopot (csak egy kozos "balance"-ot) — az eredeti
-- webhook kod ezekre a nem letezo oszlopokra hivatkozott, tehat egyetlen
-- eles checkout.session.completed/invoice.payment_succeeded esemenyre sem
-- mukodott volna hiba nelkul. Az alabbi fuggvenyek mar a valos "balance"
-- oszlopra irnak.

CREATE OR REPLACE FUNCTION increment_topup_credits(p_user_id UUID, p_delta NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  new_value NUMERIC;
BEGIN
  UPDATE user_credits
  SET balance = COALESCE(balance, 0) + p_delta
  WHERE user_id = p_user_id
  RETURNING balance INTO new_value;

  RETURN new_value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION increment_subscription_credits(p_user_id UUID, p_delta NUMERIC, p_cap NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  new_value NUMERIC;
BEGIN
  UPDATE user_credits
  SET balance = LEAST(COALESCE(balance, 0) + p_delta, p_cap)
  WHERE user_id = p_user_id
  RETURNING balance INTO new_value;

  RETURN new_value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Csak service_role hivhatja — a webhook admin klienssel fut, a userek
-- (authenticated/anon szerepkorok) nem kaphatnak kozvetlen hozzaferest,
-- kulonben barki tetszoleges osszeggel novelhetne a sajat kreditjet.
REVOKE ALL ON FUNCTION increment_topup_credits(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_subscription_credits(UUID, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_topup_credits(UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION increment_subscription_credits(UUID, NUMERIC, NUMERIC) TO service_role;

NOTIFY pgrst, 'reload schema';
