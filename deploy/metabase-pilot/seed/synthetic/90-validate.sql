-- 90-validate.sql — the seed refuses to come up wrong.
--
-- Runs last. Every check RAISES EXCEPTION, which aborts the init script and
-- leaves the container unhealthy, so a broken dataset fails at `make up`
-- rather than three days later inside a report somebody is about to send.

\set ON_ERROR_STOP on
SET search_path TO accounting;

DO $$
DECLARE
  bad         record;
  n           bigint;
  leaked      text;
  -- Anything in this list appearing in a name means real data has been pasted
  -- into what is supposed to be a synthetic fixture.
  forbidden   text[] := ARRAY['grav', 'ray and companies', 'rayandcompanies', '@grav.in'];
  secretish   text[] := ARRAY['password', 'secret', 'api_key', 'apikey', 'bearer ', 'mongodb://', 'mongodb+srv'];
BEGIN
  -- ── 1. Not empty ─────────────────────────────────────────────────────────
  SELECT count(*) INTO n FROM vouchers;
  IF n = 0 THEN RAISE EXCEPTION 'seed validation: no vouchers'; END IF;
  SELECT count(*) INTO n FROM voucher_lines;
  IF n = 0 THEN RAISE EXCEPTION 'seed validation: no voucher_lines'; END IF;
  SELECT count(*) INTO n FROM companies;
  IF n < 2 THEN RAISE EXCEPTION 'seed validation: expected 2 companies, found %', n; END IF;
  SELECT count(*) INTO n FROM bank_transactions;
  IF n = 0 THEN RAISE EXCEPTION 'seed validation: no bank_transactions'; END IF;
  SELECT count(*) INTO n FROM budget_allocations;
  IF n = 0 THEN RAISE EXCEPTION 'seed validation: no budget_allocations'; END IF;

  -- ── 2. Every voucher balances ────────────────────────────────────────────
  -- The one property an accounting dataset cannot be useful without. Checked
  -- for EVERY voucher including cancelled ones: a cancelled voucher is still a
  -- real double entry, it is simply not live.
  FOR bad IN
    SELECT voucher_id, SUM(signed_amount) AS imbalance
    FROM voucher_lines GROUP BY voucher_id HAVING SUM(signed_amount) <> 0
  LOOP
    RAISE EXCEPTION 'seed validation: voucher % does not balance (sum of signed lines = %)',
      bad.voucher_id, bad.imbalance;
  END LOOP;

  -- signed_amount must agree with dr_cr/amount, or the balance check above is
  -- checking a column nobody populates correctly.
  SELECT count(*) INTO n FROM voucher_lines
   WHERE signed_amount <> (CASE WHEN dr_cr = 'Dr' THEN amount ELSE -amount END);
  IF n > 0 THEN
    RAISE EXCEPTION 'seed validation: % line(s) have signed_amount inconsistent with dr_cr/amount', n;
  END IF;

  -- ── 3. Referential integrity ─────────────────────────────────────────────
  -- The foreign keys already enforce this; these catch a row pointing at a
  -- DIFFERENT company's ledger, which no FK can see.
  SELECT count(*) INTO n
    FROM voucher_lines vl JOIN ledgers l ON l.ledger_id = vl.ledger_id
   WHERE l.company_id <> vl.company_id;
  IF n > 0 THEN RAISE EXCEPTION 'seed validation: % voucher_line(s) reference another company''s ledger', n; END IF;

  SELECT count(*) INTO n
    FROM voucher_lines vl JOIN vouchers v ON v.voucher_id = vl.voucher_id
   WHERE v.company_id <> vl.company_id;
  IF n > 0 THEN RAISE EXCEPTION 'seed validation: % voucher_line(s) belong to another company''s voucher', n; END IF;

  SELECT count(*) INTO n
    FROM bank_transactions bt JOIN ledgers l ON l.ledger_id = bt.ledger_id
   WHERE l.company_id <> bt.company_id;
  IF n > 0 THEN RAISE EXCEPTION 'seed validation: % bank_transaction(s) reference another company''s ledger', n; END IF;

  -- ── 4. Nothing real, nothing secret ──────────────────────────────────────
  SELECT string_agg(DISTINCT hit, ', ') INTO leaked FROM (
    SELECT company_name AS hit FROM companies
    UNION ALL SELECT party_name FROM parties
    UNION ALL SELECT ledger_name FROM ledgers
    UNION ALL SELECT COALESCE(narration,'') FROM vouchers
    UNION ALL SELECT narration FROM bank_transactions
  ) AS t
  WHERE EXISTS (SELECT 1 FROM unnest(forbidden) f WHERE lower(t.hit) LIKE '%' || f || '%')
     OR EXISTS (SELECT 1 FROM unnest(secretish) s WHERE lower(t.hit) LIKE '%' || s || '%');

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'seed validation: fixture text looks like real GRAV data or a credential: %', leaked;
  END IF;

  -- Every company must be visibly a sample, so nobody mistakes a pilot screen
  -- for production.
  SELECT count(*) INTO n FROM companies WHERE company_name NOT ILIKE '%(sample)%';
  IF n > 0 THEN RAISE EXCEPTION 'seed validation: % company/companies are not marked (Sample)', n; END IF;

  RAISE NOTICE 'seed validation passed: % vouchers, % lines, all balanced',
    (SELECT count(*) FROM vouchers), (SELECT count(*) FROM voucher_lines);
END $$;
