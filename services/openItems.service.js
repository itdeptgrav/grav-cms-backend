/**
 * GRAV-CMS-BACKEND/services/openItems.service.js
 *
 * What is still outstanding, bill by bill.
 *
 * ── WHY THIS EXISTS AS A SERVICE ────────────────────────────────────────────
 * This logic already lived inline inside the ledger-detail handler in
 * `Acc_parties.js`'s sibling, `Acc_chartOfAccounts.js` (~L1855). The parties
 * LIST needs the same answer for many ledgers at once, and the cash-flow
 * forecast will need it again. Three implementations of "what is outstanding"
 * will disagree eventually, and on the day they do nobody will know which
 * screen is lying. So the definition lives here once.
 *
 * ── THE DEFINITION (unchanged from the existing implementation) ─────────────
 * For a party ledger, take every `billAllocations` entry across all POSTED
 * vouchers, group by `billName`, and sign each amount by its ledger-entry side
 * (`Dr` = +, `Cr` = −). The bill is OPEN when the signed sum is non-zero.
 *
 *   new_ref    — the original invoice; establishes the original amount
 *   agst_ref   — a settlement against it
 *   advance /
 *   on_account — money not tied to a specific bill
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not DERIVE or DEFAULT a due date. `dueDate`/`creditDays` below are
 * READ straight off `billAllocations` when a document already carries one —
 * the ledger-detail statement has always shown this — but nothing here
 * invents a date that wasn't already stored. Deriving/defaulting a due date
 * from credit terms is C0-C's job (services/creditTerms.service.js /
 * voucherDueDateDefault.service.js), a different concern entirely.
 *
 * ── C0-D — MIGRATION, NOT REDEFINITION ──────────────────────────────────────
 * The per-bill aging/bucketing logic in `agedBillsForLedger` below is moved
 * here VERBATIM from the inline implementation that lived in
 * `Acc_chartOfAccounts.js`'s `GET /ledgers/:id/statement` handler (~L1855–
 * L1990). Every threshold, default, and edge case is preserved exactly,
 * including one pre-existing inconsistency worth naming rather than quietly
 * fixing: the ledger-detail view has always treated a bill as settled below
 * ₹0.01 (`LEDGER_DETAIL_SETTLED_THRESHOLD`), while the parties-list summary
 * below it uses a full-rupee `SETTLED_TOLERANCE`. Unifying the two would be
 * a behaviour change; this migration's job is to have ONE place that HOLDS
 * both existing behaviours, not to decide which one is right.
 *
 * The fold is pure and separately testable; only `openItemsByLedger`,
 * `billsByLedger`, and the internal row-fetcher touch Mongo.
 */

const mongoose = require("mongoose");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");

/**
 * Rounding dust must not read as an open bill. A bill settled to within a
 * rupee is settled; two rupees is a real balance somebody should see.
 */
const SETTLED_TOLERANCE = 1;

/**
 * Fold raw allocation rows into per-bill positions. PURE — no db, no clock.
 *
 * @param {Array} rows  each { ledgerId, billName, amount, billType, entryType }
 * @returns {Map} `${ledgerId}||${billName}` → bill position
 */
