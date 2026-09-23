// services/centralCosting/procurementProjection.service.js
//
// WHAT AN APPROVED COSTING IS EXPECTED TO REQUIRE FROM OUTSIDE THE COMPANY.
//
// ── A FORECAST, AND NOTHING ELSE ────────────────────────────────────────────
// Nothing here writes. No requisition, no MRF, no commitment, no reservation,
// no purchase order, no supplier contact, and no change to the costing. It
// reads one frozen approved version and says what it implies. Chunk 7B will
// turn selected lines into real requests; this pass exists so that the
// conversation about what to buy happens before anything is bought.
//
// ── AND IT IS DERIVED FROM THE FROZEN RECORD, NOT FROM TODAY ────────────────
// Not the newest working version — the APPROVED one, which may be several
// behind it. Not today's supplier offers — the quotation each line was
// actually costed from, at the revision it was costed at, even if that
// quotation has since expired or been replaced. A projection that quietly
// repriced itself would answer a different question from the one the approval
// was given for, and the difference would be invisible.
//
// The source's CURRENT standing is reported separately and never written back:
// "this line was costed from quotation Q-14 rev 2, which has since expired" is
// two facts, and merging them destroys the first.
//
// ── WHAT MAKES A COST LINE A PURCHASE ───────────────────────────────────────
// One test, applied everywhere: frozen evidence naming an EXTERNAL SUPPLIER.
// A category alone is not enough — a development charge the company sets by
// policy sits in the same category as one bought from a tooling shop, and only
// the second is procurement. Internal labour, overhead, financing, the
// income-tax estimate and the margin are never procurement however they are
// categorised, because nobody buys them from anybody.

"use strict";

const itemBudgetHead = require("../itemBudgetHead.service");

/* What kind of thing has to be obtained. A service is NOT an item: it has its
   own master, its own register, a billing unit with no conversion and a
   minimum charge that floors the line rather than the quantity. Collapsing the
   two would put a service on a stock ledger. */
const KIND = Object.freeze({
  PHYSICAL: "PHYSICAL",
  SERVICE: "SERVICE",
  FREIGHT: "FREIGHT",
});

/* Categories that CAN be procurement, by kind. Membership here is necessary
   and not sufficient — see `SUPPLIER EVIDENCE` below. */
const PHYSICAL_CATEGORIES = Object.freeze(["MATERIAL", "PACKAGING"]);
const SERVICE_CATEGORIES = Object.freeze(["SERVICE"]);
const FREIGHT_CATEGORIES = Object.freeze(["FREIGHT"]);
/* Externally purchased development or tooling. Only ever procurement with a
   supplier behind it; the company's own published development charge is a
   policy figure and is excluded by the same rule that excludes overhead. */
const CONDITIONAL_CATEGORIES = Object.freeze(["FIXED_SETUP", "MISC"]);

/* Why a family is not a purchase. Said out loud, because the gap between the
   product cost and the expected procurement value is otherwise unexplained
   and reads as an error. */
const NOT_PROCUREMENT = Object.freeze({
  OPERATION: "Internal labour and operations — done by this company's own people, not bought.",
  OVERHEAD: "Allocated company and factory overhead — an internal allocation, not a purchase.",
  FINANCING: "Financing cost — the cost of money, not a supplier requirement.",
  WASTAGE: "Wastage allowance — already carried inside the material requirement it belongs to.",
  DUTY: "Customs duty and levies — paid to an authority, not ordered from a supplier.",
  NON_RECOVERABLE_TAX: "Non-recoverable tax — added to the cost of the lines it sits on, not bought separately.",
  FIXED_SETUP: "A setup or development charge with no external supplier — set by company policy.",
  MISC: "A cost with no external supplier recorded against it.",
});

/* Every reason a requirement cannot be fully stated. Each names a different
   desk, because "someone should fix this" is not an action. */
const ISSUE = Object.freeze({
  NO_CONVERSION: "NO_CONVERSION",
  NO_PURCHASE_QUANTITY: "NO_PURCHASE_QUANTITY",
  BUDGET_UNRESOLVED: "BUDGET_UNRESOLVED",
  TIMING_UNRECORDED: "TIMING_UNRECORDED",
  SOURCE_EXPIRED: "SOURCE_EXPIRED",
  SOURCE_SUPERSEDED: "SOURCE_SUPERSEDED",
  SOURCE_UNCHECKED: "SOURCE_UNCHECKED",
});

