BEGIN;

CREATE TABLE IF NOT EXISTS public.credit_bucket_migration_backup_037 (
  user_id UUID PRIMARY KEY,
  balance NUMERIC NOT NULL,
  total_used NUMERIC NOT NULL,
  plan TEXT,
  subscription_status TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE public.credit_bucket_migration_backup_037 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.credit_bucket_migration_backup_037 TO service_role;

INSERT INTO public.credit_bucket_migration_backup_037
  (user_id, balance, total_used, plan, subscription_status)
SELECT user_id, COALESCE(balance, 0), COALESCE(total_used, 0), plan, subscription_status
FROM public.user_credits
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE public.user_credits
  ADD COLUMN IF NOT EXISTS subscription_credit_balance NUMERIC,
  ADD COLUMN IF NOT EXISTS purchased_credit_balance NUMERIC;

-- Historical consumption was not bucket-aware, so origin cannot be proven.
-- Preserve every existing credit outside the subscription rollover cap.
UPDATE public.user_credits
SET subscription_credit_balance = 0,
    purchased_credit_balance = GREATEST(COALESCE(balance, 0), 0),
    balance = GREATEST(COALESCE(balance, 0), 0);

ALTER TABLE public.user_credits
  ALTER COLUMN balance SET DEFAULT 0,
  ALTER COLUMN subscription_credit_balance SET DEFAULT 0,
  ALTER COLUMN subscription_credit_balance SET NOT NULL,
  ALTER COLUMN purchased_credit_balance SET DEFAULT 0,
  ALTER COLUMN purchased_credit_balance SET NOT NULL;

ALTER TABLE public.user_credits
  DROP CONSTRAINT IF EXISTS user_credits_subscription_balance_nonnegative,
  DROP CONSTRAINT IF EXISTS user_credits_purchased_balance_nonnegative,
  DROP CONSTRAINT IF EXISTS user_credits_balance_matches_buckets;

ALTER TABLE public.user_credits
  ADD CONSTRAINT user_credits_subscription_balance_nonnegative
    CHECK (subscription_credit_balance >= 0),
  ADD CONSTRAINT user_credits_purchased_balance_nonnegative
    CHECK (purchased_credit_balance >= 0),
  ADD CONSTRAINT user_credits_balance_matches_buckets
    CHECK (balance = subscription_credit_balance + purchased_credit_balance);

ALTER TABLE public.credit_ledger
  ADD COLUMN IF NOT EXISTS credit_bucket TEXT,
  ADD COLUMN IF NOT EXISTS subscription_delta NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchased_delta NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscription_balance_after NUMERIC,
  ADD COLUMN IF NOT EXISTS purchased_balance_after NUMERIC,
  ADD COLUMN IF NOT EXISTS related_transaction_id UUID REFERENCES public.credit_ledger(id) ON DELETE RESTRICT;

UPDATE public.credit_ledger
SET credit_bucket = CASE
      WHEN reason = 'topup_purchase' THEN 'purchased'
      WHEN reason = 'subscription_renewal' THEN 'subscription'
      ELSE 'legacy'
    END,
    subscription_delta = CASE WHEN reason = 'subscription_renewal' THEN delta ELSE 0 END,
    purchased_delta = CASE WHEN reason = 'subscription_renewal' THEN 0 ELSE delta END
WHERE credit_bucket IS NULL;

ALTER TABLE public.credit_ledger
  ALTER COLUMN credit_bucket SET NOT NULL,
  DROP CONSTRAINT IF EXISTS credit_ledger_bucket_check,
  DROP CONSTRAINT IF EXISTS credit_ledger_delta_matches_buckets;

ALTER TABLE public.credit_ledger
  ADD CONSTRAINT credit_ledger_bucket_check
    CHECK (credit_bucket IN ('subscription', 'purchased', 'mixed', 'legacy')),
  ADD CONSTRAINT credit_ledger_delta_matches_buckets
    CHECK (delta = subscription_delta + purchased_delta);

CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_single_refund
  ON public.credit_ledger(related_transaction_id)
  WHERE reason = 'credit_refund';

CREATE OR REPLACE FUNCTION public.sync_credit_balance_from_buckets()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  requested_delta NUMERIC;
  subscription_spend NUMERIC;
  legacy_mutation BOOLEAN := false;
  old_subscription NUMERIC;
  old_purchased NUMERIC;
BEGIN
  NEW.balance := GREATEST(COALESCE(NEW.balance, 0), 0);
  NEW.subscription_credit_balance := GREATEST(COALESCE(NEW.subscription_credit_balance, 0), 0);
  NEW.purchased_credit_balance := GREATEST(COALESCE(NEW.purchased_credit_balance, 0), 0);

  IF TG_OP = 'INSERT' THEN
    IF NEW.subscription_credit_balance + NEW.purchased_credit_balance <> NEW.balance THEN
      IF NEW.subscription_credit_balance = 0 AND NEW.purchased_credit_balance = 0 THEN
        NEW.purchased_credit_balance := NEW.balance;
      ELSE
        NEW.balance := NEW.subscription_credit_balance + NEW.purchased_credit_balance;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Compatibility for the short migration/deploy window and any missed legacy writer.
  IF NEW.balance IS DISTINCT FROM OLD.balance
     AND NEW.subscription_credit_balance = OLD.subscription_credit_balance
     AND NEW.purchased_credit_balance = OLD.purchased_credit_balance THEN
    legacy_mutation := true;
    old_subscription := OLD.subscription_credit_balance;
    old_purchased := OLD.purchased_credit_balance;
    IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       AND NEW.subscription_status = 'active' THEN
      NEW.subscription_credit_balance := GREATEST(COALESCE(NEW.monthly_allowance, 0), 0);
    ELSE
      requested_delta := NEW.balance - OLD.balance;
      IF requested_delta < 0 THEN
        subscription_spend := LEAST(OLD.subscription_credit_balance, -requested_delta);
        NEW.subscription_credit_balance := OLD.subscription_credit_balance - subscription_spend;
        NEW.purchased_credit_balance := OLD.purchased_credit_balance - ((-requested_delta) - subscription_spend);
      ELSIF requested_delta > 0 THEN
        NEW.purchased_credit_balance := OLD.purchased_credit_balance + requested_delta;
      END IF;
    END IF;
  END IF;

  NEW.balance := NEW.subscription_credit_balance + NEW.purchased_credit_balance;
  IF legacy_mutation THEN
    INSERT INTO public.credit_ledger(
      user_id, external_ref, reason, delta, balance_after, metadata, credit_bucket,
      subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after
    ) VALUES (
      NEW.user_id, 'legacy:' || gen_random_uuid()::text, 'legacy_balance_mutation',
      NEW.balance - OLD.balance, NEW.balance,
      jsonb_build_object('source', 'user_credits_compatibility_trigger'),
      CASE
        WHEN NEW.subscription_credit_balance <> old_subscription AND NEW.purchased_credit_balance <> old_purchased THEN 'mixed'
        WHEN NEW.subscription_credit_balance <> old_subscription THEN 'subscription'
        ELSE 'purchased'
      END,
      NEW.subscription_credit_balance - old_subscription,
      NEW.purchased_credit_balance - old_purchased,
      NEW.subscription_credit_balance, NEW.purchased_credit_balance
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_credits_sync_bucket_balance ON public.user_credits;
CREATE TRIGGER user_credits_sync_bucket_balance
BEFORE INSERT OR UPDATE OF balance, subscription_credit_balance, purchased_credit_balance,
  stripe_subscription_id, subscription_status, monthly_allowance
ON public.user_credits
FOR EACH ROW EXECUTE FUNCTION public.sync_credit_balance_from_buckets();

CREATE OR REPLACE FUNCTION public.apply_bucket_credit_event(
  p_user_id UUID,
  p_delta NUMERIC,
  p_bucket TEXT,
  p_cap NUMERIC,
  p_external_ref TEXT,
  p_reason TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.user_credits%ROWTYPE;
  existing_row public.credit_ledger%ROWTYPE;
  new_subscription NUMERIC;
  new_purchased NUMERIC;
  applied_subscription NUMERIC := 0;
  applied_purchased NUMERIC := 0;
  ledger_id UUID;
BEGIN
  IF p_delta <= 0 THEN RAISE EXCEPTION 'credit delta must be positive'; END IF;
  IF p_bucket NOT IN ('subscription', 'purchased') THEN RAISE EXCEPTION 'invalid credit bucket'; END IF;
  IF NULLIF(BTRIM(p_external_ref), '') IS NULL THEN RAISE EXCEPTION 'external ref required'; END IF;

  SELECT * INTO existing_row FROM public.credit_ledger WHERE external_ref = p_external_ref;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'transaction_id', existing_row.id,
      'subscription_delta', existing_row.subscription_delta,
      'purchased_delta', existing_row.purchased_delta,
      'subscription_balance', existing_row.subscription_balance_after,
      'purchased_balance', existing_row.purchased_balance_after,
      'total_balance', existing_row.balance_after,
      'duplicate', true
    );
  END IF;

  SELECT * INTO current_row FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user credit row not found'; END IF;

  SELECT * INTO existing_row FROM public.credit_ledger WHERE external_ref = p_external_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('transaction_id', existing_row.id, 'total_balance', existing_row.balance_after, 'duplicate', true);
  END IF;

  new_subscription := current_row.subscription_credit_balance;
  new_purchased := current_row.purchased_credit_balance;
  IF p_bucket = 'subscription' THEN
    new_subscription := CASE WHEN p_cap IS NULL
      THEN new_subscription + p_delta
      ELSE LEAST(new_subscription + p_delta, p_cap)
    END;
    applied_subscription := new_subscription - current_row.subscription_credit_balance;
  ELSE
    new_purchased := new_purchased + p_delta;
    applied_purchased := p_delta;
  END IF;

  UPDATE public.user_credits
  SET subscription_credit_balance = new_subscription,
      purchased_credit_balance = new_purchased,
      balance = new_subscription + new_purchased
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_ledger(
    user_id, external_ref, reason, delta, balance_after, metadata, credit_bucket,
    subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, p_external_ref, p_reason, applied_subscription + applied_purchased,
    new_subscription + new_purchased, COALESCE(p_metadata, '{}'::jsonb), p_bucket,
    applied_subscription, applied_purchased, new_subscription, new_purchased
  ) RETURNING id INTO ledger_id;

  RETURN jsonb_build_object(
    'transaction_id', ledger_id,
    'subscription_delta', applied_subscription,
    'purchased_delta', applied_purchased,
    'subscription_balance', new_subscription,
    'purchased_balance', new_purchased,
    'total_balance', new_subscription + new_purchased,
    'duplicate', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.spend_credits(
  p_user_id UUID,
  p_cost NUMERIC,
  p_feature TEXT,
  p_external_ref TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.user_credits%ROWTYPE;
  existing_row public.credit_ledger%ROWTYPE;
  subscription_spent NUMERIC;
  purchased_spent NUMERIC;
  new_subscription NUMERIC;
  new_purchased NUMERIC;
  ledger_id UUID;
BEGIN
  IF p_cost <= 0 THEN RAISE EXCEPTION 'credit cost must be positive'; END IF;
  IF NULLIF(BTRIM(p_external_ref), '') IS NULL THEN RAISE EXCEPTION 'external ref required'; END IF;

  SELECT * INTO existing_row FROM public.credit_ledger WHERE external_ref = p_external_ref;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'transaction_id', existing_row.id,
      'subscription_spent', -LEAST(existing_row.subscription_delta, 0),
      'purchased_spent', -LEAST(existing_row.purchased_delta, 0),
      'total_balance', existing_row.balance_after,
      'duplicate', true
    );
  END IF;

  SELECT * INTO current_row FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user credit row not found'; END IF;
  IF current_row.subscription_credit_balance + current_row.purchased_credit_balance < p_cost THEN
    RAISE EXCEPTION 'insufficient credits' USING ERRCODE = 'P0001';
  END IF;

  subscription_spent := LEAST(current_row.subscription_credit_balance, p_cost);
  purchased_spent := p_cost - subscription_spent;
  new_subscription := current_row.subscription_credit_balance - subscription_spent;
  new_purchased := current_row.purchased_credit_balance - purchased_spent;

  UPDATE public.user_credits
  SET subscription_credit_balance = new_subscription,
      purchased_credit_balance = new_purchased,
      balance = new_subscription + new_purchased,
      total_used = COALESCE(total_used, 0) + p_cost
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_ledger(
    user_id, external_ref, reason, delta, balance_after, metadata, credit_bucket,
    subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after
  ) VALUES (
    p_user_id, p_external_ref, 'credit_spend', -p_cost, new_subscription + new_purchased,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('feature', p_feature),
    CASE WHEN subscription_spent > 0 AND purchased_spent > 0 THEN 'mixed'
         WHEN subscription_spent > 0 THEN 'subscription' ELSE 'purchased' END,
    -subscription_spent, -purchased_spent, new_subscription, new_purchased
  ) RETURNING id INTO ledger_id;

  RETURN jsonb_build_object(
    'transaction_id', ledger_id,
    'subscription_spent', subscription_spent,
    'purchased_spent', purchased_spent,
    'subscription_balance', new_subscription,
    'purchased_balance', new_purchased,
    'total_balance', new_subscription + new_purchased,
    'duplicate', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_credit_spend(
  p_user_id UUID,
  p_spend_transaction_id UUID,
  p_external_ref TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  current_row public.user_credits%ROWTYPE;
  spend_row public.credit_ledger%ROWTYPE;
  existing_refund public.credit_ledger%ROWTYPE;
  subscription_refund NUMERIC;
  purchased_refund NUMERIC;
  new_subscription NUMERIC;
  new_purchased NUMERIC;
  ledger_id UUID;
BEGIN
  SELECT * INTO existing_refund
  FROM public.credit_ledger
  WHERE user_id = p_user_id AND reason = 'credit_refund'
    AND related_transaction_id = p_spend_transaction_id;
  IF FOUND THEN
    RETURN jsonb_build_object('transaction_id', existing_refund.id, 'total_balance', existing_refund.balance_after, 'duplicate', true);
  END IF;

  SELECT * INTO current_row FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user credit row not found'; END IF;

  SELECT * INTO spend_row FROM public.credit_ledger
  WHERE id = p_spend_transaction_id AND user_id = p_user_id AND reason = 'credit_spend';
  IF NOT FOUND THEN RAISE EXCEPTION 'credit spend not found'; END IF;

  SELECT * INTO existing_refund
  FROM public.credit_ledger
  WHERE user_id = p_user_id AND reason = 'credit_refund'
    AND related_transaction_id = p_spend_transaction_id;
  IF FOUND THEN
    RETURN jsonb_build_object('transaction_id', existing_refund.id, 'total_balance', existing_refund.balance_after, 'duplicate', true);
  END IF;

  subscription_refund := -LEAST(spend_row.subscription_delta, 0);
  purchased_refund := -LEAST(spend_row.purchased_delta, 0);
  new_subscription := current_row.subscription_credit_balance + subscription_refund;
  new_purchased := current_row.purchased_credit_balance + purchased_refund;

  UPDATE public.user_credits
  SET subscription_credit_balance = new_subscription,
      purchased_credit_balance = new_purchased,
      balance = new_subscription + new_purchased,
      total_used = GREATEST(COALESCE(total_used, 0) - subscription_refund - purchased_refund, 0)
  WHERE user_id = p_user_id;

  INSERT INTO public.credit_ledger(
    user_id, external_ref, reason, delta, balance_after, metadata, credit_bucket,
    subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after,
    related_transaction_id
  ) VALUES (
    p_user_id, p_external_ref, 'credit_refund', subscription_refund + purchased_refund,
    new_subscription + new_purchased, COALESCE(p_metadata, '{}'::jsonb),
    CASE WHEN subscription_refund > 0 AND purchased_refund > 0 THEN 'mixed'
         WHEN subscription_refund > 0 THEN 'subscription' ELSE 'purchased' END,
    subscription_refund, purchased_refund, new_subscription, new_purchased, p_spend_transaction_id
  ) RETURNING id INTO ledger_id;

  RETURN jsonb_build_object(
    'transaction_id', ledger_id,
    'subscription_refund', subscription_refund,
    'purchased_refund', purchased_refund,
    'subscription_balance', new_subscription,
    'purchased_balance', new_purchased,
    'total_balance', new_subscription + new_purchased,
    'duplicate', false
  );
END;
$$;

-- Backward-compatible Stripe RPC during the deploy window.
CREATE OR REPLACE FUNCTION public.apply_credit_event(
  p_user_id UUID, p_delta NUMERIC, p_cap NUMERIC, p_external_ref TEXT,
  p_reason TEXT, p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE result JSONB;
BEGIN
  result := public.apply_bucket_credit_event(
    p_user_id, p_delta,
    CASE WHEN p_reason = 'topup_purchase' THEN 'purchased' ELSE 'subscription' END,
    p_cap, p_external_ref, p_reason, p_metadata
  );
  RETURN (result->>'total_balance')::NUMERIC;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.user_credits
    WHERE balance <> subscription_credit_balance + purchased_credit_balance
       OR balance < 0 OR subscription_credit_balance < 0 OR purchased_credit_balance < 0
  ) THEN
    RAISE EXCEPTION 'credit bucket backfill invariant failed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_bucket_credit_event(UUID, NUMERIC, TEXT, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.spend_credits(UUID, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_credit_spend(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_bucket_credit_event(UUID, NUMERIC, TEXT, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_credits(UUID, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_credit_spend(UUID, UUID, TEXT, JSONB) TO service_role;

-- Audit the conservative backfill without changing any user's total balance.
INSERT INTO public.credit_ledger(
  user_id, external_ref, reason, delta, balance_after, metadata, credit_bucket,
  subscription_delta, purchased_delta, subscription_balance_after, purchased_balance_after
)
SELECT
  uc.user_id,
  'migration:037:' || uc.user_id::text,
  'migration_bucket_backfill',
  0,
  uc.balance,
  jsonb_build_object('rule', 'all_existing_balance_to_purchased', 'backup_table', 'credit_bucket_migration_backup_037'),
  'legacy', 0, 0, uc.subscription_credit_balance, uc.purchased_credit_balance
FROM public.user_credits uc
ON CONFLICT (external_ref) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
