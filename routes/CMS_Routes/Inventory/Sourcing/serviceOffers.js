// routes/CMS_Routes/Inventory/Sourcing/serviceOffers.js
//
// Store & Purchase — THE SERVICE QUOTATION REGISTER.
//
// ── WHOSE SCREEN THIS IS ────────────────────────────────────────────────────
// Store's, on exactly the terms the material quotation register already sits
// on: looking is `sp.read`, changing is `sp.sourcing.manage`. Central Costing
// consumes it through `serviceOfferRead.service` and cannot change it.
//
// ── THE SAME FOUR VERBS, FOR THE SAME REASONS ───────────────────────────────
// Create a draft, publish it, revise it (which supersedes rather than edits),
// withdraw it with a reason. There is no update: a published quotation is
// evidence a costing may already have been frozen from, and rewriting one
// would make every historical costing that cited it read as though it had used
// the new figure.

const express = require("express");
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, withIdempotency, CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");

const ServiceSupplierOffer = require("../../../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");
const { beginServiceOfferLifecycle } = ServiceSupplierOffer;
const Service = require("../../../../models/CMS_Models/Inventory/Services/Service");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const offerRead = require("../../../../services/storePurchase/serviceOfferRead.service");
const { fail, handle } = require("../../../../services/storePurchase/errors");

const router = express.Router();
router.use(EmployeeAuthMiddleware, requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
const canWrite = requireCapability(CAPABILITIES.SOURCING_MANAGE);

const present = (v) => v !== null && v !== undefined && v !== "";
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);

/** What a caller may see. Never a document — a serialised, plain answer. */
const serialize = (doc) => ({
  id: String(doc._id),
  supplierId: String(doc.supplierId),
  supplierName: doc.supplierName || "",
  serviceId: String(doc.serviceId),
  serviceCode: doc.serviceCode || "",
  serviceName: doc.serviceName || "",
  supplierServiceCode: doc.supplierServiceCode || null,
  supplierServiceName: doc.supplierServiceName || null,
  description: doc.description || null,
  billingUnit: doc.billingUnit,
  currency: doc.currency,
  unitPriceMinor: doc.unitPriceMinor,
  priceBasis: doc.priceBasis,
  /* Null, never 0 — an unrecorded GST rate is not a zero-rated quotation. */
  gstRatePercent: doc.gstRatePercent ?? null,
  sacCode: doc.sacCode || null,
  minimumChargeMinor: doc.minimumChargeMinor ?? null,
  minQuantity: doc.minQuantity ?? null,
  orderMultiple: doc.orderMultiple ?? null,
  leadTimeDays: doc.leadTimeDays ?? null,
  tiers: Array.isArray(doc.tiers) && doc.tiers.length
    ? doc.tiers.map((t) => ({
      minQuantity: t.minQuantity,
      maxQuantity: t.maxQuantity ?? null,
      unitPriceMinor: t.unitPriceMinor,
      note: t.note || null,
    }))
    : null,
  quotationReference: doc.quotationReference || null,
  quotationDate: doc.quotationDate || null,
  document: doc.document?.label || doc.document?.url || doc.document?.storedAt
    ? { label: doc.document.label || "", url: doc.document.url || "", storedAt: doc.document.storedAt || "" }
    : null,
  effectiveFrom: doc.effectiveFrom || null,
  validUntil: doc.validUntil || null,
  status: doc.status,
  revision: doc.revision ?? 1,
  supersedesOfferId: doc.supersedesOfferId ? String(doc.supersedesOfferId) : null,
  supersededByOfferId: doc.supersededByOfferId ? String(doc.supersededByOfferId) : null,
  withdrawalReason: doc.withdrawalReason || null,
  createdByActorName: doc.createdByActorName || "",
  updatedByActorName: doc.updatedByActorName || "",
  createdAt: doc.createdAt || null,
  updatedAt: doc.updatedAt || null,
});

/**
 * The commercial fields, validated, with both masters proved to be this
 * company's.
 *
 * ── THE SUPPLIER AND THE SERVICE ARE RE-READ, NOT TRUSTED ───────────────────
 * A body naming another company's supplier or service would otherwise write a
 * quotation across a tenant boundary and snapshot its name. Both are read
 * company-scoped, and "not ours" and "not there" are deliberately one answer.
 */
