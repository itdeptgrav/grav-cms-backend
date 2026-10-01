"use strict";
// services/inventory/rawItemCreation.service.js
//
// REGISTERING A RAW ITEM — ONE IMPLEMENTATION, TWO DOORS.
//
// Store's own item screen and the Development BOM's inline drawer create the
// same master record. Before this they could not have: the whole rule lived
// inside a two-hundred-line handler in a two-and-a-half-thousand-line route,
// so a second caller meant a second copy — a second validation, a second SKU
// rule, a second opinion about opening stock. Two copies of a creation rule
// diverge; the only question is which one is wrong when they do.
//
// ── THE TWO DOORS ARE NOT THE SAME DOOR ────────────────────────────────────
// Store MAINTAINS the master: supplier nicknames and their prices, quantity
// discounts, re-order levels, attributes, variants, conversion factors.
// Merchandising is doing something far smaller — naming a material that exists
// in the world so a BOM row can point at a reference instead of at a
// merchandiser's spelling — and must not acquire the rest by walking through a
// shared function.
//
// So the caller declares which SECTIONS it may supply, and anything outside
// them is REFUSED rather than dropped. Silently ignoring a supplier price
// would save an item the caller believes carries one: a form filled in, a
// success message, and a record that does not say what the person thinks it
// says. That is the same class of fault as the opening-stock one below, and it
// gets the same answer.
//
// ── OWNERSHIP AND IDENTITY ARE NEVER THE PAYLOAD'S ─────────────────────────
// `companyId`, `siteId` and `createdBy` come from the resolved tenant and the
// authenticated actor, passed in as `tenant` and `actorId`. A payload that
// names a company is not obeyed and not merged — it is ignored, because the
// alternative is a cross-tenant write dressed as a field.

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { isUsedAs, DEFAULT_USED_AS } = require("../../models/CMS_Models/Inventory/Products/usedAs");
const tenantContext = require("../storePurchase/tenantContext.service");
const { fail } = require("../storePurchase/errors");
const materialOwnership = require("./materialOwnership.service");
/* One implementation of the payload judgements, shared with the Store route. */
const {
  validateEmbeddedConversions, validateEmbeddedVendors,
  escapeRegex, normaliseUnitConversion, normaliseVariantNicknames,
} = require("./rawItemPayload.service");

const str = (v) => String(v ?? "").trim();
const num = (v) => parseFloat(v);

/* ── WHAT A CALLER MAY SEND ─────────────────────────────────────────────────
   Named sections rather than a flat field list, so a field added to the item
   form tomorrow lands inside an existing permission rather than defaulting to
   "allowed" for every door. */
const SECTION = Object.freeze({
  IDENTITY: "identity",             // name, description, notes
  CLASSIFICATION: "classification", // category, unit, usedAs, tariff code
  STOCK_LEVELS: "stockLevels",      // min/max re-order levels
  /* An opening balance. No door SAVES one — Store's own path refuses it with
     the advice to record a stock adjustment instead, which is the right answer
     for someone who may make one. A caller without this section is refused
     earlier and differently, because for them it is not a matter of using the
     right screen: they may not set a balance at all. */
  STOCK: "stock",                   // quantity
  ATTRIBUTES: "attributes",         // attribute definitions
  VARIANTS: "variants",             // variant rows, their SKUs and images
  CONVERSIONS: "conversions",       // unit conversion factors
  COMMERCIAL: "commercial",         // quantity discounts
  SUPPLIER: "supplier",             // vendor nicknames, prices, lead times
});

/** Store maintains the whole master. */
const STORE_SECTIONS = Object.freeze(Object.values(SECTION));

