// services/reporting/martReconcile.service.js
//
// THE GATE. A sync is not successful because it finished; it is successful
// because these checks passed.
//
// ── WHY THIS IS NOT OPTIONAL ────────────────────────────────────────────────
// The mart creates a SECOND source of truth for figures that get quoted in
// meetings. The only thing that keeps it honest is a check that fails loudly
// and rolls the data back, rather than warning into a log nobody reads. Every
// function here throws on mismatch; `martSync.service.js` calls them INSIDE the
// transaction, so a failure un-writes the attempt and the previous dataset
// stays current.
//
// ── THE CHECKS ──────────────────────────────────────────────────────────────
//  1  ROW COUNTS        companies, groups, ledgers, vouchers and flattened
//                       lines all match Mongo exactly.
//  2  TENANT STAMPING   every row has a non-empty organization_id and
//                       company_id, and they are the expected ones.
//  3  LINES PER VOUCHER  each voucher has exactly as many mart lines as its
//                       `ledgerEntries[]` had elements — the flattening is
//                       where a silently dropped line would hide.
//  4  PERIOD TOTALS     posted debit and credit totals agree per company and
//                       per accounting period.
//  5  BALANCE           SUM(signed_amount) is zero to the last paisa for every
//                       company/period. An UNBALANCED SOURCE is reported as
//                       such, naming the company, the period and the exact
//                       difference — not rounded away.
//  6  TRIAL BALANCE     per-ledger debit and credit totals equal the existing
//                       Accounting calculation exactly.
//
// ── "EXACTLY" MEANS TO THE PAISA ────────────────────────────────────────────
// Mongo sums these amounts as IEEE-754 doubles; the mart sums them as numeric.
// Over this company's 5,889 posted lines the double sum comes out at
// -1.31e-10 rather than 0 — so the comparison tolerance is ONE PAISA (0.005,
// half the smallest stored unit), which is tight enough to catch a real
// difference and loose enough to ignore the float artefact that made the
// numeric column necessary in the first place. It is not a fudge factor: any
// genuine discrepancy is at least 0.01.
//
// ── THE TIMEZONE MUST MATCH THE SYNC ────────────────────────────────────────
// The sync derives every date in business time (+05:30 by default) because
// `voucherDate` is stored at UTC midnight in some documents and IST midnight in
// others. These aggregates pass the SAME timezone to `$dateTrunc`. Comparing an
// IST-bucketed mart against a UTC-bucketed Mongo would make ~28% of this
// company's vouchers look misplaced and the gate would fail on correct data.

"use strict";

const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");

const BUSINESS_UTC_OFFSET_MINUTES = Number.isFinite(
  Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES),
)
  ? Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES)
  : 330;

/**
 * The timezone string Mongo's date operators need.
 *
 * `$dateTrunc` accepts either an IANA name or a `+HH:MM` offset. The offset is
 * derived from the same env var the rest of the accounting code reads, so a
 * deployment that changes it changes both sides together.
 */
