// services/orderOrigin.js
//
// WHAT KIND OF ORDER IS THIS — one answer, read by every surface.
//
// Explicit request, 31 Aug 2026: the Manufacturing Order screens and the
// Project Manager's notification must both say "which type of order it is
// whether it is for sampling order, genuine customer order or like testing
// order".
//
// ── WHY A SHARED RESOLVER AND NOT A FIELD READ ───────────────────────────
// `CustomerRequest.orderOrigin` is the stored truth, but it only exists on
// rows written after 31 Aug 2026. Every order raised before that has no value
// at all — and reading the bare field would badge all of them "Customer
// order", including the internal and R&D-sampling runs that plainly were not.
//
// So this backfills a best-effort answer from the signals those older rows DO
// carry (`isInternalOrder`, `requestType`, a `sampleStyleId` link), and says so
// via `inferred: true`. Four screens each writing their own version of that
// fallback is how two of them end up disagreeing about the same order.
"use strict";

/** The canonical set, in the order a human would rank them. */
const ORDER_ORIGINS = ["customer", "sampling", "internal", "testing"];

const META = {
  customer: {
    key: "customer",
    label: "Customer order",
    short: "Customer",
    // What a reader needs to know about how to treat it.
    description: "A genuine order placed by a paying customer.",
    tone: "positive",
  },
  sampling: {
    key: "sampling",
    label: "Sampling order",
    short: "Sampling",
    description: "A sample run — made to prove or develop a garment, not to fulfil a customer's order.",
    tone: "risk",
  },
  internal: {
    key: "internal",
    label: "Internal order",
    short: "Internal",
    description: "A company-funded order — GRAV is its own customer here.",
    tone: "neutral",
  },
  testing: {
    key: "testing",
    label: "Testing order",
    short: "Testing",
    description: "A trial run, raised to test a process or a machine. Not for delivery.",
    tone: "blocked",
  },
};

/**
 * Resolve an order's kind.
 *
 * @param {object} request a CustomerRequest (document or lean object)
 * @returns {{key, label, short, description, tone, inferred:boolean}}
 */
function resolveOrderOrigin(request) {
  const stored = String(request?.orderOrigin || "").trim();
  if (ORDER_ORIGINS.includes(stored)) return { ...META[stored], inferred: false };

  // ── Backfill for rows written before the field existed ────────────────
  // Most specific signal first: a link to a sample style is unambiguous.
  if (request?.sampleStyleId) return { ...META.sampling, inferred: true };
  // `isInternalOrder` is genuinely ambiguous on old rows — it was set both by
  // the R&D sampling path and by a salesperson marking a real customer's order
  // as company-funded. "Internal" is the honest reading of it on its own.
  if (request?.isInternalOrder) return { ...META.internal, inferred: true };
  return { ...META.customer, inferred: true };
}

/** Just the label, for places that only need a word. */
const orderOriginLabel = (request) => resolveOrderOrigin(request).label;

module.exports = { ORDER_ORIGINS, ORDER_ORIGIN_META: META, resolveOrderOrigin, orderOriginLabel };