/* ── THE MERCHANDISING DOOR ─────────────────────────────────────────────────
   The minimum that makes a BOM row point at something real: what the material
   is, what class of thing it is, and what it is measured in. Nothing else.

   Attributes and variants are absent deliberately, not merely to be strict.
   A variant structure is Store's statement about how it stocks and counts the
   item, and the drawer exists so a merchandiser can finish choosing a material
   in the next few seconds — not so they can design someone else's shelf. An
   item created here has no variants, which is why the drawer can select it
   immediately with no variant question to answer.

   Stock levels are absent for the same kind of reason: they are a Store
   judgement about re-ordering, and a merchandiser has no basis for one. Rather
   than take a number they would have to invent, the service supplies zero and
   leaves Store to state the real levels when it next opens the item. */
const MERCHANDISING_SECTIONS = Object.freeze([SECTION.IDENTITY, SECTION.CLASSIFICATION]);

/** Which payload keys belong to which section. */
const SECTION_FIELDS = Object.freeze({
  [SECTION.IDENTITY]: ["name", "description", "notes"],
  [SECTION.CLASSIFICATION]: ["category", "customCategory", "unit", "customUnit", "usedAs", "customsTariffCode", "defaultOwnership"],
  [SECTION.STOCK_LEVELS]: ["minStock", "maxStock"],
  [SECTION.STOCK]: ["quantity"],
  [SECTION.ATTRIBUTES]: ["attributes"],
  [SECTION.VARIANTS]: ["variants"],
  [SECTION.CONVERSIONS]: ["unitConversion", "unitConversions"],
  [SECTION.COMMERCIAL]: ["discounts"],
  [SECTION.SUPPLIER]: ["primaryVendor", "alternateVendors", "supplierCode", "supplierPrice", "leadTimeDays"],
});

/** Who maintains each refused field, so the refusal teaches rather than blocks. */
const FIELD_OWNER = Object.freeze({
  minStock: "Store", maxStock: "Store", discounts: "Store", quantity: "Store",
  variants: "Store", attributes: "Store", unitConversions: "Store",
  unitConversion: "Store", primaryVendor: "Store", alternateVendors: "Store",
  supplierCode: "Store", supplierPrice: "Store", leadTimeDays: "Store",
  "variants[].vendorNicknames": "Store", "variants[].unitConversions": "Store",
});

/* ── STORE'S OWN SHELVES ────────────────────────────────────────────────────
   The catalogue route's list, moved here because the narrow door has to check
   a category against it and a second copy would let the two doors accept
   different words for the same shelf. A company may also file an item under a
   word of its own (`customCategory`), which is why this is a list of the
   standard shelves and not a closed enum on the model. */
const RAW_ITEM_CATEGORIES = Object.freeze([
  "Fabric", "Thread", "Fasteners", "Elastic", "Interlining",
  "Trims", "Chemicals", "Patterns", "Labels", "Packaging",
  "Accessories", "Dyes", "Buttons", "Zippers", "Laces",
  "Ribbons", "Cords", "Tapes", "Piping", "Webbing",
]);

/* ── HOW CUSTOMS CLASSIFIES THESE GOODS ─────────────────────────────────────
   Identical to the catalogue route's rule: a tariff heading is written
   "5208.52.00", "52085200" and "5208 52 00" for the same goods, and a duty
   table keyed on one of those would miss the other two. Empty stays empty — an
   unclassified item is never read as duty-free. */
const tariffCode = (v) => String(v ?? "").trim().toUpperCase().replace(/[\s.]/g, "").slice(0, 20);

/* ── DUPLICATE DETECTION ────────────────────────────────────────────────────
   NOT on the SKU. The minted SKU carries a random three-digit tail, so the
   same material registered twice a minute apart gets two different codes and
   the uniqueness check passes on both — which is exactly how a catalogue fills
   with one yarn under four codes.

   The meaningful identity is what a person would call the same thing: the
   name, the class of material, the unit it is measured in and what it is used
   as, compared with case, spacing and punctuation removed, so "Poly Mesh 135"
   and "poly-mesh 135" are one material and not two. */
const normalise = (v) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Whether this payload has a name there is any point comparing.
 *
 * The key also carries the shelf and the unit, so a NAMELESS item still
 * produces a non-empty string — and treating that as an identity would make
 * every nameless "Fabric / Metre" row a duplicate of every other. One
 * definition, used by the duplicate check and by the backfill, so neither has
 * to restate the normalisation to ask the question.
 */
