// services/closingReport.js
//
// The Order Closing Report: everything needed to sign an order off.
//
// WHY THIS STAGE EXISTS. It is the only place ESTIMATE MEETS ACTUAL. Every other
// stage is forward-looking — what we think it will cost, what we hope to charge,
// when we expect to finish. Once the last piece is packed and the last challan
// is out, all four of those have real counterparts, and the gap between them is
// the most useful number this system can produce:
//
//   materials   costing sheet's unit cost × consumption   →  rawMaterials[].quantityIssued × unitCost
//   labour      SAM × cost per minute from the IE sheet   →  timeMetrics avg seconds × units
//   price       the quotation                             →  the PI, and what was actually paid
//   dates       assignedDeadline                          →  when the last piece cleared packing
//
// WHAT THIS FILE DOES AND DOES NOT DO. It assembles the ACTUALS — production,
// dispatch, money — and computes closure readiness. It does NOT read the CoWork
// costing sheets for the estimate side: that content lives in a Firestore
// workbook and the reader for it already exists on the client
// (lib/salesJourney/costingModel), so the estimate is joined there rather than
// porting a spreadsheet parser into this service. `costing.estimateSource` says
// so plainly instead of returning a zero that would read as "it cost nothing".
//
// NOTHING IS INVENTED. There is no satisfaction score, no complaint log and no
// warranty state anywhere in GRAV, so this report has none. What it has is what
// happened.
"use strict";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const SECONDS_PER_HOUR = 3600;

function sizeOf(wo) {
  const attrs = wo.variantAttributes || [];
  const size = attrs.find((a) => /size/i.test(a?.name || ""));
  if (size?.value) return String(size.value);
  return attrs.map((a) => a?.value).filter(Boolean).join(" / ") || "—";
}

/** Pieces through the last operation, and when that happened. */
function packedOf(wo) {
  const ops = (wo.productionCompletion?.operationCompletion || [])
    .slice()
    .sort((a, b) => num(a.operationNumber) - num(b.operationNumber));
  if (!ops.length) return 0;
  const last = ops[ops.length - 1];
  return Array.isArray(last.completedUnitNumbers) && last.completedUnitNumbers.length
    ? last.completedUnitNumbers.length
    : num(last.completedQuantity);
}

/**
 * Actual cost, from what the floor really consumed.
 *
 * Materials are exact: the store issued a quantity at a unit cost. Labour is
 * measured seconds turned into money, which needs a rate per minute — and that
 * rate lives on the IE costing sheet, not here. Without it the labour half is
 * reported as UNPRICED rather than as zero, because a zero would silently make
 * every order look more profitable than it was.
 */
function actualCostOf(wo) {
  const materials = (wo.rawMaterials || []).reduce((s, m) => {
    const issued = num(m.quantityIssued);
    // Fall back to the allocated/required figure only to say what it WOULD be;
    // `issuedComplete` tells the caller whether this is a real consumption
    // number or a plan standing in for one.
    return s + issued * num(m.unitCost);
  }, 0);
  const issuedComplete = (wo.rawMaterials || []).length > 0
    && (wo.rawMaterials || []).every((m) => num(m.quantityIssued) > 0);

  const metrics = wo.productionCompletion?.timeMetrics || [];
  const seconds = metrics.reduce((s, m) => s + num(m.avgCompletionTimeSeconds) * num(m.totalUnitsAnalyzed), 0);

  return {
    materials: +materials.toFixed(2),
    issuedComplete,
    // Hours of measured machine/operator time across every operation. Money only
    // once a rate exists — see the header.
    labourHours: +(seconds / SECONDS_PER_HOUR).toFixed(1),
    labourPriced: false,
    // WorkOrder's own fields, when somebody has filled them in. Reported
    // alongside rather than instead of the derived figures, so a mismatch is
    // visible instead of hidden behind a preference.
    declaredEstimate: num(wo.estimatedCost) || null,
    declaredActual: num(wo.actualCost) || null,
  };
}

/**
 * @param {object} p
 * @param {object[]} p.workOrders
 * @param {object[]} p.challans
 * @param {object|null} p.request   the CustomerRequest (quotation / PI / payments)
 * @param {object} p.enquiry        lean enquiry, for its products and early-dispatch asks
 */
