"use strict";
/**
 * services/storePurchase/freightOfferRead.service.js
 *
 * Store & Purchase — THE ONE DOOR CENTRAL COSTING READS FREIGHT QUOTATIONS
 * THROUGH.
 *
 * The material and service registers state the reasoning and it is not
 * re-argued: an in-process read taking an explicit company and a stated
 * reason, returning plain frozen objects rather than documents, so Central
 * Costing cannot write to a register that is not its own.
 *
 * ── WHAT "CURRENT" MEANS ────────────────────────────────────────────────────
 * ACTIVE, effective by the costing date and not expired by it. A draft is not
 * a price, a withdrawn one was pulled, a superseded one was replaced, and one
 * that starts next month has not started.
 *
 * ── AND WHAT IS NOT READ HERE, AT ALL ───────────────────────────────────────
 * `PurchaseOrder.shippingCharges` and `LandedCostAllocation`. Both are records
 * of freight ACTUALLY paid on a real receipt — inbound, on a different order,
 * to a different supplier. Neither is a forecast for this enquiry, and neither
 * is imported by this file.
 */

const mongoose = require("mongoose");

const FreightOffer = require("../../models/CMS_Models/Inventory/Sourcing/FreightOffer");
const { fail } = require("./errors");

function assertReadContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Freight quotations cannot be read without a company.", {
      reason: "FREIGHT_CONTEXT_REQUIRED",
    });
  }
  if (!ctx.reason && !ctx.actorId) {
    throw fail("VALIDATION", "A service read of freight quotations must state its reason.", {
      reason: "FREIGHT_REASON_REQUIRED",
    });
  }
  return ctx;
}

/** Plain, frozen facts. A caller that tried to adjust a rate would fail loudly. */
const factsOf = (doc) => Object.freeze({
  offerId: String(doc._id),
  supplierId: String(doc.supplierId),
  supplierName: doc.supplierName || "",
  originWarehouseId: String(doc.originWarehouseId),
  originName: doc.originName || "",
  destinationAddressId: doc.destinationAddressId ? String(doc.destinationAddressId) : null,
  destinationZone: Object.freeze({
    city: doc.destinationZone?.city || "",
    region: doc.destinationZone?.region || "",
    country: doc.destinationZone?.country || "",
  }),
  destinationLabel: doc.destinationLabel || "",
  mode: doc.mode,
  basis: doc.basis,
  rateMinor: doc.rateMinor,
  currency: doc.currency,
  priceBasis: doc.priceBasis,
  /* Null, never 0 — an unrecorded rate is not a zero-rated quotation. */
  gstRatePercent: doc.gstRatePercent === undefined || doc.gstRatePercent === null
    ? null : doc.gstRatePercent,
  sacCode: doc.sacCode || null,
  minimumChargeMinor: doc.minimumChargeMinor ?? null,
  quotationReference: doc.quotationReference || null,
  quotationDate: doc.quotationDate || null,
  effectiveFrom: doc.effectiveFrom || null,
  validUntil: doc.validUntil || null,
  status: doc.status,
  revision: doc.revision ?? 1,
  withdrawalReason: doc.withdrawalReason || null,
});

/** Every quotation this company holds out of one origin, whatever its state. */
async function candidateOffers(ctx, originWarehouseId) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(originWarehouseId || ""))) return [];
  /* ── THE COMPANY CLAUSE IS IN THE SAME QUERY AS THE SELECTOR ────────
     Not a filter applied afterwards: another company's quotation must be
     indistinguishable from one that does not exist, and that is only true if
     it never comes back. */
  return FreightOffer.find({
    companyId: ctx.companyId,
    originWarehouseId: new mongoose.Types.ObjectId(String(originWarehouseId)),
  }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
}

/** One quotation by id, company-scoped. `null` when it is not this company's. */
async function offerById(ctx, offerId) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(offerId || ""))) return null;
  const doc = await FreightOffer.findOne({
    _id: new mongoose.Types.ObjectId(String(offerId)),
    companyId: ctx.companyId,
  }).lean();
  return doc ? factsOf(doc) : null;
}

/**
 * Which quotations can move THIS order, and why the rest cannot.
 *
 * Lane and mode are matched by the pure resolver in `freight.service`; state
 * and dates are judged here. Both halves of the answer are returned, because
 * "no quotation applies" is a different message from "one exists and it
 * expired last month", and only the second tells somebody what to do.
 */
async function applicableOffers(ctx, { originWarehouseId, destination, mode, asOf = new Date() } = {}) {
  assertReadContext(ctx);
  const { coversLane } = require("../centralCosting/freight.service");
  const candidates = await candidateOffers(ctx, originWarehouseId);
  if (!candidates.length) return { applicable: [], excluded: [] };

  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const applicable = [];
  const excluded = [];

  for (const doc of candidates) {
    const facts = factsOf(doc);
    const reject = (reason, detail) => excluded.push({ offer: facts, reason, ...detail });

    if (doc.status !== "ACTIVE") { reject("NOT_ACTIVE", { status: doc.status }); continue; }
    if (doc.effectiveFrom && new Date(doc.effectiveFrom).getTime() > now.getTime()) {
      reject("NOT_YET_EFFECTIVE", { effectiveFrom: doc.effectiveFrom });
      continue;
    }
    if (doc.validUntil && new Date(doc.validUntil).getTime() < now.getTime()) {
      reject("EXPIRED", { validUntil: doc.validUntil });
      continue;
    }
    if (!coversLane(facts, { originWarehouseId, destination, mode })) {
      reject("LANE_NOT_COVERED", { mode: facts.mode, destinationLabel: facts.destinationLabel });
      continue;
    }
    applicable.push(facts);
  }

  return { applicable, excluded };
}

module.exports = { candidateOffers, offerById, applicableOffers, factsOf };
