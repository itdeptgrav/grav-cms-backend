// services/centralCosting/storeFacts.service.js
//
// Central Costing — Chunk 3A. THE ONLY DOOR BETWEEN COSTING AND STORE'S FACTS.
//
// ── WHY A DOOR AND NOT A JOIN ───────────────────────────────────────────────
// Chunk 3 attaches supplier quotations and item prices to costings. Those are
// among the most confidential commercial facts the company holds, and the way
// they leak is not a dramatic breach — it is a costing route that reaches for
// `RawItem.findById(...)` because it is quicker than asking, and forgets the
// company filter once.
//
// So costing never touches a Store model. It asks here, and every function
// here takes an explicit `{companyId, reason}` service context and puts the
// company in the SAME query as the id. There is no overload that omits it, and
// nothing returns a mongoose document a caller could re-query from.
//
// ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────
// Not a supplier-offer model. Not quotation selection, quantity tiers, landed
// cost or a Store rate picker — those are Chunk 3's actual work, and building
// them here would be starting it. This chunk makes them SAFE to build; it does
// not build them.
//
// What it does expose is what Chunk 3's resolver will need to ask for, in the
// narrowest form that answers the question:
//   · supplier identity                 · item and variant identity
//   · purchase UoM and conversion facts · tax / HSN metadata
//   · the legacy alias price, explicitly labelled PROVISIONAL
//
// ── THE ALIAS PRICE IS A CURRENT NUMBER, NOT A QUOTATION ────────────────────
// `variant.vendorNicknames[].price` is a mutable field somebody typed. It has
// no quotation reference, no validity, no effective date and no MOQ, so it can
// never prove what a historical costing was based on — which is exactly why
// Chunk 3 exists. Until it does, this returns the number and calls it
// provisional, every time, with no way for a caller to ask for it otherwise.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");

/* Lazily required: the Store model graph is large and a costing that never
   asks about an item should not pay for it. */
const models = () => ({
  Vendor: require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor"),
  RawItem: require("../../models/CMS_Models/Inventory/Products/RawItem"),
  Unit: require("../../models/CMS_Models/Inventory/Configurations/Unit"),
  Service: require("../../models/CMS_Models/Inventory/Services/Service"),
});

/**
 * Every read here demands a context that NAMES a company and says why.
 *
 * Deliberately awkward, and the same shape
 * `companyContext.forService({companyId, reason})` produces: there is no
 * ambient "system" context that silently becomes global, which is how a
 * background job quietly crosses tenants.
 */
function assertServiceContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Store facts cannot be read without a company.", {
      reason: "SERVICE_CONTEXT_REQUIRED",
    });
  }
  if (!ctx.reason && !ctx.actorId) {
    throw fail("VALIDATION", "A service read of Store facts must state its reason.", {
      reason: "SERVICE_REASON_REQUIRED",
    });
  }
  return ctx;
}

const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);

/** The company filter, in the same object as the id. Never a second step. */
const scoped = (ctx, extra) => ({ companyId: ctx.companyId, ...extra });

/**
 * A supplier's identity — who they are, not what they charge.
 *
 * Returns `null` for a supplier in another company exactly as for one that
 * does not exist: a service read has no more right to distinguish the two than
 * an HTTP one.
 */
async function supplierIdentity(ctx, supplierId) {
  assertServiceContext(ctx);
  const id = oid(supplierId);
  if (!id) return null;
  const { Vendor } = models();
  const v = await Vendor.findOne(scoped(ctx, { _id: id }))
    .select("companyName vendorType contactPerson email phone gstNumber status")
    .lean();
  if (!v) return null;
  return {
    supplierId: String(v._id),
    name: v.companyName || "",
    type: v.vendorType || "",
    gstNumber: v.gstNumber || "",
    status: v.status || "",
  };
}

/**
 * An item's identity, its purchase UoM and its tax facts — plus, per variant,
 * the legacy alias prices, labelled.
 *
 * `variantId` narrows the answer to one variant; omitted, every variant is
 * returned. Either way nothing about another company's items is reachable.
 */
