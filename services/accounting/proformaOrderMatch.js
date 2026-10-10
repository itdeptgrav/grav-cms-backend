// services/accounting/proformaOrderMatch.js
//
// WHICH MANUFACTURING ORDER DOES THIS PROFORMA BELONG TO?
//
// The flow is: Sales raises a PI, the PI is approved, and the approval is
// what creates the MO. A proforma with no MO behind it is therefore one that
// was never approved — which is why the accounting list wants to show only
// the ones that have one.
//
// ── THERE IS NO STORED RELATIONSHIP, AND THAT IS THE PROBLEM ───────────────
// The accounting proforma (Acc_ProformaInvoice) and the sales PI
// (CustomerRequest.quotations[]) are different documents in different parts
// of the system, and NOTHING links them: the accounting document is only
// ever created inside accounting, and carries a buyer address, a party
// ledger and free text. So the match has to be derived, and the only honest
// way to derive it is from evidence that cannot mean anything else.
//
// ── WHAT COUNTS AS PROOF, STRONGEST FIRST ─────────────────────────────────
//   reference   the order's own number is written on the proforma — in
//               buyersReference, otherReferences or the narration. An
//               MO-REQ-… string is not something that lands there by
//               accident, so it is taken as said.
//   sole-order  the proforma's customer has exactly ONE order. There is
//               nothing else it could be.
//   (nothing)   anything else. A customer with several orders is NOT
//               guessed at: picking the wrong one puts another order's
//               dispatches on this proforma and bills them.
//
// `ambiguous` is a real answer and is reported as one. The screen says the
// proforma could not be matched and names why, rather than attaching a
// plausible order and letting somebody invoice against it.
//
// Pure: every function takes plain documents and returns plain data, so the
// whole rule is tested without a database.

"use strict";

/** Order numbers look like MO-REQ-2026-0041, MO-REQ-DEMO-DISPATCH, REQ-1042. */
const ORDER_REF = /\b((?:MO-)?REQ-[A-Z0-9][A-Z0-9-]*)\b/gi;

/**
 * Every order-looking reference written anywhere on the proforma.
 *
 * Deliberately reads several free-text fields: whoever typed the order number
 * put it where their habit says, and the cost of looking in three fields is
 * nothing next to leaving a proforma unmatched because it was in the wrong
 * one.
 */
function referencesOn(pi) {
  const text = [
    pi?.requestRef,
    pi?.buyersReference,
    pi?.otherReferences,
    pi?.narration,
  ]
    .filter(Boolean)
    .join(" ");
  const out = [];
  for (const m of String(text).matchAll(ORDER_REF)) {
    const ref = m[1].toUpperCase();
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

const normName = (v) =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Resolve the order for one proforma.
 *
 * @param {object} pi         the Acc_ProformaInvoice (plain)
 * @param {Array}  orders     candidate CustomerRequests for this buyer, each
 *                            { _id, requestId, customerName, customerId }
 * @returns {{ orderId: string|null, requestRef: string, how: string,
 *             candidates: number, reason: string }}
 *   how: "stored" | "reference" | "sole-order" | "ambiguous" | "none"
 */
function resolveOrderForProforma(pi, orders) {
  const list = (Array.isArray(orders) ? orders : []).filter(Boolean);

  /* Already decided — a stored link is somebody's answer and is never
     second-guessed by a derivation. */
  if (pi?.customerRequestId) {
    return {
      orderId: String(pi.customerRequestId?._id ?? pi.customerRequestId),
      requestRef: pi.requestRef || "",
      how: "stored",
      candidates: list.length,
      reason: "Already linked.",
    };
  }

  // 1. The order's number is written on the proforma.
  const refs = referencesOn(pi);
  if (refs.length) {
    const hit = list.filter((o) =>
      refs.includes(String(o.requestId || "").toUpperCase()));
    if (hit.length === 1) {
      return {
        orderId: String(hit[0]._id),
        requestRef: hit[0].requestId || "",
        how: "reference",
        candidates: list.length,
        reason: `The order number ${hit[0].requestId} is written on this proforma.`,
      };
    }
    if (hit.length > 1) {
      return {
        orderId: null, requestRef: "", how: "ambiguous", candidates: hit.length,
        reason: `${hit.length} orders match the references on this proforma.`,
      };
    }
  }

  // 2. The buyer has exactly one order. Nothing else it could be.
  if (list.length === 1) {
    return {
      orderId: String(list[0]._id),
      requestRef: list[0].requestId || "",
      how: "sole-order",
      candidates: 1,
      reason: `${list[0].customerName || "This buyer"} has one order, ${list[0].requestId}.`,
    };
  }

  if (list.length > 1) {
    return {
      orderId: null, requestRef: "", how: "ambiguous", candidates: list.length,
      reason:
        `This buyer has ${list.length} orders and the proforma does not name one. ` +
        "Write the order number on it to match it.",
    };
  }

  return {
    orderId: null, requestRef: "", how: "none", candidates: 0,
    reason: "No manufacturing order exists for this buyer — the proforma is not approved yet.",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   WHICH CUSTOMER IS THIS PROFORMA'S BUYER?

   Returns a Mongo filter, or NULL when the buyer carries nothing to look one
   up by. Null means "do not run a query", and both callers must honour it.

   WHY THIS IS A FUNCTION AND NOT THREE LINES INLINE. The routes each built
   `{ $or: [ ...(gstin ? [..] : []), ...(name ? [..] : []) ] }`. When the
   buyer had neither — which happened because a route's projection left
   `buyer` out entirely — that is `{ $or: [] }`, and Mongoose STRIPS an empty
   `$or`: the query becomes `{}` and returns whichever customer is first in
   the collection. Its sole order then resolved as a PROVEN match and was
   written to the proforma, binding it permanently to a stranger's order with
   that stranger's dispatches offered to invoice. Nothing on screen looked
   wrong.

   A buyer we cannot identify has no candidate orders. That is the honest
   answer, and `resolveOrderForProforma([])` already words it.
   ───────────────────────────────────────────────────────────────────────── */
function customerLookupFor(buyer) {
  const gstin = String(buyer?.gstin || "").trim().toUpperCase();
  const name = String(buyer?.name || "").trim();
  const clauses = [];
  if (gstin) clauses.push({ gstin });
  if (name) clauses.push({ name });
  return clauses.length ? { $or: clauses } : null;
}

/* The same question for a PAGE of proformas: one query for every buyer on
   it. Null for the same reason, and on the same rule. */
function customerLookupForMany(buyers) {
  const gstins = [...new Set((buyers || [])
    .map((b) => String(b?.gstin || "").trim().toUpperCase()).filter(Boolean))];
  const names = [...new Set((buyers || [])
    .map((b) => String(b?.name || "").trim()).filter(Boolean))];
  const clauses = [];
  if (gstins.length) clauses.push({ gstin: { $in: gstins } });
  if (names.length) clauses.push({ name: { $in: names } });
  return clauses.length ? { $or: clauses } : null;
}

/** May this resolution be WRITTEN to the proforma without anybody asking? */
const isProvenMatch = (r) => ["reference", "sole-order"].includes(r?.how);

module.exports = {
  ORDER_REF,
  referencesOn,
  normName,
  resolveOrderForProforma,
  isProvenMatch,
  customerLookupFor,
  customerLookupForMany,
};
