// services/manufacturing/qcRawItemOrders.js
//
// WHICH ORDERS RAW-MATERIAL QC APPLIES TO — and which one a scanned label
// belongs to.
//
// ── THE RULE THIS REPLACES, AND WHY IT WAS WRONG ───────────────────────────
// Raw-material checking shipped on 28 Sep 2026 for job work: the customer sends
// the cloth, the factory checks it before cutting. So the order list filtered on
// `fulfilmentModel === "JOB_WORK"` and the per-order figures counted only
// CUSTOMER_MATERIAL goods receipts.
//
// That conflated WHO OWNS THE MATERIAL with WHETHER IT NEEDS INSPECTING. A roll
// the factory bought can arrive short, shaded wrong or holed exactly as a
// customer's can, and the whole reason QC checks cloth before cutting — that a
// defect found after cutting is a defect you have paid to create — does not
// care who paid for it. The gate meant a normal order's material could not be
// inspected at all.
//
// ── SO ELIGIBILITY IS THE MATERIAL REQUIREMENT, NOT THE OWNERSHIP ──────────
// `WorkOrder.rawMaterials[]` (the BOM allocation snapshot: `rawItemId`,
// `rawItemVariantId`, `quantityRequired`, `quantityAllocated`, `quantityIssued`,
// `unit`) records what an order actually needs, for EVERY order, and
// `WorkOrder.customerRequestId` names the order. That is the join this service is
// built on.
//
// An order is eligible when any of three things is true:
//   1. a live work order of it allocates raw material  — it will need checking
//   2. something has already been checked on it        — never orphan a record
//   3. customer material was received against it       — the original case
//
// OWNERSHIP IS KEPT, AS CONTEXT. `materialSource` travels on every order row and
// every label so a checker can see whose cloth is in their hands, and the Orders
// screen can FILTER by it. It never decides whether the order appears.
"use strict";

const mongoose = require("mongoose");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const QCRawItemInspection = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();
const idStr = (v) => (v ? String(v) : "");

/** The MO statuses raw-material QC has anything to say about. */
const LIVE_MO = Object.freeze({ status: { $nin: ["cancelled", "rejected", "draft", "pending"] } });

/** A work order that has not been abandoned. Its allocation still stands. */
const LIVE_WO = Object.freeze({ status: { $nin: ["cancelled"] } });

const MO_SELECT =
  "requestId customerInfo.name customerInfo.deliveryDeadline requestType status createdAt fulfilmentModel items.fulfilmentModel items.stockItemName";

/* ── WHOSE MATERIAL IS THIS ───────────────────────────────────────────────── */

const SOURCE = Object.freeze({
  CUSTOMER: "CUSTOMER_SUPPLIED",
  FACTORY: "FACTORY_PROCURED",
  OTHER: "OTHER",
  UNAVAILABLE: "UNAVAILABLE",
});

const SOURCE_LABEL = Object.freeze({
  CUSTOMER_SUPPLIED: "Customer supplied",
  FACTORY_PROCURED: "Factory procured",
  OTHER: "Other recorded ownership",
  UNAVAILABLE: "Unavailable",
});

/**
 * Where a LABEL's material came from, read off the label itself.
 *
 * Descriptive only. A customer-owned label carries `customerMaterial` (the
 * Barcode schema refuses a unit price on one — see its own validator); a
 * factory-bought one carries the purchase order and the vendor. A label with
 * neither is genuinely unknown provenance and says so rather than being
 * assumed to be the factory's.
 */
function labelSource(b) {
  if (!b) return { source: SOURCE.UNAVAILABLE, sourceLabel: SOURCE_LABEL.UNAVAILABLE, owner: "" };
  const cm = b.customerMaterial || {};
  if (cm.lotId || cm.customerId || str(cm.customerLabel) || str(cm.orderRef)) {
    return { source: SOURCE.CUSTOMER, sourceLabel: SOURCE_LABEL.CUSTOMER_SUPPLIED, owner: str(cm.customerLabel) };
  }
  if (b.purchaseOrder || str(b.purchaseOrderNumber) || b.vendor || str(b.vendorName)) {
    return { source: SOURCE.FACTORY, sourceLabel: SOURCE_LABEL.FACTORY_PROCURED, owner: str(b.vendorName) };
  }
  return { source: SOURCE.UNAVAILABLE, sourceLabel: SOURCE_LABEL.UNAVAILABLE, owner: "" };
}

