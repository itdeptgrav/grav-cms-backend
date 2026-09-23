/**
 * GRAV-CMS-BACKEND/services/partyAgeing.service.js
 *
 * Invoice-wise ageing, for either side of the ledger.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * `Acc_reports.js` carries two ageing reports and neither is an accounting
 * one. `/receivables-aging` ages CRM Customer Requests by `createdAt` using
 * `quotations[0].grandTotal - totalPaidAmount`; `/payables-aging` ages
 * Purchase Orders by `orderDate` using `totalAmount - Σ payments`. Both age by
 * the DOCUMENT date rather than the due date, both reconcile with nothing in
 * the books, and neither has a company scope at all.
 *
 * This ages the BILLS — `billAllocations` grouped by `billName` across posted,
 * non-optional vouchers of one company up to one as-of date, the same
 * definition `openItems.service.js` already uses for the parties list and the
 * ledger-detail statement. Partial payments, further payments, credit notes
 * and debit notes are settlements against the bill and reduce it; the
 * remainder is what is aged.
 *
 * ── ONE ENGINE, BOTH SIDES ──────────────────────────────────────────────────
 * A customer invoice and a supplier bill are the same arithmetic seen from
 * opposite ends, and the only thing that differs is which sign means "still
 * owed". `foldAllocations` returns `remaining` in the LEDGER's convention —
 * Dr-positive — so:
 *
 *   customer  an unpaid invoice DEBITS them  → remaining > 0 is the receivable
 *   supplier  an unpaid bill CREDITS them    → remaining < 0 is the payable
 *
 * `PARTY_KINDS[kind].agedSign` (+1 / −1) is that difference, and it is the
 * whole of it. Everything else — the buckets, the due-date precedence, the
 * unallocated derivation, the reconciliation identity — is shared, which is
 * the point: two copies of a reconciliation is how one of them stops
 * reconciling without anybody noticing.
 *
 * Every figure this module reports is PARTY-FACING and positive: a payable is
 * a positive number on a supplier report, a receivable is a positive number on
 * a customer one.
 *
 * ── DUE DATES ARE READ, NEVER INVENTED ──────────────────────────────────────
 * In precedence order:
 *
 *   1. the bill allocation's own `dueDate` (from the `new_ref` row that RAISED
 *      the bill — see the note in openItems.service.js)
 *   2. the voucher header's `dueDate`
 *   3. the invoice/bill date plus the allocation's `creditDays`, and ONLY when
 *      that is a real, positive number stored on the document
 *   4. otherwise the bill is "Date unavailable" and is bucketed as such
 *
 * There is no fourth guess. The ledger master carries a `creditPeriodDays` and
 * the business has default terms, but applying either here would date a bill
 * from a rule that was not in force when it was raised, and an ageing report
 * whose buckets move when someone edits a master is not evidence of anything.
 * An undated bill is disclosed as undated, which is a finding.
 *
 * ── WHAT IS AGED, AND WHAT IS MERELY DISCLOSED ──────────────────────────────
 * Only bills still owed in the party's own direction are aged. Everything else
 * is shown separately and never netted into a bucket:
 *
 *   bill opposite   a bill settled past zero — an over-receipt against one
 *                   customer invoice, an over-payment against one supplier bill
 *   unallocated     the part of the ledger balance no bill explains: the
 *                   opening balance, `on_account`/`advance` movements, and
 *                   allocations posted with no bill name at all
 *
 * ── THE RECONCILIATION ──────────────────────────────────────────────────────
 * For every ledger, exactly:
 *
 *     aged − bill opposite + unallocated (party-signed) = ledger balance
 *                                                        (party-signed)
 *
 * where the ledger balance is opening + Σ debits − Σ credits over the same
 * company, the same as-of date and the same posted/non-optional filter the
 * Outstanding Summaries use. That identity is what ties this report to those
 * and to the General Ledger; it is computed per ledger, carried on every party
 * row, and asserted in the tests.
 *
 * ── READ-ONLY ───────────────────────────────────────────────────────────────
 * Nothing here writes.
 */

"use strict";

const party = require("./partyOutstanding.service");
const openItems = require("./openItems.service");

/**
 * The buckets, in report order.
 *
 * `notYetDue` and `unknown` are not overdue ages and deliberately sit at the
 * two ends: one is money that is not late, the other is money whose lateness
 * cannot be established. Putting either in a numbered bucket would overstate
 * or understate the overdue position.
 */
