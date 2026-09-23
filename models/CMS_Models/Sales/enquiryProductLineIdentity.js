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
// `reconcileProductLineIdentities` lets an incoming payload NAME a reference
// the enquiry already has — a client saying which line it is editing, which is
// what we want. It will not let a payload INVENT one, and it never guesses:
// a reference this enquiry does not hold is refused, never swapped for a
// "close enough" row. Identity is decided by the reference alone — never by
// product name and never by array position.
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
 * Reconcile a rebuilt product list against the lines this enquiry already has.
 *
 * The Sales edit path rebuilds every product row from the request body. This
 * decides, for each incoming row, which existing line it IS — using only the
 * `productLineRef` the client sends back — and refuses anything it cannot
 * decide for certain.
 *
 * ── WHY NOT BY NAME ────────────────────────────────────────────────────────
 * An earlier version fell back to "the first unclaimed row with the same
 * product name". One enquiry legitimately carries "Polo" twice (two colourways,
 * two departments, two development jobs), so a name match hands one line's
 * Development File to the other. Position is no better: rows are reordered.
 *
 * ── REMOVAL IS DECLARED, NEVER INFERRED ─────────────────────────────────────
 * A line the enquiry holds that is absent from the payload is removed ONLY if
 * the payload names it in `removed`. Inferring removal from absence is exactly
 * how a stale client — an old build that never sent references, or a second
 * tab that loaded before somebody added a line — would silently delete lines
 * it had never seen, and re-mint every other line as "new". Those saves are
 * refused with a conflict the client can act on: reload, then save again.
 *
 * ── LINES THAT NEVER HAD A REFERENCE ───────────────────────────────────────
 * A row stored before references existed has none to preserve. It is not
 * "held", so it cannot be missing; the first save simply issues references.
 *
 * @param {object[]} existing   the enquiry's current rows
 * @param {object[]} incoming   sanitised rows; each may carry `productLineRef`
 * @param {{removed?: string[]}} [opts]
 * @returns {{ok: true, rows: object[], removed: string[]}
 *          | {ok: false, code: string, message: string, details: object}}
 *          Rows keep a held `productLineRef`; a genuinely new row has none, so
 *          the Enquiry's validate hook mints it.
 */
function reconcileProductLineIdentities(existing, incoming, { removed = [] } = {}) {
  const refuse = (code, message, details = {}) => ({ ok: false, code, message, details });

  const held = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    const ref = str(e?.productLineRef);
    if (ref) held.set(ref, str(e?.product));
  }
  const rows = Array.isArray(incoming) ? incoming : [];

  /* Every reference the payload names must be one this enquiry holds, once. */
  const named = new Set();
  for (const row of rows) {
    const ref = str(row?.productLineRef);
    if (!ref) { if (row) delete row.productLineRef; continue; }
    if (!PRODUCT_LINE_REF_PATTERN.test(ref)) {
      return refuse("PRODUCT_LINE_REF_MALFORMED", `"${ref}" is not a product line reference this system issued.`, { productLineRef: ref });
    }
    if (!held.has(ref)) {
      /* Forged, from another enquiry, or a line already removed — the same
         answer for all three, so the response confirms nothing about any
         other record. */
      return refuse("PRODUCT_LINE_REF_UNKNOWN",
        "A product in this save is not a line on this enquiry. Reload the enquiry and save again.",
        { productLineRef: ref });
    }
    if (named.has(ref)) {
      return refuse("PRODUCT_LINE_REF_DUPLICATE",
        "Two products in this save claim the same line. Each existing line can appear only once.",
        { productLineRef: ref });
    }
    named.add(ref);
    row.productLineRef = ref;
  }

  /* Declared removals must be real, held, and not also being kept. */
  const declared = new Set();
  for (const raw of Array.isArray(removed) ? removed : []) {
    const ref = str(raw);
    if (!ref) continue;
    if (!held.has(ref)) {
      return refuse("PRODUCT_LINE_REF_UNKNOWN",
        "A product marked for removal is not a line on this enquiry. Reload the enquiry and save again.",
        { productLineRef: ref });
    }
    if (named.has(ref)) {
      return refuse("PRODUCT_LINE_REMOVAL_CONFLICT",
        "A product cannot be both kept and removed in one save.", { productLineRef: ref });
    }
    declared.add(ref);
  }

  /* Anything held, not in the payload and not declared removed: this client
     does not know about it. Refuse rather than delete it — and rather than
     re-mint the rows it did send, which would be the silent version of the
     same loss. */
  const unaccounted = [...held.keys()].filter((ref) => !named.has(ref) && !declared.has(ref));
  if (unaccounted.length) {
    const unreferenced = rows.filter((r) => !str(r?.productLineRef)).length;
    return refuse("PRODUCT_LINES_STALE",
      "This enquiry's products have changed since this screen loaded them"
        + (unreferenced ? ", or the save did not say which product each row is" : "")
        + ". Reload the enquiry and make the change again — nothing was saved.",
      {
        missingLines: unaccounted.map((ref) => ({ productLineRef: ref, product: held.get(ref) })),
        unreferencedRows: unreferenced,
      });
  }

  return { ok: true, rows, removed: [...declared] };
}

module.exports = {
  PRODUCT_LINE_REF_PATTERN, mintProductLineRef,
  ensureProductLineIdentities, reconcileProductLineIdentities,
};
