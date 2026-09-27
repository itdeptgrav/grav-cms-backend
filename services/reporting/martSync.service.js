// services/reporting/martSync.service.js
//
// FULL REFRESH OF THE ACCOUNTING REPORTING MART, FROM MONGODB.
//
// One company at a time, each in ONE transaction that is only committed after
// `martReconcile.service.js` has agreed the result matches the source. A
// company whose reconciliation fails is rolled back and its PREVIOUS data
// stays current — a stale company is recoverable, a silently wrong one is not.
//
// ── THIS PROCESS NEVER WRITES TO MONGODB ────────────────────────────────────
// Every read is `.find().project().lean()` or an aggregation. There is no
// `save`, `update`, `delete` or `bulkWrite` anywhere in this file, and
// `test/reporting/mart-sync.test.js` asserts it by counting documents and
// comparing `updatedAt` on every source collection before and after a sync.
//
// ── ORGANIZATION_ID IS MATERIALISED, NOT COPIED ─────────────────────────────
// No financial document carries an `organizationId`. Ownership exists ONLY as
// `Acc_Organization.tallyCompanyIds[]` — an access-control list, reverse-looked
// up. So the sync reads that mapping and stamps it onto every row, and refuses
// outright if a company has no owner or more than one. It is the future
// row-level-security sandbox key: a wrong value there is a cross-tenant leak,
// and an absent one is a row nobody can be shown. Neither is worth guessing at,
// so neither is guessed at.
//
// ── DATES ARE BUSINESS-TIMEZONE DATES ───────────────────────────────────────
// `voucherDate` is stored inconsistently: some documents hold UTC midnight
// (2025-08-08T00:00:00Z) and some hold IST midnight (2025-08-03T18:30:00Z,
// which IS 4 August in Kolkata). In this company, 530 of 1,868 vouchers are of
// the second kind. Read in UTC they fall on the previous day, and some fall in
// the previous MONTH — so a UTC reading would put real vouchers in the wrong
// period and no total would tie out.
//
// So every date the mart stores is resolved in the business timezone
// (`ACCOUNTING_UTC_OFFSET_MINUTES`, default +330), which is the timezone the
// accountant sees on screen and the one the rest of the accounting services
// already use. `martReconcile.service.js` applies the SAME timezone to its
// Mongo aggregates — if the two sides disagreed about what a month is, the
// reconciliation would be comparing different questions.
//
// ── WHAT IS DELIBERATELY NOT COPIED ─────────────────────────────────────────
// The projections below are an allow-list, not a convenience. Nothing reaches
// the mart except the columns named there, which excludes: password hashes and
// FCM tokens (`Acc_User`), invite tokens, Google refresh tokens, Setu AA
// consent artefacts and bank account details, `Acc_Ledger.bankDetails`,
// `panNumber`, contact blocks, every `attachments[]` URL and Drive id, and
// voucher `signatures[]`. `test/reporting/mart-sensitive-fields.test.js`
// re-asserts this against documents deliberately stuffed with all of them.

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const pg = require("./pgClient");
const reconcile = require("./martReconcile.service");

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");

/* The business timezone, read exactly as services/partyOutstanding.service.js
   reads it so the mart and the existing reports agree about what a day is. */
const BUSINESS_UTC_OFFSET_MINUTES = Number.isFinite(
  Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES),
)
  ? Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES)
  : 330;

/** How many rows go in one INSERT. Keeps parameter count well under 65,535. */
const INSERT_BATCH = 500;

/* ─────────────────────────────────────────────────────────────────────────── */
/* Value coercion                                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

/** `_id` as a string, or null. Never throws on a malformed value. */
function id(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s === "" ? null : s;
}

/**
 * A money value as an exact 2-decimal STRING for PostgreSQL `numeric`.
 *
 * Passing the JavaScript number straight through would hand the driver a
 * double and re-introduce the very imprecision the numeric column exists to
 * escape. Rounding to a string here makes the one rounding decision explicit
 * and puts it at the boundary, where it can be tested.
 */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

/** The instant, shifted into business time. Used only to read Y/M/D off it. */
function inBusinessTime(instant) {
  return new Date(new Date(instant).getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60000);
}

/** `yyyy-mm-dd` as the accountant reads it, or null. */
function businessDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const b = inBusinessTime(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
}

