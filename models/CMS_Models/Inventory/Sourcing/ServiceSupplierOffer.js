// models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer.js
//
// Store & Purchase — WHAT A SUPPLIER QUOTED FOR A PROCESS, AND WHEN.
//
// ── THE GAP THIS FILLS ──────────────────────────────────────────────────────
// Nothing in this repository recorded what job work costs before a decision to
// buy had already been taken. Two records look as though they might:
//
//   • `ServiceOrder.lines[].rate` — an approved rate on an order. It exists
//     only after somebody committed to the purchase, has no validity window,
//     and is a fact about one order rather than a standing offer.
//   • `SpendRequest.lines[].rate` — a quote captured on an approval document,
//     often by the requester rather than by Store, with no lifecycle.
//
// Both are downstream. A costing is built BEFORE either exists — that is what
// makes it a pre-production estimate — so neither can price one, and the
// outside-services family was reported as having no source at all.
//
// `Service.defaultRate` is not a candidate either, and says so itself: "an
// estimate for planning, NOT an approved cost and not an invoice price."
// Costing never reads it.
//
// ── WHY NOT EXTEND `SupplierOffer` ──────────────────────────────────────────
// Its `itemId` is `required` and refs `RawItem`, and its `purchaseUom` is a
// stock unit resolved against the Unit Master with a conversion factor. A
// service is billed per visit, per hour, per lot — units that are deliberately
// NOT in the Unit Master, for the reason `Service.billingUnit` already gives.
//
// Making one model serve both would mean relaxing `itemId` to optional and
// making the conversion conditional: weakening the material contract, for every
// existing row, to accommodate a different one. So this is a separate model
// with the SAME conventions — and the genuinely shared commercial logic (MOQ,
// order multiple, tier coverage) is reused from `offerApplicability` rather
// than copied.
//
// ── WHAT A SERVICE QUOTATION HAS THAT A MATERIAL ONE HAS NOT ────────────────
// A minimum charge. "₹8 a piece, minimum ₹5,000 a lot" is an ordinary term on
// job work and has no material equivalent: a MOQ constrains the QUANTITY you
// may order, a minimum charge is a floor under the TOTAL. Modelling it as a
// MOQ would refuse a small lot the supplier is perfectly willing to do.
//
// ── MISSING IS NOT ZERO, ANYWHERE IN THIS FILE ──────────────────────────────
// An unrecorded GST rate is `undefined`, not 0 — "0% GST" is a commercial
// statement and an unrecorded rate is the absence of one. Same for validity,
// lead time, SAC and the minimum charge.

const mongoose = require("mongoose");

/* Same four states, same meanings, same reason expiry is not one of them: a
   record does not change because a date passed. See SupplierOffer. */
const OFFER_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "SUPERSEDED", "WITHDRAWN"]);

/* Same three bases. A service can be quoted tax-exclusive, tax-inclusive, or
   as a positively non-taxable supply — which is not the same fact as a
   tax-exclusive price whose rate nobody wrote down. */
const PRICE_BASES = Object.freeze(["TAX_EXCLUSIVE", "TAX_INCLUSIVE", "NON_TAXABLE"]);

const SUPPORTED_CURRENCIES = Object.freeze(["INR", "USD", "EUR", "GBP", "AED"]);

/** Integer minor units, or nothing. No floating-point money. */
const minorUnits = (opts = {}) => ({
  type: Number,
  ...opts,
  validate: {
    validator: (v) => v === undefined || v === null || (Number.isSafeInteger(v) && v >= 0),
    message: (p) => `${p.path} must be a whole number of minor units, not negative.`,
  },
});

/* A quantity tier, in the BILLING unit. Identical semantics to the material
   register's: a stated ceiling is a real term, and a quantity past it has no
   quoted price rather than falling back to the nearest band. */
const tierSchema = new mongoose.Schema(
  {
    minQuantity: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v > 0,
        message: "A tier starts at a positive quantity.",
      },
    },
    maxQuantity: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "A tier ceiling is a positive quantity.",
      },
    },
    unitPriceMinor: minorUnits({ required: true }),
    note: { type: String, trim: true },
  },
  { _id: false },
);