const ISSUE_TEXT = Object.freeze({
  NO_CONVERSION: {
    message: "Purchase quantity unavailable — unit conversion was not frozen.",
    owner: "Store & Purchase",
  },
  NO_PURCHASE_QUANTITY: {
    message: "Purchase quantity unavailable — this version did not freeze one for this quantity.",
    owner: "Store & Purchase",
  },
  BUDGET_UNRESOLVED: { message: "No budget head resolves for this requirement.", owner: "Finance" },
  TIMING_UNRECORDED: { message: "No required date is recorded, so no month can be stated.", owner: "Sales" },
  SOURCE_EXPIRED: { message: "The quotation this was costed from has since passed its validity.", owner: "Store & Purchase" },
  SOURCE_SUPERSEDED: { message: "A newer revision of this quotation exists.", owner: "Store & Purchase" },
  SOURCE_UNCHECKED: { message: "The current standing of this quotation could not be checked.", owner: "Store & Purchase" },
});

/* The four answers about a frozen source's standing TODAY. Reported beside the
   projection and never merged into it. */
const SOURCE_STATUS = Object.freeze({
  CURRENT: "CURRENT",
  SUPERSEDED: "SUPERSEDED",
  EXPIRED: "EXPIRED",
  UNCHECKED: "UNCHECKED",
});

const present = (v) => v !== null && v !== undefined && v !== "";
const idOf = (v) => (v === null || v === undefined ? null : String(v));

/**
 * The scenario row a provenance entry froze for THIS quantity.
 *
 * Versions written before per-scenario freezing carry none; for those the
 * line-level figures applied to every scenario, and that is what is read.
 * Absence is never treated as zero.
 */
function frozenScenarioOf(prov, scenarioKey) {
  const rows = prov?.scenarios;
  if (Array.isArray(rows) && rows.length) {
    return rows.find((r) => r.scenarioKey === scenarioKey) || null;
  }
  return null;
}

/**
 * How much has to be bought, in the unit it is bought in.
 *
 * ── NEVER DERIVED HERE ──────────────────────────────────────────────────────
 * The purchase quantity is the engine's, frozen at approval, in the supplier's
 * own unit. This module does not multiply a consumption by an output quantity
 * and it does not apply a conversion factor: doing either would produce a
 * second answer to a question the approved version already answered, and the
 * two would differ the first time a rounding rule moved.
 *
 * When no purchase quantity was frozen, the quantity AND the money are both
 * reported unavailable. Multiplying a consumption figure by a purchase rate
 * across an unfrozen conversion is how metres get charged as kilograms.
 */
function physicalQuantity(prov, row, line) {
  const purchaseQuantity = present(row?.purchaseQuantity) ? String(row.purchaseQuantity)
    : (present(prov?.appliedPurchaseQuantity) ? String(prov.appliedPurchaseQuantity) : null);
  const purchaseUom = present(row?.purchaseUom) ? row.purchaseUom : (prov?.purchaseUom || null);
  const consumptionUom = prov?.consumptionUom || line?.quantityUom || null;
  const conversionFactor = present(row?.conversionFactor) ? String(row.conversionFactor)
    : (present(prov?.conversionFactor) ? String(prov.conversionFactor) : null);

  /* A conversion is only MISSING when the two units actually differ. A line
     bought and consumed in the same unit needs none, and demanding one would
     report a complete requirement as broken. */
  const unitsDiffer = present(purchaseUom) && present(consumptionUom)
    && String(purchaseUom).toLowerCase() !== String(consumptionUom).toLowerCase();
  const conversionMissing = unitsDiffer && !present(conversionFactor);

  return {
    consumptionPerUnit: present(prov?.quantityPerUnit) ? String(prov.quantityPerUnit)
      : (present(line?.quantityPerUnit) ? String(line.quantityPerUnit) : null),
    consumptionUom,
    purchaseQuantity: conversionMissing ? null : purchaseQuantity,
    purchaseUom,
    conversionFactor,
    conversionPath: prov?.conversionPath || null,
    /* Frozen supplier terms. Null is "not recorded" — never 1, which would
       read as a recorded absence of any constraint. */
    moq: present(prov?.moq) ? Number(prov.moq) : null,
    orderMultiple: present(prov?.orderMultiple) ? Number(prov.orderMultiple) : null,
    /* ── WHAT WOULD ACTUALLY BE ORDERED ────────────────────────────────
       The frozen purchase quantity already carries the engine's rounding to
       the supplier's terms — `appliedPurchaseQuantity` IS the applied one.
       Rounding it again here would round twice. */
    orderQuantity: conversionMissing ? null : purchaseQuantity,
    available: !conversionMissing && present(purchaseQuantity),
    conversionMissing,
  };
}