/** The first day of the value's month, in business time. `yyyy-mm-01`. */
function businessPeriodMonth(value) {
  const day = businessDate(value);
  return day ? `${day.slice(0, 7)}-01` : null;
}

/** A timestamp for `source_updated_at`, or null. */
function timestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const text = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
};

const bool = (value, fallback = false) =>
  value === undefined || value === null ? fallback : Boolean(value);

/* ─────────────────────────────────────────────────────────────────────────── */
/* Ownership                                                                  */
/* ─────────────────────────────────────────────────────────────────────────── */

class OwnershipError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

/**
 * company_id → organization_id, from the canonical ownership record.
 *
 * REFUSES rather than guesses:
 *   • a company in no organisation's `tallyCompanyIds`  → OWNERSHIP_MISSING
 *   • a company in more than one                        → OWNERSHIP_AMBIGUOUS
 *
 * Decision D2 says a company belongs to exactly one organisation, and there is
 * a unique multikey index enforcing it. This checks anyway, because the index
 * can be absent on a database that predates it, and because the consequence of
 * being wrong — every row of that company's books stamped with the wrong tenant
 * key — is not the kind of thing to take on trust from an index that may not
 * be there.
 *
 * @param {string[]} [companyIds] restrict the check to these companies
 * @returns {Promise<Map<string,string>>}
 */
async function resolveOwnership(companyIds = null) {
  const orgs = await Acc_Organization.find({})
    .select("_id name tallyCompanyIds")
    .lean();

  /** company_id → [organization_id] */
  const owners = new Map();
  for (const org of orgs) {
    for (const companyId of org.tallyCompanyIds || []) {
      const key = id(companyId);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(id(org._id));
    }
  }

  const wanted = companyIds
    ? companyIds.map(id).filter(Boolean)
    : (await Acc_Company.find({}).select("_id").lean()).map((c) => id(c._id));

  const mapping = new Map();
  const missing = [];
  const ambiguous = [];

  for (const companyId of wanted) {
    const holders = [...new Set(owners.get(companyId) || [])];
    if (holders.length === 0) {
      missing.push(companyId);
    } else if (holders.length > 1) {
      ambiguous.push({ companyId, organizationIds: holders.sort() });
    } else {
      mapping.set(companyId, holders[0]);
    }
  }

  if (ambiguous.length) {
    throw new OwnershipError(
      "OWNERSHIP_AMBIGUOUS",
      `${ambiguous.length} company/companies are claimed by more than one organisation. ` +
        "Which organisation owns a company decides who may read its books, and it is not " +
        "something this sync will decide by rule.",
      { ambiguous },
    );
  }
  if (missing.length) {
    throw new OwnershipError(
      "OWNERSHIP_MISSING",
      `${missing.length} company/companies belong to no organisation. Every mart row needs an ` +
        "organization_id — it is the row-level-security key — so a company without an owner " +
        "cannot be synced. Assign it with scripts/migrations/accounting-organization-company-repair.js.",
      { missing },
    );
  }

  return mapping;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reading the source                                                         */
/* ─────────────────────────────────────────────────────────────────────────── */

/* Each projection is an ALLOW-LIST. A field absent from it never reaches the
   mart, however the document grows later. */

const COMPANY_FIELDS =
  "_id companyName companyCode gstin address.stateCode booksFromDate " +
  "financialYearStart currentFinancialYear baseCurrency isPrimary isActive updatedAt";

const GROUP_FIELDS =
  "_id companyId name parent parentName nature isPrimary isReserved level " +
  "fullPath isActive updatedAt";

const LEDGER_FIELDS =
  "_id companyId name groupId groupName nature gstin openingBalance " +
  "openingBalanceType isActive updatedAt";

const VOUCHER_FIELDS =
  "_id companyId voucherNumber voucherType voucherTypeName voucherDate dueDate " +
  "referenceNumber partyLedgerId partyLedgerName narration status isLive isOptional " +
  "financialYear grandTotal updatedAt " +
  // The line array, field by field. `billAllocations` and `costCentreAllocations`
  // are their own facts in a later slice and are not read here; `attachments`
  // and `signatures` are never read at all.
  "ledgerEntries._id ledgerEntries.ledgerId ledgerEntries.ledgerName " +
  "ledgerEntries.groupName ledgerEntries.type ledgerEntries.amount " +
  "ledgerEntries.signedAmount ledgerEntries.isPartyLedger " +
  "ledgerEntries.gstClassification ledgerEntries.narration";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Writing the mart                                                           */
/* ─────────────────────────────────────────────────────────────────────────── */

/** A multi-row INSERT, in batches, on an open transaction client. */
async function insertRows(client, table, columns, rows) {
  if (!rows.length) return 0;
  let written = 0;

  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    const batch = rows.slice(start, start + INSERT_BATCH);
    const params = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((col) => {
        params.push(row[col] === undefined ? null : row[col]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(",")})`;
    });

    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`,
      params,
    );
    written += batch.length;
  }

  return written;
}

