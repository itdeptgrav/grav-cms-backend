"use strict";
/**
 * services/storePurchase/supplierOfferRead.service.js
 *
 * Store & Purchase — THE ONE DOOR CENTRAL COSTING READS OFFERS THROUGH.
 *
 * ── WHY A SERVICE AND NOT AN HTTP CALL ──────────────────────────────────────
 * Costing runs in this process. Calling the Store's own router over HTTP would
 * mean the costing engine carrying a Store session, re-authenticating as
 * somebody, and depending on a network hop inside one runtime — and the first
 * time that call failed, a costing would silently price without offers. This
 * is an in-process read that takes an explicit company and states its reason.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 * It reads. There is no write here, no model returned and no document handle:
 * every answer is a plain object, so a caller cannot save through it, and
 * Central Costing cannot mutate a master that is not its own.
 *
 * ── AND WHAT "CURRENT" MEANS ────────────────────────────────────────────────
 * ACTIVE, effective by the costing date, and not expired by it. A draft is not
 * a price, a withdrawn one was pulled, a superseded one was replaced, and a
 * future one has not started. None of them may be handed back as current —
 * this is the one place that decision is made, so a caller cannot make a
 * different one.
 */

const mongoose = require("mongoose");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const offers = require("./supplierOffer.service");
const { fail } = require("./errors");

/** Same contract as `storeFacts`: a company, and a stated reason. */
function assertReadContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Supplier offers cannot be read without a company.", {
      reason: "SERVICE_CONTEXT_REQUIRED",
    });
  }
  if (!ctx.reason && !ctx.actorId) {
    throw fail("VALIDATION", "A service read of supplier offers must state its reason.", {
      reason: "SERVICE_REASON_REQUIRED",
    });
  }
  return ctx;
}

/**
 * Plain, immutable facts about one offer. Frozen, so a caller that tried to
 * adjust a price before using it would fail loudly rather than quietly.
 */
const factsOf = (doc) => Object.freeze({
  offerId: String(doc._id),
  supplierId: String(doc.supplierId),
  supplierName: doc.supplierName || "",
  itemId: String(doc.itemId),
  variantId: doc.variantId ? String(doc.variantId) : null,
  supplierItemCode: doc.supplierItemCode || null,
  /* ── THE SUPPLIER'S OWN NAME FOR IT, AND WHERE THE PAPER IS ────────────
     Both were stored and neither reached a costing. A frozen provenance that
     carries a code but not the name is unreadable the moment the supplier
     recodes their catalogue, and one with no document reference cannot be
     checked against the quotation it claims to come from. */
  supplierItemName: doc.supplierItemName || null,
  document: doc.document && (doc.document.label || doc.document.url || doc.document.storedAt)
    ? Object.freeze({
      label: doc.document.label || "",
      url: doc.document.url || "",
      storedAt: doc.document.storedAt || "",
    })
    : null,
  purchaseUom: doc.purchaseUom,
  currency: doc.currency,
  unitPriceMinor: doc.unitPriceMinor,
  priceBasis: doc.priceBasis,
  /* Null, never 0 — an unrecorded rate is not a zero-rated quotation, and a
     costing that treated it as one would under-cost every line. */
  gstRatePercent: doc.gstRatePercent === undefined || doc.gstRatePercent === null
    ? null : doc.gstRatePercent,
  hsnCode: doc.hsnCode || null,
  moq: doc.moq ?? null,
  orderMultiple: doc.orderMultiple ?? null,
  leadTimeDays: doc.leadTimeDays ?? null,
  tiers: Array.isArray(doc.tiers) && doc.tiers.length
    ? Object.freeze(doc.tiers.map((t) => Object.freeze({
      minQuantity: t.minQuantity,
      /* The ceiling the register began requiring on non-final tiers.
         Dropping it here made every tier read as open-ended, so a quantity
         past a bounded tier still matched it — the price the supplier had
         deliberately capped. */
      maxQuantity: t.maxQuantity === undefined || t.maxQuantity === null ? null : t.maxQuantity,
      unitPriceMinor: t.unitPriceMinor,
    })))
    : null,
  /* ── DOES THIS RATE ALREADY INCLUDE GETTING IT HERE? ────────────────
     `INCLUSIVE_LANDED`, `EXCLUSIVE`, or absent — and absent is an unanswered
     question, not an answer. It decides whether the material cost is
     complete or is short the inbound freight on every metre. */
  freightTerms: doc.freightTerms || null,
  incoterm: doc.incoterm || null,
  quotationReference: doc.quotationReference || null,
  /* The date on the supplier's own paper — not when the price starts and not
     when somebody typed it in. */
  quotationDate: doc.quotationDate || null,
  /* ── READABLE AFTER THE MASTERS MOVE ON ────────────────────────────────
     Names and codes travel with the facts, because an id is not evidence: a
     costing frozen in March must still say what it costed after the item has
     been renamed and the supplier has recoded their catalogue. */
  itemName: doc.itemName || "",
  itemSku: doc.itemSku || "",
  variantLabel: doc.variantLabel || null,
  supplierItemName: doc.supplierItemName || null,
  /* A REFERENCE to where the quotation is filed — never the file. */
  document: doc.document?.label || doc.document?.url
    ? Object.freeze({
      label: doc.document.label || "",
      url: doc.document.url || "",
      storedAt: doc.document.storedAt || "",
    })
    : null,
  effectiveFrom: doc.effectiveFrom || null,
  validUntil: doc.validUntil || null,
  revision: doc.revision ?? 1,
  /* Carried so a costing version can snapshot WHICH quotation it used. */
  status: doc.status,
});

