// services/centralCosting/projectionHandoff.service.js
//
// FROM "THIS IS WHAT WE WILL NEED" TO "PLEASE START THE REQUEST FOR IT".
//
// ── WHAT THIS DOES, AND EXACTLY WHERE IT STOPS ──────────────────────────────
// It creates DRAFT spend requests. It does not approve spending, reserve
// budget, create a commitment, raise a purchase order or a service order,
// reserve stock, or contact a supplier. A draft is the beginning of the
// existing approval workflow, not a shortcut past it — everything that commits
// money still happens where it always did.
//
// ── THE BROWSER CHOOSES; IT DOES NOT DESCRIBE ───────────────────────────────
// A client may say WHICH approved version, WHICH scenario and WHICH
// requirements. It may not say what any of them are. Every quantity, unit,
// rate, amount, supplier, quotation, tax position, item identity and budget
// head is regenerated here from the frozen approved version — the same
// projection Chunk 7A renders — and a posted one is ignored rather than
// validated, because the shape a client sends is the thing under its control.
//
// ── AND NOTHING IS RE-DERIVED TWICE ─────────────────────────────────────────
// The projected purchase quantity IS the request quantity. Not the garment
// output quantity, not a consumption re-multiplied, not a conversion applied
// again, and not MOQ rounding reapplied over a figure that already carries it.
// A second derivation is a second answer, and the two differ the first time a
// rounding rule moves.

"use strict";

const mongoose = require("mongoose");

const projection = require("./procurementProjection.service");
const idempotency = require("../storePurchase/idempotency.service");
const budgetHead = require("../budgetAllocationVocabulary");
/* ── THE REQUESTS DOMAIN'S OWN DOOR ────────────────────────────────────────
   Central Costing does not own `SpendRequest` and no longer requires it. It
   chooses WHICH requirements to raise; the Requests domain creates, stamps and
   reads its own records. A costing that can write a request can, one refactor
   later, read one as a costing source — which is the loop the source-boundary
   guard exists to prevent, and why this is a boundary rather than a helper. */
const costingDemand = require("../requests/costingDemand.service");

const Employee = () => require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const SOURCE = "APPROVED_COSTING_PROJECTION";
const OPERATION = "costing.projection.requests";

/* Every refusal is a different thing to do about it. */
const CODES = Object.freeze({
  NOT_AVAILABLE: "HANDOFF_PROJECTION_UNAVAILABLE",
  VERSION_MISMATCH: "HANDOFF_VERSION_MISMATCH",
  NOTHING_SELECTED: "HANDOFF_NOTHING_SELECTED",
  UNKNOWN_REQUIREMENT: "HANDOFF_REQUIREMENT_NOT_IN_PROJECTION",
  BLOCKED_REQUIREMENT: "HANDOFF_REQUIREMENT_BLOCKED",
  ALREADY_REQUESTED: "HANDOFF_ALREADY_REQUESTED",
  NO_ACTOR: "HANDOFF_NO_STAFF_RECORD",
  NO_TRANSACTION: "HANDOFF_NOT_ATOMIC",
  DATE_REASON_REQUIRED: "HANDOFF_DATE_REASON_REQUIRED",
});

/* The one sentence a person must read before pressing the button. */
const STANDING =
  "Creating drafts starts the request workflow. It does not approve spending, "
  + "reserve budget, place an order or reserve stock.";

/* What Store may do with the supplier a costing used. Named carefully: it is
   what priced the estimate, not an appointment. Store sources as it always
   has, and may go elsewhere. */
const SUPPLIER_MEANING = "Supplier used in the approved cost estimate.";

/* Which request statuses mean the demand is still live. A cancelled or
   rejected request is history and does not block a fresh one. */
const ACTIVE_STATUSES = costingDemand.ACTIVE_STATUSES;

