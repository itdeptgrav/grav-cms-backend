// services/centralCosting/productionActual.service.js
//
// WHAT PRODUCTION ACTUALLY CONSUMED, MADE AND COST — AND WHAT IT CANNOT SAY.
//
// ── THE AUDIT THIS FILE IS BUILT ON ─────────────────────────────────────────
// Before a line of it was written, the stored production contracts were read
// and classified. The classification is the product; the arithmetic is easy.
//
//   AUTHORITATIVE MEASURED ACTUAL
//     · StockIssuance — a real stock movement. `manufacturingOrder` is a
//       stored ref to CustomerRequest, `direction` separates issue from
//       return, and `items[].nativeQty` is already converted to the item's own
//       native unit. This is the material evidence.
//     · WorkOrder.productionCompletion.efficiencyMetrics[] — scan-derived
//       `unitsCompleted` and `totalProductiveTime` per operation.
//
//   POSTED ACCOUNTING ACTUAL
//     · Posted Acc_Voucher lines and active LandedCostAllocation — read
//       through Chunk 8A's procurement report, not re-derived here.
//
//   OPERATIONAL PROXY — NEVER RELABELLED AS ACTUAL
//     · MRF.items[].consumedQty. It LOOKS like measured consumption and is
//       not: both writers (mrfRoutes.js:2331 and :2736) compute it as
//       `issuedQty − returnedQty`. So it is net issue, and this file calls it
//       "Net issued to production" wherever it appears.
//     · WorkOrder.productionCompletion.overallCompletedQuantity — units that
//       finished the last operation. Completed is not the same as GOOD.
//     · WorkOrder.qcCompletion.completedQuantity — a PM's manual mark. The
//       model says so itself: real QC results live per-barcode elsewhere with
//       "nothing rolled up onto the WorkOrder".
//
//   ESTIMATE ONLY
//     · WorkOrder.rawMaterials[].quantityIssued / unitCost / totalCost — a BOM
//       snapshot taken when the order was created. Substituting it for stock
//       movement evidence would report the plan as the outcome.
//
//   UNAVAILABLE
//     · A QC inspection-result collection. There is none: the QC models are
//       stages, defect types and assignments — configuration, not results.
//     · Any payroll or posted work-order labour allocation. None exists, so
//       there is no posted labour actual to report.
//     · MRF → work order. MRF carries no stored production reference at all;
//       only free-text `costCentre` and `projectReference`. Attributing an MRF
//       to a work order would mean matching on text, which this whole report
//       exists to avoid — so MRF is read for evidence and never for lineage.
//
// ── AND THE CONSEQUENCE, STATED UP FRONT ────────────────────────────────────
// Good ACCEPTED output has no authoritative source in this system today. That
// is the denominator a final unit cost needs, so this report cannot produce
// one — and it says exactly that, rather than quietly dividing by the units a
// PM ticked off or by the quantity the customer ordered.

"use strict";

const mongoose = require("mongoose");

const procurement = require("./actualProcurement.service");

const Closeout = () => require("../../models/CMS_Models/Manufacturing/Production/ProductionCostCloseout");
const CustomerRequest = () => require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = () => require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockIssuance = () => require("../../models/CMS_Models/Inventory/Operations/StockIssuance");

/* How a figure was arrived at. The label travels WITH the number everywhere:
   a reader who cannot tell a measured actual from an absorbed rate cannot use
   either of them. */
const BASIS = Object.freeze({
  MEASURED: "Measured actual",
  POSTED: "Posted accounting actual",
  APPLIED: "Applied conversion cost",
  ABSORBED: "Absorbed at approved rate",
  POLICY: "Applied overhead",
  PROXY: "Operational proxy",
  ESTIMATE: "Approved estimate",
  NET_ISSUED: "Net issued to production",
  UNAVAILABLE: "Actual source not connected",
});

/* Every production quantity is a different claim. None substitutes for
   another, and the report never silently promotes one. */
const OUTPUT = Object.freeze({
  ORDERED: "ordered",
  PLANNED: "planned",
  STARTED: "started",
  COMPLETED: "completed",
  GOOD: "goodAccepted",
  REJECTED: "rejected",
  REWORK: "rework",
  PACKAGED: "packaged",
  DISPATCHED: "dispatched",
});

/* Why a final per-good-unit cost cannot be stated. Each is a specific missing
   record, never one generic "incomplete". */
const BLOCKER = Object.freeze({
  NO_GOOD_OUTPUT: "NO_GOOD_OUTPUT",
  NO_WORK_ORDER: "NO_WORK_ORDER",
  AMBIGUOUS_LINEAGE: "AMBIGUOUS_LINEAGE",
  MATERIAL_VALUE: "MATERIAL_VALUE",
  MATERIAL_UNIT: "MATERIAL_UNIT",
  LABOUR_SOURCE: "LABOUR_SOURCE",
  PROCUREMENT_INCOMPLETE: "PROCUREMENT_INCOMPLETE",
  CONSUMPTION_PROXY: "CONSUMPTION_PROXY",
  CLOSEOUT_INCOMPLETE: "CLOSEOUT_INCOMPLETE",
  ISSUE_VALUE: "ISSUE_VALUE",
});