/**
 * Every offer that is genuinely current for one item, at one instant.
 *
 * `asOf` is a parameter rather than "now": a costing calculated for a date
 * must resolve the offer that was in force THEN, and a function that read the
 * clock itself could not answer that.
 */
async function currentOffersForItem(ctx, itemId, { variantId = null, asOf = new Date() } = {}) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(itemId || ""))) return [];

  const q = {
    companyId: ctx.companyId,
    itemId: new mongoose.Types.ObjectId(String(itemId)),
    /* Only ACTIVE reaches the query at all — draft, withdrawn and superseded
       are excluded here rather than filtered out later, so there is no path
       on which one of them is briefly a candidate. */
    status: "ACTIVE",
    $and: [
      { $or: [{ effectiveFrom: { $lte: asOf } }, { effectiveFrom: null }, { effectiveFrom: { $exists: false } }] },
      { $or: [{ validUntil: { $gte: asOf } }, { validUntil: null }, { validUntil: { $exists: false } }] },
    ],
  };
  /* A variant-specific quotation and an item-wide one are both candidates for
     that variant; only a quotation for a DIFFERENT variant is not. */
  if (variantId) {
    q.$and.push({ $or: [{ variantId: new mongoose.Types.ObjectId(String(variantId)) }, { variantId: null }, { variantId: { $exists: false } }] });
  }

  const rows = await SupplierOffer.find(q).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
  /* Confirmed against the same derivation the register uses, so the two can
     never disagree about what "current" means. */
  return rows
    .filter((r) => offers.isSelectable(r, asOf))
    .map(factsOf);
}

/** One offer by id, only if it is current at `asOf`. Otherwise null. */
async function currentOfferById(ctx, offerId, { asOf = new Date() } = {}) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(offerId || ""))) return null;
  const doc = await SupplierOffer.findOne({
    companyId: ctx.companyId, _id: new mongoose.Types.ObjectId(String(offerId)),
  }).lean();
  if (!doc) return null;
  /* An offer that exists but is not current answers `null`, not a fact with a
     flag on it — a flag is something a caller can forget to read. */
  return offers.isSelectable(doc, asOf) ? factsOf(doc) : null;
}

/* ══ APPLICABILITY ══════════════════════════════════════════════════════════
 *
 * `currentOffersForItem` above answers "which quotations are live?" and
 * silently drops the rest, which is the right answer for a caller that only
 * wants prices and the wrong one for a person looking at a screen. A buyer who
 * entered a quotation yesterday and is told "no quotations" has learnt
 * nothing; "expired on the 3rd" tells them what to do next.
 *
 * So this returns EVERY quotation for the item and hands the whole list to the
 * pure resolver, which decides each one and names the reason. */

const applicability = require("./offerApplicability");

/** Every quotation for an item, whatever its state — the resolver judges them. */
async function candidateOffersForItem(ctx, itemId, { variantId = null } = {}) {
  assertReadContext(ctx);
  if (!mongoose.Types.ObjectId.isValid(String(itemId || ""))) return [];
  const q = {
    companyId: ctx.companyId,
    itemId: new mongoose.Types.ObjectId(String(itemId)),
  };
  /* A quotation for a DIFFERENT variant is not a candidate at all — it is not
     an exclusion the buyer needs explained, it is simply somebody else's line.
     Item-wide quotations (no variant) stay in. */
  if (variantId) {
    q.$or = [
      { variantId: new mongoose.Types.ObjectId(String(variantId)) },
      { variantId: null }, { variantId: { $exists: false } },
    ];
  }
  return SupplierOffer.find(q).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
}

