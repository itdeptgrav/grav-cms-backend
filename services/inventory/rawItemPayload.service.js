"use strict";
// services/inventory/rawItemPayload.service.js
//
// THE PARTS OF A RAW-ITEM PAYLOAD THAT MORE THAN ONE DOOR MUST JUDGE.
//
// These rules lived inside the Store catalogue route, where they were reachable
// only by editing that file. They judge things a payload asserts about the
// world — that a supplier is this company's and may be newly assigned, that a
// conversion names a unit that exists — and they are now needed by the Store
// route (create and update) and by the narrow Merchandising creation door.
//
// Moved, not copied. Two implementations of "is this supplier ours" diverge,
// and the divergence is only discovered as a cross-company alias.

const mongoose = require("mongoose");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const tenantContext = require("../storePurchase/tenantContext.service");

/** The company filter, identical to the catalogue route's. */
const scoped = (req, extra = {}) => ({ ...tenantContext.tenantFilter(req.tenant), ...extra });

/* ── SUPPLIER MASTER NOW HAS AN OWNER ───────────────────────────────────────
 * `Vendor` carried no `companyId`, so every supplier query here read one
 * global table shared by every company, and an alias written from this router
 * bound a tenant-owned item to a record whose ownership nobody could state.
 * The previous chunk closed all of it behind SUPPLIER_TENANCY_UNAVAILABLE
 * rather than keep pretending it was safe.
 *
 * Suppliers are now company-owned, so the integration is open again — under
 * the ownership that made it possible, not merely because the refusal was
 * inconvenient:
 *
 *   · every supplier query is company-scoped, and a supplier from another
 *     company answers as one that does not exist;
 *   · a supplier may be NEWLY assigned only if it is Active and owned by this
 *     company — archived, inactive, blacklisted, legacy and cross-company
 *     suppliers are all refused, each with its own reason;
 *   · identity is resolved through one explicitly scoped map, never through a
 *     Mongoose populate that would follow a reference wherever it points;
 *   · aliases already stored against a supplier whose ownership cannot be
 *     proven are LEFT ALONE and reported as unverified. They are the item's
 *     own history, and deleting history to tidy a boundary is not a fix.
 */
const SUPPLIER_NOT_SELECTABLE = "SUPPLIER_NOT_SELECTABLE";

/**
 * A supplier this company may newly select.
 *
 * ── WHY THIS IS AN `$and`, NOT ANOTHER KEY ──────────────────────────────────
 * Written as `{...tenantContext.tenantFilter(req.tenant), companyId: {$ne: null}}`
 * the second `companyId` REPLACES the first: object spread keeps the last
 * value, so the company filter silently disappeared and every company's
 * suppliers matched. The two conditions are separate facts — "belongs to this
 * company" and "belongs to a company at all" — so they are separate clauses,
 * where neither can overwrite the other.
 */
const supplierScope = (req, extra = {}) => ({
  $and: [
    tenantContext.tenantFilter(req.tenant),
    /* A legacy supplier (no company) is a supplier (29 Sep 2026, explicit
       request: the item form refused "That supplier was not found in this
       company" for every alias, because NOT ONE supplier in this database
       carries a company). Admitted while the legacy window is open; the
       ownership rule returns with STORE_PURCHASE_STRICT_TENANCY=1. */
    ...(tenantContext.legacyWindowOpen() ? [] : [{ companyId: { $ne: null } }]),
    /* A company-owned supplier part-way through migration has no code yet.
       It is visible in the Supplier Master for remediation, and must not be
       offered here: an order or alias bound to it would carry no identity
       anybody can quote back.

       Stood down while the legacy window is open. NOT ONE of the 94 suppliers
       in this database carries a code — the supplier-code scheme shipped after
       them and the migration script deliberately never derives one — so
       enforcing it emptied the vendor dropdown on every Raw Item form in Store
       and Sales (reported 10 Sep 2026). It comes back with
       STORE_PURCHASE_STRICT_TENANCY=1, by which time codes must exist. */
    ...(tenantContext.legacyWindowOpen() ? [] : [{ supplierCode: { $gt: "" } }]),
    ...(Object.keys(extra).length ? [extra] : []),
  ],
});