const BLOCKER_TEXT = Object.freeze({
  NO_GOOD_OUTPUT:
    "Good accepted output is not recorded anywhere this report can trust. Production "
    + "completion counts units that finished the last operation, and the QC figure on a "
    + "work order is a manual mark rather than an inspection result — so neither is a "
    + "defensible denominator for a per-unit cost.",
  NO_WORK_ORDER: "No work order is linked to this costing's customer order, so nothing produced can be attributed to it.",
  AMBIGUOUS_LINEAGE: "Work orders for other products share this customer order, and the costing's product could not be told apart by a stored identity.",
  MATERIAL_VALUE: "Material issues are recorded as quantities. Their historical issue value is not available from the valuation records, so consumed material cost cannot be stated.",
  MATERIAL_UNIT: "A material was issued in a unit that could not be reconciled with the costing's unit, so its consumption cannot be compared.",
  LABOUR_SOURCE: "No payroll or work-order labour posting exists, so there is no paid-labour actual — only conversion cost applied at an approved rate.",
  CLOSEOUT_INCOMPLETE:
    "Some work orders for this product have not had their production closed, so the accepted "
    + "output is a running subtotal rather than the run's result.",
  /* The precise message this chunk was asked to produce once quantities close. */
  ISSUE_VALUE:
    "Production quantities are closed, but historical issue value is not connected. "
    + "The material actually consumed is known as a quantity; what it cost when it was issued is not.",
  PROCUREMENT_INCOMPLETE: "Procurement actuals are still incomplete, so the material and service cost behind this product is a running total.",
  CONSUMPTION_PROXY: "Consumption is inferred from issues less returns rather than recorded directly, so it is net issue and not confirmed consumption.",
});

/* The nine families, with what this system can actually say about each. */
const FAMILY = Object.freeze({
  materials: "Materials",
  services: "Outside services",
  packaging: "Packaging",
  freight: "Freight",
  duty: "Duty and non-recoverable tax",
  landed: "Landed charges",
  labour: "Production labour and conversion",
  overhead: "Applied overhead",
  financing: "Financing",
});

const TITLE = "Actual cost & margin";
const STANDING =
  "This shows the approved estimate beside what purchasing, production and Accounting "
  + "have actually recorded. Figures are labelled by how they were arrived at — measured, "
  + "posted, applied or absorbed — and a per-unit cost appears only when the records "
  + "genuinely support one.";
const TAX_NOTE =
  "Income tax is calculated on company taxable profit, not included in this product's "
  + "manufacturing cost.";
const MARGIN_LABEL = "Margin at approved selling price";
const MARGIN_CAVEAT =
  "This is margin against the price the costing approved, not realised profit. Customer "
  + "revenue, returns, discounts and credit notes are not connected.";

const present = (v) => v !== null && v !== undefined && v !== ""
  && (typeof v !== "number" || Number.isFinite(v));
const idOf = (v) => (v === null || v === undefined ? null : String(v));
const num = (v) => (present(v) ? Number(v) : 0);

/**
 * The work orders that genuinely belong to this costing's product.
 *
 * ── A CUSTOMER ORDER IS NOT A PRODUCT ───────────────────────────────────────
 * One customer request may carry several work orders for several products. A
 * work order for a different product under the same request must NOT be
 * attributed here merely because the customer matches — that is the
 * same-customer version of matching by name, and it would charge one garment's
 * material to another.
 *
 * So the filter is a stored product identity: `stockItemId`, and where the
 * costing knows a variant, `variantId` too. A work order that names neither
 * cannot be attributed and is returned as unlinked evidence rather than
 * guessed at.
 *
 * Cancelled work is excluded from every quantity and cost, and kept in the
 * result: a cancelled run is history somebody may need to explain.
 */
function selectWorkOrders(workOrders, { stockItemId, variantId }) {
  const attributed = [];
  const unlinked = [];
  const cancelled = [];

  for (const wo of workOrders) {
    const woItem = idOf(wo.stockItemId);
    if (!woItem) { unlinked.push(wo); continue; }
    if (!stockItemId || woItem !== String(stockItemId)) { unlinked.push(wo); continue; }
    /* A variant is part of the product's identity. Where the costing names
       one and the work order names a different one, it is a different
       garment. */
    if (present(variantId) && present(wo.variantId) && String(wo.variantId) !== String(variantId)) {
      unlinked.push(wo);
      continue;
    }
    if (String(wo.status || "").toLowerCase() === "cancelled") { cancelled.push(wo); continue; }
    attributed.push(wo);
  }
  return { attributed, unlinked, cancelled };
}

/**
 * What production made, quantity by quantity.
 *
 * ── SEVERAL WORK ORDERS SUM ONCE ────────────────────────────────────────────
 * A split order is several work orders for one demand; each contributes its
 * own quantities exactly once. A rework order is not extra output — the same
 * garments going round again — so rework is reported apart and never added to
 * completed.
 *
 * ── AND "GOOD" IS THE ONE FIGURE THIS SYSTEM CANNOT GIVE ─────────────────────
 * `overallCompletedQuantity` counts units that finished the last operation.
 * `qcCompletion.completedQuantity` is a PM's manual mark, which the WorkOrder
 * model itself describes as standing in for QC results that live per-barcode
 * elsewhere and are never rolled up. Neither is an inspection result, so
 * `goodAccepted` is null and every consumer of it must cope with that.
 */