/* How a requirement's request state reads on the projection screen. */
const DEMAND_STATE = Object.freeze({
  NOT_REQUESTED: "Not requested",
  DRAFT: "Draft request",
  IN_APPROVAL: "Submitted/in approval",
  APPROVED: "Approved",
  ORDERED: "Ordered",
  CLOSED: "Cancelled/rejected",
});

function stateFor(status) {
  if (status === "draft") return DEMAND_STATE.DRAFT;
  if (status === "approved") return DEMAND_STATE.APPROVED;
  if (status === "ordered") return DEMAND_STATE.ORDERED;
  if (status === "rejected" || status === "cancelled") return DEMAND_STATE.CLOSED;
  return DEMAND_STATE.IN_APPROVAL;
}

/* The domain's own refusal, so the router's error handler renders it with the
   right status instead of treating it as an unhandled bug. The statuses live
   in `storePurchase/errors.js` beside every other code, rather than in a
   second table here that would drift out of step with it. */
const { fail } = require("../storePurchase/errors");

const present = (v) => v !== null && v !== undefined && v !== "";

/**
 * The projection's own handle for one requirement.
 *
 * Derived from the frozen line key and the kind, both of which the version
 * owns — never from a position in an array, which a later version could
 * reorder, and never from a name.
 */
const requirementIdOf = (req) => `${req.reference.lineKey}:${req.reference.kind}`;

/**
 * Which requirements of this version and scenario are already spoken for.
 *
 * ── FOUND BY STORED IDENTITY, NEVER BY NAME ─────────────────────────────────
 * Read from the `costingDemandSource` the handoff itself wrote. Matching on a
 * request title or an item name would find unrelated requests and miss renamed
 * ones, which is the same failure mode in both directions.
 */
async function existingDemandFor({ companyId, costingVersionId, scenarioKey }) {
  const rows = await costingDemand.demandForCostingVersion({
    companyId, costingVersionId, scenarioKey,
  });

  const byRequirement = new Map();
  for (const r of rows) {
    for (const line of r.items || []) {
      const src = line.costingDemandSource;
      if (!src?.costingLineKey) continue;
      const key = `${src.costingLineKey}:${r.requestType === "SERVICE" ? "SERVICE" : "PHYSICAL"}`;
      const entry = {
        requestId: String(r._id),
        requestNumber: r.requestNumber || "",
        requestType: r.requestType,
        status: r.status,
        state: stateFor(r.status),
        active: ACTIVE_STATUSES.includes(r.status),
        createdAt: r.createdAt || null,
      };
      /* ── HISTORY IS KEPT, NOT REPLACED ──────────────────────────────
         A cancelled request stays visible beside a live one. A screen that
         showed only the newest would make a rejected ask disappear, and the
         question "did we already try this?" is exactly what it answers. */
      if (!byRequirement.has(key)) byRequirement.set(key, []);
      byRequirement.get(key).push(entry);
    }
  }
  /* One key per FROZEN line, matched to the kind the request was raised as —
     a service line and a physical line never share a key even if a version
     ever reused one. */
  const alsoByLine = new Map();
  for (const [key, entries] of byRequirement) alsoByLine.set(key, entries);
  return alsoByLine;
}

/**
 * The projection, with each requirement's request history attached.
 *
 * This is what the review screen reads. It is a pure read: it creates nothing.
 */