/**
 * Resolve the suppliers named on a payload, inside this company.
 *
 * @returns {{ok: true, map: Map}|{ok: false, code, message, details}}
 */
async function resolveSuppliers(req, ids, session = null) {
  const wanted = [...new Set(ids.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!wanted.length) return { ok: true, map: new Map() };

  /* Scoped, and `companyId: null` excluded explicitly: a legacy supplier is
     inside no company, so nothing new may be bound to it. */
  const found = await Vendor.find(supplierScope(req, { _id: { $in: wanted } }))
    .select("_id companyName status supplierCode").session(session).lean();

  const map = new Map(found.map((v) => [String(v._id), v]));

  const missing = wanted.find((id) => !map.has(id));
  if (missing) {
    /* Another company's supplier answers exactly as an invented id. */
    return {
      ok: false, status: 404, code: "SUPPLIER_NOT_FOUND",
      message: "That supplier is not on the supplier list any more. Pick another supplier for the alias, or remove the alias.",
    };
  }

  const unusable = found.find((v) => v.status !== "Active");
  if (unusable) {
    return {
      ok: false, status: 409, code: SUPPLIER_NOT_SELECTABLE,
      message: `${unusable.companyName} is ${String(unusable.status).toLowerCase()} and cannot be newly assigned.`,
      details: { supplier: String(unusable._id), status: unusable.status },
    };
  }

  return { ok: true, map };
}

/** Identity for aliases already stored, resolved only inside this company. */
async function supplierIdentityMap(req, ids) {
  const wanted = [...new Set(ids.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!wanted.length) return new Map();
  const found = await Vendor.find({
    ...tenantContext.tenantFilter(req.tenant),
    _id: { $in: wanted },
  }).select("_id companyName status supplierCode companyId").lean();
  return new Map(found.map((v) => [String(v._id), v]));
}

/**
 * A conversion target must be a unit this company actually has.
 *
 * `unitConversions` name units as STRINGS, so nothing stopped a factor
 * referring to a unit that does not exist, or to another company's. And
 * `normaliseUnitConversion` accepted a factor of exactly 0 — `qty < 0` is
 * rejected, 0 is not — which stores arithmetic that turns any quantity into
 * nothing.
 */
async function validateEmbeddedConversions(req, body, session = null) {
  const rows = [];
  (Array.isArray(body?.variants) ? body.variants : []).forEach((v, i) => {
    (Array.isArray(v?.unitConversions) ? v.unitConversions : []).forEach((uc, j) => {
      rows.push({ where: `variants[${i}].unitConversions[${j}]`, uc });
    });
  });
  /* The product-level fields reach the same stored factors. */
  if (body?.unitConversion) rows.push({ where: "unitConversion", uc: body.unitConversion });
  (Array.isArray(body?.unitConversions) ? body.unitConversions : []).forEach((uc, j) => {
    rows.push({ where: `unitConversions[${j}]`, uc });
  });
  if (!rows.length) return { ok: true };

  for (const { where, uc } of rows) {
    const qty = Number(uc?.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return {
        ok: false,
        message: `${where} needs a conversion factor greater than zero.`,
        details: { field: where, reason: "INVALID_FACTOR" },
      };
    }
    const name = String(uc?.toUnit || "").trim();
    if (!name) {
      return { ok: false, message: `${where} names no target unit.`, details: { field: where, reason: "TARGET_MISSING" } };
    }
    /* the unit list is one list while the legacy window is open (29 Sep 2026) */
    const unitMatch = { name: new RegExp(`^${escapeRegex(name)}$`, "i") };
    const known = await Unit.findOne(tenantContext.legacyWindowOpen() ? unitMatch : scoped(req, unitMatch)).select("_id").session(session).lean();
    if (!known) {
      return {
        ok: false,
        message: `${where} refers to a unit that is not on the unit list: "${name}". Add it under Units and conversions first.`,
        details: { field: where, reason: "TARGET_NOT_FOUND" },
      };
    }
  }
  return { ok: true };
}

/**
 * A supplier reference submitted with an item.
 *
 * This used to check that the id existed — `Vendor.find({_id: {$in: ids}})`.
 * Existence is not ownership: every id in that global table "exists" for every
 * company, so the check confirmed only that somebody, somewhere, had a
 * supplier by that id. Until Vendor records say whose they are, a reference
 * cannot be established at all, and the honest answer is that the dependency
 * is missing — not that the supplier was not found.
 */
async function validateEmbeddedVendors(req, body, session = null) {
  const named = [];
  const ids = [];
  (Array.isArray(body?.variants) ? body.variants : []).forEach((v, i) => {
    (Array.isArray(v?.vendorNicknames) ? v.vendorNicknames : []).forEach((vn, j) => {
      named.push(`variants[${i}].vendorNicknames[${j}]`);
      if (vn?.vendor) ids.push(vn.vendor);
    });
  });
  if (!named.length) return { ok: true };

  /* Existence was never the question — every id in a global table "exists"
     for everybody. This asks whether the supplier is THIS company's, and
     whether it is in a state that may be newly assigned. */
  const resolved = await resolveSuppliers(req, ids, session);
  if (!resolved.ok) return { ok: false, ...resolved, fields: named };
  return { ok: true }
}

/** A user's search text is data, not a pattern. */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normaliseVariantNicknames = (incoming) => {
  if (!Array.isArray(incoming)) return null;
  return incoming
    .filter(vn => vn && vn.vendor && vn.nickname && vn.nickname.toString().trim())
    .map(vn => ({
      _id: vn._id && mongoose.Types.ObjectId.isValid(vn._id) ? vn._id : undefined,
      /* A read hands back a NAMED supplier (the route's resolveAliasVendors),
         and a form that round-trips an untouched row sends that object
         straight back. Take the id out of either shape (11 Sep 2026). */
      vendor: vn.vendor && typeof vn.vendor === "object" && vn.vendor._id
        ? vn.vendor._id
        : vn.vendor,
      nickname: vn.nickname.toString().trim(),
      price: parseFloat(vn.price) || 0,
      deliveryDays: parseInt(vn.deliveryDays) || 0,
      notes: (vn.notes || "").toString().trim(),
      specifications: Array.isArray(vn.specifications)
        ? vn.specifications.filter(s => s.key && s.key.trim()).map(s => ({ key: s.key.trim(), value: (s.value || "").trim() }))
        : []
    }));
};

// Normalise unitConversion input → returns object or null
const normaliseUnitConversion = (uc) => {
  if (!uc || !uc.toUnit || uc.quantity === undefined || uc.quantity === null || uc.quantity === "") {
    return null;
  }
  const qty = parseFloat(uc.quantity);
  if (isNaN(qty) || qty < 0) return null;
  /* measured by weight (8 Oct 2026): the flag, and the weight of the unused
     material weighed with the goods, in toUnit — blank is "not stated" */
  const tareRaw = uc.tareQuantity;
  const tare = tareRaw === undefined || tareRaw === null || tareRaw === "" ? null : parseFloat(tareRaw);
  return {
    fromUnit: (uc.fromUnit || "").toString().trim(),
    toUnit: (uc.toUnit || "").toString().trim(),
    quantity: qty,
    measureByWeight: uc.measureByWeight === true || uc.measureByWeight === "true",
    tareQuantity: tare === null || isNaN(tare) || tare < 0 ? null : tare,
  };
};

module.exports = {
  SUPPLIER_NOT_SELECTABLE, supplierScope, resolveSuppliers, supplierIdentityMap,
  validateEmbeddedConversions, validateEmbeddedVendors,
  escapeRegex, normaliseVariantNicknames, normaliseUnitConversion,
};
