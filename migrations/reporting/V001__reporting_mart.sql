-- V001__reporting_mart.sql
--
-- THE ACCOUNTING REPORTING MART.
--
-- Slice 1+2+3 of docs/decisions/accounting-metabase-self-service-reporting.md:
-- dimensions, the flattened voucher-line fact, and the run log. Synced from
-- MongoDB by services/reporting/martSync.service.js. Nothing writes here except
-- that sync.
--
-- ── WHY THIS SCHEMA EXISTS AT ALL ───────────────────────────────────────────
-- `Acc_Voucher.ledgerEntries[]` is an embedded array two levels deep. Every
-- report an accountant actually wants — trial balance, general ledger, party
-- ledger, P&L, ageing — is a group-by over those entries, and a visual query
-- builder cannot express "explode this array, then group" against a document
-- store. `fact_voucher_line`, one row per array element, is what makes the
-- whole thing queryable. It is the table that earns the project.
--
-- ── EVERY DIMENSION AND FACT ROW CARRIES ────────────────────────────────────
--   organization_id text NOT NULL   materialised by the sync from
--                                   Acc_Organization.tallyCompanyIds, which is
--                                   the ONLY ownership record in the system —
--                                   financial documents carry companyId and no
--                                   organizationId at all. This column is the
--                                   future row-level-security sandbox key, so
--                                   a row without it is worse than useless.
--   company_id      text NOT NULL   the Mongo Acc_Company._id
--   source_id       text NOT NULL   the Mongo _id of the row's own document
--                                   (for a voucher line, the subdocument _id)
--   source_updated_at timestamptz   the source document's updatedAt, nullable
--                                   because older documents predate timestamps
--   synced_at       timestamptz NOT NULL   when this row was written
--
-- ── MONEY IS NUMERIC, NEVER FLOAT ───────────────────────────────────────────
-- Mongo stores these as IEEE-754 doubles. Summing this company's 5,889 posted
-- lines in double precision gives a company-wide imbalance of -1.31e-10 —
-- which is zero, but is not equal to zero, and "is the ledger balanced" is a
-- question the mart has to answer with a straight yes. numeric(18,2) makes the
-- rounding happen once, on the way in, where it can be seen.
--
-- ── FOREIGN KEYS: ONLY WHERE THEY ARE TRUE ──────────────────────────────────
-- Two are declared, and the rest are deliberately not:
--
--   fact_* and dim_* → dim_company    every row belongs to a synced company
--   fact_voucher_line → fact_voucher  a line cannot outlive its voucher
--
-- NOT declared, because the source does not guarantee them: `dim_ledger.group_id`
-- → `dim_group`, `fact_voucher_line.ledger_id` → `dim_ledger`, and
-- `dim_group.parent_group_id` → itself. Acc_import.js, Acc_merge.js and
-- Acc_chartOfAccounts.js all HARD DELETE ledgers and groups
-- (`Acc_Ledger.deleteMany`, `Acc_Group.deleteMany`), so a historical voucher
-- line can legitimately reference a ledger that no longer exists. A foreign key
-- there would not protect the data; it would make the sync fail on data that is
-- already in the books. Indexes give the join performance without the false
-- promise.
--
-- The two that ARE declared do not prevent a transactional refresh because the
-- refresh respects their order — see `deleteCompany` in martSync.service.js:
-- lines, vouchers, ledgers, groups, company on the way out; the reverse on the
-- way in; all inside one transaction.

CREATE SCHEMA IF NOT EXISTS reporting;

COMMENT ON SCHEMA reporting IS
  'Accounting reporting mart, synced read-only from MongoDB. Contains no credentials, tokens, consents, bank account numbers or attachment locations.';

-- ─────────────────────────────────────────────────────────────────────────────
-- DIMENSIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reporting.dim_company (
  company_id            text        NOT NULL,
  organization_id       text        NOT NULL,
  source_id             text        NOT NULL,
  company_name          text        NOT NULL,
  company_code          text,
  -- GSTIN is restricted-but-needed: GST reporting is a core use case, so it is
  -- in the mart and gated by grant, not dropped. PAN, TAN, CIN, bank details
  -- and contact rows are NOT here at all — see the sensitive-field list in the
  -- decision doc §1.2.
  gstin                 text,
  state_code            text,
  books_from_date       date,
  financial_year_start  date,
  current_financial_year text,
  base_currency         text,
  is_primary            boolean     NOT NULL DEFAULT false,
  is_active             boolean     NOT NULL DEFAULT true,
  source_updated_at     timestamptz,
  synced_at             timestamptz NOT NULL,
  CONSTRAINT dim_company_pkey PRIMARY KEY (company_id),
  CONSTRAINT dim_company_source_id_key UNIQUE (source_id)
);