function outputFrom(workOrders, closeouts = []) {
  const sum = (pick) => workOrders.reduce((t, wo) => t + num(pick(wo)), 0);
  const completed = sum((wo) => wo.productionCompletion?.overallCompletedQuantity);
  const qcMarked = sum((wo) => wo.qcCompletion?.completedQuantity);

  /* ── CLOSED EVIDENCE, AND ONLY CLOSED ────────────────────────────────
     A draft closeout is somebody's working copy. Only a live CLOSED
     revision states what a run came to, and coverage must be COMPLETE: one
     work order still open leaves the accepted total a running subtotal, and
     a subtotal used as a denominator produces a unit cost that is simply
     wrong rather than merely provisional. */
  const closedByWorkOrder = new Map(closeouts.map((c) => [String(c.workOrderId), c]));
  const covered = workOrders.filter((wo) => closedByWorkOrder.has(String(wo._id)));
  const uncovered = workOrders.filter((wo) => !closedByWorkOrder.has(String(wo._id)));
  const fullyCovered = workOrders.length > 0 && uncovered.length === 0;

  const closedAccepted = covered.reduce((t, wo) => t + num(closedByWorkOrder.get(String(wo._id))?.output?.acceptedGoodQty), 0);
  const closedRejected = covered.reduce((t, wo) => t + num(closedByWorkOrder.get(String(wo._id))?.output?.rejectedQty), 0);
  const closedRework = covered.reduce((t, wo) => t + num(closedByWorkOrder.get(String(wo._id))?.output?.openReworkQty), 0);

  return {
    planned: sum((wo) => wo.quantity),
    started: sum((wo) => wo.cuttingProgress?.completed),
    completed,
    completedBasis: BASIS.MEASURED,
    /* Shown, labelled, and never used as a denominator. */
    qcMarked,
    qcMarkedBasis: BASIS.PROXY,
    qcMarkedNote:
      "Marked by a project manager rather than produced by an inspection record, "
      + "so it is not a QC result.",
    /* ── NOW AUTHORITATIVE, WHERE EVERY RUN IS CLOSED ────────────────
       From the closed production evidence, which is itself derived from the
       per-piece QC ledger. Null while any relevant work order is still open,
       because a partial accepted total is not a denominator. */
    goodAccepted: fullyCovered ? closedAccepted : null,
    goodAcceptedBasis: fullyCovered ? BASIS.MEASURED : BASIS.UNAVAILABLE,
    goodAcceptedReason: fullyCovered ? null : BLOCKER_TEXT.CLOSEOUT_INCOMPLETE,
    rejected: fullyCovered ? closedRejected : null,
    rejectedBasis: fullyCovered ? BASIS.MEASURED : BASIS.UNAVAILABLE,
    rework: fullyCovered ? closedRework : null,
    reworkBasis: fullyCovered ? BASIS.MEASURED : BASIS.UNAVAILABLE,
    /* What the costing screen shows about coverage. */
    closeoutCoverage: {
      total: workOrders.length,
      closed: covered.length,
      complete: fullyCovered,
      open: uncovered.map((wo) => ({
        workOrderId: String(wo._id), number: wo.workOrderNumber || "", status: wo.status || "",
      })),
    },
    packaged: sum((wo) => wo.packagedQuantity),
    packagedBasis: BASIS.PROXY,
    dispatched: sum((wo) => (wo.bulkDispatchHistory || []).reduce((t, d) => t + num(d.quantity), 0)),
    dispatchedBasis: BASIS.PROXY,
    workOrderCount: workOrders.length,
  };
}

/**
 * What was actually issued to, and returned from, production.
 *
 * ── FROM STOCK MOVEMENTS, NOT FROM THE BOM SNAPSHOT ─────────────────────────
 * `StockIssuance` is the movement. `direction` says which way it went, and
 * `nativeQty` is already in the item's own native unit, so nothing here
 * converts anything — a conversion this file performed would be a second
 * answer to one the issue already recorded.
 *
 * Returns reduce the net exactly once: they are their own credit movements,
 * summed separately and subtracted, never also deducted from the issue rows.
 */
function materialMovement(issuances, { itemId, variantId }) {
  let issuedQty = 0;
  let returnedQty = 0;
  let unit = null;
  let unitConflict = false;
  const documents = [];

  for (const doc of issuances) {
    for (const line of doc.items || []) {
      if (!line.rawItem || String(line.rawItem) !== String(itemId)) continue;
      /* A variant is part of the identity, both ways: a costing that names one
         must not absorb another's issues, and one that names none must not
         claim a specific variant's. */
      if (present(variantId) && present(line.variantId) && String(line.variantId) !== String(variantId)) continue;

      const q = num(line.nativeQty);
      const u = line.nativeUnit || "";
      if (unit === null) unit = u;
      /* ── UNLIKE UNITS ARE NEVER ADDED ──────────────────────────────
         Two issues of the same item in incompatible native units is a data
         problem, and summing them produces a quantity that means nothing. */
      else if (u && unit && u.toLowerCase() !== unit.toLowerCase()) unitConflict = true;

      if (doc.direction === "credit") returnedQty += q;
      else issuedQty += q;
      documents.push({ issuanceId: idOf(doc._id), direction: doc.direction, quantity: q, unit: u });
    }
  }

  return {
    issuedQty, returnedQty,
    /* Named for what it IS. `MRF.consumedQty` is this same subtraction under a
       misleading name, so this report never borrows that word. */
    netIssuedQty: issuedQty - returnedQty,
    unit, unitConflict,
    /* Nothing in this system records what production actually consumed, as
       distinct from what it was given and gave back. */
    confirmedConsumedQty: null,
    basis: unitConflict ? BASIS.UNAVAILABLE : BASIS.NET_ISSUED,
    documents,
    found: documents.length > 0,
  };
}

