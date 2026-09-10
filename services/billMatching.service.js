/**
 * GRAV-CMS-BACKEND/services/billMatching.service.js
 *
 * Matching a receipt (or a payment) to the bills it actually settles.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * A receipt records that money arrived. It does NOT, on its own, say which
 * invoice the money was for. Bill-wise allocation is what says that, and in
 * this database it was optional: of 139 receipts, 124 carried no allocation at
 * all. So the invoice stayed open forever — the outstanding report kept asking
 * for money that had already been received, month after month.
 *
 * The new-receipt form has had an allocation picker for a while. That does not
 * help the receipts already entered, and it cannot help a receipt entered in a
 * hurry with the picker skipped. This service is the other half: match an
 * EXISTING receipt to existing bills, partially or fully, and unmatch it again.
 *
 * ── WHAT AN ALLOCATION IS, MECHANICALLY ─────────────────────────────────────
 * `billAllocations` rows live on the PARTY ledger entry of a voucher, and
 * services/openItems.service.js folds them by `billName` — signing each by its
 * ledger-entry side — to decide what is still open:
 *
 *   sales invoice   party entry Dr  →  new_ref   +amount   (opens the bill)
 *   receipt         party entry Cr  →  agst_ref  −amount   (settles it)
 *
 *   purchase bill   party entry Cr  →  new_ref   −amount
 *   payment         party entry Dr  →  agst_ref  +amount
 *
 * A bill is open while the signed sum is non-zero. So writing an `agst_ref`
 * row on a receipt is precisely what makes the outstanding go down, and
 * removing it is what puts it back. `billName` is the invoice's
 * `voucherNumber` — that convention is already established by the sales form
 * and by `GET /unpaid-invoices`, and this service does not invent a new one.
 *
 * ── WHY OUTSTANDING IS READ FROM openItems, NOT RECOMPUTED ──────────────────
 * There are two ways to ask "what is left on this bill": fold the allocations
 * (openItems, used by the ledger, the parties list and the aging report), or
 * take the invoice total and subtract receipts (what `/unpaid-invoices` does
 * for the entry form). If matching validated against one while the reports
 * showed the other, a bill could look settled on one screen and open on the
 * next. So the authority here is openItems — the same function the reports
 * use — which also means an opening balance or a Tally-imported bill can be
 * matched exactly like a bill raised in the CMS.
 *
 * ── THE RULES, AND WHY EACH ONE EXISTS ──────────────────────────────────────
 *  1. A voucher can never allocate more than its own party-side amount.
 *     Otherwise a ₹10,000 receipt could settle ₹50,000 of invoices and the
 *     books would show money that never arrived.
 *  2. A bill can never receive more than it has outstanding. Otherwise it goes
 *     negative and reads as an advance the customer never paid.
 *  3. Both limits count what OTHER vouchers have already allocated. This is
 *     the rule the user asked for in the strictest terms: a bill that is
 *     already matched cannot be matched again, and a receipt that is fully
 *     matched has nothing left to give.
 *  4. Allocation is only ever to bills of the SAME party. A receipt from
 *     customer A cannot settle customer B's invoice.
 *  5. Amounts must be positive and are rounded to paise. A zero or negative
 *     allocation is a deletion expressed confusingly; callers unmatch instead.
 *
 * Everything here is money, so every comparison uses a paise tolerance rather
 * than `===`: floating-point arithmetic on rupees produces 0.30000000000000004
 * and a strict comparison would refuse a perfectly exact full settlement.
 */

"use strict";

const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const openItems = require("./openItems.service");

/**
 * Half a paise. Below this two money figures are the same number.
 *
 * Deliberately tighter than openItems' SETTLED_TOLERANCE (a full rupee): that
 * one decides whether a bill is worth SHOWING as open, which is a display
 * judgement. This one decides whether an allocation is arithmetically legal,
 * and rounding a real rupee away there would let money leak.
 */
const EPSILON = 0.005;

