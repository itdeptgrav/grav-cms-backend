/**
 * GRAV-CMS-BACKEND/services/billTermsBackfillPlanner.service.js
 *
 * The decision logic for C0-F's historical due-date backfill. PURE — no
 * Mongo, no clock of its own. Given already-fetched open bills, an already-
 * fetched sidecar row (if any), already-fetched party terms and a company
 * default, it decides, per bill, exactly one of three things: the bill is
 * already dated, it can be honestly dated, or it cannot — and if it cannot,
 * it says why rather than guessing.
 *
 * The Mongo-touching half — fetching the bills, the sidecar rows, the party
 * terms, the company default, and (for apply) writing `Acc_BillTerms` —
 * lives in billTermsBackfillOrchestrator.service.js. This split is the same
 * one `creditTerms.service.js` (pure) / `voucherDueDateDefault.service.js`
 * (Mongo) and `budgetVariance.service.js` / `budgetActuals.service.js` used
 * before it, for the same reason: the part with real decisions in it should
 * be testable without a database.
 *
 * ── CORRECTION (24 Aug 2026) — THE SIDECAR IS NOW A REAL RUNG ──────────────
 * The first version of this ladder used `Acc_BillTerms` for nothing but an
 * informational `alreadyBackfilled` flag — a bill this collection had
 * already dated still showed as `to_apply` on every later preview, which
 * made coverage look permanently stuck at whatever it was before the very
 * first apply, no matter how many runs actually succeeded. Fixed: an
 * existing sidecar row now genuinely counts as dated, exactly as a stored
 * due date on the document itself would.
 *
 * ── THE LADDER ───────────────────────────────────────────────────────────
 * For each open bill, in order:
 *
 *   1. already_dated  (bill_allocation_due_date) — `billAllocations[].dueDate`,
 *      read via openItems' fold as `bill.dueDate`. The most specific,
 *      document-level source; nothing outranks it.
 *   2. already_dated  (voucher_due_date) — the voucher HEADER's own
 *      `dueDate`, read via openItems' fold as `bill.voucherDueDate`. Rare in
 *      this dataset, but a real, stated commitment when present.
 *   3. already_dated  (bill_terms) — an existing `Acc_BillTerms` row for
 *      this bill:
 *        - a MANUAL row (`isManual: true`) is ALWAYS already-dated,
 *          unconditionally — a human's override is never re-evaluated
 *          against what current terms would derive, and never overwritten.
 *        - a NON-manual row is already-dated only while it still matches
 *          what CURRENT party/company terms would derive. The moment those
 *          terms change enough to produce a different date/source/days, the
 *          bill falls through to rungs 4/5 below and is re-classified as
 *          `to_apply` — a genuinely changed proposal must still be able to
 *          update a row backfill itself created.
 *        - a non-manual row that no longer has ANY current derivation path
 *          (e.g. the party's terms were since cleared, and no company
 *          default exists to fall back to) still counts as already-dated:
 *          the stored value stands on its own; losing today's justification
 *          does not retroactively un-date a bill.
 *   4. no_basis_date — checked only once rungs 1–3 have found nothing: no
 *      first-voucher-date to derive FROM, so neither remaining rung can
 *      produce anything honest.
 *   5. party_terms — the bill's party ledger carries its own credit period
 *      (`creditPeriodDays > 0`). Always outranks the company default — a
 *      party's own negotiated terms are more specific and more trustworthy
 *      than a company-wide fallback.
 *   6. company_default_unset — no party terms, and the company has not set
 *      an explicit default either. BLOCKED. There is no built-in fallback
 *      number — undated is the correct outcome, not a bug to work around.
 *   7. company_default — no party terms, but the company HAS set an
 *      explicit default. Derives from it.
 *
 * `0` is unset at every rung that reads a credit-days figure — the party's
 * own `creditPeriodDays` and the company's `defaultCreditDays` both use the
 * exact rule `creditTerms.isTermSet` already enforces for C0-B's editor and
 * C0-C's voucher defaulting. This file does not re-implement that rule; it
 * imports it, so "0 means unset" can never drift between the three places
 * that must agree on it.
 */