/**
 * One approved material line beside what actually moved.
 *
 * Consumption variance is only computed where BOTH sides are compatible: the
 * units reconcile, and there is an output basis to compare per-unit
 * consumption against. Otherwise the quantities are reported and the variance
 * is explicitly unavailable — an incompatible comparison is worse than none.
 */
function materialLine({ requirement, movement, outputBasis }) {
  const estimatedPerUnit = present(requirement.quantity?.consumptionPerUnit)
    ? Number(requirement.quantity.consumptionPerUnit) : null;
  const estimatedTotal = present(requirement.quantity?.orderQuantity)
    ? Number(requirement.quantity.orderQuantity) : null;
  const estimatedUnit = requirement.quantity?.consumptionUom || null;

  const blockers = [];
  if (movement.unitConflict) blockers.push(BLOCKER.MATERIAL_UNIT);
  if (movement.found) blockers.push(BLOCKER.CONSUMPTION_PROXY);

  /* Per good unit, and only with a trustworthy numerator AND denominator. */
  const perGoodUnit = (outputBasis.quantity && movement.found && !movement.unitConflict)
    ? movement.netIssuedQty / outputBasis.quantity : null;

  /* Quantity variance against the approved total, in the material's own unit
     — never money, because the historical issue value is not available. */
  const quantityVariance = (estimatedTotal !== null && movement.found && !movement.unitConflict)
    ? movement.netIssuedQty - estimatedTotal : null;

  return {
    requirementId: requirement.requirementId || `${requirement.reference?.lineKey}:${requirement.kind}`,
    itemId: idOf(requirement.reference?.itemId),
    variantId: idOf(requirement.reference?.variantId),
    name: requirement.identity?.name || "",
    sku: requirement.identity?.sku || "",
    variantLabel: requirement.identity?.variantLabel || "",
    estimatedPerUnit, estimatedTotal, estimatedUnit,
    estimatedBasis: BASIS.ESTIMATE,
    issuedQty: movement.found ? movement.issuedQty : null,
    returnedQty: movement.found ? movement.returnedQty : null,
    netIssuedQty: movement.found ? movement.netIssuedQty : null,
    confirmedConsumedQty: movement.confirmedConsumedQty,
    actualUnit: movement.unit,
    actualBasis: movement.found ? movement.basis : BASIS.UNAVAILABLE,
    outputQuantity: outputBasis.quantity,
    outputBasis: outputBasis.basis,
    perGoodUnit,
    quantityVariance,
    /* ── QUANTITY IS KNOWN; MONEY IS NOT ──────────────────────────────
       The issue records carry no historical value, and the current Item
       Master price is a price today rather than the price this issue was
       made at. Using it would restate history. */
    consumedValueMinor: null,
    consumedValueBasis: BASIS.UNAVAILABLE,
    consumedValueReason: BLOCKER_TEXT.MATERIAL_VALUE,
    blockers: [...new Set(blockers)],
    documents: movement.documents,
    complete: false,
  };
}

/**
 * Conversion cost, classified by what the evidence actually supports.
 *
 * ── FOUR ANSWERS, AND ONLY ONE OF THEM IS "PAID" ────────────────────────────
 *   Posted labour actual   — a payroll or work-order labour posting. NONE
 *                            EXISTS in this system, so this is never returned.
 *   Applied conversion     — recorded productive time × the costing's own
 *                            frozen rate. Real measurement, applied rate.
 *   Absorbed at approved   — completed units × the frozen operation cost. No
 *     rate                   time measurement at all.
 *   Not connected          — neither time nor units can be tied to a rate.
 *
 * A current employee salary is never looked up: it is today's number, and
 * applying it to last quarter's production restates history under a label
 * that says "actual".
 */
