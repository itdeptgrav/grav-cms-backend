// routes/CMS_Routes/Inventory/Sourcing/freightOffers.js
//
// Store & Purchase — THE FREIGHT QUOTATION REGISTER.
//
// ── WHOSE SCREEN THIS IS ────────────────────────────────────────────────────
// Store's, on exactly the terms the material and service registers sit on:
// looking is `sp.read`, changing is `sp.sourcing.manage`. Central Costing
// consumes it through `freightOfferRead.service` and cannot change it, and
// neither Sales nor R&D can type a transporter's price anywhere.
//
// ── THE SAME FOUR VERBS, FOR THE SAME REASONS ───────────────────────────────
// Create a draft, publish it, revise it (which supersedes rather than edits),
// withdraw it with a reason. There is no update: a published quotation is
// evidence a costing may already have been frozen from.

const express = require("express");
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, withIdempotency, CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");

const FreightOffer = require("../../../../models/CMS_Models/Inventory/Sourcing/FreightOffer");
const { beginFreightOfferLifecycle } = FreightOffer;
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const CRMAddress = require("../../../../models/CMS_Models/Sales/Address");
const Account = require("../../../../models/CMS_Models/Sales/Account");
const {
  resolveShippingDestination, REASON: SHIPPING,
} = require("../../../../services/centralCosting/shippingDestination.service");
const offerRead = require("../../../../services/storePurchase/freightOfferRead.service");
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
  originWarehouseId: String(doc.originWarehouseId),
  originName: doc.originName || "",
  destinationAddressId: doc.destinationAddressId ? String(doc.destinationAddressId) : null,
  destinationZone: {
    city: doc.destinationZone?.city || "",
    region: doc.destinationZone?.region || "",
    country: doc.destinationZone?.country || "",
  },
  destinationLabel: doc.destinationLabel || "",
  mode: doc.mode,
  basis: doc.basis,
  rateMinor: doc.rateMinor,
  currency: doc.currency,
  priceBasis: doc.priceBasis,
  /* Null, never 0 — an unrecorded GST rate is not a zero-rated quotation. */
  gstRatePercent: doc.gstRatePercent ?? null,
  sacCode: doc.sacCode || null,
  minimumChargeMinor: doc.minimumChargeMinor ?? null,
  quotationReference: doc.quotationReference || null,
  quotationDate: doc.quotationDate || null,
  effectiveFrom: doc.effectiveFrom || null,
  validUntil: doc.validUntil || null,
  status: doc.status,
  revision: doc.revision ?? 1,
  withdrawalReason: doc.withdrawalReason || null,
  supersededByOfferId: doc.supersededByOfferId ? String(doc.supersededByOfferId) : null,
  notes: doc.notes || null,
  terms: doc.terms || null,
});

/**
 * A quotation body, validated against this company's own registers.
 *
 * ── THE LANE HAS TO BE REAL, AT BOTH ENDS ───────────────────────────────────
 * The origin is one of this company's active warehouses; a specific
 * destination is an address on one of this company's accounts. A body naming
 * either from another company would otherwise write a quotation across a
 * tenant boundary and snapshot its name — so both are read company-scoped, and
 * "not ours" and "not there" are deliberately one answer.
 */