/**
 * Where an ORDER's material comes from, across its labels and lots.
 *
 * An order may legitimately be mixed — some trims bought, the shell fabric sent
 * by the customer — so this reports what it finds rather than forcing one
 * answer. `fulfilmentModel === "JOB_WORK"` is still read, because Sales saying
 * so is real information; it is now ONE of the signals and not the gate.
 */
function orderSource(mo, { hasCustomerMaterial = false } = {}) {
  const salesSaysJobWork =
    mo?.fulfilmentModel === "JOB_WORK" || (mo?.items || []).some((i) => i.fulfilmentModel === "JOB_WORK");
  if (salesSaysJobWork || hasCustomerMaterial) {
    return {
      source: SOURCE.CUSTOMER,
      sourceLabel: SOURCE_LABEL.CUSTOMER_SUPPLIED,
      /* Both halves, because they can disagree: material can arrive for an
         order Sales never marked, and an order can be marked before anything
         arrives. Neither is an error and the screen should be able to say which. */
      salesSaysJobWork,
      hasCustomerMaterial,
    };
  }
  return {
    source: SOURCE.FACTORY,
    sourceLabel: SOURCE_LABEL.FACTORY_PROCURED,
    salesSaysJobWork: false,
    hasCustomerMaterial: false,
  };
}

/* ── WHAT AN ORDER NEEDS ──────────────────────────────────────────────────── */

/**
 * The raw-material requirement of every live order, from its work orders.
 *
 * @returns Map<moId, { lines: Map<"rawItemId|variantId", line>, workOrders:number }>
 */
async function requirementsByOrder(moIds = null) {
  const match = { ...LIVE_WO };
  if (moIds) match.customerRequestId = { $in: moIds.map(oid) };

  const rows = await WorkOrder.find(match)
    .select("customerRequestId status rawMaterials")
    .lean();

  const out = new Map();
  for (const wo of rows) {
    const key = idStr(wo.customerRequestId);
    if (!key) continue;
    const bucket = out.get(key) || { lines: new Map(), workOrders: 0 };
    bucket.workOrders += 1;
    for (const a of wo.rawMaterials || []) {
      if (!a?.rawItemId) continue;
      const k = `${idStr(a.rawItemId)}|${idStr(a.rawItemVariantId)}`;
      const line = bucket.lines.get(k) || {
        rawItemId: idStr(a.rawItemId),
        variantId: idStr(a.rawItemVariantId) || null,
        rawItemName: str(a.name),
        rawItemSku: str(a.sku),
        variantLabel: (a.rawItemVariantCombination || []).join(" · "),
        unit: str(a.unit),
        requiredQuantity: 0,
        allocatedQuantity: 0,
        issuedQuantity: 0,
      };
      line.requiredQuantity = r4(line.requiredQuantity + (a.quantityRequired || 0));
      line.allocatedQuantity = r4(line.allocatedQuantity + (a.quantityAllocated || 0));
      line.issuedQuantity = r4(line.issuedQuantity + (a.quantityIssued || 0));
      if (!line.rawItemName) line.rawItemName = str(a.name);
      if (!line.unit) line.unit = str(a.unit);
      bucket.lines.set(k, line);
    }
    out.set(key, bucket);
  }
  return out;
}

/**
 * Every order raw-material QC applies to, with WHY each one qualifies.
 *
 * The three reasons are reported rather than collapsed, because they mean
 * different things to a checker: `requires` is work coming, `checked` is work
 * done, `received` is material sitting in the store waiting.
 */