function labourFrom({ workOrders, operationEstimates }) {
  const operations = [];
  let appliedMinor = 0;
  let absorbedMinor = 0;
  let anyTime = false;

  const rateByCode = new Map(
    (operationEstimates || []).map((o) => [String(o.code || o.lineKey).toLowerCase(), o]),
  );

  for (const wo of workOrders) {
    for (const m of wo.productionCompletion?.efficiencyMetrics || []) {
      const code = String(m.operationCode || m.operationType || "").toLowerCase();
      const est = rateByCode.get(code) || null;
      const units = num(m.unitsCompleted);
      const seconds = num(m.totalProductiveTime);

      /* Time measured AND a frozen rate to apply to it. */
      if (seconds > 0 && est && present(est.ratePerMinuteMinor)) {
        anyTime = true;
        const minor = Math.round((seconds / 60) * Number(est.ratePerMinuteMinor));
        appliedMinor += minor;
        operations.push({
          operationCode: m.operationCode || "", operationType: m.operationType || "",
          unitsCompleted: units, productiveSeconds: seconds,
          amountMinor: minor, basis: BASIS.APPLIED,
          note: "Recorded production time at the rate the approved costing froze.",
        });
        continue;
      }
      /* Units, but no usable time — the approved per-unit cost, absorbed. */
      if (units > 0 && est && present(est.perUnitMinor)) {
        const minor = Math.round(units * Number(est.perUnitMinor));
        absorbedMinor += minor;
        operations.push({
          operationCode: m.operationCode || "", operationType: m.operationType || "",
          unitsCompleted: units, productiveSeconds: seconds,
          amountMinor: minor, basis: BASIS.ABSORBED,
          note: "Completed units at the approved rate. No production time was recorded against this operation.",
        });
        continue;
      }
      operations.push({
        operationCode: m.operationCode || "", operationType: m.operationType || "",
        unitsCompleted: units, productiveSeconds: seconds,
        amountMinor: null, basis: BASIS.UNAVAILABLE,
        note: "No approved rate matches this operation, so its conversion cost cannot be stated.",
      });
    }
  }

  const totalMinor = operations.some((o) => o.amountMinor !== null)
    ? appliedMinor + absorbedMinor : null;

  return {
    operations,
    appliedMinor: anyTime ? appliedMinor : null,
    absorbedMinor: absorbedMinor || null,
    totalMinor,
    /* The overall label follows the weaker half: a total that mixes applied
       and absorbed is not "applied". */
    basis: totalMinor === null ? BASIS.UNAVAILABLE
      : (absorbedMinor > 0 ? BASIS.ABSORBED : BASIS.APPLIED),
    /* Always stated, because "labour cost" reads as wages paid. */
    postedActualMinor: null,
    postedActualBasis: BASIS.UNAVAILABLE,
    postedActualReason: BLOCKER_TEXT.LABOUR_SOURCE,
  };
}

/**
 * The complete product-cost bridge, family by family.
 *
 * ── MISSING IS NOT ZERO, AND RECORDED ZERO IS NOT MISSING ───────────────────
 * Every family carries an amount OR null, plus how it was arrived at and why
 * it is absent when it is. A null totalled as zero is how a report claims a
 * product cost less than it did; a recorded zero shown as "missing" is how it
 * claims a question is open that somebody already answered.
 */
function bridgeFrom({ procurementReport, materials, labour, policy }) {
  const p = procurementReport?.summary || {};
  const rows = procurementReport?.requirements || [];
  const familyTotal = (test) => {
    const matching = rows.filter(test);
    if (!matching.length) return null;
    const valued = matching.filter((r) => r.actual?.postedActualMinor > 0);
    if (!valued.length) return null;
    return valued.reduce((t, r) => t + num(r.actual.postedActualMinor), 0);
  };

  const materialsPosted = familyTotal((r) => r.kind === "PHYSICAL");
  const servicesPosted = familyTotal((r) => r.kind !== "PHYSICAL");

  const family = (key, amountMinor, basis, extra = {}) => ({
    key, label: FAMILY[key], amountMinor, basis,
    /* Present, and honest, on every family. */
    coverage: amountMinor === null ? "unavailable"
      : (extra.partial ? "partial" : "complete"),
    ...extra,
  });

  const families = [
    family("materials", materialsPosted, materialsPosted === null ? BASIS.UNAVAILABLE : BASIS.POSTED, {
      partial: !p.complete,
      /* The purchase is posted; what production consumed of it is a quantity
         with no value. Both facts, side by side. */
      note: materials.some((m) => m.found !== false)
        ? "Purchased cost is posted. Consumption is measured as quantity only — its historical issue value is not available."
        : null,
      consumptionValueMinor: null,
      consumptionValueBasis: BASIS.UNAVAILABLE,
    }),
    family("services", servicesPosted, servicesPosted === null ? BASIS.UNAVAILABLE : BASIS.POSTED, { partial: !p.complete }),
    family("packaging", null, BASIS.UNAVAILABLE, {
      note: "Packaging bought externally is inside the procurement figure; packaging consumed in production is not separately recorded.",
    }),
    family("freight", null, BASIS.UNAVAILABLE),
    family("duty", present(p.postedActualMinor) && p.nonRecoverableTaxMinor ? p.nonRecoverableTaxMinor : null,
      p.nonRecoverableTaxMinor ? BASIS.POSTED : BASIS.UNAVAILABLE),
    family("landed", present(p.landedPostedMinor) && p.landedPostedMinor > 0 ? p.landedPostedMinor : null,
      p.landedPostedMinor > 0 ? BASIS.POSTED : BASIS.UNAVAILABLE),
    family("labour", labour.totalMinor, labour.basis, {
      note: labour.postedActualReason,
      appliedMinor: labour.appliedMinor,
      absorbedMinor: labour.absorbedMinor,
    }),
    family("overhead", present(policy?.overheadMinor) ? policy.overheadMinor : null,
      present(policy?.overheadMinor) ? BASIS.POLICY : BASIS.UNAVAILABLE, {
      /* Never "ledger actual": it is a rate the company set, applied. */
      note: present(policy?.overheadMinor)
        ? "Applied from the overhead rate the approved costing froze. It is not a posted ledger figure."
        : "No overhead rate is frozen on this approved version.",
    }),
    family("financing", null, BASIS.UNAVAILABLE, {
      note: "Financing cost is not attributed to an order anywhere in this system.",
    }),
  ];

  const known = families.filter((f) => f.amountMinor !== null);
  const missing = families.filter((f) => f.amountMinor === null);

  return {
    families,
    /* Only what is genuinely known. The missing families are NOT zeroes in
       this sum — they are listed beside it. */
    knownTotalMinor: known.reduce((t, f) => t + num(f.amountMinor), 0),
    knownFamilyCount: known.length,
    missingFamilies: missing.map((f) => ({ key: f.key, label: f.label, reason: f.note || f.basis })),
    /* Recoverable GST never enters any of the above. Reported so a reader can
       see it was handled rather than forgotten. */
    recoverableTaxMinor: p.recoverableTaxMinor ?? null,
    recoverableTaxNote: "Recoverable GST is reclaimed by the company and is not product cost.",
    incomeTaxNote: TAX_NOTE,
  };
}