/**
 * Which quotations can supply `quantity` of this item, and why the rest cannot.
 *
 * ── THE FACTS THE OFFER RECORDS CANNOT KNOW ABOUT THEMSELVES ────────────────
 * Whether the supplier is still active, and whether the purchase unit converts
 * to the one the caller is measuring in. Both are looked up here, company
 * scoped, and handed to the pure resolver — which opens no connection of its
 * own and can therefore be tested against the awkward cases directly.
 *
 * ── ONE FACT THIS DELIBERATELY DOES NOT CLAIM ───────────────────────────────
 * `itemActive` is passed as `null`, meaning "not checked", because the RawItem
 * master has no lifecycle flag: its `status` is derived from quantity against
 * minimum stock ("In Stock" / "Low Stock" / "Out of Stock"), which is a
 * warehouse fact and not a discontinuation. Treating "Out of Stock" as
 * inactive would refuse to cost every item that happens to be empty today —
 * which is most of what a costing is FOR. The resolver keeps the
 * `INACTIVE_ITEM` reason for when the item master gains a real one; until
 * then, a null fact is never read as a pass or a fail.
 */
async function applicableOffersForItem(ctx, {
  itemId, variantId = null, quantity, requestedUom, asOf = new Date(),
} = {}) {
  assertReadContext(ctx);
  const candidates = await candidateOffersForItem(ctx, itemId, { variantId });
  if (!candidates.length) {
    return { applicable: [], excluded: [], lowestApplicableOfferId: null, lowestApplicableRateMinor: null };
  }

  /* Supplier status, once per distinct supplier rather than once per offer —
     a register with forty quotations from six suppliers is six reads. */
  const storeFacts = require("../centralCosting/storeFacts.service");
  const factsCtx = { companyId: ctx.companyId, actorId: ctx.actorId, reason: ctx.reason || "offer_applicability" };
  const supplierIds = [...new Set(candidates.map((c) => String(c.supplierId)))];
  const statuses = new Map();
  for (const sid of supplierIds) {
    /* ── NOT CAUGHT ────────────────────────────────────────────────────────
       `supplierIdentity` RETURNS null for a supplier that is not this
       company's, and THROWS when it cannot read at all. Catching both and
       calling the result "inactive" turned a database blip into a settled
       commercial statement — a quotation refused as INACTIVE_SUPPLIER, and
       somebody sent to re-negotiate a relationship that is perfectly fine.
       An outage is an outage and travels up as one. */
    const s = await storeFacts.supplierIdentity(factsCtx, sid);
    /* Absent means the supplier is not this company's — which the offer's own
       company scope should already have prevented, so it is recorded as
       inactive rather than waved through. */
    statuses.set(sid, s ? String(s.status || "active").toLowerCase() === "active" : false);
  }

  /* Conversions, once per distinct purchase unit. */
  const uomCache = new Map();
  const conversionFor = ({ from, to }) => {
    const f = String(from || "").trim();
    const t = String(to || "").trim();
    if (!f || !t) return { configured: false, reason: "UOM_NOT_RECORDED", from: f || null, to: t || null };
    if (f.toLowerCase() === t.toLowerCase()) {
      return { configured: true, sameUnit: true, factor: "1", from: f, to: t, path: `${f} → ${t} (same unit)` };
    }
    const unit = uomCache.get(f.toLowerCase());
    const hit = (unit?.conversions || []).find(
      (c) => String(c.toUnitName || "").toLowerCase() === t.toLowerCase(),
    );
    if (hit && Number.isFinite(Number(hit.factor)) && Number(hit.factor) > 0) {
      return { configured: true, sameUnit: false, factor: String(hit.factor), from: f, to: t, path: `1 ${f} = ${hit.factor} ${t}` };
    }
    /* Not configured is a refusal, never a guessed 1:1 — treating a metre as
       a kilogram is a different number, not an approximation. */
    return { configured: false, reason: "CONVERSION_NOT_CONFIGURED", from: f, to: t };
  };
  for (const uom of new Set(candidates.map((c) => String(c.purchaseUom || "").trim()).filter(Boolean))) {
    uomCache.set(uom.toLowerCase(), await storeFacts.unitFacts(factsCtx, uom).catch(() => null));
  }

  return applicability.resolveApplicableOffers({
    offers: candidates,
    criteria: { companyId: ctx.companyId, itemId, variantId, quantity, requestedUom, asOf },
    facts: {
      supplierActive: (sid) => statuses.get(String(sid)) ?? null,
      itemActive: null,
      conversionFor,
    },
  });
}

module.exports = {
  assertReadContext, currentOffersForItem, currentOfferById,
  candidateOffersForItem, applicableOffersForItem,
  EXCLUSIONS: applicability.EXCLUSIONS,
};
