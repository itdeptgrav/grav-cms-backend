// services/merchandising/materialCatalogue.service.js
//
// STORE'S CATALOGUE, READ THROUGH A KEYHOLE.
//
// A merchandiser selecting materials needs to find the fabric Store already
// stocks and say "that one". Until now they typed its name, which meant the
// development BOM held a merchandiser's spelling of an item rather than a
// reference to it, and R&D had to guess which catalogue row "cotton mesh
// 135" meant.
//
// ── WHY NOT JUST CALL STORE'S OWN RAW-ITEMS ENDPOINT ────────────────────────
// Two reasons, and neither is style.
//
// The first is PERMISSION. `/api/cms/raw-items` sits behind Store's own
// `requireTenant` + `requireCapability(READ)`. Pointing Merchandising at it
// would mean every merchandiser needed a Store grant to choose a fabric —
// which is a grant to read the whole item master, its suppliers and its
// balances. The department would have been given the keys to a room it only
// needed to look into.
//
// The second is PAYLOAD. That endpoint answers with the item master: on-hand
// quantity, min and max stock, primary and alternate vendors, per-variant
// vendor nicknames with their PRICES and delivery days, quantity discounts,
// and the budget head the item is bought against. None of that is
// Merchandising's to see at selection time, and several pieces of it are
// commercially sensitive. A selection screen that received them would sooner
// or later show them.
//
// So this is a keyhole: identity only, this company only, and shaped field by
// field rather than by deleting what is unwanted from a document. A field
// added to RawItem tomorrow does not appear here by accident, which is the
// whole point of an allow-list.
//
// ── AND STORE'S CATEGORY IS NOT MERCHANDISING'S ─────────────────────────────
// Store files an item under "Zippers" because that is what it is. Merchandising
// records a row as TRIM because that is the part it plays in this garment.
// The two vocabularies answer different questions, so the map below SUGGESTS
// and never decides: it seeds the filter and pre-fills the form, and the
// merchandiser's own answer is what gets stored. Several Store categories —
// chemicals, dyes, patterns — map to nothing at all, because they are not
// components of a garment, and they are reachable without a filter rather than
// forced into a category they do not belong to.
"use strict";

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { ROW_CATEGORY } = require("../../models/CMS_Models/Merchandising/Development");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const rx = (v) => new RegExp(str(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Which Store categories a Merchandising category is usually found under.
 *
 * Read as: "when a merchandiser asks for trims, these are the shelves to
 * look on" — not "a zipper is a trim, always". Matching is case-insensitive
 * and covers `customCategory` too, because Store lets an item be filed under
 * a word that is not on its own list.
 */
const CATEGORY_SHELVES = Object.freeze({
  [ROW_CATEGORY.FABRIC]: ["fabric", "fabrics", "knit", "woven", "interlining", "fusing", "lining"],
  [ROW_CATEGORY.TRIM]: [
    "trims", "trim", "trims & accessory", "thread", "threads", "fasteners", "elastic",
    "buttons", "button", "zippers", "zipper", "laces", "lace", "ribbons", "ribbon",
    "cords", "cord", "tapes", "tape", "piping", "webbing", "velcro", "drawcord", "eyelets",
  ],
  [ROW_CATEGORY.LABEL]: ["labels", "label", "tags", "hangtag", "hangtags", "stickers"],
  [ROW_CATEGORY.ACCESSORY]: ["accessories", "accessory", "hardware"],
  [ROW_CATEGORY.SAMPLE_PACKAGING]: [
    "packaging", "packing materials", "packing", "polybag", "polybags", "cartons", "carton",
  ],
});

/** The reverse lookup, built once: a Store shelf → the category it suggests. */
const SUGGESTION = new Map();
for (const [category, shelves] of Object.entries(CATEGORY_SHELVES)) {
  for (const shelf of shelves) if (!SUGGESTION.has(shelf)) SUGGESTION.set(shelf, category);
}

/**
 * What development category this Store item PROBABLY is, or null.
 *
 * Null is an ordinary answer — chemicals, dyes and patterns reach it, and so
 * does any word a company invented for its own shelf. The form then asks the
 * merchandiser instead of pre-filling a guess, which is the honest behaviour:
 * a wrong pre-fill that nobody notices becomes a wrong row.
 */
function suggestCategory(item) {
  const seen = [str(item?.category).toLowerCase(), str(item?.customCategory).toLowerCase()];
  for (const shelf of seen) {
    if (shelf && SUGGESTION.has(shelf)) return SUGGESTION.get(shelf);
  }
  return null;
}

/* ── THE ALLOW-LIST ────────────────────────────────────────────────────────
   Named field by field. `select` with a minus list would have been shorter
   and would have leaked every field added to RawItem afterwards. */
const SAFE_SELECT = "name sku category customCategory unit customUnit attributes "
  + "variants._id variants.sku variants.combination companyId";

/* ── AND AN ALLOW-LIST OF FIELDS IS NOT ENOUGH ─────────────────────────────
   `attributes` is the one safe-looking field that is FREE TEXT, both in its
   names and in its values. Nothing stops a company defining an attribute
   called "Vendor", "Landed cost" or "MOQ" — and real catalogues do, because
   the item master is where people put the fact they have nowhere else to
   put. A row shaped by field name alone therefore carried a supplier's name
   into a Merchandising screen through a field called `attributes`.

   So the names are screened too. Deliberately broad: it matches a whole word
   anywhere in the attribute's name, so "Vendor", "Preferred vendor" and
   "Vendor code" all go, and a false positive costs a merchandiser one
   attribute they could have seen while a false negative costs the company a
   commercial fact it did not mean to publish. The trade is not symmetric.

   Screened, never renamed or blanked: the attribute is absent from the
   response, so nothing downstream can mistake an emptied field for a fact.  */
const SENSITIVE_ATTRIBUTE = new RegExp([
  "vendor", "supplier", "seller", "manufacturer", "brand[- ]?owner",
  "price", "prices", "pricing", "rate", "rates", "cost", "costs", "costing",
  "mrp", "margin", "markup", "discount", "landed",
  "stock", "quantity", "qty", "balance", "on[- ]?hand", "inventory",
  "moq", "minimum[- ]?order", "lead[- ]?time", "delivery[- ]?days",
  "purchase", "po", "invoice", "bill",
  "gst", "hsn", "tariff", "duty", "ledger", "budget",
  "payment", "credit", "terms",
].map((w) => `(?:^|[^a-z])${w}(?:[^a-z]|$)`).join("|"), "i");

const attributeIsSafe = (a) => str(a?.name) && !SENSITIVE_ATTRIBUTE.test(str(a.name));

/** The attributes as Store declares them, minus the ones that are not ours. */
const declaredAttributes = (item) => (Array.isArray(item?.attributes) ? item.attributes : [])
  .map((a) => ({
    name: str(a?.name),
    values: (Array.isArray(a?.values) ? a.values : []).map(str).filter(Boolean),
  }))
  .filter((a) => a.name && a.values.length);

/**
 * The variant, as Merchandising is allowed to see it: which one, and what it is.
 *
 * ── THE COMBINATION IS ATTRIBUTE VALUES, SO IT LEAKS THE SAME WAY ──────────
 * A variant's `combination` is one value per declared attribute, in the
 * order the attributes are declared — that is how Store generates them. An
 * item whose attributes are Colour and Vendor therefore has variants reading
 * ["Slate", "Meridian Mills"], and a screen showing the combination would
 * print the supplier as though it were a colourway.
 *
 * The rule is one sentence: an item that declares NO screened attribute has
 * nothing to leak through its combinations and keeps them whole; an item that
 * declares one keeps only the values whose own attribute can be named and is
 * safe, and the unmapped tail — legacy records do carry combinations longer
 * than their attribute list — is DROPPED, because a value whose attribute
 * cannot be named is a value nobody can promise is safe.
 *
 * Written that way round so that screening a supplier costs the reader the
 * supplier, and not every colourway on every legacy record beside it.
 */
const safeVariant = (v, attributes = [], screened = false) => {
  const values = (Array.isArray(v?.combination) ? v.combination : []).map(str);
  return {
    variantId: str(v?._id),
    sku: str(v?.sku),
    combination: (screened
      ? values.filter((_, i) => attributes[i] && attributeIsSafe(attributes[i]))
      : values
    ).filter(Boolean),
  };
};

/**
 * One catalogue row.
 *
 * Note what a reader cannot learn from this: whether any of it is in stock,
 * whether it is below its minimum, who supplies it, what it costs, or what it
 * is bought against. The variant carries its combination and its code and
 * nothing else — not even its status, which on RawItem is derived from the
 * balance and would smuggle the stock position through as a word.
 */
/**
 * CAN A MERCHANDISER ACTUALLY TELL THESE VARIANTS APART?
 *
 * This is not a cosmetic question. Screening the supplier out of an item
 * master that models SUPPLIERS AS VARIANTS — which this one does, at scale —
 * leaves variants whose only distinguishing value has been removed. They come
 * through as several identical, unnamed chips, and a screen that then demands
 * a choice between them is asking somebody to pick at random and calling the
 * result a specification.
 *
 * So the item says which of three situations it is in, and the screen obeys
 * it rather than guessing:
 *
 *   "none"            — no variants at all; an ordinary item.
 *   "required"        — every variant has its own readable label. Choose one.
 *   "indistinguishable" — two or more read identically once screened. The
 *                       item may be selected WITHOUT a variant, and the
 *                       screen says why instead of pretending there is a
 *                       choice to make.
 *
 * The third is a true statement about the catalogue, not a failure of this
 * code: Store is distinguishing those rows by a commercial fact, and the
 * lasting fix is for Store to model the supplier as a supplier. Until it
 * does, the honest thing is to say so.
 */
function variantChoiceOf(variants) {
  if (!variants.length) return "none";
  const labels = variants.map((v) => [...v.combination, v.sku].filter(Boolean).join(" · "));
  if (labels.some((l) => !l)) return "indistinguishable";
  return new Set(labels).size === labels.length ? "required" : "indistinguishable";
}

const safeItem = (item) => {
  /* Screened once, and used for BOTH the attribute list and the positional
     filter on every variant — one reading, so the two cannot disagree. */
  const declared = declaredAttributes(item);
  const screened = declared.some((a) => !attributeIsSafe(a));
  const variants = (Array.isArray(item?.variants) ? item.variants : [])
    .map((v) => safeVariant(v, declared, screened));
  return {
    variantChoice: variantChoiceOf(variants),
    rawItemId: str(item?._id),
    name: str(item?.name),
    sku: str(item?.sku),
    category: str(item?.category),
    customCategory: str(item?.customCategory),
    unit: str(item?.unit) || str(item?.customUnit),
    attributes: declared.filter(attributeIsSafe),
    variants,
    variantCount: variants.length,
    suggestedCategory: suggestCategory(item),
  };
};

/** The shelves a Merchandising category reads, as a Mongo clause. */
function shelfClause(category) {
  const shelves = CATEGORY_SHELVES[category];
  if (!shelves) {
    throw fail("VALIDATION", `"${category}" is not a development material category.`,
      { field: "category", allowed: Object.values(ROW_CATEGORY) });
  }
  const any = shelves.map((s) => new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"));
  return { $or: [{ category: { $in: any } }, { customCategory: { $in: any } }] };
}

/**
 * SEARCH — this company's Store catalogue, identity only.
 *
 * Paged by keyset on (name, _id) rather than by skip: a picker is read while
 * Store is being edited, and skip-paging silently repeats and drops rows when
 * the set shifts under it. `total` is counted only on the first page, so
 * typing a query costs one count, not one per page.
 */
async function search(ctx, { q = "", category = "", cursor = "", limit } = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Merchandising.");
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  /* ── SAME COMPANY, FULL STOP ──────────────────────────────────────────
     Not Store's `tenantFilter`, which in legacy mode widens to the records
     that carry no company at all. Those belong to nobody; a development BOM
     that referenced one would hold a pointer this company cannot prove it
     owns. They are excluded, and the empty state says the catalogue is
     empty rather than pretending it was searched badly. */
  const clauses = [];
  if (str(q)) {
    const term = rx(q);
    clauses.push({
      $or: [
        { name: term }, { sku: term }, { category: term }, { customCategory: term },
        /* ── A SEARCH MUST NOT MATCH WHAT THE ANSWER CANNOT SHOW ──────
           Matching `attributes.values` flatly would let a merchandiser
           type a supplier's name and be told which items it matched —
           the value never appears in the response, but the HIT is itself
           the disclosure. So the term is matched against a safe attribute
           or none: `$elemMatch` keeps the name test and the value test on
           the SAME attribute, which a pair of dotted paths would not.

           `variants.combination` is deliberately not searched. Its values
           ARE the attribute values, in attribute order, so the clause
           above already finds them — and unlike that clause, a query on
           the combination has no way to tell which position it matched,
           and so no way to exclude the sensitive ones. */
        {
          attributes: {
            $elemMatch: { name: { $not: SENSITIVE_ATTRIBUTE }, values: term },
          },
        },
        { "variants.sku": term },
        /* And the combinations of items that declare nothing screened —
           which is the same rule the response applies, expressed as a
           query. An item that DOES declare a screened attribute stays
           findable through the clause above, by the attribute values it
           is safe to search. */
        {
          $and: [
            { "variants.combination": term },
            { attributes: { $not: { $elemMatch: { name: SENSITIVE_ATTRIBUTE } } } },
          ],
        },
      ],
    });
  }
  if (str(category)) clauses.push(shelfClause(str(category).toUpperCase()));

  if (str(cursor)) {
    const [name, id] = str(cursor).split("|");
    if (!isId(id)) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    clauses.push({
      $or: [
        { name: { $gt: name } },
        { name, _id: { $gt: new mongoose.Types.ObjectId(id) } },
      ],
    });
  }

  const filter = { companyId: ctx.companyId };
  if (clauses.length) filter.$and = clauses;

  const [found, total, catalogueSize] = await Promise.all([
    RawItem.find(filter).select(SAFE_SELECT).sort({ name: 1, _id: 1 }).limit(size + 1).lean(),
    str(cursor) ? Promise.resolve(null) : RawItem.countDocuments(filter),
    /* What the company has AT ALL, so "nothing matched" can be told apart
       from "Store has not registered anything here yet". They need different
       words and lead to different places. */
    str(cursor) || (!str(q) && !str(category))
      ? Promise.resolve(null)
      : RawItem.countDocuments({ companyId: ctx.companyId }),
  ]);

  const page = found.slice(0, size);
  const last = page[page.length - 1];

  return {
    rows: page.map(safeItem),
    total: total ?? null,
    catalogueSize: catalogueSize ?? (total ?? null),
    hasMore: found.length > size,
    nextCursor: found.length > size && last ? `${str(last.name)}|${str(last._id)}` : null,
    categories: Object.keys(CATEGORY_SHELVES),
  };
}

/**
 * RESOLVE — turn the client's two ids into the catalogue's own words.
 *
 * The browser sends `rawItemId` and, when the item has variants, `variantId`.
 * Everything else about the item's identity — its name, its code, what the
 * variant IS — is read here and written into the row by the server. A client
 * that sent a name is not refused; its name is simply not used, because the
 * catalogue is the authority on what its items are called and a stored row
 * that disagreed with it would be a second, quieter master.
 *
 * ── A FOREIGN ITEM AND A MISSING ONE ANSWER IDENTICALLY ────────────────────
 * Both are "not in this company's catalogue". Distinguishing them would turn
 * this endpoint into a way to ask whether another company stocks a given id.
 */
async function resolve(ctx, { rawItemId, variantId } = {}, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Merchandising.");
  if (!isId(rawItemId)) {
    throw fail("VALIDATION", "That is not a catalogue reference.", { field: "rawItemId" });
  }

  const item = await RawItem.findOne({ _id: rawItemId, companyId: ctx.companyId })
    .select(SAFE_SELECT).session(session).lean();
  if (!item) {
    throw fail("DEVELOPMENT_CATALOGUE_ITEM_NOT_FOUND",
      "That material is not in this company's Store catalogue.", { field: "rawItemId" });
  }

  const variants = Array.isArray(item.variants) ? item.variants : [];
  let variant = null;
  if (str(variantId)) {
    if (!isId(variantId)) {
      throw fail("VALIDATION", "That is not a variant reference.", { field: "variantId" });
    }
    variant = variants.find((v) => str(v._id) === str(variantId)) || null;
    if (!variant) {
      throw fail("DEVELOPMENT_CATALOGUE_VARIANT_NOT_FOUND",
        `"${str(item.name)}" has no such variant.`, { field: "variantId" });
    }
  }

  return {
    rawItemId: item._id,
    rawItemName: str(item.name).slice(0, 200),
    rawItemSku: str(variant?.sku) || str(item.sku),
    variantId: variant ? variant._id : null,
    variantCombination: variant
      ? (Array.isArray(variant.combination) ? variant.combination : []).map(str).filter(Boolean)
      : [],
    suggestedCategory: suggestCategory(item),
  };
}

module.exports = {
  search, resolve, suggestCategory, safeItem, variantChoiceOf,
  CATEGORY_SHELVES, SAFE_SELECT, DEFAULT_LIMIT, MAX_LIMIT,
};