function mongoTimezone() {
  const sign = BUSINESS_UTC_OFFSET_MINUTES < 0 ? "-" : "+";
  const abs = Math.abs(BUSINESS_UTC_OFFSET_MINUTES);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** One paisa, halved: the largest difference that is float noise, not money. */
const TOLERANCE = 0.005;

class ReconciliationError extends Error {
  constructor(message, report) {
    super(message);
    this.code = "RECONCILIATION_FAILED";
    this.report = report;
  }
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const near = (a, b) => Math.abs(num(a) - num(b)) <= TOLERANCE;
/** A money difference, rendered for a human. Never rounded to hide a gap. */
const diff = (a, b) => (num(a) - num(b)).toFixed(4);

/* ─────────────────────────────────────────────────────────────────────────── */
/* What the mart holds                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

async function martCounts(client, companyId) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM reporting.dim_company       WHERE company_id = $1) AS companies,
       (SELECT count(*) FROM reporting.dim_group         WHERE company_id = $1) AS groups,
       (SELECT count(*) FROM reporting.dim_ledger        WHERE company_id = $1) AS ledgers,
       (SELECT count(*) FROM reporting.fact_voucher      WHERE company_id = $1) AS vouchers,
       (SELECT count(*) FROM reporting.fact_voucher_line WHERE company_id = $1) AS voucher_lines`,
    [companyId],
  );
  const r = rows[0];
  return {
    companies: Number(r.companies),
    groups: Number(r.groups),
    ledgers: Number(r.ledgers),
    vouchers: Number(r.vouchers),
    voucherLines: Number(r.voucher_lines),
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* The source, aggregated the same way                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

/** Posted debit/credit/signed totals per period, from Mongo. */
async function sourcePeriodTotals(companyId) {
  const tz = mongoTimezone();
  const rows = await Acc_Voucher.aggregate([
    { $match: { companyId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    {
      $group: {
        _id: { $dateTrunc: { date: "$voucherDate", unit: "month", timezone: tz } },
        debit: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0],
          },
        },
        credit: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0],
          },
        },
        lines: { $sum: 1 },
      },
    },
  ]);

  const out = new Map();
  for (const r of rows) {
    // `$dateTrunc` returns the instant that starts the month IN THAT TIMEZONE,
    // i.e. 2025-07-31T18:30:00Z for July in +05:30. Shifting back into business
    // time before reading the calendar fields is what turns it into "2025-08".
    const shifted = new Date(new Date(r._id).getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60000);
    const key = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-01`;
    out.set(key, { debit: r.debit, credit: r.credit, lines: r.lines });
  }
  return out;
}

/**
 * Posted debit/credit per ledger, from Mongo.
 *
 * THIS IS THE EXISTING CALCULATION. It mirrors the aggregation in
 * `routes/Accountant_Routes/Acc_books.js:103-131` — the trial-balance route —
 * field for field: `status: "posted"`, `$unwind` on `ledgerEntries`, group by
 * `ledgerEntries.ledgerId`, debit = sum of `Dr` amounts, credit = sum of `Cr`.
 * That route also filters its ledger LIST to `isActive: true`, which affects
 * which rows it displays but not the totals it computes; the mart's
 * `v_trial_balance` carries `ledger_is_active` so the same narrowing is a
 * filter rather than a different number.
 *
 * Notably it does NOT exclude `isOptional` vouchers, while the Lane B party
 * reports DO. The mart matches this one, because this is the trial balance the
 * gate is required to match — and `postedOptionalVouchers` below raises the
 * divergence the moment it can actually bite.
 */
async function sourceLedgerTotals(companyId) {
  const rows = await Acc_Voucher.aggregate([
    { $match: { companyId, status: "posted" } },
    { $unwind: "$ledgerEntries" },
    {
      $group: {
        _id: "$ledgerEntries.ledgerId",
        debit: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0],
          },
        },
        credit: {
          $sum: {
            $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0],
          },
        },
      },
    },
  ]);

  const out = new Map();
  for (const r of rows) {
    out.set(r._id ? String(r._id) : "(no ledger)", { debit: r.debit, credit: r.credit });
  }
  return out;
}

/** `voucher_id → ledgerEntries.length`, from Mongo. */
async function sourceLineCounts(companyId) {
  const rows = await Acc_Voucher.aggregate([
    { $match: { companyId } },
    { $project: { n: { $size: { $ifNull: ["$ledgerEntries", []] } } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* The checks                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Reconcile one company. Throws `ReconciliationError` on any mismatch.
 *
 * @param {object} o
 * @param {import("pg").PoolClient} o.client  an OPEN transaction, mid-sync
 * @param {object} o.company                  the Mongo company document
 * @param {string} o.organizationId
 * @param {object} o.sourceCounts
 * @param {Array}  [o.signMismatches]         from the flattening
 * @returns {Promise<{checks: object[], warnings: object[]}>}
 */
async function reconcileCompany({
  client,
  company,
  organizationId,
  sourceCounts,
  signMismatches = [],
}) {
  const companyId = String(company._id);
  const checks = [];
  const failures = [];
  const warnings = [];

  const pass = (name, detail = {}) => checks.push({ check: name, ok: true, ...detail });
  const fail = (name, detail) => {
    checks.push({ check: name, ok: false, ...detail });
    failures.push({ check: name, ...detail });
  };

  /* ── 1. Row counts ─────────────────────────────────────────────────────── */
  const counts = await martCounts(client, companyId);
  const countMismatches = Object.entries(sourceCounts)
    .filter(([key, expected]) => counts[key] !== expected)
    .map(([key, expected]) => ({ entity: key, source: expected, mart: counts[key] }));

  if (countMismatches.length) {
    fail("row_counts", { mismatches: countMismatches });
  } else {
    pass("row_counts", { counts });
  }

  /* ── 2. Every row carries its tenant ───────────────────────────────────── */
  const { rows: untenanted } = await client.query(
    `SELECT 'dim_group' AS t, count(*) AS n FROM reporting.dim_group
        WHERE company_id = $1 AND (organization_id IS NULL OR organization_id = '' OR organization_id <> $2)
      UNION ALL
      SELECT 'dim_ledger', count(*) FROM reporting.dim_ledger
        WHERE company_id = $1 AND (organization_id IS NULL OR organization_id = '' OR organization_id <> $2)
      UNION ALL
      SELECT 'fact_voucher', count(*) FROM reporting.fact_voucher
        WHERE company_id = $1 AND (organization_id IS NULL OR organization_id = '' OR organization_id <> $2)
      UNION ALL
      SELECT 'fact_voucher_line', count(*) FROM reporting.fact_voucher_line
        WHERE company_id = $1 AND (organization_id IS NULL OR organization_id = '' OR organization_id <> $2)`,
    [companyId, organizationId],
  );
  const badTenant = untenanted.filter((r) => Number(r.n) > 0);
  if (badTenant.length) {
    fail("tenant_stamping", {
      organizationId,
      tables: badTenant.map((r) => ({ table: r.t, rows: Number(r.n) })),
    });
  } else {
    pass("tenant_stamping", { organizationId });
  }

  /* ── 3. Lines per voucher ──────────────────────────────────────────────── */
  const sourceLines = await sourceLineCounts(company._id);
  const { rows: martLines } = await client.query(
    `SELECT v.voucher_id,
            v.line_count                       AS declared,
            count(l.line_id)::int              AS actual
       FROM reporting.fact_voucher v
       LEFT JOIN reporting.fact_voucher_line l ON l.voucher_id = v.voucher_id
      WHERE v.company_id = $1
      GROUP BY v.voucher_id, v.line_count`,
    [companyId],
  );

  const lineMismatches = [];
  for (const row of martLines) {
    const expected = sourceLines.get(row.voucher_id);
    if (expected === undefined) {
      lineMismatches.push({ voucherId: row.voucher_id, reason: "voucher not in source" });
    } else if (expected !== row.actual || expected !== row.declared) {
      lineMismatches.push({
        voucherId: row.voucher_id,
        source: expected,
        martLines: row.actual,
        declaredLineCount: row.declared,
      });
    }
  }
  if (martLines.length !== sourceLines.size) {
    lineMismatches.push({
      reason: "voucher count differs",
      source: sourceLines.size,
      mart: martLines.length,
    });
  }

  if (lineMismatches.length) {
    fail("lines_per_voucher", { sample: lineMismatches.slice(0, 20), total: lineMismatches.length });
  } else {
    pass("lines_per_voucher", { vouchers: martLines.length });
  }

  /* ── 4 & 5. Period totals, and balance ─────────────────────────────────── */
  const sourcePeriods = await sourcePeriodTotals(company._id);
  const { rows: martPeriods } = await client.query(
    `SELECT to_char(period_month,'YYYY-MM-DD') AS period,
            SUM(debit)         AS debit,
            SUM(credit)        AS credit,
            SUM(signed_amount) AS signed,
            count(*)::int      AS lines
       FROM reporting.fact_voucher_line
      WHERE company_id = $1 AND voucher_status = 'posted' AND is_live
      GROUP BY period_month
      ORDER BY period_month`,
    [companyId],
  );

  const periodMismatches = [];
  const imbalances = [];
  const seen = new Set();

  for (const row of martPeriods) {
    seen.add(row.period);
    const src = sourcePeriods.get(row.period);
    if (!src) {
      periodMismatches.push({ period: row.period, reason: "period absent from source" });
      continue;
    }
    if (!near(src.debit, row.debit) || !near(src.credit, row.credit) || src.lines !== row.lines) {
      periodMismatches.push({
        period: row.period,
        sourceDebit: num(src.debit).toFixed(2),
        martDebit: num(row.debit).toFixed(2),
        debitDifference: diff(src.debit, row.debit),
        sourceCredit: num(src.credit).toFixed(2),
        martCredit: num(row.credit).toFixed(2),
        creditDifference: diff(src.credit, row.credit),
        sourceLines: src.lines,
        martLines: row.lines,
      });
    }
    /* THE BALANCE CHECK. Zero to the smallest stored unit. A difference here is
       the source's books not balancing — reported with the company, the period
       and the exact aggregate difference, and never rounded away to let a sync
       pass. */
    if (!near(row.signed, 0)) {
      imbalances.push({
        companyId,
        companyName: company.companyName,
        period: row.period,
        signedTotal: num(row.signed).toFixed(2),
        debit: num(row.debit).toFixed(2),
        credit: num(row.credit).toFixed(2),
        difference: num(row.signed).toFixed(4),
      });
    }
  }
  for (const period of sourcePeriods.keys()) {
    if (!seen.has(period)) {
      periodMismatches.push({ period, reason: "period absent from mart" });
    }
  }

  if (periodMismatches.length) {
    fail("period_totals", { sample: periodMismatches.slice(0, 20), total: periodMismatches.length });
  } else {
    pass("period_totals", { periods: martPeriods.length });
  }

  if (imbalances.length) {
    fail("balanced_periods", { imbalances: imbalances.slice(0, 20), total: imbalances.length });
  } else {
    pass("balanced_periods", { periods: martPeriods.length });
  }

  /* ── 6. Trial balance per ledger, against the existing calculation ─────── */
  const sourceLedgers = await sourceLedgerTotals(company._id);
  const { rows: martLedgers } = await client.query(
    `SELECT COALESCE(ledger_id,'(no ledger)') AS ledger_id,
            SUM(debit)  AS debit,
            SUM(credit) AS credit
       FROM reporting.fact_voucher_line
      WHERE company_id = $1 AND voucher_status = 'posted' AND is_live
      GROUP BY COALESCE(ledger_id,'(no ledger)')`,
    [companyId],
  );

  const ledgerMismatches = [];
  const martByLedger = new Map(martLedgers.map((r) => [r.ledger_id, r]));

  for (const [ledgerId, src] of sourceLedgers) {
    const m = martByLedger.get(ledgerId);
    if (!m) {
      ledgerMismatches.push({
        ledgerId,
        reason: "ledger absent from mart",
        sourceDebit: num(src.debit).toFixed(2),
        sourceCredit: num(src.credit).toFixed(2),
      });
      continue;
    }
    if (!near(src.debit, m.debit) || !near(src.credit, m.credit)) {
      ledgerMismatches.push({
        ledgerId,
        sourceDebit: num(src.debit).toFixed(2),
        martDebit: num(m.debit).toFixed(2),
        debitDifference: diff(src.debit, m.debit),
        sourceCredit: num(src.credit).toFixed(2),
        martCredit: num(m.credit).toFixed(2),
        creditDifference: diff(src.credit, m.credit),
      });
    }
  }
  for (const ledgerId of martByLedger.keys()) {
    if (!sourceLedgers.has(ledgerId)) {
      ledgerMismatches.push({ ledgerId, reason: "ledger absent from the source calculation" });
    }
  }

  if (ledgerMismatches.length) {
    fail("trial_balance_per_ledger", {
      sample: ledgerMismatches.slice(0, 20),
      total: ledgerMismatches.length,
    });
  } else {
    pass("trial_balance_per_ledger", { ledgers: martLedgers.length });
  }

  /* ── Warnings: true, worth knowing, not grounds to reject the data ─────── */

  /* A posted+optional voucher makes `Acc_books.js`'s trial balance and the
     Lane B party reports disagree with each other. The mart matches the former.
     There are none today; the moment there is one, somebody has to decide which
     report is right, and this is how they find out. */
  const postedOptional = await Acc_Voucher.countDocuments({
    companyId: company._id,
    status: "posted",
    isOptional: true,
  });
  if (postedOptional > 0) {
    warnings.push({
      warning: "posted_optional_vouchers",
      count: postedOptional,
      detail:
        "Posted vouchers flagged isOptional exist. Acc_books.js's trial balance counts them " +
        "and the Lane B party reports do not, so the two in-app reports disagree. The mart " +
        "matches Acc_books.js. Decide which is correct before quoting either.",
    });
  }

  if (signMismatches.length) {
    warnings.push({
      warning: "stored_signed_amount_disagrees",
      count: signMismatches.length,
      sample: signMismatches.slice(0, 10),
      detail:
        "The stored ledgerEntries.signedAmount disagreed with type+amount. The mart used the " +
        "derived value, which is what every other report reads.",
    });
  }

  const { rows: orphanLedgers } = await client.query(
    `SELECT count(*)::int AS n
       FROM reporting.fact_voucher_line l
       LEFT JOIN reporting.dim_ledger d ON d.ledger_id = l.ledger_id
      WHERE l.company_id = $1 AND l.ledger_id IS NOT NULL AND d.ledger_id IS NULL`,
    [companyId],
  );
  if (orphanLedgers[0].n > 0) {
    warnings.push({
      warning: "lines_reference_deleted_ledgers",
      count: orphanLedgers[0].n,
      detail:
        "Voucher lines point at ledgers that no longer exist in acc_ledgers — ledgers are hard " +
        "deleted elsewhere in the product. v_trial_balance LEFT JOINs dim_ledger so this money " +
        "still appears; it will show with a null group and nature.",
    });
  }

  const report = { companyId, companyName: company.companyName, organizationId, checks, warnings };

  if (failures.length) {
    const summary = failures.map((f) => f.check).join(", ");
    throw new ReconciliationError(
      `Reconciliation failed for ${company.companyName} (${companyId}): ${summary}`,
      report,
    );
  }

  return report;
}

module.exports = {
  reconcileCompany,
  martCounts,
  sourcePeriodTotals,
  sourceLedgerTotals,
  sourceLineCounts,
  mongoTimezone,
  ReconciliationError,
  TOLERANCE,
};
