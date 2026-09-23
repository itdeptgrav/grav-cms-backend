// models/CMS_Models/Inventory/Sourcing/SupplierOffer.js
//
// Store & Purchase — Supplier Offer Master V1. WHAT A SUPPLIER ACTUALLY
// QUOTED, AND WHEN.
//
// ── WHOSE MASTER THIS IS ────────────────────────────────────────────────────
// Store's. A supplier quotation is procurement's commercial record: Store
// negotiates it, records it and withdraws it, and the people who do that hold
// `sp.sourcing.manage` and frequently no costing grant at all. The first cut
// put this under Central Costing and made a storekeeper need
// `costing.cost.read` to open their own supplier register — which is a
// permission nobody could explain and an ownership nobody agreed.
//
// Central Costing CONSUMES it, in Chunk 3.2, through a narrow read adapter
// that returns plain facts. It does not own it and cannot change it.
//
// ── THE COLLECTION NAME IS UNCHANGED ────────────────────────────────────────
// The model is still registered as `SupplierOffer`, so mongoose resolves the
// same `supplieroffers` collection it did before the move. Records written
// under the old location are exactly where they were.
//
// ── THE PROBLEM THIS REPLACES ───────────────────────────────────────────────
// The only supplier price in the system is `RawItem.variants[].vendorNicknames[]
// .price` — a single mutable number with no date, no validity, no tax basis,
// no quantity and no quotation reference. It is useful for a lookup and it
// cannot prove anything: edit it and every historical costing that used it now
// reads as though it had used the new figure.
//
// This is a dated, referenced, company-owned register of quotations. The
// legacy field is left exactly where it is — Chunk 3.2 will read this instead,
// and nothing here migrates or overwrites that history.
//
// ── WHAT AN OFFER IS NOT ────────────────────────────────────────────────────
// Not an inventory valuation. Not a landed cost. Not an invoice price. Not an
// approved costing. It is what a supplier said they would charge, on a date,
// subject to terms — and the difference matters, because each of the others is
// a different number that people would otherwise reconcile against it.
//
// ── MISSING IS NOT ZERO, ANYWHERE IN THIS FILE ──────────────────────────────
// A GST rate that nobody recorded is `undefined`, not 0 — "0% GST" is a real
// commercial statement and an unrecorded rate is the absence of one. The same
// holds for validity, lead time and HSN. Every optional field here is absent
// when unknown, never defaulted into a claim.

const mongoose = require("mongoose");

/* ── LIFECYCLE ──────────────────────────────────────────────────────────────
 * `DRAFT`      being entered; not selectable, not evidence of anything yet.
 * `ACTIVE`     published. Selectable where the clock says it is in force.
 * `SUPERSEDED` a later revision replaced it. Readable forever as the price
 *              that WAS quoted; never selectable again.
 * `WITHDRAWN`  the supplier or the buyer pulled it, with a stated reason.
 *
 * Expiry is deliberately NOT a status. A record does not change because a date
 * passed, and writing one would mean every offer needed a job to age it — so
 * "expired" is derived from `validUntil` against the clock, and the stored
 * status stays a record of what somebody DID. */
const OFFER_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "SUPERSEDED", "WITHDRAWN"]);

/* Tax basis. No default: a price whose basis nobody stated cannot be turned
   into a net or a gross figure, and guessing one is an 18% error waiting to be
   quoted.

   `NON_TAXABLE` is a supplier's positive statement that the supply carries no
   GST — an exempt or nil-rated line. It is NOT the same as TAX_EXCLUSIVE with
   an unrecorded rate, which is "nobody wrote the rate down": the first has a
   derivable net (the quoted figure, with no tax to add), the second does not
   yet know whether tax applies at all. Collapsing them would silently turn
   every unfinished entry into a tax-free purchase. */
const PRICE_BASES = Object.freeze(["TAX_EXCLUSIVE", "TAX_INCLUSIVE", "NON_TAXABLE"]);

const SUPPORTED_CURRENCIES = Object.freeze(["INR", "USD", "EUR", "GBP", "AED"]);