/** A service quantity is a billing quantity. There is no conversion to make. */
function serviceQuantity(prov, row) {
  const quantity = present(row?.serviceQuantity) ? String(row.serviceQuantity)
    : (present(prov?.appliedServiceQuantity) ? String(prov.appliedServiceQuantity) : null);
  return {
    serviceQuantity: quantity,
    billingUnit: present(row?.billingUnit) ? row.billingUnit : (prov?.billingUnit || null),
    requestedUnit: prov?.requestedUnit || null,
    minimumChargeMinor: present(prov?.minimumChargeMinor) ? Number(prov.minimumChargeMinor) : null,
    minimumChargeApplied: Boolean(row?.minimumChargeApplied ?? prov?.minimumChargeApplied),
    available: present(quantity),
    conversionMissing: false,
  };
}

/**
 * What this requirement is expected to cost, and what of that is tax.
 *
 * Every figure is read from the frozen result — `totalMinor` is the engine's
 * own net for this line at this quantity, and `taxMinor` is the non-recoverable
 * part it already included. Recoverable GST is reported SEPARATELY and is
 * never added to the expected value: the company gets it back, so it is a cash
 * requirement rather than a cost.
 */
function moneyFor({ result, row, quantityAvailable }) {
  if (!quantityAvailable || !result) {
    return {
      available: false,
      expectedNetMinor: null,
      nonRecoverableTaxMinor: null,
      recoverableTaxMinor: null,
      grossCashMinor: null,
      reason: "Expected value unavailable — the purchase quantity could not be stated.",
    };
  }
  const net = present(result.totalMinor) ? Number(result.totalMinor) : null;
  const nonRecoverable = present(result.taxMinor) ? Number(result.taxMinor) : null;

  /* Recoverable tax is only stated where the frozen evidence says the
     treatment was recoverable AND recorded an amount. A rate without an
     amount is not an amount. */
  const treatment = String(row?.taxTreatment || "").toUpperCase();
  const recoverable = treatment.includes("RECOVERABLE") && !treatment.startsWith("NON")
    && present(row?.gstAmountMinor) ? Number(row.gstAmountMinor) : null;

  return {
    available: net !== null,
    /* The cost figure: recoverable tax is NOT in it. */
    expectedNetMinor: net,
    nonRecoverableTaxMinor: nonRecoverable,
    recoverableTaxMinor: recoverable,
    /* ── ONLY WHERE IT CAN BE STATED HONESTLY ──────────────────────────
        Net plus the tax that has to be funded. Null rather than equal to the
        net when the recoverable part was never recorded, because "no
        recoverable tax" and "nobody wrote it down" are different. */
    grossCashMinor: net !== null && recoverable !== null ? net + recoverable : null,
    reason: null,
  };
}

/** The frozen commercial evidence, read as written. */
function supplierEvidence(prov, row, asOfDate) {
  const validUntil = prov?.validUntil || null;
  let status = SOURCE_STATUS.UNCHECKED;
  if (validUntil instanceof Date || typeof validUntil === "string") {
    const until = new Date(validUntil);
    if (!Number.isNaN(until.getTime()) && asOfDate) {
      status = until.getTime() >= asOfDate.getTime() ? SOURCE_STATUS.CURRENT : SOURCE_STATUS.EXPIRED;
    }
  }
  return {
    supplierId: idOf(prov?.supplierId),
    supplierName: prov?.supplierName || "",
    quotationReference: prov?.quotationReference || "",
    quotationRevision: present(prov?.offerRevision) ? Number(prov.offerRevision) : null,
    quotationDate: prov?.quotationDate || null,
    validUntil,
    /* The tier this quantity actually reached, in the supplier's own unit. */
    tier: {
      minQuantity: present(row?.tierMinQuantity) ? Number(row.tierMinQuantity)
        : (present(prov?.tierMinQuantity) ? Number(prov.tierMinQuantity) : null),
      maxQuantity: present(row?.tierMaxQuantity) ? Number(row.tierMaxQuantity)
        : (present(prov?.tierMaxQuantity) ? Number(prov.tierMaxQuantity) : null),
      priceSource: row?.priceSource || prov?.priceSource || null,
    },
    quotedRateMinor: present(row?.netRateMinor) ? Number(row.netRateMinor)
      : (present(prov?.netRateMinor) ? Number(prov.netRateMinor) : null),
    priceBasis: prov?.priceBasis || null,
    currency: prov?.currency || null,
    /* Reported, never acted on: a source that has moved does not rewrite one
       figure of this projection. */
    status,
  };
}

