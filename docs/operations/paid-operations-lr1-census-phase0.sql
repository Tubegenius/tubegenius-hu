-- ============================================================================
-- LR-1 census, 0. szakasz (generacios tabla nelkul) -- v3 -- ELOKESZITVE, NEM FUTTATVA
--
-- STATUS : prepared text only. It has NOT been executed against any database
--          (not on staging either). Running it needs a separate, explicit,
--          phase-by-phase approval bound to the SHA-256 of this exact file
--          AND to the approved target (see "TARGET IDENTITY" below).
-- SCOPE  : read-only, aggregate-only. No row identifier, no user input text,
--          no secret is selected or printed.
-- FAIL CLOSED (v3):
--   * Q0 and Q0b are real gates, not comments. Each one is a DO block that
--     raises an exception when its condition is not met. The script is run
--     with ON_ERROR_STOP=1, so psql stops at the first error and exits with a
--     non-zero status; the transaction is then aborted and every later
--     statement would fail with "current transaction is aborted", so no census
--     query can return rows after a failed guard. The runner treats ANY error
--     or non-zero exit status as "discard everything that was printed".
--   * Q0b requires EXACTLY 10 columns (5 of paid_results, 5 of credit_ledger),
--     in tables of type BASE TABLE in schema public; fewer or more -> error.
-- FIXED VOCABULARIES (v3):
--   * tool_type and status are NEVER printed from the data column. They are
--     printed from fixed vocabulary tables inside this file (the 17 tool_type
--     values of the CHECK constraint of migration 026, and the 4 status values
--     of migration 019). Any other value is counted under '(other)'; a NULL
--     status under '(null)'. A value outside the vocabulary therefore cannot
--     reach the output, whatever the data contains.
-- SMALL-CELL PROTECTION (in the query output itself):
--   * No exact count leaves the database. Every count is replaced by a
--     magnitude bucket: '0', '<5', '5-9', '10-49', '50-99', '100-499',
--     '500-999', '1000-9999', '10000-99999', '100000+'.
--   * The same bucket table is used by every query, so a bucket never reveals
--     more than the '<5' class does.
--   * Differencing: no query prints a total next to its parts. Q1 (status
--     counts) and Q2 (the same non-completed rows by quarter) are bucketed
--     independently, and in Q2 every (tool, status, quarter) cell below 5 is
--     merged into one '(suppressed)' period row, so subtracting Q1 from Q2
--     (or the cells from each other) cannot recover a cell below 5.
--     Q4 prints no total, no refunded count and no gap value; Q3 prints no
--     live-row estimate (inserts minus deletes would equal the row count).
--   * The time resolution is a UTC quarter, never finer.
-- TARGET IDENTITY (checked OUTSIDE this file, before any statement of this file
--   is sent, and never printed): the runner compares a fingerprint of the
--   interactively entered connection target with the fingerprint recorded in
--   the approval for this phase, and prints only "TARGET OK <label>" or
--   "TARGET MISMATCH" (the label is staging or production). A mismatch aborts
--   before the connection is used. See the plan document.
-- RUNNER : psql -X -q --no-psqlrc -v ON_ERROR_STOP=1 -f <this file>
--          Connection parameters (host, role, password) are entered
--          interactively at run time and are NEVER written to this file,
--          to shell history or to the saved output.
-- NEVER SELECTED (not even inside a subquery that reaches the output):
--   paid_results : id, input_hash, normalized_input, original_input,
--                  result_json, summary_json, source_run_id
--   credit_ledger: external_ref
--   (id / user_id / related_transaction_id are used only inside JOIN,
--    NOT EXISTS and DISTINCT, never in an output column.)
--   credit_ledger.metadata carries raw user text (topic, keyword, niche,
--   channel_id, seed_keyword): it is read ONLY as metadata->>'feature' and
--   that value is mapped to a fixed vocabulary, anything else becomes
--   '(unmapped)'. A login role must not be granted direct SELECT on this raw
--   column; see the execution options in the plan document.
-- Every query below declares its output columns in an "OUTPUT:" line; a test
-- compares them with an allow-list.
-- ============================================================================

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '120s';
SET LOCAL application_name = 'lr1_census_phase0';

-- Q0  session_guard  (GATE: raises an exception unless read-only and repeatable read)
DO $guard$
BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'lr1_census_guard_failed: session_guard: transaction is not read only';
  END IF;
  IF current_setting('transaction_isolation') <> 'repeatable read' THEN
    RAISE EXCEPTION 'lr1_census_guard_failed: session_guard: isolation is not repeatable read';
  END IF;