/** Money, to paise. */
function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Voucher types that REDUCE what a party owes, and therefore settle a bill.
 *
 * Two pairs, and the difference between them is worth stating because it is
 * the thing people get wrong:
 *
 *   receipt / payment       — money moved. The debt is paid.
 *   credit_note / debit_note — money did NOT move. The debt was reduced
 *                             because goods came back, or were never
 *                             delivered, or were overbilled.
 *
 * A CREDIT NOTE DOES NOT CANCEL THE INVOICE. Under GST the invoice has
 * already been reported in GSTR-1; it cannot be unreported. The credit note
 * is the legal instrument that reverses it, and is itself reported (Table
 * 9B). Cancelling the invoice would erase a filed sale and break the audit
 * trail. So a matched credit note LINKS to its invoice and reduces the
 * outstanding — the invoice stays, permanently, with a credit against it.
 */
const SETTLING_TYPES = new Set(["receipt", "payment", "credit_note", "debit_note"]);

/** Which side of a voucher faces the party, per type. */
const PARTY_SIDE = {
  receipt: "Cr",
  credit_note: "Cr", // the customer owes less
  payment: "Dr",
  debit_note: "Dr", // we owe the supplier less
};

/**
 * Types that can settle an obligation the books recorded WITHOUT a party —
 * a payroll journal's Cr Salary Payable being the case that forced this.
 * Receipts are absent on purpose: money coming in settles a customer, and
 * widening that side is how the 66 false positives came back.
 */
const OBLIGATION_TYPES = new Set(["payment", "debit_note"]);

/** The document type a settlement of this voucher applies against. */
const SOURCE_TYPE = {
  receipt: "sales",
  credit_note: "sales",
  payment: "purchase",
  debit_note: "purchase",
};

/** A voucher whose allocations may be edited at all. */
function assertMatchable(voucher) {
  if (!voucher) {
    const e = new Error("Voucher not found.");
    e.status = 404;
    throw e;
  }
  if (!SETTLING_TYPES.has(voucher.voucherType)) {
    const e = new Error(
      `Only receipts, payments, credit notes and debit notes can be matched to bills — this is a ${voucher.voucherType}.`,
    );
    e.status = 400;
    throw e;
  }
  if (["cancelled", "void"].includes(voucher.status)) {
    const e = new Error(`Cannot match a ${voucher.status} voucher.`);
    e.status = 400;
    throw e;
  }
  return voucher;
}

/**
 * The ledger entry that faces the PARTY — the one allocations belong on.
 *
 * Only two things identify one: the explicit `isPartyLedger` flag, or the
 * voucher's own `partyLedgerId`. There is deliberately no "if there is just
 * one line on that side, use it" fallback any more.
 *
 * That fallback was wrong, and measurably so: of 139 receipts it claimed a
 * party for 66 that have none — bank interest, a director's loan, a machinery
 * purchase, transfers between two bank accounts. Those are not money from a
 * customer and can never settle a sales invoice, but the register showed every
 * one of them as "Unmatched" with a Match button that opened on an empty list.
 * A screen that asks somebody to fix 66 things that are not broken is worse
 * than one that says nothing.
 */
/**
 * EVERY party line on the settling side, not just the first.
 *
 * One cheque can settle two customers — RC/2627/00007 credits two Mayfair
 * hotels out of one ₹3,00,000 receipt. Taking `find()` and stopping made that
 * receipt look matchable for ₹1,52,000 while quietly ignoring the other
 * ₹1,48,000, which is worse than refusing it: half a receipt allocated looks
 * exactly like a whole one.
 */