async function eligibleOrders({ ids = null } = {}) {
  const [mos, reqs, checkedIds, customerLots] = await Promise.all([
    CustomerRequest.find(ids ? { ...LIVE_MO, _id: { $in: ids.map(oid) } } : LIVE_MO)
      .select(MO_SELECT).sort({ createdAt: -1 }).lean(),
    requirementsByOrder(ids),
    QCRawItemInspection.distinct("manufacturingOrderId", { superseded: { $ne: true } }).catch(() => []),
    CustomerMaterialLot.distinct("orderRef").catch(() => []),
  ]);

  const checked = new Set(checkedIds.map(idStr));
  const lotRefs = new Set(customerLots.map((r) => str(r)).filter(Boolean));

  return mos.map((mo) => {
    const key = idStr(mo._id);
    const req = reqs.get(key) || { lines: new Map(), workOrders: 0 };
    const hasCustomerMaterial =
      lotRefs.has(str(mo.requestId)) || lotRefs.has(`MO-${str(mo.requestId)}`);
    const why = {
      requires: req.lines.size > 0,
      checked: checked.has(key),
      received: hasCustomerMaterial,
    };
    return {
      mo,
      requirement: req,
      source: orderSource(mo, { hasCustomerMaterial }),
      why,
      /* ── EVERY ELIGIBLE ORDER, AND ELIGIBILITY IS NOT OWNERSHIP ─────────
         Any one of the three is enough. An order with no raw-material
         allocation, nothing received and nothing checked has no raw material to
         inspect — that is not a job-work test, it is the absence of a subject. */
      eligible: why.requires || why.checked || why.received,
    };
  });
}

/* ── WHICH ORDER IS THIS LABEL FOR ────────────────────────────────────────── */

/**
 * Resolve the manufacturing order a scanned label belongs to.
 *
 * ── SCAN FIRST, ASK ONLY IF YOU MUST ──────────────────────────────────────
 * The old screen made the checker pick the order before it would accept a
 * scan, for every scan, because a factory-procured label has no order on it and
 * the code had no other way to find one. It does now, and the order question is
 * asked only when the answer is genuinely ambiguous.
 *
 * Three signals, in descending strength:
 *
 *   1. THE LABEL SAYS SO. `customerMaterial.orderRef` is written when the Store
 *      books customer material in against an order. It is the strongest signal
 *      there is and it is trusted alone.
 *   2. ALREADY CHECKED. A standing QC record for this label names an order; a
 *      recheck must land on the same one rather than asking again.
 *   3. SOMEBODY NEEDS THIS MATERIAL. Live orders whose work orders allocate this
 *      raw item and variant. This is the path a factory-procured roll takes.
 *
 * @returns `{ candidates, resolution, reason }`
 *   resolution "auto"   exactly one — the caller selects it
 *              "choose" several — the caller must ask
 *              "none"   nothing — the caller must NOT invent one
 */
