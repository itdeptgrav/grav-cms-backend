// services/sales/paymentTermsResolution.service.js
//
// SALES — WHEN THIS ORDER GETS PAID, AS A FACT A COSTING CAN READ.
//
// ── WHY THE EXISTING RESOLVER IS NOT THIS ───────────────────────────────────
// `services/paymentTerms.js` already resolves Account → PO and gates
// production on the advance. It is unchanged and still does exactly that. But
// it answers at the PO stage — long after a costing is calculated — and the
// only duration it produces is a display string built from free text
// (`negotiatedTerms`, `paymentTermsCode`). A financing cost cannot be worked
// out from prose.
//
// So this answers the same question one record earlier and structurally: what
// did Sales agree for THIS enquiry, in numbers, and has anybody confirmed it.
//
// ── COPIED AT CONFIRMATION, NEVER READ THROUGH ──────────────────────────────
// The Account is the DEFAULT. Its values are copied onto the enquiry when
// Sales confirms them, and never resolved live afterwards — a customer
// renegotiating in November must not silently restate what an order costed in
// March was quoted on. Before confirmation the account's terms are offered as
// a suggestion and labelled as one; after it, the enquiry speaks for itself.
//
// ── AND UNANSWERED IS NEVER CASH ────────────────────────────────────────────
// The single mistake worth designing against: an enquiry nobody has answered
// reading as an order paid up front, therefore costing nothing to finance.
// "Paid up front" is `advancePercent: 100`, which somebody states. Silence is
// `not_started`, and the two are different states here.
//
// ── NO MONEY LEAVES THIS FILE ───────────────────────────────────────────────
// No financing rate, no financing amount, no margin. The rate and the
// methodology are the Board's; this publishes the DURATION and the advance,
// which is what the Board's rule has been missing.
"use strict";

const { PAYMENT_DUE_FROM } = require("../../constants/crm");

const DUE_FROM_CODES = Object.freeze(PAYMENT_DUE_FROM.map((p) => p.code));
const DUE_FROM_LABEL = Object.freeze(
  Object.fromEntries(PAYMENT_DUE_FROM.map((p) => [p.code, p.label])),
);

const str = (v) => String(v ?? "").trim();

/**
 * A percent that can actually be used. 0 is valid and means "no advance".
 *
 * The null/"" check is not redundant: `Number(null)` and `Number("")` are both
 * 0, so an UNSET field would otherwise read as a deliberate "0% agreed" — and
 * the whole contract turns on those two being different answers. Mirrors
 * `services/paymentTerms.js::usablePercent` deliberately, so the enquiry and
 * the PO cannot disagree about what an empty field means.
 */
function usablePercent(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** A whole number of days, or null. 0 is "due immediately", which is an answer. */
function usableDays(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
}

/* ── FIVE STATES, AND THREE OF THEM ARE ANSWERS ─────────────────────────────
 *
 * `NOT_APPLICABLE` is reachable ONLY through an explicit stated condition —
 * never from silence, and never from a 100% advance, which is a financing
 * duration of zero rather than an absence of financing. */
const TERMS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
  DRAFT: "DRAFT",
  NOT_STARTED: "NOT_STARTED",
});

/**
 * The Account's standing terms, reduced to what is usable.
 *
 * `paymentTermsCode` and `negotiatedTerms` are deliberately NOT read for
 * numbers. They are prose a person wrote — "NET30 subject to inspection" — and
 * parsing days out of them would be a guess presented as an agreement.
 */
function accountDefaults(account) {
  return {
    advancePercent: usablePercent(account?.advancePercent),
    creditDays: usableDays(account?.creditDays),
    /* Carried for display so a screen can show what the customer's paper
       says beside the structured figures. Never parsed. */
    paymentTermsCode: str(account?.paymentTermsCode),
    negotiatedTerms: str(account?.negotiatedTerms),
  };
}

/**
 * WHAT IS STILL MISSING FROM THIS ENQUIRY'S TERMS.
 *
 * Pure and exported, so every branch is exercised without a database.
 */
function gaps(terms = {}) {
  const out = [];
  if (terms.notApplicable) {
    if (!str(terms.notApplicableReason)) {
      out.push({ field: "notApplicableReason", message: "Say why financing does not apply to this order." });
    }
    return out;
  }
  if (usablePercent(terms.advancePercent) === null) {
    out.push({
      field: "advancePercent",
      message: "Say what advance is agreed. No advance is 0% — an empty field is not an answer.",
    });
  }
  /* ── A FULL ADVANCE NEEDS NO BALANCE TERM ─────────────────────────────
     100% received before production leaves nothing outstanding, so there is
     no duration to measure and asking for one would be a field whose only
     honest answer is "not applicable". Anything less does have a balance. */
  if (usablePercent(terms.advancePercent) !== 100) {
    if (usableDays(terms.creditDays) === null) {
      out.push({
        field: "creditDays",
        message: "Say how long the balance is outstanding. Due immediately is 0 days.",
      });
    } else if (usableDays(terms.creditDays) > 0 && !DUE_FROM_CODES.includes(str(terms.creditDaysFrom))) {
      /* Only a non-zero duration needs an anchor. "0 days from the invoice"
         and "0 days from dispatch" are the same term. */
      out.push({
        field: "creditDaysFrom",
        message: "Say what the days are counted from — thirty days from the invoice and from the "
          + "bill of lading differ by the whole shipping time.",
      });
    }
  }
  return out;
}