function partyEntriesOf(voucher, liabilityLedgerIds = null) {
  const entries = voucher.ledgerEntries || [];
  const wantSide = PARTY_SIDE[voucher.voucherType] || "Cr";
  const flagged = entries.filter((e) => e.isPartyLedger && e.type === wantSide);
  if (flagged.length) return flagged;
  if (voucher.partyLedgerId) {
    const byId = entries.filter(
      (e) => e.ledgerId && String(e.ledgerId) === String(voucher.partyLedgerId) && e.type === wantSide,
    );
    if (byId.length) return byId;
  }

  /* ── PAYING SOMETHING THE BOOKS ALREADY OWE ───────────────────────────────
     Not every payable is a supplier bill. Posting payroll writes a JOURNAL —
     Dr Salaries, Cr Salary Payable — and the money leaves later on a payment
     voucher: Dr Salary Payable, Cr Bank. Neither carries a party: salary is
     owed to staff, not to a Sundry Creditor, so `isPartyLedger` is false on
     every line and `partyLedgerId` is unset. The payment was therefore
     "not against a customer or supplier account" and could not be matched to
     anything — the JV stayed open forever and the payment settled nothing.

     So a payment's Dr leg counts when it lands on a LIABILITY ledger: the
     books said we owed this, and this voucher is us paying it. The ids are
     passed in rather than guessed from the group name, because "Provisions",
     "Current Liabilities" and "Duties & Taxes" are all liabilities and no
     string test gets that right for long. Without the set, this returns
     nothing and every existing caller behaves exactly as it did.

     Deliberately NOT "the only line on that side". That fallback claimed a
     party for 66 of 139 receipts that have none — see the note above. A
     ledger's nature is a fact about the account; line count is a coincidence. */
  if (liabilityLedgerIds && OBLIGATION_TYPES.has(voucher.voucherType)) {
    return entries.filter(
      (e) =>
        e.type === wantSide &&
        e.ledgerId &&
        liabilityLedgerIds.has(String(e.ledgerId)),
    );
  }
  return [];
}

/**
 * Which ledgers on these vouchers are liabilities?
 *
 * One query for the whole page rather than one per voucher — `/unmatched`
 * summarises up to 500 at a time, and a lookup per voucher there is 500 round
 * trips to Mumbai for a fact that fits in a single `$in`.
 */
async function liabilityLedgerIdsFor(vouchers) {
  const list = Array.isArray(vouchers) ? vouchers : [vouchers];
  const ids = new Set();
  for (const v of list) {
    if (!v || !OBLIGATION_TYPES.has(v.voucherType)) continue;
    const wantSide = PARTY_SIDE[v.voucherType] || "Cr";
    for (const e of v.ledgerEntries || []) {
      if (e.type === wantSide && e.ledgerId) ids.add(String(e.ledgerId));
    }
  }
  if (!ids.size) return new Set();

  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  const rows = await Acc_Ledger.find({
    _id: { $in: [...ids] },
    nature: "liability",
  })
    .select("_id")
    .lean();
  return new Set(rows.map((r) => String(r._id)));
}

/**
 * The one party line this call is about.
 *
 * `partyLedgerId` picks a leg on a voucher that settles several parties; with
 * one party it is ignored, so every existing caller behaves as before.
 */
function findPartyEntry(voucher, partyLedgerId = null, liabilityLedgerIds = null) {
  const parties = partyEntriesOf(voucher, liabilityLedgerIds);
  if (partyLedgerId) {
    return parties.find((e) => String(e.ledgerId) === String(partyLedgerId)) || null;
  }
  if (parties.length) return parties[0];

  const entries = voucher.ledgerEntries || [];
  const wantSide = PARTY_SIDE[voucher.voucherType] || "Cr";

  const flagged = entries.find((e) => e.isPartyLedger && e.type === wantSide);
  if (flagged) return flagged;

  if (voucher.partyLedgerId) {
    const byId = entries.find(
      (e) =>
        e.ledgerId &&
        String(e.ledgerId) === String(voucher.partyLedgerId) &&
        e.type === wantSide,
    );
    if (byId) return byId;
  }

  return null;
}

/** Allocation rows that represent a settlement against a named bill. */
function settlementRows(entry) {
  return (entry?.billAllocations || []).filter(
    (a) => a.billType === "agst_ref" && a.billName,
  );
}

/**
 * What this voucher has, has used, and has left.
 *
 * `unallocated` is the headline: it is what the matching screen offers, and
 * zero means this voucher is fully matched and must be left alone.
 */
