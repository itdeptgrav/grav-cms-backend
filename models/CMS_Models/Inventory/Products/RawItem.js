// models/CMS_Models/Inventory/Products/RawItem.js
//
// Refactored model. Changes vs prior version:
//   1. REMOVED: item-level `vendorNicknames` array
//   2. ADDED:   `variant.image` (Cloudinary URL string — frontend uploads directly)
//   3. ADDED:   `variant.vendorNicknames[]` (per-variant aliases)
//
// Everything else (stockTransactions, primaryVendor, alternateVendors,
// discounts, attributes, etc.) is preserved.
//
// NOTE: If your previous model had additional custom fields not shown here,
// merge them in. This file matches what the routes file expects.

const mongoose = require("mongoose");
const { USED_AS_VALUES, DEFAULT_USED_AS } = require("./usedAs");
const { DEFAULT_OWNERSHIP, DEFAULT_OWNERSHIP_VALUES } = require("./materialOwnership");

// e.g. Button → fromUnit "Piece", toUnit "Kilogram", quantity 0.4  → 1 pc = 0.4 KG
const unitConversionSchema = new mongoose.Schema(
  {
    fromUnit: { type: String, trim: true, default: "" },
    toUnit:   { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

// ── Per-variant vendor alias ───────────────────────────────────────────────
const variantVendorNicknameSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true
    },
    nickname:     { type: String, required: true, trim: true },  // vendor's code/name for this variant
    price:        { type: Number, default: 0, min: 0 },          // vendor's price for this variant
    deliveryDays: { type: Number, default: 0, min: 0 },          // delivery timeline in days
    notes:          { type: String, default: "", trim: true },
    specifications: [{ key: { type: String, default: "" }, value: { type: String, default: "" } }]
  },
  { timestamps: true }
);

// ── Variant ────────────────────────────────────────────────────────────────
const variantSchema = new mongoose.Schema({
  combination: [{ type: String }],
  quantity:    { type: Number, default: 0, min: 0 },
  minStock:    { type: Number, default: 0 },
  maxStock:    { type: Number, default: 0 },
  sku:         { type: String, default: "" },

  // ── NEW: per-variant fields ──
  image:           { type: String, default: "" },          // Cloudinary URL
  vendorNicknames: [variantVendorNicknameSchema],          // per-variant aliases
  unitConversion:  { type: unitConversionSchema, default: null },   // legacy — kept for backward compat
  unitConversions: [unitConversionSchema],

  status: { type: String, default: "In Stock" }
});

// ── Stock transaction (embedded) ───────────────────────────────────────────
const stockTransactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["ADD", "REDUCE", "PURCHASE_ORDER", "VARIANT_ADD", "VARIANT_REDUCE", "CONSUME"],
      required: true
    },
    quantity:           { type: Number, required: true },
    variantCombination: [{ type: String }],
    variantId:          { type: mongoose.Schema.Types.ObjectId },

    /* ── WHOSE GOODS MOVED ───────────────────────────────────────────────────
       COMPANY for the factory's own stock (the default — every purchase, MRF,
       adjustment and return), CUSTOMER for customer-supplied material that is
       physically held but owned by the customer. It is explicit provenance on
       each NEW movement so the valuation engine can exclude customer property
       from company inventory value and on-hand WITHOUT inference; historical
       customer movements (written before this field) are recovered instead from
       CustomerMaterialLot.movements[].stockTransactionId. RawItem.quantity stays
       the honest PHYSICAL total either way — ownership never removes stock, only
       decides whose it is. */
    ownership: { type: String, enum: ["COMPANY", "CUSTOMER"], default: "COMPANY" },

    previousQuantity: { type: Number, default: 0 },
    newQuantity:      { type: Number, default: 0 },

    /* ── THE VARIANT'S OWN BEFORE AND AFTER ──────────────────────────────────
       Written whenever a movement targets a specific variant, so the variant's
       balance has the same continuous audit chain the item-level balance has.
       They were being stored without ever being declared: the stock movements
       are written as aggregation-pipeline updates, which bypass Mongoose's
       casting and validation entirely, so the fields reached the database
       regardless of what this schema said and were invisible to anything
       reading through the model. Null on a movement that touched no variant —
       distinct from 0, which would claim the variant was emptied. */
    variantPreviousQuantity: { type: Number, default: null },
    variantNewQuantity:      { type: Number, default: null },

    reason:          { type: String, default: "" },
    supplier:        { type: String, default: "" },
    supplierId:      { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    unitPrice:       { type: Number, default: 0 },
    purchaseOrder:   { type: String, default: "" },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    invoiceNumber:   { type: String, default: "" },
    notes:           { type: String, default: "" },

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },

    /* ── WHICH OPERATION MOVED THIS STOCK ────────────────────────────────────
       The `_id` of the Store & Purchase idempotency record whose action wrote
       this line. It is what lets a retry ask "did MY attempt already move
       stock?" and get an answer that cannot be confused with an earlier,
       identical-looking movement of the same item for the same quantity.
       Null on everything written before, and on movements from routes that are
       not yet governed. */
    operationId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    /* ── WHERE IN THE WAREHOUSE THIS MOVEMENT LANDED / LEFT (Warehouse Stock V1)
       A snapshot of the warehouse/location the paired LocationMovement records,
       so Stock movements can show the real location without a fragile join.
       Absent on legacy movements and on operations not yet location-aware —
       those read as "Unassigned", never guessed onto a warehouse. */
    warehouseId:   { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    locationId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, default: "" },
    locationCode:  { type: String, default: "" },
    locationName:  { type: String, default: "" },

    /* Mongoose's `timestamps` option does not run for an update written as an
       aggregation pipeline, and the stock movements are written that way so
       they can be atomic. The route sets these explicitly; declaring them here
       is what stops a ledger line from silently carrying none. */
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ── Discount ───────────────────────────────────────────────────────────────
const discountSchema = new mongoose.Schema({
  minQuantity: { type: Number, required: true, min: 0 },
  price:       { type: Number, required: true, min: 0 }
});