/**
 * Integer minor units, or nothing.
 *
 * ── NO FLOATING-POINT MONEY, EVER ───────────────────────────────────────────
 * `12.30` cannot be represented exactly in binary floating point, and a
 * register of prices that cannot be summed exactly is not a register. Beyond
 * 2^53 addition silently stops being exact, so "safe" integer rather than
 * merely integer.
 */
const minorUnits = (opts = {}) => ({
  type: Number,
  ...opts,
  validate: {
    validator: (v) => v === undefined || v === null
      || (Number.isSafeInteger(v) && (opts.allowNegative ? true : v >= 0)),
    message: (p) => `${p.path} must be a whole number of minor units${opts.allowNegative ? "" : ", not negative"}.`,
  },
});

/* ── A QUANTITY TIER ────────────────────────────────────────────────────────
 * Only where a supplier actually quoted one. An invented tier is a price
 * nobody offered, and it would be quoted.
 *
 * Both bounds are in the PURCHASE UoM. `minQuantity` is the floor at which the
 * price applies; `maxQuantity` is OPTIONAL and, where present, the last
 * quantity it covers.
 *
 * ── WHY A MAX EXISTS AT ALL ────────────────────────────────────────────────
 * The first cut left every tier open-ended, running until the next one starts.
 * That is a tidy model and it quietly invents prices: a supplier who quoted
 * "500–999 at ₹42" and said nothing above 1,000 has not offered a price for
 * 5,000 units, and an open-ended tier would hand one over as though they had.
 * A stated ceiling is a real term on real quotations, and a quantity that
 * falls past it — or into a gap between two tiers — has NO quoted price. That
 * is a refusal, not a fallback to the nearest tier.
 *
 * Absent still means open-ended, because plenty of quotations genuinely are.
 * The difference is that it is now the supplier's choice rather than the
 * schema's. */
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

