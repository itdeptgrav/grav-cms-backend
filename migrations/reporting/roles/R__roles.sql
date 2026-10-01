-- R__roles.sql — the two roles that touch the mart, and what each may do.
--
-- Applied by `npm run reporting:roles`, as the database owner, with both
-- passwords bound at run time from the environment. **No password is ever
-- written into this file or any other committed file.**
--
-- ── TWO ROLES, BECAUSE THEY WANT OPPOSITE THINGS ────────────────────────────
--
--   reporting_sync     the sync writes here and nowhere else. INSERT/UPDATE/
--                      DELETE on the reporting schema; no CREATE, no DDL, no
--                      other schema. It cannot migrate itself — migrations run
--                      as the owner — so a compromised sync cannot reshape the
--                      mart, only refill it.
--
--   metabase_reader    SELECT, and nothing else, on the approved reporting
--                      objects. This is the connection an accountant's query
--                      builder runs as. The builder is only safe to hand to a
--                      non-technical user if the connection underneath it is
--                      INCAPABLE of changing anything, whatever the builder is
--                      persuaded to emit.
--
-- ── READ-ONLY IS ASSERTED BY REMOVING, NOT BY NOT GRANTING ──────────────────
-- Every role is a member of PUBLIC, and PUBLIC carries privileges of its own —
-- before PostgreSQL 15 it could CREATE in `public`. So this revokes as well as
-- grants, and `scripts/reporting/verify-roles.js` then proves the result by
-- ATTEMPTING each forbidden action and requiring it to fail. A grant matrix
-- read by eye is how a misconfiguration survives review.
--
-- ── METABASE'S APPLICATION DATABASE ─────────────────────────────────────────
-- It is on a SEPARATE PostgreSQL SERVER (deploy/metabase-pilot/compose.yaml:
-- `postgres-app` vs `postgres-reporting`), not a second database on this one.
-- So `metabase_reader` has no network path to it at all, which is a stronger
-- guarantee than any grant — a mis-grant here cannot reach it. The verification
-- script asserts that too, rather than assuming the topology stays this way.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────────────────
-- Roles (idempotent — this file is repeatable)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_sync') THEN
    CREATE ROLE reporting_sync LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_reader') THEN
    CREATE ROLE metabase_reader LOGIN;
  END IF;
END
$$;

ALTER ROLE reporting_sync  WITH PASSWORD :'sync_password'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE metabase_reader WITH PASSWORD :'reader_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Nobody gets anything by default
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

/* The maintenance database. PostgreSQL ships `postgres` with no ACL at all,
   which means PUBLIC may connect — so `metabase_reader` could open a session
   on a database that has nothing to do with reporting and read the shared
   system catalogues from there. `scripts/reporting/verify-roles.js` found
   exactly that and it is closed here.

   Superusers bypass database ACLs, so the owner is unaffected. Revoking from
   PUBLIC rather than from the role by name is what also covers any role added
   later. */
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;

/* And the template database, which is itself connectable by default and is no
   business of the reader's.

   NOTE, because it is easy to assume otherwise and it was assumed here first:
   this does NOT close databases created later. A database-level ACL lives on
   the `pg_database` row, and `CREATE DATABASE` does not copy it from the
   template — a new database comes up with `datacl = NULL`, which means the
   default, which includes CONNECT for PUBLIC. Verified directly rather than
   reasoned about.

   So ANY NEW DATABASE ON THIS SERVER IS OPEN TO `metabase_reader` UNTIL
   SOMEONE REVOKES IT. That is an operational fact, not something this file can
   fix: re-run this script after adding a database, or add the revoke to
   whatever creates it. `test/reporting/mart-sync-integration.test.js` does
   exactly that for its throwaway database. */
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;

GRANT CONNECT ON DATABASE :"db_name" TO reporting_sync, metabase_reader;
GRANT USAGE ON SCHEMA reporting TO reporting_sync, metabase_reader;

-- Neither role may create anything, anywhere.
REVOKE CREATE ON SCHEMA reporting FROM reporting_sync, metabase_reader, PUBLIC;
REVOKE CREATE ON SCHEMA public    FROM reporting_sync, metabase_reader, PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- reporting_sync — data in, data out, shape untouched
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reporting TO reporting_sync;
-- `fact_voucher_line.line_id` and `mart_sync_run.run_id` are bigserial, so the
-- writer needs nextval on their sequences. That is the only sequence privilege
-- it gets, and the reader gets none.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA reporting TO reporting_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reporting_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting
  GRANT USAGE, SELECT ON SEQUENCES TO reporting_sync;

-- TRUNCATE is deliberately withheld. The refresh is a scoped DELETE inside a
-- transaction; TRUNCATE cannot be scoped to one company and would turn a bug in
-- the company loop into the loss of every company's data.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA reporting FROM reporting_sync;

-- ─────────────────────────────────────────────────────────────────────────────
-- metabase_reader — SELECT on the approved objects, and nothing else anywhere
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM metabase_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting FROM metabase_reader;

-- Named one at a time rather than ALL TABLES: a table added by a future
-- migration must be considered before it is exposed, not exposed because it
-- happened to land in this schema. There is no ALTER DEFAULT PRIVILEGES for
-- this role for the same reason.
GRANT SELECT ON reporting.dim_company        TO metabase_reader;
GRANT SELECT ON reporting.dim_group          TO metabase_reader;
GRANT SELECT ON reporting.dim_ledger         TO metabase_reader;
GRANT SELECT ON reporting.fact_voucher       TO metabase_reader;
GRANT SELECT ON reporting.fact_voucher_line  TO metabase_reader;
GRANT SELECT ON reporting.v_general_ledger   TO metabase_reader;
GRANT SELECT ON reporting.v_trial_balance    TO metabase_reader;

-- The run log is operational, not accounting data. The reader is shown it so a
-- "data as of" question can be answered from the same connection, and it holds
-- no financial figures and no secrets.
GRANT SELECT ON reporting.mart_sync_run      TO metabase_reader;

-- Belt and braces: no write verb on anything that exists now, including the
-- objects just granted SELECT.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA reporting FROM metabase_reader;

COMMENT ON ROLE reporting_sync  IS 'Mart sync writer: DML on schema reporting only. No DDL, no other schema.';
COMMENT ON ROLE metabase_reader IS 'Metabase connection: SELECT only, on named reporting objects. Must never own or write anything.';
