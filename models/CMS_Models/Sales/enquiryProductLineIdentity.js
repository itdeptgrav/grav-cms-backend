// models/CMS_Models/Sales/enquiryProductLineIdentity.js
//
// EVERY JOURNEY PRODUCT LINE GETS A PERMANENT NAME OF ITS OWN.
//
// The pre-order twin of `customerRequestLineIdentity.js`, and deliberately the
// same mechanism, because it closes the same defect one stage earlier.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// An `Enquiry.products` row has a mongoose `_id` and nothing else that is its
// own. That `_id` is stable only while the array is pushed to; several Sales
// edit paths rebuild `products` wholesale from a request body, and a rebuilt
// subdocument is a NEW subdocument with a new `_id`. So a reference held by
// another application would silently start pointing at a different line — or
// at nothing — the first time somebody reordered the enquiry or edited a row.
//
// Position cannot be the identity: rows are added, removed and reordered.
// Neither can the product name or the style text: one enquiry legitimately
// carries "Polo" twice, in two colourways for two departments, and those are
// two development jobs with two different material selections.
//
// ── WHAT A PRODUCT LINE REFERENCE IS ────────────────────────────────────────
// An opaque, server-minted token, unique within its enquiry, that means "this
// product line" and nothing else. Minted ONCE and never reissued. An edited
// line keeps it — that is the entire point, because a Development File is
// rooted on it and must survive the buyer changing the fabric preference.
//
// A removed line takes its reference with it, and a new line, however similar,
// gets a new one: "the same product at the same quantity" is not evidence of
// being the same development job.
//
// ── WHY A HOOK, AND NOT A RULE EVERY WRITER FOLLOWS ─────────────────────────
// Every writer of these rows persists through `.save()`, which makes a
// pre-validate hook a complete chokepoint: one implementation, no writer to
// remember, and no way for a new one to forget.
//
// ── AND WHY A CLIENT CANNOT AUTHOR ONE ──────────────────────────────────────
// `carryProductLineIdentities` lets an incoming payload NAME a reference the
// enquiry already has — a client saying which line it is editing, which is
// what we want. It will not let a payload INVENT one: a value not already on
// the record is dropped and the server mints instead.
"use strict";

const crypto = require("crypto");

/** `PL-` and twelve hex characters. Visibly not a position, short enough to
 *  read in a log line, and enough entropy that a collision inside one enquiry
 *  is not a scenario worth designing around. */
const PRODUCT_LINE_REF_PATTERN = /^PL-[0-9a-f]{12}$/;

const str = (v) => String(v ?? "").trim();

/** A new, unused product line reference. */
function mintProductLineRef() {
  return `PL-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Give every product line a reference, without ever changing one it has.
 *
 * A duplicate is refused rather than repaired: two lines answering to one name
 * is precisely the ambiguity this exists to remove, and quietly re-minting one
 * of them would hide whichever writer caused it.
 */
function ensureProductLineIdentities(products) {
  const list = Array.isArray(products) ? products : [];
  const seen = new Set();

  for (const row of list) {
    const held = str(row?.productLineRef);
    if (!held) continue;
    if (!PRODUCT_LINE_REF_PATTERN.test(held)) {
      const err = new Error(`"${held}" is not a product line reference this system issued.`);
      err.name = "EnquiryProductLineIdentityError";
      throw err;
    }
    if (seen.has(held)) {
      const err = new Error(`Two enquiry product lines carry the reference ${held}.`);
      err.name = "EnquiryProductLineIdentityError";
      throw err;
    }
    seen.add(held);
  }

  for (const row of list) {
    if (str(row?.productLineRef)) continue;
    let minted = mintProductLineRef();
    while (seen.has(minted)) minted = mintProductLineRef();
    seen.add(minted);
    /* Assigning through the subdocument so mongoose marks it modified — a
       plain property set on a cast subdocument would not always persist. */
    if (typeof row?.set === "function") row.set("productLineRef", minted);
    else row.productLineRef = minted;
  }

  return list;
}

/**
 * Carry identity across a rebuild.
 *
 * The Sales edit paths rebuild every product row from the request body.
 * Rebuilding lost the line's identity along with everything else, so editing
 * one row's fabric preference would retire every Development File on the
 * enquiry and open replacements. This joins rebuilt rows back to the ones they
 * came from.
 *
 * Two ways a rebuilt row is recognised, strongest first:
 *
 *   1. It names a `productLineRef` the enquiry already holds. It cannot name
 *      one the enquiry does NOT hold — that value is discarded.
 *   2. Failing that, the first unclaimed existing row with the same product
 *      name, in order. This keeps identity stable for a client that has never
 *      heard of product line references, which today is all of them.
 */
function carryProductLineIdentities(existing, incoming) {
  const pool = (Array.isArray(existing) ? existing : [])
    .map((e) => ({
      productLineRef: str(e?.productLineRef),
      product: str(e?.product).toLowerCase(),
      claimed: false,
    }))
    .filter((e) => e.productLineRef);
  const byRef = new Map(pool.map((e) => [e.productLineRef, e]));
  const list = Array.isArray(incoming) ? incoming : [];

  /* Pass 1 — the payload names a line this enquiry actually has. */
  for (const row of list) {
    const named = str(row?.productLineRef);
    const held = named ? byRef.get(named) : null;
    if (held && !held.claimed) held.claimed = true;
    else if (named) delete row.productLineRef;
  }

  /* Pass 2 — same product name, in order, for a payload that named nothing. */
  for (const row of list) {
    if (str(row?.productLineRef)) continue;
    const product = str(row?.product).toLowerCase();
    const match = pool.find((e) => !e.claimed && e.product && e.product === product);
    if (match) {
      match.claimed = true;
      row.productLineRef = match.productLineRef;
    }
  }

  return list;
}

module.exports = {
  PRODUCT_LINE_REF_PATTERN, mintProductLineRef,
  ensureProductLineIdentities, carryProductLineIdentities,
};