/**
 * One requirement, fully stated.
 *
 * `reference` is the stable handle Chunk 7B will convert into a real request.
 * It is ids only and carries nothing a screen should lead with.
 */
function requirementFrom({ costing, version, scenario, line, result, prov, kind, asOfDate }) {
  const row = frozenScenarioOf(prov, scenario.key);
  const quantity = kind === KIND.PHYSICAL
    ? physicalQuantity(prov, row, line)
    : serviceQuantity(prov, row);
  const money = moneyFor({ result, row, quantityAvailable: quantity.available });

  const issues = [];
  if (quantity.conversionMissing) issues.push(ISSUE.NO_CONVERSION);
  else if (!quantity.available) issues.push(ISSUE.NO_PURCHASE_QUANTITY);

  const evidence = supplierEvidence(prov, row, asOfDate);
  if (evidence.status === SOURCE_STATUS.EXPIRED) issues.push(ISSUE.SOURCE_EXPIRED);
  if (evidence.status === SOURCE_STATUS.UNCHECKED) issues.push(ISSUE.SOURCE_UNCHECKED);

  return {
    /* ── THE STABLE HANDOFF IDENTITY (Chunk 7B) ────────────────────────
       Everything needed to raise a request against this exact requirement
       later, and to prove afterwards which approved costing it came from. */
    reference: {
      costingId: idOf(costing._id),
      costingVersionId: idOf(version._id),
      versionNumber: version.versionNumber ?? null,
      scenarioKey: scenario.key,
      lineKey: line.lineKey,
      kind,
      itemId: idOf(prov?.itemId),
      variantId: idOf(prov?.variantId),
      serviceId: idOf(prov?.serviceId),
    },
    kind,
    /* Readable after the masters move on — the names were frozen for exactly
       this reason. */
    identity: kind === KIND.PHYSICAL ? {
      name: prov?.itemName || line.label || "",
      sku: prov?.itemSku || "",
      variantLabel: prov?.variantLabel || "",
      variantSku: prov?.variantSku || "",
      supplierItemCode: prov?.supplierItemCode || "",
      hsnCode: prov?.hsnCode || "",
      category: line.category,
    } : {
      name: prov?.serviceName || line.label || "",
      serviceCode: prov?.serviceCode || "",
      supplierServiceCode: prov?.supplierServiceCode || "",
      sacCode: prov?.sacCode || "",
      category: line.category,
    },
    outputQuantity: present(row?.outputQuantity) ? String(row.outputQuantity) : String(scenario.quantity),
    outputQuantityUom: scenario.quantityUom || null,
    quantity,
    supplier: evidence,
    money,
    /* Filled in by the caller, which is where the company-scoped masters and
       the enquiry are read. */
    budget: null,
    timing: null,
    issues,
  };
}

/**
 * Every cost family that is NOT a purchase, with the reason.
 *
 * Built from what the scenario actually contains rather than from a fixed
 * list, so a category the version never used is not explained away as though
 * it had been considered.
 */
function notProcurementFrom(scenario, procuredLineKeys) {
  const out = [];
  const seen = new Set();
  for (const result of scenario.lines || []) {
    if (procuredLineKeys.has(result.lineKey)) continue;
    const reason = NOT_PROCUREMENT[result.category];
    const key = result.category;
    if (!reason) continue;
    if (seen.has(key)) {
      const existing = out.find((o) => o.category === key);
      if (existing && present(result.totalMinor)) {
        existing.totalMinor = (existing.totalMinor || 0) + Number(result.totalMinor);
        existing.lineCount += 1;
      }
      continue;
    }
    seen.add(key);
    out.push({
      category: key,
      reason,
      totalMinor: present(result.totalMinor) ? Number(result.totalMinor) : null,
      lineCount: 1,
    });
  }
  return out;
}

/**
 * Whether two requirements may be added together.
 *
 * ── THE DEFAULT IS NO ────────────────────────────────────────────────────────
 * Aggregation is where a projection quietly becomes wrong: two metres of
 * different fabrics, a service and an item, or the same item from two
 * suppliers at two prices all add up to a number that describes nothing. Every
 * dimension below has to match, and where they do not the rows stay apart with
 * the reason attached.
 */