CREATE TABLE reporting.dim_group (
  group_id            text        NOT NULL,
  organization_id     text        NOT NULL,
  company_id          text        NOT NULL,
  source_id           text        NOT NULL,
  group_name          text        NOT NULL,
  parent_group_id     text,
  parent_group_name   text,
  nature              text        NOT NULL,
  is_primary          boolean     NOT NULL DEFAULT false,
  is_reserved         boolean     NOT NULL DEFAULT false,
  level               integer,
  full_path           text,
  is_active           boolean     NOT NULL DEFAULT true,
  source_updated_at   timestamptz,
  synced_at           timestamptz NOT NULL,
  CONSTRAINT dim_group_pkey PRIMARY KEY (group_id),
  CONSTRAINT dim_group_source_id_key UNIQUE (source_id),
  CONSTRAINT dim_group_company_fkey
    FOREIGN KEY (company_id) REFERENCES reporting.dim_company (company_id)
);

CREATE INDEX dim_group_company_idx ON reporting.dim_group (company_id);
CREATE INDEX dim_group_org_idx     ON reporting.dim_group (organization_id);
CREATE INDEX dim_group_parent_idx  ON reporting.dim_group (parent_group_id);

CREATE TABLE reporting.dim_ledger (
  ledger_id             text        NOT NULL,
  organization_id       text        NOT NULL,
  company_id            text        NOT NULL,
  source_id             text        NOT NULL,
  ledger_name           text        NOT NULL,
  group_id              text,
  group_name            text,
  nature                text,
  gstin                 text,
  -- The ledger's configured opening balance, signed (+Dr / −Cr) exactly as the
  -- source stores it. `bankDetails.accountNumber`, `panNumber` and the contact
  -- block are excluded entirely.
  opening_balance       numeric(18,2) NOT NULL DEFAULT 0,
  opening_balance_type  text,
  is_active             boolean     NOT NULL DEFAULT true,
  source_updated_at     timestamptz,
  synced_at             timestamptz NOT NULL,
  CONSTRAINT dim_ledger_pkey PRIMARY KEY (ledger_id),
  CONSTRAINT dim_ledger_source_id_key UNIQUE (source_id),
  CONSTRAINT dim_ledger_company_fkey
    FOREIGN KEY (company_id) REFERENCES reporting.dim_company (company_id)
);

CREATE INDEX dim_ledger_company_idx ON reporting.dim_ledger (company_id);
CREATE INDEX dim_ledger_org_idx     ON reporting.dim_ledger (organization_id);
CREATE INDEX dim_ledger_group_idx   ON reporting.dim_ledger (company_id, group_id);
CREATE INDEX dim_ledger_name_idx    ON reporting.dim_ledger (company_id, ledger_name);

-- ─────────────────────────────────────────────────────────────────────────────
-- FACTS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE reporting.fact_voucher (
  voucher_id          text        NOT NULL,
  organization_id     text        NOT NULL,
  company_id          text        NOT NULL,
  source_id           text        NOT NULL,
  voucher_number      text,
  voucher_type        text        NOT NULL,
  voucher_type_name   text,
  voucher_date        date        NOT NULL,
  due_date            date,
  reference_number    text,
  party_ledger_id     text,
  party_ledger_name   text,
  narration           text,
  -- The full lifecycle is retained: draft | pending_approval | posted |
  -- cancelled | void. The curated views filter it; the table never hides it,
  -- because a correction is only auditable if the cancelled original is still
  -- there to look at.
  status              text        NOT NULL,
  is_live             boolean     NOT NULL DEFAULT true,
  is_optional         boolean     NOT NULL DEFAULT false,
  financial_year      text,
  -- First day of the voucher's month. The period grain every reconciliation
  -- and most reports group by; stored rather than derived so the query builder
  -- can group by it without a date function.
  period_month        date        NOT NULL,
  grand_total         numeric(18,2) NOT NULL DEFAULT 0,
  line_count          integer     NOT NULL DEFAULT 0,
  source_updated_at   timestamptz,
  synced_at           timestamptz NOT NULL,
  CONSTRAINT fact_voucher_pkey PRIMARY KEY (voucher_id),
  CONSTRAINT fact_voucher_source_id_key UNIQUE (source_id),
  CONSTRAINT fact_voucher_company_fkey
    FOREIGN KEY (company_id) REFERENCES reporting.dim_company (company_id),
  CONSTRAINT fact_voucher_status_check
    CHECK (status IN ('draft','pending_approval','posted','cancelled','void'))
);

CREATE INDEX fact_voucher_company_date_idx ON reporting.fact_voucher (company_id, voucher_date);
CREATE INDEX fact_voucher_org_idx          ON reporting.fact_voucher (organization_id);
CREATE INDEX fact_voucher_status_idx       ON reporting.fact_voucher (company_id, status);
CREATE INDEX fact_voucher_period_idx       ON reporting.fact_voucher (company_id, period_month);
CREATE INDEX fact_voucher_party_idx        ON reporting.fact_voucher (company_id, party_ledger_id);