const supplierOfferSchema = new mongoose.Schema(
  {
    /* ── WHOSE RECORD THIS IS ─────────────────────────────────────────────
       Stamped from the server-resolved context, never from a request body.
       Two companies may hold equivalent offers — same supplier, same item,
       same quotation number — and neither may see the other's. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    /* ── WHO QUOTED, FOR WHAT ─────────────────────────────────────────────
       Ids AND a snapshot of the names. The ids are the relationship; the
       snapshot is what the record reads as in three years when the supplier
       has been renamed and the item recoded — an offer that cannot be read
       without three joins is not evidence anybody will check. */
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    supplierName: { type: String, trim: true, default: "" },

    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true, index: true },
    itemName: { type: String, trim: true, default: "" },
    itemSku: { type: String, trim: true, default: "" },

    /* Optional: a quotation may be for the item generally or for one variant.
       Absent means "the item", not "an unknown variant". */
    variantId: { type: mongoose.Schema.Types.ObjectId },
    variantLabel: { type: String, trim: true },

    /* What the SUPPLIER calls it. The single most useful field on a purchase
       order and the one nobody can reconstruct later. */
    supplierItemCode: { type: String, trim: true },
    supplierItemName: { type: String, trim: true },

    /* ── THE UNIT THE PRICE IS PER ────────────────────────────────────────
       A price without its unit is a number. Stored as both the id and the
       name because `RawItem.unit` is a bare string and the two masters do not
       reference each other. */
    purchaseUomId: { type: mongoose.Schema.Types.ObjectId, ref: "Unit" },
    purchaseUom: { type: String, trim: true, required: true },

    /* ── THE PRICE ────────────────────────────────────────────────────────── */
    currency: { type: String, required: true, enum: SUPPORTED_CURRENCIES },
    unitPriceMinor: minorUnits({ required: true }),
    /* Required, with no default. See PRICE_BASES. */
    priceBasis: { type: String, required: true, enum: PRICE_BASES },

    /* ── TAX, WHERE IT WAS RECORDED ───────────────────────────────────────
       No default. `undefined` is "nobody wrote a rate down"; `0` is "this is
       zero-rated", which is a supplier's statement and a different fact. A
       screen that showed the first as 0% would be inventing a tax position. */
    gstRatePercent: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v >= 0 && v <= 100),
        message: "A GST rate is a percentage between 0 and 100.",
      },
    },
    hsnCode: { type: String, trim: true },

    /* ── QUANTITY TERMS ───────────────────────────────────────────────────
       Both in the PURCHASE UoM, both positive where present. A zero MOQ is
       not "no minimum" — it is a number nobody meant. */
    moq: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "A minimum order quantity is positive.",
      },
    },
    orderMultiple: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isFinite(v) && v > 0),
        message: "An order multiple is positive.",
      },
    },
    /* ── DOES THIS RATE ALREADY INCLUDE GETTING IT HERE? ─────────────────
       Nothing recorded it, so nothing could answer it — and the answer is
       the difference between a material cost that is complete and one that
       is short the inbound freight on every metre.

       `INCLUSIVE_LANDED` means the quoted rate delivers to our warehouse, so
       no separate inbound freight belongs anywhere near this line.
       `EXCLUSIVE` means it does not, and the costing says so honestly rather
       than costing the material as though delivery were free.

       Absent means nobody has been asked — which is the state every offer
       recorded before this field existed is in, and is reported as an
       unanswered question rather than guessed either way. */
    freightTerms: {
      type: String,
      enum: ["INCLUSIVE_LANDED", "EXCLUSIVE"],
      default: undefined,
    },
    /* What the supplier actually wrote, where they wrote one. Free text
       because Incoterms are not parsed anywhere in this system, and
       pretending otherwise would be a rule nothing enforces. */
    incoterm: { type: String, trim: true },

    /* ── WHERE THESE GOODS COME FROM ─────────────────────────────────────
       Customs duty is charged on IMPORTED goods, by origin. Nothing recorded
       either, so nothing could answer it — and an absent answer must never be
       read as "domestic, therefore no duty", which is the specific mistake
       that turns a missing fact into a free one.

       ── WHY THIS IS ON THE QUOTATION AND NOT ON THE ITEM ────────────────
       The same fabric may be quoted by a local mill and by an importer. Where
       it comes from is a fact about THIS supplier's offer, and it changes
       when the offer does — so it belongs beside the price, the validity and
       the reference, under the same lifecycle. The tariff CLASSIFICATION does
       not vary that way and lives on the item; see `RawItem.customsTariffCode`.

       ── AND THE SUPPLIER'S ADDRESS IS NOT AN ANSWER ─────────────────────
       `Vendor.address.country` is where the supplier is, which is a different
       fact from where the goods were made. A trader in Ludhiana may quote
       Chinese fabric. Nothing here falls back to it.

       Absent means nobody has been asked. That is the state every offer
       recorded before this field existed is in, and it is reported as an
       unanswered question rather than guessed either way. */
    sourcing: {
      /* `DOMESTIC` — no customs entry, so no duty. A stated answer, not an
         absence. `IMPORTED` — duty applies, and the origin decides which. */
      type: {
        type: String,
        enum: ["DOMESTIC", "IMPORTED"],
        default: undefined,
      },
      /* ISO-2, from the company's own list (`constants/crm.js` COUNTRIES).
         A code rather than free text, because "China", "CN" and "P.R. China"
         are one origin and three strings, and a duty table keyed by the
         third would miss the first two.

         Required only where the goods are imported: a domestic supply has an
         origin of India by definition, and asking for it again would be a
         field whose only correct answer is already known. */
      countryOfOrigin: { type: String, trim: true, uppercase: true, maxlength: 2, default: undefined },
      /* ── AND WHETHER THE QUOTED RATE ALREADY CARRIES THE DUTY ─────────
         `freightTerms` above says whether the rate delivers to our warehouse.
         That is a statement about FREIGHT. It says nothing about customs, and
         reading it as though it did is how a landed rate ends up charged duty
         twice.

         So this is asked separately, and absent means nobody has been asked —
         the state every offer recorded before this field existed is in.
         Costing blocks an imported line on it rather than guessing, because
         both guesses are wrong in opposite directions: adding duty to a rate
         that includes it overstates every metre, and assuming it is included
         understates every metre.

         Only meaningful where `type` is `IMPORTED`; a domestic supply has no
         customs entry for duty to be inside. */
      dutyInQuotedRate: {
        type: String,
        enum: ["INCLUDED", "EXCLUDED"],
        default: undefined,
      },
      /* What the supplier put it on — a certificate of origin, a bill of
         entry, the invoice itself. Free text, because this is evidence a
         person cites rather than a value anything computes with. */
      evidenceNote: { type: String, trim: true, maxlength: 300, default: "" },
    },

    leadTimeDays: {
      type: Number,
      validate: {
        validator: (v) => v === undefined || v === null || (Number.isInteger(v) && v >= 0),
        message: "A lead time is a whole number of days.",
      },
    },

    /* Factual only — see `tierSchema`. `undefined` when the supplier quoted
       one price, which is not the same as a single tier at quantity 1. */
    tiers: { type: [tierSchema], default: undefined },

    /* ── THE EVIDENCE ─────────────────────────────────────────────────────
       The supplier's own quotation number, and a REFERENCE to a document
       somebody already stored elsewhere. Deliberately a reference and not an
       upload: building a second file store for this would be a bigger piece
       of work than the register itself. */
    quotationReference: { type: String, trim: true },
    /* WHEN the supplier issued it — distinct from `effectiveFrom`, which is
       when the price starts, and from `createdAt`, which is when somebody got
       round to typing it in. A quotation dated three months before it was
       entered is an ordinary thing and the gap is worth being able to see. */
    quotationDate: { type: Date },
    document: {
      label: { type: String, trim: true },
      url: { type: String, trim: true },
      storedAt: { type: String, trim: true },
    },

    /* ── WHEN IT APPLIES ──────────────────────────────────────────────────
       `effectiveFrom` defaults to the moment of publication — a price is in
       force from when it was quoted unless somebody says otherwise.
       `validUntil` has NO default: an unrecorded validity is "validity not
       recorded", and defaulting it to forever would make every undated
       quotation permanently current. */
    effectiveFrom: { type: Date },
    validUntil: { type: Date },

    notes: { type: String, trim: true },
    terms: { type: String, trim: true },

    status: { type: String, enum: OFFER_STATUSES, default: "DRAFT", required: true, index: true },

    /* ── REVISION EVIDENCE ────────────────────────────────────────────────
       A correction does not rewrite a price somebody was quoted; it creates a
       new record and points both ways. `revision` counts within one chain, so
       "revision 3 of quotation Q-118" is answerable without walking it. */
    revision: { type: Number, default: 1, min: 1 },
    supersedesOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierOffer", default: null },
    supersededByOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierOffer", default: null },
    supersededAt: { type: Date },

    withdrawnAt: { type: Date },
    withdrawnByName: { type: String, trim: true },
    /* Required by the SERVICE when withdrawing — a withdrawal with no stated
       reason is a price that vanished. */
    withdrawalReason: { type: String, trim: true },

    activatedAt: { type: Date },
    activatedByName: { type: String, trim: true },

    createdByActorId: { type: String, trim: true, default: "" },
    createdByActorName: { type: String, trim: true, default: "" },
    /* Server-owned, like the creator: who last changed this record. Never
       taken from a request body. */
    updatedByActorId: { type: String, trim: true, default: "" },
    updatedByActorName: { type: String, trim: true, default: "" },

    /* The idempotent-write receipt, so a retry of one action finds its own
       earlier record rather than creating a second offer. */
    creationClaimId: { type: String, trim: true },
    creationRequestHash: { type: String, trim: true },
  },
  { timestamps: true },
);