// ── Attribute ──────────────────────────────────────────────────────────────
const attributeSchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true },
  values: [{ type: String, trim: true }]
});



// ── Helper: derive status from qty vs minStock ──
const deriveStatus = (qty, minStock) => {
  const q = Number(qty) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "Out of Stock";
  if (q <= m) return "Low Stock";
  return "In Stock";
};

// ── Main RawItem ───────────────────────────────────────────────────────────
const rawItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /* Not `unique` here any more: uniqueness is company-scoped, declared as a
       compound index below. Mongoose never DROPS an index it stops declaring,
       so the legacy global `sku_1` survives on running deployments and must be
       retired deliberately — see
       scripts/migrations/store-purchase-catalogue-indexes.js. */
    sku:  { type: String, required: true, trim: true },

    category:       { type: String, default: "" },

    /* ── HOW CUSTOMS CLASSIFIES THESE GOODS ───────────────────────────────
       The tariff heading an import of this item is entered under. A property
       of the GOODS, so it is recorded once here rather than on every
       quotation — two suppliers of one fabric do not classify it differently,
       and storing it per offer would let them appear to.

       ── AND IT IS NOT THE HSN ON A QUOTATION ─────────────────────────────
       `SupplierOffer.hsnCode` is what the supplier wrote for GST. The two
       derive from the same Harmonised System and are routinely different
       lengths for the same goods — the GST code is what the seller charges
       tax under, this is what the importer clears customs under. Reading one
       as the other is how a duty is worked out against the wrong heading.

       Empty means nobody has classified it. It is never defaulted, never
       inferred from the category, and never read as "no duty". */
    customsTariffCode: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    /* "Product Type" on the item form (Raw Material, Asset, Consumable…). The
       form has offered it since the start and the list filtered on it, but
       the field was never on the schema, so every save dropped it (29 Sep
       2026: "the marked inputs are defined but edit shows nothing filled"). */
    productType: { type: String, trim: true, maxlength: 80, default: "" },

    /* ── WHAT WOULD MAKE THIS THE SAME MATERIAL AS ANOTHER ──────────────────
       The name, the shelf, the unit and the classification, with case, spacing
       and punctuation removed, joined into one string.

       It exists because the SKU cannot do this job. `RAW-FAB-POLMES-417` ends
       in three random digits, so registering the same yarn twice a minute apart
       mints two different codes and a uniqueness check on the SKU passes on
       both — which is how a catalogue ends up holding one material under four
       codes that no report can add together.

       Stored rather than computed at query time so the check is an indexed
       lookup and so "Poly mesh 135", "poly-mesh 135" and "POLY  MESH  135"
       collide, which a regex on `name` cannot do. Empty on items created before
       this field existed; the duplicate check falls back to an exact-name
       comparison for those rather than pretending they have one. */
    masterIdentityKey: { type: String, trim: true, default: "", index: false },

    /* ── AND WHETHER THAT IDENTITY IS CLAIMED AS THE ONLY ONE ───────────────
       True only on items registered through a door that REFUSES duplicates —
       today, the Development BOM's narrow registration drawer. Those rows are
       covered by a unique index on `{companyId, masterIdentityKey}` (declared
       below), which is what makes two simultaneous registrations of the same
       material produce one item rather than two: the second loses the index,
       not a race that nobody notices.

       Store's own item screen leaves it FALSE, deliberately. A storekeeper can
       see the catalogue in front of them and may have a real reason to register
       a second row for what looks like the same material — a different mill's
       equivalent, a re-coded replacement, a row kept for history. Turning that
       judgement into a database error nobody can act on would be the migration
       equivalent of refusing to let a person do their job. So the flag is set
       by the caller's DUPLICATE POLICY rather than by the field's existence, and
       the two doors keep their different answers.

       It lives on the item rather than in a separate claim table so that
       deleting an item releases its claim. A claim outliving the row it
       described would block re-registering a material that no longer exists. */
    identityUnique: { type: Boolean, default: false },

    /* ── THIS ITEM'S OWN BUDGET HEAD, WHERE IT DIFFERS FROM ITS CATEGORY ───
       Normally empty. The head comes from the item's CATEGORY (see
       Acc_ItemCategoryBudget) because mapping 15 categories is a meeting and
       mapping every item is a project nobody finishes.

       Set only where an item genuinely does not belong with its siblings —
       a fabric bought for sampling rather than production, say. An empty
       value is not "unknown", it is "whatever my category says", which is
       what keeps this field rare and therefore trustworthy. */
    budgetLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", default: null },
    /* Display snapshot, never the authority — the id is. Held so a resolver
       can name the head without a join per item, and deliberately allowed to
       go stale: a head renamed next year must not silently restate what this
       override was set to. */
    budgetLedgerName: { type: String, trim: true, default: "" },
    budgetLedgerSetBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User", default: null },
    budgetLedgerSetByName: { type: String, trim: true, default: "" },
    budgetLedgerSetAt: { type: Date, default: null },
    customCategory: { type: String, default: "" },

    /* ── WHAT PART THIS ITEM PLAYS, AND WHERE IT MAY BE SELECTED ───────────
       Store-owned. `category` says what the item IS; `usedAs` says what it is
       FOR — and it is what Merchandising reads to decide whether the item may
       appear in a product BOM picker. Merchandising can never write it: its
       routes carry no Store grant and expose no field for it. Defaults to
       NOT_CLASSIFIED, which keeps an unclassified item OUT of every picker
       until Store classifies it — the safe direction. */
    usedAs: {
      type: String,
      enum: USED_AS_VALUES,
      default: DEFAULT_USED_AS,
    },

    unit:       { type: String, default: "" },
    customUnit: { type: String, default: "" },

    /* ── WHOSE PROPERTY THIS MATERIAL NORMALLY IS ─────────────────────────
       A catalogue DEFAULT, not a stock fact. CUSTOMER_OWNED says the material
       is normally supplied by a customer and remains their property, so a
       receipt of it preselects customer ownership and the customer named
       below. It never creates stock and never re-owns stock already held:
       physical ownership is decided per receipt (GoodsReceipt.sourceType),
       per lot (CustomerMaterialLot) and per movement
       (stockTransactions[].ownership), and none of those read this field.
       Defaults to COMPANY_OWNED so every item registered before the field
       existed, and every client that never sends it, reads as what it was. */
    defaultOwnership: {
      type: String,
      enum: DEFAULT_OWNERSHIP_VALUES,
      default: DEFAULT_OWNERSHIP.COMPANY_OWNED,
    },
    /* The customer whose property a CUSTOMER_OWNED material normally is. The
       identity is the Customer's own id — the same reference every lot and
       receipt carries — and it is validated on the server against this
       company's reach before it is stored. Always null on a company-owned
       material: the route clears it rather than letting a stale customer
       ride along after somebody switches the default back. */
    owningCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    /* Display snapshot beside the id, in the same shape the receipts and lots
       keep (services/merchandising/customerIdentity.service.js). Never the
       authority — the id is — and deliberately allowed to go stale rather
       than restating what this default was set to. */
    owningCustomer: {
      customerCode:  { type: String, trim: true, default: "" },
      customerLabel: { type: String, trim: true, default: "" },
      customerName:  { type: String, trim: true, default: "" },
    },

    quantity: { type: Number, default: 0, min: 0 },
    minStock: { type: Number, default: 0 },
    maxStock: { type: Number, default: 0 },

    description: { type: String, default: "" },
    notes:       { type: String, default: "" },

    status: { type: String, default: "In Stock" },

    attributes: [attributeSchema],
    variants:   [variantSchema],
    discounts:  [discountSchema],

    stockTransactions: [stockTransactionSchema],

    primaryVendor:    { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    alternateVendors: [{ type: mongoose.Schema.Types.ObjectId, ref: "Vendor" }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" }
  },
  { timestamps: true }
);