async function parseOffer(req) {
  const b = req.body || {};
  const companyId = req.tenant.companyId;

  if (!isObjectId(b.supplierId)) {
    throw fail("VALIDATION", "A quotation names the supplier who gave it.", { field: "supplierId" });
  }
  const supplier = await Vendor.findOne({ _id: b.supplierId, companyId })
    .select("companyName status").lean();
  if (!supplier) {
    throw fail("VALIDATION", "That supplier is not in this company's register.", { field: "supplierId" });
  }
  if (String(supplier.status || "").toLowerCase() !== "active") {
    throw fail("VALIDATION",
      `${supplier.companyName} is not an active supplier, so a quotation cannot be recorded against them.`,
      { field: "supplierId", status: supplier.status });
  }

  if (!isObjectId(b.serviceId)) {
    throw fail("VALIDATION", "A quotation names the service it is for.", { field: "serviceId" });
  }
  const service = await Service.findOne({ _id: b.serviceId, companyId })
    .select("serviceCode name billingUnit sacCode status").lean();
  if (!service) {
    throw fail("VALIDATION", "That service is not in this company's Service Master.", { field: "serviceId" });
  }
  if (String(service.status || "").toUpperCase() !== "ACTIVE") {
    throw fail("VALIDATION",
      `${service.name} is not active in the Service Master, so a quotation cannot be recorded against it.`,
      { field: "serviceId", status: service.status });
  }

  const billingUnit = str(b.billingUnit || service.billingUnit, 60);
  if (!billingUnit) {
    throw fail("VALIDATION",
      "Say how the supplier bills this — per visit, per piece, per lot. A costing cannot apply a rate whose unit nobody stated.",
      { field: "billingUnit" });
  }

  if (!Number.isSafeInteger(b.unitPriceMinor) || b.unitPriceMinor < 0) {
    throw fail("VALIDATION", "The quoted rate must be a whole number of minor units.", { field: "unitPriceMinor" });
  }
  if (!ServiceSupplierOffer.PRICE_BASES.includes(b.priceBasis)) {
    throw fail("VALIDATION",
      "Say whether the quoted figure includes GST, excludes it, or the supply is non-taxable. A price whose basis nobody stated cannot be turned into a net figure.",
      { field: "priceBasis", allowed: [...ServiceSupplierOffer.PRICE_BASES] });
  }
  if (!ServiceSupplierOffer.SUPPORTED_CURRENCIES.includes(b.currency)) {
    throw fail("VALIDATION", "That is not a currency this register supports.",
      { field: "currency", allowed: [...ServiceSupplierOffer.SUPPORTED_CURRENCIES] });
  }

  /* Tiers, only where the supplier genuinely quoted them. An invented band is
     a price nobody offered, and it would be quoted. */
  const tiers = Array.isArray(b.tiers) && b.tiers.length
    ? b.tiers.map((t, i) => {
      if (!Number.isFinite(Number(t?.minQuantity)) || Number(t.minQuantity) <= 0) {
        throw fail("VALIDATION", "A tier starts at a positive quantity.", { field: `tiers.${i}.minQuantity` });
      }
      if (!Number.isSafeInteger(t?.unitPriceMinor) || t.unitPriceMinor < 0) {
        throw fail("VALIDATION", "A tier's rate must be a whole number of minor units.", { field: `tiers.${i}.unitPriceMinor` });
      }
      return {
        minQuantity: Number(t.minQuantity),
        ...(present(t.maxQuantity) ? { maxQuantity: Number(t.maxQuantity) } : {}),
        unitPriceMinor: t.unitPriceMinor,
        ...(str(t.note) ? { note: str(t.note) } : {}),
      };
    })
    : undefined;

  return {
    supplierId: b.supplierId,
    supplierName: supplier.companyName || "",
    serviceId: b.serviceId,
    serviceCode: service.serviceCode || "",
    serviceName: service.name || "",
    ...(str(b.supplierServiceCode, 60) ? { supplierServiceCode: str(b.supplierServiceCode, 60) } : {}),
    ...(str(b.supplierServiceName) ? { supplierServiceName: str(b.supplierServiceName) } : {}),
    ...(str(b.description, 2000) ? { description: str(b.description, 2000) } : {}),
    billingUnit,
    currency: b.currency,
    unitPriceMinor: b.unitPriceMinor,
    priceBasis: b.priceBasis,
    /* Absent stays absent: an unrecorded rate is not a zero-rated supply. */
    ...(present(b.gstRatePercent) ? { gstRatePercent: Number(b.gstRatePercent) } : {}),
    ...(str(b.sacCode, 20) || service.sacCode ? { sacCode: str(b.sacCode, 20) || service.sacCode } : {}),
    ...(present(b.minimumChargeMinor) ? { minimumChargeMinor: Number(b.minimumChargeMinor) } : {}),
    ...(present(b.minQuantity) ? { minQuantity: Number(b.minQuantity) } : {}),
    ...(present(b.orderMultiple) ? { orderMultiple: Number(b.orderMultiple) } : {}),
    ...(present(b.leadTimeDays) ? { leadTimeDays: Number(b.leadTimeDays) } : {}),
    ...(tiers ? { tiers } : {}),
    ...(str(b.quotationReference, 120) ? { quotationReference: str(b.quotationReference, 120) } : {}),
    ...(b.quotationDate ? { quotationDate: new Date(b.quotationDate) } : {}),
    ...(b.document?.label || b.document?.url || b.document?.storedAt
      ? { document: { label: str(b.document.label), url: str(b.document.url, 2000), storedAt: str(b.document.storedAt) } }
      : {}),
    ...(b.effectiveFrom ? { effectiveFrom: new Date(b.effectiveFrom) } : {}),
    ...(b.validUntil ? { validUntil: new Date(b.validUntil) } : {}),
    ...(str(b.notes, 2000) ? { notes: str(b.notes, 2000) } : {}),
    ...(str(b.terms, 2000) ? { terms: str(b.terms, 2000) } : {}),
  };
}

