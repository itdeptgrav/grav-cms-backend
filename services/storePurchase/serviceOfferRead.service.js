"use strict";
/**
 * services/storePurchase/serviceOfferRead.service.js
 *
 * Store & Purchase — THE ONE DOOR CENTRAL COSTING READS SERVICE QUOTATIONS
 * THROUGH.
 *
 * The material register's own adapter states the reasoning and it is not
 * re-argued here: an in-process read that takes an explicit company and a
 * stated reason, returning plain objects rather than documents, so Central
 * Costing cannot write to a master that is not its own.
 *
 * ── WHAT "CURRENT" MEANS ────────────────────────────────────────────────────
 * ACTIVE, effective by the costing date, not expired by it. A draft is not a
 * price, a withdrawn one was pulled, a superseded one was replaced, and a
 * future one has not started.
 *
 * ── AND WHAT IS NOT READ HERE, AT ALL ───────────────────────────────────────
 * `ServiceOrder`. `SpendRequest`. `Service.defaultRate`. The first two are
 * downstream of a decision to buy and cannot price a pre-production estimate;
 * the third says of itself that it is planning guidance. None of the three is
 * imported by this file, which is a stronger statement than a comment saying
 * they are not used.
 */

const mongoose = require("mongoose");

const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const applicability = require("./serviceOfferApplicability");
const { fail } = require("./errors");

/** Same contract as `storeFacts`: a company, and a stated reason. */
function assertReadContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Service quotations cannot be read without a company.", {
      reason: "SERVICE_CONTEXT_REQUIRED",
    });
  }
  if (!ctx.reason && !ctx.actorId) {
    throw fail("VALIDATION", "A service read of service quotations must state its reason.", {
      reason: "SERVICE_REASON_REQUIRED",
    });
  }
  return ctx;
}

/** Plain, frozen facts. A caller that tried to adjust a rate would fail loudly. */
const factsOf = (doc) => Object.freeze({
  offerId: String(doc._id),
  supplierId: String(doc.supplierId),
  supplierName: doc.supplierName || "",
  serviceId: String(doc.serviceId),
  serviceCode: doc.serviceCode || "",
  serviceName: doc.serviceName || "",
  supplierServiceCode: doc.supplierServiceCode || null,
  supplierServiceName: doc.supplierServiceName || null,
  description: doc.description || null,
  document: doc.document && (doc.document.label || doc.document.url || doc.document.storedAt)
    ? Object.freeze({
      label: doc.document.label || "",
      url: doc.document.url || "",
      storedAt: doc.document.storedAt || "",
    })
    : null,
  billingUnit: doc.billingUnit,
  currency: doc.currency,
  unitPriceMinor: doc.unitPriceMinor,
  priceBasis: doc.priceBasis,
  /* Null, never 0 — an unrecorded rate is not a zero-rated quotation. */
  gstRatePercent: doc.gstRatePercent === undefined || doc.gstRatePercent === null
    ? null : doc.gstRatePercent,
  sacCode: doc.sacCode || null,
  minimumChargeMinor: doc.minimumChargeMinor ?? null,
  minQuantity: doc.minQuantity ?? null,
  orderMultiple: doc.orderMultiple ?? null,
  leadTimeDays: doc.leadTimeDays ?? null,
  tiers: Array.isArray(doc.tiers) && doc.tiers.length
    ? Object.freeze(doc.tiers.map((t) => Object.freeze({
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity === undefined || t.maxQuantity === null ? null : t.maxQuantity,
      unitPriceMinor: t.unitPriceMinor,
      note: t.note || null,
    })))
    : null,
  quotationReference: doc.quotationReference || null,
  quotationDate: doc.quotationDate || null,
  effectiveFrom: doc.effectiveFrom || null,
  validUntil: doc.validUntil || null,
  status: doc.status,
  revision: doc.revision ?? 1,
  withdrawalReason: doc.withdrawalReason || null,
  supersededByOfferId: doc.supersededByOfferId ? String(doc.supersededByOfferId) : null,
});

/** Every quotation this company holds for one service, whatever its state. */
async function candidateOffersForService(ctx, serviceId) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(serviceId || ""))) return [];
  return ServiceSupplierOffer.find({
    companyId: ctx.companyId,
    serviceId: new mongoose.Types.ObjectId(String(serviceId)),
  }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
}

/** The ones a person could select today, as plain facts. */
async function currentOffersForService(ctx, serviceId, { asOf = new Date() } = {}) {
  const docs = await candidateOffersForService(ctx, serviceId);
  const now = asOf instanceof Date ? asOf : new Date(asOf);
  return docs
    .filter((d) => d.status === "ACTIVE")
    .filter((d) => !d.effectiveFrom || new Date(d.effectiveFrom).getTime() <= now.getTime())
    .filter((d) => !d.validUntil || new Date(d.validUntil).getTime() >= now.getTime())
    .map(factsOf);
}

/** One quotation by id, company-scoped. `null` when it is not this company's. */
async function currentOfferById(ctx, offerId) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(offerId || ""))) return null;
  const doc = await ServiceSupplierOffer.findOne({
    _id: new mongoose.Types.ObjectId(String(offerId)),
    companyId: ctx.companyId,
  }).lean();
  return doc ? factsOf(doc) : null;
}

/**
 * Which quotations can price `quantity` of this service, and why the rest cannot.
 *
 * The facts the records cannot know about themselves — whether the supplier is
 * still active, whether the Service Master row is still active — are looked up
 * here, company scoped, and handed to the pure resolver.
 *
 * ── A LOOKUP FAILURE IS AN OUTAGE ───────────────────────────────────────────
 * Not caught. `supplierIdentity` RETURNS null for a supplier that is not this
 * company's and THROWS when it cannot read at all; catching both and calling
 * the result "inactive" turns a database blip into a settled commercial
 * statement. The material adapter had exactly that bug and it is not repeated.
 */
async function applicableOffersForService(ctx, { serviceId, quantity, requestedUnit, asOf = new Date() } = {}) {
  assertReadContext(ctx);
  const candidates = await candidateOffersForService(ctx, serviceId);
  if (!candidates.length) return { applicable: [], excluded: [] };

  const storeFacts = require("../centralCosting/storeFacts.service");
  const factsCtx = { companyId: ctx.companyId, actorId: ctx.actorId, reason: ctx.reason || "service_offer_applicability" };

  const supplierIds = [...new Set(candidates.map((c) => String(c.supplierId)))];
  const statuses = new Map();
  for (const sid of supplierIds) {
    const s = await storeFacts.supplierIdentity(factsCtx, sid);
    /* Absent means the supplier is not this company's — which the offer's own
       company scope should already have prevented, so it is recorded as
       inactive rather than waved through. */
    statuses.set(sid, s ? String(s.status || "active").toLowerCase() === "active" : false);
  }

  /* Unlike RawItem, the Service master HAS a lifecycle, so it is checked. */
  const service = await storeFacts.serviceFacts(factsCtx, serviceId);

  return applicability.resolveApplicableServiceOffers({
    offers: candidates,
    criteria: { companyId: ctx.companyId, serviceId, quantity, requestedUnit, asOf },
    facts: {
      supplierActive: (sid) => statuses.get(String(sid)) ?? null,
      serviceActive: service ? service.active : false,
    },
  });
}

module.exports = {
  assertReadContext,
  candidateOffersForService,
  currentOffersForService,
  currentOfferById,
  applicableOffersForService,
};
