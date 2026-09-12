// services/voucherNarration.service.js
//
// What this voucher is, in a sentence, when nobody wrote one.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Narration is blank on 395 of 797 payments and 288 of 446 purchases. That is
// not carelessness — it is a free-text box at the end of a form asking someone
// to restate, in prose, what they have just finished entering in fields. The
// honest reading of a half-empty column is that the question was not worth
// answering, so this answers it instead of nagging.
//
// It is a DEFAULT, never an override: anything typed is kept untouched. And it
// is derived only from what the voucher already carries — party, bill
// allocations, source document — so it cannot say anything the voucher does
// not already prove.
//
// Deliberately plain. "Payment to Acme Ltd against INV-0012" is useful on a
// statement; "Being amount paid vide cheque in favour of..." is Tally-era
// boilerplate that tells a reader nothing they cannot see in the columns.

"use strict";

const TYPE_WORDS = {
  sales: "Sales to",
  purchase: "Purchase from",
  receipt: "Receipt from",
  payment: "Payment to",
  credit_note: "Credit note for",
  debit_note: "Debit note to",
};

/** The bills this voucher settles, by name, in order, without repeats. */
function settledBillNames(voucher) {
  const out = [];
  for (const e of voucher?.ledgerEntries || []) {
    for (const a of e.billAllocations || []) {
      if (a.billType === "agst_ref" && a.billName && !out.includes(a.billName)) {
        out.push(a.billName);
      }
    }
  }
  return out;
}

/** "A", "A and B", "A, B and C", "A, B and 3 others" */
function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length <= 4) {
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} others`;
}

/**
 * A one-line description of a voucher, or "" when nothing honest can be said.
 *
 * @param {object} voucher  the voucher as it is about to be saved
 * @returns {string}
 */
function defaultNarration(voucher) {
  if (!voucher) return "";

  const party =
    voucher.partyLedgerName ||
    (voucher.ledgerEntries || []).find((e) => e.isPartyLedger)?.ledgerName ||
    "";

  const bills = settledBillNames(voucher);
  const lead = TYPE_WORDS[voucher.voucherType];

  /* A journal has no party and no single shape, so it is described by what it
     came from when that is known, and left alone otherwise. Inventing prose
     for an arbitrary Dr/Cr set would be noise dressed as information. */
  if (voucher.voucherType === "journal") {
    if (/payroll/i.test(voucher.sourceReference || voucher.sourceSystem || "")) {
      const d = voucher.voucherDate ? new Date(voucher.voucherDate) : null;
      const month = d
        ? d.toLocaleString("en-IN", { month: "long", year: "numeric" })
        : "";
      return month ? `Payroll for ${month}` : "Payroll posting";
    }
    return "";
  }

  if (voucher.voucherType === "contra") {
    const entries = voucher.ledgerEntries || [];
    const from = entries.find((e) => e.type === "Cr")?.ledgerName;
    const to = entries.find((e) => e.type === "Dr")?.ledgerName;
    return from && to ? `Transfer from ${from} to ${to}` : "";
  }

  if (!lead || !party) return "";

  let s = `${lead} ${party}`;
  if (bills.length) s += ` against ${joinNames(bills)}`;
  else if (voucher.referenceNumber) s += ` — ref ${voucher.referenceNumber}`;
  return s;
}

/**
 * Fill `narration` on a voucher only when it is empty.
 *
 * Returns true when something was written, so a caller can say so.
 */
function applyDefaultNarration(voucher) {
  if (!voucher) return false;
  const existing = String(voucher.narration || "").trim();
  if (existing) return false;
  const next = defaultNarration(voucher);
  if (!next) return false;
  voucher.narration = next;
  return true;
}

module.exports = { defaultNarration, applyDefaultNarration, joinNames };
