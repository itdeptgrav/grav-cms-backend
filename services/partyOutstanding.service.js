/**
 * GRAV-CMS-BACKEND/services/partyOutstanding.service.js
 *
 * What a party owes us, or we owe them — straight from the books.
 *
 * ── WHY ONE ENGINE FOR BOTH SIDES ───────────────────────────────────────────
 * Customers and suppliers are the same arithmetic seen from opposite ends. A
 * Sundry Debtor with a debit balance owes us; a Sundry Creditor with a credit
 * balance is owed by us. Everything between the ledger and that sentence —
 * company scoping, the Sundry-group tree walk, re-resolving caller-supplied
 * ledger ids, the as-of cut-off, the opening balance, the running statement —
 * is identical, and the parts of it that are security-critical are exactly the
 * parts that must not exist in two copies that can drift apart.
 *
 * So this module holds the engine, and `customerOutstanding.service.js` and
 * `supplierOutstanding.service.js` bind it to a party kind: which Sundry group
 * to read, which side of the balance is the amount people care about, and what
 * to call the two halves.
 *
 *   signed balance = ledger opening balance + Σ debits − Σ credits
 *
 * over POSTED, NON-OPTIONAL vouchers of THIS company dated on or before the
 * as-of date. Nothing here reads a quotation, a Customer Request, a purchase
 * order, an order total, or the cached `totalOutstanding`/`currentBalance`
 * summary fields: a report that disagrees with the General Ledger is worse
 * than no report, and all of those can.
 *
 * ── THE TWO SIDES ARE NEVER NETTED ──────────────────────────────────────────
 * A customer sitting on an advance does not reduce what the other customers
 * owe; a supplier we have overpaid does not reduce what we owe the others.
 * Every report carries the two halves separately, and offers the netted figure
 * only as a named extra for reconciling against the control account.
 *
 * ── WHAT IS DELIBERATELY EXCLUDED ───────────────────────────────────────────
 *   status !== "posted"        drafts and pending_approval are not in the
 *                              books yet; cancelled and void never were
 *   isOptional === true        Tally's "Optional" vouchers are planning
 *                              documents that never hit a ledger
 *   another companyId          scoping is a filter on every query here, and
 *                              a missing/malformed one returns NOTHING rather
 *                              than silently running unscoped (same fail-closed
 *                              rule as openItems.service.js)
 *   voucherDate > asOf         an as-of report that includes later movement is
 *                              not an as-of report
 *   ledgers outside the kind's Sundry group
 *                              a customer report is the receivable side and a
 *                              supplier report the payable side. Ids handed in
 *                              by a caller are re-resolved against both the
 *                              company and the group before they are trusted.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * Every function here reads. Nothing writes a ledger, a voucher, a party or a
 * balance. Generating a report must never change the thing it reports on.
 */

"use strict";

const mongoose = require("mongoose");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../models/Accountant_model/Acc_MasterModels");

/**
 * The two party kinds, and everything that differs between them.
 *
 * The regexes match the ones `Acc_parties.js` already uses for
 * `kind: "customer"` / `kind: "vendor"`, so a report and the party list can
 * never disagree about who is a customer or a supplier.
 *
 * `primarySide` is the side of the balance that is the headline number:
 *
 *   customer  Dr → RECEIVABLE. They owe us. A Cr balance is a credit or
 *                  advance we are holding for them.
 *   supplier  Cr → PAYABLE. We owe them. A Dr balance is an advance we have
 *                  paid, or an overpayment they owe back.
 *
 * That single flag is the whole difference in the accounting treatment; the
 * arithmetic above it is identical, which is why it lives in one place.
 */
