-- ============================================================
-- Migration 090: PFM Public Schema Privilege Hardening v1
--
-- MIT JAVIT A 090
--   A 044-es migracio (2026-07-23) a helyi/hosted `auto_expose_new_tables`
--   alapertelmezes teljes jogkeszletebol KIZAROLAG a SELECT/INSERT/UPDATE/
--   DELETE jogokat vonta vissza az `anon` szerepkortol, es a production <->
--   clean-rebuild audit is csak ezeket a DML-tuple-oket hasonlitotta. A
--   TRUNCATE, REFERENCES, TRIGGER es MAINTAIN jog erintetlen maradt, igy a
--   production es a staging (es a tiszta helyi stack) jelenlegi allapota:
--     - `anon`          : mind a 4 jog 37 public tablan
--     - `authenticated` : mind a 4 jog ugyanazon a 37 tablan
--     - `service_role`  : mind a 4 jog 39 tablan (a 37 + a
--                         credit_bucket_migration_backup_037 es a
--                         youtube_oauth_tokens)
--   Egyik jogra sincs szukseg az alkalmazasnak (az app kizarolag DML-t
--   hasznal service_role-on vagy RLS alatt authenticated-en), a PostgREST
--   pedig nem ismer TRUNCATE/REFERENCES/TRIGGER/MAINTAIN igejet -- a kockazat
--   latens, de valos (SQL-injekcio vagy hibas dinamikus RPC eseten).
--
--   A 090 KATALOGUSVEZERELTEN, idempotensen visszavonja ezt a negy jogot a
--   public schema osszes relaciojan `anon`, `authenticated`, `service_role`
--   es PUBLIC elol. A meglevo SELECT/INSERT/UPDATE/DELETE (keeper) halmazok,
--   az oszlopszintu ACL-ek, az RLS enabled/forced allapotok, a fuggvenyek,
--   a tablak adatai valtozatlanok -- ezt a migracio elotte es utana is
--   rogzitett digestekkel, halmazszinten bizonyitja.
--
-- MIT NEM TUD MODOSITANI (PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL)
--   A `supabase_admin` szerepkor public-schemas default ACL-je (tablak,
--   szekvenciak, fuggvenyek: `anon`, `authenticated`, `service_role`
--   szeles jogai) MARAD. Ezt a migraciot futtato hosted (es helyi) `postgres`
--   szerepkor NEM modosithatja: nem superuser, es nem tagja a
--   `supabase_admin`-nak (`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin`
--   -> "permission denied to change default privileges"; production, staging
--   es helyi stack egyarant igy viselkedik, 2026-09-19 read-only relay).
--   Ez a 090 NEM probalja megkerulni: nincs `ALTER DEFAULT PRIVILEGES FOR
--   ROLE supabase_admin`, nincs SET ROLE, nincs event trigger, nincs
--   dinamikus jogosultsagi kerouut.
--
-- MIERT PLATFORM-OWNED A RESIDUAL
--   A `supabase_admin` a Supabase platform szerepkore; a hozza kotott
--   default ACL a platform sajat kezelesu allapota. Az alkalmazas migraciok
--   `postgres`-kent futnak, az altaluk letrehozott objektumok a `postgres`
--   default ACL-jet kapjak (azt a 046 mar zarta: csak owner). A
--   `supabase_admin` default ACL gyakorlatilag csak az extension-telepites
--   (pl. a pg_trgm fuggvenyei) altal letrehozott objektumokra hat.
--
-- MIT ELLENORIZ A 090 A RESIDUALRA (fail-closed felso korlat)
--   A migracio KIOLVASSA es VALIDALJA -- de nem modositja -- a public-
--   schemas default ACL-eket. Az ekkor kiolvasott (2026-09-19, production =
--   staging = tiszta helyi stack) grantkeszlet a MEGENGEDETT FELSO KORLAT:
--     - uj grantee nem jelenhet meg,
--     - uj objektumtipus nem jelenhet meg,
--     - uj privilege nem jelenhet meg,
--     - ismeretlen owner nem jelenhet meg,
--     - a jelenlegihez kepest SZIGORUBB platform-default elfogadott,
--     - bovules vagy ismeretlen allapot -> RAISE EXCEPTION (fail-closed).
--   A postgres-owner public default (046) felso korlatja: csak owner.
--
-- FUGGVENYEK
--   A 31 pg_trgm fuggveny (owner supabase_admin, SECURITY INVOKER, a public
--   schemaban) zart, signature+body-hash+owner+security+volatility alapu
--   allowlist; nem mozgatjuk at, nem cserejuk, nem modositjuk a grantjukat.
--   A 77 alkalmazasi fuggveny teljes szerzodese (signature, owner, kind,
--   security mode, volatility, search_path, explicit ACL, body md5) rogzitett
--   -- barmilyen elteres, uj vagy hianyzo public fuggveny megbuktatja a
--   migraciot. Nem allowlistelt fuggvenyen PUBLIC/anon EXECUTE = 0.
--
-- JOVOBELI DRIFT ELLENI VEDELEM (CI + POSTCONDITION)
--   scripts/public-schema-privilege-guard.sql: read-only topology guard,
--   amely a CI regression jobban (tests/090-...) es a staging/production
--   postconditionben ugyanugy bukik minden uj public table/function/sequence
--   tul szeles grantjan, public schemaba telepitett uj extensionon, es a
--   default ACL felso korlat bovulesen. Uj extension KIZAROLAG kulon
--   preflighttal, lehetoleg az `extensions` schemaba kerulhet. A Data API
--   "Automatically expose new tables" kikapcsolt allapota kulon
--   postcondition (docs/operations/public-schema-privilege-hardening.md).
--   Supabase support / platform-oldali default ACL hardening kulon backlog.
--
-- NEM TARTALMAZ: adatvaltoztatast, RLS-valtoztatast, fuggveny-/extension-
-- valtoztatast, ALTER DEFAULT PRIVILEGES-t, event triggert, seedet.
-- ============================================================