const AGEING_BUCKETS = [
  { key: "notYetDue", label: "Not yet due", min: null, max: 0 },
  { key: "d1_30", label: "1–30 days", min: 1, max: 30 },
  { key: "d31_60", label: "31–60 days", min: 31, max: 60 },
  { key: "d61_90", label: "61–90 days", min: 61, max: 90 },
  { key: "d90plus", label: "90+ days", min: 91, max: null },
  { key: "unknown", label: "Date unavailable", min: null, max: null },
];

const BUCKET_KEYS = AGEING_BUCKETS.map((b) => b.key);

/** A bill is settled below this. Matches the ledger-detail view's threshold. */
const SETTLED_TOLERANCE = openItems.LEDGER_DETAIL_SETTLED_THRESHOLD;

const DAY_MS = 86400000;

/* ────────────────────────────────────────────────────────────────────────── */
/* Pure — no database, no clock                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The due date of a folded bill, and where it came from. PURE.
 *
 * `source` is carried into the report so a reader can see WHY a bill is in the
 * bucket it is in — an ageing figure resting on a derived date is a different
 * quality of evidence from one resting on a date printed on the invoice.
 *
 * @param {object} bill  a folded bill from openItems.foldAllocations
 * @returns {{dueDate: Date|null, source: "allocation"|"voucher"|"creditDays"|"none"}}
 */
function resolveDueDate(bill) {
  const asDate = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  /* The `new_ref` row's date first, then any allocation row's.
   * `bill.dueDate` is first-ROW-wins over an unsorted aggregation, so on a
   * bill with a settlement against it, it is a coin toss whether that row is
   * the invoice (dated) or the receipt (not) — `refDueDate` is taken from the
   * document that raised the bill and is therefore stable. See the note in
   * openItems.service.js. */
  const raised = asDate(bill && bill.refDueDate);
  if (raised) return { dueDate: raised, source: "allocation" };

  const allocation = asDate(bill && bill.dueDate);
  if (allocation) return { dueDate: allocation, source: "allocation" };

  const header = asDate(bill && bill.voucherDueDate);
  if (header) return { dueDate: header, source: "voucher" };

  /* Only an EXPLICIT, positive credit-days figure stored on the allocation.
   * Zero is the schema default and means "unset", not "due on receipt" — the
   * same reading `Acc_parties.js` applies to `creditPeriodDays`. Treating it
   * as due-on-receipt would age every undated bill from its invoice date and
   * silently turn a data gap into a 90+ balance. */
  const days = Number(
    bill && bill.refCreditDays != null ? bill.refCreditDays : bill && bill.creditDays,
  );
  const invoiced = asDate(bill && bill.firstVoucherDate);
  if (invoiced && Number.isFinite(days) && days > 0) {
    return { dueDate: new Date(invoiced.getTime() + days * DAY_MS), source: "creditDays" };
  }

  return { dueDate: null, source: "none" };
}

/**
 * How many days overdue a bill is at `asOf`, and which bucket that is. PURE.
 *
 * Both dates are collapsed to their BUSINESS day before subtracting, so an
 * as-of timestamp of 23:59:59.999 and a due date stored at UTC midnight do not
 * differ by "0.77 of a day" and round the wrong way. A bill due today is NOT
 * overdue: the first overdue day is the day after the due date.
 */
function ageOf(dueDate, asOf) {
  if (!dueDate) return { bucket: "unknown", daysOverdue: null };
  const due = party.startOfBusinessDay(dueDate).getTime();
  const at = party.startOfBusinessDay(asOf).getTime();
  const days = Math.floor((at - due) / DAY_MS);
  if (days <= 0) return { bucket: "notYetDue", daysOverdue: 0 };
  if (days <= 30) return { bucket: "d1_30", daysOverdue: days };
  if (days <= 60) return { bucket: "d31_60", daysOverdue: days };
  if (days <= 90) return { bucket: "d61_90", daysOverdue: days };
  return { bucket: "d90plus", daysOverdue: days };
}

/** An all-zero bucket map. */
function emptyBuckets() {
  return BUCKET_KEYS.reduce((o, k) => ({ ...o, [k]: 0 }), {});
}

function round2(n) {
  return party.round2(n);
}

/**
 * Turn one ledger's folded bills into aged rows plus its disclosure figures.
 * PURE.
 *
 * @param {object} ledger        lean Acc_Ledger doc (for the row's identity)
 * @param {Array}  bills         folded bills for THIS ledger
 * @param {object} o
 * @param {Date}   o.asOf
 * @param {number} o.ledgerSigned  opening + Σ Dr − Σ Cr at asOf
 */