function hasComparableName(payload) {
  return Boolean(normalise(payload?.name));
}

function identityKey(payload) {
  return [
    normalise(payload?.name),
    normalise(str(payload?.customCategory) || payload?.category),
    normalise(str(payload?.customUnit) || payload?.unit),
    normalise(payload?.usedAs) || normalise(DEFAULT_USED_AS),
  ].join("|");
}

/**
 * The item this payload would duplicate, or null.
 *
 * Company-scoped. Two companies may legitimately hold the same material, and a
 * match found across the boundary would be a leak dressed as a helpful
 * warning: it would answer "does that other company stock this?".
 */
async function findDuplicate(tenant, payload, session = null) {
  if (!hasComparableName(payload)) return null;
  const wanted = identityKey(payload);
  /* Two narrowings, both indexed, because the catalogue holds two kinds of row.
     Items registered since `masterIdentityKey` existed are an exact lookup, and
     that is the path that makes "Poly mesh 135", "poly-mesh 135" and
     "POLY  MESH  135" collide. Items older than the field carry no key, so they
     are reached by an exact, case-insensitive name — which finds a genuine
     duplicate of the usual kind and honestly misses a legacy row that differs
     only in punctuation, rather than scanning the whole catalogue to close a gap
     a backfill closes properly.

     The cap is a safety limit, not paging: more than a handful of items sharing
     one identity is already the problem this check exists to report. */
  const candidates = await RawItem.find({
    ...tenantContext.tenantFilter(tenant),
    $or: [
      { masterIdentityKey: wanted },
      { name: new RegExp(`^${escapeRegex(str(payload.name))}$`, "i") },
    ],
  }).limit(25).session(session).lean();
  /* Confirmed on the full key either way, so a name match that is a different
     material — same words, different unit — is not reported as a duplicate. */
  return candidates.find((c) => identityKey(c) === wanted) || null;
}

/** `RAW-CAT-NAM-000`. Kept exactly as the Store route minted it. */
function mintSku(name, category) {
  const nameCode = str(name).split(" ").map((w) => w.substring(0, 3).toUpperCase()).join("");
  const categoryCode = str(category).substring(0, 3).toUpperCase();
  const tail = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `RAW-${categoryCode}-${nameCode}-${tail}`;
}

/* ── WHAT A NARROW CALLER MAY SEE BACK ──────────────────────────────────────
   A duplicate refusal has to hand back the item it matched, so the drawer can
   offer "use the one that is already there" instead of leaving the person to
   search for a name they were just told exists. But the matched item is a full
   Store master, with discounts, supplier aliases and balances on it. This is
   the identity half and nothing else — shaped field by field, so a field added
   to RawItem tomorrow does not appear here by accident. */
function publicItem(item) {
  return {
    _id: str(item?._id),
    name: str(item?.name),
    sku: str(item?.sku),
    category: str(item?.category),
    customCategory: str(item?.customCategory),
    unit: str(item?.unit),
    customUnit: str(item?.customUnit),
    usedAs: str(item?.usedAs),
    description: str(item?.description),
    variantCount: Array.isArray(item?.variants) ? item.variants.length : 0,
    ownership: materialOwnership.ownershipView(item),
  };
}

/** Everything the caller sent that its sections do not cover. */
function fieldsBeyond(allowed, payload) {
  const out = [];
  const supplied = (v) => v !== undefined && v !== null && v !== "";
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    if (allowed.has(section)) continue;
    for (const f of fields) if (supplied(payload?.[f])) out.push(f);
  }
  /* Two facts travel INSIDE variants and are gated separately from the variant
     structure itself — the side door the catalogue route already closes. */
  const variants = Array.isArray(payload?.variants) ? payload.variants : [];
  if (!allowed.has(SECTION.SUPPLIER)
      && variants.some((v) => v && v.vendorNicknames !== undefined)) {
    out.push("variants[].vendorNicknames");
  }
  if (!allowed.has(SECTION.CONVERSIONS)
      && variants.some((v) => v && v.unitConversions !== undefined)) {
    out.push("variants[].unitConversions");
  }
  return out;
}