END
$guard$;

-- OUTPUT: session_guard_status, server_version_num
SELECT 'ok'::text AS session_guard_status,
       current_setting('server_version_num')::int AS server_version_num;

-- Q0b schema_guard  (GATE: raises an exception unless exactly the 10 expected columns exist)
DO $guard$
DECLARE
  found_columns integer;
BEGIN
  SELECT count(*)::integer INTO found_columns
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema
   AND t.table_name = c.table_name
   AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public'
    AND ((c.table_name = 'paid_results'
          AND c.column_name IN ('tool_type', 'status', 'credit_cost', 'updated_at', 'user_id'))
      OR (c.table_name = 'credit_ledger'
          AND c.column_name IN ('id', 'user_id', 'reason', 'metadata', 'related_transaction_id')));
  IF found_columns <> 10 THEN
    RAISE EXCEPTION 'lr1_census_guard_failed: schema_guard: expected exactly 10 columns, found %', found_columns;
  END IF;
END
$guard$;

-- OUTPUT: schema_guard_status
SELECT 'ok'::text AS schema_guard_status;

-- Q1  C-1a  paid_results status distribution per tool (fixed vocabulary labels, bucketed)
-- OUTPUT: tool_type, status, n_rows_bucket
WITH bucket(lo, hi, label) AS (
  VALUES (0::bigint, 1::bigint, '0'),
         (1, 5, '<5'),
         (5, 10, '5-9'),
         (10, 50, '10-49'),
         (50, 100, '50-99'),
         (100, 500, '100-499'),
         (500, 1000, '500-999'),
         (1000, 10000, '1000-9999'),
         (10000, 100000, '10000-99999'),
         (100000, 9223372036854775807, '100000+')
),
tool_vocab(value) AS (
  VALUES ('viral_score'), ('similar_videos'), ('opportunity_engine'), ('video_audit'),
         ('video_package'), ('script_extract'), ('transcript_extract'), ('content_gap'),
         ('analyzer'), ('keyword_research'), ('competitor_tracker'), ('outlier_detector'),
         ('title_studio'), ('thumbnail_studio'), ('seo_optimizer'), ('opportunity_explain'),
         ('channel_audit')
),
status_vocab(value) AS (
  VALUES ('completed'), ('failed'), ('refreshed'), ('archived')
),
cell AS (
  SELECT COALESCE(tv.value, '(other)') AS tool_type,
         CASE WHEN p.status IS NULL THEN '(null)' ELSE COALESCE(sv.value, '(other)') END AS status,
         count(*) AS n
  FROM public.paid_results p
  LEFT JOIN tool_vocab tv ON tv.value = p.tool_type
  LEFT JOIN status_vocab sv ON sv.value = p.status
  GROUP BY 1, 2
)
SELECT c.tool_type, c.status, b.label AS n_rows_bucket
FROM cell c
JOIN bucket b ON c.n >= b.lo AND c.n < b.hi
ORDER BY c.tool_type, c.status;

-- Q2  C-1b  non-completed rows per tool, status and UTC quarter (fixed vocabulary labels, bucketed, cells < 5 merged)
-- OUTPUT: tool_type, status, period, n_rows_bucket
WITH bucket(lo, hi, label) AS (
  VALUES (0::bigint, 1::bigint, '0'),
         (1, 5, '<5'),
         (5, 10, '5-9'),
         (10, 50, '10-49'),
         (50, 100, '50-99'),
         (100, 500, '100-499'),
         (500, 1000, '500-999'),
         (1000, 10000, '1000-9999'),
         (10000, 100000, '10000-99999'),
         (100000, 9223372036854775807, '100000+')
),
tool_vocab(value) AS (
  VALUES ('viral_score'), ('similar_videos'), ('opportunity_engine'), ('video_audit'),
         ('video_package'), ('script_extract'), ('transcript_extract'), ('content_gap'),
         ('analyzer'), ('keyword_research'), ('competitor_tracker'), ('outlier_detector'),
         ('title_studio'), ('thumbnail_studio'), ('seo_optimizer'), ('opportunity_explain'),
         ('channel_audit')
),
status_vocab(value) AS (
  VALUES ('completed'), ('failed'), ('refreshed'), ('archived')
),
cell AS (
  SELECT COALESCE(tv.value, '(other)') AS tool_type,
         CASE WHEN p.status IS NULL THEN '(null)' ELSE COALESCE(sv.value, '(other)') END AS status,
         date_trunc('quarter', p.updated_at AT TIME ZONE 'UTC')::date AS quarter_utc,
         count(*) AS n
  FROM public.paid_results p
  LEFT JOIN tool_vocab tv ON tv.value = p.tool_type
  LEFT JOIN status_vocab sv ON sv.value = p.status
  WHERE p.status IS DISTINCT FROM 'completed'
  GROUP BY 1, 2, 3
),
merged AS (
  SELECT tool_type,
         status,
         CASE WHEN n < 5 THEN NULL::date ELSE quarter_utc END AS quarter_utc,
         sum(n)::bigint AS n
  FROM cell
  GROUP BY tool_type, status, CASE WHEN n < 5 THEN NULL::date ELSE quarter_utc END
)
SELECT m.tool_type,
       m.status,
       COALESCE(m.quarter_utc::text, '(suppressed)') AS period,
       b.label AS n_rows_bucket