/**
 * Remove one company's mart rows.
 *
 * ORDER IS THE POINT. The declared foreign keys are real, so children go first
 * — lines, then vouchers, then the dimensions, then the company row itself.
 * Doing it the other way round does not corrupt anything; it simply fails, and
 * the whole transaction rolls back. This ordering is what lets the mart have
 * true foreign keys AND a full refresh at the same time.
 */
async function deleteCompany(client, companyId) {
  const counts = {};
  for (const [key, table] of [
    ["voucherLines", "reporting.fact_voucher_line"],
    ["vouchers", "reporting.fact_voucher"],
    ["ledgers", "reporting.dim_ledger"],
    ["groups", "reporting.dim_group"],
    ["companies", "reporting.dim_company"],
  ]) {
    const { rowCount } = await client.query(
      `DELETE FROM ${table} WHERE company_id = $1`,
      [companyId],
    );
    counts[key] = rowCount;
  }
  return counts;
}

const COMPANY_COLUMNS = [
  "company_id", "organization_id", "source_id", "company_name", "company_code",
  "gstin", "state_code", "books_from_date", "financial_year_start",
  "current_financial_year", "base_currency", "is_primary", "is_active",
  "source_updated_at", "synced_at",
];

const GROUP_COLUMNS = [
  "group_id", "organization_id", "company_id", "source_id", "group_name",
  "parent_group_id", "parent_group_name", "nature", "is_primary", "is_reserved",
  "level", "full_path", "is_active", "source_updated_at", "synced_at",
];

const LEDGER_COLUMNS = [
  "ledger_id", "organization_id", "company_id", "source_id", "ledger_name",
  "group_id", "group_name", "nature", "gstin", "opening_balance",
  "opening_balance_type", "is_active", "source_updated_at", "synced_at",
];

const VOUCHER_COLUMNS = [
  "voucher_id", "organization_id", "company_id", "source_id", "voucher_number",
  "voucher_type", "voucher_type_name", "voucher_date", "due_date",
  "reference_number", "party_ledger_id", "party_ledger_name", "narration",
  "status", "is_live", "is_optional", "financial_year", "period_month",
  "grand_total", "line_count", "source_updated_at", "synced_at",
];

const LINE_COLUMNS = [
  "organization_id", "company_id", "source_id", "voucher_id", "line_no",
  "voucher_date", "voucher_type", "voucher_type_name", "voucher_number",
  "voucher_status", "is_live", "is_optional", "period_month", "financial_year",
  "ledger_id", "ledger_name", "group_name", "party_ledger_id",
  "party_ledger_name", "dr_cr", "amount", "debit", "credit", "signed_amount",
  "is_party_ledger", "gst_classification", "narration", "source_updated_at",
  "synced_at",
];

/**
 * Flatten one voucher into its `ledgerEntries[]` rows.
 *
 * Exported and pure so the flattening — the single most important
 * transformation in the mart — is testable without a database at either end.
 *
 * `line_no` is the element's ORDINAL POSITION, 1-based, not a stored field.
 * It is what makes (voucher_id, line_no) a stable grain key and what lets a
 * line be matched back to the array element it came from.
 *
 * `signedAmount` is taken from the source when present (the schema sets it in
 * pre-save) and derived from type+amount when it is not — an imported voucher
 * can bypass the hook. When both exist and disagree, the DERIVED value wins and
 * the disagreement is reported: `type` and `amount` are what the accountant
 * entered and what every other report reads, so a stale cached sign must not
 * silently become the mart's version of the truth.
 */