function matchStateOf(voucher, partyLedgerId = null, liabilityLedgerIds = null) {
  const entry = findPartyEntry(voucher, partyLedgerId, liabilityLedgerIds);
  if (!entry) {
    return {
      matchable: false,
      reason:
        "This voucher is not against a customer or supplier account, so there is no bill for it to settle.",
      total: 0,
      allocated: 0,
      unallocated: 0,
      allocations: [],
    };
  }

  const rows = settlementRows(entry);
  const allocated = money(rows.reduce((s, a) => s + (Number(a.amount) || 0), 0));
  const total = money(entry.amount);

  const parties = partyEntriesOf(voucher, liabilityLedgerIds);
  return {
    matchable: true,
    /* Every party this voucher settles, so a screen can offer a choice
       instead of silently working on the first. One entry for the ordinary
       case; the caller can ignore it entirely. */
    parties: parties.map((e) => ({
      ledgerId: e.ledgerId ? String(e.ledgerId) : null,
      ledgerName: e.ledgerName || "",
      amount: money(e.amount),
    })),
    multiParty: parties.length > 1,
    partyLedgerId: entry.ledgerId ? String(entry.ledgerId) : null,
    partyLedgerName: entry.ledgerName || voucher.partyLedgerName || "",
    total,
    allocated,
    unallocated: money(Math.max(0, total - allocated)),
    fullyMatched: total - allocated <= EPSILON,
    allocations: rows.map((a) => ({
      billName: a.billName,
      amount: money(a.amount),
      billType: a.billType,
    })),
  };
}

/**
 * The bills this voucher could settle, with what is left on each.
 *
 * Read through openItems so the number offered here is the same number the
 * outstanding report shows. A receipt is offered receivable bills (folded
 * remaining > 0); a payment is offered payables (< 0). The sign is dropped in
 * the response — a screen asking "how much of this ₹50,000 do you want to
 * settle?" should not have to reason about Dr and Cr.
 *
 * `excludeVoucherId` lets the caller ask "what would be open if THIS voucher's
 * own allocations were undone" — which is what an edit screen needs, so a bill
 * this receipt already settled is still offered, at its pre-settlement figure,
 * rather than vanishing.
 */
async function openBillsForVoucher(voucher, { excludeVoucherId = null, partyLedgerId = null, liabilityLedgerIds = null } = {}) {
  const liabilities =
    liabilityLedgerIds || (await liabilityLedgerIdsFor(voucher));
  const state = matchStateOf(voucher, partyLedgerId, liabilities);
  if (!state.matchable || !state.partyLedgerId) return [];

  const folded = await openItems.billsByLedger(voucher.companyId, [
    state.partyLedgerId,
  ]);

  /* This voucher's own rows are part of the fold. When re-opening a matching
     screen we add them back, so the bill shows what it would owe if this
     voucher were unmatched — otherwise a fully-settled bill disappears and
     the person cannot see, or adjust, what they did last time. */
  const ownByBill = new Map();
  if (excludeVoucherId && String(voucher._id) === String(excludeVoucherId)) {
    for (const a of state.allocations) {
      ownByBill.set(a.billName, (ownByBill.get(a.billName) || 0) + a.amount);
    }
  }

  const wantPositive = (PARTY_SIDE[voucher.voucherType] || "Cr") === "Cr";

  const fromFold = [...folded.values()]
    .map((bill) => {
      const own = ownByBill.get(bill.billName) || 0;
      /* Undoing a settlement moves `remaining` AWAY from zero, in whichever
         direction this voucher type settles from. */
      const remaining = bill.remaining + (wantPositive ? own : -own);
      return {
        billName: bill.billName,
        originalAmount: money(bill.originalAmount),
        outstanding: money(Math.abs(remaining)),
        signedRemaining: money(remaining),
        alreadyOnThisVoucher: money(own),
        firstVoucherDate: bill.firstVoucherDate || null,
        dueDate: bill.dueDate || bill.voucherDueDate || null,
        voucherNumbers: [...(bill.voucherNumbers || [])],
      };
    })
    .filter((b) =>
      wantPositive
        ? b.signedRemaining > EPSILON
        : b.signedRemaining < -EPSILON,
    );

  /* Invoices that never established a bill. Without these the screen tells a
     customer with a real unpaid invoice that they owe nothing — see
     unbilledInvoicesForParty. */
  const fromInvoices = await unbilledInvoicesForParty(voucher, folded, partyLedgerId);

  /* Journals that put an obligation on this very ledger — payroll's
     Cr Salary Payable being the one that matters. Only for the types that
     can settle one; for a receipt this is an empty list. */
  const fromJournals = await openJournalObligations(
    voucher,
    state.partyLedgerId,
    folded,
  );

  const seen = new Set(fromFold.map((b) => b.billName));
  const all = [
    ...fromFold,
    ...fromInvoices.filter((b) => !seen.has(b.billName)),
    ...fromJournals.filter((b) => !seen.has(b.billName)),
  ];

  return all.sort((a, b) => {
    const da = a.firstVoucherDate ? new Date(a.firstVoucherDate).getTime() : 0;
    const db = b.firstVoucherDate ? new Date(b.firstVoucherDate).getTime() : 0;
    return da - db; // oldest first — the order a person settles bills in
  });
}