const { isTermSet, resolveDueDate } = require("./creditTerms.service");
const { isOpen } = require("./openItems.service");

const BLOCKED_REASON = Object.freeze({
  NO_BASIS_DATE: "no_basis_date",
  COMPANY_DEFAULT_UNSET: "company_default_unset",
});

const SOURCE = Object.freeze({
  PARTY_TERMS: "party_terms",
  COMPANY_DEFAULT: "company_default",
});

/** Where an `already_dated` row's date actually came from — the visible
 *  breakdown this correction adds. Distinct from `SOURCE` above, which only
 *  ever applies to a `to_apply` row's PROPOSED derivation. */
const ALREADY_DATED_SOURCE = Object.freeze({
  BILL_ALLOCATION_DUE_DATE: "bill_allocation_due_date",
  VOUCHER_DUE_DATE: "voucher_due_date",
  BILL_TERMS: "bill_terms",
});

const STATUS = Object.freeze({
  ALREADY_DATED: "already_dated",
  TO_APPLY: "to_apply",
  BLOCKED: "blocked",
});

/** Two Date-or-null values, equal to the day. */
function sameDate(a, b) {
  if (!a || !b) return !a === !b; // both absent counts as equal; one absent does not
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * What CURRENT party/company terms would derive for this bill, or a reason
 * they cannot. Used both to build a `to_apply` proposal directly, AND to
 * decide whether an existing non-manual sidecar row is still correct.
 * Pure; no side effects.
 */
function deriveFromTerms(bill, { partyCreditDays, companyDefaultCreditDays }) {
  if (!bill.firstVoucherDate) {
    return { blockedReason: BLOCKED_REASON.NO_BASIS_DATE };
  }
  if (isTermSet(partyCreditDays)) {
    return {
      source: SOURCE.PARTY_TERMS,
      creditDaysUsed: partyCreditDays,
      proposedDueDate: resolveDueDate({
        voucherDate: bill.firstVoucherDate,
        partyLedger: { creditPeriodDays: partyCreditDays },
      }),
    };
  }
  if (!isTermSet(companyDefaultCreditDays)) {
    return { blockedReason: BLOCKED_REASON.COMPANY_DEFAULT_UNSET };
  }
  return {
    source: SOURCE.COMPANY_DEFAULT,
    creditDaysUsed: companyDefaultCreditDays,
    proposedDueDate: resolveDueDate({
      voucherDate: bill.firstVoucherDate,
      partyLedger: { creditPeriodDays: companyDefaultCreditDays },
    }),
  };
}

/**
 * Plan one bill. Pure; takes exactly the inputs the decision needs.
 *
 * @param {object} bill — a folded bill from openItems.service.js
 *   (`foldAllocations`/`billsByLedger`'s Map values): `{ ledgerId, billName,
 *   remaining, dueDate, voucherDueDate, firstVoucherDate, ... }`
 * @param {object} [opts]
 * @param {number|null} [opts.partyCreditDays] — the bill's party ledger's
 *   own `creditPeriodDays`, or null/undefined if the ledger wasn't found
 * @param {number|null} [opts.companyDefaultCreditDays] — the company's
 *   `defaultCreditDays`, or null/undefined if unset
 * @param {object|null} [opts.existingBillTerm] — the `Acc_BillTerms` row
 *   already stored for this exact bill, if any:
 *   `{ dueDate, source, creditDaysUsed, basisDate, isManual }`
 */
function planOne(bill, opts = {}) {
  const { partyCreditDays = null, companyDefaultCreditDays = null, existingBillTerm = null } = opts;

  const base = {
    key: `${bill.ledgerId}||${bill.billName}`,
    ledgerId: bill.ledgerId,
    billName: bill.billName,
    remaining: bill.remaining,
    remainingAbs: Math.abs(bill.remaining),
    remainingType: bill.remaining >= 0 ? "Dr" : "Cr",
    firstVoucherDate: bill.firstVoucherDate || null,
    alreadyBackfilled: !!existingBillTerm, // a sidecar row exists, whatever this run decides about it
    isManual: !!(existingBillTerm && existingBillTerm.isManual),
  };

  const alreadyDated = (existingDueDate, alreadyDatedSource, extra = {}) => ({
    ...base,
    status: STATUS.ALREADY_DATED,
    existingDueDate,
    alreadyDatedSource,
    source: extra.source ?? null,
    creditDaysUsed: extra.creditDaysUsed ?? null,
    proposedDueDate: null,
    blockedReason: null,
  });

  // Rung 1 — the document's own bill allocation carries a due date.
  if (bill.dueDate) {
    return alreadyDated(bill.dueDate, ALREADY_DATED_SOURCE.BILL_ALLOCATION_DUE_DATE);
  }

  // Rung 2 — the voucher header carries its own due date.
  if (bill.voucherDueDate) {
    return alreadyDated(bill.voucherDueDate, ALREADY_DATED_SOURCE.VOUCHER_DUE_DATE);
  }

  // Rung 3 — an existing sidecar row.
  if (existingBillTerm) {
    if (existingBillTerm.isManual) {
      // A human's override. Never re-evaluated, never overwritten.
      return alreadyDated(existingBillTerm.dueDate, ALREADY_DATED_SOURCE.BILL_TERMS, {
        source: existingBillTerm.source,
        creditDaysUsed: existingBillTerm.creditDaysUsed,
      });
    }

    const derivedNow = deriveFromTerms(bill, { partyCreditDays, companyDefaultCreditDays });

    const stillMatches =
      !derivedNow.blockedReason &&
      sameDate(existingBillTerm.dueDate, derivedNow.proposedDueDate) &&
      existingBillTerm.source === derivedNow.source &&
      existingBillTerm.creditDaysUsed === derivedNow.creditDaysUsed;

    // Terms can no longer derive ANYTHING (cleared since the original run) —
    // the stored value stands; losing today's justification does not
    // retroactively un-date a bill that was honestly dated when it was set.
    const nothingNewToPropose = !!derivedNow.blockedReason;

    if (stillMatches || nothingNewToPropose) {
      return alreadyDated(existingBillTerm.dueDate, ALREADY_DATED_SOURCE.BILL_TERMS, {
        source: existingBillTerm.source,
        creditDaysUsed: existingBillTerm.creditDaysUsed,
      });
    }

    // A genuine change: current terms derive something different from what
    // is stored. Fall through and propose the new value.
    return {
      ...base,
      status: STATUS.TO_APPLY,
      existingDueDate: existingBillTerm.dueDate,
      alreadyDatedSource: null,
      source: derivedNow.source,
      creditDaysUsed: derivedNow.creditDaysUsed,
      proposedDueDate: derivedNow.proposedDueDate,
      blockedReason: null,
    };
  }

  // No document-level date, no sidecar row at all — derive fresh.
  const derived = deriveFromTerms(bill, { partyCreditDays, companyDefaultCreditDays });
  if (derived.blockedReason) {
    return {
      ...base,
      status: STATUS.BLOCKED,
      existingDueDate: null,
      alreadyDatedSource: null,
      source: null,
      creditDaysUsed: null,
      proposedDueDate: null,
      blockedReason: derived.blockedReason,
    };
  }
  return {
    ...base,
    status: STATUS.TO_APPLY,
    existingDueDate: null,
    alreadyDatedSource: null,
    source: derived.source,
    creditDaysUsed: derived.creditDaysUsed,
    proposedDueDate: derived.proposedDueDate,
    blockedReason: null,
  };
}

/**
 * Plan a whole backfill run. Pure. Filters to OPEN bills only — a settled
 * bill has nothing to date — using the same `isOpen` (₹1 tolerance) that
 * defines the canonical "208 open items" figure everywhere else in C0, not
 * the ledger-detail statement's tighter ₹0.01 threshold. Backfilling a bill
 * the parties list would call settled would silently disagree with the
 * screen everyone actually reads.
 *
 * @param {Array} bills — folded bills (e.g. `[...billsByLedger(...).values()]`)
 * @param {object} opts
 * @param {Map} [opts.partyCreditDaysByLedgerId] — ledgerId (string) →
 *   creditPeriodDays. A ledger absent from the map reads as no terms set.
 * @param {number|null} [opts.companyDefaultCreditDays]
 * @param {Map} [opts.existingBillTermsByKey] — `${ledgerId}||${billName}` →
 *   `{ dueDate, source, creditDaysUsed, basisDate, isManual }`, the full
 *   stored sidecar row for a bill, when one exists.
 */
function planBackfill(bills, opts = {}) {
  const {
    partyCreditDaysByLedgerId = new Map(),
    companyDefaultCreditDays = null,
    existingBillTermsByKey = new Map(),
  } = opts;

  const rows = (bills || [])
    .filter((b) => b && isOpen(b))
    .map((bill) => {
      const key = `${bill.ledgerId}||${bill.billName}`;
      return planOne(bill, {
        partyCreditDays: partyCreditDaysByLedgerId.get(String(bill.ledgerId)) ?? null,
        companyDefaultCreditDays,
        existingBillTerm: existingBillTermsByKey.get(key) || null,
      });
    });

  const toApply = rows.filter((r) => r.status === STATUS.TO_APPLY);
  const blocked = rows.filter((r) => r.status === STATUS.BLOCKED);
  const alreadyDated = rows.filter((r) => r.status === STATUS.ALREADY_DATED);

  const totalOpen = rows.length;
  const datedBefore = alreadyDated.length;
  const datedAfter = datedBefore + toApply.length;

  return {
    rows,
    toApply,
    blocked,
    alreadyDated,
    totals: {
      totalOpen,
      toApplyCount: toApply.length,
      blockedCount: blocked.length,
      alreadyDatedCount: alreadyDated.length,
      bySource: {
        party_terms: toApply.filter((r) => r.source === SOURCE.PARTY_TERMS).length,
        company_default: toApply.filter((r) => r.source === SOURCE.COMPANY_DEFAULT).length,
      },
      alreadyDatedBySource: {
        bill_allocation_due_date: alreadyDated.filter(
          (r) => r.alreadyDatedSource === ALREADY_DATED_SOURCE.BILL_ALLOCATION_DUE_DATE,
        ).length,
        voucher_due_date: alreadyDated.filter(
          (r) => r.alreadyDatedSource === ALREADY_DATED_SOURCE.VOUCHER_DUE_DATE,
        ).length,
        bill_terms: alreadyDated.filter((r) => r.alreadyDatedSource === ALREADY_DATED_SOURCE.BILL_TERMS).length,
      },
      byBlockedReason: {
        no_basis_date: blocked.filter((r) => r.blockedReason === BLOCKED_REASON.NO_BASIS_DATE).length,
        company_default_unset: blocked.filter((r) => r.blockedReason === BLOCKED_REASON.COMPANY_DEFAULT_UNSET).length,
      },
    },
    coverage: {
      before: totalOpen > 0 ? Number(((datedBefore / totalOpen) * 100).toFixed(1)) : null,
      after: totalOpen > 0 ? Number(((datedAfter / totalOpen) * 100).toFixed(1)) : null,
    },
  };
}

module.exports = {
  BLOCKED_REASON,
  SOURCE,
  ALREADY_DATED_SOURCE,
  STATUS,
  planOne,
  planBackfill,
};