/** This company's row, or a non-disclosing 404. */
async function load(req) {
  if (!isObjectId(req.params.id)) throw fail("NOT_FOUND", "No such service quotation.");
  const doc = await ServiceSupplierOffer.findOne({
    _id: req.params.id, companyId: req.tenant.companyId,
  });
  if (!doc) throw fail("NOT_FOUND", "No such service quotation.");
  return doc;
}

/* ══ READ ═══════════════════════════════════════════════════════════════════ */

router.get("/", canRead, handle(async (req, res) => {
  const q = { companyId: req.tenant.companyId };
  if (isObjectId(req.query.serviceId)) q.serviceId = req.query.serviceId;
  if (isObjectId(req.query.supplierId)) q.supplierId = req.query.supplierId;
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  const docs = await ServiceSupplierOffer.find(q)
    .sort({ updatedAt: -1 }).limit(200).lean();
  return res.json({ success: true, offers: docs.map(serialize) });
}));

/**
 * Which quotations can price this much of this service, and why the rest
 * cannot — the SAME verdict the costing save reaches, from the same resolver.
 * Two implementations would let the picker offer a supplier the save refuses.
 */
router.get("/applicable", canRead, handle(async (req, res) => {
  const serviceId = String(req.query.serviceId || "").trim();
  if (!isObjectId(serviceId)) throw fail("VALIDATION", "Name the service.", { field: "serviceId" });
  const result = await offerRead.applicableOffersForService(
    { companyId: req.tenant.companyId, actorId: String(req.user?.id || ""), reason: "service_offer_listing" },
    {
      serviceId,
      quantity: req.query.quantity,
      requestedUnit: String(req.query.unit || "").trim(),
      asOf: req.query.asOf ? new Date(req.query.asOf) : new Date(),
    },
  );
  return res.json({ success: true, ...result });
}));

router.get("/:id", canRead, handle(async (req, res) => {
  const doc = await load(req);
  return res.json({ success: true, offer: serialize(doc) });
}));

/* ══ CREATE ═════════════════════════════════════════════════════════════════ */

router.post("/", canWrite,
  withIdempotency("SERVICE_OFFER_CREATE", { target: () => "service-offer" }),
  handle(async (req, res) => {
    const parsed = await parseOffer(req);
    const created = await ServiceSupplierOffer.create({
      ...parsed,
      companyId: req.tenant.companyId,
      status: "DRAFT",
      revision: 1,
      createdByActorId: String(req.user?.id || ""),
      createdByActorName: req.user?.name || "",
    });
    const body = { success: true, offer: serialize(created) };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }));

