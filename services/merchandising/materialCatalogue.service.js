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

const materialOwnership = require("../inventory/materialOwnership.service");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { ROW_CATEGORY } = require("../../models/CMS_Models/Merchandising/Development");
const usedAsDef = require("../../models/CMS_Models/Inventory/Products/usedAs");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const { fail } = require("../storePurchase/errors");
const rawItemCreation = require("../../services/inventory/rawItemCreation.service");

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
const SAFE_SELECT = "name sku category customCategory usedAs unit customUnit attributes "
  + "variants._id variants.sku variants.combination companyId "
  /* Whose property the material normally is — a merchandiser choosing a
     customer-supplied line should see it. */
  + "defaultOwnership";

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
    /* Store's own classification, shown as a small label on each result so a
       merchandiser can see what part Store says this item plays. */
    usedAs: str(item?.usedAs) || usedAsDef.DEFAULT_USED_AS,
    usedAsLabel: usedAsDef.usedAsLabel(item?.usedAs) || usedAsDef.usedAsLabel(usedAsDef.DEFAULT_USED_AS),
    attributes: declared.filter(attributeIsSafe),
    variants,
    variantCount: variants.length,
    suggestedCategory: suggestCategory(item),
    /* Company owned, or customer property. */
    ownership: materialOwnership.ownershipView(item),
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
async function search(ctx, { q = "", category = "", section = "", cursor = "", limit } = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Merchandising.");
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  /* ── THE HARD GATE ────────────────────────────────────────────────────
     The section fixes the ONLY `usedAs` values this call may ever surface —
     Materials & Trims sees the four garment-component classes, Sample
     Packaging sees only sample packaging — and a `category` can narrow within
     that but never widen it. Everything Store marked a factory consumable, a
     machine spare, an electrical item, a tool, "not for product BOM" or "not
     classified" is absent by construction: no section maps to it, so no
     forged category or widened query can reveal it. Default is Materials, so a
     caller that sends nothing gets the safe set rather than the whole catalogue. */
  const sectionResolved = usedAsDef.SECTION[str(section).toUpperCase()] || usedAsDef.SECTION.MATERIALS;
  const allowedUsedAs = usedAsDef.allowedUsedAs(sectionResolved, category);

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
  /* The hard gate, ANDed into every query — it cannot be turned off from the
     client. `category` has already narrowed `allowedUsedAs` within the section. */
  clauses.push({ usedAs: { $in: allowedUsedAs } });

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
    /* How many items Store has CLASSIFIED FOR THIS SECTION at all, so "nothing
       matched" can be told apart from "Store has not classified anything for
       this section yet". They need different words and lead to different
       places (the empty state asks Store to set an item's "Used as"). */
    str(cursor)
      ? Promise.resolve(null)
      : RawItem.countDocuments({
        companyId: ctx.companyId,
        usedAs: { $in: usedAsDef.SECTION_USED_AS[sectionResolved] },
      }),
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
    /* Which section this answered for, and the exact classifications it may
       show — so the client cannot believe it is seeing more than it is. */
    section: sectionResolved,
    usedAsAllowed: allowedUsedAs,
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

/* ═══ REGISTERING A MATERIAL STORE DOES NOT HAVE YET ═══════════════════════
   A merchandiser searches the catalogue for the lining the buyer specified and
   it is not there — because nobody has bought it yet. Until now the only
   answers were to describe it as unregistered text, which leaves R&D guessing,
   or to stop, message Store, and come back tomorrow. Both of those are how a
   BOM ends up holding spellings instead of references.

   So there is a door. It is a KEYHOLE in the same sense as the search above:
   it registers a material's IDENTITY and nothing else.

   ── WHAT THIS DOOR IS NOT ────────────────────────────────────────────────
   It is not `sp.master.maintain`. A merchandiser who walks through it does not
   acquire the ability to set opening stock, adjust a balance, record a
   purchase price, name a supplier or maintain a supplier alias — and does not
   acquire it by omission either. The shared creation service is told which
   SECTIONS this caller may supply, and a payload carrying anything else is
   REFUSED rather than quietly stripped, so nobody is left believing they
   recorded a price that was dropped on the way in.

   It also does not create UNITS or CATEGORIES. Both are Store configuration —
   a unit especially, since a conversion factor on one retroactively changes
   what every stored quantity in it MEANS — so this door will only accept a
   category from Store's own list and a unit from this company's unit master.
   `customCategory` and `customUnit` are the fields that would invent them, and
   they are refused by name rather than ignored.

   ── WHY IT REFUSES A DUPLICATE INSTEAD OF REGISTERING ONE ────────────────
   This is reached at exactly the moment a search failed to find something, and
   a search fails for two quite different reasons: the material genuinely is
   not there, or it is there under a name the merchandiser did not type. Store's
   own screen may register a near-duplicate — a storekeeper can see the
   catalogue in front of them and may have a reason. Here the honest answer is
   to hand back the item that matched so the drawer can offer it, because a
   second row for one yarn is a cost somebody pays for years. */

/** A name that a person, and a duplicate check, can work with. */
const MIN_NAME = 2;
const MAX_NAME = 120;

/**
 * What the drawer's form may offer.
 *
 * Store's standard shelves, plus the words this company has actually filed
 * items under, plus this company's active units. All three are needed to
 * register an item at all, and none of them is a commercial fact — a unit is
 * "Meter", a shelf is "Trims". Nothing here reveals a balance, a price or a
 * supplier, which is the line this whole service exists to hold.
 */
async function registrationOptions(ctx, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Merchandising.");

  const [inUse, units] = await Promise.all([
    RawItem.distinct("customCategory", { companyId: ctx.companyId }, { session }),
    Unit.find({ companyId: ctx.companyId, status: "Active" })
      .select("name").sort({ name: 1 }).session(session)
      .lean(),
  ]);

  const standard = rawItemCreation.RAW_ITEM_CATEGORIES;
  const known = new Set(standard.map((c) => c.toLowerCase()));
  const companyOwn = [...new Set((inUse || []).map(str).filter(Boolean))]
    .filter((c) => !known.has(c.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  return {
    /* Store's shelves first, then the company's own words, each marked so the
       form can group them rather than present one undifferentiated list. */
    categories: [
      ...standard.map((name) => ({ name, source: "standard" })),
      ...companyOwn.map((name) => ({ name, source: "company" })),
    ],
    units: (units || []).map((u) => ({ name: str(u.name) })),
    /* Only the classifications a garment BOM can use. A merchandiser
       registering a lining has no business filing it as a machine spare, and
       offering the full list would invite exactly that. Store can reclassify it
       later if the item turns out to be something else. */
    usedAs: usedAsDef.PRODUCT_BOM_USED_AS.map((value) => ({
      value, label: usedAsDef.usedAsLabel(value),
    })),
  };
}

/** The category this door will accept, or a refusal naming the alternative. */
function acceptCategory(categories, wanted) {
  const want = str(wanted).toLowerCase();
  const match = categories.find((c) => c.name.toLowerCase() === want);
  if (!match) {
    throw fail("VALIDATION",
      `"${str(wanted)}" is not a Store category. Choose one of Store's, or ask Store to add it.`,
      { field: "category", reason: "CATEGORY_NOT_IN_STORE" });
  }
  return match.name;
}

/** The unit this door will accept. A unit it has not got is not one it invents. */
function acceptUnit(units, wanted) {
  const want = str(wanted).toLowerCase();
  const match = units.find((u) => u.name.toLowerCase() === want);
  if (!match) {
    throw fail("VALIDATION",
      `"${str(wanted)}" is not a unit this company has. Choose one of its units, or ask Store to add it.`,
      { field: "unit", reason: "UNIT_NOT_IN_COMPANY" });
  }
  return match.name;
}

/**
 * Register a material in this company's Store catalogue, identity only.
 *
 * @param {object} ctx     the Merchandising context — `companyId` is the ONLY
 *                         source of ownership
 * @param {object} body    `{ name, category, unit, usedAs, description }`
 * @param {string} actorId the authenticated actor — the ONLY source of
 *                         `createdBy`
 * @returns {Promise<{item: object}>} the created item in the SAME shape a
 *          search result has, so the drawer selects it with the code it already
 *          has rather than a second, nearly identical path
 */
async function register(ctx, body = {}, actorId = null, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Merchandising.");

  /* Refused by name, not ignored: these are the two fields that would create
     Store configuration through a Merchandising grant. */
  const invents = ["customCategory", "customUnit"].filter((f) => str(body?.[f]));
  if (invents.length) {
    throw fail("FORBIDDEN",
      "Store maintains its categories and units. Choose one that exists, or ask Store to add it. Nothing was saved.",
      { reason: "STORE_CONFIGURATION_NOT_PERMITTED_HERE", fields: invents });
  }

  const name = str(body.name);
  if (name.length < MIN_NAME) {
    throw fail("VALIDATION", "Give the material a name R&D and Store will recognise.",
      { field: "name" });
  }
  if (name.length > MAX_NAME) {
    throw fail("VALIDATION", `A material name is at most ${MAX_NAME} characters.`, { field: "name" });
  }

  const options = await registrationOptions(ctx, session);
  const category = acceptCategory(options.categories, body.category);
  const unit = acceptUnit(options.units, body.unit);

  /* An unstated classification is DERIVED from the category rather than left
     unset, because an item that reaches the catalogue as NOT_CLASSIFIED is
     invisible to the very picker this drawer was opened from — the merchandiser
     would register a material and then fail to find it. A value the caller DID
     state must be one a garment BOM can hold. */
  const offered = new Set(options.usedAs.map((u) => u.value));
  let usedAs = str(body.usedAs).toUpperCase();
  if (usedAs && !offered.has(usedAs)) {
    throw fail("VALIDATION",
      "That is not a classification a garment's bill of materials uses.",
      { field: "usedAs", allowed: [...offered] });
  }
  if (!usedAs) usedAs = usedAsDef.classifyByCategory(category) || "";
  if (usedAs && !offered.has(usedAs)) usedAs = "";

  /* Merchandising's own envelope fields. They say WHICH file this was done
     from and how the request is de-duplicated — they are not facts about the
     material, so they are removed rather than refused. Everything else the
     caller sent travels on, where the shared service refuses whatever this
     door may not supply. */
  const { fileId, idempotencyKey, expectedRevision, ...material } = body || {};

  const { rawItem } = await rawItemCreation.createRawItem({
    /* Company from the resolved Merchandising context, actor from the session.
       Neither is read from the payload, and a payload naming either is not
       merged — it is ignored. */
    tenant: { companyId: ctx.companyId },
    actorId,
    payload: {
      ...material,
      /* Read back from Store's own masters, so what is stored is Store's
         spelling of the category and unit rather than the caller's casing. */
      name, category, unit,
      /* Empty means "Store decides later" — the model's own default — rather
         than a guess this door is not entitled to make. */
      ...(usedAs ? { usedAs } : {}),
      description: body.description,
    },
    /* Identity and classification. Not stock levels, not variants, not
       attributes, not conversions, not discounts, not suppliers. */
    sections: rawItemCreation.MERCHANDISING_SECTIONS,
    onDuplicate: "refuse",
    /* Part of the caller's unit of work, not a write of its own. The item and
       the audit row that says why it exists commit together or not at all. */
    session,
  });

  /* Read back through the same keyhole the search uses. The drawer then holds
     a row indistinguishable from a search result — same `variantChoice`, same
     `suggestedCategory` — and selects it without a special case. */
  return { item: safeItem(rawItem.toObject ? rawItem.toObject() : rawItem) };
}

module.exports = {
  search, resolve, suggestCategory, safeItem, variantChoiceOf,
  registrationOptions, register,
  CATEGORY_SHELVES, SAFE_SELECT, DEFAULT_LIMIT, MAX_LIMIT,
};