function aggregationKey(req) {
  if (req.kind === KIND.PHYSICAL) {
    return [
      "P",
      req.reference.itemId || `label:${req.identity.name}`,
      /* A variant is part of the identity, not a detail of it. */
      req.reference.variantId || "novariant",
      req.supplier.supplierId || "nosupplier",
      String(req.quantity.purchaseUom || "").toLowerCase(),
      req.supplier.status,
    ].join("|");
  }
  return [
    req.kind,
    req.reference.serviceId || `label:${req.identity.name}`,
    req.supplier.supplierId || "nosupplier",
    String(req.quantity.billingUnit || "").toLowerCase(),
    req.supplier.status,
  ].join("|");
}

/** Why two superficially similar requirements were kept apart. */
function separationReason(a, b) {
  if (a.kind !== b.kind) return "A service and a physical item are different requirements.";
  if ((a.reference.variantId || "") !== (b.reference.variantId || "")) return "Different variants.";
  if ((a.supplier.supplierId || "") !== (b.supplier.supplierId || "")) return "Priced by different suppliers.";
  const ua = a.kind === KIND.PHYSICAL ? a.quantity.purchaseUom : a.quantity.billingUnit;
  const ub = b.kind === KIND.PHYSICAL ? b.quantity.purchaseUom : b.quantity.billingUnit;
  if (String(ua || "").toLowerCase() !== String(ub || "").toLowerCase()) return "Different purchase units.";
  if (a.supplier.status !== b.supplier.status) return "Different quotation validity periods.";
  return "Not comparable.";
}

module.exports = {
  KIND, ISSUE, ISSUE_TEXT, SOURCE_STATUS, NOT_PROCUREMENT,
  PHYSICAL_CATEGORIES, SERVICE_CATEGORIES, FREIGHT_CATEGORIES, CONDITIONAL_CATEGORIES,
  frozenScenarioOf, physicalQuantity, serviceQuantity, moneyFor, supplierEvidence,
  requirementFrom, notProcurementFrom, aggregationKey, separationReason,
  itemBudgetHead,
};

/* ══ THE PROJECTION ITSELF ══════════════════════════════════════════════════
 *
 * Everything above is pure. This is where the company-scoped records are read:
 * the costing, its APPROVED version, the item and service masters the budget
 * rules need, and the enquiry that knows when the customer wants the goods.
 * ═════════════════════════════════════════════════════════════════════════ */

const mongoose = require("mongoose");

const Costing = () => require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = () => require("../../models/CMS_Models/Costing/CostingVersion");
const RawItem = () => require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = () => require("../../models/CMS_Models/Inventory/Services/Service");
const Enquiry = () => require("../../models/CMS_Models/Sales/Enquiry");

const UNAVAILABLE = Object.freeze({
  NO_COSTING: "NO_COSTING",
  NO_APPROVED_VERSION: "NO_APPROVED_VERSION",
  NO_SCENARIO: "NO_SCENARIO",
});

const UNAVAILABLE_TEXT = Object.freeze({
  NO_COSTING: "This costing could not be read.",
  NO_APPROVED_VERSION:
    "Procurement projection is not available yet: no version of this costing has been approved. "
    + "A projection is derived from an approved version, never from work in progress.",
  NO_SCENARIO: "That quantity is not one this approved version was costed for.",
});

/**
 * Which kind of procurement a line is — or none.
 *
 * ── SUPPLIER EVIDENCE IS THE TEST ───────────────────────────────────────────
 * A category says what a cost IS; only the frozen provenance says whether
 * somebody outside the company supplies it. A development charge the company
 * publishes by policy and one bought from a tooling shop share a category, and
 * only the second can be ordered. So a line becomes a requirement when its
 * frozen evidence names a supplier — and never on category alone.
 */
function kindOf(line, prov) {
  if (!prov) return null;
  const hasSupplier = present(prov.supplierId) || present(prov.serviceId) || present(prov.itemId);
  if (!hasSupplier) return null;
  const category = line.category;
  if (PHYSICAL_CATEGORIES.includes(category)) return KIND.PHYSICAL;
  if (SERVICE_CATEGORIES.includes(category)) return KIND.SERVICE;
  if (FREIGHT_CATEGORIES.includes(category)) return KIND.FREIGHT;
  if (CONDITIONAL_CATEGORIES.includes(category)) {
    /* Externally purchased only. A policy charge has no supplier behind it. */
    if (!present(prov.supplierId)) return null;
    return present(prov.serviceId) ? KIND.SERVICE : KIND.PHYSICAL;
  }
  /* OPERATION, OVERHEAD, FINANCING, WASTAGE, DUTY, NON_RECOVERABLE_TAX are
     never procurement, whatever provenance happens to sit beside them. */
  return null;
}

