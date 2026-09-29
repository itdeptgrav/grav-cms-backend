-- V002__drop_synthetic_pilot_schema.sql
--
-- REMOVE THE SYNTHETIC PILOT DATASET FROM THE ACTIVE REPORTING DATABASE.
--
-- The pilot shipped an invented Accounting dataset in schema `accounting` —
-- two made-up companies, made-up parties, generated vouchers — so that the
-- question "does self-service reporting work for an accountant" could be
-- answered before any real record was at risk. It did its job.
--
-- Now that `reporting.*` holds the real mart, the synthetic schema is not
-- merely redundant, it is DANGEROUS: two schemas in one database, both full of
-- plausible-looking Accounting tables, one of which is fiction. A user browsing
-- the data picker would see `accounting.vouchers` beside
-- `reporting.fact_voucher` with nothing on screen to say which is which, and
-- the fictional numbers are the ones that are easy to build a clean-looking
-- chart from. A figure from the wrong schema in a board pack is exactly the
-- failure this whole design exists to prevent.
--
-- So it goes. It is not archived here: it was generated from nothing by
-- `deploy/metabase-pilot/seed/synthetic/15-data.sql`, which is kept in the
-- repository and can regenerate it into a throwaway database whenever it is
-- wanted for a test. Nothing is lost that cannot be made again in a second.
--
-- CASCADE because the synthetic tables reference each other. It is scoped to
-- this one schema and cannot touch `reporting`.
DROP SCHEMA IF EXISTS accounting CASCADE;

-- The read-only role the synthetic pilot created (`seed/lib/roles.sql`). It was
-- granted on `accounting`, which no longer exists, so it now has connect rights
-- and nothing to read — a login with no purpose. `metabase_reader` replaces it.
-- Dropped rather than left dormant: an account nobody uses is an account nobody
-- notices being used.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_readonly') THEN
    EXECUTE 'REVOKE ALL ON DATABASE ' || quote_ident(current_database()) || ' FROM metabase_readonly';
    EXECUTE 'DROP OWNED BY metabase_readonly';
    EXECUTE 'DROP ROLE metabase_readonly';
  END IF;
END
$$;
