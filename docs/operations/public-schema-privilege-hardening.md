# Public Schema Privilege Hardening v1 (migration 090)

Status: local implementation. Not applied to staging or production. Rollout is a separate gate.

## What 090 fixes

Migration 044 (2026-07-23) revoked only `SELECT/INSERT/UPDATE/DELETE` from `anon` on tables that
the Supabase `auto_expose_new_tables` default had over-granted, and its production audit compared
only those DML tuples. `TRUNCATE`, `REFERENCES`, `TRIGGER` and `MAINTAIN` were left in place.
Production, staging and a clean local stack (001-089) all carry the same set:

| Role | Tables holding all four privileges |
|---|---|
| `anon` | 37 |
| `authenticated` | 37 (the same tables) |
| `service_role` | 39 (the 37 plus `credit_bucket_migration_backup_037` and `youtube_oauth_tokens`) |

The application uses none of these privileges (DML only, via `service_role` or RLS-protected
`authenticated`). PostgREST has no verb for them, so the risk is latent, not an open HTTP path.

090 revokes exactly these four privileges, catalog-driven and idempotently, from `anon`,
`authenticated`, `service_role` and `PUBLIC` on every public relation. It proves, before and after,
by set-level digests, that nothing else changed:

- keeper `SELECT/INSERT/UPDATE/DELETE` sets (`anon`/`PUBLIC` = 0, `authenticated` = 23 tuples,
  `service_role` = 200 tuples),
- column-level ACLs (81 tuples),
- RLS enabled/forced topology (82 tables),
- the 77 application functions (signature, owner, kind, security mode, volatility, `search_path`,
  explicit ACL, body md5) and migration 089's capability RPC body,
- the 31 `pg_trgm` allowlist functions (signature, owner, kind, security mode, volatility, body md5).

## What 090 cannot modify

`PLATFORM_OWNED_DEFAULT_ACL_RESIDUAL`: the `supabase_admin` default ACL in schema `public`
(tables, sequences, functions: broad `anon`/`authenticated`/`service_role` grants) stays.

The migration role (`postgres` on hosted and local) is not a superuser and not a member of
`supabase_admin`. `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` fails with
`permission denied to change default privileges` (verified on production, staging and the local
stack on 2026-09-19). 090 does not attempt it and contains no workaround: no `SET ROLE`, no event
trigger, no dynamic privilege path.

Why platform-owned: `supabase_admin` is the Supabase platform role. Application migrations run as
`postgres` and get the `postgres` default ACL, which 046 already closed (owner only). The
`supabase_admin` default only affects objects that role creates in `public`, in practice extension
installs such as `pg_trgm`.

090 reads and validates this default ACL without modifying it. The set read on 2026-09-19 is the
**allowed upper bound**: a new owner, grantee, object type or privilege raises an exception; a
stricter platform default is accepted; an unknown state fails closed.

## How future drift is detected

`scripts/public-schema-privilege-guard.sql` is one read-only SQL file used three ways:

1. CI regression job: `tests/090-public-schema-privilege-hardening-db-integration.test.ts` runs it
   against the clean local stack and requires `GUARD_RESULT|violations=0`. The same test proves the
   guard fails on injected drift (broad table grant, extra privilege, sequence grant, public
   function with `PUBLIC`/`anon` EXECUTE, a new extension in `public`, a default ACL beyond the
   upper bound).
2. Staging postcondition, 3. production postcondition: run it through the interactive relay as
   `BEGIN ... ROLLBACK`; the result must be `violations=0`.

It fails on: a public table with any `anon` or `PUBLIC` privilege; `authenticated`/`service_role`
holding `TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN`; RLS disabled; a sequence with `anon`/`PUBLIC`
privileges; a non-`pg_trgm` public function with `PUBLIC` or `anon` EXECUTE (including the implicit
default); a `pg_trgm` allowlist size other than 31; an extension in `public` other than `pg_trgm`;
a default ACL beyond the recorded bound.

## Extension policy

- Installing an extension into schema `public` is forbidden (090's preflight and the guard fail).
- A new extension needs its own preflight, and should go into the `extensions` schema.
- `pg_trgm` in `public` is the single recorded exception; its 31 functions are a closed allowlist.
  Do not move it in this version.

## Separate postcondition item: Data API setting

The Data API setting "Automatically expose new tables" must be OFF on production and staging
(both were verified OFF on 2026-09-19; exposed schemas: `graphql_public`, `public`; 0 of 82 tables
and 31 of 108 functions exposed). This is a dashboard setting and cannot be checked in SQL, so it is
a manual postcondition line item next to the guard result.

## Backlog (not in 090)

Supabase support / platform-side hardening of the `supabase_admin` default ACL. Until then the
guard is the compensating control.

## Rollout order (separate gates)

Staging preflight (read-only, guard baseline), staging apply, staging postcondition (guard +
Data API setting + negative PostgREST/RPC checks), then the same three steps for production.
Rollback is restoring the four privileges from a catalog snapshot taken in the preflight.