-- THE GRAIN IS EXACTLY ONE `ledgerEntries[]` ELEMENT. Not one voucher, not one
-- bill allocation. Voucher header attributes are denormalised onto the line so
-- the common questions — "posted sales by ledger by month" — are a single
-- group-by with no join, which is what a non-technical user can build unaided.
CREATE TABLE reporting.fact_voucher_line (
  line_id             bigserial   NOT NULL,
  organization_id     text        NOT NULL,
  company_id          text        NOT NULL,
  source_id           text        NOT NULL,
  voucher_id          text        NOT NULL,
  line_no             integer     NOT NULL,
  voucher_date        date        NOT NULL,
  voucher_type        text        NOT NULL,
  voucher_type_name   text,
  voucher_number      text,
  voucher_status      text        NOT NULL,
  is_live             boolean     NOT NULL DEFAULT true,
  is_optional         boolean     NOT NULL DEFAULT false,
  period_month        date        NOT NULL,
  financial_year      text,
  ledger_id           text,
  ledger_name         text        NOT NULL,
  group_name          text,
  party_ledger_id     text,
  party_ledger_name   text,
  dr_cr               text        NOT NULL,
  amount              numeric(18,2) NOT NULL,
  -- Split out so "debit total / credit total" is a plain SUM in the builder
  -- rather than a CASE expression the user has to compose correctly.
  debit               numeric(18,2) NOT NULL DEFAULT 0,
  credit              numeric(18,2) NOT NULL DEFAULT 0,
  -- +Dr / −Cr. The source already carries this (`ledgerEntrySchema.signedAmount`),
  -- so the mart inherits a balancing column rather than deriving one — and
  -- "does this company balance" becomes SUM(signed_amount) = 0, one group-by.
  signed_amount       numeric(18,2) NOT NULL,
  is_party_ledger     boolean     NOT NULL DEFAULT false,
  gst_classification  text,
  narration           text,
  source_updated_at   timestamptz,
  synced_at           timestamptz NOT NULL,
  CONSTRAINT fact_voucher_line_pkey PRIMARY KEY (line_id),
  -- The idempotency key. A re-run must not be able to double a line.
  CONSTRAINT fact_voucher_line_source_id_key UNIQUE (source_id),
  -- And the grain, stated as a constraint: one row per voucher per position.
  CONSTRAINT fact_voucher_line_grain_key UNIQUE (voucher_id, line_no),
  CONSTRAINT fact_voucher_line_voucher_fkey
    FOREIGN KEY (voucher_id) REFERENCES reporting.fact_voucher (voucher_id),
  CONSTRAINT fact_voucher_line_company_fkey
    FOREIGN KEY (company_id) REFERENCES reporting.dim_company (company_id),
  CONSTRAINT fact_voucher_line_dr_cr_check CHECK (dr_cr IN ('Dr','Cr')),
  CONSTRAINT fact_voucher_line_amount_check CHECK (amount >= 0),
  -- The three money columns are one fact expressed three ways; they must agree
  -- or every report built on any one of them is wrong.
  CONSTRAINT fact_voucher_line_sides_check CHECK (
    (dr_cr = 'Dr' AND debit = amount  AND credit = 0 AND signed_amount =  amount) OR
    (dr_cr = 'Cr' AND credit = amount AND debit  = 0 AND signed_amount = -amount)
  )
);

CREATE INDEX fact_voucher_line_company_ledger_idx ON reporting.fact_voucher_line (company_id, ledger_id);
CREATE INDEX fact_voucher_line_org_idx            ON reporting.fact_voucher_line (organization_id);
CREATE INDEX fact_voucher_line_voucher_idx        ON reporting.fact_voucher_line (voucher_id);
CREATE INDEX fact_voucher_line_period_idx         ON reporting.fact_voucher_line (company_id, period_month);
CREATE INDEX fact_voucher_line_status_idx         ON reporting.fact_voucher_line (company_id, voucher_status);
CREATE INDEX fact_voucher_line_date_idx           ON reporting.fact_voucher_line (company_id, voucher_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- RUN LOG
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One row per company per sync attempt, grouped by `run_key`. A failed attempt
-- is recorded as failed and its data is rolled back — the previous successful
-- dataset stays current. "Data as of" is the latest `finished_at` among
-- succeeded rows, which is what the UI should show and what a stale mart fails
-- to move.
CREATE TABLE reporting.mart_sync_run (
  run_id            bigserial   NOT NULL,
  run_key           uuid        NOT NULL,
  run_mode          text        NOT NULL,
  organization_id   text,
  company_id        text,
  company_name      text,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz,
  status            text        NOT NULL,
  failure_reason    text,
  source_counts     jsonb,
  mart_counts       jsonb,
  reconciliation    jsonb,
  CONSTRAINT mart_sync_run_pkey PRIMARY KEY (run_id),
  CONSTRAINT mart_sync_run_status_check
    CHECK (status IN ('running','succeeded','failed'))
);

CREATE INDEX mart_sync_run_key_idx     ON reporting.mart_sync_run (run_key);
CREATE INDEX mart_sync_run_company_idx ON reporting.mart_sync_run (company_id, started_at DESC);
CREATE INDEX mart_sync_run_status_idx  ON reporting.mart_sync_run (status, finished_at DESC);