async function itemFacts(ctx, itemId, { variantId = null } = {}) {
  assertServiceContext(ctx);
  const id = oid(itemId);
  if (!id) return null;
  const { RawItem, Vendor } = models();
  const item = await RawItem.findOne(scoped(ctx, { _id: id }))
    .select("name sku category unit variants primaryVendor alternateVendors status")
    .lean();
  if (!item) return null;

  const wanted = (item.variants || []).filter((v) => !variantId || String(v._id) === String(variantId));

  /* ── PROVING THE ITEM'S COMPANY IS NOT PROVING ITS REFERENCES' ──────────
   * The first version stopped at the item: it checked that the RawItem
   * belonged to the reading company and then returned `primaryVendor`,
   * `alternateVendors` and every `vendorNicknames[].vendor` straight out of
   * the document, with the alias price attached.
   *
   * A reference is not a fact about the item; it is a fact about a SUPPLIER,
   * and a company-scoped item can carry one to a supplier in another company —
   * through a migration, a copied record, or simply an id typed in before the
   * boundary existed. Returning it discloses that another company's supplier
   * exists, hands over its internal id, and attaches a price to it. Chunk 3
   * will turn exactly these references into quotations.
   *
   * So every referenced supplier is resolved in ONE company-scoped query, and
   * anything that does not come back — foreign, deleted, unowned — is omitted.
   * Omitted, not nulled and not annotated: saying "there is a supplier here you
   * may not see" is still saying it exists. */
  const referenced = [
    item.primaryVendor,
    ...(item.alternateVendors || []),
    ...wanted.flatMap((v) => (v.vendorNicknames || []).map((n) => n.vendor)),
  ].filter(Boolean);

  const proven = referenced.length
    ? await Vendor.find(scoped(ctx, { _id: { $in: referenced } })).select("_id").lean()
    : [];
  const ours = new Set(proven.map((v) => String(v._id)));

  const variants = wanted.map((v) => ({
    variantId: String(v._id),
    name: v.name || "",
    sku: v.sku || "",
    category: v.category || "",
    /* The unit the item is BOUGHT in, which is the one a supplier quotes
       against — not a converted display unit. */
    purchaseUom: v.unit || item.unit || "",
    aliasPrices: (v.vendorNicknames || [])
      /* The alias price goes with its supplier. An alias whose supplier is not
         ours is not "a price with an unknown supplier" — it is another
         company's commercial fact, and it leaves entirely. */
      .filter((n) => n.vendor && ours.has(String(n.vendor)))
      .map((n) => ({
        supplierId: String(n.vendor),
        supplierAlias: n.nickname || "",
        priceMajor: typeof n.price === "number" ? n.price : null,
        deliveryDays: typeof n.deliveryDays === "number" ? n.deliveryDays : null,
        /* ── PROVISIONAL, ALWAYS ────────────────────────────────────────
           Proving the supplier is ours does not make the number a quotation.
           It is still a mutable field somebody typed, with no reference, no
           validity and no MOQ — which is why Chunk 3 exists. */
        confidence: "PROVISIONAL",
        evidence: "LEGACY_ALIAS_FIELD",
      })),
  }));

  return {
    itemId: String(item._id),
    name: item.name || "",
    sku: item.sku || "",
    category: item.category || "",
    purchaseUom: item.unit || "",
    /* ── TAX FACTS ARE NOT ON THIS MASTER, AND THAT IS REPORTED ──────────
       RawItem has no HSN code and no GST rate — not blank ones, none at all.
       A supplier offer needs both, so this is a real gap in what Chunk 3
       depends on rather than a field this function forgot to select.
       Returning empty strings would read as "this item has no HSN", which is a
       different and untrue statement, and one a costing would later treat as
       zero-rated. */
    tax: {
      available: false,
      reason: "NOT_MODELLED_ON_RAW_ITEM",
      hsnCode: null,
      gstRatePercent: null,
    },
    primarySupplierId: item.primaryVendor && ours.has(String(item.primaryVendor))
      ? String(item.primaryVendor) : null,
    alternateSupplierIds: (item.alternateVendors || [])
      .filter((v) => ours.has(String(v))).map(String),
    variants,
  };
}