FROM merged m
JOIN bucket b ON m.n >= b.lo AND m.n < b.hi
ORDER BY m.tool_type, m.status, period;

-- Q3  C-2   cumulative table counters (supplementary diagnostics ONLY; bucketed)
-- OUTPUT: relname, n_tup_ins_bucket, n_tup_upd_bucket, n_tup_del_bucket
WITH bucket(lo, hi, label) AS (
  VALUES (0::bigint, 1::bigint, '0'),
         (1, 5, '<5'),
         (5, 10, '5-9'),
         (10, 50, '10-49'),
         (50, 100, '50-99'),
         (100, 500, '100-499'),
         (500, 1000, '500-999'),
         (1000, 10000, '1000-9999'),
         (10000, 100000, '10000-99999'),
         (100000, 9223372036854775807, '100000+')
),
counter AS (
  SELECT s.relname, s.n_tup_ins, s.n_tup_upd, s.n_tup_del
  FROM pg_stat_user_tables s
  WHERE s.schemaname = 'public'
    AND s.relname IN ('paid_results', 'credit_ledger')
)
SELECT c.relname,
       bi.label AS n_tup_ins_bucket,
       bu.label AS n_tup_upd_bucket,
       bd.label AS n_tup_del_bucket
FROM counter c
JOIN bucket bi ON c.n_tup_ins >= bi.lo AND c.n_tup_ins < bi.hi
JOIN bucket bu ON c.n_tup_upd >= bu.lo AND c.n_tup_upd < bu.hi
JOIN bucket bd ON c.n_tup_del >= bd.lo AND c.n_tup_del < bd.hi
ORDER BY c.relname;

-- Q3b C-2   when the cumulative counters were last reset (a counter value is meaningless without this)
-- OUTPUT: stats_reset
SELECT d.stats_reset
FROM pg_stat_database d
WHERE d.datname = current_database();