/**
 * Invoices for this party that never established a bill reference.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * openItems only knows what `billAllocations` tells it. An invoice raised
 * without one is invisible to it — and 81 of 154 sales invoices in this
 * database have none, because the sales form only started writing `new_ref`
 * part-way through. So a customer could have a real, unpaid ₹1.4 lakh invoice
 * and the matching screen would say "nothing outstanding for this party",
 * which is exactly what it did say.
 *
 * These invoices are therefore reconstructed the way `/unpaid-invoices` does
 * it — face value, less credit notes, less anything already settled against
 * that number — and offered alongside the folded bills.
 *
 * An invoice counts as unbilled when no `new_ref` exists for its number. That
 * also catches the corrupt middle case: a bill carrying settlements but no
 * original, whose folded remaining is negative and reads as a credit the
 * customer never had.
 */
async function unbilledInvoicesForParty(voucher, foldedBills, partyLedgerId = null) {
  const state = matchStateOf(voucher, partyLedgerId);
  if (!state.matchable || !state.partyLedgerId) return [];

  const sourceType = SOURCE_TYPE[voucher.voucherType] || "sales";
  const noteType = sourceType === "sales" ? "credit_note" : "debit_note";

  const invoices = await Acc_Voucher.find({
    companyId: voucher.companyId,
    voucherType: sourceType,
    status: "posted",
    partyLedgerId: state.partyLedgerId,
  })
    .select("voucherNumber voucherDate grandTotal dueDate")
    .sort({ voucherDate: 1 })
    .limit(500)
    .lean();

  if (!invoices.length) return [];

  /* Already billed — the fold owns these, and offering them twice would let
     the same money be allocated against two versions of one bill. */
  const billed = new Set(
    [...foldedBills.values()]
      .filter((b) => b.originalAmount > EPSILON)
      .map((b) => b.billName),
  );
  const candidates = invoices.filter((i) => !billed.has(i.voucherNumber));
  if (!candidates.length) return [];

  const numbers = candidates.map((i) => i.voucherNumber);
  const ids = candidates.map((i) => i._id);

  /* Credit/debit notes raised against these invoices reduce what is owed. */
  /* Credit/debit notes raised against these invoices reduce what is owed —
     but ONLY the ones that do not already carry a bill allocation of their
     own. A note that is allocated is already counted in `settled` below, and
     subtracting it here as well would halve the invoice twice. */
  const notes = await Acc_Voucher.aggregate([
    {
      $match: {
        companyId: voucher.companyId,
        voucherType: noteType,
        status: { $in: ["posted", "pending_approval"] },
        "originalInvoice.voucherId": { $in: ids },
        "ledgerEntries.billAllocations.billType": { $ne: "agst_ref" },
      },
    },
    { $group: { _id: "$originalInvoice.voucherId", total: { $sum: "$grandTotal" } } },
  ]);
  const notedByInvoice = new Map(notes.map((n) => [String(n._id), n.total]));

  /* Whatever any voucher has already settled against these numbers — the
     fold has it as a negative remaining, and it still counts. */
  const settledByName = new Map();
  for (const b of foldedBills.values()) {
    if (numbers.includes(b.billName)) {
      settledByName.set(b.billName, Math.abs(b.remaining));
    }
  }

  return candidates
    .map((i) => {
      const face = Number(i.grandTotal) || 0;
      const credited = notedByInvoice.get(String(i._id)) || 0;
      const settled = settledByName.get(i.voucherNumber) || 0;
      return {
        billName: i.voucherNumber,
        originalAmount: money(face),
        outstanding: money(Math.max(0, face - credited - settled)),
        firstVoucherDate: i.voucherDate || null,
        dueDate: i.dueDate || null,
        voucherNumbers: [i.voucherNumber],
        /* The flag applyAllocations acts on: settling this needs the bill to
           be established on the invoice first. */
        needsBillReference: true,
        sourceVoucherId: i._id,
      };
    })
    .filter((b) => b.outstanding > EPSILON);
}