/**
 * May a final actual unit cost be stated?
 *
 * ── EVERY CONDITION, NOT A MAJORITY ─────────────────────────────────────────
 * The answer today is always no, and the reason is the one the audit found:
 * good accepted output has no authoritative source. The other conditions are
 * checked anyway and reported, so that when QC results do become available
 * this gate does not silently start passing on a system that is still missing
 * material value or labour posting.
 */
function completenessOf({ procurementReport, output, materials, labour, workOrders }) {
  const blockers = [];

  if (!workOrders.attributed.length) blockers.push(BLOCKER.NO_WORK_ORDER);
  if (workOrders.unlinked.length) blockers.push(BLOCKER.AMBIGUOUS_LINEAGE);
  if (!present(output.goodAccepted)) {
    /* Distinguish "nobody closed it" from "there is no source at all" — the
       first is somebody's next action, the second was a system limitation. */
    blockers.push(output.closeoutCoverage && !output.closeoutCoverage.complete
      ? BLOCKER.CLOSEOUT_INCOMPLETE : BLOCKER.NO_GOOD_OUTPUT);
  } else if (num(output.goodAccepted) <= 0) {
    /* Zero accepted is valid evidence and a real answer — it simply cannot
       be a denominator. */
    blockers.push(BLOCKER.NO_GOOD_OUTPUT);
  }
  if (!procurementReport?.summary?.complete) blockers.push(BLOCKER.PROCUREMENT_INCOMPLETE);
  if (materials.some((m) => m.blockers.includes(BLOCKER.MATERIAL_UNIT))) blockers.push(BLOCKER.MATERIAL_UNIT);
  if (materials.some((m) => m.consumedValueMinor === null)) {
    /* Once quantities are closed, the remaining gap is value alone — and the
       message says exactly that instead of repeating a generic one. */
    blockers.push(present(output.goodAccepted) ? BLOCKER.ISSUE_VALUE : BLOCKER.MATERIAL_VALUE);
  }
  if (materials.some((m) => m.blockers.includes(BLOCKER.CONSUMPTION_PROXY))) blockers.push(BLOCKER.CONSUMPTION_PROXY);
  if (labour.postedActualMinor === null) blockers.push(BLOCKER.LABOUR_SOURCE);

  const unique = [...new Set(blockers)];
  return {
    complete: unique.length === 0,
    blockers: unique.map((k) => ({ key: k, message: BLOCKER_TEXT[k] })),
    /* The one sentence the headline carries when it is not complete. */
    label: unique.length === 0 ? "Actual unit cost" : "Known cost to date — incomplete",
  };
}

/**
 * Margin against the price the costing APPROVED — never realised profit.
 *
 * Realised profit needs customer revenue, returns, discounts, credit notes and
 * revenue recognition, none of which is connected. And no income-tax
 * percentage is subtracted from a product margin: income tax is charged on
 * company taxable profit, not on a garment.
 */
function marginFrom({ approvedPriceMinor, estimatedCostMinor, actualUnitCostMinor, goodOutput }) {
  const estimatedMargin = present(approvedPriceMinor) && present(estimatedCostMinor)
    ? approvedPriceMinor - estimatedCostMinor : null;
  const actualMargin = present(approvedPriceMinor) && present(actualUnitCostMinor)
    ? approvedPriceMinor - actualUnitCostMinor : null;

  return {
    label: MARGIN_LABEL,
    caveat: MARGIN_CAVEAT,
    approvedPriceMinor: present(approvedPriceMinor) ? approvedPriceMinor : null,
    estimatedCostMinor: present(estimatedCostMinor) ? estimatedCostMinor : null,
    estimatedMarginMinor: estimatedMargin,
    /* Null whenever the unit cost is — which is always, today. */
    actualUnitCostMinor: present(actualUnitCostMinor) ? actualUnitCostMinor : null,
    actualMarginMinor: actualMargin,
    marginVarianceMinor: present(estimatedMargin) && present(actualMargin)
      ? actualMargin - estimatedMargin : null,
    totalMarginMinor: present(actualMargin) && present(goodOutput) && goodOutput > 0
      ? actualMargin * goodOutput : null,
    incomeTaxNote: TAX_NOTE,
  };
}

/**
 * Every variance cause, reconciling exactly.
 *
 * ── THE IDENTITY MUST HOLD, OR SAY IT DOES NOT ──────────────────────────────
 * explained + unexplained === total, always. Where a cause cannot be computed
 * its amount is absent rather than zero, and whatever the causes fail to
 * account for lands in `unexplainedMinor` — never widened into the last cause
 * to make the arithmetic look tidy.
 */