/** Has anybody put these terms in force? */
function stateOf(terms = {}) {
  const started = terms.notApplicable
    || usablePercent(terms.advancePercent) !== null
    || usableDays(terms.creditDays) !== null
    || Boolean(str(terms.creditDaysFrom))
    || Boolean(str(terms.note));
  if (!started) return TERMS.NOT_STARTED;
  if (gaps(terms).length) return TERMS.DRAFT;
  if (!terms.confirmedAt) return TERMS.DRAFT;
  return terms.notApplicable ? TERMS.NOT_APPLICABLE : TERMS.CONFIRMED;
}

/**
 * WHAT SALES IS OFFERED WHEN THEY OPEN AN UNANSWERED ENQUIRY.
 *
 * A suggestion drawn from the Account, clearly labelled as one. It is NOT
 * written anywhere until somebody confirms — a default silently saved is a
 * default nobody agreed to, and it would read afterwards as an agreement.
 */
function suggestionFor(account) {
  const d = accountDefaults(account);
  const has = d.advancePercent !== null || d.creditDays !== null;
  return {
    available: has,
    advancePercent: d.advancePercent,
    creditDays: d.creditDays,
    /* The Account records no anchor — `creditDays` predates the question. So
       a suggestion carries the days and leaves the event for Sales, rather
       than inventing an anchor the customer never agreed. */
    creditDaysFrom: null,
    paymentTermsCode: d.paymentTermsCode,
    negotiatedTerms: d.negotiatedTerms,
    label: has ? "The customer's standing terms" : null,
  };
}

/**
 * VALIDATE AND NORMALISE A SUBMITTED SET OF TERMS.
 *
 * Refuses rather than repairs. A save that quietly corrects half of what it
 * was sent is a save nobody can reason about — and here it would be a save
 * that records terms the customer never agreed.
 *
 * @returns {{ok: true, terms: object} | {ok: false, field: string, message: string}}
 */
function validate(input = {}, { account = null, confirm = false, actor = null, existing = null } = {}) {
  const notApplicable = input.notApplicable === true;

  if (notApplicable) {
    const reason = str(input.notApplicableReason);
    if (!reason) {
      return { ok: false, field: "notApplicableReason", message: "Say why financing does not apply to this order." };
    }
    return {
      ok: true,
      terms: {
        notApplicable: true,
        notApplicableReason: reason.slice(0, 500),
        note: str(input.note).slice(0, 1000),
        source: "ENQUIRY",
        ...(confirm ? { confirmedAt: new Date(), confirmedBy: actor || undefined } : {}),
      },
    };
  }

  /* ── EACH FIELD IS REFUSED BY NAME ────────────────────────────────────
     "Invalid payment terms" tells somebody nothing about which box to fix. */
  const advanceRaw = input.advancePercent;
  if (advanceRaw !== undefined && advanceRaw !== null && advanceRaw !== "" && usablePercent(advanceRaw) === null) {
    return { ok: false, field: "advancePercent", message: "An advance is a percentage between 0 and 100." };
  }
  const daysRaw = input.creditDays;
  if (daysRaw !== undefined && daysRaw !== null && daysRaw !== "" && usableDays(daysRaw) === null) {
    return { ok: false, field: "creditDays", message: "Credit days is a whole number of days, not negative." };
  }
  const from = str(input.creditDaysFrom);
  if (from && !DUE_FROM_CODES.includes(from)) {
    return { ok: false, field: "creditDaysFrom", message: "Choose what the days are counted from." };
  }

  const advancePercent = usablePercent(advanceRaw);
  const creditDays = usableDays(daysRaw);

  /* ── THE INCOMPATIBLE COMBINATION ─────────────────────────────────────
     A full advance leaves no balance, so a credit period against it is two
     statements that contradict each other. Refused rather than silently
     dropped: somebody who typed both meant one of them. */
  if (advancePercent === 100 && creditDays !== null && creditDays > 0) {
    return {
      ok: false, field: "creditDays",
      message: "A 100% advance leaves no balance outstanding. Clear the credit period, or reduce the advance.",
    };
  }

  const terms = {
    notApplicable: false,
    notApplicableReason: "",
    ...(advancePercent !== null ? { advancePercent } : {}),
    ...(creditDays !== null ? { creditDays } : {}),
    /* An anchor is meaningless without days, and a zero duration needs none. */
    ...(from && creditDays !== null && creditDays > 0 ? { creditDaysFrom: from } : {}),
    note: str(input.note).slice(0, 1000),
  };

  if (confirm) {
    const remaining = gaps(terms);
    if (remaining.length) {
      return { ok: false, field: remaining[0].field, message: remaining[0].message };
    }
    const d = accountDefaults(account);
    /* ── WHERE THESE NUMBERS CAME FROM ──────────────────────────────────
       `ACCOUNT` only when they match the standing terms exactly. Re-typing
       the customer's own figures is agreement, not deviation — flagging it
       as an override would make the flag meaningless, which is the same
       reasoning `services/paymentTerms.js` already applies to the PO. */
    const matchesAccount = d.advancePercent !== null
      && d.advancePercent === (terms.advancePercent ?? null)
      && d.creditDays === (terms.creditDays ?? null);
    terms.source = matchesAccount ? "ACCOUNT" : "ENQUIRY";
    /* Snapshotted so an override stays auditable as a DIFFERENCE after the
       Account moves again. */
    terms.accountDefaultAtConfirmation = {
      ...(d.advancePercent !== null ? { advancePercent: d.advancePercent } : {}),
      ...(d.creditDays !== null ? { creditDays: d.creditDays } : {}),
    };
    terms.confirmedAt = new Date();
    terms.confirmedBy = actor || undefined;
  } else if (existing?.confirmedAt) {
    /* An edit after confirmation re-opens the terms rather than keeping the
       old confirmation against new numbers. Confirming is a deliberate act
       and has to be repeated. */
    terms.confirmedAt = undefined;
    terms.confirmedBy = undefined;
    terms.source = undefined;
  }

  return { ok: true, terms };
}