/**
 * Obligations a JOURNAL put on this ledger, and what is left on each.
 *
 * ── WHY A JOURNAL IS A BILL HERE ────────────────────────────────────────────
 * Posting payroll records the cost and the debt in one journal — Dr Salaries,
 * Cr Salary Payable — and paying it is a separate voucher, Dr Salary Payable /
 * Cr Bank. That Cr is a real obligation with a number on it. It is a bill in
 * every sense that matters to matching: an amount the books say we owe, on a
 * named ledger, that a payment can discharge in part or in full.
 *
 * A journal can credit several liability ledgers at once — PF Payable, ESI
 * Payable and Salary Payable all come out of the same payroll run — so the
 * obligation offered is this journal's Cr on THIS ledger only. Paying Salary
 * Payable must never look like it cleared the PF.
 *
 * The fold is ledger-scoped for the same reason, so a journal that is already
 * carrying its `new_ref` is handled by `fromFold` and skipped here.
 */
async function openJournalObligations(voucher, ledgerId, foldedBills) {
  if (!OBLIGATION_TYPES.has(voucher.voucherType) || !ledgerId) return [];

  const journals = await Acc_Voucher.find({
    companyId: voucher.companyId,
    voucherType: "journal",
    status: "posted",
    ledgerEntries: {
      $elemMatch: { ledgerId, type: "Cr" },
    },
  })
    .select("voucherNumber voucherDate narration ledgerEntries")
    .sort({ voucherDate: 1 })
    .limit(500)
    .lean();

  if (!journals.length) return [];

  /* Already carrying a reference — the fold owns it, and offering it twice
     would let one obligation be allocated against two copies of itself. */
  const billed = new Set(
    [...foldedBills.values()]
      .filter((b) => b.originalAmount > EPSILON)
      .map((b) => b.billName),
  );

  /* What any voucher has already put against these numbers on this ledger. */
  const settledByName = new Map();
  for (const b of foldedBills.values()) {
    settledByName.set(b.billName, Math.abs(b.remaining));
  }

  const out = [];
  for (const j of journals) {
    if (billed.has(j.voucherNumber)) continue;

    const owed = (j.ledgerEntries || [])
      .filter(
        (e) => e.ledgerId && String(e.ledgerId) === String(ledgerId) && e.type === "Cr",
      )
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    if (owed <= EPSILON) continue;

    const settled = settledByName.get(j.voucherNumber) || 0;
    const outstanding = money(Math.max(0, owed - settled));
    if (outstanding <= EPSILON) continue;

    out.push({
      billName: j.voucherNumber,
      originalAmount: money(owed),
      outstanding,
      /* Payables are negative in the fold's sign convention, and a screen
         filtering on it must see this the same way as a purchase bill. */
      signedRemaining: money(-outstanding),
      alreadyOnThisVoucher: 0,
      firstVoucherDate: j.voucherDate || null,
      dueDate: null,
      voucherNumbers: [j.voucherNumber],
      /* What it is, so the screen can say "Journal" rather than implying a
         supplier invoice that does not exist. */
      sourceVoucherType: "journal",
      sourceLabel: j.narration || "Journal",
      needsBillReference: true,
      sourceVoucherId: j._id,
      /* ensureBillReference cannot infer which line to stamp on a journal —
         a payroll JV credits three different liabilities. */
      referenceLedgerId: String(ledgerId),
    });
  }
  return out;
}

/**
 * Give an invoice the bill reference it should always have carried.
 *
 * Writing an `agst_ref` settlement against an invoice that has no `new_ref`
 * would make the fold read −X for that bill: a credit the customer never had,
 * on a report that is supposed to be showing what they owe. So before the
 * settlement is recorded, the invoice is given the `new_ref` its own number
 * implies, at its face value. Idempotent, and it changes no total on the
 * invoice — `billAllocations` are a reference, not a posting.
 */