function flattenVoucher(voucher, { organizationId, syncedAt }) {
  const companyId = id(voucher.companyId);
  const voucherId = id(voucher._id);
  const voucherDate = businessDate(voucher.voucherDate);
  const periodMonth = businessPeriodMonth(voucher.voucherDate);
  const sourceUpdatedAt = timestamp(voucher.updatedAt);
  const entries = Array.isArray(voucher.ledgerEntries) ? voucher.ledgerEntries : [];

  const rows = [];
  const signMismatches = [];

  entries.forEach((entry, index) => {
    const drCr = entry.type === "Cr" ? "Cr" : "Dr";
    const amount = Math.abs(Number(entry.amount) || 0);
    const derivedSigned = drCr === "Dr" ? amount : -amount;

    if (entry.signedAmount !== undefined && entry.signedAmount !== null) {
      const stored = Number(entry.signedAmount);
      if (Number.isFinite(stored) && Math.abs(stored - derivedSigned) > 0.005) {
        signMismatches.push({
          voucherId,
          lineNo: index + 1,
          storedSignedAmount: stored,
          derivedSignedAmount: derivedSigned,
        });
      }
    }

    rows.push({
      organization_id: organizationId,
      company_id: companyId,
      /* The subdocument `_id`. `ledgerEntrySchema` declares `{ _id: true }`, so
         every element has one and it is stable across syncs — which is what
         makes UNIQUE (source_id) a real idempotency key rather than a hope.
         A document old enough to predate it falls back to a deterministic
         composite so two runs still produce the same key. */
      source_id: id(entry._id) || `${voucherId}:${index + 1}`,
      voucher_id: voucherId,
      line_no: index + 1,
      voucher_date: voucherDate,
      voucher_type: text(voucher.voucherType),
      voucher_type_name: text(voucher.voucherTypeName),
      voucher_number: text(voucher.voucherNumber),
      voucher_status: text(voucher.status) || "draft",
      is_live: bool(voucher.isLive, !["cancelled", "void"].includes(voucher.status)),
      is_optional: bool(voucher.isOptional),
      period_month: periodMonth,
      financial_year: text(voucher.financialYear),
      ledger_id: id(entry.ledgerId),
      ledger_name: text(entry.ledgerName) || "(unnamed ledger)",
      group_name: text(entry.groupName),
      party_ledger_id: id(voucher.partyLedgerId),
      party_ledger_name: text(voucher.partyLedgerName),
      dr_cr: drCr,
      amount: money(amount),
      debit: money(drCr === "Dr" ? amount : 0),
      credit: money(drCr === "Cr" ? amount : 0),
      signed_amount: money(derivedSigned),
      is_party_ledger: bool(entry.isPartyLedger),
      gst_classification: text(entry.gstClassification),
      narration: text(entry.narration),
      source_updated_at: sourceUpdatedAt,
      synced_at: syncedAt,
    });
  });

  return { rows, signMismatches };
}

