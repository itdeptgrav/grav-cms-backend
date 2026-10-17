"use strict";
// services/ppc/targetScope.js
//
// WHAT A TARGET IS ASKED AGAINST — the whole order, or some of its work orders.
//
// Until now a target was always the WHOLE manufacturing order: "Cutting, 300 a
// day on MO-2026-0041". That is how a target is asked when an order is one
// style in one colour. It is not how a real order is planned:
//
//   · an order of 19 work orders goes onto the floor in batches — the two
//     colours that have fabric now, the rest when it lands;
//   · a style is split across two sewing lines, and each line is asked for its
//     own number;
//   · cutting is asked for the lay that is on the table, not the order.
//
// So a target may name a MIX OF WORK ORDERS. The whole order stays the default
// and every target written before this is read as exactly that, because an
// absent scope IS the order.
//
// ── WHAT MAKES THIS HONEST ──────────────────────────────────────────────────
// A scoped target can only be set where the department's own records say WHICH
// work order the piece belonged to. Cutting names the work order on every
// entry, the production scan carries it in the barcode, QC and the finishing
// scans store it, packaging records sit on the work order itself. Dispatch
// does not: a challan counts units for the order, so a dispatch target scoped
// to two work orders could never be measured — and a target nobody can measure
// is worse than no target. It is refused in those words.
//
// Pure: no database, no mongoose, no clock. The service resolves a scope once
// (against the order's work orders) and stores what it resolved.

/** The departments whose completion records name a work order. */
const ATTRIBUTABLE = Object.freeze(new Set([
  "cutting", "embroidery", "printing", "washing", "trimming", "ironing",
  "production", "qc", "packaging",
]));

const SCOPE_KINDS = Object.freeze(["order", "work_orders"]);

/** Can this department's book answer "how many of THESE work orders"? */
const canScope = (department) => ATTRIBUTABLE.has(String(department || ""));

const idsOf = (scope) => new Set((scope?.workOrderIds || []).map(String));

/** The whole order, as a scope. The shape every reader gets, scoped or not. */
function wholeOrder(ctx) {
  return { kind: "order", workOrderIds: [], label: "the whole order", quantity: Number(ctx?.quantity) || 0, count: (ctx?.workOrders || []).length };
}

/**
 * Resolve what the form asked for against the order's own work orders.
 *
 * @param body `{ workOrderIds?: string[] }` — absent or empty means the order
 * @param ctx  `{ quantity, workOrders: [{ id, number, product, quantity }] }`
 * @param department the department the target is for
 * @returns `{ ok, error, scope }` — `error` is a sentence for the planner
 */
