-- V003__voucher_register_view.sql
--
-- `reporting.v_voucher_register` — one row per POSTED voucher.
--
-- The third curated subject the Custom Reports designer offers, beside
-- `v_general_ledger` (one row per line) and `v_trial_balance` (movement per
-- ledger per month). It exists because "show me the vouchers" is the question
-- an accountant asks first, and answering it from `v_general_ledger` would
-- return one row per LINE — a two-line journal appearing twice, with its
-- amount double-counted the moment anyone totals it.
--
-- ── GRAIN: ONE VOUCHER ──────────────────────────────────────────────────────
-- Header attributes come from `fact_voucher`; the money is aggregated from that
-- voucher's posted lines. `debit_amount` and `credit_amount` are the sums of
-- each side, which for a balanced voucher are equal — and `total_amount` is
-- that same figure rather than their sum, because a ₹10,000 sale is ₹10,000 of
-- business, not ₹20,000. Adding the two sides together is the single easiest
-- way to double a revenue figure in a self-service tool, so the column the user
-- will reach for first is the one that cannot do it.
--
-- `grand_total` is carried separately, as the header's OWN stated total, so the
-- two can be compared rather than conflated. They are usually equal; where they
-- are not, that is a fact about the voucher worth seeing.
--
-- ── POSTED AND LIVE, LIKE THE OTHER CURATED VIEWS ───────────────────────────
-- Draft, pending_approval, cancelled and void are excluded here exactly as they
-- are in `v_general_ledger`. A voucher with no posted lines does not appear at
-- all: the join is INNER, because a row whose amounts would all be zero is not
-- a voucher an accountant is looking for and would quietly pad every count.

CREATE OR REPLACE VIEW reporting.v_voucher_register AS
SELECT
  v.organization_id,
  v.company_id,
  c.company_name,
  v.voucher_id,
  v.voucher_number,
  v.voucher_type,
  v.voucher_type_name,
  v.voucher_date,
  v.due_date,
  v.period_month,
  v.financial_year,
  v.reference_number,
  v.party_ledger_id,
  v.party_ledger_name,
  v.narration,
  v.is_optional,
  SUM(l.debit)                      AS debit_amount,
  SUM(l.credit)                     AS credit_amount,
  -- One side, not their sum. See the note above.
  SUM(l.debit)                      AS total_amount,
  v.grand_total,
  count(l.line_id)::int             AS line_count,
  v.synced_at
FROM reporting.fact_voucher v
JOIN reporting.dim_company c ON c.company_id = v.company_id
JOIN reporting.fact_voucher_line l
  ON l.voucher_id = v.voucher_id
 AND l.voucher_status = 'posted'
 AND l.is_live
WHERE v.status = 'posted'
  AND v.is_live
GROUP BY
  v.organization_id, v.company_id, c.company_name, v.voucher_id, v.voucher_number,
  v.voucher_type, v.voucher_type_name, v.voucher_date, v.due_date, v.period_month,
  v.financial_year, v.reference_number, v.party_ledger_id, v.party_ledger_name,
  v.narration, v.is_optional, v.grand_total, v.synced_at;

COMMENT ON VIEW reporting.v_voucher_register IS
  'One row per POSTED voucher. total_amount is the debit side, NOT debit+credit — summing both sides would double every figure.';

-- The reporting connection reads it; it can do nothing else with it. Named
-- explicitly rather than by a blanket grant, for the reason R__roles.sql gives:
-- a new object should be considered before it is exposed, not exposed because
-- it landed in the right schema.
GRANT SELECT ON reporting.v_voucher_register TO metabase_reader;