function varianceFrom({ procurementReport, bridge, estimatedTotalMinor }) {
  const causes = [];
  /* Procurement's own decomposition, carried through rather than recomputed —
     one authority for purchase price and quantity variance. */
  for (const row of procurementReport?.requirements || []) {
    for (const c of row.variance?.causes || []) {
      const existing = causes.find((x) => x.cause === c.cause);
      if (existing) existing.amountMinor += num(c.amountMinor);
      else causes.push({ cause: c.cause, label: c.label, amountMinor: num(c.amountMinor) });
    }
  }
  /* Conversion cost the estimate did not carry as an actual. */
  const labour = bridge.families.find((f) => f.key === "labour");
  if (labour?.amountMinor !== null && labour?.amountMinor !== undefined) {
    causes.push({
      cause: "CONVERSION", label: "Conversion cost applied", amountMinor: labour.amountMinor,
      note: `Basis: ${labour.basis}.`,
    });
  }

  const explainedMinor = causes.reduce((t, c) => t + num(c.amountMinor), 0);
  const totalMinor = present(estimatedTotalMinor)
    ? bridge.knownTotalMinor - estimatedTotalMinor : null;
  const unexplainedMinor = totalMinor === null ? null : totalMinor - explainedMinor;

  return {
    causes, explainedMinor, totalMinor, unexplainedMinor,
    reconciles: unexplainedMinor === 0,
    /* Stated whether or not it reconciles, so nobody has to check the sum. */
    identity: "explained + unexplained = total",
  };
}

/**
 * The whole report: procurement (Chunk 8A) composed with production evidence.
 *
 * ── COMPOSED, NOT REBUILT ───────────────────────────────────────────────────
 * Purchase price, accepted quantity, posted bills and landed charges are
 * 8A's answer and are read from it. This adds what production consumed, made
 * and cost — and the gate that decides whether any of it adds up to a unit
 * cost.
 *
 * Every query is bounded and projected: the customer orders this costing was
 * quoted on, the work orders under those orders, and the issues against those
 * orders. Nothing loads a whole collection.
 */