async function prepare(ctx, { costingId, scenarioKey } = {}) {
  const projected = await projection.projectFor(ctx, { costingId, scenarioKey });
  if (!projected.available) {
    return { ...projected, standing: STANDING, supplierMeaning: SUPPLIER_MEANING };
  }

  const history = await existingDemandFor({
    companyId: ctx.companyId,
    costingVersionId: projected.version.costingVersionId,
    scenarioKey: projected.scenario.scenarioKey,
  });

  const requirements = projected.requirements.map((req) => {
    const id = requirementIdOf(req);
    const requests = history.get(id) || [];
    const active = requests.filter((r) => r.active);
    /* Blocked means the projection could not state a quantity or a value, so
       there is nothing to put on a request line. Never converted to zero. */
    const blocked = !req.quantity?.available || !req.money?.available;
    return {
      ...req,
      requirementId: id,
      requests,
      demandState: active.length ? active[0].state : (requests.length ? DEMAND_STATE.CLOSED : DEMAND_STATE.NOT_REQUESTED),
      alreadyRequested: active.length > 0,
      blocked,
      blockedReason: blocked
        ? (req.money?.reason || "This requirement has no purchase quantity, so it cannot be put on a request.")
        : null,
      /* Selectable, and deliberately NOT pre-selected. */
      selectable: !blocked && !active.length,
    };
  });

  const selectable = requirements.filter((r) => r.selectable);
  return {
    ...projected,
    requirements,
    standing: STANDING,
    supplierMeaning: SUPPLIER_MEANING,
    handoff: {
      /* Exactly how many drafts pressing the button would create — never one
         per supplier. */
      productCount: selectable.filter((r) => r.kind === "PHYSICAL").length,
      serviceCount: selectable.filter((r) => r.kind !== "PHYSICAL").length,
      blockedCount: requirements.filter((r) => r.blocked).length,
      alreadyRequestedCount: requirements.filter((r) => r.alreadyRequested).length,
    },
  };
}

/**
 * One request line, built entirely from the authoritative projection.
 *
 * ── THE QUANTITY IS THE PROJECTED ONE ───────────────────────────────────────
 * Taken as frozen. No re-multiplication, no re-conversion, no second rounding:
 * `orderQuantity` already carries the engine's rounding to the supplier's MOQ
 * and order multiple, and applying them again would round twice.
 */