async function parseOffer(req) {
  const b = req.body || {};
  const companyId = req.tenant.companyId;

  if (!isObjectId(b.supplierId)) {
    throw fail("VALIDATION", "A quotation names the transporter who gave it.", { field: "supplierId" });
  }
  const supplier = await Vendor.findOne({ _id: b.supplierId, companyId })
    .select("companyName status").lean();
  if (!supplier) {
    throw fail("VALIDATION", "That transporter is not in this company's register.", { field: "supplierId" });
  }
  if (String(supplier.status || "").toLowerCase() !== "active") {
    throw fail("VALIDATION",
      `${supplier.companyName} is not an active supplier, so a quotation cannot be recorded against them.`,
      { field: "supplierId", status: supplier.status });
  }

  if (!isObjectId(b.originWarehouseId)) {
    throw fail("VALIDATION", "A freight rate starts somewhere. Name the dispatch warehouse.", { field: "originWarehouseId" });
  }
  const origin = await Warehouse.findOne({ _id: b.originWarehouseId, companyId })
    .select("name shortName status").lean();
  if (!origin) {
    throw fail("VALIDATION", "That warehouse is not in this company's register.", { field: "originWarehouseId" });
  }
  if (String(origin.status || "") !== "Active") {
    throw fail("VALIDATION",
      `${origin.name} is not an active warehouse, so a lane cannot start there.`,
      { field: "originWarehouseId", status: origin.status });
  }

  /* ── A DESTINATION, OR A ZONE — NEVER NEITHER ───────────────────────
     A quotation that names no destination at all is not a quotation for
     everywhere; it is one nobody can match to an order. */
  let destinationAddressId = null;
  let destinationLabel = str(b.destinationLabel, 200);
  const zone = {
    city: str(b.destinationZone?.city, 120),
    region: str(b.destinationZone?.region, 120),
    country: str(b.destinationZone?.country, 120),
  };
  if (isObjectId(b.destinationAddressId)) {
    /* ── RESOLVED THROUGH A COMPANY-OWNED ACCOUNT ────────────────────
       A `CRMAddress` carries no company of its own — the Account does. This
       used to load the address by id alone, which would snapshot another
       company's customer address, their delivery instructions and their city
       into this company's freight register. */
    const { destination, reason, addressType } = await resolveShippingDestination(companyId, {
      addressId: b.destinationAddressId,
    });
    if (!destination) {
      throw fail("VALIDATION",
        reason === SHIPPING.NOT_SHIPPING
          /* Told apart only for an address this company owns — the caller can
             already see it, and naming the type is the difference between a
             five-second fix and a mystery. */
          ? `That is the ${addressType} address. A freight lane delivers to a shipping address.`
          : "That delivery address is not on this company's records.",
        { field: "destinationAddressId", reason });
    }
    destinationAddressId = destination.addressId;
    /* ── SNAPSHOT FROM THE RECORD, NEVER FROM THE REQUEST ────────────
       A label the caller supplied is a label the caller chose; the lane has
       to be the one the address actually says. */
    destinationLabel = destination.label;
    zone.city = "";
    zone.region = "";
    zone.country = "";
  } else if (!zone.city && !zone.region && !zone.country) {
    throw fail("VALIDATION",
      "Say where this rate delivers to — a specific address, or the city, state or country it covers.",
      { field: "destinationZone" });
  } else if (!destinationLabel) {
    destinationLabel = [zone.city, zone.region, zone.country].filter(Boolean).join(", ");
  }

  if (!FreightOffer.FREIGHT_MODES.includes(b.mode)) {
    throw fail("VALIDATION",
      "Say how this rate travels. Road and air on one lane are different rates from different carriers.",
      { field: "mode", allowed: [...FreightOffer.FREIGHT_MODES] });
  }
  if (!FreightOffer.CALCULATION_BASES.includes(b.basis)) {
    throw fail("VALIDATION",
      "Say what the rate is charged against — the consignment, the kilogram, or the carton. Nothing here can calculate a distance or a dimensional weight.",
      { field: "basis", allowed: [...FreightOffer.CALCULATION_BASES] });
  }
  if (!Number.isSafeInteger(b.rateMinor) || b.rateMinor < 0) {
    throw fail("VALIDATION", "The quoted rate must be a whole number of minor units.", { field: "rateMinor" });
  }
  if (!FreightOffer.PRICE_BASES.includes(b.priceBasis)) {
    throw fail("VALIDATION",
      "Say whether the quoted figure includes GST, excludes it, or the supply is non-taxable.",
      { field: "priceBasis", allowed: [...FreightOffer.PRICE_BASES] });
  }
  if (!FreightOffer.SUPPORTED_CURRENCIES.includes(b.currency)) {
    throw fail("VALIDATION", "That is not a currency this register supports.",
      { field: "currency", allowed: [...FreightOffer.SUPPORTED_CURRENCIES] });
  }

  return {
    supplierId: b.supplierId,
    supplierName: supplier.companyName || "",
    originWarehouseId: b.originWarehouseId,
    originName: origin.name || "",
    ...(destinationAddressId ? { destinationAddressId } : {}),
    destinationZone: zone,
    destinationLabel,
    mode: b.mode,
    basis: b.basis,
    rateMinor: b.rateMinor,
    currency: b.currency,
    priceBasis: b.priceBasis,
    /* Absent stays absent: an unrecorded rate is not a zero-rated supply. */
    ...(present(b.gstRatePercent) ? { gstRatePercent: Number(b.gstRatePercent) } : {}),
    ...(str(b.sacCode, 20) ? { sacCode: str(b.sacCode, 20) } : {}),
    ...(present(b.minimumChargeMinor) ? { minimumChargeMinor: Number(b.minimumChargeMinor) } : {}),
    ...(str(b.quotationReference, 120) ? { quotationReference: str(b.quotationReference, 120) } : {}),
    ...(b.quotationDate ? { quotationDate: new Date(b.quotationDate) } : {}),
    ...(b.document?.name || b.document?.url
      ? { document: { name: str(b.document.name), url: str(b.document.url, 2000) } }
      : {}),
    ...(b.effectiveFrom ? { effectiveFrom: new Date(b.effectiveFrom) } : {}),
    ...(b.validUntil ? { validUntil: new Date(b.validUntil) } : {}),
    ...(str(b.notes, 2000) ? { notes: str(b.notes, 2000) } : {}),
    ...(str(b.terms, 2000) ? { terms: str(b.terms, 2000) } : {}),
  };
}