// Auto-derive item-level + variant statuses on save
rawItemSchema.pre("save", function (next) {
  this.status = deriveStatus(this.quantity, this.minStock);

  if (Array.isArray(this.variants)) {
    this.variants.forEach(v => {
      v.status = deriveStatus(v.quantity, v.minStock ?? this.minStock);
    });
  }

  next();
});

rawItemSchema.statics.deriveStatus = deriveStatus;

/* ── THE TRASH (29 Sep 2026, explicit request: a deleted item "removed
   permanently — keep a Trash bin to recover it") ──────────────────────────
   Deleting an item sets `deletedAt`; nothing is destroyed. Every ordinary
   read — find, findOne/findById, counts, updates, aggregates — excludes a
   trashed item, so to the rest of the system it is gone: pickers do not
   offer it, stock views do not count it, its code is free to reuse... until
   it is restored. A reader that WANTS the trash says so with the query
   option `withDeleted: true` (an aggregate: `{ withDeleted: true }` in its
   options). `{ deletedAt: null }` matches every document written before
   the field existed, so no backfill was needed. */
rawItemSchema.add({
  deletedAt:     { type: Date, default: null, index: true },
  deletedBy:     { type: mongoose.Schema.Types.ObjectId, default: null },
  deletedByName: { type: String, default: "", trim: true },
});
const LIVE_ONLY = ["find", "findOne", "findOneAndUpdate", "findOneAndReplace", "countDocuments", "updateOne", "updateMany", "distinct"];
for (const op of LIVE_ONLY) {
  rawItemSchema.pre(op, function excludeTrashed() {
    const opts = typeof this.getOptions === "function" ? this.getOptions() : {};
    if (opts.withDeleted) return;
    const cond = typeof this.getFilter === "function" ? this.getFilter() : {};
    if (cond && Object.prototype.hasOwnProperty.call(cond, "deletedAt")) return;
    this.where({ deletedAt: null });
  });
}
rawItemSchema.pre("aggregate", function excludeTrashedAggregate() {
  if (this.options && this.options.withDeleted) return;
  const first = this.pipeline()[0];
  if (first && first.$match && Object.prototype.hasOwnProperty.call(first.$match, "deletedAt")) return;
  this.pipeline().unshift({ $match: { deletedAt: null } });
});