/* The register's own read: this company's offers, newest first. */
supplierOfferSchema.index({ companyId: 1, status: 1, updatedAt: -1 });
/* And the lookup Chunk 3.2 will make: which offers exist for this item. */
supplierOfferSchema.index({ companyId: 1, itemId: 1, status: 1, effectiveFrom: -1 });
supplierOfferSchema.index({ companyId: 1, supplierId: 1, updatedAt: -1 });

/* ── ONE CLAIM, ONE OFFER ───────────────────────────────────────────────────
 * Partial and company-scoped: a retry carrying the same key cannot create a
 * second record, and two companies' claims never collide. */
supplierOfferSchema.index(
  { companyId: 1, creationClaimId: 1 },
  { unique: true, partialFilterExpression: { creationClaimId: { $type: "string", $gt: "" } } },
);

/* ══ A QUOTED PRICE IS NOT EDITABLE ══════════════════════════════════════════
 *
 * The register's whole claim is that a costing from March can still show what
 * was quoted in March. Everything else in this file — the revision chain, the
 * supersede-in-one-commit flow, the immutable costing versions that snapshot
 * it — rests on the commercial fields never changing after the record exists.
 *
 * That was a CONVENTION: the routes happened to create a revision rather than
 * edit, and nothing stopped the next route, script or bulk job from writing
 * `unitPriceMinor` straight onto a live offer. A convention that holds until
 * somebody writes the obvious thing is not a guarantee, and here it would fail
 * silently and backwards — every historical costing that read that offer would
 * suddenly read as though it had used the new figure.
 *
 * ── THE NARROW DOOR ─────────────────────────────────────────────────────────
 * Same shape as `CostingVersion`'s lifecycle transition, for the same reasons:
 *
 *   1. A module-private `Symbol`. Not a string, not enumerable, not reachable
 *      from a request body, and nothing outside this file can produce it
 *      except by calling `beginOfferLifecycle`, which is exported by name.
 *   2. Armed on ONE document, through `$locals` — never a module flag, which
 *      under load is open for every concurrent save in the process.
 *   3. Spent on read, so a second `save()` is refused like any other.
 *   4. Scoped to ONE transition. Each names exactly the fields it may write,
 *      so a withdrawal cannot smuggle a price change alongside the reason, and
 *      publishing cannot quietly move the quantity tiers.
 *   5. `save`-only. The query paths gained nothing and refuse every write to a
 *      commercial field, so there is no `findOneAndUpdate` bypass to find.
 *
 * The limits are the same ones stated for costing versions and are not
 * re-argued: this is mongoose middleware. It does not stop a database shell,
 * `bulkWrite`, or `Model.collection.*`. No production code writes an offer
 * through those, and that remains a convention — but the ordinary paths are
 * now closed properly rather than by good intentions.
 */
