// routes/Cms_routes/Inventory/Products/rawItems.js
//
// Refactored from your existing file. Changes:
//   1. REMOVED: item-level /vendor-nicknames endpoints (3 routes)
//   2. ADDED: per-variant /:id/variants/:variantId/vendor-nicknames endpoints (4 routes)
//   3. UPDATED: GET /:id returns variants.vendorNicknames as stored refs
//      (no Vendor populate — Supplier Master has no company yet)
//   4. UPDATED: PUT /:id matches incoming variants by _id first, then combination
//      — preserves variant.image + variant.vendorNicknames if not in payload
//   5. UPDATED: POST / accepts variant.image + variant.vendorNicknames
//   6. ADDED: unitConversion accepted on POST / and PUT /:id (product-level)

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

/* ── Chunk 1B: the catalogue had authentication and nothing else ────────────
 * Every route below answered any signed-in employee, for any company, with no
 * capability check and no idempotency. Chunk 0 measured what that meant:
 *
 *   · S7 — the ordinary "edit item" PUT set `quantity` and every variant
 *     quantity directly, writing NO stock transaction. Correcting a typo in a
 *     description and correcting the balance on the shelf were the same
 *     request, and only one of them left a trace.
 *   · S12 — item creation took opening balances with no opening transaction,
 *     so stock appeared with no movement that explains it.
 *   · S11 — DELETE destroyed the item AND its embedded ledger, with no guard
 *     against open purchase orders or material requests referencing it.
 *
 * Reads now need `sp.read`; catalogue identity needs `sp.master.maintain`;
 * supplier aliases are procurement facts and need `sp.sourcing.manage`; and
 * anything that moves stock needs `sp.stock.adjust`, an idempotency key and a
 * movement record. Authentication alone grants nothing. */
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES, hasAll } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const stockAccountability = require("../../../../services/stockAccountability.service");

const RAW_ITEM_CATEGORIES = [
  "Fabric", "Thread", "Fasteners", "Elastic", "Interlining",
  "Trims", "Chemicals", "Patterns", "Labels", "Packaging",
  "Accessories", "Dyes", "Buttons", "Zippers", "Laces",
  "Ribbons", "Cords", "Tapes", "Piping", "Webbing"
];

router.use(EmployeeAuthMiddleware);
/* Every route below is tenant-resolved. A caller whose company cannot be
   proved is refused here rather than handed another company's catalogue. */
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
/* Item identity: name, code, category, unit, attributes, variants, thresholds. */
const canMaintain = [requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite];
/* Supplier aliases and their pricing are procurement facts about a commercial
   relationship, not catalogue identity. Granting them through the catalogue
   permission would let anyone who may rename an item also rewrite what a
   supplier calls it and what it costs. */
const canSource = [requireCapability(CAPABILITIES.SOURCING_MANAGE), refuseLegacyWrite];

/**
 * The company filter every query in this router applies.
 *
 * It said "every catalogue query is company-scoped" while two Unit reads and
 * every Vendor read ran globally — a comment that told a reviewer the boundary
 * was closed and stopped them looking. The Unit reads are scoped now and the
 * Vendor paths are closed; what remains outside it is stated where it happens,
 * not summarised away here.
 */
const scoped = (req, extra = {}) => ({ ...tenantContext.tenantFilter(req.tenant), ...extra });

/**
 * Fold caller-supplied search into a tenant filter without displacing it.
 *
 * In legacy mode the tenant filter IS an `$or` (companyId missing or null), so
 * assigning a search `$or` straight onto the filter would replace the company
 * scope entirely. Everything caller-supplied goes inside `$and`, where it can
 * only ever narrow.
 */
function scopedSearch(req, extra = {}) {
  const base = { ...tenantContext.tenantFilter(req.tenant) };
  const clauses = [];
  if (extra.$or) { clauses.push({ $or: extra.$or }); delete extra.$or; }
  Object.assign(base, extra);
  if (clauses.length) base.$and = [...(base.$and || []), ...clauses];
  return base;
}

/**
 * Which stronger authorities a payload actually needs.
 *
 * ── THE BYPASS THIS CLOSES ──────────────────────────────────────────────────
 * The dedicated endpoints are gated correctly: supplier aliases need
 * `sp.sourcing.manage`, conversion factors need `sp.config.manage`. But the
 * general create and update routes accept the SAME data embedded in the item
 * payload — `variants[].vendorNicknames` carries a supplier's name, price and
 * lead time; `variants[].unitConversions` carries conversion factors — and
 * they were gated on `sp.master.maintain` alone.
 *
 * So the stronger permissions protected the front door while the side door
 * stayed open: a master maintainer who could not touch supplier pricing
 * through `/vendor-nicknames` could set the identical fields by putting them
 * in the item form. A permission that can be sidestepped by choosing a
 * different endpoint is not a permission.
 *
 * The capability is therefore decided by WHAT THE PAYLOAD CHANGES, not by
 * which URL it arrived at. A mixed payload needs every capability its fields
 * imply.
 */
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
    { companyId: { $ne: null } },
    /* A company-owned supplier part-way through migration has no code yet.
       It is visible in the Supplier Master for remediation, and must not be
       offered here: an order or alias bound to it would carry no identity
       anybody can quote back. */
    { supplierCode: { $gt: "" } },
    ...(Object.keys(extra).length ? [extra] : []),
  ],
});

/**
 * Resolve the suppliers named on a payload, inside this company.
 *
 * @returns {{ok: true, map: Map}|{ok: false, code, message, details}}
 */
