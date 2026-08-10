// models/CMS_Models/Sales/Enquiry.js
//
// Enquiry / RFQ — ONE specific business opportunity within a Sales Journey's
// Enquiry stage. "What does this customer want, this time?"
//
// WHY ITS OWN COLLECTION (not a field on SalesJourney):
//   The SalesJourney model deliberately refuses to embed later-stage data (see
//   its header). An enquiry carries products, pricing, qualification and a
//   status lifecycle of its own — real module data — so it lives in its own
//   record, linked back by `journeyId`, exactly as CRMActivity links to the
//   modules it annotates. One enquiry per journey (unique index on journeyId):
//   a second requirement for the same customer is a second Journey.
//
// WHAT IS NOT DUPLICATED HERE:
//   • The customer is `accountId` → CRMAccount. No company name/address copied.
//   • The contact is `primaryContactId` → CRMContact.
//   • The salesperson is `ownerId`/`ownerName`, same shape the Journey uses.
//   Display names are resolved by populating on read, never stored twice.
//
// Built in chunks: Chunk 1 is identity + header + status. Products, indicative
// pricing, qualification and lost-reason land in later chunks as additive
// fields — nothing here needs migrating when they do.

const mongoose = require("mongoose");
const {
  ENQUIRY_STATUS_CODES,
  ENQUIRY_SOURCE_CODES,
  ENQUIRY_LOST_REASON_CODES,
  GARMENT_GENDER_CODES,
  ENQUIRY_PRIORITY_CODES,
  CUSTOMER_SERIOUSNESS_CODES,
  ENQUIRY_REFERENCE_TYPE_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const enquirySchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    // The human reference the customer and audit trail see. Minted by
    // services/enquiryRef.js under an atomic counter; immutable once set.
    enquiryId: { type: String, required: true, unique: true, immutable: true, trim: true },

    // The Journey this enquiry belongs to. Unique — one enquiry per journey.
    journeyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesJourney",
      required: true,
      unique: true,
      index: true,
    },

    // The customer and the specific person we're dealing with — references, not
    // copies. accountId is indexed so "this account's enquiries" is cheap.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", required: true, index: true },
    primaryContactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    // The salesperson who owns this opportunity.
    ownerId: { type: mongoose.Schema.Types.ObjectId, index: true },
    ownerName: { type: String, trim: true },

    // The Lead this opportunity grew out of, when it was converted from one.
    sourceLeadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },

    // Salesperson-facing title, e.g. "New staff uniforms for ITC Bhubaneswar".
    title: { type: String, trim: true },

    // ── Dates & source ──────────────────────────────────────────────────────
    enquiryDate: { type: Date, default: Date.now },
    source: { type: String, enum: ENQUIRY_SOURCE_CODES },
    expectedClosingDate: { type: Date },
    requirementDeadline: { type: Date },

    // Free-text summary of what the customer is asking for — the plain-language
    // brief that complements the structured products below.
    summary: { type: String, trim: true },

    // ── Products (Chunk 2) + per-product garment spec (Chunk 3) ─────────────
    // The product-wise requirement. Quantities are APPROXIMATE at enquiry stage
    // — not PO-level final. Seeded from the converting Lead's requirementItems.
    // Every spec field is optional: at enquiry stage the customer's brief is
    // rarely complete, and a half-filled spec is more useful than a blocked one.
    products: [
      new mongoose.Schema(
        {
          product: { type: String, trim: true, required: true },
          quantity: { type: Number, min: 0 },
          note: { type: String, trim: true },

          // Garment spec
          gender: { type: String, enum: GARMENT_GENDER_CODES },
          colour: { type: String, trim: true },
          fabricPreference: { type: String, trim: true },
          fabricComposition: { type: String, trim: true },
          gsm: { type: String, trim: true }, // "180 GSM" or a bare number — free text, only "if specified"
          fit: { type: String, trim: true },
          sizeRange: { type: String, trim: true },

          // Branding / decoration
          logo: { type: Boolean, default: false },
          embroidery: { type: Boolean, default: false },
          printing: { type: Boolean, default: false },
          brandingPlacement: { type: String, trim: true },

          // Construction & context
          trims: { type: String, trim: true },
          specialConstruction: { type: String, trim: true },
          existingUniform: { type: String, trim: true }, // existing garment details / what they wear now
        },
        { _id: true },
      ),
    ],

    // ── Costing sheets (CoWork bridge) — top-level, keyed by PRODUCT NAME ───
    // Not embedded on the product row above, and not keyed by that row's
    // _id: routes/CMS_Routes/Sales/enquiries.js's sanitizeProducts() rebuilds
    // the entire `products` array from client input on every "Save
    // requirement" (Chunk 2), which reassigns a fresh _id to every row and
    // carries through only its own known field list. A pointer stored on or
    // keyed by that row would be silently orphaned the next time somebody
    // edited a quantity. Product NAME survives that rewrite — it's the field
    // a requirement edit actually preserves — so it is what this joins on.
    // If a product is later renamed, its costing sheet is not auto-migrated;
    // the sheet itself still exists in CoWork and isn't lost, just no longer
    // linked from this row until someone re-links it.
    //
    // The sheet's cell content and live collaboration state live entirely in
    // CoWork (Firestore cowork_documents/cowork_document_bodies, kind:
    // "sheet") — this is only the pointer plus a denormalised membership
    // snapshot so the CMS can render without a round trip to CoWork on every
    // list view. Source of truth for membership stays the CoWork document
    // itself — see services/coworkSheets.service.js.
    costingSheets: [
      new mongoose.Schema(
        {
          productName: { type: String, trim: true, required: true },
          documentId: { type: String, trim: true, required: true }, // cowork_documents doc id
          title: { type: String, trim: true },
          createdAt: { type: Date, default: Date.now },
          createdBy: actorRef(),
          members: [
            {
              employeeId: { type: String, trim: true },
              name: { type: String, trim: true },
              role: { type: String, trim: true, enum: ["owner", "editor", "viewer"] },
            },
          ],
        },
        { _id: false },
      ),
    ],

    // ── Indicative pricing (Chunk 4) ────────────────────────────────────────
    // INDICATIVE only — NOT the formal quote (that's the Cost & Quote stage).
    // `targetPrice` is what the customer says their budget is; `estimatedPrice
    // Min/Max` is our rough "we usually make this for…", subject to sampling and
    // final costing. Seeded from the lead's estimated unit price.
    pricingCurrency: { type: String, trim: true, uppercase: true, default: "INR" },
    targetPrice: { type: Number, min: 0 }, // customer's stated budget per unit
    estimatedPriceMin: { type: Number, min: 0 },
    estimatedPriceMax: { type: Number, min: 0 },
    pricingNote: { type: String, trim: true },

    // ── Sales qualification (Chunk 4) ───────────────────────────────────────
    // Is this worth pursuing, and how hard? Opportunity size is a whole-deal
    // value (restricted-commercial in spirit; kept simple here). Probability is
    // 0–100. Seriousness is the Hot/Warm/Cold read.
    opportunitySize: { type: Number, min: 0 },
    winProbability: { type: Number, min: 0, max: 100 },
    priority: { type: String, enum: ENQUIRY_PRIORITY_CODES },
    seriousness: { type: String, enum: CUSTOMER_SERIOUSNESS_CODES },
    expectedOrderDate: { type: Date },

    // ── References (Chunk 6) ────────────────────────────────────────────────
    // The supporting material for the brief. Binary file upload is deferred
    // until the platform file service is connected to the CRM; until then a
    // reference is a LINK (Pinterest, drive, etc.) or a NOTE about a physical
    // sample, tagged by type. When uploads land, `fileUrl`/`fileName` join this
    // sub-schema with no migration.
    references: [
      new mongoose.Schema(
        {
          label: { type: String, trim: true },
          type: { type: String, enum: ENQUIRY_REFERENCE_TYPE_CODES, default: "other" },
          url: { type: String, trim: true }, // a link to the reference (drive, Pinterest, …)
          note: { type: String, trim: true }, // e.g. "physical sample couriered 12 Aug"
        },
        { _id: true },
      ),
    ],

    // ── Lifecycle ───────────────────────────────────────────────────────────
    status: { type: String, enum: ENQUIRY_STATUS_CODES, default: "new", index: true },
    // Required only when status === "lost"; enforced in the route, not the
    // schema, so a mid-edit save isn't blocked before the reason is picked.
    lostReason: { type: String, enum: ENQUIRY_LOST_REASON_CODES },
    lostReasonNote: { type: String, trim: true },

    // ── Audit / lifecycle metadata, matching the other CRM models ───────────
    createdBy: actorRef(),
    updatedBy: actorRef(),
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

module.exports = mongoose.models.Enquiry || mongoose.model("Enquiry", enquirySchema);