async function ensureBillReference(sourceVoucherId, referenceLedgerId = null) {
  const invoice = await Acc_Voucher.findById(sourceVoucherId);
  if (!invoice) return false;

  const wantSide = invoice.voucherType === "sales" ? "Dr" : "Cr";
  const entries = invoice.ledgerEntries || [];

  /* A journal has no party line, and picking the wrong one would put the
     reference on the PF when the payment cleared the salary. The caller names
     the ledger; without a name there is nothing safe to guess, so refuse. */
  let party;
  if (invoice.voucherType === "journal") {
    if (!referenceLedgerId) return false;
    party = entries.find(
      (e) =>
        e.ledgerId &&
        String(e.ledgerId) === String(referenceLedgerId) &&
        e.type === "Cr",
    );
  } else {
    party =
      entries.find((e) => e.isPartyLedger && e.type === wantSide) ||
      (invoice.partyLedgerId &&
        entries.find(
          (e) => e.ledgerId && String(e.ledgerId) === String(invoice.partyLedgerId) && e.type === wantSide,
        ));
  }
  if (!party) return false;

  const existing = (party.billAllocations || []).find(
    (a) => a.billType === "new_ref" && a.billName === invoice.voucherNumber,
  );
  if (existing) return true;

  party.billAllocations = [
    ...(party.billAllocations || []),
    {
      billName: invoice.voucherNumber,
      billType: "new_ref",
      amount: money(party.amount || invoice.grandTotal),
      ...(invoice.dueDate ? { dueDate: invoice.dueDate } : {}),
    },
  ];
  invoice.markModified("ledgerEntries");
  await invoice.save();
  return true;
}

/**
 * Match a voucher to bills. REPLACES this voucher's settlements wholesale.
 *
 * Replace rather than append, deliberately: "set the allocations to this" is
 * an operation a screen can express idempotently, where "add these" makes a
 * double-submitted form allocate twice. Unmatching is therefore just an empty
 * list, and re-matching is a correction rather than an accumulation.
 *
 * @param {object} voucher            a Mongoose document (saved by the caller)
 * @param {Array}  requested          [{ billName, amount }]
 * @returns {Promise<object>}         the new match state
 */