// Indexes
/* ── TENANT OWNERSHIP ────────────────────────────────────────────────────────
   The catalogue is company data: an item's code, its suppliers and its balance
   all belong to one set of books. Optional for the same reason every other
   Store & Purchase model's is — records that predate the boundary carry none,
   and they are legacy-global, excluded from ordinary reads rather than adopted
   by whichever company asks first. */
rawItemSchema.add({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Acc_Company",
    default: null,
    index: true,
  },
  siteId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

/* One item code per company. Two companies may both stock "RAW-FAB-CTN-001";
   within a company the code is the item's identity. */
rawItemSchema.index({ companyId: 1, sku: 1 }, { unique: true });
rawItemSchema.index({ companyId: 1, name: 1 });
/* Duplicate detection at registration. NOT unique: Store's own screen may
   deliberately register a near-duplicate, and a unique index would turn a
   judgement the storekeeper is entitled to make into a database error nobody
   can act on. Sparse, because items created before the field existed carry no
   key and must not all collide on "". */
rawItemSchema.index({ companyId: 1, masterIdentityKey: 1 }, { sparse: true });
/* ── THE ONE PLACE A CONCURRENT DUPLICATE IS ACTUALLY STOPPED ───────────────
   A duplicate check that reads and then writes cannot hold under concurrency:
   two transactions both read "not there" and both insert, because snapshot
   isolation only conflicts on documents they BOTH touch, and a row that does
   not exist yet is not one of those.

   So the constraint is an index. Partial, on `identityUnique: true`, so it
   covers only the rows whose door promises uniqueness — Store's own screen keeps
   its ability to register a deliberate near-duplicate, because its rows are not
   in this index at all. See the field. */
rawItemSchema.index(
  { companyId: 1, masterIdentityKey: 1 },
  {
    unique: true,
    name: "companyId_1_masterIdentityKey_1_claimed",
    partialFilterExpression: { identityUnique: true },
  },
);
rawItemSchema.index({ companyId: 1, category: 1 });
/* The Merchandising picker reads this company's items of one `usedAs` set. */
rawItemSchema.index({ companyId: 1, usedAs: 1 });
/* "Every material that is normally this customer's property", per company. */
rawItemSchema.index({ companyId: 1, owningCustomerId: 1 });
rawItemSchema.index({ name: 1 });
rawItemSchema.index({ category: 1 });
rawItemSchema.index({ "variants.vendorNicknames.vendor": 1 });

module.exports =
  mongoose.models.RawItem || mongoose.model("RawItem", rawItemSchema);