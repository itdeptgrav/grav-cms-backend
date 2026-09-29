-- 10-schema.sql — synthetic Accounting reporting schema for the local pilot.
--
-- SYNTHETIC DATA ONLY. Nothing here is copied from, derived from, or shaped to
-- match any real GRAV customer, supplier, ledger, voucher or employee.
--
-- The shape deliberately mirrors the mart proposed in
-- docs/decisions/accounting-metabase-self-service-reporting.md: dimensions plus
-- a FLATTENED voucher-line fact, because the thing that makes Accounting
-- unqueryable in the visual builder is `Acc_Voucher.ledgerEntries[]` being an
-- embedded array two levels deep. One row per line is the whole point.

CREATE SCHEMA IF NOT EXISTS accounting;
SET search_path TO accounting;

CREATE TABLE companies (
  company_id      text PRIMARY KEY,
  company_name    text NOT NULL,
  gstin           text,
  state_code      text,
  books_from_date date NOT NULL,
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE account_groups (
  group_id    text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies(company_id),
  group_name  text NOT NULL,
  -- asset / liability / income / expense — what a trial balance rolls up by.
  nature      text NOT NULL CHECK (nature IN ('asset','liability','income','expense')),
  is_primary  boolean NOT NULL DEFAULT true
);

CREATE TABLE ledgers (
  ledger_id   text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies(company_id),
  group_id    text NOT NULL REFERENCES account_groups(group_id),
  ledger_name text NOT NULL,
  nature      text NOT NULL CHECK (nature IN ('asset','liability','income','expense')),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE parties (
  party_id    text PRIMARY KEY,
  company_id  text NOT NULL REFERENCES companies(company_id),
  ledger_id   text NOT NULL REFERENCES ledgers(ledger_id),
  party_name  text NOT NULL,
  party_type  text NOT NULL CHECK (party_type IN ('customer','supplier')),
  gstin       text,
  state       text,
  credit_days integer NOT NULL DEFAULT 30
);

CREATE TABLE vouchers (
  voucher_id     text PRIMARY KEY,
  company_id     text NOT NULL REFERENCES companies(company_id),
  voucher_number text NOT NULL,
  voucher_type   text NOT NULL
    CHECK (voucher_type IN ('sales','purchase','receipt','payment','journal','contra')),
  voucher_date   date NOT NULL,
  party_id       text REFERENCES parties(party_id),
  narration      text,
  -- Reporting must filter on this rather than assume a row is live. Cancelled
  -- vouchers are kept so a correction is auditable.
  status         text NOT NULL DEFAULT 'posted'
    CHECK (status IN ('draft','pending_approval','posted','cancelled')),
  grand_total    numeric(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE voucher_lines (
  line_id       bigserial PRIMARY KEY,
  voucher_id    text NOT NULL REFERENCES vouchers(voucher_id),
  company_id    text NOT NULL REFERENCES companies(company_id),
  line_no       integer NOT NULL,
  ledger_id     text NOT NULL REFERENCES ledgers(ledger_id),
  party_id      text REFERENCES parties(party_id),
  dr_cr         text NOT NULL CHECK (dr_cr IN ('Dr','Cr')),
  amount        numeric(14,2) NOT NULL CHECK (amount >= 0),
  -- +Dr / -Cr. Carried rather than derived so "does this voucher balance" is
  -- SUM(signed_amount) = 0 — one group-by, no CASE expression, and something a
  -- non-technical accountant can build in the query builder unaided.
  signed_amount numeric(14,2) NOT NULL,
  gst_rate      numeric(5,2),
  taxable_value numeric(14,2),
  tax_amount    numeric(14,2),
  UNIQUE (voucher_id, line_no)
);

CREATE TABLE bank_transactions (
  bank_txn_id  text PRIMARY KEY,
  company_id   text NOT NULL REFERENCES companies(company_id),
  ledger_id    text NOT NULL REFERENCES ledgers(ledger_id),
  txn_date     date NOT NULL,
  narration    text NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('inflow','outflow')),
  amount       numeric(14,2) NOT NULL CHECK (amount >= 0),
  voucher_id   text REFERENCES vouchers(voucher_id),
  is_reconciled boolean NOT NULL DEFAULT false
);

CREATE TABLE budget_allocations (
  budget_id    text PRIMARY KEY,
  company_id   text NOT NULL REFERENCES companies(company_id),
  ledger_id    text NOT NULL REFERENCES ledgers(ledger_id),
  period_month date NOT NULL,          -- first day of the month
  allocated    numeric(14,2) NOT NULL,
  department   text
);

-- Indexes on what the pilot reports actually group by.
CREATE INDEX ON voucher_lines (company_id, ledger_id);
CREATE INDEX ON voucher_lines (voucher_id);
CREATE INDEX ON vouchers (company_id, voucher_date);
CREATE INDEX ON vouchers (company_id, voucher_type, status);
CREATE INDEX ON bank_transactions (company_id, txn_date);
CREATE INDEX ON budget_allocations (company_id, period_month);

COMMENT ON SCHEMA accounting IS
  'SYNTHETIC pilot data. Not GRAV production data. See deploy/metabase-pilot/README.md.';