/** One company's mart rows, built from the source. Pure given its input. */
function buildCompanyRows({ company, groups, ledgers, vouchers, organizationId, syncedAt }) {
  const companyId = id(company._id);

  const companyRow = {
    company_id: companyId,
    organization_id: organizationId,
    source_id: companyId,
    company_name: text(company.companyName) || "(unnamed company)",
    company_code: text(company.companyCode),
    gstin: text(company.gstin),
    state_code: text(company.address?.stateCode),
    books_from_date: businessDate(company.booksFromDate),
    financial_year_start: businessDate(company.financialYearStart),
    current_financial_year: text(company.currentFinancialYear),
    base_currency: text(company.baseCurrency),
    is_primary: bool(company.isPrimary),
    is_active: bool(company.isActive, true),
    source_updated_at: timestamp(company.updatedAt),
    synced_at: syncedAt,
  };

  const groupRows = groups.map((g) => ({
    group_id: id(g._id),
    organization_id: organizationId,
    company_id: companyId,
    source_id: id(g._id),
    group_name: text(g.name) || "(unnamed group)",
    parent_group_id: id(g.parent),
    parent_group_name: text(g.parentName),
    nature: text(g.nature) || "asset",
    is_primary: bool(g.isPrimary),
    is_reserved: bool(g.isReserved),
    level: Number.isFinite(Number(g.level)) ? Number(g.level) : null,
    full_path: text(g.fullPath),
    is_active: bool(g.isActive, true),
    source_updated_at: timestamp(g.updatedAt),
    synced_at: syncedAt,
  }));

  const ledgerRows = ledgers.map((l) => ({
    ledger_id: id(l._id),
    organization_id: organizationId,
    company_id: companyId,
    source_id: id(l._id),
    ledger_name: text(l.name) || "(unnamed ledger)",
    group_id: id(l.groupId),
    group_name: text(l.groupName),
    nature: text(l.nature),
    gstin: text(l.gstin),
    opening_balance: money(l.openingBalance),
    opening_balance_type: text(l.openingBalanceType),
    is_active: bool(l.isActive, true),
    source_updated_at: timestamp(l.updatedAt),
    synced_at: syncedAt,
  }));

  const voucherRows = [];
  const lineRows = [];
  const signMismatches = [];

  for (const v of vouchers) {
    const flat = flattenVoucher(v, { organizationId, syncedAt });
    lineRows.push(...flat.rows);
    signMismatches.push(...flat.signMismatches);

    voucherRows.push({
      voucher_id: id(v._id),
      organization_id: organizationId,
      company_id: companyId,
      source_id: id(v._id),
      voucher_number: text(v.voucherNumber),
      voucher_type: text(v.voucherType) || "journal",
      voucher_type_name: text(v.voucherTypeName),
      voucher_date: businessDate(v.voucherDate),
      due_date: businessDate(v.dueDate),
      reference_number: text(v.referenceNumber),
      party_ledger_id: id(v.partyLedgerId),
      party_ledger_name: text(v.partyLedgerName),
      narration: text(v.narration),
      status: text(v.status) || "draft",
      is_live: bool(v.isLive, !["cancelled", "void"].includes(v.status)),
      is_optional: bool(v.isOptional),
      financial_year: text(v.financialYear),
      period_month: businessPeriodMonth(v.voucherDate),
      grand_total: money(v.grandTotal),
      line_count: flat.rows.length,
      source_updated_at: timestamp(v.updatedAt),
      synced_at: syncedAt,
    });
  }

  return { companyRow, groupRows, ledgerRows, voucherRows, lineRows, signMismatches };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* The sync                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Refresh one company, inside one transaction, gated by reconciliation.
 *
 * The sequence is deliberate: write everything, RECONCILE AGAINST MONGO WHILE
 * STILL INSIDE THE TRANSACTION, and only then commit. Reconciling after the
 * commit would mean the wrong data had already been visible to Metabase, and
 * "we noticed afterwards" is not a gate.
 */
async function syncCompany({ company, organizationId, runKey, runMode, log = () => {} }) {
  const companyId = id(company._id);
  const companyName = company.companyName;
  const startedAt = new Date();
  const syncedAt = startedAt.toISOString();

  log(`  ${companyName} (${companyId})`);

  // ── Read the source. No cursor is held open across the write, so a slow
  //    Postgres cannot hold a Mongo cursor past its timeout.
  const [groups, ledgers, vouchers] = await Promise.all([
    Acc_Group.find({ companyId: company._id }).select(GROUP_FIELDS).lean(),
    Acc_Ledger.find({ companyId: company._id }).select(LEDGER_FIELDS).lean(),
    Acc_Voucher.find({ companyId: company._id }).select(VOUCHER_FIELDS).lean(),
  ]);

  const built = buildCompanyRows({
    company,
    groups,
    ledgers,
    vouchers,
    organizationId,
    syncedAt,
  });

  const sourceCounts = {
    companies: 1,
    groups: groups.length,
    ledgers: ledgers.length,
    vouchers: vouchers.length,
    voucherLines: vouchers.reduce(
      (n, v) => n + (Array.isArray(v.ledgerEntries) ? v.ledgerEntries.length : 0),
      0,
    ),
  };

  log(
    `    source: ${sourceCounts.groups} groups, ${sourceCounts.ledgers} ledgers, ` +
      `${sourceCounts.vouchers} vouchers, ${sourceCounts.voucherLines} lines`,
  );

  // ── The run row is written OUTSIDE the data transaction, so that a rolled
  //    back attempt still leaves a record that it was attempted and failed.
  const { rows: runRows } = await pg.query(
    "sync",
    `INSERT INTO reporting.mart_sync_run
       (run_key, run_mode, organization_id, company_id, company_name, started_at, status, source_counts)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7)
     RETURNING run_id`,
    [runKey, runMode, organizationId, companyId, companyName, startedAt, JSON.stringify(sourceCounts)],
  );
  const runId = runRows[0].run_id;

  try {
    const outcome = await pg.withTransaction("sync", async (client) => {
      await deleteCompany(client, companyId);

      // Parents before children — the foreign keys are real.
      await insertRows(client, "reporting.dim_company", COMPANY_COLUMNS, [built.companyRow]);
      await insertRows(client, "reporting.dim_group", GROUP_COLUMNS, built.groupRows);
      await insertRows(client, "reporting.dim_ledger", LEDGER_COLUMNS, built.ledgerRows);
      await insertRows(client, "reporting.fact_voucher", VOUCHER_COLUMNS, built.voucherRows);
      await insertRows(client, "reporting.fact_voucher_line", LINE_COLUMNS, built.lineRows);

      /* THE GATE. Inside the transaction, so a failure rolls the data back and
         the previous dataset stays current. `reconcileCompany` throws on a
         mismatch; nothing below it runs, and the catch marks the run failed. */
      const report = await reconcile.reconcileCompany({
        client,
        company,
        organizationId,
        sourceCounts,
        signMismatches: built.signMismatches,
      });

      const martCounts = await reconcile.martCounts(client, companyId);
      return { report, martCounts };
    });

    await pg.query(
      "sync",
      `UPDATE reporting.mart_sync_run
          SET finished_at = now(), status = 'succeeded',
              mart_counts = $2, reconciliation = $3
        WHERE run_id = $1`,
      [runId, JSON.stringify(outcome.martCounts), JSON.stringify(outcome.report)],
    );

    log(`    reconciled: ${outcome.report.checks.length} checks passed`);
    return {
      companyId,
      companyName,
      organizationId,
      status: "succeeded",
      sourceCounts,
      martCounts: outcome.martCounts,
      reconciliation: outcome.report,
    };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    await pg.query(
      "sync",
      `UPDATE reporting.mart_sync_run
          SET finished_at = now(), status = 'failed', failure_reason = $2, reconciliation = $3
        WHERE run_id = $1`,
      [runId, reason.slice(0, 4000), JSON.stringify(err?.report || null)],
    );
    log(`    FAILED: ${reason}`);
    return {
      companyId,
      companyName,
      organizationId,
      status: "failed",
      failureReason: reason,
      sourceCounts,
      reconciliation: err?.report || null,
    };
  }
}

/**
 * Full refresh.
 *
 * Every company is attempted even if an earlier one failed: one company's
 * unbalanced books is not a reason to leave the others stale, and the caller
 * gets a per-company result either way. The CLI's exit code is non-zero if any
 * company failed.
 *
 * @param {object} o
 * @param {string[]} [o.companyIds]  restrict to these companies
 * @param {function} [o.log]
 */
async function fullSync({ companyIds = null, log = console.log } = {}) {
  const runKey = crypto.randomUUID();
  const startedAt = new Date();

  const filter = companyIds
    ? { _id: { $in: companyIds.map((c) => new mongoose.Types.ObjectId(String(c))) } }
    : {};
  const companies = await Acc_Company.find(filter).select(COMPANY_FIELDS).lean();

  if (!companies.length) {
    log("No companies matched. Nothing to sync.");
    return { runKey, startedAt, results: [], ok: true };
  }

  // Ownership FIRST, for every company, before a single row is written. A
  // partial sync that stops half way because company four has no owner is
  // worse than one that never started.
  const ownership = await resolveOwnership(companies.map((c) => id(c._id)));

  log(`Run ${runKey} — ${companies.length} company/companies`);
  log("");

  const results = [];
  for (const company of companies) {
    results.push(
      await syncCompany({
        company,
        organizationId: ownership.get(id(company._id)),
        runKey,
        runMode: "full",
        log,
      }),
    );
  }

  const ok = results.every((r) => r.status === "succeeded");
  return { runKey, startedAt, finishedAt: new Date(), results, ok };
}

module.exports = {
  fullSync,
  syncCompany,
  resolveOwnership,
  buildCompanyRows,
  flattenVoucher,
  deleteCompany,
  insertRows,
  // Exported for tests — the coercions are where precision is won or lost.
  money,
  businessDate,
  businessPeriodMonth,
  BUSINESS_UTC_OFFSET_MINUTES,
  COMPANY_FIELDS,
  GROUP_FIELDS,
  LEDGER_FIELDS,
  VOUCHER_FIELDS,
  OwnershipError,
};
