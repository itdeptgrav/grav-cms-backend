// services/shipmentView.js
//
// Work orders + dispatch challans → what is ready to leave, and what has left.
//
// SHIPMENT IS PRODUCTION'S LAST COLUMN, CONTINUED. A piece that clears the final
// operation is packed; a packed piece that has not been dispatched is READY TO
// SHIP. So this service does not invent a new lifecycle — it reads the same
// counted pieces productionView does and subtracts what the dispatch ledger says
// has gone:
//
//   ordered        WorkOrder.quantity
//   packed         last operationCompletion's completed unit numbers
//   dispatched     WorkOrder.dispatchedQuantity (the store's own ledger)
//   ready to ship  packed − dispatched
//   in production  ordered − packed
//
// WHAT IS NOT HERE, BECAUSE IT IS NOT IN THE DATA:
//
//   • No "received"/"acknowledged"/"signed" state. DispatchChallan has no such
//     field, so a delivered-and-signed count would be invented. Dispatched is
//     the last thing GRAV actually knows.
//   • No ETD, ETA, transporter, freight mode or port. GRAV dispatches challans
//     to named staff or to a store; it is not an export freight system, and the
//     old fixtures for this stage described one.
//
// A challan is `person_wise` (named staff, each with their own garments, carrying
// a UIN and department) or `bulk` (to a store). Both are summarised; the person
// detail is only read when it exists.
"use strict";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * A work order's human label.
 *
 * `workOrderNumber` is declared on the model but NOTHING GENERATES IT — as of
 * 27 Aug 2026 all 138 work orders in the live database have it unset, so every
 * view that showed it rendered a blank cell and the lists read as broken or
 * empty. Falling back to the id's last 8 characters matches both the existing
 * convention in routes/CEO_Routes/commandCenter.js and, more usefully, the
 * barcode format production actually prints (`WO-<shortId>-<unit>`), so the
 * label on screen is the one a person can match against a physical ticket.
 *
 * A display fallback, not a fix: the real repair is generating the number on
 * creation. This stops the gap being invisible in the meantime.
 */
/**
 * Product identity for a work order — the SAME resolver productionView uses,
 * imported rather than duplicated so the two screens can never disagree about
 * which photo represents a style (27 Aug 2026).
 */
const { productIdentity, variantOf, sizeOf } = require("./productionView");

const woLabel = (wo) => wo.workOrderNumber || (wo._id ? `WO-${String(wo._id).slice(-8)}` : "—");

// sizeOf/variantOf come from productionView — a SECOND copy of this lived here
// and carried the same bug (falling back to "any attribute", so a colour-only
// product reported its size as "Green" and the by-size grid grew a GREEN
// column). Importing the one implementation means the two screens cannot drift
// apart again (27 Aug 2026).

/** How many of this work order's pieces are through the LAST operation. */
function packedOf(wo) {
  const ops = wo.productionCompletion?.operationCompletion || [];
  if (!ops.length) return 0;
  const last = [...ops].sort((a, b) => num(a.operationNumber) - num(b.operationNumber)).pop();
  return Array.isArray(last.completedUnitNumbers) && last.completedUnitNumbers.length
    ? last.completedUnitNumbers.length
    : num(last.completedQuantity);
}

/**
 * @param {object[]} workOrders lean WorkOrder docs for one customer request
 * @param {object[]} challans   lean DispatchChallan docs for the same request
 * @param {object[]} [earlyRequests] the enquiry's own off-schedule asks
 */
function buildShipmentView(workOrders = [], challans = [], earlyRequests = [], now = new Date()) {
  const orders = workOrders.filter(Boolean);

  const lines = orders.map((wo) => {
    const ordered = num(wo.quantity);
    const packed = packedOf(wo);
    const dispatched = Math.min(packed, num(wo.dispatchedQuantity));
    return {
      workOrderId: String(wo._id || ""),
      workOrderNumber: woLabel(wo),
      style: wo.stockItemName || wo.stockItemReference || "—",
      ...productIdentity(wo),
      size: sizeOf(wo),
      variant: variantOf(wo),
      ordered,
      packed,
      dispatched,
      // The only number Sales can act on: sitting packed, not gone.
      ready: Math.max(0, packed - dispatched),
      inProduction: Math.max(0, ordered - packed),
      deadline: wo.assignedDeadline || null,
    };
  }).sort((a, b) => a.style.localeCompare(b.style) || String(a.size ?? "").localeCompare(String(b.size ?? "")));

  const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
  const totals = {
    ordered: sum("ordered"),
    packed: sum("packed"),
    dispatched: sum("dispatched"),
    ready: sum("ready"),
    inProduction: sum("inProduction"),
    workOrders: lines.length,
  };
  totals.pct = totals.ordered > 0 ? Math.round((totals.dispatched / totals.ordered) * 100) : 0;

  // Style rollup, the same shape Production uses so the two stages read alike.
  const byStyle = new Map();
  for (const l of lines) {
    if (!byStyle.has(l.style)) {
      byStyle.set(l.style, {
        style: l.style, ordered: 0, packed: 0, dispatched: 0, ready: 0, inProduction: 0, sizes: [], deadline: l.deadline,
        image: l.image, reference: l.reference, gender: l.gender, category: l.category,
      });
    }
    const st = byStyle.get(l.style);
    for (const k of ["ordered", "packed", "dispatched", "ready", "inProduction"]) st[k] += l[k];
    st.sizes.push(l);
    if (l.deadline && (!st.deadline || new Date(l.deadline) < new Date(st.deadline))) st.deadline = l.deadline;
  }
  const styles = [...byStyle.values()].map((st) => ({
    ...st,
    pct: st.ordered > 0 ? Math.round((st.dispatched / st.ordered) * 100) : 0,
  })).sort((a, b) => b.ordered - a.ordered);

  const dispatches = challans.filter(Boolean).map((c) => ({
    id: String(c._id || ""),
    challanNumber: c.challanNumber || "",
    dispatchType: c.dispatchType || "bulk",
    totalUnits: num(c.totalUnits),
    totalPersons: num(c.totalPersons),
    dispatchedBy: c.dispatchedBy || "",
    notes: c.notes || "",
    createdAt: c.createdAt || null,
    // Person detail only where the challan actually is person-wise.
    persons: (c.persons || []).map((p) => ({
      name: p.employeeName || "",
      uin: p.employeeUIN || "",
      department: p.department || "",
      designation: p.designation || "",
      units: num(p.totalUnits),
    })),
  })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const requests = (earlyRequests || []).map((r) => ({
    id: String(r._id || ""),
    pieces: num(r.pieces),
    reason: r.reason || "",
    status: r.status || "requested",
    requestedAt: r.requestedAt || null,
    requestedByName: r.requestedBy?.name || "",
    decidedAt: r.decidedAt || null,
    decisionNote: r.decisionNote || "",
  })).sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

  return {
    totals,
    styles,
    lines,
    dispatches,
    requests,
    openRequests: requests.filter((r) => r.status === "requested").length,
    // Deliberately absent — see the file header.
    received: null,
    deadline: lines.map((l) => l.deadline).filter(Boolean).sort()[0] || null,
    now,
  };
}

module.exports = { buildShipmentView, packedOf };
