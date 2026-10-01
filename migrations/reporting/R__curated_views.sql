-- R__curated_views.sql  —  REPEATABLE migration.
--
-- Re-applied whenever its checksum changes (see services/reporting/martMigrate.service.js).
-- Views only: nothing here holds data, so replacing them is always safe.
--
-- ── WHAT THE CURATED VIEWS ARE FOR ──────────────────────────────────────────
-- Self-service reporting fails in one predictable way: a user builds a
-- beautiful chart that quietly includes cancelled vouchers, and nobody notices
-- until it is in a board pack. The answer is not training. It is that the
-- objects the user is pointed at DEFAULT TO CORRECT — the exposed views carry
-- the `status = 'posted'` filter so that the wrong answer requires deliberately
-- going around them to the raw fact table.
--
-- `draft` and `pending_approval` are not accounting facts yet; `cancelled` and
-- `void` are accounting facts that were withdrawn. None of the four may enter a
-- total silently. The raw `fact_voucher_line` keeps all of them, so an audit
-- question ("what did we cancel in March?") is still answerable — it just has
-- to be asked on purpose.
--
-- ── WHY POSTED AND NOT `is_live` ────────────────────────────────────────────
-- `is_live` is false only for cancelled and void (Acc_VoucherModels.js:680), so
-- on its own it would still admit drafts. Both are applied: `is_live` is the
-- source's own recomputed flag and `status = 'posted'` is the accounting rule,
-- and where they disagree the sync has a bug worth failing on.
--
-- ── OPTIONAL VOUCHERS ARE A KNOWN DIVERGENCE ────────────────────────────────
-- Tally's "Optional" vouchers are planning-only and not posted to the ledger
-- (`Acc_VoucherModels.js:408`). The existing trial balance in
-- `routes/Accountant_Routes/Acc_books.js:76` does NOT filter them out, while
-- the Lane B party reports DO. The two in-app reports therefore disagree with
-- each other about a posted+optional voucher.
--
-- These views match `Acc_books.js`, because that is the calculation the
-- reconciliation gate is required to match exactly — and `is_optional` is
-- carried as a column so the divergence is visible and filterable rather than
-- silently resolved here. There are currently ZERO posted+optional vouchers in
-- the source, so the two definitions agree today; `martReconcile.service.js`
-- raises `POSTED_OPTIONAL_VOUCHERS` the moment that stops being true, because
-- at that point the mart cannot match both reports and a person has to decide
-- which one is right.

-- ─────────────────────────────────────────────────────────────────────────────
-- v_general_ledger — one row per posted voucher line, ready to group by.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── WHY THE LEDGER IS RESOLVED THROUGH dim_ledger ───────────────────────────
-- `fact_voucher_line` carries `group_name` as the source wrote it ON THE LINE,
-- and the source usually does not write it at all: 4,581 of GRAV CLOTHING's
-- posted lines have no group on the line while the ledger master has one for
-- every single ledger. Reading the line's own column therefore put more than
-- half the money in an unnamed bucket the moment anyone grouped by Ledger
-- Group — silently, and only in this view, because `v_trial_balance` below has
-- always resolved it through `dim_ledger`. Two curated views disagreeing about
-- which group a ledger is in is worse than either answer.
--
-- A ledger's group is an attribute of the ledger, not of the transaction, so
-- the dimension wins and the line's own value is the fallback for a ledger the
-- dimension no longer has. The name is resolved the same way and for the same
-- reason, with the voucher's own spelling kept as `ledger_name_on_voucher` so
-- a rename is still explainable.
CREATE OR REPLACE VIEW reporting.v_general_ledger AS
SELECT
  l.organization_id,
  l.company_id,
  c.company_name,
  l.voucher_id,
  l.voucher_number,
  l.voucher_type,
  l.voucher_type_name,
  l.voucher_date,
  l.period_month,
  l.financial_year,
  l.line_no,
  l.ledger_id,
  COALESCE(d.ledger_name, l.ledger_name)  AS ledger_name,
  COALESCE(d.group_name, l.group_name)    AS group_name,
  l.party_ledger_id,
  l.party_ledger_name,
  l.dr_cr,
  l.amount,
  l.debit,
  l.credit,
  l.signed_amount,
  l.is_party_ledger,
  l.gst_classification,
  l.narration,
  l.is_optional,
  l.synced_at,
  -- Appended rather than placed beside `ledger_name`, which reads better but
  -- costs a DROP: CREATE OR REPLACE VIEW may add columns at the end and may
  -- not reorder them, and dropping this view would take its grants with it.
  l.ledger_name                           AS ledger_name_on_voucher,
  d.nature                                AS ledger_nature