/**
 * THE PROJECTION CENTRAL COSTING READS.
 *
 * Read-only, and carries no rate, no amount and no margin. What it publishes
 * is the DURATION and the advance — the two facts the Board's financing rule
 * has never had.
 *
 * ── AND IT IS ONLY EVER THE ENQUIRY'S OWN ───────────────────────────────────
 * No account fallback. An unconfirmed enquiry is unanswered, full stop: the
 * point of confirmation is that somebody looked at the standing terms and said
 * they apply to this order, and reading through would make that act
 * decorative.
 */
function projectionFor(enquiry) {
  const t = enquiry?.paymentTerms || {};
  const state = stateOf(t);
  const confirmed = state === TERMS.CONFIRMED;
  const advancePercent = usablePercent(t.advancePercent);
  const creditDays = usableDays(t.creditDays);

  return {
    state,
    /* Money is out from the moment the company spends until the customer
       pays. Published as the agreed terms; turning them into a number of
       financed days is the Board's methodology, not Sales' to assert. */
    advancePercent: confirmed ? advancePercent : null,
    creditDays: confirmed ? creditDays : null,
    creditDaysFrom: confirmed && creditDays > 0 ? (str(t.creditDaysFrom) || null) : null,
    creditDaysFromLabel: confirmed && creditDays > 0
      ? (DUE_FROM_LABEL[str(t.creditDaysFrom)] || null) : null,
    notApplicable: state === TERMS.NOT_APPLICABLE,
    notApplicableReason: state === TERMS.NOT_APPLICABLE ? str(t.notApplicableReason) : "",
    /* Provenance, so a costing can say whether these were the customer's
       standing terms or something agreed for this order. */
    source: confirmed || state === TERMS.NOT_APPLICABLE ? (str(t.source) || null) : null,
    overridden: confirmed && str(t.source) === "ENQUIRY"
      && (t.accountDefaultAtConfirmation?.advancePercent !== undefined
        || t.accountDefaultAtConfirmation?.creditDays !== undefined),
    accountDefaultAtConfirmation: confirmed && t.accountDefaultAtConfirmation
      ? {
        advancePercent: usablePercent(t.accountDefaultAtConfirmation.advancePercent),
        creditDays: usableDays(t.accountDefaultAtConfirmation.creditDays),
      }
      : null,
    confirmedAt: confirmed || state === TERMS.NOT_APPLICABLE ? (t.confirmedAt || null) : null,
    confirmedByName: confirmed || state === TERMS.NOT_APPLICABLE ? str(t.confirmedBy?.name) : "",
    /* What is still missing, named by field, for a screen that has to say so. */
    gaps: state === TERMS.CONFIRMED || state === TERMS.NOT_APPLICABLE ? [] : gaps(t),
  };
}

module.exports = {
  TERMS, DUE_FROM_CODES, DUE_FROM_LABEL,
  usablePercent, usableDays, accountDefaults,
  gaps, stateOf, suggestionFor, validate, projectionFor,
};