function buildClosingReport({ workOrders = [], challans = [], request = null, enquiry = null }, now = new Date()) {
  const orders = workOrders.filter(Boolean);

  // ── What was ordered, made and sent ──────────────────────────────────────
  const lines = orders.map((wo) => {
    const ordered = num(wo.quantity);
    const packed = packedOf(wo);
    const dispatched = Math.min(packed, num(wo.dispatchedQuantity));
    const cost = actualCostOf(wo);
    return {
      workOrderNumber: wo.workOrderNumber || "",
      style: wo.stockItemName || wo.stockItemReference || "—",
      size: sizeOf(wo),
      ordered,
      packed,
      dispatched,
      short: Math.max(0, ordered - dispatched),
      deadline: wo.assignedDeadline || null,
      cost,
    };
  }).sort((a, b) => a.style.localeCompare(b.style) || a.size.localeCompare(b.size));

  const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
  const delivery = {
    ordered: sum("ordered"),
    packed: sum("packed"),
    dispatched: sum("dispatched"),
    short: sum("short"),
    challans: challans.length,
  };
  delivery.pct = delivery.ordered > 0 ? Math.round((delivery.dispatched / delivery.ordered) * 100) : 0;
  delivery.complete = delivery.ordered > 0 && delivery.short === 0;

  // ── Dates. Promised is the earliest deadline the floor was given; actual is
  //    the last challan out, which is when the customer actually had it. ──────
  const deadlines = lines.map((l) => l.deadline).filter(Boolean).map((d) => new Date(d));
  const sent = challans.map((c) => c.createdAt).filter(Boolean).map((d) => new Date(d));
  const promised = deadlines.length ? new Date(Math.min(...deadlines)) : null;
  const lastOut = sent.length ? new Date(Math.max(...sent)) : null;
  const DAY = 86400000;
  const dates = {
    promised,
    lastDispatch: lastOut,
    daysLate: promised && lastOut ? Math.max(0, Math.round((lastOut - promised) / DAY)) : null,
    onTime: promised && lastOut ? lastOut <= promised : null,
  };

  // ── Quality, from the scan ledger rather than anyone's opinion ────────────
  const invalid = orders.reduce((s, wo) => s + num(wo.productionCompletion?.invalidScansCount)
    + (wo.productionCompletion?.invalidScans || []).length, 0);
  const quality = {
    invalidScans: invalid,
    // A rejection count per se is not stored; short delivery is the only
    // quality outcome this data can prove, so that is what is reported.
    shortDelivered: delivery.short,
  };

  // ── Cost. Actuals here; the estimate is joined on the client. ─────────────
  const materials = +lines.reduce((s, l) => s + l.cost.materials, 0).toFixed(2);
  const labourHours = +lines.reduce((s, l) => s + l.cost.labourHours, 0).toFixed(1);
  const costing = {
    actualMaterials: materials,
    actualLabourHours: labourHours,
    labourPriced: false,
    issuedComplete: lines.length > 0 && lines.every((l) => l.cost.issuedComplete),
    declaredEstimate: +lines.reduce((s, l) => s + (l.cost.declaredEstimate || 0), 0).toFixed(2) || null,
    declaredActual: +lines.reduce((s, l) => s + (l.cost.declaredActual || 0), 0).toFixed(2) || null,
    // The client reads the CoWork costing sheets and fills this in.
    estimateSource: "cowork-costing-sheets",
  };

  // ── Money ────────────────────────────────────────────────────────────────
  const q = (request?.quotations || [])[0] || null;
  const schedule = (request?.paymentSchedule || []).map((p) => ({
    dueDate: p.dueDate || null,
    status: p.status || "pending",
    paidAmount: num(p.paidAmount),
    remainingAmount: num(p.remainingAmount),
  }));
  const invoiced = num(q?.grandTotal) || num(request?.grandTotal) || 0;
  const received = schedule.reduce((s, p) => s + p.paidAmount, 0);
  const outstanding = schedule.length
    ? schedule.reduce((s, p) => s + p.remainingAmount, 0)
    : Math.max(0, invoiced - received);
  const overdue = schedule.filter((p) => p.status === "overdue"
    || (p.status !== "paid" && p.dueDate && new Date(p.dueDate) < now));
  const money = {
    requestId: request?.requestId || null,
    invoiced,
    received,
    outstanding,
    settled: invoiced > 0 && outstanding <= 0,
    instalments: schedule.length,
    overdue: overdue.length,
    overdueAmount: +overdue.reduce((s, p) => s + p.remainingAmount, 0).toFixed(2),
    schedule,
  };

  // ── What the customer now owns. The one thing worth carrying forward: it is
  //    the input to their next order, and it exists nowhere else assembled. ──
  const byStyle = new Map();
  for (const l of lines) {
    if (!byStyle.has(l.style)) byStyle.set(l.style, { style: l.style, delivered: 0, sizes: [] });
    const st = byStyle.get(l.style);
    st.delivered += l.dispatched;
    if (l.dispatched > 0) st.sizes.push({ size: l.size, pieces: l.dispatched });
  }
  const departments = new Map();
  let staff = 0;
  for (const c of challans) {
    for (const p of c.persons || []) {
      staff += 1;
      const d = p.department || "Unassigned";
      departments.set(d, (departments.get(d) || 0) + num(p.totalUnits));
    }
  }
  const installedBase = {
    styles: [...byStyle.values()].filter((s) => s.delivered > 0).sort((a, b) => b.delivered - a.delivered),
    staffKitted: staff,
    departments: [...departments.entries()].map(([name, pieces]) => ({ name, pieces }))
      .sort((a, b) => b.pieces - a.pieces),
    deliveredOn: lastOut,
  };

  // ── Exceptions that happened along the way, for the record ───────────────
  const early = (enquiry?.earlyDispatchRequests || []).map((r) => ({
    pieces: num(r.pieces), reason: r.reason || "", status: r.status || "requested",
    requestedAt: r.requestedAt || null, requestedByName: r.requestedBy?.name || "",
  }));

  // ── Can this be closed? Every item is a fact, not a judgement. ───────────
  const checklist = [
    {
      id: "delivered",
      label: "Everything ordered has been dispatched",
      done: delivery.complete,
      detail: delivery.complete ? null : `${delivery.short} of ${delivery.ordered} pieces never went out.`,
    },
    {
      id: "paid",
      label: "The order is paid in full",
      done: money.settled,
      detail: money.settled ? null
        : invoiced > 0
          ? `${money.outstanding} still outstanding${money.overdue ? ` · ${money.overdue} instalment${money.overdue === 1 ? "" : "s"} overdue` : ""}.`
          : "No invoice total on the order yet.",
    },
    {
      id: "cost",
      label: "Actual material cost is recorded",
      done: costing.issuedComplete,
      detail: costing.issuedComplete ? null
        : "Some materials show nothing issued, so the actual cost is incomplete.",
    },
  ];

  return {
    delivery,
    dates,
    quality,
    costing,
    money,
    installedBase,
    lines,
    earlyDispatches: early,
    checklist,
    canClose: checklist.every((c) => c.done),
    blockers: checklist.filter((c) => !c.done).length,
    now,
  };
}

module.exports = { buildClosingReport };