const PARTY_KINDS = {
  customer: {
    key: "customer",
    groupRx: /sundry debtor/i,
    groupLabel: "Sundry Debtors",
    partyLabel: "customer",
    partyLabelPlural: "customers",
    primarySide: "Dr",
    primaryKey: "receivable",
    primaryLabel: "Receivable (Dr)",
    secondaryKey: "customerCredit",
    secondaryLabel: "Credit (Cr)",
    primaryCountKey: "debtorCount",
    secondaryCountKey: "creditCount",
    columnLabel: "Customer",
    /* Printed verbatim on the exports. Spelled out per kind rather than
     * derived, for the same reason as `balanceSideLabels`. */
    totalPrimaryLabel: "TOTAL RECEIVABLE (Dr)",
    totalSecondaryLabel: "TOTAL CUSTOMER CREDIT (Cr)",
    primaryCountNoun: "receivable",
    secondaryCountNoun: "in credit",
    /* ── AGEING VOCABULARY ─────────────────────────────────────────────────
     * `agedSign` is the multiplier that turns a folded bill's `remaining` —
     * which is Dr-positive, the ledger's own convention — into the amount the
     * report ages. For a customer that is already the right way round: an
     * unpaid invoice DEBITS the customer, so `remaining` is positive and IS
     * the receivable. See the supplier entry for the mirror. */
    agedSign: 1,
    ageingTitle: "Customer Invoice-wise Ageing",
    ageingStem: "customer-ageing",
    ageingType: "customer-ageing",
    billOppositeKey: "billCredits",
    billOppositeLabel: "Bill credits",
    billOppositeHint: "Invoices settled past zero",
    unallocatedPrimaryKey: "unallocatedReceivable",
    unallocatedSecondaryKey: "unallocatedCredit",
    ledgerPrimaryKey: "ledgerReceivable",
    ledgerSecondaryKey: "ledgerCredit",
    agedNoun: "receivables",
    billNoun: "invoice",
    billNounPlural: "invoices",
    billRefLabel: "Invoice / Ref",
    /* Reconciliation wording, verbatim. Spelled out per kind because
     * "unallocated debit" is right for a customer and wrong for a supplier —
     * an unallocated supplier payable is a CREDIT. */
    unallocatedPrimaryLine: "plus unallocated debit (opening / on-account)",
    unallocatedSecondaryLine: "less unallocated credit",
    unallocatedSecondaryLinePdf: "less unallocated credit (advances on account)",
    unallocatedPrimaryCol: "Unallocated Dr",
    unallocatedSecondaryCol: "Unallocated Cr",
    /* The workbook's detail tab, and the words for a derived due date. Both
     * are read off the report so one writer serves either side without a
     * customer sheet ever saying "Bill" or a supplier sheet "Invoice". */
    detailSheetName: "Invoices",
    creditDaysSourceLabel: "Invoice + credit days",
    codePrefix: "C-",
    codeOf: (id) => base36Code(id, "C-"),
    /* Exact wording for the applied-filters line. Spelled out rather than
     * derived from the labels above: these strings are printed on every
     * exported report, and deriving them made a casing change invisible. */
    balanceSideLabels: {
      debit: "Balances: receivable (Dr) only",
      credit: "Balances: customer credit (Cr) only",
      both: "Balances: receivable and credit",
    },
    summaryTitle: "Customer Outstanding Summary",
    statementTitle: "Customer Ledger / Statement of Account",
    reportType: "customer-outstanding",
    statementType: "customer-ledger",
    filenameStem: "customer-outstanding",
    statementStem: "customer-ledger",
  },
  supplier: {
    key: "supplier",
    groupRx: /sundry creditor/i,
    groupLabel: "Sundry Creditors",
    partyLabel: "supplier",
    partyLabelPlural: "suppliers",
    primarySide: "Cr",
    primaryKey: "payable",
    primaryLabel: "Payable (Cr)",
    secondaryKey: "supplierAdvance",
    secondaryLabel: "Advance (Dr)",
    primaryCountKey: "payableCount",
    secondaryCountKey: "advanceCount",
    columnLabel: "Supplier",
    totalPrimaryLabel: "TOTAL PAYABLE (Cr)",
    totalSecondaryLabel: "TOTAL SUPPLIER ADVANCE (Dr)",
    primaryCountNoun: "payable",
    secondaryCountNoun: "in advance",
    /* A purchase bill CREDITS the supplier ledger, so an unpaid bill leaves
     * `remaining` NEGATIVE. `agedSign: -1` flips it, which is what lets the
     * report show payables as positive figures without a second code path —
     * and what makes an overpayment (a positive `remaining`) come out as a
     * bill advance rather than as a negative payable. */
    agedSign: -1,
    ageingTitle: "Supplier Invoice-wise Ageing",
    ageingStem: "supplier-ageing",
    ageingType: "supplier-ageing",
    billOppositeKey: "billAdvances",
    billOppositeLabel: "Bill advances",
    billOppositeHint: "Bills paid past zero",
    unallocatedPrimaryKey: "unallocatedPayable",
    unallocatedSecondaryKey: "unallocatedAdvance",
    ledgerPrimaryKey: "ledgerPayable",
    ledgerSecondaryKey: "ledgerAdvance",
    agedNoun: "payables",
    billNoun: "bill",
    billNounPlural: "bills",
    billRefLabel: "Bill / Ref",
    unallocatedPrimaryLine: "plus unallocated payable (opening / on-account)",
    unallocatedSecondaryLine: "less unallocated advance",
    unallocatedSecondaryLinePdf: "less unallocated advance (paid on account)",
    unallocatedPrimaryCol: "Unallocated payable",
    unallocatedSecondaryCol: "Unallocated advance",
    detailSheetName: "Bills",
    creditDaysSourceLabel: "Bill + credit days",
    codePrefix: "VEN-",
    codeOf: (id) => hex6Code(id, "VEN-"),
    balanceSideLabels: {
      debit: "Balances: supplier advance (Dr) only",
      credit: "Balances: payable (Cr) only",
      both: "Balances: payable and supplier advance",
    },
    summaryTitle: "Supplier Outstanding Summary",
    statementTitle: "Supplier Ledger / Statement of Account",
    reportType: "supplier-outstanding",
    statementType: "supplier-ledger",
    filenameStem: "supplier-outstanding",
    statementStem: "supplier-ledger",
  },
};

/** Resolve a kind key or descriptor. Unknown kinds throw — never default. */
function partyKind(kind) {
  if (kind && typeof kind === "object" && kind.groupRx) return kind;
  const k = PARTY_KINDS[String(kind || "").toLowerCase()];
  if (!k) throw new Error(`Unknown party kind "${kind}".`);
  return k;
}

/**
 * Balances settle to dust. A tenth of a rupee either way is neither a
 * receivable nor a credit — reporting it as one puts a ₹0.00 Dr row in front
 * of an accountant who then has to prove it is nothing.
 */
const ZERO_TOLERANCE = 0.005;