/** This company's row, or a non-disclosing 404. */
async function load(req) {
  if (!isObjectId(req.params.id)) throw fail("NOT_FOUND", "No such freight quotation.");
  const doc = await FreightOffer.findOne({
    _id: req.params.id, companyId: req.tenant.companyId,
  });
  if (!doc) throw fail("NOT_FOUND", "No such freight quotation.");
  return doc;
}

/* ══ READ ═══════════════════════════════════════════════════════════════════ */

router.get("/", canRead, handle(async (req, res) => {
  const q = { companyId: req.tenant.companyId };
  if (isObjectId(req.query.originWarehouseId)) q.originWarehouseId = req.query.originWarehouseId;
  if (isObjectId(req.query.supplierId)) q.supplierId = req.query.supplierId;
  if (req.query.mode) q.mode = String(req.query.mode).toUpperCase();
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  const docs = await FreightOffer.find(q).sort({ updatedAt: -1 }).limit(200).lean();
  return res.json({ success: true, offers: docs.map(serialize) });
}));

/**
 * Which quotations cover this lane, and why the rest do not — the SAME verdict
 * the costing save reaches, from the same resolver. Two implementations would
 * let the picker offer a carrier the save refuses.
 */
router.get("/applicable", canRead, handle(async (req, res) => {
  const originWarehouseId = String(req.query.originWarehouseId || "").trim();
  if (!isObjectId(originWarehouseId)) {
    throw fail("VALIDATION", "Name the dispatch warehouse.", { field: "originWarehouseId" });
  }
  const result = await offerRead.applicableOffers(
    { companyId: req.tenant.companyId, actorId: String(req.user?.id || ""), reason: "freight_offer_listing" },
    {
      originWarehouseId,
      /* ── THE LANE IS RESOLVED, NOT DESCRIBED ────────────────────
         A caller passing a city could otherwise ask "what covers Bengaluru"
         and be told about a zone rate their own customers cannot reach. The
         address is resolved company-scoped and the zone comes from IT. */
      destination: await (async () => {
        const addressId = String(req.query.destinationAddressId || "").trim();
        if (!addressId) return { addressId: null, city: "", region: "", country: "" };
        const { destination } = await resolveShippingDestination(req.tenant.companyId, { addressId });
        return destination || { addressId: null, city: "", region: "", country: "" };
      })(),
      mode: String(req.query.mode || "").toUpperCase(),
      asOf: req.query.asOf ? new Date(req.query.asOf) : new Date(),
    },
  );
  return res.json({ success: true, ...result });
}));

/**
 * What the register's pickers may offer — this company's active transporters
 * and warehouses, and the shipping addresses it may quote to.
 *
 * ── DECLARED BEFORE `/:id` ──────────────────────────────────────────────
 * Express matches in declaration order, so a static path under a parameter
 * route must come first, or "options" is looked up as a quotation id.
 */
router.get("/options", canRead, handle(async (req, res) => {
  const companyId = req.tenant.companyId;
  /* The company clause, in the same query as every selector below. */
  const companyClause = { companyId };
  const [suppliers, warehouses, accounts] = await Promise.all([
    Vendor.find({ companyId, status: "Active" }).select("companyName").sort({ companyName: 1 }).limit(200).lean(),
    Warehouse.find({ companyId, status: "Active" }).select("name shortName addressDetail.city").sort({ name: 1 }).limit(100).lean(),
    Account.find({ ...companyClause }).select("_id companyName").limit(500).lean(),
  ]);
  /* Shipping addresses only, on accounts this company owns — a picker that
     lists billing addresses is one somebody will eventually choose from, and
     the save refuses it. */
  const addresses = accounts.length
    ? await CRMAddress.find({
      accountId: { $in: accounts.map((a) => a._id) }, addressType: "shipping", isActive: true,
    }).select("accountId recipient addressLine1 city region country").limit(300).lean()
    : [];
  const named = new Map(accounts.map((a) => [String(a._id), a.companyName]));
  return res.json({
    success: true,
    suppliers: suppliers.map((v) => ({ id: String(v._id), label: v.companyName })),
    warehouses: warehouses.map((w) => ({
      id: String(w._id),
      label: [w.name, w.addressDetail?.city].filter(Boolean).join(" — "),
    })),
    addresses: addresses.map((a) => ({
      id: String(a._id),
      label: [named.get(String(a.accountId)), a.city, a.region].filter(Boolean).join(" — "),
    })),
  });
}));