function ageLedger(kind, ledger, bills, { asOf, ledgerSigned = 0 } = {}) {
  const k = party.partyKind(kind);
  /* Turns the ledger's Dr-positive convention into the party's own. After
   * this line every quantity below is "how much is still owed in the
   * direction this report is about", and the customer and supplier maths are
   * literally the same expressions. */
  const sign = k.agedSign;
  const rows = [];
  const buckets = emptyBuckets();
  let agedTotal = 0;
  let billCredits = 0;
  let billsSigned = 0;
  let undatedCount = 0;

  for (const bill of bills || []) {
    if (!bill) continue;
    const owed = sign * bill.remaining;
    billsSigned += owed;

    if (Math.abs(owed) < SETTLED_TOLERANCE) continue; // settled

    if (owed < 0) {
      // Settled past zero against this ONE bill. An over-receipt from a
      // customer, an over-payment to a supplier. Not a negative age.
      billCredits += Math.abs(owed);
      continue;
    }

    const { dueDate, source } = resolveDueDate(bill);
    const { bucket, daysOverdue } = ageOf(dueDate, asOf);
    if (source === "none") undatedCount += 1;

    const remaining = round2(owed);
    buckets[bucket] += remaining;
    agedTotal += remaining;

    rows.push({
      ledgerId: String(ledger._id),
      code: k.codeOf(ledger._id),
      name: ledger.name || "Unnamed",
      gstin: ledger.gstin || "",
      billName: bill.billName,
      voucherType: bill.voucherTypeName || bill.voucherType || "",
      voucherNumbers: [...(bill.voucherNumbers || [])].join(", "),
      invoiceDate: bill.firstVoucherDate || null,
      dueDate,
      dueDateSource: source,
      creditDays: Number(bill.refCreditDays ?? bill.creditDays) || 0,
      originalAmount: round2(bill.originalAmount),
      remaining,
      daysOverdue,
      bucket,
    });
  }

  /* What no bill explains: the opening balance, on-account receipts, and
   * allocations posted with no bill name. Derived rather than queried — it is
   * exactly the part of the ledger the bill-wise view cannot see, and deriving
   * it is what makes the reconciliation below an identity rather than a hope. */
  const ledgerOwed = round2(sign * ledgerSigned);
  const unallocatedSigned = round2(ledgerOwed - billsSigned);

  return {
    rows,
    party: {
      ledgerId: String(ledger._id),
      code: k.codeOf(ledger._id),
      name: ledger.name || "Unnamed",
      gstin: ledger.gstin || "",
      buckets: BUCKET_KEYS.reduce((o, k) => ({ ...o, [k]: round2(buckets[k]) }), {}),
      openBillCount: rows.length,
      undatedBillCount: undatedCount,
      agedTotal: round2(agedTotal),
      /* Party-neutral names first, then this kind's own — so a shared writer
       * never has to know which side it is printing. */
      billOpposite: round2(billCredits),
      [k.billOppositeKey]: round2(billCredits),
      unallocatedSigned,
      unallocatedPrimary: unallocatedSigned > 0 ? unallocatedSigned : 0,
      unallocatedSecondary: unallocatedSigned < 0 ? round2(-unallocatedSigned) : 0,
      [k.unallocatedPrimaryKey]: unallocatedSigned > 0 ? unallocatedSigned : 0,
      [k.unallocatedSecondaryKey]:
        unallocatedSigned < 0 ? round2(-unallocatedSigned) : 0,
      ledgerBalance: round2(Math.abs(ledgerSigned)),
      ledgerBalanceType: ledgerSigned < 0 ? "Cr" : "Dr",
      ledgerSigned: round2(ledgerSigned),
      /* The ledger balance in the party's own direction: positive means the
       * party still owes us (customer) or we still owe them (supplier). */
      ledgerOwed,
      /* aged − billCredits + unallocated === ledger. Carried per party so a
       * single bad ledger is visible instead of only a bad grand total. */
      reconciles:
        Math.abs(
          round2(agedTotal) - round2(billCredits) + unallocatedSigned - ledgerOwed,
        ) < 0.02,
    },
  };
}