function foldAllocations(rows = []) {
  const bills = new Map();

  for (const r of rows) {
    if (!r) continue;
    // An allocation with no bill name cannot be grouped, so it cannot form an
    // open item. The existing implementation skips these silently; here they
    // are skipped but COUNTED, because a party whose allocations are unnamed
    // will show zero open items and that needs an explanation, not a blank.
    if (!r.billName) continue;

    const lid = String(r.ledgerId);
    const key = `${lid}||${r.billName}`;
    if (!bills.has(key)) {
      bills.set(key, {
        ledgerId: lid,
        billName: r.billName,
        originalAmount: 0,
        remaining: 0,
        firstVoucherDate: r.voucherDate || null,
        // `dueDate`/`creditDays` are captured ONLY here, at first encounter,
        // and never touched again for this bill — matching the inline
        // implementation exactly. This is deliberately NOT "earliest
        // dueDate seen" or "most complete row wins": it is whatever the
        // FIRST allocation for this bill happened to carry. Changing that
        // rule would be a behaviour change, which C0-D is not scoped to make.
        dueDate: r.dueDate,
        creditDays: r.creditDays || 0,
        // Unlike `dueDate`/`creditDays` above, this is the first NON-NULL
        // voucher-header dueDate seen across ALL rows for this bill, not
        // strictly the first row's value. A bill's rows come from several
        // different vouchers (the original invoice, one or more
        // settlements), and a header dueDate is a fact about whichever
        // voucher happens to carry it — usually the invoice — not about
        // whichever row the aggregation iterates first. `dueDate`/
        // `creditDays` keep the first-row-only rule because it MATCHES an
        // existing, already-shipped implementation (see the comment on
        // `dueDate` above); this field has no such precedent to preserve.
        voucherDueDate: r.voucherDueDate || null,
        voucherNumbers: new Set(),
      });
    }
    const bill = bills.get(key);

    const amount = Number(r.amount) || 0;
    bill.remaining += (r.entryType === "Dr" ? 1 : -1) * amount;
    if (r.billType === "new_ref") bill.originalAmount += amount;

    const d = r.voucherDate ? new Date(r.voucherDate).getTime() : null;
    const f = bill.firstVoucherDate ? new Date(bill.firstVoucherDate).getTime() : null;
    if (d !== null && Number.isFinite(d) && (f === null || d < f)) {
      bill.firstVoucherDate = r.voucherDate;
    }

    if (!bill.voucherDueDate && r.voucherDueDate) {
      bill.voucherDueDate = r.voucherDueDate;
    }

    // Every voucher touching this bill, whether the row carried a dueDate or
    // not — this is what "voucherCount" on the ledger-detail screen counts.
    if (r.voucherNumber) bill.voucherNumbers.add(r.voucherNumber);
  }

  return bills;
}

/** How many of these rows carry no bill name — the blind spot, made countable. */
function countUnnamed(rows = []) {
  return rows.reduce((n, r) => (r && !r.billName ? n + 1 : n), 0);
}

/** Is this bill still open? */
function isOpen(bill) {
  return !!bill && Math.abs(bill.remaining) > SETTLED_TOLERANCE;
}

/**
 * Summarise folded bills per ledger.
 *
 * `receivable` and `payable` are kept apart rather than netted: a party with
 * ₹5L owed to us and ₹5L owed by us is not the same as a party with nothing
 * outstanding, and a single net figure cannot tell them apart.
 */
function summariseByLedger(bills, unnamedByLedger = new Map()) {
  const out = new Map();

  const ensure = (lid) => {
    if (!out.has(lid)) {
      out.set(lid, {
        openItemCount: 0,
        receivable: 0,   // Dr-side: money owed TO us
        payable: 0,      // Cr-side: money WE owe
        oldestOpenDate: null,
        unnamedAllocations: unnamedByLedger.get(lid) || 0,
      });
    }
    return out.get(lid);
  };

  for (const [, bill] of bills) {
    const row = ensure(bill.ledgerId);
    if (!isOpen(bill)) continue;

    row.openItemCount += 1;
    if (bill.remaining > 0) row.receivable += bill.remaining;
    else row.payable += Math.abs(bill.remaining);

    const d = bill.firstVoucherDate ? new Date(bill.firstVoucherDate).getTime() : null;
    const cur = row.oldestOpenDate ? new Date(row.oldestOpenDate).getTime() : null;
    if (d !== null && Number.isFinite(d) && (cur === null || d < cur)) {
      row.oldestOpenDate = bill.firstVoucherDate;
    }
  }

  // Ledgers that had only unnamed allocations still deserve a row, so the UI
  // can say "no bill-wise data" rather than "nothing outstanding".
  for (const [lid] of unnamedByLedger) ensure(lid);

  return out;
}