async function resolveSuppliers(req, ids) {
  const wanted = [...new Set(ids.map(String))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!wanted.length) return { ok: true, map: new Map() };

  /* Scoped, and `companyId: null` excluded explicitly: a legacy supplier is
     inside no company, so nothing new may be bound to it. */
  const found = await Vendor.find(supplierScope(req, { _id: { $in: wanted } }))
    .select("_id companyName status supplierCode").lean();

  const map = new Map(found.map((v) => [String(v._id), v]));

  const missing = wanted.find((id) => !map.has(id));
  if (missing) {
    /* Another company's supplier answers exactly as an invented id. */
    return {
      ok: false, status: 404, code: "SUPPLIER_NOT_FOUND",
      message: "That supplier was not found in this company.",
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

function sensitiveFieldsIn(body) {
  const sourcing = [];
  const conversion = [];

  const variants = Array.isArray(body?.variants) ? body.variants : [];
  variants.forEach((v, i) => {
    if (v && v.vendorNicknames !== undefined) sourcing.push(`variants[${i}].vendorNicknames`);
    if (v && v.unitConversions !== undefined) conversion.push(`variants[${i}].unitConversions`);
  });

  /* Item-level forms of the same facts, including the legacy singular. */
  for (const key of ["primaryVendor", "alternateVendors", "supplierCode", "supplierPrice", "leadTimeDays"]) {
    if (body?.[key] !== undefined) sourcing.push(key);
  }
  for (const key of ["unitConversion", "unitConversions"]) {
    if (body?.[key] !== undefined) conversion.push(key);
  }

  return { sourcing, conversion };
}

/**
 * Refuse before anything is written, naming what the caller would need.
 *
 * Deliberately a refusal rather than a silent strip: an operator who filled in
 * a supplier price, saved, and got a success message would reasonably believe
 * the price was recorded. Telling them which permission the change needs is
 * the only answer that lets them do something about it.
 */
function payloadAuthority(req, res, next) {
  const { sourcing, conversion } = sensitiveFieldsIn(req.body);
  const required = [];
  if (sourcing.length) required.push(CAPABILITIES.SOURCING_MANAGE);
  if (conversion.length) required.push(CAPABILITIES.CONFIG_MANAGE);
  if (!required.length) return next();

  if (hasAll(req.tenant?.capabilitySet, required)) return next();

  const missing = required.filter((c) => !hasAll(req.tenant?.capabilitySet, [c]));
  return sendError(res, fail(
    "FORBIDDEN",
    "This change includes supplier or conversion details that need additional permission.",
    {
      required: missing,
      fields: [
        ...(missing.includes(CAPABILITIES.SOURCING_MANAGE) ? sourcing : []),
        ...(missing.includes(CAPABILITIES.CONFIG_MANAGE) ? conversion : []),
      ],
    },
  ));
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
async function validateEmbeddedConversions(req, body) {
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
    const known = await Unit.findOne(scoped(req, {
      name: new RegExp(`^${escapeRegex(name)}$`, "i"),
    })).select("_id").lean();
    if (!known) {
      /* Another company's unit answers exactly as one that does not exist. */
      return {
        ok: false,
        message: `${where} refers to a unit this company does not have: "${name}".`,
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
async function validateEmbeddedVendors(req, body) {
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
  const resolved = await resolveSuppliers(req, ids);
  if (!resolved.ok) return { ok: false, ...resolved, fields: named };
  return { ok: true }
}

/** A user's search text is data, not a pattern. */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const computeStatus = (qty, minStock) => {
  const q = Number(qty) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "Out of Stock";
  if (q <= m) return "Low Stock";
  return "In Stock";
};

const applyComputedStatus = (item) => {
  if (!item) return item;
  item.status = computeStatus(item.quantity, item.minStock);
  if (Array.isArray(item.variants)) {
    item.variants = item.variants.map(v => ({
      ...v,
      status: computeStatus(v.quantity, v.minStock ?? item.minStock)
    }));
  }
  return item;
};

// Match incoming variant payload to existing variant doc:
// → first by _id (most reliable),
// → fallback by exact combination.
const matchExistingVariant = (incoming, existingList) => {
  if (incoming._id) {
    const byId = existingList.find(e => e._id?.toString() === incoming._id.toString());
    if (byId) return byId;
  }
  if (Array.isArray(incoming.combination) && incoming.combination.length) {
    return existingList.find(e =>
      Array.isArray(e.combination) &&
      e.combination.length === incoming.combination.length &&
      e.combination.every((v, i) => v === incoming.combination[i])
    );
  }
  return null;
};

const normaliseVariantNicknames = (incoming) => {
  if (!Array.isArray(incoming)) return null;
  return incoming
    .filter(vn => vn && vn.vendor && vn.nickname && vn.nickname.toString().trim())
    .map(vn => ({
      _id: vn._id && mongoose.Types.ObjectId.isValid(vn._id) ? vn._id : undefined,
      vendor: vn.vendor,
      nickname: vn.nickname.toString().trim(),
      price: parseFloat(vn.price) || 0,
      deliveryDays: parseInt(vn.deliveryDays) || 0,
      notes: (vn.notes || "").toString().trim(),
      specifications: Array.isArray(vn.specifications)
        ? vn.specifications.filter(s => s.key && s.key.trim()).map(s => ({ key: s.key.trim(), value: (s.value || "").trim() }))
        : []
    }));
};

// Map of unit name → { baseUnit, conversions: [{toUnit, factor}] }, resolved
// from the Unit master — the SAME source R&D's raw-item unit picker reads
// (routes/CMS_Routes/Inventory/Products/stockItems.js's own copy of this;
// duplicated rather than shared, same as sampleStyles.js's copy, since there
// is no shared lib between route files here). Used to hand a costing row's
// picked item its registered unit + conversions without the picker knowing
// anything about Units itself.
async function buildUnitConversionsMap(req) {
  try {
    /* ── THE MAP IS BUILT FROM ONE COMPANY'S ARITHMETIC ───────────────────
     * This read every Active unit in the database. Two companies may both
     * call a unit "roll" and mean 25 metres and 1000 metres — the map is keyed
     * by NAME, so whichever document happened to load last decided what every
     * company's rolls were worth, and the answer changed with insertion order.
     * A conversion factor from a company you cannot see is not a fallback; it
     * is someone else's arithmetic applied to your stock. */
    const units = await Unit.find(scoped(req, { status: "Active" }))
      .populate("conversions.toUnit", "name");
    const map = {};
    units.forEach(u => {
      if (!map[u.name]) map[u.name] = { baseUnit: u.name, conversions: [] };
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName) return;
        map[u.name].conversions.push({ toUnit: toUnitName, factor: c.quantity });
      });
    });
    units.forEach(u => {
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName || !c.quantity) return;
        if (!map[toUnitName]) map[toUnitName] = { baseUnit: toUnitName, conversions: [] };
        const alreadyHas = map[toUnitName].conversions.some(x => x.toUnit === u.name);
        if (!alreadyHas) map[toUnitName].conversions.push({ toUnit: u.name, factor: 1 / c.quantity });
      });
    });
    return map;
  } catch (err) {
    console.error("buildUnitConversionsMap:", err);
    return {};
  }
}

// Normalise unitConversion input → returns object or null
const normaliseUnitConversion = (uc) => {
  if (!uc || !uc.toUnit || uc.quantity === undefined || uc.quantity === null || uc.quantity === "") {
    return null;
  }
  const qty = parseFloat(uc.quantity);
  if (isNaN(qty) || qty < 0) return null;
  return {
    fromUnit: (uc.fromUnit || "").toString().trim(),
    toUnit: (uc.toUnit || "").toString().trim(),
    quantity: qty
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GET all raw items (pagination, search, filter)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", canRead, async (req, res) => {
  try {
    const {
      search = "",
      status,
      category,
      page = 1,
      limit = 20
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const skip = (pageNum - 1) * limitNum;

    /* ── SEARCH NARROWS; IT NEVER REPLACES ────────────────────────────────
     * Two problems lived here. The category clause ASSIGNED `$or`, wiping the
     * search clause assigned just above it — so filtering by category silently
     * discarded whatever the user had typed. And in legacy mode the tenant
     * filter is itself an `$or`, so either assignment would have replaced the
     * company scope with a search. Every caller-supplied clause now goes into
     * `$and`, where it can only ever narrow. */
    const clauses = [];
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      clauses.push({
        $or: [
          { name: re }, { sku: re }, { category: re }, { customCategory: re },
          { "variants.vendorNicknames.nickname": re },
        ],
      });
    }
    if (category) {
      clauses.push({ $or: [{ category }, { customCategory: category }] });
    }

    const filter = { ...tenantContext.tenantFilter(req.tenant) };
    if (clauses.length) filter.$and = clauses;

    let rawItems = await RawItem.find(filter)
      .select("-stockTransactions")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      /* No vendor populate: resolving a name out of an unowned global table
         is the leak, whichever route does it. The stored reference is
         returned as-is and labelled unverified. */
      .sort({ createdAt: -1 })
      .lean();

    rawItems = rawItems.map(applyComputedStatus);

    if (status) {
      rawItems = rawItems.filter(it => it.status === status);
    }

    const totalItems = rawItems.length;
    const paged = rawItems.slice(skip, skip + limitNum);

    // Attach each item's registered-unit conversions so a picker (e.g. the
    // Sales costing sheet) can offer "which unit" without a second round
    // trip per row — same map R&D's own raw-item picker resolves against.
    const unitConversionsMap = await buildUnitConversionsMap(req);
    paged.forEach((it) => {
      const unitName = it.customUnit || it.unit || "";
      it.unitConversions = unitConversionsMap[unitName]?.conversions || [];
    });

    const allForStats = await RawItem.find(scoped(req))
      .select("quantity minStock variants")
      .lean();

    let total = 0, lowStock = 0, outOfStock = 0, totalVariants = 0;
    allForStats.forEach(it => {
      total++;
      const s = computeStatus(it.quantity, it.minStock);
      if (s === "Low Stock") lowStock++;
      else if (s === "Out of Stock") outOfStock++;
      if (Array.isArray(it.variants)) totalVariants += it.variants.length;
    });

    res.json({
      success: true,
      rawItems: paged,
      pagination: {
        total: totalItems,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalItems / limitNum) || 1,
        hasNextPage: pageNum < Math.ceil(totalItems / limitNum),
        hasPrevPage: pageNum > 1
      },
      stats: {
        total,
        lowStock,
        outOfStock,
        totalVariants
      },
      filters: {
        categories: RAW_ITEM_CATEGORIES,
        statuses: ["In Stock", "Low Stock", "Out of Stock"]
      }
    });

  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items"
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET units
// ─────────────────────────────────────────────────────────────────────────────
router.get("/units", canRead, async (req, res) => {
  try {
    /* The same company boundary `/units` applies. This alias is a different
       door into the same vocabulary, and it was standing open. */
    const units = await Unit.find(scoped(req, { status: "Active" }))
      .select("name gstUqc")
      .sort({ name: 1 });

    res.json({
      success: true,
      units: units.map(u => u.name)
    });

  } catch (error) {
    console.error("Error fetching units:", error);
    res.status(500).json({ success: false, message: "Server error while fetching units" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET suppliers
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suppliers", canRead, async (req, res) => {
  try {
    /* Was `Vendor.find({status: "Active"})` — the whole table, to anybody
       signed in. Now: this company's Active suppliers, and only those, which
       are exactly the ones that may be newly assigned. */
    const suppliers = await Vendor.find(supplierScope(req, { status: "Active" }))
      .select("companyName vendorType supplierCode")
      .sort({ companyName: 1 })
      .lean();

    res.json({
      success: true,
      suppliers: suppliers.map((s) => ({
        id: s._id, name: s.companyName, type: s.vendorType, code: s.supplierCode || "",
      })),
    });
  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ success: false, message: "Server error while fetching suppliers" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET categories
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/categories", canRead, async (req, res) => {
  res.json({ success: true, categories: RAW_ITEM_CATEGORIES });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /accountability — every stock movement across every raw item, for a date
// range, with the totals and series the charts render.
//
// Registered BEFORE "/:id" — otherwise Express matches "/:id" first and treats
// "accountability" as a raw-item id.
//
// Query: from, to (ISO dates; default = today), category, search, page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/accountability", canRead, async (req, res) => {
  try {
    const { from, to, category = "ALL", search = "", page = 1, limit = 50 } = req.query;

    // Default to today — the store's normal question is "what moved today?".
    // Dates arrive as calendar days, so widen them to cover the whole day in
    // server-local time; a bare `new Date("2026-07-29")` is midnight UTC and
    // would silently drop or borrow movements either side of the boundary.
    const start = from ? new Date(from) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = to ? new Date(to) : new Date(from || Date.now());
    end.setHours(23, 59, 59, 999);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date range" });
    }
    if (start > end) {
      return res.status(400).json({ success: false, message: "'from' must be on or before 'to'" });
    }

    const rows = await stockAccountability.listMovements(start, end, { category, search });
    const summary = stockAccountability.summarise(rows, start, end);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
    const startIdx = (pageNum - 1) * perPage;

    res.json({
      success: true,
      // Summary is over the WHOLE range, not just the visible page — a chart
      // that only counted page 1 would be quietly wrong.
      ...summary,
      movements: rows.slice(startIdx, startIdx + perPage),
      pagination: {
        total: rows.length,
        page: pageNum,
        limit: perPage,
        totalPages: Math.max(1, Math.ceil(rows.length / perPage)),
      },
      range: { from: start, to: end },
      categories: Object.keys(stockAccountability.CATEGORY).map(k => ({
        key: k, label: stockAccountability.CATEGORY_LABEL[k],
      })),
    });
  } catch (error) {
    console.error("Error building accountability report:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /data/attributes-batch?ids=a,b,c — lightweight batch lookup of just the
// attribute definitions (name + values) for a set of raw items, so a BOM/raw-
// items list can label each variant's plain combination values with the
// attribute name they belong to (e.g. "Color: Red" instead of just "Red")
// without an N+1 fetch per row. Registered BEFORE "/:id" for the same reason
// as /accountability above.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/attributes-batch", canRead, async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => mongoose.Types.ObjectId.isValid(s));
    if (!ids.length) return res.json({ success: true, rawItems: [] });

    const docs = await RawItem.find(scoped(req, { _id: { $in: [...new Set(ids)] } }))
      .select("name sku attributes")
      .lean();

    res.json({
      success: true,
      rawItems: docs.map((d) => ({
        _id: d._id,
        name: d.name,
        sku: d.sku,
        attributes: d.attributes || [],
      })),
    });
  } catch (error) {
    console.error("Error fetching raw item attributes batch:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw item attributes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET raw item by ID — vendor aliases come back as stored references
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", canRead, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      /* See the Supplier Master note: no global identity is resolved. */
      /* The alias rows are this item's own history; the vendor behind them
         is not resolvable while Supplier Master has no owner. */
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    applyComputedStatus(rawItem);

    res.json({ success: true, rawItem });

  } catch (error) {
    console.error("Error fetching raw item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw item" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", ...canMaintain, payloadAuthority, async (req, res) => {
  try {
    const {
      name,
      category,
      customCategory,
      unit,
      customUnit,
      minStock,
      maxStock,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Item name is required" });
    }
    if (!category && !customCategory) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    if (!unit && !customUnit) {
      return res.status(400).json({ success: false, message: "Unit of measurement is required" });
    }
    if (minStock === undefined || isNaN(minStock) || minStock < 0) {
      return res.status(400).json({ success: false, message: "Valid minimum stock is required" });
    }
    if (maxStock === undefined || isNaN(maxStock) || maxStock < 0) {
      return res.status(400).json({ success: false, message: "Valid maximum stock is required" });
    }
    if (parseFloat(minStock) >= parseFloat(maxStock)) {
      return res.status(400).json({ success: false, message: "Maximum stock must be greater than minimum stock" });
    }

    if (attributes && Array.isArray(attributes)) {
      for (let attr of attributes) {
        if (!attr.name || !attr.name.trim()) {
          return res.status(400).json({ success: false, message: "Attribute name is required" });
        }
        if (!attr.values || !Array.isArray(attr.values) || attr.values.length === 0) {
          return res.status(400).json({ success: false, message: `Attribute "${attr.name}" must have at least one value` });
        }
      }
    }

    // Generate SKU
    const nameWords = name.trim().split(' ');
    const nameCode = nameWords.map(word => word.substring(0, 3).toUpperCase()).join('');
    const finalCategory = customCategory?.trim() || category;
    const categoryCode = finalCategory.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const sku = `RAW-${categoryCode}-${nameCode}-${randomNum}`;

    /* Company-scoped: two companies may legitimately hold the same code. */
    const existingItem = await RawItem.findOne(scoped(req, { sku }));
    if (existingItem) {
      return res.status(400).json({ success: false, message: "An item with similar SKU already exists. Please try again." });
    }

    const convCheck = await validateEmbeddedConversions(req, req.body);
    if (!convCheck.ok) {
      return sendError(res, fail("VALIDATION", convCheck.message, convCheck.details));
    }
    const vendorCheck = await validateEmbeddedVendors(req, req.body);
    if (!vendorCheck.ok) {
      /* Refused whole. Silently dropping the supplier fields would save an
         item the caller believes has a supplier on it. */
      return res.status(vendorCheck.status).json({
        success: false, code: vendorCheck.code, message: vendorCheck.message,
        fields: vendorCheck.fields, ...(vendorCheck.details || {}),
      });
    }

    // Process variants — accept image + per-variant vendorNicknames
    let processedVariants = [];
    if (variants && Array.isArray(variants)) {
      processedVariants = variants.map(variant => {
        const out = {
          combination: variant.combination || [],
          quantity: parseFloat(variant.quantity) || 0,
          minStock: parseFloat(variant.minStock) || parseFloat(minStock) || 0,
          maxStock: parseFloat(variant.maxStock) || parseFloat(maxStock) || 0,
          sku: variant.sku || "",
          image: variant.image || "",
          unitConversions: (Array.isArray(variant.unitConversions) ? variant.unitConversions : [])
            .map(uc => normaliseUnitConversion(uc)).filter(Boolean)
        };
        const nks = normaliseVariantNicknames(variant.vendorNicknames);
        if (nks) out.vendorNicknames = nks;
        return out;
      });
    }

    /* ── AN ITEM IS CREATED EMPTY ─────────────────────────────────────────
     * This used to sum the variants' quantities into an opening balance and
     * save it with no stock transaction (S12): stock existed with nothing
     * anywhere explaining where it came from, and it could never be
     * reconciled because there was no movement to reconcile against.
     *
     * The quantity is REFUSED rather than dropped. Silently ignoring it would
     * leave the operator looking at a form they filled in, a success message,
     * and a shelf that never changed — the worst of the three options. Opening
     * stock is a stock adjustment, and it goes through the path that records
     * one. */
    const openingQuantities = processedVariants
      .map((v, i) => ({ i, q: Number(v.quantity) || 0 }))
      .filter((x) => x.q > 0);
    if (openingQuantities.length || (Number(req.body.quantity) || 0) > 0) {
      return sendError(res, fail(
        "VALIDATION",
        "An item is created with no stock. Record the opening balance as a stock adjustment, so the movement is on the record.",
        {
          reason: "OPENING_QUANTITY_NOT_ACCEPTED",
          variantRows: openingQuantities.map((x) => x.i + 1),
        },
      ));
    }
    processedVariants.forEach((v) => { v.quantity = 0; });

    const newRawItem = new RawItem({
      /* Ownership from the resolved context ONLY — never from the payload. */
      ...tenantContext.stamp(req.tenant),
      name: name.trim(),
      sku: sku.toUpperCase(),
      category: customCategory ? "" : (category || ""),
      customCategory: customCategory || "",
      unit: customUnit ? "" : (unit || ""),
      customUnit: customUnit || "",
      quantity: 0,
      minStock: parseFloat(minStock),
      maxStock: parseFloat(maxStock),
      discounts: discounts && Array.isArray(discounts)
        ? discounts
            .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
            .map(d => ({
              minQuantity: parseFloat(d.minQuantity),
              price: parseFloat(d.price)
            }))
        : [],
      attributes: attributes && Array.isArray(attributes)
        ? attributes
            .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(val => val && val.trim())
            }))
        : [],
      variants: processedVariants,
      description: description ? description.trim() : "",
      notes: notes ? notes.trim() : "",
      createdBy: req.user.id
    });

    await newRawItem.save();

    res.status(201).json({
      success: true,
      message: "Raw item registered successfully",
      rawItem: newRawItem
    });

  } catch (error) {
    console.error("Error creating raw item:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Item with this SKU already exists" });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: "Validation error: " + error.message,
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: "Server error while creating raw item: " + error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — preserves variant.image + variant.vendorNicknames if not in payload,
//          matches by _id first then by combination
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", ...canMaintain, payloadAuthority, async (req, res) => {
  try {
    const {
      name,
      category,
      customCategory,
      unit,
      customUnit,
      quantity,
      minStock,
      maxStock,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    /* Referenced suppliers and conversion targets are checked here, before
       any field of the loaded document is assigned. */
    const putConv = await validateEmbeddedConversions(req, req.body);
    if (!putConv.ok) return sendError(res, fail("VALIDATION", putConv.message, putConv.details));
    const putVendors = await validateEmbeddedVendors(req, req.body);
    if (!putVendors.ok) {
      return res.status(putVendors.status).json({
        success: false, code: putVendors.code, message: putVendors.message,
        fields: putVendors.fields, ...(putVendors.details || {}),
      });
    }

    /* ── EDITING AN ITEM DOES NOT MOVE STOCK ──────────────────────────────
     * This route used to accept `quantity` and set the balance directly, and
     * to write each variant's quantity from the payload, writing NO stock
     * transaction (S7). Fixing a spelling mistake and silently correcting the
     * shelf were the same request, and only one of them was visible
     * afterwards — which is how a balance drifts with nothing to audit.
     *
     * Refused, not ignored: an operator who typed a quantity into a form and
     * got a success message would otherwise believe the shelf had changed. */
    const quantityFields = [];
    if (quantity !== undefined) quantityFields.push("quantity");
    const variantQuantities = (Array.isArray(variants) ? variants : [])
      .map((v, i) => ({ i, has: v && v.quantity !== undefined }))
      .filter((x) => x.has);
    if (variantQuantities.length) quantityFields.push("variants[].quantity");

    if (quantityFields.length) {
      return sendError(res, fail(
        "VALIDATION",
        "Item details cannot change stock. Record a stock adjustment instead, so the movement is on the record.",
        {
          reason: "QUANTITY_NOT_EDITABLE_HERE",
          fields: quantityFields,
          variantRows: variantQuantities.map((x) => x.i + 1),
        },
      ));
    }

    if (name !== undefined && name.trim()) rawItem.name = name.trim();

    if (category !== undefined || customCategory !== undefined) {
      if (customCategory && customCategory.trim()) {
        rawItem.category = "";
        rawItem.customCategory = customCategory.trim();
      } else if (category !== undefined) {
        rawItem.category = category.trim();
        rawItem.customCategory = "";
      }
    }

    if (unit !== undefined || customUnit !== undefined) {
      const nextUnit = (customUnit && customUnit.trim())
        ? { unit: "", customUnit: customUnit.trim() }
        : (unit !== undefined ? { unit: unit.trim(), customUnit: "" } : null);

      const changesUnit = nextUnit
        && (nextUnit.unit !== (rawItem.unit || "") || nextUnit.customUnit !== (rawItem.customUnit || ""));

      if (changesUnit) {
        /* ── THE STOCK UNIT IS HOW EVERY STORED QUANTITY IS READ ───────────
         * `unit` is a bare string, and nothing anywhere converts a balance
         * when it changes. Editing it on an item holding 10 metres does not
         * convert anything — it simply makes the same stored 10 read as 10
         * pieces, and makes every historical movement, purchase-order line and
         * issue recorded against it read the same new way. Yesterday's receipt
         * silently becomes a different fact.
         *
         * A safe change needs a conversion and a migration of the history that
         * records it, which is Item Master work. Until that exists the change
         * is refused wherever there is anything to reinterpret. An item that
         * has never held stock and is referenced nowhere has no history to
         * misread, so correcting a mistyped unit there stays possible. */
        const currentUnit = rawItem.customUnit || rawItem.unit || "";
        const variantStock = (rawItem.variants || []).reduce((n, v) => n + (v.quantity || 0), 0);
        const movements = (rawItem.stockTransactions || []).length;

        const PurchaseOrderModel = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
        const MRFModel = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
        const tf = tenantContext.tenantFilter(req.tenant);
        const [onOrders, onRequests] = await Promise.all([
          PurchaseOrderModel.countDocuments({ ...tf, "items.rawItem": rawItem._id }),
          MRFModel.countDocuments({ ...tf, "items.rawItem": rawItem._id }),
        ]);

        const blockedBy = [];
        if ((rawItem.quantity || 0) !== 0) {
          blockedBy.push({ kind: "stockOnHand", count: rawItem.quantity,
            detail: `${rawItem.quantity} ${currentUnit} on hand would be reread as ${nextUnit.customUnit || nextUnit.unit}.` });
        }
        if (variantStock !== 0) {
          blockedBy.push({ kind: "variantStock", count: variantStock,
            detail: `${variantStock} held across variants would be reread the same way.` });
        }
        if (movements) {
          blockedBy.push({ kind: "stockHistory", count: movements,
            detail: `${movements} recorded movement(s) are expressed in ${currentUnit}.` });
        }
        if (onOrders) {
          blockedBy.push({ kind: "purchaseOrders", count: onOrders,
            detail: `${onOrders} purchase order line(s) were priced and ordered in ${currentUnit}.` });
        }
        if (onRequests) {
          blockedBy.push({ kind: "materialRequests", count: onRequests,
            detail: `${onRequests} material request line(s) were raised in ${currentUnit}.` });
        }

        if (blockedBy.length) {
          return res.status(409).json({
            success: false,
            code: "UNIT_CHANGE_BLOCKED",
            message: `This item's stock unit cannot be changed from "${currentUnit}" — existing quantities and records would silently mean something different.`,
            blockedBy,
          });
        }
      }

      if (nextUnit) {
        rawItem.unit = nextUnit.unit;
        rawItem.customUnit = nextUnit.customUnit;
      }
    }

    if (minStock !== undefined && !isNaN(minStock)) rawItem.minStock = parseFloat(minStock);
    if (maxStock !== undefined && !isNaN(maxStock)) rawItem.maxStock = parseFloat(maxStock);

    if (discounts !== undefined) {
      rawItem.discounts = Array.isArray(discounts)
        ? discounts
            .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
            .map(d => ({
              minQuantity: parseFloat(d.minQuantity),
              price: parseFloat(d.price)
            }))
        : [];
    }

    if (attributes !== undefined) {
      rawItem.attributes = Array.isArray(attributes)
        ? attributes
            .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(val => val && val.trim())
            }))
        : [];
    }

    // ── Variants: match by _id first, then combination, preserve image+nicknames ──
    if (variants !== undefined) {
      if (variants !== undefined && !Array.isArray(variants)) {
        /* A non-array `variants` used to fall through to "no variants
           supplied", which is indistinguishable from a client bug that sent
           `null` — and on the branch below it would have emptied the array. */
        return sendError(res, fail(
          "VALIDATION",
          "`variants` must be a list of variants.",
          { field: "variants", reason: "VARIANTS_MALFORMED" },
        ));
      }

      if (Array.isArray(variants)) {
        const oldVariants = rawItem.variants.map(v => v.toObject ? v.toObject() : v);

        /* ── AN OMITTED VARIANT IS NOT A DELETED VARIANT ──────────────────
         * The new array was built from the INCOMING list alone, so a variant
         * missing from the payload simply vanished — taking its balance, its
         * supplier aliases and its identity with it — and the parent quantity
         * was then recomputed from whatever survived. That is stock removed
         * through the item-details endpoint, which the quantity refusal above
         * was supposed to have made impossible.
         *
         * A form that loads three variants and posts two is indistinguishable
         * from one that means to delete the third, and this legacy model has
         * no variant lifecycle to retire one safely. So it fails closed and
         * says why. */
        const incomingIds = new Set(
          variants.map((v) => (v?._id ? String(v._id) : null)).filter(Boolean),
        );
        const omitted = oldVariants.filter((old) => {
          if (incomingIds.has(String(old._id))) return false;
          return !variants.some((v) => matchExistingVariant(v, [old]));
        });
        if (omitted.length) {
          return sendError(res, fail(
            "VALIDATION",
            "Variants cannot be removed while editing item details. Every existing variant must be included.",
            {
              reason: "VARIANT_REMOVAL_NOT_SUPPORTED",
              missingVariants: omitted.map((v) => ({
                id: String(v._id),
                combination: v.combination || [],
                sku: v.sku || "",
                quantity: v.quantity || 0,
              })),
            },
          ));
        }

        /* Duplicates introduced by the request would collapse two variants
           into one and silently discard a balance. */
        const seenIds = new Set();
        const seenCombos = new Set();
        for (let i = 0; i < variants.length; i += 1) {
          const v = variants[i] || {};
          const id = v._id ? String(v._id) : null;
          if (id && seenIds.has(id)) {
            return sendError(res, fail("VALIDATION",
              `variants[${i}] repeats a variant already listed.`,
              { field: `variants[${i}]`, reason: "DUPLICATE_VARIANT_ID" }));
          }
          if (id) seenIds.add(id);
          const combo = JSON.stringify(v.combination || []);
          if (seenCombos.has(combo)) {
            return sendError(res, fail("VALIDATION",
              `variants[${i}] repeats an option combination already listed.`,
              { field: `variants[${i}]`, reason: "DUPLICATE_VARIANT_COMBINATION" }));
          }
          seenCombos.add(combo);
        }

        const newVariants = variants.map(incoming => {
          const existing = matchExistingVariant(incoming, oldVariants);

          // image: if explicitly in payload (even ""), respect it; else preserve
          const image = incoming.image !== undefined
            ? (incoming.image || "")
            : (existing?.image || "");

          // vendorNicknames: if payload has the array, replace; else preserve
          let nicknames;
          if (Array.isArray(incoming.vendorNicknames)) {
            nicknames = normaliseVariantNicknames(incoming.vendorNicknames) || [];
          } else {
            nicknames = existing?.vendorNicknames || [];
          }

          const ucs = incoming.unitConversions !== undefined
            ? (Array.isArray(incoming.unitConversions) ? incoming.unitConversions : [])
                .map(u => normaliseUnitConversion(u)).filter(Boolean)
            : (existing?.unitConversions || [])

          return {
            _id: existing?._id,
            combination: incoming.combination || existing?.combination || [],
            /* Never from the payload — a variant keeps whatever balance the
               stock ledger gave it. */
            quantity: existing?.quantity ?? 0,
            minStock: parseFloat(incoming.minStock ?? existing?.minStock ?? rawItem.minStock) || 0,
            maxStock: parseFloat(incoming.maxStock ?? existing?.maxStock ?? rawItem.maxStock) || 0,
            sku: incoming.sku ?? existing?.sku ?? "",
            image,
            vendorNicknames: nicknames,
            unitConversions: ucs,
            status: incoming.status || existing?.status || "In Stock"
          };
        });

        rawItem.variants = newVariants;

        /* ── THE PARENT BALANCE IS NOT RE-DERIVED HERE ────────────────────
         * `rawItem.quantity = variants.reduce(...)` used to run on every edit
         * that touched the variant array. Even with every variant balance
         * preserved, that is a stock mutation with no movement behind it: an
         * item whose parent reads 35 while its variants total 30 — a legacy
         * record, or one part-way through a reconciliation — silently became
         * 30 because somebody corrected a SKU.
         *
         * An inconsistency is a fact about the data, and correcting it is a
         * decision with a reason and an author. That belongs to the stock
         * workflow, which records both. Item editing leaves the balance
         * exactly as it found it. */
      }
    }

    if (description !== undefined) rawItem.description = description ? description.trim() : "";
    if (notes !== undefined) rawItem.notes = notes ? notes.trim() : "";

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updatedRawItem = await RawItem.findOne(scoped(req, { _id: rawItem._id }))
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      /* See the Supplier Master note: no global identity is resolved. */
      /* The alias rows are this item's own history; the vendor behind them
         is not resolvable while Supplier Master has no owner. */
      .lean();

    applyComputedStatus(updatedRawItem);

    res.json({
      success: true,
      message: "Raw item updated successfully",
      rawItem: updatedRawItem
    });

  } catch (error) {
    console.error("Error updating raw item:", error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: "Validation error: " + error.message,
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: "Server error while updating raw item: " + error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", ...canMaintain, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    /* ── NOTHING IS DELETED OUT FROM UNDER A DOCUMENT THAT NAMES IT ────────
     * This was a bare `deleteOne` (S11). It destroyed the item AND the stock
     * transactions embedded in it — the only movement history that existed —
     * with no check for open purchase orders, material requests or returns
     * pointing at it. A PO line then referenced an item id that resolved to
     * nothing, and the movements that would have explained the discrepancy
     * had been deleted in the same operation.
     *
     * This legacy model has NO lifecycle field: there is no draft, blocked or
     * archived state to move an item into, so there is no archive to offer and
     * this does not pretend otherwise. What it can do is refuse, and name what
     * is holding the item. A real lifecycle arrives with the Item master. */
    const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const MRF = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
    const tenantFilter = tenantContext.tenantFilter(req.tenant);

    const [onOrders, onRequests, onReturns, movements] = await Promise.all([
      PurchaseOrder.countDocuments({ ...tenantFilter, "items.rawItem": rawItem._id }),
      MRF.countDocuments({ ...tenantFilter, "items.rawItem": rawItem._id }),
      PurchaseOrder.countDocuments({ ...tenantFilter, "returnRequests.rawItem": rawItem._id }),
      Promise.resolve((rawItem.stockTransactions || []).length),
    ]);

    const blockedBy = [];
    if (onOrders) blockedBy.push({ kind: "purchaseOrders", count: onOrders, detail: `${onOrders} purchase order(s) contain this item.` });
    if (onRequests) blockedBy.push({ kind: "materialRequests", count: onRequests, detail: `${onRequests} material request(s) contain this item.` });
    if (onReturns) blockedBy.push({ kind: "supplierReturns", count: onReturns, detail: `${onReturns} supplier return(s) reference this item.` });
    if (movements) {
      blockedBy.push({
        kind: "stockHistory",
        count: movements,
        detail: `${movements} stock movement(s) are recorded against this item. Deleting it would destroy them.`,
      });
    }
    if ((rawItem.quantity || 0) !== 0) {
      blockedBy.push({
        kind: "stockOnHand",
        count: rawItem.quantity,
        detail: `${rawItem.quantity} still on hand. Adjust the balance to zero before removing the item.`,
      });
    }

    if (blockedBy.length) {
      return res.status(409).json({
        success: false,
        code: "ITEM_IN_USE",
        message: "This item is still referenced, so it cannot be deleted.",
        blockedBy,
      });
    }

    await RawItem.deleteOne(scoped(req, { _id: rawItem._id }));
    res.json({ success: true, message: "Raw item deleted successfully" });
  } catch (error) {
    console.error("Error deleting raw item:", error);
    res.status(500).json({ success: false, message: "Server error while deleting raw item" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-VARIANT VENDOR NICKNAMES (replaces item-level endpoints)
// ─────────────────────────────────────────────────────────────────────────────

// LIST nicknames for a specific variant
router.get("/:id/variants/:variantId/vendor-nicknames", canRead, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .select("name sku variants")
      /* Still no populate: a populate follows a reference wherever it points,
         including into another company. Identity comes from the scoped map
         below instead. */
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = (rawItem.variants || []).find(
      v => v._id?.toString() === req.params.variantId
    );
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    /* ── EACH ALIAS ANSWERS FOR ITSELF ──────────────────────────────────
     * An alias recorded before suppliers had owners may point at a legacy
     * record, or at one this company does not own. Those rows stay — they are
     * what the item says about itself — and each is labelled with what can
     * actually be established about it, rather than the whole list being
     * declared unverified or the unprovable rows being hidden. */
    const aliases = variant.vendorNicknames || [];
    const identities = await supplierIdentityMap(req, aliases.map((a) => a.vendor).filter(Boolean));

    const rows = aliases.map((a) => {
      const known = a.vendor ? identities.get(String(a.vendor)) : null;
      return {
        ...a,
        supplier: known
          ? { id: known._id, name: known.companyName, status: known.status, code: known.supplierCode || "" }
          : null,
        /* VERIFIED: this company's supplier, resolvable now.
           UNVERIFIED: recorded before ownership existed, or pointing outside
           this company — kept, shown, and not passed off as current. */
        identity: known && known.companyId ? "VERIFIED" : "UNVERIFIED",
      };
    });

    res.json({
      success: true,
      vendorNicknames: rows,
      unverifiedCount: rows.filter((r) => r.identity === "UNVERIFIED").length,
      variant: { _id: variant._id, combination: variant.combination, sku: variant.sku },
      item: { name: rawItem.name, sku: rawItem.sku }
    });
  } catch (error) {
    console.error("Error fetching variant vendor nicknames:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// BULK upsert + delete aliases — single MongoDB save instead of N round trips
router.post("/:id/variants/bulk-vendor-nicknames", ...canSource, async (req, res) => {
  /* Reopened: Supplier Master is company-owned, so a reference made here can
     be tied to an owner. Each handler resolves its supplier through
     `resolveSuppliers`, which refuses anything not this company's and Active. */
  try {
    const { operations = [] } = req.body;

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    for (const op of operations) {
      const variant = rawItem.variants.id(op.variantId);
      if (!variant) continue;

      if (op.action === "delete" && op.aliasId) {
        const entry = variant.vendorNicknames.id(op.aliasId);
        if (entry) entry.deleteOne();

      } else if (op.action === "upsert") {
        if (op.aliasId) {
          // Update existing alias
          const entry = variant.vendorNicknames.id(op.aliasId);
          if (entry) {
            if (op.nickname !== undefined) entry.nickname     = op.nickname.toString().trim() || entry.nickname;
            if (op.price    !== undefined) entry.price        = parseFloat(op.price)           || 0;
            if (op.deliveryDays !== undefined) entry.deliveryDays = parseInt(op.deliveryDays)  || 0;
            if (op.notes    !== undefined) entry.notes        = (op.notes || "").trim();
          }
        } else if (op.vendor) {
          // Create — skip if this vendor already has an alias on this variant
          const exists = (variant.vendorNicknames || []).find(vn => vn.vendor?.toString() === op.vendor);
          if (!exists) {
            variant.vendorNicknames.push({
              vendor:       op.vendor,
              nickname:     (op.nickname || "").toString().trim(),
              price:        parseFloat(op.price)        || 0,
              deliveryDays: parseInt(op.deliveryDays)   || 0,
              notes:        (op.notes || "").trim()
            });
          }
        }
      }
    }

    rawItem.updatedBy = req.user.id;
    await rawItem.save();
    res.json({ success: true, message: "Bulk alias update complete" });
  } catch (error) {
    console.error("bulk-vendor-nicknames error:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ADD nickname to a specific variant
router.post("/:id/variants/:variantId/vendor-nicknames", ...canSource, async (req, res) => {
  /* Reopened: Supplier Master is company-owned, so a reference made here can
     be tied to an owner. Each handler resolves its supplier through
     `resolveSuppliers`, which refuses anything not this company's and Active. */
  try {
    const { vendor, nickname, notes, price, deliveryDays } = req.body;

    if (!vendor || !mongoose.Types.ObjectId.isValid(vendor)) {
      return res.status(400).json({ success: false, message: "Valid vendor is required" });
    }
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ success: false, message: "Vendor code is required" });
    }

    /* Not a bare `findById`: that made an id existing ANYWHERE look like a
       valid reference here. This asks whether the supplier is this company's
       and may be newly assigned. */
    const resolved = await resolveSuppliers(req, [vendor]);
    if (!resolved.ok) {
      return res.status(resolved.status).json({
        success: false, code: resolved.code, message: resolved.message,
        ...(resolved.details || {}),
      });
    }
    const vendorDoc = resolved.map.get(String(vendor));

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    const existing = (variant.vendorNicknames || []).find(
      vn => vn.vendor?.toString() === vendor
    );
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `${vendorDoc.companyName} already has an alias for this variant. Edit the existing entry instead.`
      });
    }

    variant.vendorNicknames.push({
      vendor,
      nickname: nickname.trim(),
      price: price != null && !isNaN(price) ? parseFloat(price) : 0,
      deliveryDays: deliveryDays != null && !isNaN(deliveryDays) ? parseInt(deliveryDays) : 0,
      notes: (notes || "").trim()
    });

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findOne(scoped(req, { _id: rawItem._id }))
      .select("variants")
      /* No vendor populate, here or anywhere: identity from an unowned
         global table is the leak these endpoints are closed for. */;

    const updatedVariant = updated.variants.id(req.params.variantId);

    res.status(201).json({
      success: true,
      message: "Vendor alias added successfully",
      vendorNicknames: updatedVariant?.vendorNicknames || []
    });
  } catch (error) {
    console.error("Error adding variant vendor alias:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// UPDATE a nickname on a specific variant
router.put("/:id/variants/:variantId/vendor-nicknames/:nicknameId", ...canSource, async (req, res) => {
  /* Reopened: Supplier Master is company-owned, so a reference made here can
     be tied to an owner. Each handler resolves its supplier through
     `resolveSuppliers`, which refuses anything not this company's and Active. */
  try {
    const { nickname, notes, vendor, price, deliveryDays } = req.body;

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    const entry = variant.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor alias entry not found" });
    }

    if (vendor && mongoose.Types.ObjectId.isValid(vendor)) {
      const collision = variant.vendorNicknames.find(
        vn => vn._id.toString() !== req.params.nicknameId && vn.vendor?.toString() === vendor
      );
      if (collision) {
        return res.status(400).json({
          success: false,
          message: "Another alias already exists for that vendor on this variant"
        });
      }
      entry.vendor = vendor;
    }
    if (nickname !== undefined && nickname.trim()) entry.nickname = nickname.trim();
    if (price !== undefined) entry.price = !isNaN(price) ? parseFloat(price) : 0;
    if (deliveryDays !== undefined) entry.deliveryDays = !isNaN(deliveryDays) ? parseInt(deliveryDays) : 0;
    if (notes !== undefined) entry.notes = (notes || "").trim();

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findOne(scoped(req, { _id: rawItem._id }))
      .select("variants")
      /* No vendor populate, here or anywhere: identity from an unowned
         global table is the leak these endpoints are closed for. */;

    const updatedVariant = updated.variants.id(req.params.variantId);

    res.json({
      success: true,
      message: "Vendor alias updated successfully",
      vendorNicknames: updatedVariant?.vendorNicknames || []
    });
  } catch (error) {
    console.error("Error updating variant vendor alias:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// DELETE a nickname from a specific variant
router.delete("/:id/variants/:variantId/vendor-nicknames/:nicknameId", ...canSource, async (req, res) => {
  /* Reopened: Supplier Master is company-owned, so a reference made here can
     be tied to an owner. Each handler resolves its supplier through
     `resolveSuppliers`, which refuses anything not this company's and Active. */
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    const entry = variant.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor nickname entry not found" });
    }

    entry.deleteOne();
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    res.json({ success: true, message: "Vendor nickname removed" });
  } catch (error) {
    console.error("Error deleting variant vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VARIANTS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/variants", canRead, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id })).select("variants attributes name sku minStock").lean();
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variants = (rawItem.variants || []).map(v => ({
      ...v,
      status: computeStatus(v.quantity, v.minStock ?? rawItem.minStock)
    }));

    res.json({
      success: true,
      variants,
      attributes: rawItem.attributes || [],
      item: { name: rawItem.name, sku: rawItem.sku }
    });
  } catch (error) {
    console.error("Error fetching variants:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variants" });
  }
});

/**
 * One parser for every number that moves stock or money.
 *
 * ── WHY `isNaN` + `parseFloat` IS NOT VALIDATION ────────────────────────────
 * These routes checked `isNaN(quantity)` and then applied `parseFloat(quantity)`.
 * Those two functions do not agree about what a number is. `isNaN("1e3")` is
 * false, so "1e3" passed the check; `parseFloat` reads it as 1000, other
 * readers of the same field read 1, and either way the movement recorded is
 * not the one the operator typed. `parseFloat("5 rolls")` is 5. `isNaN("")`
 * is false and `Number("")` is 0.
 *
 * A quantity is a plain decimal: digits, an optional point, at most four
 * places, greater than zero. Anything else is refused rather than rounded,
 * truncated or guessed at — excess precision is a disagreement about the
 * measurement, not a rounding opportunity.
 *
 * @returns {number|null} null when the value is not one this system will act on
 */
function strictAmount(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  /* A JSON number is already unambiguous; a string is taken exactly as typed
     — no trimming, because " 5" means somebody's field was not what they
     thought it was. */
  const text = typeof raw === "number" ? String(raw) : raw;
  if (!/^\d+(\.\d{1,4})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** A reason an auditor can read, stated by the person who moved the stock. */
function statedReason(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text.length ? text : null;
}

/**
 * An identifier bound for an ObjectId field.
 *
 * The pipeline update bypasses Mongoose casting, so an id that arrives as a
 * string is STORED as a string in a field declared ObjectId: every later
 * populate on it fails, and the mismatch surfaces far from here.
 */
function objectIdOrNull(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (!mongoose.Types.ObjectId.isValid(String(raw))) return { ok: false };
  return { ok: true, value: new mongoose.Types.ObjectId(String(raw)) };
}

/**
 * A manual movement may not present itself as a purchase-order receipt.
 *
 * Receiving against an order has a lifecycle — the order is matched, the
 * received quantity is checked against what was ordered, the line is closed.
 * These endpoints run none of it. Accepting `purchaseOrder` here would let a
 * caller stamp that provenance on a movement that never went through it, and
 * the audit trail would read as though it had.
 */
function refusesOrderLinkage(body) {
  const named = [];
  /* A field that is present but EMPTY claims nothing — an unfilled box on a
     form, not an assertion that this came from an order. It is the stated
     value that is refused, so a form sending "" is not punished for the shape
     of its payload while a real order reference still cannot slip through. */
  const claims = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  if (claims(body?.purchaseOrder)) named.push("purchaseOrder");
  if (claims(body?.purchaseOrderId)) named.push("purchaseOrderId");
  return named;
}

/**
 * Move one variant's stock, once, whatever the caller retries.
 *
 * ── WHY THIS IS NOT read-modify-`save()` ────────────────────────────────────
 * Both stock routes loaded the item, added to the variant in memory, and
 * saved. Two requests that overlap therefore both read the same balance and
 * the second write silently discards the first — the same lost update the
 * returns helper was corrected for.
 *
 * ── WHY THE MIDDLEWARE ALONE WAS NOT ENOUGH ─────────────────────────────────
 * Both routes were wrapped in `withIdempotency` and then answered with a plain
 * `res.json`, which the middleware deliberately treats as an UNCLAIMED success
 * and abandons — it cannot know from an arbitrary response that the effect
 * landed. So the key was released and a retry moved the stock a SECOND time.
 * A route that advertises an idempotency key and then double-counts a retry is
 * worse than one that never offered it.
 *
 * The movement itself therefore carries the proof. `operationId` is written
 * into the transaction inside the same atomic update that changes the balance,
 * and the filter refuses to apply a movement whose id is already recorded. The
 * balance and the history move together or not at all, and a retry finds its
 * own movement already there.
 */
const literalise = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, v]) => [k, { $literal: v === undefined ? null : v }]),
);

async function moveVariantStock(req, { itemId, variantId, delta, transaction, requireAvailable }) {
  const operationId = req.idempotent?.record?._id || null;
  const vid = new mongoose.Types.ObjectId(String(variantId));

  const matchedQty = {
    $let: {
      vars: { m: { $first: { $filter: { input: "$variants", as: "v", cond: { $eq: ["$$v._id", vid] } } } } },
      in: { $ifNull: ["$$m.quantity", 0] },
    },
  };

  const guards = [];
  /* Never below zero, checked against what is stored at this instant rather
     than against a balance read a moment ago. */
  if (requireAvailable) guards.push({ $gte: [matchedQty, Math.abs(delta)] });
  /* At most once: the movement is refused if its own id is already recorded. */
  if (operationId) {
    guards.push({
      $eq: [{ $size: { $filter: {
        input: { $ifNull: ["$stockTransactions", []] }, as: "t",
        cond: { $eq: ["$$t.operationId", operationId] },
      } } }, 0],
    });
  }

  /* ── STATUS IS PART OF THE MOVEMENT, NOT A LATER TIDY-UP ────────────────
   * `RawItem`'s pre-save hook derives both statuses from the balances, and an
   * aggregation-pipeline update does not run it. So the balance moved and the
   * label did not: an item could read 0 on the shelf and "In Stock" in the
   * catalogue, on the reorder report, and in every list that trusts the stored
   * field. Deriving it at read time instead would only hide the stale value
   * from screens that remembered to call the helper.
   *
   * This mirrors `RawItem.deriveStatus` exactly — q <= 0, then q <= minimum —
   * inside the same atomic update, so the balance, the movement and the status
   * are one write or none. */
  const statusOf = (qty, min) => ({
    $switch: {
      branches: [
        { case: { $lte: [qty, 0] }, then: "Out of Stock" },
        { case: { $lte: [qty, min] }, then: "Low Stock" },
      ],
      default: "In Stock",
    },
  });
  const itemMin = { $ifNull: ["$minStock", 0] };

  const filter = scoped(req, { _id: itemId, "variants._id": vid });
  if (guards.length) filter.$expr = { $and: guards };

  const updated = await RawItem.findOneAndUpdate(
    filter,
    [
      { $set: { __prevQty: matchedQty } },
      { $set: {
        variants: { $map: {
          input: "$variants", as: "v",
          in: { $cond: [
            { $eq: ["$$v._id", vid] },
            { $mergeObjects: ["$$v", {
              quantity: { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
              /* A variant with no minimum of its own inherits the item's, the
                 same fallback the pre-save hook applies. */
              status: statusOf(
                { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
                { $ifNull: ["$$v.minStock", itemMin] },
              ),
            }] },
            "$$v",
          ] },
        } },
      } },
      /* ── THE PARENT MOVES BY THE MOVEMENT, NOT BY A RECOUNT ─────────────
       * `$sum: "$variants.quantity"` would silently absorb any pre-existing
       * discrepancy between the parent and its variants into whichever
       * movement happened to come next, crediting this operator's receipt
       * with a correction nobody made. The parent moves by exactly the
       * amount recorded; reconciling a legacy difference stays an explicit
       * decision, as it is in item editing. */
      { $set: { quantity: { $add: [{ $ifNull: ["$quantity", 0] }, delta] } } },
      { $set: { status: statusOf("$quantity", itemMin) } },
      { $set: {
        stockTransactions: { $concatArrays: [
          [{
            /* ── EVERY SUPPLIED VALUE IS DATA, NOT AN EXPRESSION ───────────
             * This is an aggregation pipeline, where a string beginning with
             * "$" is a FIELD PATH. A supplier called "$name" or a note reading
             * "$500 short" would otherwise be resolved against the document —
             * silently storing the item's name, or nothing at all, in place of
             * what the person typed. `$literal` says: this is a value. */
            ...literalise(transaction),
            operationId: { $literal: operationId },
            previousQuantity: "$__prevQty",
            newQuantity: { $add: ["$__prevQty", delta] },
            variantPreviousQuantity: "$__prevQty",
            variantNewQuantity: { $add: ["$__prevQty", delta] },
            createdAt: { $literal: new Date() },
            updatedAt: { $literal: new Date() },
          }],
          { $ifNull: ["$stockTransactions", []] },
        ] },
      } },
      { $set: {
        updatedBy: new mongoose.Types.ObjectId(String(req.user.id)),
        /* Mongoose stamps this on save(); a pipeline update must do it
           itself, or the record looks untouched since before the movement. */
        updatedAt: { $literal: new Date() },
      } },
      { $unset: "__prevQty" },
    ],
    { new: true },
  );

  return updated;
}

/**
 * Answer for a stock move, and settle its idempotency record.
 *
 * A move that did not apply is not automatically a failure: on a retry the
 * filter refuses precisely because this movement is already recorded, and the
 * right answer is the one from the first attempt — not a second movement and
 * not an error. So a miss is read back: if this operation's movement is there,
 * it replays; if it is not, the guard that refused is reported.
 */
async function settleStockMove(req, res, { rawItem, variantId, updated, verb, insufficient = false }) {
  const operationId = req.idempotent?.record?._id || null;
  let doc = updated;

  if (!doc) {
    const current = await RawItem.findOne(scoped(req, { _id: rawItem._id })).lean();
    const alreadyDone = operationId && (current?.stockTransactions || [])
      .some((t) => String(t.operationId) === String(operationId));
    if (!alreadyDone) {
      /* The only other guard is availability, and it is checked against what
         was stored at the moment of the write. */
      const v = (current?.variants || []).find((x) => String(x._id) === String(variantId));
      return res.status(insufficient ? 400 : 409).json({
        success: false,
        message: insufficient
          ? `Insufficient stock. Available: ${v?.quantity ?? 0}`
          : "The stock could not be moved. Please try again.",
      });
    }
    doc = current;
  }

  const variant = (doc.variants || []).find((v) => String(v._id) === String(variantId));
  const transaction = operationId
    ? (doc.stockTransactions || []).find((t) => String(t.operationId) === String(operationId))
    : (doc.stockTransactions || [])[0];

  const body = {
    success: true,
    message: `Stock ${verb} successfully. New quantity: ${variant?.quantity ?? 0}`,
    variant,
    transaction,
  };

  /* Settled through the record, so an identical retry replays this answer
     instead of being told the key was abandoned. */
  if (req.idempotent?.succeed) {
    return req.idempotent.succeed(200, body, { entityType: "RawItem", entityId: rawItem._id });
  }
  return res.json(body);
}

router.post(
  "/:id/variants/:variantId/add-stock",
  /* This moves stock. It is not catalogue maintenance, and a retry must
     not move it twice. */
  requireCapability(CAPABILITIES.STOCK_ADJUST),
  refuseLegacyWrite,
  withIdempotency("RAW_ITEM_ADD_STOCK"),
  async (req, res) => {
  try {
    const { quantity, supplier, supplierId, invoiceNumber, reason, notes } = req.body;

    /* Everything is decided before a single field of the record is touched. */
    const linkage = refusesOrderLinkage(req.body);
    if (linkage.length) {
      return sendError(res, fail(
        "VALIDATION",
        "A manual stock addition cannot be recorded against a purchase order. Receive it through the goods receipt workflow instead.",
        { fields: linkage, reason: "ORDER_LINKAGE_NOT_ACCEPTED" },
      ));
    }

    const amount = strictAmount(quantity);
    if (amount === null) {
      return sendError(res, fail("VALIDATION",
        "Quantity must be a plain number greater than zero, with at most four decimal places.",
        { field: "quantity", reason: "AMOUNT_INVALID", value: quantity }));
    }

    if (typeof supplier !== "string" || !supplier.trim()) {
      return res.status(400).json({ success: false, message: "Supplier name is required" });
    }

    const price = strictAmount(req.body?.unitPrice);
    if (price === null) {
      return sendError(res, fail("VALIDATION",
        "Unit price must be a plain number greater than zero, with at most four decimal places.",
        { field: "unitPrice", reason: "AMOUNT_INVALID", value: req.body?.unitPrice }));
    }

    const statedWhy = statedReason(reason);
    if (!statedWhy) {
      return sendError(res, fail("VALIDATION",
        "Say why this stock is being added. A movement without a stated reason cannot be audited.",
        { field: "reason", reason: "REASON_REQUIRED" }));
    }

    const supplierRef = objectIdOrNull(supplierId);
    if (!supplierRef.ok) {
      return sendError(res, fail("VALIDATION",
        "The supplier reference is not a valid identifier.",
        { field: "supplierId", reason: "IDENTIFIER_INVALID" }));
    }

    if (notes !== undefined && typeof notes !== "string") {
      return sendError(res, fail("VALIDATION", "Notes must be text.",
        { field: "notes", reason: "TEXT_EXPECTED" }));
    }
    if (invoiceNumber !== undefined && typeof invoiceNumber !== "string") {
      return sendError(res, fail("VALIDATION", "The invoice number must be text.",
        { field: "invoiceNumber", reason: "TEXT_EXPECTED" }));
    }

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) return res.status(404).json({ success: false, message: "Variant not found" });

    const variant = rawItem.variants[variantIndex];

    const updated = await moveVariantStock(req, {
      itemId: rawItem._id,
      variantId: variant._id,
      delta: amount,
      transaction: {
        type: "VARIANT_ADD",
        quantity: amount,
        variantCombination: variant.combination,
        variantId: variant._id,
        reason: statedWhy,
        supplier: supplier.trim(),
        supplierId: supplierRef.value,
        unitPrice: price,
        invoiceNumber: (invoiceNumber || "").trim(),
        notes: (notes || "").trim(),
        performedBy: new mongoose.Types.ObjectId(String(req.user.id)),
      },
    });

    const settled = await settleStockMove(req, res, { rawItem, variantId: variant._id, updated, verb: "added" });
    return settled;

  } catch (error) {
    console.error("Error adding stock to variant:", error);
    res.status(500).json({ success: false, message: "Server error while adding stock to variant" });
  }
},
);

router.post(
  "/:id/variants/:variantId/reduce-stock",
  requireCapability(CAPABILITIES.STOCK_ADJUST),
  refuseLegacyWrite,
  withIdempotency("RAW_ITEM_REDUCE_STOCK"),
  async (req, res) => {
  try {
    const { quantity, reason, notes } = req.body;

    const linkage = refusesOrderLinkage(req.body);
    if (linkage.length) {
      return sendError(res, fail(
        "VALIDATION",
        "A manual stock reduction cannot be recorded against a purchase order.",
        { fields: linkage, reason: "ORDER_LINKAGE_NOT_ACCEPTED" },
      ));
    }

    const amount = strictAmount(quantity);
    if (amount === null) {
      return sendError(res, fail("VALIDATION",
        "Quantity must be a plain number greater than zero, with at most four decimal places.",
        { field: "quantity", reason: "AMOUNT_INVALID", value: quantity }));
    }

    const statedWhy = statedReason(reason);
    if (!statedWhy) {
      return sendError(res, fail("VALIDATION",
        "Say why this stock is being reduced. A movement without a stated reason cannot be audited.",
        { field: "reason", reason: "REASON_REQUIRED" }));
    }

    if (notes !== undefined && typeof notes !== "string") {
      return sendError(res, fail("VALIDATION", "Notes must be text.",
        { field: "notes", reason: "TEXT_EXPECTED" }));
    }

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }));
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) return res.status(404).json({ success: false, message: "Variant not found" });

    const variant = rawItem.variants[variantIndex];
    /* Reported early so the caller gets the useful message; the binding check
       is the atomic one inside the move, against what is stored then. */
    if (amount > variant.quantity) {
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${variant.quantity}` });
    }

    const updated = await moveVariantStock(req, {
      itemId: rawItem._id,
      variantId: variant._id,
      delta: -amount,
      requireAvailable: true,
      transaction: {
        type: "VARIANT_REDUCE",
        quantity: amount,
        variantCombination: variant.combination,
        variantId: variant._id,
        reason: statedWhy,
        notes: (notes || "").trim(),
        performedBy: new mongoose.Types.ObjectId(String(req.user.id)),
      },
    });

    const settled = await settleStockMove(req, res, {
      rawItem, variantId: variant._id, updated, verb: "reduced", insufficient: true,
    });
    return settled;

  } catch (error) {
    console.error("Error reducing stock:", error);
    res.status(500).json({ success: false, message: "Server error while reducing stock" });
  }
},
);

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/transactions", canRead, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .select("stockTransactions name sku quantity minStock")
      .populate("stockTransactions.performedBy", "name email")
      /* The supplier behind a movement is not resolved from the global
         table; the movement's own recorded `supplier` text is used. */
      .lean();

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    let transactions = rawItem.stockTransactions || [];
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const startIndex = (page - 1) * limit;
    const paginatedTransactions = transactions.slice(startIndex, startIndex + parseInt(limit));

    const totalAdditions = transactions
      .filter(tx => ["ADD", "PURCHASE_ORDER", "VARIANT_ADD"].includes(tx.type))
      .reduce((sum, tx) => sum + (tx.quantity || 0), 0);

    const totalReductions = transactions
      .filter(tx => ["REDUCE", "CONSUME", "VARIANT_REDUCE"].includes(tx.type))
      .reduce((sum, tx) => sum + (tx.quantity || 0), 0);

    const uniqueVendors = [...new Set(transactions
      .filter(tx => tx.supplier && tx.supplier.trim())
      .map(tx => tx.supplier))];

    const computedStatus = computeStatus(rawItem.quantity, rawItem.minStock);

    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      stats: {
        totalAdditions,
        totalReductions,
        uniqueVendors: uniqueVendors.length,
        currentStock: rawItem.quantity,
        status: computedStatus
      },
      item: {
        name: rawItem.name,
        sku: rawItem.sku,
        quantity: rawItem.quantity,
        status: computedStatus
      }
    });

  } catch (error) {
    console.error("Error fetching stock transactions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock transactions" });
  }
});

router.get("/:id/variants/:variantId/transactions", canRead, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .select("stockTransactions name sku variants minStock")
      .populate("stockTransactions.performedBy", "name email")
      /* The supplier behind a movement is not resolved from the global
         table; the movement's own recorded `supplier` text is used. */
      .lean();

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variant = rawItem.variants.find(v => v._id.toString() === req.params.variantId);
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });

    let transactions = rawItem.stockTransactions.filter(tx =>
      tx.variantId && tx.variantId.toString() === req.params.variantId
    );
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const startIndex = (page - 1) * limit;
    const paginatedTransactions = transactions.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      variant: {
        combination: variant.combination,
        sku: variant.sku,
        quantity: variant.quantity,
        status: computeStatus(variant.quantity, variant.minStock ?? rawItem.minStock),
        minStock: variant.minStock,
        maxStock: variant.maxStock
      },
      item: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching variant transactions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variant transactions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/purchase-orders", canRead, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id })).select("name sku");
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

    /* ── THIS READ WAS ALSO GLOBAL ────────────────────────────────────────
     * Found while removing the vendor populates, and left closed rather than
     * reported and skipped: an item id is enough to match orders belonging to
     * any company, and the row carries the order number, the supplier name and
     * the amount. The item itself is already tenant-scoped above, so the
     * orders about it are scoped the same way.
     *
     * The vendor populate is gone for the reason every other one here is: the
     * order's own `vendorName`, recorded when it was raised, is what this
     * company wrote down. */
    const purchaseOrders = await PurchaseOrder.find({
      ...tenantContext.tenantFilter(req.tenant),
      "items.rawItem": req.params.id,
    })
      .select("poNumber orderDate expectedDeliveryDate vendorName status totalAmount items")
      .sort({ orderDate: -1 });

    const processedOrders = purchaseOrders.map(po => {
      const item = po.items.find(i => i.rawItem.toString() === req.params.id);
      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendor?.companyName || po.vendorName,
        status: po.status,
        totalAmount: po.totalAmount,
        itemDetails: item ? {
          quantity: item.quantity,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status
        } : null
      };
    });

    res.json({
      success: true,
      purchaseOrders: processedOrders,
      rawItem: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res.status(500).json({ success: false, message: "Server error while fetching purchase orders" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIERS HISTORY  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/suppliers", canRead, async (req, res) => {
  try {
    const rawItem = await RawItem.findOne(scoped(req, { _id: req.params.id }))
      .select("stockTransactions name sku primaryVendor alternateVendors")
      /* Supplier identity is unresolvable here — see the note above. The
         movement's own `supplier` text is what this company recorded at the
         time, and that stays. */;

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const transactionSuppliers = {};
    rawItem.stockTransactions.forEach(tx => {
      if (tx.supplier && ["ADD", "PURCHASE_ORDER", "VARIANT_ADD"].includes(tx.type)) {
        const name = tx.supplier;
        if (!transactionSuppliers[name]) {
          transactionSuppliers[name] = {
            name,
            lastPurchaseDate: tx.createdAt,
            lastCost: tx.unitPrice || 0,
            totalPurchased: tx.quantity || 0,
            purchaseCount: 1,
            supplierId: tx.supplierId
          };
        } else {
          transactionSuppliers[name].totalPurchased += tx.quantity || 0;
          transactionSuppliers[name].purchaseCount += 1;
          if (new Date(tx.createdAt) > new Date(transactionSuppliers[name].lastPurchaseDate)) {
            transactionSuppliers[name].lastPurchaseDate = tx.createdAt;
            transactionSuppliers[name].lastCost = tx.unitPrice || 0;
          }
        }
      }
    });

    res.json({
      success: true,
      suppliers: Object.values(transactionSuppliers).sort((a, b) =>
        new Date(b.lastPurchaseDate) - new Date(a.lastPurchaseDate)
      ),
      primaryVendor: rawItem.primaryVendor,
      alternateVendors: rawItem.alternateVendors || [],
      item: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ success: false, message: "Server error while fetching suppliers" });
  }
});

module.exports = router;