-- Q4  C-3   unrefunded paid spends vs stored results, per tool (INFORMATIVE magnitude only; no totals, no gap)
--           (fixed vocabulary labels, bucketed)
-- OUTPUT: tool_type, n_spends_not_refunded_bucket, n_completed_cost_pos_bucket, n_completed_cost_zero_bucket
WITH bucket(lo, hi, label) AS (
  VALUES (0::bigint, 1::bigint, '0'),
         (1, 5, '<5'),
         (5, 10, '5-9'),
         (10, 50, '10-49'),
         (50, 100, '50-99'),
         (100, 500, '100-499'),
         (500, 1000, '500-999'),
         (1000, 10000, '1000-9999'),
         (10000, 100000, '10000-99999'),
         (100000, 9223372036854775807, '100000+')
),
tool_vocab(value) AS (
  VALUES ('viral_score'), ('similar_videos'), ('opportunity_engine'), ('video_audit'),
         ('video_package'), ('script_extract'), ('transcript_extract'), ('content_gap'),
         ('analyzer'), ('keyword_research'), ('competitor_tracker'), ('outlier_detector'),
         ('title_studio'), ('thumbnail_studio'), ('seo_optimizer'), ('opportunity_explain'),
         ('channel_audit')
),
feature_map(feature, tool_type) AS (
  VALUES ('viral_score', 'viral_score'),
         ('similar_videos', 'similar_videos'),
         ('opportunity_engine', 'opportunity_engine'),
         ('video_audit', 'video_audit'),
         ('video_package_shorts', 'video_package'),
         ('video_package_long', 'video_package'),
         ('content_gap_finder', 'content_gap'),
         ('keyword_research', 'keyword_research'),
         ('title_studio', 'title_studio'),
         ('thumbnail_studio', 'thumbnail_studio'),
         ('seo_optimizer', 'seo_optimizer'),
         ('channel_audit', 'channel_audit'),
         ('script_extract', 'script_extract'),
         ('transcript_extract', 'transcript_extract'),
         ('opportunity_explain', 'opportunity_explain')
),
refunded AS (
  SELECT DISTINCT related_transaction_id AS spend_id
  FROM public.credit_ledger
  WHERE reason = 'credit_refund' AND related_transaction_id IS NOT NULL
),
spends AS (
  SELECT l.id, COALESCE(m.tool_type, '(unmapped)') AS tool_type
  FROM public.credit_ledger l
  LEFT JOIN feature_map m ON m.feature = l.metadata->>'feature'
  WHERE l.reason = 'credit_spend'
),
ledger_agg AS (
  SELECT s.tool_type,
         count(*) FILTER (WHERE r.spend_id IS NULL) AS n_not_refunded
  FROM spends s
  LEFT JOIN refunded r ON r.spend_id = s.id
  GROUP BY s.tool_type
),
results_agg AS (
  SELECT COALESCE(tv.value, '(other)') AS tool_type,
         count(*) FILTER (WHERE p.status = 'completed' AND p.credit_cost > 0) AS n_pos,
         count(*) FILTER (WHERE p.status = 'completed' AND COALESCE(p.credit_cost, 0) = 0) AS n_zero
  FROM public.paid_results p
  LEFT JOIN tool_vocab tv ON tv.value = p.tool_type
  GROUP BY 1
),
joined AS (
  SELECT COALESCE(l.tool_type, r.tool_type) AS tool_type,
         COALESCE(l.n_not_refunded, 0) AS a,
         COALESCE(r.n_pos, 0) AS b,
         COALESCE(r.n_zero, 0) AS c
  FROM ledger_agg l
  FULL OUTER JOIN results_agg r ON r.tool_type = l.tool_type
)
SELECT j.tool_type,
       ba.label AS n_spends_not_refunded_bucket,
       bb.label AS n_completed_cost_pos_bucket,
       bc.label AS n_completed_cost_zero_bucket
FROM joined j
JOIN bucket ba ON j.a >= ba.lo AND j.a < ba.hi
JOIN bucket bb ON j.b >= bb.lo AND j.b < bb.hi
JOIN bucket bc ON j.c >= bc.lo AND j.c < bc.hi
ORDER BY j.tool_type;

-- Q5  C-3b  users with unrefunded mapped spends and NO paid_results row of any status (one bucket label)
-- OUTPUT: n_users_with_mapped_spends_and_no_paid_results_bucket
WITH bucket(lo, hi, label) AS (
  VALUES (0::bigint, 1::bigint, '0'),
         (1, 5, '<5'),
         (5, 10, '5-9'),
         (10, 50, '10-49'),
         (50, 100, '50-99'),
         (100, 500, '100-499'),
         (500, 1000, '500-999'),
         (1000, 10000, '1000-9999'),
         (10000, 100000, '10000-99999'),
         (100000, 9223372036854775807, '100000+')
),
feature_map(feature) AS (
  VALUES ('viral_score'), ('similar_videos'), ('opportunity_engine'), ('video_audit'),
         ('video_package_shorts'), ('video_package_long'), ('content_gap_finder'),
         ('keyword_research'), ('title_studio'), ('thumbnail_studio'), ('seo_optimizer'),
         ('channel_audit'), ('script_extract'), ('transcript_extract'), ('opportunity_explain')
),
spender AS (
  SELECT DISTINCT l.user_id
  FROM public.credit_ledger l
  JOIN feature_map m ON m.feature = l.metadata->>'feature'
  WHERE l.reason = 'credit_spend'
    AND NOT EXISTS (
      SELECT 1 FROM public.credit_ledger rf
      WHERE rf.reason = 'credit_refund' AND rf.related_transaction_id = l.id
    )
),
total AS (
  SELECT count(*)::bigint AS n
  FROM spender sp
  WHERE NOT EXISTS (SELECT 1 FROM public.paid_results p WHERE p.user_id = sp.user_id)
)
SELECT b.label AS n_users_with_mapped_spends_and_no_paid_results_bucket
FROM total t
JOIN bucket b ON t.n >= b.lo AND t.n < b.hi;

ROLLBACK;
