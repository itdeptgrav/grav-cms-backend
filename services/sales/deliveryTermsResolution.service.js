// services/sales/deliveryTermsResolution.service.js
//
// SALES — HOW THIS ORDER IS DELIVERED, AS A FACT A COSTING CAN READ.
//
// ── WHY THIS EXISTS, AND WHAT IT CORRECTS ───────────────────────────────────
//
// Payment terms and delivery terms are the same kind of agreement — the
// customer's standing term, which one deal may depart from — and until now the
// two were resolved by opposite rules:
//
//   • `paymentTermsResolution` COPIES the Account's terms onto the enquiry when
//     Sales confirms them, and never reads the Account again. A customer
//     renegotiating in November cannot restate what an order costed in March
//     was quoted on.
//   • freight read the Account LIVE, on every costing run
//     (`freightSource.service.js` used to load `Account.freightArrangement` and
//     fall back to it). Editing the customer's standing term silently changed
//     the arrangement an existing draft costing was built on — retrospectively,
//     with nothing recorded to say it had happened.
//
// This file makes delivery behave like payment: the Account is a SUGGESTION
// offered to Sales, whatever Sales saves is COPIED onto the enquiry with its
// provenance, and costing reads the enquiry's own snapshot.
//
// ── SAVING IS THE ACT, AS CONFIRMING IS FOR PAYMENT ─────────────────────────
// Delivery terms have no separate draft/confirm step: the arrangement is a
// fact about the deal rather than a negotiation with a rate attached, and the
// costing already refuses to price an incomplete lane by naming the gap
// (`freightSource` owns that). So SAVING is the deliberate act here, and an
// enquiry nobody has saved is unanswered — never "the customer's usual term,
// silently applied".
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// No freight amount, no transporter rate, no quotation. Sales records who
// bears the cost and the lane; Store & Purchase records what a transporter
// quoted; Central Costing multiplies. That division is unchanged.
"use strict";

const {
  FREIGHT_ARRANGEMENT_CODES, TRANSPORT_MODE_CODES, PREPAID_TREATMENT_CODES,
} = require("../../constants/crm");

const str = (v) => String(v ?? "").trim();
const id = (v) => (v == null ? "" : String(v));

/* The arrangements under which the COMPANY organises the shipment, and
   therefore the only ones with a lane to answer for. Mirrors
   `freight.service.js::TREATMENT` — ex-works and to-pay are recorded zeros
   with no lane of ours. */
const BEARS_FREIGHT = Object.freeze(["delivered", "prepaid"]);
const bearsFreight = (arrangement) => BEARS_FREIGHT.includes(str(arrangement));

/** A whole number of consignments, or null. Blank is unknown, never 1. */
function usableCount(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}

/**
 * The Account's standing delivery terms, reduced to what is usable.
 *
 * `defaultIncoterm` rides along because the costing records it beside the
 * lane; it is free text everywhere in this system and is never parsed.
 */
function accountDefaults(account) {
  const arrangement = str(account?.freightArrangement);
  const mode = str(account?.defaultTransportMode);
  const prepaidTreatment = str(account?.defaultPrepaidTreatment);
  return {
    arrangement: FREIGHT_ARRANGEMENT_CODES.includes(arrangement) ? arrangement : null,
    shippingAddressId: id(account?.defaultShippingAddressId) || null,
    mode: TRANSPORT_MODE_CODES.includes(mode) ? mode : null,
    prepaidTreatment: PREPAID_TREATMENT_CODES.includes(prepaidTreatment) ? prepaidTreatment : null,
    instructions: str(account?.deliveryInstructions),
    incoterm: str(account?.defaultIncoterm),
  };
}

/**
 * WHAT SALES IS OFFERED WHEN THEY OPEN AN UNANSWERED ENQUIRY.
 *
 * A suggestion, clearly labelled as one and written nowhere until somebody
 * applies and saves it. The same contract as the payment suggestion: a default
 * silently saved is a default nobody agreed to, and it would read afterwards
 * as an agreement.
 */
