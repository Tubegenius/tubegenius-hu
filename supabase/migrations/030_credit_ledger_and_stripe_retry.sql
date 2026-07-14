CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  external_ref TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  delta NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "credit_ledger_select_own" ON public.credit_ledger
  FOR SELECT USING (auth.uid() = user_id);
GRANT ALL ON public.credit_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.apply_credit_event(
  p_user_id UUID, p_delta NUMERIC, p_cap NUMERIC, p_external_ref TEXT,
  p_reason TEXT, p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE new_value NUMERIC; inserted_id UUID;
BEGIN
  IF p_delta <= 0 THEN RAISE EXCEPTION 'credit delta must be positive'; END IF;
  SELECT balance_after INTO new_value FROM public.credit_ledger WHERE external_ref = p_external_ref;
  IF FOUND THEN RETURN new_value; END IF;

  SELECT CASE WHEN p_cap IS NULL THEN COALESCE(balance, 0) + p_delta
    ELSE LEAST(COALESCE(balance, 0) + p_delta, p_cap) END
  INTO new_value FROM public.user_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user credit row not found'; END IF;

  INSERT INTO public.credit_ledger(user_id, external_ref, reason, delta, balance_after, metadata)
  VALUES (p_user_id, p_external_ref, p_reason, p_delta, new_value, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (external_ref) DO NOTHING RETURNING id INTO inserted_id;
  IF inserted_id IS NULL THEN
    SELECT balance_after INTO new_value FROM public.credit_ledger WHERE external_ref = p_external_ref;
    RETURN new_value;
  END IF;
  UPDATE public.user_credits SET balance = new_value WHERE user_id = p_user_id;
  RETURN new_value;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_credit_event(UUID, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_credit_event(UUID, NUMERIC, NUMERIC, TEXT, TEXT, JSONB) TO service_role;
NOTIFY pgrst, 'reload schema';