/* ══ ACTIVATE ═══════════════════════════════════════════════════════════════ */

router.post("/:id/activate", canWrite,
  withIdempotency("SERVICE_OFFER_ACTIVATE", { target: (req) => `service-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const offer = await load(req);
    if (offer.status === "ACTIVE") {
      return res.json({ success: true, replayed: true, offer: serialize(offer) });
    }
    if (offer.status !== "DRAFT") {
      throw fail("SUPPLIER_OFFER_NOT_ACTIVE",
        `A ${offer.status.toLowerCase()} quotation cannot be published.`, { status: offer.status });
    }
    /* Re-checked at publication: a supplier or a service deactivated between
       drafting and publishing must not be published against. */
    const supplier = await Vendor.findOne({ _id: offer.supplierId, companyId: req.tenant.companyId })
      .select("companyName status").lean();
    if (!supplier || String(supplier.status || "").toLowerCase() !== "active") {
      throw fail("VALIDATION",
        "That supplier is no longer active, so this quotation cannot be published.",
        { field: "supplierId" });
    }
    const service = await Service.findOne({ _id: offer.serviceId, companyId: req.tenant.companyId })
      .select("name status").lean();
    if (!service || String(service.status || "").toUpperCase() !== "ACTIVE") {
      throw fail("VALIDATION",
        "That service is no longer active, so this quotation cannot be published.",
        { field: "serviceId" });
    }

    offer.status = "ACTIVE";
    offer.activatedAt = new Date();
    offer.activatedByName = req.user?.name || "";
    /* In force from when it was quoted unless somebody said otherwise. The
       EXPIRY is never defaulted: an invented validity is a claim. */
    if (!offer.effectiveFrom) offer.effectiveFrom = offer.activatedAt;
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    await beginServiceOfferLifecycle(offer, "ACTIVATE").save();

    const body = { success: true, offer: serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

/* ══ REVISE ═════════════════════════════════════════════════════════════════
 *
 * A correction is a NEW record. The old one keeps saying what was quoted,
 * because somebody was quoted it — and a costing may already have frozen it.
 */
router.post("/:id/revise", canWrite,
  withIdempotency("SERVICE_OFFER_REVISE", { target: (req) => `service-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const previous = await load(req);
    if (!["DRAFT", "ACTIVE"].includes(previous.status)) {
      throw fail("SUPPLIER_OFFER_ALREADY_SUPERSEDED",
        `A ${previous.status.toLowerCase()} quotation cannot be revised.`, { status: previous.status });
    }
    const parsed = await parseOffer(req);
    const created = await ServiceSupplierOffer.create({
      ...parsed,
      companyId: req.tenant.companyId,
      status: "DRAFT",
      revision: (previous.revision || 1) + 1,
      supersedesOfferId: previous._id,
      createdByActorId: String(req.user?.id || ""),
      createdByActorName: req.user?.name || "",
    });

    previous.status = "SUPERSEDED";
    previous.supersededByOfferId = created._id;
    previous.supersededAt = new Date();
    previous.updatedByActorId = String(req.user?.id || "");
    previous.updatedByActorName = req.user?.name || "";
    await beginServiceOfferLifecycle(previous, "SUPERSEDE").save();

    const body = { success: true, offer: serialize(created), superseded: serialize(previous) };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }));

/* ══ WITHDRAW ═══════════════════════════════════════════════════════════════ */

router.post("/:id/withdraw", canWrite,
  withIdempotency("SERVICE_OFFER_WITHDRAW", { target: (req) => `service-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const offer = await load(req);
    if (offer.status === "WITHDRAWN") {
      return res.json({ success: true, replayed: true, offer: serialize(offer) });
    }
    const reason = str(req.body?.reason, 500);
    if (!reason) {
      /* Without one, a withdrawn quotation is indistinguishable from a
         mistake, and nobody can tell whether to go back to that supplier. */
      throw fail("SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED",
        "Say why this quotation is being withdrawn.", { field: "reason" });
    }
    offer.status = "WITHDRAWN";
    offer.withdrawnAt = new Date();
    offer.withdrawnByName = req.user?.name || "";
    offer.withdrawalReason = reason;
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    await beginServiceOfferLifecycle(offer, "WITHDRAW").save();

    const body = { success: true, offer: serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

module.exports = router;
module.exports.serialize = serialize;