router.get("/:id", canRead, handle(async (req, res) => {
  const doc = await load(req);
  return res.json({ success: true, offer: serialize(doc) });
}));

/* ══ CREATE ═════════════════════════════════════════════════════════════════ */

router.post("/", canWrite,
  withIdempotency("FREIGHT_OFFER_CREATE", { target: () => "freight-offer" }),
  handle(async (req, res) => {
    const parsed = await parseOffer(req);
    const created = await FreightOffer.create({
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
  withIdempotency("FREIGHT_OFFER_ACTIVATE", { target: (req) => `freight-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const offer = await load(req);
    if (offer.status === "ACTIVE") {
      return res.json({ success: true, replayed: true, offer: serialize(offer) });
    }
    if (offer.status !== "DRAFT") {
      throw fail("SUPPLIER_OFFER_NOT_ACTIVE",
        `A ${offer.status.toLowerCase()} quotation cannot be published.`, { status: offer.status });
    }
    /* Re-checked at publication: a transporter or a warehouse deactivated
       between drafting and publishing must not be published against. */
    const supplier = await Vendor.findOne({ _id: offer.supplierId, companyId: req.tenant.companyId })
      .select("companyName status").lean();
    if (!supplier || String(supplier.status || "").toLowerCase() !== "active") {
      throw fail("VALIDATION",
        "That transporter is no longer active, so this quotation cannot be published.",
        { field: "supplierId" });
    }
    const origin = await Warehouse.findOne({ _id: offer.originWarehouseId, companyId: req.tenant.companyId })
      .select("name status").lean();
    if (!origin || String(origin.status || "") !== "Active") {
      throw fail("VALIDATION",
        "That warehouse is no longer active, so a lane cannot start there.",
        { field: "originWarehouseId" });
    }

    offer.status = "ACTIVE";
    offer.activatedAt = new Date();
    offer.activatedByName = req.user?.name || "";
    /* In force from when it was quoted unless somebody said otherwise. The
       EXPIRY is never defaulted: an invented validity is a claim. */
    if (!offer.effectiveFrom) offer.effectiveFrom = offer.activatedAt;
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    await beginFreightOfferLifecycle(offer, "ACTIVATE").save();

    const body = { success: true, offer: serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

/* ══ REVISE ═════════════════════════════════════════════════════════════════
 *
 * A correction is a NEW record. The old one keeps saying what was quoted,
 * because a costing may already have frozen it.
 */
router.post("/:id/revise", canWrite,
  withIdempotency("FREIGHT_OFFER_REVISE", { target: (req) => `freight-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const previous = await load(req);
    if (!["DRAFT", "ACTIVE"].includes(previous.status)) {
      throw fail("SUPPLIER_OFFER_ALREADY_SUPERSEDED",
        `A ${previous.status.toLowerCase()} quotation cannot be revised.`, { status: previous.status });
    }
    const parsed = await parseOffer(req);
    const created = await FreightOffer.create({
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
    await beginFreightOfferLifecycle(previous, "SUPERSEDE").save();

    const body = { success: true, offer: serialize(created), superseded: serialize(previous) };
    return req.idempotent ? req.idempotent.succeed(201, body) : res.status(201).json(body);
  }));

/* ══ WITHDRAW ═══════════════════════════════════════════════════════════════ */

router.post("/:id/withdraw", canWrite,
  withIdempotency("FREIGHT_OFFER_WITHDRAW", { target: (req) => `freight-offer:${req.params.id}` }),
  handle(async (req, res) => {
    const offer = await load(req);
    if (offer.status === "WITHDRAWN") {
      return res.json({ success: true, replayed: true, offer: serialize(offer) });
    }
    const reason = str(req.body?.reason, 500);
    if (!reason) {
      throw fail("SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED",
        "Say why this quotation is being withdrawn.", { field: "reason" });
    }
    offer.status = "WITHDRAWN";
    offer.withdrawnAt = new Date();
    offer.withdrawnByName = req.user?.name || "";
    offer.withdrawalReason = reason;
    offer.updatedByActorId = String(req.user?.id || "");
    offer.updatedByActorName = req.user?.name || "";
    await beginFreightOfferLifecycle(offer, "WITHDRAW").save();

    const body = { success: true, offer: serialize(offer) };
    return req.idempotent ? req.idempotent.succeed(200, body) : res.json(body);
  }));

module.exports = router;
module.exports.serialize = serialize;