/**
 * How many ledger ids a single request may name.
 *
 * Raised from the 500 the parties list uses, because "Current filtered result"
 * sends the id of every row on screen and a company can legitimately have more
 * than 500 customers with a balance. The cap still exists — an unbounded id
 * list is a denial-of-service shaped like a report — and callers that would
 * exceed the URL-safe length send the same payload as a POST body instead
 * (see the route). 2,000 ids is ~50 KB of JSON, well inside the 50 MB body
 * limit, and past that a filter is not a filter.
 */
const MAX_EXPORT_LEDGERS = 2000;

/**
 * The timezone the books are kept in.
 *
 * A financial "as on 31 August" means the end of 31 August WHERE THE BUSINESS
 * IS, not where the server happens to be. `server.js` runs on Render in UTC
 * while the books are Indian, so `setHours(23,59,59,999)` — which is
 * server-local — cut an as-of report 5½ hours early and silently dropped that
 * evening's vouchers. Offset rather than a timezone library, matching the
 * existing IST convention documented in CLAUDE.md for SOP and attendance
 * dates. India has no DST, so a fixed offset is exact.
 */
const BUSINESS_UTC_OFFSET_MINUTES = Number.isFinite(
  Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES),
)
  ? Number(process.env.ACCOUNTING_UTC_OFFSET_MINUTES)
  : 330; // Asia/Kolkata, +05:30

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure helpers — no database, no clock. Exported so the maths is testable
 * without a Mongo instance, and so a future supplier/payables report can share
 * the sign conventions rather than re-deriving them.                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** An ObjectId, or null. Never throws — callers fail closed on null. */