async function applyAllocations(voucher, requested = [], { partyLedgerId = null } = {}) {
  assertMatchable(voucher);

  /* Resolved here too, or a payroll payment would pass the read path and then
     be refused at the write with "no single party ledger line" — the screen
     offering bills it cannot then accept. */
  const liabilities = await liabilityLedgerIdsFor(voucher);
  const entry = findPartyEntry(voucher, partyLedgerId, liabilities);
  if (!entry) {
    const e = new Error(
      "This voucher has no single party ledger line, so there is nothing to match it against.",
    );
    e.status = 400;
    throw e;
  }

  /* Normalise and merge duplicates: two rows for one bill is a UI accident,
     and silently keeping both would let the per-bill cap be bypassed. */
  const wanted = new Map();
  for (const r of requested || []) {
    const billName = String(r?.billName || "").trim();
    const amount = money(r?.amount);
    if (!billName) {
      const e = new Error("Every allocation needs a bill to match against.");
      e.status = 400;
      throw e;
    }
    if (!(amount > 0)) {
      const e = new Error(
        `Allocation for "${billName}" must be more than zero. To remove it, leave it out.`,
      );
      e.status = 400;
      throw e;
    }
    wanted.set(billName, money((wanted.get(billName) || 0) + amount));
  }

  const total = money(entry.amount);
  const sum = money([...wanted.values()].reduce((s, v) => s + v, 0));

  // Rule 1 — never allocate more than the voucher itself is worth.
  if (sum - total > EPSILON) {
    const e = new Error(
      `Allocations come to ₹${sum.toFixed(2)}, which is more than this ${voucher.voucherType} of ₹${total.toFixed(2)}.`,
    );
    e.status = 400;
    throw e;
  }

  if (wanted.size) {
    // Rules 2–4 — measured against the books with THIS voucher undone.
    const available = await openBillsForVoucher(voucher, {
      excludeVoucherId: voucher._id,
      partyLedgerId: entry.ledgerId,
      liabilityLedgerIds: liabilities,
    });
    const byName = new Map(available.map((b) => [b.billName, b]));

    /* Establish any missing bill reference FIRST — see ensureBillReference.
       Done before the settlement is written so the fold can never hold a
       settlement with no original behind it. */
    for (const [billName] of wanted) {
      const bill = byName.get(billName);
      if (bill?.needsBillReference && bill.sourceVoucherId) {
        await ensureBillReference(bill.sourceVoucherId, bill.referenceLedgerId || null);
      }
    }

    for (const [billName, amount] of wanted) {
      const bill = byName.get(billName);
      if (!bill) {
        const e = new Error(
          `"${billName}" is not an open bill for ${entry.ledgerName || "this party"}. It may already be settled, or it belongs to someone else.`,
        );
        e.status = 400;
        throw e;
      }
      if (amount - bill.outstanding > EPSILON) {
        const e = new Error(
          `"${billName}" has ₹${bill.outstanding.toFixed(2)} outstanding — you cannot allocate ₹${amount.toFixed(2)} to it.`,
        );
        e.status = 400;
        throw e;
      }
    }
  }

  /* Keep every non-settlement row (new_ref, advance, on_account) exactly as it
     was — this operation owns settlements and nothing else. */
  const preserved = (entry.billAllocations || []).filter(
    (a) => !(a.billType === "agst_ref" && a.billName),
  );

  const fresh = [...wanted.entries()].map(([billName, amount]) => ({
    billName,
    billType: "agst_ref",
    amount,
  }));

  /* Any remainder is money received without a bill named for it. Tally calls
     that "on account", and openItems ignores unnamed rows, so recording it
     keeps the voucher's own arithmetic honest without opening a phantom bill.
     Rebuilt each time so it can never drift from the settlements beside it. */
  const remainder = money(total - money(fresh.reduce((s, a) => s + a.amount, 0)));
  const kept = preserved.filter((a) => a.billType !== "on_account");
  if (remainder > EPSILON) {
    kept.push({ billType: "on_account", amount: remainder });
  }

  entry.billAllocations = [...kept, ...fresh];
  voucher.markModified("ledgerEntries");

  /* A CREDIT OR DEBIT NOTE ALSO CARRIES A GST LINK.
     `originalInvoice` / `originalBill` is what GSTR-1 Table 9B (and GSTR-2B
     reconciliation) reads to say which invoice a note reverses. The bill
     allocation above is what the outstanding reports read. They are two
     different consumers of the same fact, so matching sets both — a note
     that reduces a customer's balance but does not name the invoice on the
     return is a filing problem, not just a reporting one.

     Only when exactly ONE bill is settled: the field holds a single
     reference, and a note spread over three invoices has no honest answer
     to put in it. */
  if (["credit_note", "debit_note"].includes(voucher.voucherType)) {
    const field = voucher.voucherType === "credit_note" ? "originalInvoice" : "originalBill";
    if (fresh.length === 1) {
      const src = await Acc_Voucher.findOne({
        companyId: voucher.companyId,
        voucherNumber: fresh[0].billName,
        voucherType: SOURCE_TYPE[voucher.voucherType],
      }).select("_id voucherNumber voucherDate").lean();
      if (src) {
        voucher[field] = {
          voucherId: src._id,
          voucherNumber: src.voucherNumber,
          voucherDate: src.voucherDate,
        };
        voucher.markModified(field);
      }
    } else if (fresh.length === 0) {
      voucher[field] = {};
      voucher.markModified(field);
    }
  }

  /* The same liability set the leg was resolved with. Recomputing without it
     reported `matchable: false, allocated: 0` for a payroll payment that had
     just been allocated correctly — the write landed, the answer denied it. */
  return matchStateOf(voucher, entry.ledgerId, liabilities);
}

/** Unmatch: drop this voucher's settlements, keeping everything else. */
async function clearAllocations(voucher, { partyLedgerId = null } = {}) {
  return applyAllocations(voucher, [], { partyLedgerId });
}

module.exports = {
  EPSILON,
  PARTY_SIDE,
  SOURCE_TYPE,
  OBLIGATION_TYPES,
  liabilityLedgerIdsFor,
  openJournalObligations,
  partyEntriesOf,
  unbilledInvoicesForParty,
  ensureBillReference,
  SETTLING_TYPES,
  money,
  assertMatchable,
  findPartyEntry,
  matchStateOf,
  openBillsForVoucher,
  applyAllocations,
  clearAllocations,
};