async function reportFor(ctx, { costingId, scenarioKey } = {}) {
  const procurementReport = await procurement.reportFor(ctx, { costingId, scenarioKey });
  if (!procurementReport.available) {
    return { ...procurementReport, title: TITLE, standing: STANDING };
  }

  const versionId = procurementReport.version.costingVersionId;

  /* ── 1. THE CUSTOMER ORDERS THIS COSTING WAS QUOTED ON ────────────────
     Found through the quotation line's own `costingSource`, which the Sales
     handoff stamped — never by customer name or product name. */
  const customerRequests = await CustomerRequest().find({
    "quotations.items.costingSource.costingVersionId": versionId,
  })
    /* `stockItemId` is the product identity a work order is matched on. It
       must be projected, or every work order becomes unattributable and the
       report silently reports no production at all. */
    .select("_id requestId quotations.items.costingSource quotations.items.sampleStyleId "
      + "quotations.items.stockItemId quotations.items.unitPrice "
      + "quotations.items.quantity quotations.status")
    .limit(50)
    .lean()
    .catch(() => []);

  const requestIds = customerRequests.map((r) => r._id);

  /* The approved selling price this costing was quoted at, from the stamp. */
  let approvedPriceMinor = null;
  for (const r of customerRequests) {
    for (const q of r.quotations || []) {
      for (const item of q.items || []) {
        const src = item.costingSource;
        if (!src || String(src.costingVersionId) !== String(versionId)) continue;
        if (present(src.unitPriceMinor)) approvedPriceMinor = Number(src.unitPriceMinor);
      }
    }
  }

  /* ── 2. THE WORK ORDERS, FILTERED BY STORED PRODUCT IDENTITY ───────── */
  const workOrderDocs = requestIds.length
    ? await WorkOrder().find({ customerRequestId: { $in: requestIds } })
      .select("workOrderNumber customerRequestId stockItemId variantId status quantity "
        + "cuttingProgress packagedQuantity bulkDispatchHistory "
        + "productionCompletion.overallCompletedQuantity productionCompletion.efficiencyMetrics "
        + "qcCompletion.completedQuantity")
      .limit(200)
      .lean()
      .catch(() => [])
    : [];

  /* The costing's product identity, from the frozen provenance rather than a
     name. Absent on a costing whose style was never linked to a stock item. */
  const styleStockItemId = customerRequests
    .flatMap((r) => (r.quotations || []).flatMap((q) => q.items || []))
    .map((i) => i.stockItemId)
    .find(Boolean) || null;

  const workOrders = selectWorkOrders(workOrderDocs, {
    stockItemId: styleStockItemId, variantId: null,
  });

  /* Only live CLOSED revisions. A superseded one is history and a draft is a
     working copy; neither states what a run came to. */
  const closeouts = workOrders.attributed.length
    ? await Closeout().find({
      companyId: ctx.companyId,
      workOrderId: { $in: workOrders.attributed.map((w) => w._id) },
      status: "CLOSED",
    })
      .select("workOrderId output materials revision closedAt closedByName")
      .limit(200)
      .lean()
      .catch(() => [])
    : [];

  const output = outputFrom(workOrders.attributed, closeouts);

  /* ── 3. MATERIAL MOVEMENTS AGAINST THOSE ORDERS ────────────────────── */
  const issuances = requestIds.length
    ? await StockIssuance().find({
      companyId: ctx.companyId, manufacturingOrder: { $in: requestIds },
    })
      .select("_id direction manufacturingOrder items.rawItem items.variantId items.nativeQty items.nativeUnit createdAt")
      .limit(500)
      .lean()
      .catch(() => [])
    : [];

  const outputBasis = {
    /* Deliberately the completed count and NOT good output: it is the only
       measured figure, and every consumer of it is told which it is. */
    quantity: output.completed > 0 ? output.completed : null,
    basis: output.completed > 0 ? BASIS.MEASURED : BASIS.UNAVAILABLE,
    note: "Units that finished the last operation. Good accepted output is not recorded.",
  };

  const materials = procurementReport.requirements
    .filter((r) => r.kind === "PHYSICAL")
    .map((r) => materialLine({
      requirement: r,
      movement: materialMovement(issuances, {
        itemId: r.reference?.itemId, variantId: r.reference?.variantId,
      }),
      outputBasis,
    }));

  /* ── 4. CONVERSION COST ────────────────────────────────────────────── */
  const labour = labourFrom({ workOrders: workOrders.attributed, operationEstimates: [] });

  const bridge = bridgeFrom({ procurementReport, materials, labour, policy: null });
  const completeness = completenessOf({ procurementReport, output, materials, labour, workOrders });

  const estimatedTotalMinor = procurementReport.summary?.estimatedProcurementMinor ?? null;
  const variance = varianceFrom({ procurementReport, bridge, estimatedTotalMinor });

  /* ── 5. AND THE ONE FIGURE THIS SYSTEM CANNOT YET GIVE ──────────────── */
  const actualUnitCostMinor = completeness.complete && output.goodAccepted > 0
    ? Math.round(bridge.knownTotalMinor / output.goodAccepted) : null;

  const margin = marginFrom({
    approvedPriceMinor,
    estimatedCostMinor: procurementReport.requirements.length && present(procurementReport.scenario?.outputQuantity)
      ? Math.round(estimatedTotalMinor / Number(procurementReport.scenario.outputQuantity)) : null,
    actualUnitCostMinor,
    goodOutput: output.goodAccepted,
  });

  return {
    available: true,
    title: TITLE,
    standing: STANDING,
    costing: procurementReport.costing,
    version: procurementReport.version,
    scenario: procurementReport.scenario,
    /* 8A's report, whole and unchanged — the procurement section keeps
       working exactly as it did. */
    procurement: procurementReport,
    output,
    materials,
    /* The closed material classification, so the costing screen can show what
       was used and what was scrapped rather than only what was issued. */
    closeouts: closeouts.map((c) => ({
      workOrderId: idOf(c.workOrderId), revision: c.revision,
      closedAt: c.closedAt, closedByName: c.closedByName || "",
      acceptedGoodQty: num(c.output?.acceptedGoodQty),
      rejectedQty: num(c.output?.rejectedQty),
      materials: (c.materials || []).map((m) => ({
        rawItemId: idOf(m.rawItemId), variantId: idOf(m.variantId), itemName: m.itemName || "",
        unit: m.unit || "", netIssuedQty: num(m.netIssuedQty),
        usedQty: num(m.usedQty), scrapQty: num(m.scrapQty), remainingQty: num(m.remainingQty),
      })),
    })),
    labour,
    bridge,
    variance,
    margin,
    completeness,
    lineage: {
      customerRequests: customerRequests.map((r) => ({ id: idOf(r._id), number: r.requestId || "" })),
      workOrders: workOrders.attributed.map((w) => ({ id: idOf(w._id), number: w.workOrderNumber || "", status: w.status })),
      /* Kept visible rather than dropped: a work order this report could not
         attribute is evidence somebody may need to explain. */
      unlinkedWorkOrders: workOrders.unlinked.map((w) => ({
        id: idOf(w._id), number: w.workOrderNumber || "", status: w.status,
        reason: "Not attributed — its product identity does not match this costing's.",
      })),
      cancelledWorkOrders: workOrders.cancelled.map((w) => ({
        id: idOf(w._id), number: w.workOrderNumber || "", status: w.status,
        reason: "Cancelled. Excluded from every quantity and cost, kept as history.",
      })),
      issuanceCount: issuances.length,
    },
    /* The headline, and why it is what it is. */
    summary: {
      label: completeness.label,
      estimatedTotalMinor,
      knownTotalMinor: bridge.knownTotalMinor,
      knownFamilyCount: bridge.knownFamilyCount,
      missingFamilyCount: bridge.missingFamilies.length,
      actualUnitCostMinor,
      /* The FIRST real blocker's own words, so the sentence names what is
         actually missing today rather than repeating a fixed one that may
         no longer be the reason. */
      unitCostWithheldReason: actualUnitCostMinor === null
        ? (completeness.blockers[0]?.message || BLOCKER_TEXT.NO_GOOD_OUTPUT) : null,
      complete: completeness.complete,
    },
  };
}

module.exports = {
  reportFor,
  bridgeFrom, completenessOf, marginFrom, varianceFrom,
  selectWorkOrders, outputFrom, materialMovement, materialLine, labourFrom,
  BASIS, OUTPUT, BLOCKER, BLOCKER_TEXT, FAMILY,
  TITLE, STANDING, TAX_NOTE, MARGIN_LABEL, MARGIN_CAVEAT,
  procurement, CustomerRequest, WorkOrder, StockIssuance,
  present, idOf, num,
};