function oid(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const s = String(value);
  if (!mongoose.isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

/** Escape a user string for safe use inside a RegExp. */
function escapeRx(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The calendar date, in business time, that a UTC instant falls on. */
function businessDayParts(instant) {
  const shifted = new Date(
    new Date(instant).getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60000,
  );
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
  };
}

/** 00:00:00.000 business time on the day `instant` falls on, as a UTC Date. */
function startOfBusinessDay(instant) {
  const { y, m, d } = businessDayParts(instant);
  return new Date(Date.UTC(y, m, d) - BUSINESS_UTC_OFFSET_MINUTES * 60000);
}

/** 23:59:59.999 business time on the day `instant` falls on, as a UTC Date. */
function endOfBusinessDay(instant) {
  const { y, m, d } = businessDayParts(instant);
  return new Date(
    Date.UTC(y, m, d, 23, 59, 59, 999) - BUSINESS_UTC_OFFSET_MINUTES * 60000,
  );
}

/**
 * A date boundary from user input.
 *
 * Returns `{ ok, value }` rather than throwing or defaulting: a route that
 * silently swallows `asOf=yesterday` and reports as-of-today has produced a
 * document an accountant will sign.
 *
 * A bare `YYYY-MM-DD` is read as that calendar date IN BUSINESS TIME, and
 * `end: true` pushes it to 23:59:59.999 there — so "as on 31 August" means the
 * same instant whether the process runs in UTC or in IST. Anything carrying
 * its own time or zone is honoured as given; only a date-only string is
 * interpreted, because only a date-only string is ambiguous.
 */
const DATE_ONLY_RX = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBoundary(raw, { end = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false, value: null };
  if (!DATE_ONLY_RX.test(s)) return { ok: true, value: d };
  // `new Date("2026-08-31")` is UTC midnight; re-read its calendar date and
  // rebuild the boundary in business time.
  const [y, m, day] = s.split("-").map(Number);
  const base = Date.UTC(y, m - 1, day) - BUSINESS_UTC_OFFSET_MINUTES * 60000;
  return {
    ok: true,
    value: new Date(end ? base + 86399999 : base),
  };
}

/**
 * THE DATE AN OUTSTANDING REPORT IS AS OF.
 *
 * Never null. A missing `asOf` used to mean "no upper bound", which quietly
 * put FUTURE-dated posted vouchers into a report headed "as on today" — a
 * receivable figure that includes an invoice dated next month is wrong in the
 * one direction that matters, and nothing on the page said so.
 *
 * So the absence of a date is resolved here, once, to the end of today in
 * business time. The value is carried on the report, printed in the header and
 * built into the filename, so an export can always be dated by looking at it.
 */
function effectiveAsOf(asOf, now = new Date()) {
  if (asOf instanceof Date && !Number.isNaN(asOf.getTime())) return asOf;
  return endOfBusinessDay(now);
}

/**
 * The ledger master's opening balance as a SIGNED number.
 *
 * `openingBalance` is documented as signed in the schema but is written
 * unsigned by several import paths, with the side carried in
 * `openingBalanceType`. Taking `abs()` and re-applying the type is the only
 * reading that is correct under both conventions.
 */
function openingSignedOf(ledger) {
  const sign = ledger && ledger.openingBalanceType === "Cr" ? -1 : 1;
  return sign * Math.abs((ledger && ledger.openingBalance) || 0);
}

/** opening + debits − credits. The whole accounting definition, in one line. */
function signedBalance(openingSigned, debit, credit) {
  return (openingSigned || 0) + (debit || 0) - (credit || 0);
}

/**
 * Which side a signed balance sits on, and what it means commercially.
 *
 * Dr → receivable (they owe us). Cr → a credit/advance we are holding.
 * These are NOT interchangeable and must never be summed into one total: a
 * customer sitting on a ₹1,00,000 advance does not reduce what the other
 * customers owe, and a receivables figure that nets them off understates the
 * debt the business is actually carrying.
 */
function classifyBalance(signed) {
  const v = Number(signed) || 0;
  if (v > ZERO_TOLERANCE) {
    return { type: "Dr", amount: round2(v), debit: round2(v), credit: 0 };
  }
  if (v < -ZERO_TOLERANCE) {
    return { type: "Cr", amount: round2(-v), debit: 0, credit: round2(-v) };
  }
  return { type: "Nil", amount: 0, debit: 0, credit: 0 };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * One report row from a ledger master plus its movement. PURE.
 *
 * The row carries the balance three ways, because three different readers need
 * three different things and none of them should have to re-derive the sign:
 *
 *   balance / balanceType   unsigned + side, the way a ledger is read aloud
 *   signedBalance           for sorting, summing and reconciling
 *   <primary> / <secondary> the two halves under this party kind's names —
 *                           `receivable`/`customerCredit` for a customer,
 *                           `payable`/`supplierAdvance` for a supplier
 *
 * @param {object} kind      a PARTY_KINDS descriptor or key
 * @param {object} ledger    lean Acc_Ledger doc
 * @param {object} movement  { debit, credit, transactionCount, lastTransactionDate }
 */
function buildOutstandingRow(kind, ledger, movement = {}) {
  const k = partyKind(kind);
  const openingSigned = openingSignedOf(ledger);
  const debit = round2(movement.debit || 0);
  const credit = round2(movement.credit || 0);
  const closingSigned = signedBalance(openingSigned, debit, credit);
  const cls = classifyBalance(closingSigned);
  const opening = classifyBalance(openingSigned);

  /* Which half is "the amount owed" depends only on the party kind. For a
   * customer that is the Dr side; for a supplier the Cr side. `cls.debit` and
   * `cls.credit` are the raw halves; these two are the same numbers under the
   * names the report prints. */
  const primary = k.primarySide === "Dr" ? cls.debit : cls.credit;
  const secondary = k.primarySide === "Dr" ? cls.credit : cls.debit;

  return {
    ledgerId: String(ledger._id),
    code: k.codeOf(ledger._id),
    name: ledger.name || "Unnamed",
    gstin: ledger.gstin || "",
    groupName: ledger.groupName || "",
    openingBalance: opening.amount,
    openingType: opening.type === "Nil" ? k.primarySide : opening.type,
    debit,
    credit,
    balance: cls.amount,
    balanceType: cls.type,
    signedBalance: round2(closingSigned),
    /* Party-neutral halves, so a shared writer never has to know the kind. */
    debitBalance: cls.debit,
    creditBalance: cls.credit,
    [k.primaryKey]: primary,
    [k.secondaryKey]: secondary,
    transactionCount: movement.transactionCount || 0,
    lastTransactionDate: movement.lastTransactionDate || null,
  };
}

/* ── PARTY CODES ────────────────────────────────────────────────────────────
 * The code printed on a report must be the code the user can see on screen and
 * type into a search box. The two screens derive it DIFFERENTLY, and inventing
 * a third derivation for the reports — as an earlier version of this file did
 * for suppliers — produces a document whose identifiers match nothing.
 *
 *   Customers  `C-` + base-36 of the id's last six hex characters, padded to
 *              five. Same as `customerCodeForId` in Acc_customers.js.
 *   Suppliers  `VEN-` + the id's last six hex characters, uppercased. Same as
 *              `VEN-${id.toString().substring(18, 24).toUpperCase()}` in
 *              Acc_vendors.js.
 *
 * Both read the LEDGER id, which is what the Vendors screen uses too when a
 * ledger exists (`vendorLedger?._id || vendor._id`) — so an imported Tally
 * creditor with no CMS vendor row and a CMS vendor linked to that same ledger
 * produce the same code, because they are the same ledger. */

/** `C-` + base-36 of the id's last six hex characters. Customers. */
function base36Code(objectId, prefix = "C-") {
  const hex = String(objectId).slice(-6);
  const num = parseInt(hex, 16);
  if (Number.isNaN(num)) return `${prefix}00000`;
  return prefix + num.toString(36).toUpperCase().padStart(5, "0");
}

/** `VEN-` + the id's last six hex characters, uppercased. Suppliers. */
function hex6Code(objectId, prefix = "VEN-") {
  const hex = String(objectId).slice(-6).toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) return `${prefix}000000`;
  return prefix + hex;
}

/** The code for a ledger, in the party kind's own format. */
function ledgerCode(objectId, kind) {
  return partyKind(kind).codeOf(objectId);
}

/**
 * Apply the balance-dependent filters. PURE.
 *
 * Search is applied in the database (see `resolvePartyLedgers`) because it can
 * use an index; these two cannot, because they need the computed balance.
 *
 * `balanceSide`:
 *   "debit"  → receivables only
 *   "credit" → customers in credit only
 *   "both"   → everything with a non-nil balance on either side
 *
 * `minOutstanding` is compared against the UNSIGNED balance magnitude, so a
 * minimum of 1,000 keeps a ₹5,000 credit as well as a ₹5,000 receivable when
 * both sides are asked for. It is a materiality threshold, not a sign filter —
 * the sign filter is `balanceSide`, and conflating the two would make
 * "credit balances over ₹1,000" impossible to ask for.
 */
function applyBalanceFilters(rows, { minOutstanding = 0, balanceSide = "both", includeZero = false } = {}) {
  const min = Number(minOutstanding) || 0;
  const side = ["debit", "credit", "both"].includes(balanceSide)
    ? balanceSide
    : "both";
  return rows.filter((r) => {
    if (side === "debit" && r.balanceType !== "Dr") return false;
    if (side === "credit" && r.balanceType !== "Cr") return false;
    if (!includeZero && r.balanceType === "Nil") return false;
    if (min > 0 && r.balance < min) return false;
    return true;
  });
}

/**
 * The two halves, counted separately.
 *
 * THEY ARE NEVER SUMMED INTO ONE FIGURE. A customer holding an advance does
 * not reduce what the other customers owe, and a supplier we have overpaid
 * does not reduce what we owe the others; a single netted "outstanding"
 * understates both the debt being carried and the money sitting with third
 * parties. `netBalance` is offered as a NAMED extra because the trial balance
 * does net them, and an accountant reconciling this report against the Sundry
 * control account needs that figure to do it — but it is never the headline.
 */
function totalsOf(kind, rows) {
  const k = partyKind(kind);
  let primary = 0;
  let secondary = 0;
  let primaryCount = 0;
  let secondaryCount = 0;
  let transactionCount = 0;
  for (const r of rows) {
    primary += r[k.primaryKey] || 0;
    secondary += r[k.secondaryKey] || 0;
    if (r.balanceType === k.primarySide) primaryCount += 1;
    else if (r.balanceType !== "Nil") secondaryCount += 1;
    transactionCount += r.transactionCount || 0;
  }
  return {
    ledgerCount: rows.length,
    [k.primaryCountKey]: primaryCount,
    [k.secondaryCountKey]: secondaryCount,
    transactionCount,
    [k.primaryKey]: round2(primary),
    [k.secondaryKey]: round2(secondary),
    /* Party-neutral aliases, so a shared writer can print the totals row
     * without knowing which kind produced it. */
    primaryTotal: round2(primary),
    secondaryTotal: round2(secondary),
    primaryCount,
    secondaryCount,
    netBalance: round2(primary - secondary),
  };
}

/**
 * Validate a report request. PURE — no database, no clock.
 *
 * Returns `{ errors, filters }`. A non-empty `errors` means the route answers
 * 400 and NOTHING is queried: an export whose scope could not be understood
 * must fail, never fall back to "everything".
 */
function parseReportQuery(query = {}, { partyLabel = "customer" } = {}) {
  const errors = [];

  const companyId = oid(query.companyId);
  if (!companyId) errors.push("A valid companyId is required.");

  const asOf = parseDateBoundary(query.asOf, { end: true });
  if (!asOf.ok) errors.push("asOf is not a valid date.");

  const from = parseDateBoundary(query.from, { end: false });
  if (!from.ok) errors.push("from is not a valid date.");

  const to = parseDateBoundary(query.to, { end: true });
  if (!to.ok) errors.push("to is not a valid date.");

  if (from.ok && to.ok && from.value && to.value && from.value > to.value) {
    errors.push("from must not be after to.");
  }

  let minOutstanding = 0;
  if (query.minOutstanding !== undefined && String(query.minOutstanding).trim() !== "") {
    const n = Number(query.minOutstanding);
    if (!Number.isFinite(n) || n < 0) {
      errors.push("minOutstanding must be a number of zero or more.");
    } else {
      minOutstanding = n;
    }
  }

  const rawSide = String(query.balanceSide || "both").toLowerCase();
  if (!["debit", "credit", "both"].includes(rawSide)) {
    errors.push('balanceSide must be one of "debit", "credit" or "both".');
  }

  const rawScope = String(query.scope || "all").toLowerCase();
  if (!["all", "filtered", "selected"].includes(rawScope)) {
    errors.push('scope must be one of "all", "filtered" or "selected".');
  }

  /* Ids arrive as repeated params, one comma-joined string, or a JSON array in
   * a POST body. Malformed entries are dropped here and the survivors are
   * re-resolved against the company and the Sundry Debtors group before they
   * are used — see `resolvePartyLedgers`. A caller cannot widen the report by
   * inventing an id, only narrow it. */
  const rawIds = []
    .concat(query.ledgerIds || [])
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const ledgerIds = [...new Set(rawIds.filter((s) => mongoose.isValidObjectId(s)))];
  if (rawIds.length > MAX_EXPORT_LEDGERS) {
    errors.push(`At most ${MAX_EXPORT_LEDGERS} ledgers can be exported at once.`);
  }

  /* ── PRESENT-BUT-EMPTY IS NOT THE SAME AS ABSENT ────────────────────────
   * "Current filtered result" with nothing matching must export an EMPTY
   * report. An absent `ledgerIds` on a scope that is defined by ids is a
   * caller bug, and the safe answer to a caller bug is a refusal — resolving
   * it to "no ids, therefore no narrowing, therefore every customer" is how a
   * filtered export silently becomes a full one. So the two cases are
   * distinguished by the PRESENCE of the parameter, before any parsing. */
  const ledgerIdsProvided =
    query.ledgerIds !== undefined && query.ledgerIds !== null;

  if (rawScope === "selected" && ledgerIds.length === 0) {
    errors.push(`Select at least one ${partyLabel} to export.`);
  }
  if (rawScope === "filtered" && !ledgerIdsProvided) {
    errors.push(
      "A filtered export must send the ledger ids it is filtered to (send an empty list for an empty result).",
    );
  }

  /* Which scopes are defined BY their id list rather than by server-side
   * filters. Both are re-resolved identically; the distinction is only what
   * the report header calls them. */
  const restrictToIds = rawScope === "selected" || rawScope === "filtered";

  return {
    errors,
    filters: {
      companyId,
      asOf: asOf.value,
      from: from.value,
      to: to.value,
      search: String(query.search || "").trim(),
      minOutstanding,
      balanceSide: rawSide,
      scope: rawScope,
      ledgerIds,
      ledgerIdsProvided,
      restrictToIds,
    },
  };
}

/**
 * The applied-filters line printed on the report.
 *
 * Every export must say what it was asked for; a spreadsheet of eleven
 * customers with no note of the filter that produced it is indistinguishable
 * from a spreadsheet of a company with eleven customers.
 */
function describeFilters(kind, filters = {}, { resolvedCount = null } = {}) {
  const k = partyKind(kind);
  const parts = [];
  const n = resolvedCount != null ? ` (${resolvedCount})` : "";
  if (filters.scope === "selected") {
    parts.push(`Scope: selected ${k.partyLabelPlural}${n}`);
  } else if (filters.scope === "filtered") {
    parts.push(`Scope: current filtered result${n}`);
  } else {
    parts.push(`Scope: all accounting ${k.partyLabelPlural}`);
  }
  /* Only meaningful for `all`. The id scopes deliberately do not re-apply the
   * screen's search — see `partyOutstandingReport`. */
  if (filters.search && !filters.restrictToIds) {
    parts.push(`Search: "${filters.search}"`);
  }
  if (filters.minOutstanding > 0) {
    parts.push(`Minimum balance: ₹${Number(filters.minOutstanding).toLocaleString("en-IN")}`);
  }
  const side = ["debit", "credit", "both"].includes(filters.balanceSide)
    ? filters.balanceSide
    : "both";
  parts.push(k.balanceSideLabels[side]);
  return parts.join(" · ");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Database reads                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Every group id under this company's "Sundry Debtors" tree.
 *
 * Sub-grouping is normal in Tally ("Sundry Debtors → Export", "→ Domestic"),
 * so a report that matched only the exact group name would silently omit most
 * of the customers. Same walk as `Acc_parties.groupIdsForKind`.
 */
async function partyGroupIds(kind, companyId) {
  const k = partyKind(kind);
  const cId = oid(companyId);
  if (!cId) return [];
  const all = await Acc_Group.find({ companyId: cId })
    .select("_id name parent parentName")
    .lean();
  if (!all.length) return [];

  const ids = new Set(
    all.filter((g) => k.groupRx.test(g.name || "")).map((g) => String(g._id)),
  );
  const byName = new Map(all.map((g) => [g.name, g]));

  let added = true;
  let guard = 0;
  while (added && guard < 20) {
    added = false;
    guard += 1;
    for (const g of all) {
      if (ids.has(String(g._id))) continue;
      const parentRef =
        (g.parent && String(g.parent)) ||
        (g.parentName && byName.get(g.parentName)
          ? String(byName.get(g.parentName)._id)
          : null);
      if (parentRef && ids.has(parentRef)) {
        ids.add(String(g._id));
        added = true;
      }
    }
  }
  return [...ids].map((s) => new mongoose.Types.ObjectId(s));
}

/**
 * The customer ledgers a request is allowed to see.
 *
 * ── WHY IDS ARE RE-RESOLVED ────────────────────────────────────────────────
 * `ledgerIds` come from a checkbox list in a browser. Trusting them would let
 * anyone who can reach the endpoint paste a ledger id belonging to another
 * company and receive its balance in a spreadsheet — the company-access check
 * on `companyId` would still pass, because the id they spoofed is not the
 * company they asked for. So the ids are never used as a lookup result; they
 * are used as an additional NARROWING clause on a query that is already
 * scoped to this company and to its Sundry Debtors groups. An id that does not
 * survive both is simply not in the answer.
 */
async function resolvePartyLedgers(
  kind,
  companyId,
  { ledgerIds = [], restrictToIds = false, search = "" } = {},
) {
  const cId = oid(companyId);

  /* `restrictToIds` says "the id list IS the population". An empty list under
   * it means an empty population — NOT an absent filter. Answering this before
   * touching Mongo is deliberate: the widening bug this prevents is one missing
   * clause away in any refactor of the query below. */
  const wanted = (ledgerIds || []).map(oid).filter(Boolean);
  if (restrictToIds && !wanted.length) return [];
  if (!cId) return [];

  const gIds = await partyGroupIds(kind, cId);
  if (!gIds.length) return [];

  const filter = {
    companyId: cId,
    groupId: { $in: gIds },
    isActive: { $ne: false },
  };

  if (restrictToIds || wanted.length) {
    filter._id = { $in: wanted };
  }

  if (search) {
    const rx = new RegExp(escapeRx(search), "i");
    filter.$or = [{ name: rx }, { aliases: rx }, { gstin: rx }];
  }

  return Acc_Ledger.find(filter)
    .select("name aliases gstin groupName openingBalance openingBalanceType")
    .sort({ name: 1 })
    .lean();
}

/**
 * Posted, non-optional movement per ledger up to (and including) `asOf`.
 *
 * `transactionCount` counts distinct VOUCHERS, not ledger lines: a journal
 * that debits and credits the same party twice is one transaction on the
 * statement, and reporting it as two makes the count disagree with the ledger
 * page the accountant will open to check it.
 */
async function movementByLedger(companyId, ledgerIds, { asOf = null, from = null } = {}) {
  const cId = oid(companyId);
  const ids = (ledgerIds || []).map(oid).filter(Boolean);
  if (!cId || !ids.length) return new Map();

  const match = {
    companyId: cId,
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": { $in: ids },
  };
  if (from || asOf) {
    match.voucherDate = {};
    if (from) match.voucherDate.$gte = from;
    if (asOf) match.voucherDate.$lte = asOf;
  }

  const agg = await Acc_Voucher.aggregate([
    { $match: match },
    { $unwind: "$ledgerEntries" },
    { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
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
        voucherIds: { $addToSet: "$_id" },
        lastTransactionDate: { $max: "$voucherDate" },
      },
    },
  ]);

  const out = new Map();
  for (const r of agg) {
    out.set(String(r._id), {
      debit: r.debit || 0,
      credit: r.credit || 0,
      transactionCount: (r.voucherIds || []).length,
      lastTransactionDate: r.lastTransactionDate || null,
    });
  }
  return out;
}

/** The company header every report carries. */
async function companyHeader(companyId) {
  const cId = oid(companyId);
  if (!cId) return null;
  const c = await Acc_Company.findById(cId)
    .select("companyName companyCode gstin address")
    .lean();
  if (!c) return null;
  return {
    companyId: String(c._id),
    companyName: c.companyName || "Company",
    companyCode: c.companyCode || null,
    gstin: c.gstin || null,
  };
}

/**
 * THE CUSTOMER OUTSTANDING SUMMARY.
 *
 * @param {object} filters  as produced by `parseReportQuery().filters`
 * @returns {object|null}   null when the company does not exist
 */
async function partyOutstandingReport(kind, filters = {}) {
  const k = partyKind(kind);
  const cId = oid(filters.companyId);
  if (!cId) return null;

  const company = await companyHeader(cId);
  if (!company) return null;

  /* NEVER null, and never open-ended. See `effectiveAsOf`. */
  const asOf = effectiveAsOf(filters.asOf);

  /* ── THE POPULATION ──────────────────────────────────────────────────────
   * `selected` and `filtered` are both defined by their id list. `search` is
   * NOT applied on top of one: the screen's search matches name, company name,
   * email, phone and customer code, while this service's search matches name,
   * aliases and GSTIN — so re-applying it here would DROP rows the user could
   * see, which is the exact divergence the id list exists to close. For
   * `all`, there is no id list and `search` is the only narrowing available.
   */
  const restrictToIds = !!filters.restrictToIds;
  const ledgers = await resolvePartyLedgers(k, cId, {
    ledgerIds: restrictToIds ? filters.ledgerIds : [],
    restrictToIds,
    search: restrictToIds ? "" : filters.search,
  });

  const moves = await movementByLedger(
    cId,
    ledgers.map((l) => l._id),
    { asOf },
  );

  const allRows = ledgers.map((l) =>
    buildOutstandingRow(k, l, moves.get(String(l._id)) || {}),
  );
  const rows = applyBalanceFilters(allRows, {
    minOutstanding: filters.minOutstanding,
    balanceSide: filters.balanceSide,
  });

  return {
    reportType: k.reportType,
    partyKind: k.key,
    title: k.summaryTitle,
    labels: {
      primary: k.primaryLabel,
      secondary: k.secondaryLabel,
      primaryKey: k.primaryKey,
      secondaryKey: k.secondaryKey,
      party: k.partyLabel,
      partyPlural: k.partyLabelPlural,
      column: k.columnLabel,
      group: k.groupLabel,
      totalPrimary: k.totalPrimaryLabel,
      totalSecondary: k.totalSecondaryLabel,
      primaryCountNoun: k.primaryCountNoun,
      secondaryCountNoun: k.secondaryCountNoun,
      primarySide: k.primarySide,
      filenameStem: k.filenameStem,
    },
    company,
    asOf,
    generatedAt: new Date(),
    filters: { ...filters, companyId: String(cId) },
    filterSummary: describeFilters(k, filters, {
      // The count AFTER re-resolution, so a spoofed or stale id is not counted
      // in a line an accountant reads as "this is what I asked for".
      resolvedCount: restrictToIds ? ledgers.length : null,
    }),
    /* How many party ledgers existed before the balance filters ran. An
     * accountant seeing 4 rows out of 120 wants to know the 116 were filtered
     * out, not missing. */
    consideredLedgerCount: allRows.length,
    rows,
    totals: totalsOf(k, rows),
  };
}

/**
 * THE INDIVIDUAL CUSTOMER LEDGER / STATEMENT OF ACCOUNT.
 *
 * ── THE OPENING BALANCE IS THE WHOLE POINT ──────────────────────────────────
 * For a date-range statement the opening balance at `from` is the ledger
 * master's opening balance PLUS every posted movement strictly before `from`.
 * Starting the running balance at the master opening while listing only the
 * in-range vouchers is the classic statement bug: every figure in the balance
 * column is wrong by the amount of the omitted history, and it looks perfectly
 * plausible. So the earlier movement is queried explicitly, and the closing
 * balance is asserted to be opening + in-range movement.
 *
 * @returns {object|null} null when the ledger is not a party of this kind in
 *                         this company
 */
async function partyLedgerStatement(kind, filters = {}) {
  const k = partyKind(kind);
  const cId = oid(filters.companyId);
  const lId = oid(filters.ledgerId);
  if (!cId || !lId) return null;

  const company = await companyHeader(cId);
  if (!company) return null;

  // Same re-resolution rule as the summary: the id is a narrowing clause on a
  // company- and group-scoped query, never a lookup in its own right.
  const [ledger] = await resolvePartyLedgers(k, cId, {
    ledgerIds: [String(lId)],
    restrictToIds: true,
  });
  if (!ledger) return null;

  const from = filters.from || null;
  // `to` wins when both are given; `asOf` alone means "everything up to here".
  const end = filters.to || filters.asOf || null;

  const masterOpeningSigned = openingSignedOf(ledger);

  // Movement BEFORE the window opens. Empty when no `from` was asked for.
  let priorSigned = 0;
  let priorCount = 0;
  if (from) {
    const priorEnd = new Date(from.getTime() - 1);
    const prior = await movementByLedger(cId, [ledger._id], { asOf: priorEnd });
    const p = prior.get(String(ledger._id));
    if (p) {
      priorSigned = (p.debit || 0) - (p.credit || 0);
      priorCount = p.transactionCount || 0;
    }
  }
  const openingSigned = masterOpeningSigned + priorSigned;

  const match = {
    companyId: cId,
    status: "posted",
    isOptional: { $ne: true },
    "ledgerEntries.ledgerId": ledger._id,
  };
  if (from || end) {
    match.voucherDate = {};
    if (from) match.voucherDate.$gte = from;
    if (end) match.voucherDate.$lte = end;
  }

  const vouchers = await Acc_Voucher.find(match)
    .select(
      "voucherType voucherTypeName voucherNumber voucherDate partyLedgerName narration ledgerEntries",
    )
    .sort({ voucherDate: 1, createdAt: 1, _id: 1 })
    .lean();

  let running = openingSigned;
  let debitTotal = 0;
  let creditTotal = 0;
  const rows = [];
  for (const v of vouchers) {
    let dr = 0;
    let cr = 0;
    let lineNarration = "";
    for (const e of v.ledgerEntries || []) {
      if (String(e.ledgerId) !== String(ledger._id)) continue;
      if (e.type === "Dr") dr += e.amount || 0;
      else cr += e.amount || 0;
      if (!lineNarration && e.narration) lineNarration = e.narration;
    }
    // A voucher can carry this ledger with a zero amount on both sides; it is
    // still a transaction on the statement and is listed.
    debitTotal += dr;
    creditTotal += cr;
    running += dr - cr;
    const cls = classifyBalance(running);
    rows.push({
      voucherId: String(v._id),
      date: v.voucherDate,
      voucherType: v.voucherTypeName || v.voucherType || "—",
      voucherNumber: v.voucherNumber || "",
      narration: v.narration || lineNarration || "",
      counterParty: v.partyLedgerName || "",
      debit: round2(dr),
      credit: round2(cr),
      runningBalance: cls.amount,
      runningType: cls.type === "Nil" ? k.primarySide : cls.type,
      runningSigned: round2(running),
    });
  }

  const opening = classifyBalance(openingSigned);
  const closing = classifyBalance(running);

  return {
    reportType: k.statementType,
    partyKind: k.key,
    title: k.statementTitle,
    labels: {
      primary: k.primaryLabel,
      secondary: k.secondaryLabel,
      party: k.partyLabel,
      partyPlural: k.partyLabelPlural,
      group: k.groupLabel,
      filenameStem: k.statementStem,
    },
    company,
    ledger: {
      ledgerId: String(ledger._id),
      code: k.codeOf(ledger._id),
      name: ledger.name,
      gstin: ledger.gstin || "",
      groupName: ledger.groupName || "",
    },
    from,
    to: filters.to || null,
    asOf: filters.asOf || null,
    periodEnd: end,
    generatedAt: new Date(),
    opening: {
      amount: opening.amount,
      type: opening.type === "Nil" ? k.primarySide : opening.type,
      signed: round2(openingSigned),
      /* Split out so the PDF can say "includes 14 earlier vouchers" — the one
       * line that tells a reader the opening is not the master opening. */
      masterOpening: round2(masterOpeningSigned),
      priorMovement: round2(priorSigned),
      priorVoucherCount: priorCount,
    },
    closing: {
      amount: closing.amount,
      type: closing.type === "Nil" ? k.primarySide : closing.type,
      signed: round2(running),
    },
    totals: {
      debit: round2(debitTotal),
      credit: round2(creditTotal),
      transactionCount: rows.length,
    },
    rows,
  };
}

module.exports = {
  // Constants
  PARTY_KINDS,
  partyKind,
  ZERO_TOLERANCE,
  MAX_EXPORT_LEDGERS,
  BUSINESS_UTC_OFFSET_MINUTES,

  // Pure
  oid,
  escapeRx,
  startOfBusinessDay,
  endOfBusinessDay,
  effectiveAsOf,
  parseDateBoundary,
  openingSignedOf,
  signedBalance,
  classifyBalance,
  round2,
  base36Code,
  hex6Code,
  ledgerCode,
  buildOutstandingRow,
  applyBalanceFilters,
  totalsOf,
  parseReportQuery,
  describeFilters,

  // Database
  partyGroupIds,
  resolvePartyLedgers,
  movementByLedger,
  companyHeader,
  partyOutstandingReport,
  partyLedgerStatement,
};