/**
 * The month this requirement is expected in.
 *
 * ── FROM AN AUTHORITATIVE SALES FIELD, OR NOT AT ALL ────────────────────────
 * `Enquiry.requirementDeadline` is what the customer asked for. `createdAt` is
 * when somebody opened a record, which is not a delivery date and would put
 * every requirement in the month the costing happened to be raised — a number
 * that looks like a plan and is not one.
 *
 * With no reliable date the line goes to "Timing not recorded", stays OUT of
 * every month total, and names Sales as the desk that has the answer.
 */
async function timingFor(costing, ctx) {
  const none = {
    month: null, monthLabel: null, source: null, recorded: false,
    requiredBy: null, owner: ISSUE_TEXT.TIMING_UNRECORDED.owner,
    message: ISSUE_TEXT.TIMING_UNRECORDED.message,
  };
  try {
    if (costing?.context?.type !== "ENQUIRY_STYLE" || !costing.context.primaryId) return none;
    /* Company-scoped, though the id came from a costing this company owns.
       The scope is not load-bearing here — it is the convention, and code
       that relies on an id "already having been proved" is code somebody has
       to reason about later. */
    const enquiry = await Enquiry().findOne({
      _id: costing.context.primaryId, companyId: ctx.companyId,
    }).select("requirementDeadline").lean();
    const when = enquiry?.requirementDeadline ? new Date(enquiry.requirementDeadline) : null;
    if (!when || Number.isNaN(when.getTime())) return none;
    const month = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
    return {
      month,
      monthLabel: when.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
      source: "ENQUIRY_REQUIREMENT_DEADLINE",
      recorded: true,
      requiredBy: when,
      owner: null,
      message: null,
    };
  } catch (err) {
    return none;
  }
}

/**
 * The budget head each requirement would affect.
 *
 * Reuses the company's existing rules verbatim — item override, then item
 * category mapping, then unresolved; a service uses its own explicit head and
 * NEVER an item-category mapping. Re-implementing either would be a second
 * answer to a question Finance has already settled.
 */
async function budgetsFor(requirements, companyId) {
  const itemIds = [...new Set(requirements
    .filter((r) => r.kind === KIND.PHYSICAL && r.reference.itemId)
    .map((r) => r.reference.itemId))];
  const serviceIds = [...new Set(requirements
    .filter((r) => r.kind !== KIND.PHYSICAL && r.reference.serviceId)
    .map((r) => r.reference.serviceId))];

  const [items, services] = await Promise.all([
    itemIds.length
      ? itemBudgetHead.resolveItemIds({ itemIds, companyId, RawItem: RawItem() }).catch(() => [])
      : [],
    serviceIds.length
      ? itemBudgetHead.resolveServiceIds({ serviceIds, companyId, Service: Service() }).catch(() => [])
      : [],
  ]);

  const byItem = new Map(items.map((r) => [String(r.itemId ?? r._id ?? r.id), r]));
  const byService = new Map(services.map((r) => [String(r.serviceId ?? r._id ?? r.id), r]));

  for (const req of requirements) {
    const row = req.kind === KIND.PHYSICAL
      ? byItem.get(String(req.reference.itemId))
      : byService.get(String(req.reference.serviceId));
    const resolution = row?.resolution || row || null;
    const ledgerId = resolution?.budgetLedgerId ? String(resolution.budgetLedgerId) : null;
    req.budget = {
      budgetLedgerId: ledgerId,
      budgetLedgerName: resolution?.budgetLedgerName || null,
      /* WHY it resolved that way, so a wrong head can be corrected at source
         rather than argued about. */
      source: resolution?.source || null,
      category: resolution?.category || null,
      message: resolution?.message || null,
      resolved: Boolean(ledgerId),
      /* Whose correction it is. An unmapped category is Finance's decision;
         an uncategorised item is the Store's data. */
      owner: ledgerId ? null : (req.kind === KIND.PHYSICAL ? "Store & Purchase / Finance" : "Finance"),
    };
    if (!ledgerId) req.issues.push(ISSUE.BUDGET_UNRESOLVED);
  }
  return requirements;
}