BEGIN;

DO $hardening_090$
DECLARE
  -- ---- rogzitett szerzodes (2026-09-19, production = staging = tiszta helyi stack) ----
  c_app_functions CONSTANT jsonb := $pin_app$[
    "_close_pending_items_for_stopped_batch(p_batch_id uuid, p_reason_code text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=077348225fef2de59c00e7324b720e2b",
    "_semantic_topic_eligible_membership_sources(p_semantic_topic_id uuid)|owner=postgres|kind=f|secdef=false|vol=s|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=fba8af744970df7f93ba96fd71d2a939",
    "_semantic_topic_lifecycle_mechanical_check(p_vector jsonb)|owner=postgres|kind=f|secdef=false|vol=s|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=d75add661114d913cd6e783481202128",
    "_semantic_topic_lifecycle_snapshot_digest(p_semantic_topic_id uuid, p_target_status text, p_review_policy_version integer, p_vector jsonb)|owner=postgres|kind=f|secdef=false|vol=s|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=761d4217d220499617c54da6754bf347",
    "abandon_unclaimed_intake_item(p_batch_id uuid, p_item_id uuid, p_operator_reference text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=7af8d9a71cd31805842f1e00da42b925",
    "apply_bucket_credit_event(p_user_id uuid, p_delta numeric, p_bucket text, p_cap numeric, p_external_ref text, p_reason text, p_metadata jsonb)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=a866a896254f70b9054b2f50bb2e198d",
    "apply_credit_event(p_user_id uuid, p_delta numeric, p_cap numeric, p_external_ref text, p_reason text, p_metadata jsonb)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=3d25849aa43d1aa80e3ee0509949172d",
    "apply_signal_observation_batch(p_run_id uuid, p_batch_id uuid, p_lease_owner text, p_observed_at timestamp with time zone, p_results jsonb)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=f67212b8e05095e0118c0562d09b1b0b",
    "authorize_intake_item_retry(p_item_id uuid, p_operator_reference text, p_reason_code text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=2f57ec10552162e08602e683845a688e",
    "begin_intake_attempt_call(p_item_id uuid, p_claim_token text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=17fae83e58b7348b64af92fa0e1f7b41",
    "bind_provider_reservation_to_batch(p_reservation_id uuid, p_batch_id uuid, p_lease_owner text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=1373cae28319ed700bab226b6a4f7744",
    "cancel_intake_batch(p_batch_id uuid, p_operator_reference text, p_reason_code text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=0811f04e4da0ef00c5e39e7657f4cceb",
    "cancel_semantic_topic_lifecycle_review_request(p_review_request_id uuid, p_idempotency_key text, p_cancel_reason_code text, p_cancel_rationale text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=3d89febb55199ecaaa6936d4e68bcecb",
    "cancel_topic_assignment_review_request(p_review_request_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=c12d0d8abe4b2cd6206c33485d324bc5",
    "claim_next_intake_item(p_batch_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=21b4d6d58d259cc1235f74f1f2e5d38d",
    "cleanup_expired_cache()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=cba5fdac6c629e0a9414aaa8d1dc3183",
    "commit_ai_provider_units(p_reservation_id uuid, p_actual_input_tokens integer, p_actual_output_tokens integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=1bfb1df62ceb15624583fedebd99f705",
    "commit_provider_units(p_reservation_id uuid, p_actual_units integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=3af19fd58f0b9ace1cc2fdec938f0782",
    "complete_intake_item_success(p_item_id uuid, p_claim_token text, p_provider_reservation_id uuid, p_extraction_run_id uuid, p_review_request_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=29c033340b45fb797af4739ff5b0f6c2",
    "compute_topic_evidence_vector(p_semantic_topic_id uuid)|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=73aeb37846bcc80fd42a4e2c8862dc7c",
    "configure_supervised_intake_control(p_enabled boolean, p_max_batch_items integer, p_max_daily_claimed_items integer, p_claim_lease_seconds integer, p_operator_reference text, p_reason_code text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=d7c79d05654f513be33047e98d47b9e1",
    "create_semantic_topic_lifecycle_review_request(p_semantic_topic_id uuid, p_target_status text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=162b4b91d7d742722a4f580ababff34c",
    "create_supervised_intake_batch(p_evidence_ids uuid[], p_operator_reference text, p_provider text, p_usage_type text, p_model text, p_normalization_version integer, p_extraction_schema_version integer, p_prompt_version text, p_deterministic_extractor_version integer, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=ab9e2376f95fd39536124ed19ddf37ca",
    "create_topic_assignment_review_request(p_extraction_run_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=b2dc0bf3cde341c21efc5023dd32ac04",
    "deactivate_signal_seed(p_target_seed_fingerprint text, p_reason_code text, p_operator_reference text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=a5d35d5cdb8720b2b6a1b8fc5092c051",
    "enforce_creator_memory_identity()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=ee6534a101bfc213d89e4ce7865b07e4",
    "enforce_creator_memory_lane_consistency()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=570313f9e5056ea161e1c6e7beef5825",
    "enforce_video_idea_lane_lock_immutable()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=bb8195311b5d69d916e632702ae26d89",
    "ensure_video_idea_lane(p_user_id uuid, p_topic text, p_normalized_topic text, p_platform text, p_language text, p_market text, p_input_hash text, p_content_lane text, p_expected_current_lane text, p_expected_assignment_source text, p_lane_source text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=9ae96af8ffaab33d18d447c09e24ab70",
    "execute_approved_semantic_topic_lifecycle_transition(p_review_request_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=6c12de4cef728e046490645c0ce3b057",
    "execute_approved_topic_assignment_review(p_review_request_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=4b0569a4ebb39b63d918b27859be2ea6",
    "expire_stale_provider_reservations(p_provider text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=49de87d163f5c31b216e357f675bbb08",
    "expire_stale_topic_assignment_review_requests(p_batch_limit integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=57964e0dfea52dbe072e2b4f331cc8f2",
    "fail_intake_item(p_item_id uuid, p_claim_token text, p_reason_code text, p_retryable boolean, p_diagnostic_code text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=b06194dd4dd64b5488bc8a3fd218c6bd",
    "finalize_ai_provider_reservation_outcome(p_reservation_id uuid, p_extraction_run_id uuid, p_application_outcome text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=f61c4c5791e578e4ed8f45816fc618b9",
    "finalize_intake_batch(p_batch_id uuid, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=2fc763c1da71a436c2ece2c7b4cd190e",
    "get_semantic_topic_lifecycle_review_request(p_review_request_id uuid)|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=74b1694a0f72dfb845d8a5e651423401",
    "get_semantic_topic_lifecycle_reviewer_capability()|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=141a93f922973dc9b2b20dc8df7e2de0",
    "get_topic_assignment_review_request(p_review_request_id uuid)|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=702dff99375c953725c8ea966782d2d7",
    "handle_new_user()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=814e0bfb089dab3ab7c956e688d89a8a",
    "handle_new_user_credits()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=dfbd749245740141594091a84098a0a3",
    "increment_subscription_credits(p_user_id uuid, p_delta numeric, p_cap numeric)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=ec32a72e94c383cc577b53a07a6a31c7",
    "increment_topup_credits(p_user_id uuid, p_delta numeric)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=8a49888e3512df7c33cae6bd0e332b17",
    "link_creator_memory_parent(p_user_id uuid, p_memory_id uuid, p_video_idea_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=c4cc3f8e000319a615466ccc78482372",
    "list_pending_topic_assignment_review_requests(p_limit integer, p_after_requested_at timestamp with time zone, p_after_id uuid)|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=dc5bc62aa0a421daaa00aa49673cbedc",
    "list_semantic_topic_lifecycle_review_requests(p_status_filter text, p_limit integer, p_after_requested_at timestamp with time zone, p_after_id uuid)|owner=postgres|kind=f|secdef=true|vol=s|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=e146ee7500646b5fd240545a0419d5a5",
    "lock_video_idea_lane(p_user_id uuid, p_video_idea_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=15a8672de124af6fe458beb116a27c9b",
    "mark_ai_provider_attempt_started(p_reservation_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=27f8326eb24641a149e72ac9748e0e1d",
    "mark_ai_provider_outcome_unknown(p_reservation_id uuid, p_error_class text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=186d3f26bef951e79aff077f87e293ce",
    "mark_provider_attempt_started(p_reservation_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=e10f65bb0801665a727b73fe2ae6e4f3",
    "mark_provider_outcome_unknown(p_reservation_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=2d8efc407c3b4682004db52c5423e974",
    "reclassify_video_idea(p_user_id uuid, p_source_video_idea_id uuid, p_new_lane text, p_new_source text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=da2bff7a62ef761b4fa392de4a10e1c1",
    "reconcile_missing_signal_observation_schedules()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=c8f0784b89b785423622f49d9a3bc6e1",
    "reconcile_stale_ai_provider_reservations(p_unstarted_stale_after_seconds integer, p_started_stale_after_seconds integer, p_committed_unfinalized_stale_after_seconds integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=4729a222a07039de3ea94a7141cc0775",
    "reconcile_stale_intake_claims(p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=18efbad8a1d5416e8c7959c5603441df",
    "record_semantic_topic_lifecycle_review_decision(p_review_request_id uuid, p_decision_idempotency_key text, p_outcome text, p_reason_code text, p_reviewer_rationale text, p_same_semantic_identity_confirmed boolean, p_no_material_identity_conflict boolean, p_canonical_definition_scope_fit_confirmed boolean, p_provenance_relationship_reviewed boolean, p_review_policy_version integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=84e841b23fe2d42725c53d09bbb1b2a7",
    "record_topic_assignment_decision(p_extraction_run_id uuid, p_outcome text, p_decision_reason text, p_deterministic_signals jsonb, p_idempotency_key text, p_existing_semantic_topic_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=9e681c94870719a0a7cb4605de458baf",
    "record_topic_assignment_review_decision(p_review_request_id uuid, p_decision_idempotency_key text, p_outcome text, p_canonical_topic_label text, p_topic_definition text, p_scope text, p_inclusion_criteria text, p_exclusion_criteria text, p_lane_neutral_confirmed boolean, p_evidence_adequacy text, p_duplicate_search_outcome text, p_proposed_outcome text, p_target_semantic_topic_id uuid, p_uncertainty_classification text, p_reviewer_rationale text, p_review_policy_version integer, p_rejection_reason text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=cf8fa6dece05fc6e8f24a361939acce9",
    "record_topic_extraction_run(p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_method text, p_provider text, p_model text, p_prompt_version text, p_deterministic_extractor_version integer, p_normalized_extraction_input text, p_extraction_schema_version integer, p_status text, p_structured_output jsonb, p_input_tokens integer, p_output_tokens integer, p_estimated_cost_usd numeric, p_error_class text, p_idempotency_key text, p_started_at timestamp with time zone, p_completed_at timestamp with time zone)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=ef55f0b83d78d001d9e2f903f434c79f",
    "refund_credit_spend(p_user_id uuid, p_spend_transaction_id uuid, p_external_ref text, p_metadata jsonb)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=26d5646cafe19a3ffcad509ec8ef420b",
    "register_signal_seed(p_seed_text text, p_category text, p_region text, p_language text, p_seed_type text, p_fingerprint text, p_operator_reference text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=4bf30d8349141abad35d82dcc03d1083",
    "release_ai_provider_units(p_reservation_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=22b2b563668e71248731a707e6d6f12a",
    "release_provider_units(p_reservation_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=da4ec39e3b20211e0a8f9c77e6bd7231",
    "reserve_ai_provider_units(p_provider text, p_usage_type text, p_model text, p_signal_evidence_id uuid, p_normalization_version integer, p_extraction_schema_version integer, p_prompt_version text, p_normalized_extraction_input text, p_estimated_input_tokens integer, p_estimated_max_output_tokens integer, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=d781b17d74ab22fcd4e758408b75f0df",
    "reserve_provider_units(p_provider text, p_usage_scope text, p_usage_type text, p_run_id uuid, p_phase text, p_idempotency_key text, p_units integer, p_lease_seconds integer)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=3ad82ac63b81d925176192ddb7430ce3",
    "resolve_intake_attempt_reconciliation(p_attempt_id uuid, p_operator_reference text, p_resolution text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=2e0eb9973173250fc50ff4a2ddb2fde2",
    "revoke_topic_assignment_review_approval(p_review_request_id uuid)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=authenticated:EXECUTE,postgres:EXECUTE|body=02d0ea82e72a05b61d91da496475eadf",
    "rls_auto_enable()|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=pg_catalog|acl=postgres:EXECUTE|body=99be20677b456ea8d3be47bdd44fb369",
    "run_shadow_topic_scoring(p_evaluation_time timestamp with time zone, p_input_cutoff timestamp with time zone, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=75e1ff9653b362191e62b213ea06237a",
    "spend_credits(p_user_id uuid, p_cost numeric, p_feature text, p_external_ref text, p_metadata jsonb)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=1ea8165ff4acdc8bd05830c78b036260",
    "stop_intake_batch(p_batch_id uuid, p_reason_code text, p_idempotency_key text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=a23602bc8f37aff495632832522cf96d",
    "sync_credit_balance_from_buckets()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=a81ae6cea9be4b32efe6ef8eb1e805b7",
    "trg_schedule_new_scheduled_youtube_evidence()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=c7f3d7bb62073d8ce31df69dc103c9da",
    "update_tracked_competitors_updated_at()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=da5ac28a58c8b4bb30209bf0d3d7082c",
    "update_updated_at()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=da5ac28a58c8b4bb30209bf0d3d7082c",
    "update_video_ideas_updated_at()|owner=postgres|kind=f|secdef=false|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE|body=da5ac28a58c8b4bb30209bf0d3d7082c",
    "upsert_creator_memory(p_user_id uuid, p_topic text, p_content_lane text, p_video_idea_id uuid, p_search_keyword text, p_state text, p_opportunity_score integer, p_viral_score integer, p_platform text, p_notes text, p_audit_score integer, p_audit_id uuid, p_video_package_id uuid, p_source_context text, p_quality_status text)|owner=postgres|kind=f|secdef=true|vol=v|cfg=search_path=public, pg_temp|acl=postgres:EXECUTE,service_role:EXECUTE|body=3a01ae760626adbdd84409f6ac1bf9ce"
  ]$pin_app$::jsonb;
  c_trgm_functions CONSTANT jsonb := $pin_trgm$[
    "gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=bcc3d1b35e67c79fdd7743051b5bb54e",
    "gin_extract_value_trgm(text, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=c75ed6efb95d6922885e652c3b1ae63f",
    "gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=1a51ef4f90da1f8206849b90da034f15",
    "gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=2042fbe8e50aa61204b33362850572be",
    "gtrgm_compress(internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=0c5e51542dfa58ac5c28c29a37958c04",
    "gtrgm_consistent(internal, text, smallint, oid, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=520315289c6207994f47bd6b574fcbe2",
    "gtrgm_decompress(internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=92fd74d4efb9a0f25dd35b9b75f71a6b",
    "gtrgm_distance(internal, text, smallint, oid, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=96b6ebcb046f8c4a69cbe07f341d676e",
    "gtrgm_in(cstring)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=af406f0d6fd3f9f056beb474dc267883",
    "gtrgm_options(internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=e959830838e9384393160a2b19d70bb7",
    "gtrgm_out(gtrgm)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=809b516b4474d75b7ea2606e56263a8b",
    "gtrgm_penalty(internal, internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=78a76e7fec267214504a675b59c13d82",
    "gtrgm_picksplit(internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=c2073eb2953664de02fe1c5070a2c0e3",
    "gtrgm_same(gtrgm, gtrgm, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=5b60e89adb1cae9e6b7e3b9e7512a859",
    "gtrgm_union(internal, internal)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=ac59a0687df15075468862ca946ee148",
    "set_limit(real)|owner=supabase_admin|kind=f|secdef=false|vol=v|body=79156a0336c67021d9428bff7da30542",
    "show_limit()|owner=supabase_admin|kind=f|secdef=false|vol=s|body=3ab6c68b603f0310182efe3695d82a92",
    "show_trgm(text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=bb20c15988887dca8023fcdec2e15705",
    "similarity(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=a65b94a37c1cfdf8414dc6e5180328ee",
    "similarity_dist(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=ace88dc523cc3a38ee252b232a6f3233",
    "similarity_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=s|body=4317659571d5d65d8c2c051c25c0cecd",
    "strict_word_similarity(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=658697160f2064b47734aebdbd38425f",
    "strict_word_similarity_commutator_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=s|body=d06f5838b6234053cb93ddd82002f172",
    "strict_word_similarity_dist_commutator_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=21d307ff0ca968d7cb12e9ecdf15ed5e",
    "strict_word_similarity_dist_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=4a6a81f56250df9a7e29bb72de12835f",
    "strict_word_similarity_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=s|body=04fed7fd0767165a07b85c5ec4fd59a1",
    "word_similarity(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=b9d296bc7ed64b19e32192351e9b284f",
    "word_similarity_commutator_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=s|body=02611902707b5de0d52c0f6a91da6218",
    "word_similarity_dist_commutator_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=d3dad69b1ecbf95b0cd4ad9d0b898eca",
    "word_similarity_dist_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=i|body=ba8863f446eceb450a04b6c324db7419",
    "word_similarity_op(text, text)|owner=supabase_admin|kind=f|secdef=false|vol=s|body=5412212962db1aa604d6b20bbcf89c75"
  ]$pin_trgm$::jsonb;
  -- PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL felso korlat (public schema) es globalis default ACL felso korlat
  c_dacl_public_bound CONSTANT jsonb := $pin_dp$[
    "postgres|S|postgres|SELECT",
    "postgres|S|postgres|UPDATE",
    "postgres|S|postgres|USAGE",
    "postgres|f|postgres|EXECUTE",
    "postgres|r|postgres|DELETE",
    "postgres|r|postgres|INSERT",
    "postgres|r|postgres|MAINTAIN",
    "postgres|r|postgres|REFERENCES",
    "postgres|r|postgres|SELECT",
    "postgres|r|postgres|TRIGGER",
    "postgres|r|postgres|TRUNCATE",
    "postgres|r|postgres|UPDATE",
    "supabase_admin|S|anon|SELECT",
    "supabase_admin|S|anon|UPDATE",
    "supabase_admin|S|anon|USAGE",
    "supabase_admin|S|authenticated|SELECT",
    "supabase_admin|S|authenticated|UPDATE",
    "supabase_admin|S|authenticated|USAGE",
    "supabase_admin|S|postgres|SELECT",
    "supabase_admin|S|postgres|UPDATE",
    "supabase_admin|S|postgres|USAGE",
    "supabase_admin|S|service_role|SELECT",
    "supabase_admin|S|service_role|UPDATE",
    "supabase_admin|S|service_role|USAGE",
    "supabase_admin|f|anon|EXECUTE",
    "supabase_admin|f|authenticated|EXECUTE",
    "supabase_admin|f|postgres|EXECUTE",
    "supabase_admin|f|service_role|EXECUTE",
    "supabase_admin|r|anon|DELETE",
    "supabase_admin|r|anon|INSERT",
    "supabase_admin|r|anon|MAINTAIN",
    "supabase_admin|r|anon|REFERENCES",
    "supabase_admin|r|anon|SELECT",
    "supabase_admin|r|anon|TRIGGER",
    "supabase_admin|r|anon|TRUNCATE",
    "supabase_admin|r|anon|UPDATE",
    "supabase_admin|r|authenticated|DELETE",
    "supabase_admin|r|authenticated|INSERT",
    "supabase_admin|r|authenticated|MAINTAIN",
    "supabase_admin|r|authenticated|REFERENCES",
    "supabase_admin|r|authenticated|SELECT",
    "supabase_admin|r|authenticated|TRIGGER",
    "supabase_admin|r|authenticated|TRUNCATE",
    "supabase_admin|r|authenticated|UPDATE",
    "supabase_admin|r|postgres|DELETE",
    "supabase_admin|r|postgres|INSERT",
    "supabase_admin|r|postgres|MAINTAIN",
    "supabase_admin|r|postgres|REFERENCES",
    "supabase_admin|r|postgres|SELECT",
    "supabase_admin|r|postgres|TRIGGER",
    "supabase_admin|r|postgres|TRUNCATE",
    "supabase_admin|r|postgres|UPDATE",
    "supabase_admin|r|service_role|DELETE",
    "supabase_admin|r|service_role|INSERT",
    "supabase_admin|r|service_role|MAINTAIN",
    "supabase_admin|r|service_role|REFERENCES",
    "supabase_admin|r|service_role|SELECT",
    "supabase_admin|r|service_role|TRIGGER",
    "supabase_admin|r|service_role|TRUNCATE",
    "supabase_admin|r|service_role|UPDATE"
  ]$pin_dp$::jsonb;
  c_dacl_global_bound CONSTANT jsonb := $pin_dg$[
    "postgres|f|postgres|EXECUTE"
  ]$pin_dg$::jsonb;
  c_cap089_body CONSTANT text := '141a93f922973dc9b2b20dc8df7e2de0';
  c_dml_auth_count CONSTANT int := 23;
  c_dml_auth_digest CONSTANT text := 'a61b7ce32da3173b31ebb3d425d28e87';
  c_dml_service_count CONSTANT int := 200;
  c_dml_service_digest CONSTANT text := 'bce480eb585ee2696de25026dcbd094c';
  c_rls_count CONSTANT int := 82;
  c_rls_digest CONSTANT text := '6f7316e9cfac1034d05db6917006b23f';
  c_colacl_count CONSTANT int := 81;
  c_colacl_digest CONSTANT text := 'f39227a4fb9a998d64748195b63a12b4';

  v_phase int;
  v_label text;
  v_cur text[];
  v_missing text[];
  v_unexpected text[];
  v_count int;
  v_digest text;
  v_body text;
  r record;
