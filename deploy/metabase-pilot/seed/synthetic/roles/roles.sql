-- 20-roles.sql — the role Metabase connects as.
--
-- Metabase does NOT connect as the owner. It connects as `metabase_readonly`,
-- which can run SELECT and nothing else. This is the pilot's rehearsal of the
-- production boundary in the decision doc: the visual query builder is only
-- safe to hand to an accountant if the connection underneath it is incapable
-- of changing anything, whatever the builder is persuaded to emit.
--
-- Read-only is asserted by REMOVING privileges, not by trusting that none were
-- granted. Postgres gives every role membership of `PUBLIC`, and before v15
-- PUBLIC could CREATE in `public` — so the revokes below matter even though
-- this is a fresh database.

\set ON_ERROR_STOP on

SET search_path TO accounting;

-- The password arrives from the container environment, so it is never written
-- into a file that could be committed.
CREATE ROLE metabase_readonly LOGIN PASSWORD :'readonly_password';

-- Connect to THIS database only.
REVOKE ALL ON DATABASE reporting FROM PUBLIC;
GRANT CONNECT ON DATABASE reporting TO metabase_readonly;

-- Read the reporting schema; create nothing anywhere.
GRANT USAGE ON SCHEMA accounting TO metabase_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA accounting TO metabase_readonly;
REVOKE CREATE ON SCHEMA accounting FROM metabase_readonly, PUBLIC;
REVOKE CREATE ON SCHEMA public    FROM metabase_readonly, PUBLIC;

-- Sequences: readable for completeness, never usable (nextval is a write).
REVOKE ALL ON ALL SEQUENCES IN SCHEMA accounting FROM metabase_readonly, PUBLIC;

-- Tables added later inherit SELECT and nothing else.
ALTER DEFAULT PRIVILEGES IN SCHEMA accounting GRANT SELECT ON TABLES TO metabase_readonly;

-- Belt and braces: no write verb on anything that exists now.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA accounting FROM metabase_readonly;

COMMENT ON ROLE metabase_readonly IS
  'Local pilot: SELECT-only on accounting schema. Must never own or write anything.';