const LIFECYCLE_TOKEN = Symbol("supplierOffer.lifecycleTransition");

/** Only ever `updatedAt`/`__v`: everything else on this record is evidence. */
const MUTABLE_AFTER_CREATION = new Set(["updatedAt", "__v"]);

/* Who last moved the record travels with every transition — it is audit, not
   commerce, and a transition that could not record its actor would be worse. */
const AUDIT_PATHS = ["updatedByActorId", "updatedByActorName"];

const TRANSITIONS = Object.freeze({
  /* DRAFT → ACTIVE. `effectiveFrom` is here because publication is when an
     undated price takes force — and the route only fills it when it is absent,
     so this cannot move a date somebody stated. */
  ACTIVATE: new Set([...AUDIT_PATHS, "status", "activatedAt", "activatedByName", "effectiveFrom"]),
  /* ACTIVE → WITHDRAWN, with a stated reason. */
  WITHDRAW: new Set([...AUDIT_PATHS, "status", "withdrawnAt", "withdrawnByName", "withdrawalReason"]),
  /* ACTIVE/DRAFT → SUPERSEDED, as its revision is created in the same commit.
     The old record's PRICE is untouched: somebody was quoted it. */
  SUPERSEDE: new Set([...AUDIT_PATHS, "status", "supersededByOfferId", "supersededAt"]),
});

/**
 * Arm ONE document for ONE lifecycle save.
 *
 * Called only by `routes/CMS_Routes/Inventory/Sourcing/supplierOffers.js`.
 * A commercial correction has no transition here on purpose — it creates a new
 * revision instead, which is the whole point of the chain.
 */
function beginOfferLifecycle(doc, transition) {
  if (!doc || typeof doc.$locals !== "object") {
    throw new Error("beginOfferLifecycle needs a supplier offer document.");
  }
  if (!TRANSITIONS[transition]) {
    throw new Error(`"${transition}" is not a supplier-offer lifecycle transition.`);
  }
  doc.$locals[LIFECYCLE_TOKEN] = transition;
  return doc;
}

const immutable = (message, paths) => {
  const err = new Error(message);
  err.name = "SupplierOfferImmutableError";
  err.status = 409;
  err.code = "SUPPLIER_OFFER_IMMUTABLE";
  if (paths) err.changedPaths = paths;
  return err;
};