async function resolveOrdersForLabel(b) {
  if (!b) return { candidates: [], resolution: "none", reason: "No label was given." };

  const rawItemId = idStr(b.rawItem);
  const variantId = idStr(b.variantId);

  const [byRef, priorRecords, requirementMap] = await Promise.all([
    /* 1. the label's own order reference */
    str(b.customerMaterial?.orderRef)
      ? CustomerRequest.find({
          ...LIVE_MO,
          $or: [
            { requestId: str(b.customerMaterial.orderRef) },
            { requestId: str(b.customerMaterial.orderRef).replace(/^MO-/i, "") },
          ],
        }).select(MO_SELECT).lean()
      : Promise.resolve([]),
    /* 2. where it has already been checked */
    QCRawItemInspection.find({ barcodeId: b._id, superseded: { $ne: true } })
      .select("manufacturingOrderId moNumber status inspectedAt inspectedByName")
      .lean(),
    /* 3. who needs this material */
    rawItemId ? requirementsByOrder(null) : Promise.resolve(new Map()),
  ]);

  const seen = new Map();
  const add = (mo, matchedBy, extra = {}) => {
    const key = idStr(mo._id);
    if (!key) return;
    const cur = seen.get(key);
    if (cur) {
      if (!cur.matchedBy.includes(matchedBy)) cur.matchedBy.push(matchedBy);
      Object.assign(cur, extra, { matchedBy: cur.matchedBy });
      return;
    }
    seen.set(key, {
      manufacturingOrderId: key,
      moNumber: mo.requestId ? `MO-${mo.requestId}` : "",
      requestId: str(mo.requestId),
      customerName: str(mo.customerInfo?.name) || "—",
      products: (mo.items || []).map((i) => str(i.stockItemName)).filter(Boolean).slice(0, 4),
      deliveryDate: mo.customerInfo?.deliveryDeadline || null,
      status: str(mo.status),
      ...orderSource(mo),
      matchedBy: [matchedBy],
      ...extra,
    });
  };

  for (const mo of byRef) add(mo, "label");

  /* The prior records need their orders looked up; they are few. */
  const priorIds = [...new Set(priorRecords.map((r) => idStr(r.manufacturingOrderId)))].filter(isId);
  if (priorIds.length) {
    const mos = await CustomerRequest.find({ _id: { $in: priorIds.map(oid) } }).select(MO_SELECT).lean();
    for (const mo of mos) {
      const rec = priorRecords.find((r) => idStr(r.manufacturingOrderId) === idStr(mo._id));
      add(mo, "already-checked", {
        priorStatus: rec ? str(rec.status) : "",
        priorAt: rec ? rec.inspectedAt : null,
        priorBy: rec ? str(rec.inspectedByName) : "",
      });
    }
  }

  /* Who needs this raw item. A requirement line with NO variant matches any
     variant of the item, and a label with no variant matches any line of it —
     an allocation recorded before variants were tracked must not silently stop
     matching the rolls it is about. */
  const needIds = [];
  const needLine = new Map();
  for (const [moId, bucket] of requirementMap) {
    for (const line of bucket.lines.values()) {
      if (line.rawItemId !== rawItemId) continue;
      if (line.variantId && variantId && line.variantId !== variantId) continue;
      needIds.push(moId);
      needLine.set(moId, line);
      break;
    }
  }
  if (needIds.length) {
    const mos = await CustomerRequest.find({ ...LIVE_MO, _id: { $in: needIds.filter(isId).map(oid) } })
      .select(MO_SELECT).lean();
    for (const mo of mos) {
      const line = needLine.get(idStr(mo._id));
      add(mo, "requires-material", line ? {
        requiredQuantity: line.requiredQuantity,
        allocatedQuantity: line.allocatedQuantity,
        issuedQuantity: line.issuedQuantity,
        requirementUnit: line.unit,
      } : {});
    }
  }

  const candidates = [...seen.values()];

  /* ── THE LABEL'S OWN REFERENCE WINS OUTRIGHT ─────────────────────────────
     When the Store booked this roll in against an order, that is not one
     candidate among several — it is the answer, and offering a chooser beside
     it would invite somebody to overrule a recorded fact with a guess. */
  const fromLabel = candidates.filter((c) => c.matchedBy.includes("label"));
  if (fromLabel.length === 1) {
    return { candidates: fromLabel, resolution: "auto", reason: "The label was received for this order." };
  }

  /* A standing verdict is next: a recheck goes back where it came from. */
  const fromPrior = candidates.filter((c) => c.matchedBy.includes("already-checked"));
  if (fromPrior.length === 1 && fromLabel.length === 0) {
    return { candidates: fromPrior, resolution: "auto", reason: "This label has already been checked on this order." };
  }

  if (candidates.length === 1) {
    return { candidates, resolution: "auto", reason: "Only this order needs this material." };
  }
  if (candidates.length > 1) {
    return {
      candidates,
      resolution: "choose",
      reason: "This material is required by more than one active order.",
    };
  }
  return {
    candidates: [],
    resolution: "none",
    /* No invention. Naming the two reasons it can happen is what lets the
       checker fix it rather than assume the scanner is broken. */
    reason: rawItemId
      ? "No active order needs this material, and nothing has been checked against this label. Either no work order allocates it yet, or it was received for an order that is no longer active."
      : "This label does not name a raw item, so there is no material to match against an order.",
  };
}

module.exports = {
  LIVE_MO, LIVE_WO, MO_SELECT, SOURCE, SOURCE_LABEL,
  labelSource, orderSource, requirementsByOrder, eligibleOrders, resolveOrdersForLabel,
};