function suggestionFor(account) {
  const d = accountDefaults(account);
  const available = Boolean(d.arrangement || d.shippingAddressId || d.mode || d.instructions);
  return {
    available,
    arrangement: d.arrangement,
    shippingAddressId: d.shippingAddressId,
    mode: d.mode,
    /* Only ever meaningful beside a prepaid arrangement. */
    prepaidTreatment: d.arrangement === "prepaid" ? d.prepaidTreatment : null,
    instructions: d.instructions,
    label: available ? "The customer's usual delivery terms" : null,
  };
}

/**
 * WHAT IS STILL MISSING FROM THIS ENQUIRY'S DELIVERY TERMS.
 *
 * The dispatch warehouse and the delivery count are deliberately NOT here:
 * they are per-deal facts the costing asks for when it needs them
 * (`freightSource` names the gap and its owner), and an enquiry may legitimately
 * record the agreement before the warehouse is settled.
 *
 * Pure and exported, so every branch is exercised without a database.
 */
function gaps(terms = {}) {
  const out = [];
  const arrangement = str(terms.arrangement);
  if (!arrangement) {
    out.push({
      field: "arrangement",
      message: "Say who bears the delivery cost. The customer collecting and the company delivering "
        + "are different garment costs.",
    });
    return out;
  }
  if (arrangement === "prepaid" && !str(terms.prepaidTreatment)) {
    out.push({
      field: "prepaidTreatment",
      message: "This order is prepaid: the company pays the carrier. Say whether that freight is inside "
        + "the quoted price or recovered from the customer separately.",
    });
  }
  if (bearsFreight(arrangement)) {
    if (!id(terms.shippingAddressId)) {
      out.push({ field: "shippingAddressId", message: "Choose where this order is delivered." });
    }
    if (!str(terms.mode)) {
      out.push({
        field: "mode",
        message: "Say how this order travels. Road and air on one lane are different rates from "
          + "different transporters.",
      });
    }
  }
  return out;
}

/** Has anybody answered these terms, and do they still say everything they must? */
const STATE = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  INCOMPLETE: "INCOMPLETE",
  SAVED: "SAVED",
});

function stateOf(terms = {}) {
  const started = Boolean(str(terms.arrangement) || id(terms.shippingAddressId)
    || str(terms.mode) || str(terms.notes) || terms.savedAt);
  if (!started) return STATE.NOT_STARTED;
  return gaps(terms).length ? STATE.INCOMPLETE : STATE.SAVED;
}

/**
 * VALIDATE AND NORMALISE A SUBMITTED SET OF DELIVERY TERMS.
 *
 * Refuses rather than repairs, exactly as the payment resolver does — with one
 * deliberate exception that is not a repair but the answer itself: when the
 * arrangement carries no lane of ours (`to_pay`, `ex_works`), the lane fields
 * are CLEARED rather than kept. A destination and a mode left behind from a
 * previous arrangement are stale facts that a later reader would take for
 * current ones, and "the customer collects, from our Ludhiana warehouse, by
 * air" is not a statement anybody made.
 *
 * Identity checks (does this address belong to this account, is this warehouse
 * this company's) are the ROUTE's, because they need the database. This
 * function is pure.
 *
 * @param {object} input                 the submitted terms
 * @param {object} [opt]
 * @param {object} [opt.account]         the customer's standing terms, for provenance
 * @param {object} [opt.actor]           who is saving
 * @param {object} [opt.existing]        what the enquiry holds today
 * @returns {{ok: true, terms: object} | {ok: false, field: string, message: string}}
 */