/**
 * A unit and the conversions declared on it.
 *
 * ── CONVERSION ARITHMETIC IS NOT DUPLICATED HERE ────────────────────────────
 * This returns the declared FACTS — which unit converts to which, and by what
 * factor — and nothing computes with them. A second implementation of unit
 * conversion inside costing would be a second answer to a question the Store
 * master already answers, and the two would disagree the first time somebody
 * edited a factor.
 *
 * A conversion whose target belongs to another company is dropped rather than
 * returned: a cross-company factor is not a fact this company may use, and
 * silently including it would put another company's arithmetic into a costing.
 */
async function unitFacts(ctx, unitIdOrName) {
  assertServiceContext(ctx);
  const { Unit } = models();
  const id = oid(unitIdOrName);
  const unit = await Unit.findOne(
    scoped(ctx, id ? { _id: id } : { name: String(unitIdOrName || "").trim() }),
  ).select("name symbol status conversions").lean();
  if (!unit) return null;

  const targets = (unit.conversions || []).map((c) => c.toUnit).filter(Boolean);
  const reachable = targets.length
    ? await Unit.find(scoped(ctx, { _id: { $in: targets } })).select("_id name").lean()
    : [];
  const byId = new Map(reachable.map((u) => [String(u._id), u.name]));

  return {
    unitId: String(unit._id),
    name: unit.name || "",
    symbol: unit.symbol || "",
    status: unit.status || "",
    conversions: (unit.conversions || [])
      /* Cross-company targets are absent, not merely unnamed. */
      .filter((c) => c.toUnit && byId.has(String(c.toUnit)))
      .map((c) => ({
        toUnitId: String(c.toUnit),
        toUnitName: byId.get(String(c.toUnit)),
        /* Unit's persisted conversion schema calls this `quantity`: one
           source unit equals this many target units. Keep the Costing-facing
           name `factor`, but never read a field the master does not store. */
        factor: c.quantity ?? null,
      })),
  };
}

/**
 * One service's identity and lifecycle, from the company-scoped Service Master.
 *
 * ── WHAT IS DELIBERATELY NOT RETURNED ───────────────────────────────────────
 * `defaultRate`. The master's own schema calls it "an estimate for planning,
 * NOT an approved cost and not an invoice price", and a costing that could
 * reach it would eventually use it — at which point a frozen version would
 * cite a number nobody quoted, with no supplier, no date and no reference
 * behind it. It is not withheld by convention: it is not in the projection, so
 * there is nothing here to read it from.
 *
 * `null` for a service that is not this company's — the same non-disclosing
 * answer `supplierIdentity` gives, for the same reason.
 */
async function serviceFacts(ctx, serviceId) {
  assertServiceContext(ctx);
  const id_ = oid(serviceId);
  if (!id_) return null;
  const { Service } = models();
  const doc = await Service.findOne(scoped(ctx, { _id: id_ }))
    .select("serviceCode name category billingUnit sacCode defaultGstRate status")
    .lean();
  if (!doc) return null;
  return Object.freeze({
    serviceId: String(doc._id),
    serviceCode: doc.serviceCode || "",
    name: doc.name || "",
    category: doc.category || "",
    /* How the MASTER says it is billed. Informational: what a costing measures
       against is the requirement's own unit and the quotation's, which have to
       agree with each other. */
    billingUnit: doc.billingUnit || "",
    sacCode: doc.sacCode || "",
    defaultGstRatePercent: doc.defaultGstRate ?? null,
    status: doc.status || "",
    active: String(doc.status || "").toUpperCase() === "ACTIVE",
  });
}

module.exports = { assertServiceContext, supplierIdentity, itemFacts, unitFacts, serviceFacts };
