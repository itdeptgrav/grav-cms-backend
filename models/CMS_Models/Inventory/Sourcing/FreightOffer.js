// models/CMS_Models/Inventory/Sourcing/FreightOffer.js
//
// WHAT A TRANSPORTER QUOTED TO MOVE A FINISHED ORDER, ON A LANE, ON A DATE.
//
// ── WHY THIS IS NOT A SERVICE QUOTATION ─────────────────────────────────────
// `ServiceSupplierOffer` identifies its subject by ONE `serviceId` — a row in
// the Service master. A freight rate is not identified by a service; it is
// identified by a LANE: where it starts, where it ends, and how it travels.
//
// Expressing that through the service register means writing "Ludhiana →
// Bengaluru, road" into a Service NAME. The lane then becomes a string nobody
// can query, scope or validate; every new destination becomes a new master
// record; and the register still has nowhere to put a destination at all. So
// the lane is structured here, and the conventions — dated, referenced,
// revisioned, immutable once live, withdrawn rather than deleted — are the
// ones the other two registers already use.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
// Not a freight invoice, not a booking, not an actual paid charge, and not a
// landed cost. It is what a transporter said they would charge, on a date, for
// a stated lane — and each of the others is a different number that people
// would otherwise reconcile against it.
//
// ── AND THE BASES ARE THE ONES THIS SYSTEM CAN ACTUALLY CALCULATE ───────────
// Per kilogram, per carton, and a fixed charge for one consignment. Distance
// slabs, dimensional weight, vehicle types, pallets and consolidation are all
// real ways freight is priced, and none of them has a factual input anywhere
// in this codebase — no distance table, no dimensions, no vehicle master. A
// basis that cannot be calculated from recorded facts would be a rate that
// looks configured and quietly produces nothing.
//
// ── MISSING IS NOT ZERO, ANYWHERE IN THIS FILE ──────────────────────────────
// An unrecorded GST rate is `undefined`, not 0. Same for the minimum charge
// and the validity window.

const mongoose = require("mongoose");

const OFFER_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "SUPERSEDED", "WITHDRAWN"]);
const PRICE_BASES = Object.freeze(["TAX_EXCLUSIVE", "TAX_INCLUSIVE", "NON_TAXABLE"]);
const SUPPORTED_CURRENCIES = Object.freeze(["INR", "USD", "EUR", "GBP", "AED"]);

/** How the movement happens. Stated, because it is half of a lane's identity. */
const FREIGHT_MODES = Object.freeze(["ROAD", "RAIL", "AIR", "SEA", "COURIER"]);

/**
 * What the rate is charged against.
 *
 * `PER_KG` needs a packed weight; `PER_CARTON` needs a carton capacity; both
 * come from the sample's shipment facts and both block when absent. A fixed
 * consignment charge needs neither and is diluted across the run.
 */
const CALCULATION_BASES = Object.freeze(["FIXED_PER_CONSIGNMENT", "PER_KG", "PER_CARTON"]);

/** Integer minor units, or nothing. No floating-point money. */
const minorUnits = (opts = {}) => ({
  type: Number,
  ...opts,
  validate: {
    validator: (v) => v === undefined || v === null || (Number.isSafeInteger(v) && v >= 0),
    message: (p) => `${p.path} must be a whole number of minor units, not negative.`,
  },
});

const freightOfferSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    /* ── THE TRANSPORTER ────────────────────────────────────────────────
       By id, with a snapshot of the name as it read when the quotation was
       recorded. `Vendor.vendorType` is a free string that defaults to "Raw
       Material Supplier", so it is NOT used as a gate — the check that
       matters is that the vendor is this company's and active. */
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    supplierName: { type: String, trim: true, default: "" },

    /* ── THE LANE ───────────────────────────────────────────────────────
       Origin is one of this company's warehouses, by id. Destination is
       either a specific shipping address or a named ZONE — a transporter
       quoting "anywhere in Karnataka" is quoting a zone, and forcing that
       into one address would either invent a precision nobody quoted or
       require a quotation per customer. */
    originWarehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },
    originName: { type: String, trim: true, default: "" },

    destinationAddressId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAddress", default: null },
    /* A zone the destination has to fall inside. Matched on the address's own
       city/region/country, never on distance. */
    destinationZone: {
      city: { type: String, trim: true, default: "" },
      region: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
    },
    destinationLabel: { type: String, trim: true, default: "" },

    mode: { type: String, enum: FREIGHT_MODES, required: true },

    /* ── THE RATE ───────────────────────────────────────────────────────── */
    basis: { type: String, enum: CALCULATION_BASES, required: true },
    /* Per kg, per carton, or for the consignment — the basis says which. */
    rateMinor: minorUnits({ required: true }),
    currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    priceBasis: { type: String, required: true, enum: PRICE_BASES },
    gstRatePercent: {
      type: Number,
      min: 0,
      max: 100,
      validate: {
        validator: (v) => v === undefined || v === null || Number.isFinite(v),
        message: "A GST rate is a number of percent.",
      },
    },
    sacCode: { type: String, trim: true },

    /* ── A FLOOR UNDER THE CONSIGNMENT, NOT UNDER THE RATE ───────────────
       "₹35 a kg, minimum ₹4,000" means a 50 kg load is charged ₹4,000 and not
       ₹1,750. It is applied to the line TOTAL, exactly as the service
       register's minimum charge is. */
    minimumChargeMinor: minorUnits(),

    /* ── THE QUOTATION ITSELF ───────────────────────────────────────────── */
    quotationReference: { type: String, trim: true },
    quotationDate: { type: Date },
    document: {
      url: { type: String, trim: true },
      name: { type: String, trim: true },
    },

    effectiveFrom: { type: Date },
    validUntil: { type: Date },

    notes: { type: String, trim: true },
    terms: { type: String, trim: true },

    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT", required: true, index: true },
    withdrawalReason: { type: String, trim: true },

    revision: { type: Number, default: 1, min: 1 },
    supersedesOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "FreightOffer", default: null },
    supersededByOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "FreightOffer", default: null },
    supersededAt: { type: Date },

    withdrawnAt: { type: Date },
    withdrawnByName: { type: String, trim: true },
    activatedAt: { type: Date },
    activatedByName: { type: String, trim: true },

    createdByActorId: { type: String, trim: true, default: "" },
    createdByActorName: { type: String, trim: true, default: "" },
    updatedByActorId: { type: String, trim: true, default: "" },
    updatedByActorName: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/* The read the costing makes: this company's live quotations out of one
   origin. Status and dates are judged in the resolver, not by the index. */