FROM reporting.fact_voucher_line l
JOIN reporting.dim_company c ON c.company_id = l.company_id
-- LEFT, and never INNER, for the reason spelled out on v_trial_balance: a
-- ledger can be hard-deleted while its history stays in the books, and a
-- general ledger that quietly drops those lines is not a general ledger.
-- `dim_ledger`'s primary key is `ledger_id`, so this join can never duplicate
-- a line — the row count of this view is exactly the posted line count.
LEFT JOIN reporting.dim_ledger d ON d.ledger_id = l.ledger_id
WHERE l.voucher_status = 'posted'
  AND l.is_live;

COMMENT ON VIEW reporting.v_general_ledger IS
  'Posted, live voucher lines only — one row per ledgerEntries[] element. Draft, pending_approval, cancelled and void vouchers are excluded. Use fact_voucher_line directly to audit those.';

-- ─────────────────────────────────────────────────────────────────────────────
-- v_trial_balance — movement per ledger, per period.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The grain is (company, ledger, period_month) rather than (company, ledger),
-- so a user can total a month, a quarter or a year by filtering instead of
-- needing a different view for each. Summing every period for a ledger gives
-- the same debit and credit totals as the aggregation in `Acc_books.js:103-131`,
-- which is what `martReconcile.service.js` asserts before a sync is allowed to
-- commit.
--
-- `opening_balance` comes from `dim_ledger` and is the ledger's CONFIGURED
-- opening (signed, +Dr/−Cr) — it is repeated on every period row for
-- convenience and must not be summed across periods.
CREATE OR REPLACE VIEW reporting.v_trial_balance AS
SELECT
  l.organization_id,
  l.company_id,
  c.company_name,
  l.period_month,
  l.ledger_id,
  -- The line carries the name as it was written on the voucher, which survives
  -- a later ledger rename; dim_ledger carries the current one. Both are here
  -- because "why does this month say something different" is otherwise an
  -- unanswerable question.
  COALESCE(d.ledger_name, l.ledger_name)     AS ledger_name,
  l.ledger_name                              AS ledger_name_on_voucher,
  d.group_id,
  COALESCE(d.group_name, l.group_name)       AS group_name,
  d.nature,
  d.is_active                                AS ledger_is_active,
  d.opening_balance,
  SUM(l.debit)                               AS debit_total,
  SUM(l.credit)                              AS credit_total,
  SUM(l.signed_amount)                       AS net_movement,
  COUNT(*)                                   AS line_count,
  COUNT(DISTINCT l.voucher_id)               AS voucher_count,
  MAX(l.synced_at)                           AS synced_at
FROM reporting.fact_voucher_line l
JOIN reporting.dim_company c ON c.company_id = l.company_id
-- LEFT, not INNER: ledgers are hard-deleted elsewhere in the product, so a
-- historical line can point at a ledger that no longer exists. An inner join
-- would silently drop that money out of the trial balance, which is the one
-- thing a trial balance may never do.
LEFT JOIN reporting.dim_ledger d ON d.ledger_id = l.ledger_id
WHERE l.voucher_status = 'posted'
  AND l.is_live
GROUP BY
  l.organization_id, l.company_id, c.company_name, l.period_month, l.ledger_id,
  d.ledger_name, l.ledger_name, d.group_id, d.group_name, l.group_name,
  d.nature, d.is_active, d.opening_balance;

COMMENT ON VIEW reporting.v_trial_balance IS
  'Posted movement per ledger per month. SUM(net_movement) over a whole company and period is 0 for balanced books. opening_balance is the ledger''s configured opening and is repeated per period — do not sum it.';