BEGIN
  -- 0. A MAINTAIN privilege PostgreSQL 17 elotti verziokon nem letezik: fail-closed.
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION '090 fail-closed: PostgreSQL >= 17 required (MAINTAIN privilege); got %', current_setting('server_version');
  END IF;

  -- 1. Ket menet: 1 = 089 utani elvart prestate (fail-fast, MIELOTT barmit modositunk),
  --    2 = a visszavonas utani vegallapot. A strukturalis szerzodes mindket menetben azonos.
  FOR v_phase IN 1..2 LOOP
    v_label := CASE v_phase WHEN 1 THEN 'pre' ELSE 'post' END;

    -- 1a. 089 capability RPC valtozatlan
    SELECT md5(replace(prosrc, E'\r\n', E'\n')) INTO v_body
    FROM pg_proc WHERE oid = to_regprocedure('public.get_semantic_topic_lifecycle_reviewer_capability()');
    IF v_body IS DISTINCT FROM c_cap089_body THEN
      RAISE EXCEPTION '090 fail-closed (%): 089 capability RPC missing or body hash changed', v_label;
    END IF;

    -- 1b. 77 alkalmazasi fuggveny: pontos halmaz + teljes szerzodes
    SELECT coalesce(array_agg(line ORDER BY line), ARRAY[]::text[]) INTO v_cur FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
        '|owner=' || pg_get_userbyid(p.proowner) || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef ||
        '|vol=' || p.provolatile::text || '|cfg=' || coalesce(array_to_string(p.proconfig, ';'), '') ||
        '|acl=' || coalesce((SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type, ',' ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END), a.privilege_type) FROM aclexplode(p.proacl) a), '<null>') ||
        '|body=' || md5(replace(p.prosrc, E'\r\n', E'\n')) AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm')
    ) s;
    SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_missing
      FROM (SELECT jsonb_array_elements_text(c_app_functions) AS x EXCEPT SELECT unnest(v_cur)) s;
    SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_unexpected
      FROM (SELECT unnest(v_cur) AS x EXCEPT SELECT jsonb_array_elements_text(c_app_functions)) s;
    IF cardinality(v_missing) > 0 OR cardinality(v_unexpected) > 0 THEN
      RAISE EXCEPTION '090 fail-closed (%): application function contract drift (unknown or changed public function). changed/missing=% unexpected/changed=%',
        v_label,
        (SELECT array_agg(split_part(x, '|', 1)) FROM (SELECT x FROM unnest(v_missing) x LIMIT 5) s),
        (SELECT array_agg(split_part(x, '|', 1)) FROM (SELECT x FROM unnest(v_unexpected) x LIMIT 5) s);
    END IF;

    -- 1c. 31 pg_trgm fuggveny: zart allowlist (signature + owner + kind + security + volatility + body md5)
    SELECT coalesce(array_agg(line ORDER BY line), ARRAY[]::text[]) INTO v_cur FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ||
        '|owner=' || pg_get_userbyid(p.proowner) || '|kind=' || p.prokind::text || '|secdef=' || p.prosecdef ||
        '|vol=' || p.provolatile::text || '|body=' || md5(replace(p.prosrc, E'\r\n', E'\n')) AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm')
    ) s;
    SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_missing
      FROM (SELECT jsonb_array_elements_text(c_trgm_functions) AS x EXCEPT SELECT unnest(v_cur)) s;
    SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO v_unexpected
      FROM (SELECT unnest(v_cur) AS x EXCEPT SELECT jsonb_array_elements_text(c_trgm_functions)) s;
    IF cardinality(v_missing) > 0 OR cardinality(v_unexpected) > 0 THEN
      RAISE EXCEPTION '090 fail-closed (%): pg_trgm allowlist drift. missing/changed=% unexpected/changed=%',
        v_label,
        (SELECT array_agg(split_part(x, '|', 1)) FROM (SELECT x FROM unnest(v_missing) x LIMIT 5) s),
        (SELECT array_agg(split_part(x, '|', 1)) FROM (SELECT x FROM unnest(v_unexpected) x LIMIT 5) s);
    END IF;
    -- az extension-fuggvenyek grantjai csak PUBLIC/API-szerepkor/owner EXECUTE lehetnek (szigorodas elfogadott)
    SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE n.nspname = 'public'
      AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm')
      AND NOT (a.privilege_type = 'EXECUTE'
               AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role','postgres','supabase_admin')));
    IF v_count <> 0 THEN
      RAISE EXCEPTION '090 fail-closed (%): pg_trgm function grants exceed the recorded grantee/privilege set (% offending ACL entries)', v_label, v_count;
    END IF;

    -- 1d. nem allowlistelt fuggvenyen PUBLIC / anon EXECUTE = 0 (implicit PUBLIC default-tal egyutt)
    SELECT coalesce(array_agg(p.proname ORDER BY p.proname), ARRAY[]::text[]) INTO v_unexpected
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e' AND e.extname = 'pg_trgm')
      AND (p.proacl IS NULL
           OR has_function_privilege('anon', p.oid, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
    IF cardinality(v_unexpected) > 0 THEN
      RAISE EXCEPTION '090 fail-closed (%): non-allowlisted public function(s) callable by PUBLIC or anon: %', v_label, v_unexpected[1:5];
    END IF;

    -- 1e. extension policy: public schemaban KIZAROLAG a mar telepitett pg_trgm lehet
    SELECT coalesce(array_agg(extname::text ORDER BY extname), ARRAY[]::text[]) INTO v_unexpected
    FROM pg_extension WHERE extnamespace = 'public'::regnamespace;
    IF v_unexpected IS DISTINCT FROM ARRAY['pg_trgm']::text[] THEN
      RAISE EXCEPTION '090 fail-closed (%): extension policy violated -- only pg_trgm may live in schema public, found %', v_label, v_unexpected;
    END IF;

    -- 1f. keeper DML halmazok (objektumhalmaz-szintu digest): anon/PUBLIC = 0, authenticated es service_role pontosan a rogzitett
    SELECT count(*) INTO v_count
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND (a.grantee = 0 OR a.grantee = 'anon'::regrole) AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');
    IF v_count <> 0 THEN
      RAISE EXCEPTION '090 fail-closed (%): anon/PUBLIC table DML tuples expected 0, found %', v_label, v_count;
    END IF;
    SELECT count(*), coalesce(md5(string_agg(t, E'\n' ORDER BY t)), 'empty') INTO v_count, v_digest FROM (
      SELECT c.relname || '|' || a.privilege_type AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.grantee = 'authenticated'::regrole
        AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) s;
    IF v_count <> c_dml_auth_count OR v_digest <> c_dml_auth_digest THEN
      RAISE EXCEPTION '090 fail-closed (%): authenticated keeper DML set changed (count %, expected %)', v_label, v_count, c_dml_auth_count;
    END IF;
    SELECT count(*), coalesce(md5(string_agg(t, E'\n' ORDER BY t)), 'empty') INTO v_count, v_digest FROM (
      SELECT c.relname || '|' || a.privilege_type AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.grantee = 'service_role'::regrole
        AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')) s;
    IF v_count <> c_dml_service_count OR v_digest <> c_dml_service_digest THEN
      RAISE EXCEPTION '090 fail-closed (%): service_role keeper DML set changed (count %, expected %)', v_label, v_count, c_dml_service_count;
    END IF;

    -- 1g. oszlopszintu ACL-ek es RLS enabled/forced topologia valtozatlan
    SELECT count(*), coalesce(md5(string_agg(t, E'\n' ORDER BY t)), 'empty') INTO v_count, v_digest FROM (
      SELECT c.relname || '.' || at.attname || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute at ON at.attrelid = c.oid CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE n.nspname = 'public' AND at.attacl IS NOT NULL AND NOT at.attisdropped) s;
    IF v_count <> c_colacl_count OR v_digest <> c_colacl_digest THEN
      RAISE EXCEPTION '090 fail-closed (%): column-level ACL set changed (count %, expected %)', v_label, v_count, c_colacl_count;
    END IF;
    SELECT count(*), md5(string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity, E'\n' ORDER BY c.relname)) INTO v_count, v_digest
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p');
    IF v_count <> c_rls_count OR v_digest IS DISTINCT FROM c_rls_digest THEN
      RAISE EXCEPTION '090 fail-closed (%): RLS enabled/forced topology changed (tables %, expected %)', v_label, v_count, c_rls_count;
    END IF;

    -- 1h. PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL: kiolvas + validal, DE NEM modosit (felso korlat)
    SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_unexpected FROM (
      SELECT pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace = 'public'::regnamespace
      EXCEPT SELECT jsonb_array_elements_text(c_dacl_public_bound)) s;
    IF cardinality(v_unexpected) > 0 THEN
      RAISE EXCEPTION '090 fail-closed (%, PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL): default ACL in schema public EXCEEDS the recorded upper bound (new owner/grantee/objtype/privilege): %', v_label, v_unexpected[1:8];
    END IF;
    SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[]) INTO v_unexpected FROM (
      SELECT pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || '|' || a.privilege_type AS t
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace = 0
      EXCEPT SELECT jsonb_array_elements_text(c_dacl_global_bound)) s;
    IF cardinality(v_unexpected) > 0 THEN
      RAISE EXCEPTION '090 fail-closed (%, PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL): global default ACL EXCEEDS the recorded upper bound: %', v_label, v_unexpected[1:8];
    END IF;

    IF v_phase = 1 THEN
      -- 2. KATALOGUSVEZERELT visszavonas: az ACL-ben tenylegesen szereplo (relacio, grantee) parokra.
      FOR r IN
        SELECT DISTINCT c.oid::regclass::text AS rel,
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee_sql
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
          AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
          AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role'))
        ORDER BY 1, 2
      LOOP
        EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE %s FROM %s', r.rel, r.grantee_sql);
      END LOOP;
    ELSE
      -- 3. vegallapot: a negy jog sem ACL-bejegyzeskent, sem effektiv modon nem maradhat
      SELECT count(*) INTO v_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
        AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon','authenticated','service_role'));
      IF v_count <> 0 THEN
        RAISE EXCEPTION '090 fail-closed (post): % TRUNCATE/REFERENCES/TRIGGER/MAINTAIN ACL entries remain for anon/authenticated/service_role/PUBLIC', v_count;
      END IF;
      SELECT count(*) INTO v_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) roles(rolname)
      CROSS JOIN (VALUES ('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) privs(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege(roles.rolname, c.oid, privs.priv);
      IF v_count <> 0 THEN
        RAISE EXCEPTION '090 fail-closed (post): % effective TRUNCATE/REFERENCES/TRIGGER/MAINTAIN privileges remain (incl. inherited)', v_count;
      END IF;
    END IF;
  END LOOP;
END
$hardening_090$;

COMMIT;
