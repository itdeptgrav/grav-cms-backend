// services/storePurchase/labelIdentity.js
//
// WHEN A PRINTED LABEL BECOMES A STOCK IDENTITY.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
// A Barcode document has always been minted by `POST /api/cms/inventory/
// barcodes` with no receipt behind it, and every reader downstream treated its
// existence as proof that the material exists: `resolveStock` resolved it, the
// put-away queue listed its quantity as work owed, the locator found it, and a
// cutting session would open on it. That was survivable while labels were only
// ever printed for stock that had already been received.
//
// Receiving by counting changes that. A label is now printed DURING the count,
// before any goods receipt exists — that is the whole point, because the
// sticker goes on the roll as it comes off the vehicle. So between printing and
// finalising there are real, durable, scannable identities in the collection
// for material GRAV has not received. If the readers still treat those as
// stock, the feature has invented inventory.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// Exactly one state is stock: ACTIVATED. Everything else — reserved, printed,
// applied, voided — is an identity that exists on paper and nowhere else.
//
// ── AND WHY ABSENT MEANS ACTIVATED ──────────────────────────────────────────
// Every label printed before this field existed has no `identityState` at all,
// and every one of them IS real stock. A filter that asked for
// `identityState: "ACTIVATED"` would make the entire existing label estate
// vanish from the locator, the put-away queue and every scan — so the filters
// here accept a missing field, and `scripts/migrations/label-identity-state.js`
// backfills it. Mongoose's schema default does not help: it applies to new
// documents and to hydrated ones, but NOT to `.lean()` reads, which is what
// almost every one of these call sites uses.

"use strict";

/**
 * RESERVED   the server allocated it during a count. Printable. Not stock.
 * PRINTED    a print job carried it. Still not stock — a browser cannot say
 *            whether paper came out, so this claims only that it was sent.
 * APPLIED    the receiver says the sticker is on the goods and counted it.
 * ACTIVATED  a goods receipt recorded the material. NOW it is stock.
 * VOIDED     terminal. Never usable, never reused, never deleted.
 */
const IDENTITY_STATE = Object.freeze({
  RESERVED: "RESERVED",
  PRINTED: "PRINTED",
  APPLIED: "APPLIED",
  ACTIVATED: "ACTIVATED",
  VOIDED: "VOIDED",
});

const IDENTITY_STATES = Object.freeze(Object.values(IDENTITY_STATE));

/** The states a receiving session may still move a label out of. */
const OPEN_IDENTITY_STATES = Object.freeze([
  IDENTITY_STATE.RESERVED,
  IDENTITY_STATE.PRINTED,
  IDENTITY_STATE.APPLIED,
]);

/** Counted toward what a session has received. */
const COUNTED_IDENTITY_STATES = Object.freeze([
  IDENTITY_STATE.APPLIED,
  IDENTITY_STATE.ACTIVATED,
]);

/** Printed or reserved and still owing somebody a decision. */
const UNRESOLVED_IDENTITY_STATES = Object.freeze([
  IDENTITY_STATE.RESERVED,
  IDENTITY_STATE.PRINTED,
]);

/**
 * The clause that means "this label is real stock".
 *
 * Returned as a bare `$or`, so a caller must fold it into `$and` alongside a
 * tenant filter — `tenantFilter` is itself frequently an `$or`, and assigning
 * two `$or` keys onto one object silently drops the first.
 *
 *   const filter = { $and: [tenantContext.tenantFilter(req.tenant), usableIdentity(), extra] };
 */
function usableIdentity() {
  return {
    $or: [
      { identityState: { $exists: false } },
      { identityState: null },
      { identityState: IDENTITY_STATE.ACTIVATED },
    ],
  };
}

/** True when a label document may be treated as stock. Mirrors `usableIdentity`. */
function isUsableIdentity(barcode) {
  const state = barcode && barcode.identityState;
  return state === undefined || state === null || state === IDENTITY_STATE.ACTIVATED;
}

/**
 * Why this label is not stock, in words a receiver or a storekeeper reads at a
 * scanner. Never "invalid barcode": the label is perfectly valid, it simply
 * does not name anything GRAV has received yet, and saying which is the whole
 * difference between "throw this away" and "finish the receipt".
 */
function identityRefusal(barcode) {
  const state = barcode && barcode.identityState;
  if (isUsableIdentity(barcode)) return null;
  if (state === IDENTITY_STATE.VOIDED) {
    const why = (barcode && barcode.voidReason) || "";
    return {
      reason: "LABEL_VOIDED",
      message: `This label was voided${why ? ` — ${why}` : ""}. It names nothing and must not be used. Take it off the goods.`,
    };
  }
  if (state === IDENTITY_STATE.APPLIED) {
    return {
      reason: "LABEL_NOT_RECEIVED",
      message: "This label has been counted but its goods receipt has not been recorded yet, so the material is not in stock. Finish the receipt first.",
    };
  }
  return {
    reason: "LABEL_NOT_RECEIVED",
    message: "This label was printed during a count that has not been finished, so the material is not in stock yet. Finish the goods receipt, then scan it again.",
  };
}

module.exports = {
  IDENTITY_STATE,
  IDENTITY_STATES,
  OPEN_IDENTITY_STATES,
  COUNTED_IDENTITY_STATES,
  UNRESOLVED_IDENTITY_STATES,
  usableIdentity,
  isUsableIdentity,
  identityRefusal,
};