/** Totals, grouped only where grouping is safe. */
function summarise(requirements, notProcurement, timing) {
  const sum = (rows, pick) => rows.reduce((t, r) => {
    const v = pick(r);
    return present(v) ? t + Number(v) : t;
  }, 0);

  const valued = requirements.filter((r) => r.money.available);
  const physical = requirements.filter((r) => r.kind === KIND.PHYSICAL);
  const services = requirements.filter((r) => r.kind !== KIND.PHYSICAL);
  const mapped = valued.filter((r) => r.budget?.resolved);
  const unmapped = valued.filter((r) => !r.budget?.resolved);

  /* ── BY BUDGET HEAD, WITH THE UNMAPPED KEPT OUT ────────────────────────
     Never a default head. An amount placed in one nobody chose is an amount
     nobody re-checks. */
  const heads = new Map();
  for (const r of mapped) {
    const key = r.budget.budgetLedgerId;
    if (!heads.has(key)) {
      heads.set(key, {
        budgetLedgerId: key, budgetLedgerName: r.budget.budgetLedgerName,
        projectedMinor: 0, requirementCount: 0,
      });
    }
    const h = heads.get(key);
    h.projectedMinor += Number(r.money.expectedNetMinor);
    h.requirementCount += 1;
  }

  /* ── BY SUPPLIER ───────────────────────────────────────────────────── */
  const suppliers = new Map();
  for (const r of valued) {
    const key = r.supplier.supplierId || `unnamed:${r.supplier.supplierName || "?"}`;
    if (!suppliers.has(key)) {
      suppliers.set(key, {
        supplierId: r.supplier.supplierId, supplierName: r.supplier.supplierName || "",
        projectedMinor: 0, requirementCount: 0, statuses: new Set(),
      });
    }
    const s = suppliers.get(key);
    s.projectedMinor += Number(r.money.expectedNetMinor);
    s.requirementCount += 1;
    s.statuses.add(r.supplier.status);
  }

  /* ── BY MONTH, AND ONLY WHERE A MONTH IS RECORDED ──────────────────── */
  const months = new Map();
  let untimedMinor = 0;
  let untimedCount = 0;
  for (const r of valued) {
    if (!r.timing?.recorded) {
      untimedMinor += Number(r.money.expectedNetMinor);
      untimedCount += 1;
      continue;
    }
    const key = r.timing.month;
    if (!months.has(key)) {
      months.set(key, { month: key, monthLabel: r.timing.monthLabel, projectedMinor: 0, requirementCount: 0 });
    }
    const m = months.get(key);
    m.projectedMinor += Number(r.money.expectedNetMinor);
    m.requirementCount += 1;
  }

  return {
    physicalCount: physical.length,
    serviceCount: services.length,
    /* Requirements whose value could not be stated are counted, never valued
       at zero. */
    unvaluedCount: requirements.length - valued.length,
    expectedProcurementValueMinor: sum(valued, (r) => r.money.expectedNetMinor),
    nonRecoverableTaxMinor: sum(valued, (r) => r.money.nonRecoverableTaxMinor),
    /* Funded and reclaimed — reported apart from the cost, never inside it. */
    recoverableTaxMinor: sum(valued, (r) => r.money.recoverableTaxMinor),
    mappedBudgetValueMinor: sum(mapped, (r) => r.money.expectedNetMinor),
    budgetMappingRequiredMinor: sum(unmapped, (r) => r.money.expectedNetMinor),
    budgetMappingRequiredCount: requirements.filter((r) => !r.budget?.resolved).length,
    timingNotRecordedMinor: untimedMinor,
    timingNotRecordedCount: requirements.filter((r) => !r.timing?.recorded).length,
    sourceAttentionCount: requirements.filter((r) => r.supplier.status !== SOURCE_STATUS.CURRENT).length,
    byBudgetHead: [...heads.values()],
    bySupplier: [...suppliers.values()].map((s) => ({ ...s, statuses: [...s.statuses] })),
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    notProcurement,
    timingSource: timing.source,
  };
}

/**
 * Group requirements only where every dimension agrees.
 *
 * Where two rows look alike but cannot be added, both survive and carry the
 * reason. A projection that merged them would be shorter and wrong.
 */
function groupRequirements(requirements) {
  const groups = new Map();
  for (const r of requirements) {
    const key = aggregationKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    members,
    /* Only where all of them could be valued; one unvalued member makes the
       group total a partial figure pretending to be a whole one. */
    aggregatable: members.every((m) => m.money.available),
    separatedFrom: requirements
      .filter((o) => aggregationKey(o) !== key
        && (o.reference.itemId || o.reference.serviceId)
        === (members[0].reference.itemId || members[0].reference.serviceId)
        && (o.reference.itemId || o.reference.serviceId))
      .map((o) => ({ lineKey: o.reference.lineKey, reason: separationReason(members[0], o) })),
  }));
}

/**
 * The whole projection for one approved scenario.
 *
 * @param {{companyId, actorId}} ctx
 * @param {{costingId, scenarioKey, asOf}} args
 */