function lineFrom(req, { requiredDate }) {
  const isPhysical = req.kind === "PHYSICAL";
  const quantityText = isPhysical ? req.quantity.orderQuantity : req.quantity.serviceQuantity;
  const unit = isPhysical ? req.quantity.purchaseUom : req.quantity.billingUnit;
  const quantity = Number(quantityText);
  /* Minor units to the major-unit figures the request model stores. Rounded
     to whole minor units first, so no float ever divides a rate. */
  const rate = present(req.supplier?.quotedRateMinor)
    ? Math.round(Number(req.supplier.quotedRateMinor)) / 100 : 0;
  /* The engine's own net for this line. `createSpendRequest` recomputes
     `amount` as quantity × rate by its own rule; this is what the costing
     projected, and both are kept. */
  const projectedAmountMinor = present(req.money?.expectedNetMinor)
    ? Math.round(Number(req.money.expectedNetMinor)) : null;

  const allocation = req.budget?.resolved ? {
    budgetLedgerId: req.budget.budgetLedgerId,
    budgetLedgerName: req.budget.budgetLedgerName || "",
    resolutionSource: req.budget.source || budgetHead.SOURCE_NONE,
    resolutionCategory: req.budget.category || "",
    status: budgetHead.STATUS_RESOLVED,
  } : {
    budgetLedgerId: null,
    budgetLedgerName: "",
    resolutionSource: budgetHead.SOURCE_NONE,
    resolutionCategory: req.budget?.category || "",
    /* ── AN UNRESOLVED HEAD IS SAVED, NOT DROPPED ──────────────────────
       Dropping the line would lose the demand; guessing a head would put an
       amount somewhere nobody chose. It is saved as unresolved and the
       screen says whose correction it is before submission. */
    status: budgetHead.STATUS_UNRESOLVED,
    resolutionReason: req.budget?.message || "",
  };

  return {
    name: req.identity?.name || req.reference.lineKey,
    whyNeeded: `Required by the approved costing for ${req.outputQuantity}${
      req.outputQuantityUom ? ` ${req.outputQuantityUom}` : ""}.`,
    spec: isPhysical
      ? [req.identity?.sku, req.identity?.variantLabel].filter(Boolean).join(" · ")
      : [req.identity?.serviceCode, req.identity?.sacCode].filter(Boolean).join(" · "),

    /* ── IDENTITY BY STORED ID, NEVER BY NAME ──────────────────────────── */
    ...(isPhysical ? {
      rawItem: req.reference.itemId || null,
      rawItemSku: req.identity?.sku || "",
      baseUnit: unit || "",
    } : {
      service: req.reference.serviceId || null,
      serviceCode: req.identity?.serviceCode || "",
      billingUnit: unit || "",
      sacCode: req.identity?.sacCode || "",
    }),

    quantity: Number.isFinite(quantity) ? quantity : 0,
    unit: unit || "unit",
    rate,
    /* Recomputed by the creation service; supplied so the shape is complete. */
    amount: Number.isFinite(quantity) ? Math.round(quantity * rate * 100) / 100 : 0,

    /* ── THE SUPPLIER IS EVIDENCE, NOT AN APPOINTMENT ──────────────────
       `suggestedVendorName` is the model's own field for "who the requester
       suggested — information, never an instruction". That is exactly what a
       costing's supplier is, so Store sources as it always has and may go
       elsewhere. It is deliberately NOT written to `vendorName`, which is
       the supplier Store itself chose. */
    suggestedVendorName: req.supplier?.supplierName || "",
    vendorId: req.supplier?.supplierId || undefined,
    quoteRef: req.supplier?.quotationReference
      ? `${req.supplier.quotationReference}${present(req.supplier.quotationRevision) ? ` rev ${req.supplier.quotationRevision}` : ""}`
      : "",
    vendorNote: SUPPLIER_MEANING,
    ...(requiredDate ? { expectedDeliveryDate: requiredDate } : {}),

    budgetAllocation: allocation,

    costingDemandSource: {
      source: SOURCE,
      costingId: req.reference.costingId,
      costingVersionId: req.reference.costingVersionId,
      costingVersionNumber: req.reference.versionNumber,
      scenarioKey: req.reference.scenarioKey,
      costingLineKey: req.reference.lineKey,
      projectionRequirementId: requirementIdOf(req),
      projectedAt: new Date(),
      projectedQuantity: String(quantityText ?? ""),
      projectedUnit: unit || "",
      projectedAmountMinor,
      currency: req.supplier?.currency || "INR",
    },
  };
}

/**
 * Create the draft requests for a selection.
 *
 * ── ONE ACTION, AT MOST TWO DRAFTS ──────────────────────────────────────────
 * A `SpendRequest` carries ONE `requestType`, so a mixed selection produces a
 * PRODUCT draft and a SERVICE draft — never one per supplier. A Product
 * request holding lines from three suppliers is correct and intended: the
 * costing priced them separately, and Store's own sourcing raises the separate
 * purchase orders later from the approved request, with each line keeping its
 * own supplier evidence.
 *
 * ── ALL OR NEITHER ──────────────────────────────────────────────────────────
 * The two drafts are one decision. Returning success having written only the
 * Product half would leave the service demand invisible while the screen said
 * it had been raised, so where a transaction cannot be guaranteed this refuses
 * BEFORE writing anything rather than half-succeeding.
 *
 * @param {{companyId, actorId}} ctx
 */
