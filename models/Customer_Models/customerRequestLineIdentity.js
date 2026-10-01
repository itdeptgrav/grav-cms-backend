// models/Customer_Models/customerRequestLineIdentity.js
//
// EVERY ORDER LINE GETS A PERMANENT NAME OF ITS OWN.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// A CustomerRequest order line had no identity at all: `requestItemSchema` is
// declared `{ _id: false }`, and its array position is rewritten whenever a
// quotation drops an emptied line or a customer edits the order. So anything
// that needed to point AT a line pointed at the only stable thing on it — the
// selected style — and the Sales→Merchandising handover did exactly that.
//
// That made a style identity stand in for an order-line identity, and the two
// are not the same fact. The same style legitimately appears on two commercial
// lines of one order: two delivery destinations, two buyer references, two
// packing requirements, a contractual split. The handover code met that case,
// could not tell the lines apart, and refused the whole order as AMBIGUOUS —
// declaring a normal enterprise order malformed because the reference it had
// chosen was not up to the job.
//
// ── WHAT A LINE REFERENCE IS ────────────────────────────────────────────────
// An opaque, server-minted token, unique within its request, that means "this
// line" and nothing else. Not a sequence number: `LINE-3` would have to be
// rewritten the moment line 2 is removed, which is the problem restated. Not
// derived from the style, the product, the quantity or the position, because
// every one of those legitimately changes while the line stays the same line.
//
// It is minted ONCE and never reissued. An edited line keeps it — that is the
// entire point. A line that is removed takes its reference with it, and a new
// line, however similar, gets a new one: "the same style at the same quantity"
// is not evidence of being the same commercial commitment.
//
// ── WHY A HOOK, AND NOT A RULE EVERY WRITER FOLLOWS ─────────────────────────
// There are sixteen places in this repository that write these lines —
// customer self-service, Sales on behalf, measurement conversion, sampling,
// return cloning, six separate quotation paths, a seed script. Every one of
// them persists through `.save()`, which makes a pre-validate hook a complete
// chokepoint: one implementation, no writer to remember, and no way for a new
// seventeenth writer to forget.
//
// ── AND WHY A CLIENT CANNOT AUTHOR ONE ──────────────────────────────────────
// `carryLineIdentities` lets an incoming payload NAME a line reference the
// request already has — that is a client saying which line it is editing, and
// it is exactly what we want. It will not let a payload INVENT one: a value
// that is not already on the record is dropped and the server mints instead.
// The distinction is the whole guarantee, and the hook enforces uniqueness
// underneath it in case a writer bypasses the helper.
"use strict";

const crypto = require("crypto");

/** `LN-` and twelve hex characters. Enough entropy that a collision inside one
 *  order is not a scenario worth designing around, short enough to read in a
 *  log line, and visibly not a position. */
const LINE_REF_PATTERN = /^LN-[0-9a-f]{12}$/;

const str = (v) => String(v ?? "").trim();

/** A new, unused line reference. */
function mintLineRef() {
  return `LN-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Give every line of `doc` a reference, without ever changing one it has.
 *
 * Called from the CustomerRequest pre-validate hook, so it runs on creation,
 * on a push, and on the filter-and-reassign the quotation paths perform — a
 * re-cast subdocument keeps its field values, so a surviving line keeps its
 * identity and only genuinely new lines are minted for.
 *
 * A duplicate reference is refused rather than repaired: two lines answering
 * to one name is precisely the ambiguity this exists to remove, and quietly
 * re-minting one of them would hide whichever writer caused it.
 */
function ensureLineIdentities(items) {
  const list = Array.isArray(items) ? items : [];
  const seen = new Set();

  for (const item of list) {
    const held = str(item?.lineRef);
    if (held) {
      if (!LINE_REF_PATTERN.test(held)) {
        const err = new Error(`"${held}" is not a line reference this system issued.`);
        err.name = "CustomerRequestLineIdentityError";
        throw err;
      }
      if (seen.has(held)) {
        const err = new Error(`Two order lines carry the line reference ${held}.`);
        err.name = "CustomerRequestLineIdentityError";
        throw err;
      }
      seen.add(held);
    }
  }

  for (const item of list) {
    if (str(item?.lineRef)) continue;
    let minted = mintLineRef();
    while (seen.has(minted)) minted = mintLineRef();
    seen.add(minted);
    /* Assigning through the subdocument so mongoose marks it modified — a
       plain property set on a cast subdocument would not always persist. */
    if (typeof item?.set === "function") item.set("lineRef", minted);
    else item.lineRef = minted;
  }

  return list;
}

/**
 * Carry line identity across a rebuild.
 *
 * The customer edit path rebuilds every line from the request body and the
 * stock-item record — deliberately, so a client cannot restate a price or a
 * name. Rebuilding lost the line's identity along with everything else, so
 * editing the quantity on one line silently retired all of them and opened
 * replacements. This joins the rebuilt lines back to the ones they came from.
 *
 * Two ways a rebuilt line is recognised, strongest first:
 *
 *   1. It names a `lineRef` the request already holds. A client that read the
 *      order knows the reference and can say which line it means. It cannot
 *      name one the request does NOT hold — that value is discarded, so a
 *      guessed or copied reference buys nothing.
 *   2. Failing that, the first unclaimed existing line with the same stock
 *      item, in order. This is what keeps identity stable for a client that
 *      has never heard of line references, which today is all of them.
 *
 * Anything still unmatched is a genuinely new line and is left for the hook
 * to mint.
 *
 * @param existing  the lines currently on the record
 * @param incoming  the rebuilt lines, mutated in place
 */
function carryLineIdentities(existing, incoming) {
  const pool = (Array.isArray(existing) ? existing : [])
    .map((e) => ({ lineRef: str(e?.lineRef), stockItemId: str(e?.stockItemId), claimed: false }))
    .filter((e) => e.lineRef);
  const byRef = new Map(pool.map((e) => [e.lineRef, e]));
  const list = Array.isArray(incoming) ? incoming : [];

  /* Pass 1 — the payload names a line this request actually has. */
  for (const item of list) {
    const named = str(item?.lineRef);
    const held = named ? byRef.get(named) : null;
    if (held && !held.claimed) {
      held.claimed = true;
    } else if (named) {
      /* Named something this order does not hold. Not an error — an older
         client, a copied body, a stale tab — but not an identity either. */
      delete item.lineRef;
    }
  }

  /* Pass 2 — same stock item, in order, for a payload that named nothing. */
  for (const item of list) {
    if (str(item?.lineRef)) continue;
    const stockItemId = str(item?.stockItemId);
    const match = pool.find((e) => !e.claimed && e.stockItemId && e.stockItemId === stockItemId);
    if (match) {
      match.claimed = true;
      item.lineRef = match.lineRef;
    }
  }

  return list;
}

/** Strip any client-authored reference from lines about to be adopted. */
function stripLineIdentities(items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item === "object") delete item.lineRef;
  }
  return items;
}

module.exports = {
  LINE_REF_PATTERN, mintLineRef, ensureLineIdentities, carryLineIdentities, stripLineIdentities,
};