freightOfferSchema.index({ companyId: 1, originWarehouseId: 1, status: 1 });
freightOfferSchema.index({ companyId: 1, supplierId: 1, status: 1 });

/* ── THE COMMERCIAL FIELDS ARE EVIDENCE, AND DO NOT MOVE ────────────────────
 * The same narrow door as the other two registers, with the same limits: a
 * module-private Symbol, armed on ONE document, spent on read, scoped to ONE
 * transition, `save`-only. A costing frozen in March must still show the rate
 * that was quoted in March.
 */
const LIFECYCLE_TOKEN = Symbol("freightOffer.lifecycleTransition");

const MUTABLE_AFTER_CREATION = new Set(["updatedAt", "__v"]);
const AUDIT_PATHS = ["updatedByActorId", "updatedByActorName"];

const TRANSITIONS = Object.freeze({
  ACTIVATE: new Set([...AUDIT_PATHS, "status", "activatedAt", "activatedByName", "effectiveFrom"]),
  WITHDRAW: new Set([...AUDIT_PATHS, "status", "withdrawnAt", "withdrawnByName", "withdrawalReason"]),
  SUPERSEDE: new Set([...AUDIT_PATHS, "status", "supersededByOfferId", "supersededAt"]),
});

/** Arm ONE document for ONE lifecycle save. */
function beginFreightOfferLifecycle(doc, transition) {
  if (!doc || typeof doc.$locals !== "object") {
    throw new Error("beginFreightOfferLifecycle needs a freight quotation document.");
  }
  if (!TRANSITIONS[transition]) {
    throw new Error(`"${transition}" is not a freight-quotation lifecycle transition.`);
  }
  doc.$locals[LIFECYCLE_TOKEN] = transition;
  return doc;
}

const immutable = (message, paths) => {
  const err = new Error(message);
  err.name = "FreightOfferImmutableError";
  err.status = 409;
  err.code = "SUPPLIER_OFFER_IMMUTABLE";
  if (paths) err.changedPaths = paths;
  return err;
};

freightOfferSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const transition = this.$locals?.[LIFECYCLE_TOKEN];
  if (transition) delete this.$locals[LIFECYCLE_TOKEN];
  const allowed = TRANSITIONS[transition] || null;

  const changed = this.modifiedPaths().filter((path) => {
    const root = path.split(".")[0];
    if (MUTABLE_AFTER_CREATION.has(root)) return false;
    return !allowed || !allowed.has(root);
  });
  if (changed.length) {
    return next(immutable(
      "A freight quotation's commercial terms cannot be changed once recorded; a costing may have been priced from them. Record a revision instead.",
      changed,
    ));
  }
  return next();
});

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
      "A freight quotation cannot be updated through a query; record a revision, or move it through its lifecycle.",
      changed,
    ));
  }
  return next();
};
freightOfferSchema.pre("updateOne", refuseQueryUpdate);
freightOfferSchema.pre("updateMany", refuseQueryUpdate);
freightOfferSchema.pre("findOneAndUpdate", refuseQueryUpdate);

/** Withdraw it, with a reason. Deleting it would orphan a frozen costing. */
function refuseDelete(next) {
  return next(immutable(
    "A freight quotation cannot be deleted; a costing may have been priced from it. Withdraw it instead, with a reason.",
  ));
}
freightOfferSchema.pre("deleteOne", { document: true, query: true }, refuseDelete);
freightOfferSchema.pre("deleteMany", refuseDelete);
freightOfferSchema.pre("findOneAndDelete", refuseDelete);

module.exports = mongoose.models.FreightOffer
  || mongoose.model("FreightOffer", freightOfferSchema);
module.exports.beginFreightOfferLifecycle = beginFreightOfferLifecycle;
module.exports.OFFER_STATUSES = OFFER_STATUSES;
module.exports.PRICE_BASES = PRICE_BASES;
module.exports.FREIGHT_MODES = FREIGHT_MODES;
module.exports.CALCULATION_BASES = CALCULATION_BASES;
module.exports.SUPPORTED_CURRENCIES = SUPPORTED_CURRENCIES;