/** Sum the party roll-ups into the report totals. PURE. */
function totalsOf(kind, parties) {
  const k = party.partyKind(kind);
  const buckets = emptyBuckets();
  let agedTotal = 0;
  let billCredits = 0;
  let unallocatedReceivable = 0;
  let unallocatedCredit = 0;
  let ledgerReceivable = 0;
  let ledgerCredit = 0;
  let openBillCount = 0;
  let undatedBillCount = 0;

  for (const p of parties) {
    for (const k of BUCKET_KEYS) buckets[k] += p.buckets[k];
    agedTotal += p.agedTotal;
    billCredits += p.billOpposite;
    unallocatedReceivable += p.unallocatedPrimary;
    unallocatedCredit += p.unallocatedSecondary;
    openBillCount += p.openBillCount;
    undatedBillCount += p.undatedBillCount;
    /* Clamped PER LEDGER, exactly as the Outstanding Summary clamps it — so
     * these two are directly comparable with that report's own two totals
     * (`receivable`/`customerCredit`, `payable`/`supplierAdvance`). */
    if (p.ledgerOwed > 0) ledgerReceivable += p.ledgerOwed;
    else ledgerCredit += -p.ledgerOwed;
  }

  return {
    partyCount: parties.length,
    openBillCount,
    undatedBillCount,
    buckets: BUCKET_KEYS.reduce((o, k) => ({ ...o, [k]: round2(buckets[k]) }), {}),
    agedTotal: round2(agedTotal),
    // Party-neutral names, then this kind's own.
    billOpposite: round2(billCredits),
    unallocatedPrimary: round2(unallocatedReceivable),
    unallocatedSecondary: round2(unallocatedCredit),
    ledgerPrimary: round2(ledgerReceivable),
    ledgerSecondary: round2(ledgerCredit),
    [k.billOppositeKey]: round2(billCredits),
    [k.unallocatedPrimaryKey]: round2(unallocatedReceivable),
    [k.unallocatedSecondaryKey]: round2(unallocatedCredit),
    /* Directly comparable with the Outstanding Summary for the same company
     * and as-of date. */
    [k.ledgerPrimaryKey]: round2(ledgerReceivable),
    [k.ledgerSecondaryKey]: round2(ledgerCredit),
  };
}

/**
 * The applied-filters line.
 *
 * Says plainly which of the shared export filters this report does and does not
 * honour. `balanceSide` is an outstanding-summary idea — a ledger is Dr or Cr —
 * and has no meaning for a bill; printing a filter the report ignored would be
 * worse than saying so.
 */