const serviceSupplierOfferSchema = new mongoose.Schema(
  {
    /* Stamped from the server-resolved context, never from a request body. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    /* Snapshotted so a register row reads correctly after a rename — the quote
       was given under the name on it. */
    supplierName: { type: String, trim: true, default: "" },

    /* The company-scoped Service master this quotes. */
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true, index: true },
    serviceCode: { type: String, trim: true, default: "" },
    serviceName: { type: String, trim: true, default: "" },

    /* The supplier's own words. Their code is what appears on their invoice,
       and a register that carries only ours cannot be reconciled against it. */
    supplierServiceCode: { type: String, trim: true },
    supplierServiceName: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 2000 },

    /* How THEY bill it. Text, not a Unit Master reference — see the header. */
    billingUnit: { type: String, trim: true, required: true },

    currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    /* The final quoted rate per billing unit. */
    unitPriceMinor: minorUnits({ required: true }),
    priceBasis: { type: String, required: true, enum: PRICE_BASES },

    /* Absent means unrecorded, and a taxable quotation with no rate cannot
       state a tax position at all — which the pricing refuses by name. */
    gstRatePercent: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v >= 0 && v <= 100),
        message: "A GST rate is a percentage between 0 and 100.",
      },
    },
    /* SAC is the services counterpart of HSN. */
    sacCode: { type: String, trim: true },

    /* ── A FLOOR UNDER THE TOTAL, NOT UNDER THE QUANTITY ──────────────────
       "₹8 a piece, minimum ₹5,000" means a 200-piece lot costs ₹5,000 and not
       ₹1,600. Distinct from `minQuantity`, which refuses the lot outright.
       Absent when the supplier stated none. */
    minimumChargeMinor: minorUnits(),
    /* The smallest lot they will take at all, in the billing unit. Absent when
       they take any. */
    minQuantity: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "A minimum quantity is positive.",
      },
    },
    orderMultiple: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "An order multiple is positive.",
      },
    },
    /* How long the work takes. Absent when unrecorded — never 0, which would
       claim same-day turnaround. */
    leadTimeDays: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 0),
        message: "A lead time is a whole number of days.",
      },
    },
    /* Only where the supplier genuinely quoted bands. */
    tiers: { type: [tierSchema], default: undefined },

    /* What this record cites. A quotation with no reference cannot be checked
       against the document it came from. */
    quotationReference: { type: String, trim: true },
    quotationDate: { type: Date },
    document: {
      label: { type: String, trim: true },
      url: { type: String, trim: true },
      storedAt: { type: String, trim: true },
    },

    /* Validity. Absent `validUntil` is open-ended, which many job-work rates
       genuinely are; absent `effectiveFrom` is filled at publication. */
    effectiveFrom: { type: Date },
    validUntil: { type: Date },

    notes: { type: String, trim: true },
    terms: { type: String, trim: true },

    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT", required: true, index: true },

    /* The revision chain. A commercial correction creates a new record and
       supersedes this one; it never edits it. */
    revision: { type: Number, default: 1, min: 1 },
    supersedesOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceSupplierOffer", default: null },
    supersededByOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "ServiceSupplierOffer", default: null },
    supersededAt: { type: Date },

    withdrawnAt: { type: Date },
    withdrawnByName: { type: String, trim: true },
    withdrawalReason: { type: String, trim: true },

    activatedAt: { type: Date },
    activatedByName: { type: String, trim: true },

    createdByActorId: { type: String, trim: true, default: "" },
    createdByActorName: { type: String, trim: true, default: "" },
    updatedByActorId: { type: String, trim: true, default: "" },
    updatedByActorName: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/* The read the costing assembly makes: this company's live quotations for one
   service. Status and dates are judged in the resolver, not the index. */
serviceSupplierOfferSchema.index({ companyId: 1, serviceId: 1, status: 1 });
serviceSupplierOfferSchema.index({ companyId: 1, supplierId: 1, status: 1 });

/* ── THE COMMERCIAL FIELDS ARE EVIDENCE, AND DO NOT MOVE ────────────────────
 * Same narrow door as `SupplierOffer`, for the same reason and with the same
 * stated limits: a module-private Symbol, armed on ONE document through
 * `$locals`, spent on read, scoped to ONE transition, and `save`-only.
 *
 * A costing frozen in March must still show what was quoted in March. Without
 * this, any route or script could write `unitPriceMinor` onto a live offer and
 * every historical costing that cited it would silently re-read as though it
 * had used the new figure.
 */