function resolveScope(body, ctx, department, leftByWo = null) {
  const all = (ctx?.workOrders || []);

  /* ── QUANTITIES PER WORK ORDER (16 Oct 2026, owner: "I need settings or
     access to change quantity within a work order") ──────────────────────
     `allocations` is the precise form: how many MORE garments this target
     asks for on each named work order. The target's quantity is their sum,
     so picking work orders recalculates it and editing one line changes it.
     Each line is bounded by what that work order still has to go through
     this stage, when the caller knows it. */
  const rawAlloc = Array.isArray(body?.allocations) ? body.allocations : [];
  if (rawAlloc.length) {
    const known = new Map(all.map((w) => [String(w.id), w]));
    const seen = new Set();
    const allocations = [];
    for (const a of rawAlloc) {
      const id = String(a?.workOrderId || "").trim();
      const q = Number(a?.quantity);
      if (!id) continue;
      const w = known.get(id);
      if (!w) return { ok: false, error: "One of the work orders in this target does not belong to the order.", scope: null };
      if (seen.has(id)) return { ok: false, error: `${w.number || "A work order"} appears twice in the allocation.`, scope: null };
      seen.add(id);
      if (!Number.isFinite(q) || q < 1 || q !== Math.floor(q)) return { ok: false, error: `${w.number || "A work order"}: the quantity must be a whole number of at least 1.`, scope: null };
      const left = leftByWo ? leftByWo.get(id) : null;
      if (left != null && q > left) {
        return { ok: false, error: `${w.number}: ${q} requested, but only ${left} remain${left === 1 ? "s" : ""} at this stage.`, scope: null };
      }
      allocations.push({ workOrderId: id, quantity: q, number: w.number || "", product: w.product || "" });
    }
    if (!allocations.length) return { ok: true, error: "", scope: wholeOrder(ctx) };
    if (!canScope(department)) {
      return { ok: false, error: "Dispatch is recorded per challan for the whole order, not per work order, so it cannot be allocated by work order. Set the target on the whole order.", scope: null };
    }
    const quantity = allocations.reduce((n, a) => n + a.quantity, 0);
    const every = allocations.length === all.length;
    return {
      ok: true,
      error: "",
      scope: {
        kind: "work_orders",
        workOrderIds: allocations.map((a) => a.workOrderId),
        allocations: allocations.map(({ workOrderId, quantity: qq }) => ({ workOrderId, quantity: qq })),
        quantity,
        count: allocations.length,
        label: every ? `all ${all.length} work order${all.length === 1 ? "" : "s"}` : `${allocations.length} of ${all.length} work order${all.length === 1 ? "" : "s"}`,
        detail: allocations.slice(0, 3).map((a) => a.number || a.product).filter(Boolean).join(", ") + (allocations.length > 3 ? ` +${allocations.length - 3}` : ""),
      },
    };
  }

  const asked = [...new Set((Array.isArray(body?.workOrderIds) ? body.workOrderIds : []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!asked.length) return { ok: true, error: "", scope: wholeOrder(ctx) };

  const known = new Map(all.map((w) => [String(w.id), w]));
  const stray = asked.filter((id) => !known.has(id));
  if (stray.length) {
    return { ok: false, error: `${stray.length === 1 ? "A selected work order does" : `${stray.length} selected work orders do`} not belong to this order.`, scope: null };
  }

  /* Naming every work order is the order. Stored as the order, so the rule
     that one order-wide target replaces another is not dodged by listing
     them all. */
  if (asked.length === all.length) return { ok: true, error: "", scope: wholeOrder(ctx) };

  if (!canScope(department)) {
    return {
      ok: false,
      error: "Dispatch is recorded per challan for the whole order, not per work order, so a target on selected work orders cannot be measured. Set the target on the whole order.",
      scope: null,
    };
  }

  const chosen = asked.map((id) => known.get(id));
  const quantity = chosen.reduce((n, w) => n + (Number(w.quantity) || 0), 0);
  return {
    ok: true,
    error: "",
    scope: {
      kind: "work_orders",
      workOrderIds: asked,
      quantity,
      count: chosen.length,
      label: `${chosen.length} of ${all.length} work order${all.length === 1 ? "" : "s"}`,
      detail: chosen.slice(0, 3).map((w) => w.number || w.product || "").filter(Boolean).join(", ")
        + (chosen.length > 3 ? ` +${chosen.length - 3}` : ""),
    },
  };
}

/** Does a completion event belong to this scope? */
function eventInScope(event, scope, ids = null) {
  if (!scope || scope.kind !== "work_orders") return true;
  const set = ids || idsOf(scope);
  return Boolean(event?.woId) && set.has(String(event.woId));
}

/** Only this scope's events. */
function scopedEvents(events, scope) {
  if (!scope || scope.kind !== "work_orders") return events || [];
  const set = idsOf(scope);
  return (events || []).filter((e) => eventInScope(e, scope, set));
}

/**
 * Do two scopes ask the same work from the same department?
 *
 * This is what decides whether a new target REPLACES a standing one. Two
 * targets on different work orders are two live commitments and both stand —
 * that is the whole point of scoping. Two that share any work order, or either
 * of which is the whole order, are the same promise made twice, so the older
 * one is replaced as it always was.
 */
function scopesOverlap(a, b) {
  const ka = a?.kind === "work_orders", kb = b?.kind === "work_orders";
  if (!ka || !kb) return true;
  const set = idsOf(a);
  return (b.workOrderIds || []).some((id) => set.has(String(id)));
}

/** What a scope is called in a sentence. */
function describeScope(scope) {
  if (!scope || scope.kind !== "work_orders") return "";
  return scope.detail ? `${scope.label} (${scope.detail})` : scope.label;
}

module.exports = { ATTRIBUTABLE, SCOPE_KINDS, canScope, wholeOrder, resolveScope, eventInScope, scopedEvents, scopesOverlap, describeScope };