function validate(input = {}, { account = null, actor = null, existing = null } = {}) {
  const arrangement = str(input.arrangement);
  if (arrangement && !FREIGHT_ARRANGEMENT_CODES.includes(arrangement)) {
    return { ok: false, field: "arrangement", message: "That is not a delivery arrangement this system recognises." };
  }

  const mode = str(input.mode).toUpperCase();
  if (mode && !TRANSPORT_MODE_CODES.includes(mode)) {
    return { ok: false, field: "mode", message: "That is not a freight mode this system recognises." };
  }

  const prepaidTreatment = str(input.prepaidTreatment);
  if (prepaidTreatment && !PREPAID_TREATMENT_CODES.includes(prepaidTreatment)) {
    return {
      ok: false, field: "prepaidTreatment",
      message: "Say whether prepaid freight sits inside the price or is recovered separately.",
    };
  }

  const countRaw = input.deliveryCount;
  if (countRaw !== undefined && countRaw !== null && countRaw !== "" && usableCount(countRaw) === null) {
    return {
      ok: false, field: "deliveryCount",
      message: "A delivery count is a whole number of deliveries, at least one.",
    };
  }

  const lane = bearsFreight(arrangement);
  const terms = {
    arrangement: arrangement || undefined,
    /* ── CLEARED, NOT CARRIED ─────────────────────────────────────────
       An arrangement with no lane of ours keeps no lane fields. */
    mode: lane ? (mode || undefined) : undefined,
    shippingAddressId: lane ? (id(input.shippingAddressId) || undefined) : undefined,
    originWarehouseId: lane ? (id(input.originWarehouseId) || undefined) : undefined,
    deliveryCount: lane ? (usableCount(countRaw) ?? undefined) : undefined,
    /* Only a prepaid arrangement has this question to answer. */
    prepaidTreatment: arrangement === "prepaid" ? (prepaidTreatment || undefined) : undefined,
    notes: str(input.notes).slice(0, 1000),
  };

  /* ── WHERE THESE TERMS CAME FROM ──────────────────────────────────────
     `ACCOUNT` only when every value Sales saved matches the customer's
     standing terms. Re-typing the customer's own answer is agreement, not
     deviation — the same reasoning the payment resolver applies, and the
     reason a flag on every second enquiry would mean nothing. */
  const d = accountDefaults(account);
  const matchesAccount = Boolean(d.arrangement) && d.arrangement === (terms.arrangement || null)
    && (d.mode || null) === (terms.mode || null)
    && (d.shippingAddressId || null) === (terms.shippingAddressId || null)
    && (d.arrangement === "prepaid" ? (d.prepaidTreatment || null) === (terms.prepaidTreatment || null) : true);
  terms.source = matchesAccount ? "ACCOUNT" : "ENQUIRY";

  /* Snapshotted so an override stays auditable as a DIFFERENCE after the
     Account moves again — and so costing never has to ask the Account. */
  terms.accountDefaultAtSave = {
    ...(d.arrangement ? { arrangement: d.arrangement } : {}),
    ...(d.mode ? { mode: d.mode } : {}),
    ...(d.shippingAddressId ? { shippingAddressId: d.shippingAddressId } : {}),
    ...(d.prepaidTreatment ? { prepaidTreatment: d.prepaidTreatment } : {}),
  };
  /* The incoterm the customer's paper says, copied at save. The costing used
     to read this live off the Account for the same reason it read the
     arrangement live, and with the same consequence. */
  terms.incoterm = d.incoterm || undefined;
  terms.savedAt = new Date();
  terms.savedBy = actor || undefined;
  void existing;

  return { ok: true, terms };
}

/**
 * THE PROJECTION A READER GETS — and it is only ever the enquiry's own.
 *
 * No account fallback. An enquiry nobody has answered is unanswered, and the
 * costing names that gap and its owner rather than borrowing the customer's
 * usual term and presenting it as this order's.
 */
function projectionFor(enquiry) {
  const f = enquiry?.freight || {};
  const state = stateOf(f);
  const arrangement = str(f.arrangement) || null;
  return {
    state,
    arrangement,
    source: str(f.source) || null,
    /* An override is a DIFFERENCE from what the account said at the time. */
    overridden: str(f.source) === "ENQUIRY" && Boolean(f.accountDefaultAtSave?.arrangement),
    mode: str(f.mode) || null,
    shippingAddressId: id(f.shippingAddressId) || null,
    originWarehouseId: id(f.originWarehouseId) || null,
    deliveryCount: Number.isFinite(f.deliveryCount) ? f.deliveryCount : null,
    prepaidTreatment: str(f.prepaidTreatment) || null,
    incoterm: str(f.incoterm) || null,
    notes: str(f.notes),
    accountDefaultAtSave: f.accountDefaultAtSave || null,
    savedAt: f.savedAt || null,
    savedByName: str(f.savedBy?.name) || null,
    gaps: gaps(f),
  };
}

module.exports = {
  STATE,
  BEARS_FREIGHT,
  bearsFreight,
  usableCount,
  accountDefaults,
  suggestionFor,
  gaps,
  stateOf,
  validate,
  projectionFor,
};