supplierOfferSchema.pre("save", function (next) {
  if (this.isNew) return next();
  const transition = this.$locals?.[LIFECYCLE_TOKEN];
  /* Spent on read whether or not it is used — a token that survived its save
     would leave the door open for the next one. */
  if (transition) delete this.$locals[LIFECYCLE_TOKEN];
  const allowed = TRANSITIONS[transition] || null;

  const changed = this.modifiedPaths().filter((path) => {
    const root = path.split(".")[0];
    if (MUTABLE_AFTER_CREATION.has(root)) return false;
    if (allowed && allowed.has(root)) return false;
    return true;
  });
  if (!changed.length) return next();
  return next(immutable(
    `A supplier quotation cannot be edited once it exists — somebody was quoted it. Revise it instead of changing ${changed.join(", ")}.`,
    changed,
  ));
});

/* `updateOne`/`updateMany`/`findOneAndUpdate` bypass the save hook entirely,
   so they are guarded too: otherwise the promise would hold for exactly the
   one code path that happens to use `save()`. */
function refuseUpdate(next) {
  const update = this.getUpdate() || {};
  const touched = new Set();
  for (const [op, payload] of Object.entries(update)) {
    /* `$setOnInsert` applies only when the update CREATES the document, and
       mongoose adds `createdAt` to it on every timestamped update. An insert
       is not a mutation. */
    if (op === "$setOnInsert") continue;
    if (op.startsWith("$")) {
      if (payload && typeof payload === "object") {
        for (const key of Object.keys(payload)) touched.add(String(key).split(".")[0]);
      }
      continue;
    }
    touched.add(String(op).split(".")[0]);
  }
  const changed = [...touched].filter((root) => !MUTABLE_AFTER_CREATION.has(root));
  if (!changed.length) return next();
  return next(immutable(
    `A supplier quotation cannot be changed by an update query (${changed.join(", ")}). Publish, withdraw or revise it through the sourcing service.`,
    changed,
  ));
}

supplierOfferSchema.pre("updateOne", refuseUpdate);
supplierOfferSchema.pre("updateMany", refuseUpdate);
supplierOfferSchema.pre("findOneAndUpdate", refuseUpdate);
supplierOfferSchema.pre("update", refuseUpdate);

/* A replacement carries the whole document, so "which fields changed" cannot
   be answered before the write — and the answer would be "possibly all of
   them". Refused outright; there is no legitimate wholesale replacement of a
   quotation. */
function refuseReplace(next) {
  return next(immutable(
    "A supplier quotation cannot be replaced. Revise it, which creates the next revision and supersedes this one.",
  ));
}
supplierOfferSchema.pre("replaceOne", refuseReplace);
supplierOfferSchema.pre("findOneAndReplace", refuseReplace);

/* ── DELETION IS NOT A CORRECTION ───────────────────────────────────────────
 * A persisted offer is evidence: a costing may have been priced from it and
 * frozen the reference. Deleting it leaves that version pointing at nothing
 * and the audit trail unanswerable. Withdraw it — that is what withdrawal is
 * for, and it keeps the reason.
 *
 * Guarded on every mongoose deletion path, including the document-level
 * `doc.deleteOne()`, which is separate middleware from the query-level call of
 * the same name. `findByIdAndDelete` routes through `findOneAndDelete`.
 */
function refuseDelete(next) {
  return next(immutable(
    "A supplier quotation cannot be deleted; a costing may have been priced from it. Withdraw it instead, with a reason.",
  ));
}
supplierOfferSchema.pre("deleteOne", { document: true, query: true }, refuseDelete);
supplierOfferSchema.pre("deleteMany", refuseDelete);
supplierOfferSchema.pre("findOneAndDelete", refuseDelete);

module.exports =
  mongoose.models.SupplierOffer || mongoose.model("SupplierOffer", supplierOfferSchema);
module.exports.beginOfferLifecycle = beginOfferLifecycle;
module.exports.OFFER_STATUSES = OFFER_STATUSES;
module.exports.PRICE_BASES = PRICE_BASES;
module.exports.SUPPORTED_CURRENCIES = SUPPORTED_CURRENCIES;