async function createDrafts(ctx, {
  costingId, costingVersionId, scenarioKey, requirementIds = [],
  purpose = "", requiredDate = null, requiredDateReason = "", idempotencyKey,
} = {}) {
  /* ── THE SERVER REGENERATES; IT DOES NOT READ THE BROWSER'S COPY ──────── */
  const prepared = await prepare(ctx, { costingId, scenarioKey });
  if (!prepared.available) {
    throw fail(CODES.NOT_AVAILABLE, prepared.message, { reason: prepared.reason });
  }

  /* The client names the version it was LOOKING at. If the approval has moved
     since, the selection describes a projection that no longer exists, and
     silently using the new one would raise requests for figures nobody saw. */
  if (present(costingVersionId)
      && String(costingVersionId) !== String(prepared.version.costingVersionId)) {
    throw fail(
      CODES.VERSION_MISMATCH,
      "The approved version changed while this was open. Reopen the projection and choose again.",
      { expected: prepared.version.costingVersionId, received: String(costingVersionId) },
    );
  }

  const wanted = [...new Set((requirementIds || []).map(String).filter(Boolean))];
  if (!wanted.length) {
    throw fail(CODES.NOTHING_SELECTED, "Choose at least one requirement to request.");
  }

  const byId = new Map(prepared.requirements.map((r) => [r.requirementId, r]));
  const selected = [];
  for (const id of wanted) {
    const req = byId.get(id);
    /* ── A SELECTION THAT NO LONGER EXISTS IS REFUSED ──────────────────
       Never substituted with the nearest line. If the version was recalculated
       and re-approved, the thing that was selected is gone and quietly
       requesting a different one is worse than refusing. */
    if (!req) {
      throw fail(CODES.UNKNOWN_REQUIREMENT,
        "One of the selected requirements is no longer in this approved projection. Reopen it and choose again.",
        { requirementId: id });
    }
    if (req.blocked) {
      throw fail(CODES.BLOCKED_REQUIREMENT, req.blockedReason, { requirementId: id });
    }
    if (req.alreadyRequested) {
      throw fail(CODES.ALREADY_REQUESTED,
        `${req.identity?.name || id} is already on an active request.`,
        { requirementId: id, requests: req.requests.filter((r) => r.active) });
    }
    selected.push(req);
  }

  /* ── A DIFFERENT REQUIRED DATE NEEDS A REASON ──────────────────────────
     The projection's date is the customer's, from Sales. Overwriting it
     silently would lose the fact that somebody disagreed with it. */
  const sourceDate = selected.find((r) => r.timing?.recorded)?.timing?.requiredBy || null;
  if (requiredDate && sourceDate
      && new Date(requiredDate).getTime() !== new Date(sourceDate).getTime()
      && !String(requiredDateReason || "").trim()) {
    throw fail(CODES.DATE_REASON_REQUIRED,
      "This costing already has a required date from Sales. Say why purchasing needs a different one.");
  }
  const neededBy = requiredDate ? new Date(requiredDate) : sourceDate;

  const emp = await Employee().findById(ctx.actorId)
    .select("_id firstName middleName lastName name email department biometricId").lean();
  if (!emp) {
    throw fail(CODES.NO_ACTOR,
      "Your sign-in is not linked to a staff record, so a request cannot be raised in your name.",
      {});
  }
  const company = await Acc_Company.findById(ctx.companyId).select("_id companyName").lean();
  const actorName = [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim()
    || emp.name || emp.email || "";

  /* ── AND THE TWO HALVES ARE NEVER MIXED ────────────────────────────────
     One `requestType` per request, decided by what the requirement IS. A
     service on a Product request would reach Store as something to put on a
     shelf. */
  const physical = selected.filter((r) => r.kind === "PHYSICAL");
  const services = selected.filter((r) => r.kind !== "PHYSICAL");

  const summary = {
    source: SOURCE,
    costingId: prepared.costing.costingId,
    costingVersionId: prepared.version.costingVersionId,
    costingVersionNumber: prepared.version.versionNumber,
    scenarioKey: prepared.scenario.scenarioKey,
    handoffKey: String(idempotencyKey || ""),
    /* Both dates survive, with the reason if they differ. */
    sourceRequiredDate: sourceDate || null,
    requestedRequiredDate: neededBy || null,
    requiredDateReason: String(requiredDateReason || "").slice(0, 500),
    createdAt: new Date(),
  };
  const label = prepared.costing.label || "costing";
  const reason = String(purpose || "").trim()
    || `Raised from the approved costing for ${label} at ${prepared.scenario.outputQuantity}${
      prepared.scenario.outputQuantityUom ? ` ${prepared.scenario.outputQuantityUom}` : ""}.`;

  const plan = [];
  if (physical.length) plan.push({ requestType: "PRODUCT", rows: physical });
  if (services.length) plan.push({ requestType: "SERVICE", rows: services });

  /* ── REFUSE BEFORE WRITING, RATHER THAN HALF-SUCCEED ───────────────────
     Only when BOTH would be written. A single draft is atomic by itself, and
     where two are needed the Requests domain writes them inside one session —
     this refusal is what happens on a deployment that cannot give one. */
  if (plan.length > 1 && !(await costingDemand.canCreateTogether())) {
    throw fail(CODES.NO_TRANSACTION,
      "Both drafts must be created together and this deployment cannot guarantee that. "
      + "Request the physical items and the services separately.",
      {});
  }

  /* Every commercial fact is regenerated above; what crosses the boundary is
     the finished lines and the provenance stamp. */
  const created = await costingDemand.createDraftsFromCosting(ctx, {
    parts: plan.map((part) => {
      const lines = part.rows.map((r) => lineFrom(r, { requiredDate: neededBy }));
      return {
        requestType: part.requestType,
        title: `${label} — ${part.requestType === "SERVICE" ? "outside services" : "materials"}`,
        lines,
        totalAmount: Math.round(lines.reduce((t, l) => t + (Number(l.amount) || 0), 0) * 100) / 100,
      };
    }),
    costingSource: summary,
    emp, actorName, company,
    purpose: reason,
    neededBy,
    historyNote: `Raised from the approved costing (version ${summary.costingVersionNumber}, ${summary.scenarioKey}).`,
  });

  return {
    mode: "CREATED",
    standing: STANDING,
    drafts: created,
    productRequest: created.find((c) => c.requestType === "PRODUCT") || null,
    serviceRequest: created.find((c) => c.requestType === "SERVICE") || null,
    selectedRequirementCount: selected.length,
    blockedRequirementCount: prepared.handoff.blockedCount,
    costingVersionId: summary.costingVersionId,
    scenarioKey: summary.scenarioKey,
  };
}

/**
 * The idempotent door.
 *
 * Reuses the established record: the unique index decides, an identical retry
 * REPLAYS the stored answer, and the same key with a different selection is a
 * conflict rather than a second set of drafts.
 */
async function handoff(ctx, args = {}) {
  const { outcome, record, response } = await idempotency.begin({
    ctx,
    operation: OPERATION,
    key: args.idempotencyKey,
    body: {
      costingId: String(args.costingId || ""),
      costingVersionId: String(args.costingVersionId || ""),
      scenarioKey: String(args.scenarioKey || ""),
      /* Sorted, so the same selection in a different order is the same
         selection rather than a conflict. */
      requirementIds: [...new Set((args.requirementIds || []).map(String))].sort(),
      requiredDate: args.requiredDate ? new Date(args.requiredDate).toISOString() : "",
    },
    target: { costingId: String(args.costingId || "") },
  });

  if (outcome === "REPLAY") {
    /* `begin` hands back `{ status, responseBody }` — the stored answer is
       inside `body`, not spread across the envelope. The SAME request ids
       come back, never a second pair. */
    return { ...(response?.body || {}), mode: "RECOVERED" };
  }

  try {
    const result = await createDrafts(ctx, args);
    await idempotency.complete({ record, status: 201, body: result, entityType: "SpendRequest" });
    return result;
  } catch (err) {
    /* A refusal must not become a replayable success. */
    await idempotency.abandon({ record, reason: err.message });
    throw err;
  }
}

module.exports = {
  createDrafts, handoff,
  CODES, SOURCE, OPERATION, STANDING, SUPPLIER_MEANING,
  ACTIVE_STATUSES, DEMAND_STATE, stateFor, requirementIdOf,
  existingDemandFor, prepare, lineFrom, fail,
};