async function projectFor(ctx, { costingId, scenarioKey, asOf } = {}) {
  const unavailable = (reason) => ({
    available: false, reason, message: UNAVAILABLE_TEXT[reason],
  });

  if (!mongoose.Types.ObjectId.isValid(String(costingId || ""))) {
    return unavailable(UNAVAILABLE.NO_COSTING);
  }
  const costing = await Costing().findOne({ companyId: ctx.companyId, _id: costingId })
    .select("_id label context approvedVersionId currentVersionId").lean();
  if (!costing) return unavailable(UNAVAILABLE.NO_COSTING);

  /* ── THE APPROVED ONE, EXPLICITLY ──────────────────────────────────────
     Never `currentVersionId`. A projection built from a draft would describe
     a plan nobody approved, and would move every time somebody recalculated. */
  if (!costing.approvedVersionId) return unavailable(UNAVAILABLE.NO_APPROVED_VERSION);
  const version = await CostingVersion().findOne({
    _id: costing.approvedVersionId, companyId: ctx.companyId, status: "APPROVED",
  }).lean();
  if (!version) return unavailable(UNAVAILABLE.NO_APPROVED_VERSION);

  /* Exact, or nothing. The nearest quantity is a different run size with
     different fixed-cost dilution and possibly a different supplier tier. */
  const scenarios = version.scenarios || [];
  const scenario = present(scenarioKey)
    ? scenarios.find((s) => s.key === scenarioKey)
    : (scenarios.find((s) => s.isPrimary) || scenarios[0]);
  if (!scenario) return unavailable(UNAVAILABLE.NO_SCENARIO);

  const asOfDate = asOf ? new Date(asOf) : new Date();
  const provByLine = new Map((version.offerProvenance || []).map((p) => [p.lineKey, p]));
  const freight = version.freightProvenance;
  if (freight?.lineKey && !provByLine.has(freight.lineKey)) provByLine.set(freight.lineKey, freight);
  const resultByLine = new Map((scenario.lines || []).map((l) => [l.lineKey, l]));

  const requirements = [];
  const procuredLineKeys = new Set();
  for (const line of version.inputs || []) {
    const prov = provByLine.get(line.lineKey) || null;
    const kind = kindOf(line, prov);
    if (!kind) continue;
    const result = resultByLine.get(line.lineKey) || null;
    /* A line the scenario did not compute is not projected. Absent is not
       zero, and a requirement with no result has no value to state. */
    if (!result) continue;
    procuredLineKeys.add(line.lineKey);
    requirements.push(requirementFrom({
      costing, version, scenario, line, result, prov, kind, asOfDate,
    }));
  }

  const timing = await timingFor(costing, ctx);
  for (const r of requirements) {
    r.timing = timing;
    if (!timing.recorded) r.issues.push(ISSUE.TIMING_UNRECORDED);
  }
  await budgetsFor(requirements, ctx.companyId);

  const notProcurement = notProcurementFrom(scenario, procuredLineKeys);

  return {
    available: true,
    reason: null,
    /* ── WHAT THIS IS, SAID ON THE RESULT ITSELF ───────────────────────
        So no caller can present it as an authorisation. */
    basis: "ESTIMATED_PROCUREMENT_REQUIREMENT",
    notAuthorisation: true,
    costing: {
      costingId: idOf(costing._id),
      label: costing.label || "",
    },
    version: {
      costingVersionId: idOf(version._id),
      versionNumber: version.versionNumber ?? null,
      approvedAt: version.lifecycle?.approvedAt || null,
      baseCurrency: version.baseCurrency || "INR",
    },
    scenario: {
      scenarioKey: scenario.key,
      label: scenario.label || "",
      outputQuantity: String(scenario.quantity),
      outputQuantityUom: scenario.quantityUom || null,
      /* Every quantity this version was approved for, so a screen can offer
         the real choices rather than inviting one nobody approved. */
      availableScenarios: scenarios.map((s) => ({
        scenarioKey: s.key, quantity: String(s.quantity),
        quantityUom: s.quantityUom || null, isPrimary: Boolean(s.isPrimary),
      })),
    },
    requirements,
    groups: groupRequirements(requirements),
    summary: summarise(requirements, notProcurement, timing),
  };
}

module.exports.UNAVAILABLE = UNAVAILABLE;
module.exports.UNAVAILABLE_TEXT = UNAVAILABLE_TEXT;
module.exports.kindOf = kindOf;
module.exports.timingFor = timingFor;
module.exports.budgetsFor = budgetsFor;
module.exports.summarise = summarise;
module.exports.groupRequirements = groupRequirements;
module.exports.projectFor = projectFor;