/** Cast to ObjectId, or null when the value isn't one. Never throws. */
function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Raw allocation rows for a set of ledgers — posted vouchers only. The one
 * query both `openItemsByLedger` and `billsByLedger` share; a wider
 * `$project` than the earliest version of this service had, because the
 * ledger-detail statement (billsByLedger's consumer) needs `dueDate`,
 * `creditDays` and `voucherNumber` alongside what the parties-list summary
 * already used. `summariseByLedger` simply ignores the extra fields.
 *
 * ── FAIL CLOSED ON COMPANY SCOPE ─────────────────────────────────────────
 * `companyId` is REQUIRED. A missing or malformed value used to fall
 * through to an aggregation with no `companyId` filter at all — matching
 * `ledgerIds` alone, across every company's vouchers, rather than refusing.
 * That is the same class of gap C0-B1's credit-terms write and C0-C's
 * due-date defaulting were both corrected for: a read whose figures feed
 * the parties list, the ledger statement, and later forecast/backfill work
 * deserves the same "can't verify the scope → return nothing" discipline as
 * a write does. See the correction below and openItems.test.js for the
 * cross-company proof.
 *
 * Not exported: the two named entry points below are the public surface.
 */
async function fetchAllocationRows(companyId, ledgerIds) {
  const ids = (ledgerIds || []).map(castId).filter(Boolean);
  if (ids.length === 0) return [];

  const cid = castId(companyId);
  if (!cid) return []; // never guess the scope — no company, no query, no rows

  const match = { status: "posted", isOptional: { $ne: true }, companyId: cid };

  return Acc_Voucher.aggregate([
    { $match: { ...match, "ledgerEntries.ledgerId": { $in: ids } } },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
    { $unwind: "$ledgerEntries.billAllocations" },
    {
      $project: {
        _id: 0,
        ledgerId: "$ledgerEntries.ledgerId",
        entryType: "$ledgerEntries.type",
        billName: "$ledgerEntries.billAllocations.billName",
        amount: "$ledgerEntries.billAllocations.amount",
        billType: "$ledgerEntries.billAllocations.billType",
        dueDate: "$ledgerEntries.billAllocations.dueDate",
        creditDays: "$ledgerEntries.billAllocations.creditDays",
        // The voucher HEADER's own dueDate — a different field from the
        // allocation-level one above. Added for C0-F's backfill readiness
        // ladder: `billAllocations[].dueDate` outranks it, but a voucher
        // that carries its own printed due date still counts as dated even
        // when its bill allocation doesn't repeat that date. Genuinely rare
        // in this dataset (4 of 551 vouchers, at last count) but the fold
        // must not pretend the field doesn't exist just because it is
        // usually empty.
        voucherDueDate: "$dueDate",
        voucherNumber: "$voucherNumber",
        voucherDate: "$voucherDate",
      },
    },
  ]);
}

/**
 * Open-item position for a set of party ledgers. READ ONLY.
 *
 * Scoped to the ledgers passed in — normally one page of the parties list —
 * rather than sweeping every ledger in the company.
 */
async function openItemsByLedger(companyId, ledgerIds = []) {
  const ids = (ledgerIds || []).map(castId).filter(Boolean);
  if (ids.length === 0) return new Map();

  const rows = await fetchAllocationRows(companyId, ids);

  const unnamedByLedger = new Map();
  for (const r of rows) {
    if (r && !r.billName) {
      const lid = String(r.ledgerId);
      unnamedByLedger.set(lid, (unnamedByLedger.get(lid) || 0) + 1);
    }
  }

  return summariseByLedger(foldAllocations(rows), unnamedByLedger);
}

/**
 * Every folded bill for a set of ledgers — the per-bill detail
 * `openItemsByLedger`'s summary rolls up and discards. Used by the
 * ledger-detail statement (via `agedBillsForLedger`) and, later, by the
 * forecast/backfill work that needs the same bills with their dates intact.
 *
 * Not filtered to "open only" — same as `foldAllocations`'s own contract —
 * so a caller who wants settled bills too (an export, an audit view) still
 * can. `agedBillsForLedger` does its own open/settled filtering.
 */
async function billsByLedger(companyId, ledgerIds = []) {
  const ids = (ledgerIds || []).map(castId).filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await fetchAllocationRows(companyId, ids);
  return foldAllocations(rows);
}

/**
 * A bill is settled below this threshold for the LEDGER-DETAIL view
 * specifically. Deliberately NOT the same value as `SETTLED_TOLERANCE`
 * above (₹1) — the inline implementation this migrates always used ₹0.01
 * here, and preserving that exactly is what "migration, not redefinition"
 * means. See the module header for why the two are not unified.
 */
const LEDGER_DETAIL_SETTLED_THRESHOLD = 0.01;

/**
 * Turn one ledger's folded bills into the aged, bucketed list the
 * ledger-detail statement renders — moved verbatim from the inline
 * implementation in `Acc_chartOfAccounts.js`. PURE: no db, no clock of its
 * own. `asOf` and `closingBalance` are both required inputs.
 *
 * Reconciliation: bill allocations alone miss opening balances and imported
 * entries with no bill reference, so their signed sum can differ from the
 * ledger's real closing balance. The gap is surfaced as an
 * "Opening / Unallocated" synthetic line in the `current` bucket, so the
 * headline total always equals `closingBalance` — the same figure shown on
 * the ledger's own header card.
 *
 * @param {Array} bills — folded bill objects for ONE ledger (e.g.
 *   `[...billsByLedger(...).values()]` filtered to that ledger, or already
 *   scoped by having passed a single ledgerId to `billsByLedger`)
 * @param {object} opts
 * @param {Date}   opts.asOf — "today", injected so this stays deterministic
 * @param {number} opts.closingBalance — the ledger's real signed closing
 *   balance (+ = Dr, − = Cr), computed elsewhere from the full transaction
 *   history, not from bill allocations
 * @param {*}      [opts.fallbackFirstDate] — used as the Unallocated line's
 *   `firstDate` when there is a gap to reconcile
 */
function agedBillsForLedger(bills, { asOf, closingBalance, fallbackFirstDate = null } = {}) {
  const when = asOf instanceof Date ? asOf : new Date(asOf);
  const buckets = { current: 0, "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const openBills = [];

  for (const bill of bills || []) {
    if (!bill) continue;
    if (Math.abs(bill.remaining) < LEDGER_DETAIL_SETTLED_THRESHOLD) continue; // settled

    const dueDate = bill.dueDate || null;
    const creditDays = bill.creditDays || 0;
    const daysOverdue = dueDate
      ? Math.max(0, Math.floor((when - new Date(dueDate)) / 86400000))
      : Math.max(
          0,
          Math.floor((when - new Date(bill.firstVoucherDate)) / 86400000) - creditDays,
        );

    let bucket = "current";
    if (daysOverdue > 0) bucket = "0-30";
    if (daysOverdue > 30) bucket = "31-60";
    if (daysOverdue > 60) bucket = "61-90";
    if (daysOverdue > 90) bucket = "90+";
    buckets[bucket] += Math.abs(bill.remaining);

    openBills.push({
      billName: bill.billName,
      firstDate: bill.firstVoucherDate,
      dueDate,
      creditDays,
      originalAmount: bill.originalAmount,
      remaining: bill.remaining,
      remainingAbs: Math.abs(bill.remaining),
      remainingType: bill.remaining >= 0 ? "Dr" : "Cr",
      daysOverdue,
      bucket,
      voucherCount: bill.voucherNumbers ? bill.voucherNumbers.size : 0,
    });
  }

  const billSigned = openBills.reduce(
    (s, b) => s + b.remainingAbs * (b.remainingType === "Dr" ? 1 : -1),
    0,
  );
  const unallocated =
    typeof closingBalance === "number"
      ? parseFloat((closingBalance - billSigned).toFixed(2))
      : 0;

  if (Math.abs(unallocated) >= LEDGER_DETAIL_SETTLED_THRESHOLD) {
    openBills.push({
      billName: "Opening / Unallocated",
      firstDate: fallbackFirstDate,
      dueDate: null,
      creditDays: 0,
      originalAmount: Math.abs(unallocated),
      remaining: unallocated,
      remainingAbs: Math.abs(unallocated),
      remainingType: unallocated >= 0 ? "Dr" : "Cr",
      daysOverdue: 0,
      bucket: "current",
      voucherCount: 0,
    });
    buckets.current += Math.abs(unallocated);
  }

  openBills.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { bills: openBills, buckets, unallocated };
}

module.exports = {
  SETTLED_TOLERANCE,
  LEDGER_DETAIL_SETTLED_THRESHOLD,
  foldAllocations,
  countUnnamed,
  isOpen,
  summariseByLedger,
  openItemsByLedger,
  billsByLedger,
  agedBillsForLedger,
};