function describeFilters(kind, filters = {}, { resolvedCount = null } = {}) {
  const k = party.partyKind(kind);
  const parts = [];
  const n = resolvedCount != null ? ` (${resolvedCount})` : "";
  if (filters.scope === "selected") parts.push(`Scope: selected ${k.partyLabelPlural}${n}`);
  else if (filters.scope === "filtered") parts.push(`Scope: current filtered result${n}`);
  else parts.push(`Scope: all accounting ${k.partyLabelPlural}`);

  if (filters.search && !filters.restrictToIds) parts.push(`Search: "${filters.search}"`);
  if (filters.minOutstanding > 0) {
    parts.push(
      `Minimum aged ${k.primaryKey === "receivable" ? "receivable" : "payable"}: ₹${Number(
        filters.minOutstanding,
      ).toLocaleString("en-IN")}`,
    );
  }
  /* "bills" for both kinds, deliberately: it is the generic accounting term
     for either side, and it is the exact string the customer report has been
     printing since Chunk 3. `billNounPlural` varies the Excel/PDF column
     headings, where "Invoice / Ref" and "Bill / Ref" genuinely differ. */
  parts.push("Ageing: by due date; undated bills shown separately");
  return parts.join(" · ");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Database                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * THE CUSTOMER INVOICE-WISE AGEING REPORT.
 *
 * Same scoping, same id re-resolution and same as-of default as the Customer
 * Outstanding Summary — it shares the engine for all three — so the two
 * reports cannot disagree about which customers exist or what date they are as
 * of. See the module header for the reconciliation identity.
 *
 * @param {object} filters  as produced by `parseReportQuery().filters`
 * @returns {object|null}   null when the company does not exist
 */
async function partyAgeingReport(kind, filters = {}) {
  const k = party.partyKind(kind);
  const cId = party.oid(filters.companyId);
  if (!cId) return null;

  const company = await party.companyHeader(cId);
  if (!company) return null;

  const asOf = party.effectiveAsOf(filters.asOf);

  const restrictToIds = !!filters.restrictToIds;
  const ledgers = await party.resolvePartyLedgers(k, cId, {
    ledgerIds: restrictToIds ? filters.ledgerIds : [],
    restrictToIds,
    search: restrictToIds ? "" : filters.search,
  });

  const ledgerIds = ledgers.map((l) => l._id);
  const [bills, moves] = await Promise.all([
    // Bill-wise positions, bounded by the SAME as-of date as the balances
    // below — a receipt banked after the date must not settle a bill that was
    // open on it.
    openItems.billsByLedger(cId, ledgerIds, { asOf }),
    party.movementByLedger(cId, ledgerIds, { asOf }),
  ]);

  const billsByLedgerId = new Map();
  for (const [, bill] of bills) {
    const lid = String(bill.ledgerId);
    if (!billsByLedgerId.has(lid)) billsByLedgerId.set(lid, []);
    billsByLedgerId.get(lid).push(bill);
  }

  const min = Number(filters.minOutstanding) || 0;
  const rows = [];
  const parties = [];

  for (const ledger of ledgers) {
    const lid = String(ledger._id);
    const move = moves.get(lid) || { debit: 0, credit: 0 };
    const ledgerSigned = party.signedBalance(
      party.openingSignedOf(ledger),
      move.debit,
      move.credit,
    );
    const aged = ageLedger(k, ledger, billsByLedgerId.get(lid) || [], {
      asOf,
      ledgerSigned,
    });

    /* A customer with nothing aged, nothing owed and nothing on account is not
     * a finding — it is a settled account, and printing it makes the report
     * longer without making it more informative. */
    const hasSomething =
      aged.party.agedTotal !== 0 ||
      aged.party.billOpposite !== 0 ||
      aged.party.unallocatedSigned !== 0;
    if (!hasSomething) continue;

    // A materiality threshold on what is being AGED. Deliberately not applied
    // to the disclosure figures: suppressing a credit or an unallocated
    // balance would break the reconciliation the report exists to support.
    if (min > 0 && aged.party.agedTotal < min) continue;

    parties.push(aged.party);
    rows.push(...aged.rows);
  }

  parties.sort((a, b) => b.agedTotal - a.agedTotal || a.name.localeCompare(b.name));
  rows.sort(
    (a, b) =>
      (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1) ||
      a.name.localeCompare(b.name) ||
      String(a.billName).localeCompare(String(b.billName)),
  );

  const totals = totalsOf(k, parties);

  return {
    reportType: k.ageingType,
    partyKind: k.key,
    title: k.ageingTitle,
    labels: {
      party: k.partyLabel,
      partyPlural: k.partyLabelPlural,
      column: k.columnLabel,
      group: k.groupLabel,
      filenameStem: k.ageingStem,
      agedNoun: k.agedNoun,
      billNoun: k.billNoun,
      billNounPlural: k.billNounPlural,
      billRefLabel: k.billRefLabel,
      billOpposite: k.billOppositeLabel,
      billOppositeHint: k.billOppositeHint,
      unallocatedPrimaryLine: k.unallocatedPrimaryLine,
      unallocatedSecondaryLine: k.unallocatedSecondaryLine,
      unallocatedSecondaryLinePdf: k.unallocatedSecondaryLinePdf,
      unallocatedPrimaryCol: k.unallocatedPrimaryCol,
      unallocatedSecondaryCol: k.unallocatedSecondaryCol,
      detailSheetName: k.detailSheetName,
      creditDaysSourceLabel: k.creditDaysSourceLabel,
      primaryLabel: k.primaryLabel,
      secondaryLabel: k.secondaryLabel,
      outstandingReportTitle: k.summaryTitle,
    },
    company,
    asOf,
    generatedAt: new Date(),
    buckets: AGEING_BUCKETS,
    filters: { ...filters, companyId: String(cId) },
    filterSummary: describeFilters(k, filters, {
      resolvedCount: restrictToIds ? ledgers.length : null,
    }),
    consideredLedgerCount: ledgers.length,
    rows,
    parties,
    totals,
    /* The tie-out an accountant checks first. `ledgerReceivable` /
     * `ledgerCredit` are the same per-ledger clamps the Customer Outstanding
     * Summary reports, so the two documents can be compared line for line. */
    reconciliation: {
      agedTotal: totals.agedTotal,
      billOpposite: totals.billOpposite,
      unallocatedPrimary: totals.unallocatedPrimary,
      unallocatedSecondary: totals.unallocatedSecondary,
      ledgerPrimary: totals.ledgerPrimary,
      ledgerSecondary: totals.ledgerSecondary,
      partiesOutOfBalance: parties.filter((p) => !p.reconciles).map((p) => p.ledgerId),
      reconciles: parties.every((p) => p.reconciles),
    },
  };
}

module.exports = {
  AGEING_BUCKETS,
  BUCKET_KEYS,
  SETTLED_TOLERANCE,
  resolveDueDate,
  ageOf,
  emptyBuckets,
  ageLedger,
  totalsOf,
  describeFilters,
  partyAgeingReport,
};