/**
 * Register a raw item.
 *
 * @param {object}   tenant     resolved tenant context — the ONLY source of
 *                              company ownership
 * @param {string}   actorId    the authenticated actor — the ONLY source of
 *                              `createdBy`
 * @param {object}   payload    what the caller sent
 * @param {string[]} sections   which sections this caller may supply
 * @param {"refuse"|"allow"} onDuplicate
 *        What to do when the payload names a material this company already
 *        has. `allow` is Store's long-standing behaviour and is preserved
 *        unchanged: a storekeeper looking at the catalogue can see the
 *        near-match and has reasons to register a second row anyway. `refuse`
 *        is the narrow door's, where the item is being created from a picker
 *        that just failed to find it — which is precisely the moment a
 *        duplicate gets made by accident.
 * @returns {Promise<{rawItem: object, duplicate: object|null}>}
 */
async function createRawItem({
  tenant, actorId, payload = {}, sections = STORE_SECTIONS, onDuplicate = "allow",
  session = null,
} = {}) {
  const allowed = new Set(sections);
  /* ── ONE POLICY, TWO CONSEQUENCES ───────────────────────────────────────
     A door that refuses a duplicate is also the door that may claim its
     material's identity as the only one, and those are the same decision — so
     they are read from the same value rather than passed separately, where a
     caller could set one and forget the other. The claim is what the unique
     partial index on the model covers; see the field's comment there for why
     Store's door does not make it. */
  const claimsIdentity = onDuplicate === "refuse";

  /* ── REFUSED, NOT DROPPED ───────────────────────────────────────────── */
  const beyond = fieldsBeyond(allowed, payload);
  if (beyond.length) {
    const owners = [...new Set(beyond.map((f) => FIELD_OWNER[f]).filter(Boolean))];
    throw fail("FORBIDDEN",
      owners.length
        ? `${owners.join(" and ")} maintains ${beyond.join(", ")}. This door registers a material's identity only, and nothing was saved.`
        : `This door may not set ${beyond.join(", ")}. Nothing was saved.`,
      { reason: "FIELD_NOT_PERMITTED_HERE", fields: beyond });
  }

  /* ── VALIDATION, IN THE CATALOGUE ROUTE'S ORDER ─────────────────────────
     Same order and same sentences, so the Store form's field-by-field
     behaviour is unchanged. */
  const name = str(payload.name);
  if (!name) throw fail("VALIDATION", "Item name is required", { field: "name" });
  if (!payload.category && !str(payload.customCategory)) {
    throw fail("VALIDATION", "Category is required", { field: "category" });
  }
  if (!payload.unit && !str(payload.customUnit)) {
    throw fail("VALIDATION", "Unit of measurement is required", { field: "unit" });
  }

  const statesLevels = allowed.has(SECTION.STOCK_LEVELS);
  const minStock = statesLevels ? payload.minStock : 0;
  const maxStock = statesLevels ? payload.maxStock : 0;
  if (statesLevels) {
    if (minStock === undefined || Number.isNaN(Number(minStock)) || Number(minStock) < 0) {
      throw fail("VALIDATION", "Valid minimum stock is required", { field: "minStock" });
    }
    if (maxStock === undefined || Number.isNaN(Number(maxStock)) || Number(maxStock) < 0) {
      throw fail("VALIDATION", "Valid maximum stock is required", { field: "maxStock" });
    }
    if (num(minStock) >= num(maxStock)) {
      throw fail("VALIDATION", "Maximum stock must be greater than minimum stock", { field: "maxStock" });
    }
  }

  for (const attr of (Array.isArray(payload.attributes) ? payload.attributes : [])) {
    if (!str(attr?.name)) throw fail("VALIDATION", "Attribute name is required", { field: "attributes" });
    if (!Array.isArray(attr.values) || attr.values.length === 0) {
      throw fail("VALIDATION", `Attribute "${attr.name}" must have at least one value`, { field: "attributes" });
    }
  }

  /* ── IS IT ALREADY IN THE CATALOGUE? ────────────────────────────────────
     Looked up in both modes, because the answer is worth reporting even when
     it is not worth refusing: Store's response carries it as `duplicate` so a
     screen can say so without a second request. */
  /* ── WHOSE PROPERTY IT NORMALLY IS ──────────────────────────────────────
     Decided by the one rule every door shares. A client that says nothing
     gets COMPANY_OWNED; an unknown word is refused. What comes back is the
     one catalogue field — never a quantity or a movement. */
  const ownership = materialOwnership.resolveOwnership({ stored: null, payload });

  const duplicate = await findDuplicate(tenant, payload, session);
  if (duplicate && onDuplicate === "refuse") {
    throw fail("CONFLICT",
      `"${duplicate.name}" is already in this company's Store catalogue. Select it instead of registering it again.`,
      { reason: "RAW_ITEM_ALREADY_REGISTERED", existing: publicItem(duplicate) });
  }

  /* Payload judgements about the world, shared with the Store route's update
     path. The validators read `req.tenant`, so the tenant travels as one. */
  const asReq = { tenant };
  if (allowed.has(SECTION.CONVERSIONS) || allowed.has(SECTION.VARIANTS)) {
    const conv = await validateEmbeddedConversions(asReq, payload, session);
    if (!conv.ok) throw fail("VALIDATION", conv.message, conv.details);
  }
  if (allowed.has(SECTION.SUPPLIER)) {
    const vendors = await validateEmbeddedVendors(asReq, payload, session);
    if (!vendors.ok) {
      /* Refused whole. Silently dropping the supplier fields would save an
         item the caller believes has a supplier on it. */
      throw fail(vendors.code === "SUPPLIER_NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
        vendors.message, { reason: vendors.code, fields: vendors.fields, ...(vendors.details || {}) });
    }
  }

  const usedAsValue = isUsedAs(payload.usedAs)
    ? str(payload.usedAs).toUpperCase()
    : DEFAULT_USED_AS;

  const variants = (allowed.has(SECTION.VARIANTS) && Array.isArray(payload.variants)
    ? payload.variants : []).map((variant) => {
    const out = {
      combination: variant.combination || [],
      /* An item is created empty — see below. */
      quantity: 0,
      minStock: num(variant.minStock) || num(minStock) || 0,
      maxStock: num(variant.maxStock) || num(maxStock) || 0,
      sku: variant.sku || "",
      image: variant.image || "",
      unitConversions: (Array.isArray(variant.unitConversions) ? variant.unitConversions : [])
        .map((uc) => normaliseUnitConversion(uc)).filter(Boolean),
    };
    if (allowed.has(SECTION.SUPPLIER)) {
      const nks = normaliseVariantNicknames(variant.vendorNicknames);
      if (nks) out.vendorNicknames = nks;
    }
    return out;
  });

  /* ── AN ITEM IS CREATED EMPTY ───────────────────────────────────────────
     Opening balances used to be summed out of the variants and saved with no
     stock transaction, so stock existed with nothing anywhere explaining where
     it came from and no movement to reconcile it against.

     The quantity is REFUSED rather than dropped. Silently ignoring it would
     leave the operator looking at a form they filled in, a success message and
     a shelf that never changed — the worst of the three outcomes. Opening
     stock is a stock adjustment and goes through the path that records one. */
  const openingRows = (Array.isArray(payload.variants) ? payload.variants : [])
    .map((v, i) => ({ i, q: Number(v?.quantity) || 0 })).filter((x) => x.q > 0);
  if (openingRows.length || (Number(payload.quantity) || 0) > 0) {
    throw fail("VALIDATION",
      "An item is created with no stock. Record the opening balance as a stock adjustment, so the movement is on the record.",
      { reason: "OPENING_QUANTITY_NOT_ACCEPTED", variantRows: openingRows.map((x) => x.i + 1) });
  }

  const sku = mintSku(name, str(payload.customCategory) || payload.category);
  /* Company-scoped: two companies may legitimately hold the same code. */
  if (await RawItem.findOne({ ...tenantContext.tenantFilter(tenant), sku }).session(session)) {
    throw fail("VALIDATION", "An item with similar SKU already exists. Please try again.");
  }

  const rawItem = new RawItem({
    /* Ownership from the resolved context ONLY — never from the payload. */
    ...tenantContext.stamp(tenant),
    name,
    sku: sku.toUpperCase(),
    /* Computed from the values actually being stored, not from the payload, so
       the key can never describe a different item than the record does. */
    masterIdentityKey: identityKey({
      name,
      category: payload.category,
      customCategory: payload.customCategory,
      unit: payload.unit,
      customUnit: payload.customUnit,
      usedAs: usedAsValue,
    }),
    identityUnique: claimsIdentity,
    category: str(payload.customCategory) ? "" : (payload.category || ""),
    customCategory: str(payload.customCategory) || "",
    usedAs: usedAsValue,
    productType: str(payload.productType).slice(0, 80),
    /* A property of the GOODS, recorded once here rather than on every
       quotation. Distinct from the supplier's GST HSN — see the model. */
    customsTariffCode: tariffCode(payload.customsTariffCode),
    unit: str(payload.customUnit) ? "" : (payload.unit || ""),
    customUnit: str(payload.customUnit) || "",
    defaultOwnership: ownership.defaultOwnership,
    quantity: 0,
    minStock: num(minStock) || 0,
    maxStock: num(maxStock) || 0,
    discounts: allowed.has(SECTION.COMMERCIAL) && Array.isArray(payload.discounts)
      ? payload.discounts
        .filter((d) => d.minQuantity && d.price && !Number.isNaN(Number(d.minQuantity)) && !Number.isNaN(Number(d.price)))
        .map((d) => ({ minQuantity: num(d.minQuantity), price: num(d.price) }))
      : [],
    attributes: allowed.has(SECTION.ATTRIBUTES) && Array.isArray(payload.attributes)
      ? payload.attributes
        .filter((a) => str(a.name) && Array.isArray(a.values) && a.values.length)
        .map((a) => ({ name: str(a.name), values: a.values.filter((v) => str(v)) }))
      : [],
    variants,
    description: str(payload.description),
    notes: str(payload.notes),
    createdBy: actorId,
  });

  try {
    await rawItem.save({ session });
  } catch (err) {
    /* ── THE RACE THE READ ABOVE CANNOT SEE ───────────────────────────────
       Two requests registering the same material at the same moment both read
       "not there" — snapshot isolation only conflicts on documents they both
       touch, and a row that does not exist yet is not one of those. The unique
       partial index is what actually stops the second one, and this turns its
       11000 into the same answer the read would have given, so a caller cannot
       tell whether they lost a race or simply arrived second. */
    if (err?.code === 11000 && str(err?.message).includes("masterIdentityKey")) {
      const winner = await findDuplicate(tenant, payload, session);
      throw fail("CONFLICT",
        winner
          ? `"${winner.name}" is already in this company's Store catalogue. Select it instead of registering it again.`
          : "That material was registered a moment ago. Search for it and select it.",
        {
          reason: "RAW_ITEM_ALREADY_REGISTERED",
          ...(winner ? { existing: publicItem(winner) } : {}),
        });
    }
    throw err;
  }
  return { rawItem, duplicate: duplicate ? publicItem(duplicate) : null };
}

module.exports = {
  SECTION, STORE_SECTIONS, MERCHANDISING_SECTIONS, SECTION_FIELDS,
  identityKey, hasComparableName, findDuplicate, createRawItem, publicItem, mintSku, tariffCode,
  RAW_ITEM_CATEGORIES,
};