const LIFECYCLE_TOKEN = Symbol("serviceSupplierOffer.lifecycleTransition");

const MUTABLE_AFTER_CREATION = new Set(["updatedAt", "__v"]);
const AUDIT_PATHS = ["updatedByActorId", "updatedByActorName"];

const TRANSITIONS = Object.freeze({
  ACTIVATE: new Set([...AUDIT_PATHS, "status", "activatedAt", "activatedByName", "effectiveFrom"]),
  WITHDRAW: new Set([...AUDIT_PATHS, "status", "withdrawnAt", "withdrawnByName", "withdrawalReason"]),
  SUPERSEDE: new Set([...AUDIT_PATHS, "status", "supersededByOfferId", "supersededAt"]),
});

/** Arm ONE document for ONE lifecycle save. */
function beginServiceOfferLifecycle(doc, transition) {
  if (!doc || typeof doc.$locals !== "object") {
    throw new Error("beginServiceOfferLifecycle needs a service quotation document.");
  }
  if (!TRANSITIONS[transition]) {
    throw new Error(`"${transition}" is not a service-quotation lifecycle transition.`);
  }
  doc.$locals[LIFECYCLE_TOKEN] = transition;
  return doc;
}

const immutable = (message, paths) => {
  const err = new Error(message);
  err.name = "ServiceSupplierOfferImmutableError";
  err.status = 409;
  err.code = "SUPPLIER_OFFER_IMMUTABLE";
  if (paths) err.changedPaths = paths;
  return err;
};

serviceSupplierOfferSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const transition = this.$locals?.[LIFECYCLE_TOKEN];
  /* Spent on read whether or not it is used — a token that survived its save
     would leave the door open for the next one. */
  if (transition) delete this.$locals[LIFECYCLE_TOKEN];
  const allowed = TRANSITIONS[transition] || null;

  const changed = this.modifiedPaths().filter((path) => {
    const root = path.split(".")[0];
    if (MUTABLE_AFTER_CREATION.has(root)) return false;
    return !allowed || !allowed.has(root);
  });
  if (changed.length) {
    return next(immutable(
      "A service quotation's commercial terms cannot be changed once recorded; a costing may have been priced from them. Record a revision instead.",
      changed,
    ));
  }
  return next();
});

/* The query paths gained nothing, so they refuse every write to a commercial
   field rather than offering a bypass to find. */
const refuseQueryUpdate = function refuseQueryUpdate(next) {
  const update = this.getUpdate() || {};
  const touched = new Set();
  for (const [op, payload] of Object.entries(update)) {
    if (op.startsWith("$")) {
      for (const path of Object.keys(payload || {})) touched.add(String(path).split(".")[0]);
    } else {
      touched.add(String(op).split(".")[0]);
    }
  }
  const changed = [...touched].filter((p) => !MUTABLE_AFTER_CREATION.has(p));
  if (changed.length) {
    return next(immutable(
      "A service quotation cannot be updated through a query; record a revision, or move it through its lifecycle.",
      changed,
    ));
  }
  return next();
};
serviceSupplierOfferSchema.pre("updateOne", refuseQueryUpdate);
serviceSupplierOfferSchema.pre("updateMany", refuseQueryUpdate);
serviceSupplierOfferSchema.pre("findOneAndUpdate", refuseQueryUpdate);

/** Withdraw it, with a reason. Deleting it would orphan a frozen costing. */
function refuseDelete(next) {
  return next(immutable(
    "A service quotation cannot be deleted; a costing may have been priced from it. Withdraw it instead, with a reason.",
  ));
}
serviceSupplierOfferSchema.pre("deleteOne", { document: true, query: true }, refuseDelete);
serviceSupplierOfferSchema.pre("deleteMany", refuseDelete);
serviceSupplierOfferSchema.pre("findOneAndDelete", refuseDelete);

module.exports = mongoose.models.ServiceSupplierOffer
  || mongoose.model("ServiceSupplierOffer", serviceSupplierOfferSchema);
module.exports.beginServiceOfferLifecycle = beginServiceOfferLifecycle;
module.exports.OFFER_STATUSES = OFFER_STATUSES;
module.exports.PRICE_BASES = PRICE_BASES;
module.exports.SUPPORTED_CURRENCIES = SUPPORTED_CURRENCIES;
