// models/CMS_Models/Sales/SampleStyle.js
//
// A SampleStyle — ONE garment style being developed inside a Sales Journey's
// "Style & Sample" stage. It is the shared record two separate apps talk to:
//
//   • the Sales journey Style & Sample stage (app/sales) — creates styles from
//     the enquiry's product rows, and owns the TWO approval gates; and
//   • the R&D / Sampling app (app/research-development) — owns the TWO
//     production jobs (tech sheet, sample).
//
// They are NOT the same page; they communicate through this one record.
//
// WHY ITS OWN COLLECTION (mirrors Enquiry's rationale): a style carries a
// tech-sheet + sampling lifecycle of its own — real module data — so it lives
// in its own record, linked back by `journeyId` (and `enquiryId`). The join key
// WITHIN a journey is the product NAME, exactly like Enquiry.costingSheets:
// enquiries.js sanitizeProducts() rebuilds the products array (and its row
// _ids) on every requirement save, so the row _id is not stable — the product
// name is. Unique compound index on { journeyId, productName }.
//
// WHAT IS NOT DUPLICATED: the customer (accountId → CRMAccount), the owner
// (ownerId/ownerName). Display names are populated on read.

const mongoose = require("mongoose");
const {
  SAMPLE_MATERIALS_STATUS_CODES,
  SAMPLE_TECHSHEET_STATUS_CODES,
  SAMPLE_SAMPLING_STATUS_CODES,
  SAMPLE_ROUND_TYPE_CODES,
  SAMPLE_STYLE_STATUS_CODES,
  SAMPLE_STYLE_STAGE_CODES,
  GARMENT_GENDER_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

// A revision bounced back from a Sales gate — the note + who/when.
const revisionSchema = new mongoose.Schema(
  { note: { type: String, trim: true }, at: { type: Date, default: Date.now }, by: actorRef() },
  { _id: false },
);

// One physical sample round on the ladder (Proto → Fit → … → PP).
const roundSchema = new mongoose.Schema(
  {
    roundNo: { type: Number, min: 1 },
    type: { type: String, enum: SAMPLE_ROUND_TYPE_CODES },
    note: { type: String, trim: true },
    madeAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const imageSchema = new mongoose.Schema(
  {
    fileId: { type: String, trim: true }, // Drive file id (legacy)
    publicId: { type: String, trim: true }, // Cloudinary public id — dropped before 19 Aug 2026, see briefFromProduct
    name: { type: String, trim: true },
    url: { type: String, trim: true },
  },
  { _id: false },
);

// One event on the style's shared timeline — every hop and bounce, so Sales,
// Merchandiser and R&D all see WHY a style ping-ponged. `kind` is a free label
// (route / send_back / tech_approved / sample_rejected / …); `note` carries the
// reason (e.g. the customer feedback Sales relayed).
const historySchema = new mongoose.Schema(
  {
    kind: { type: String, trim: true },
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    note: { type: String, trim: true },
    by: actorRef(),
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const sampleStyleSchema = new mongoose.Schema(
  {
    // Human, audit-facing reference — minted by services/sampleStyleRef.js.
    sampleStyleId: { type: String, required: true, unique: true, immutable: true, trim: true },

    // The stable per-journey style code both apps compute (SC-<journeyRef>-NN).
    styleCode: { type: String, trim: true },

    // Linkage — the journey is the spine; the enquiry is where the product row
    // (this style's origin) lives.
    journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesJourney", required: true, index: true },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry", index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", index: true },

    // Join key within the journey (see header). Never the product row _id.
    productName: { type: String, required: true, trim: true, index: true },

    // The enquiry product subdocument this style was raised from.
    //
    // Provisioning used to match styles to products by NAME alone, so editing a
    // product's text in the enquiry orphaned its style: the next read found no
    // match, created a second style, and the original's tech sheet and sample
    // rounds were stranded on a record nothing pointed at. The subdocument _id
    // survives a rename, so it is the join key now; `productName` is kept in
    // step with the enquiry rather than being the identity.
    // Sparse: styles created before this field existed have none, and they are
    // matched by name and backfilled on the next provision.
    enquiryProductId: { type: mongoose.Schema.Types.ObjectId, index: true, sparse: true },

    // Routing position (kanban): brief → materials → rnd. Created at "brief"
    // (carried from the enquiry, sent nowhere yet); the R&D app only lists
    // styles at "rnd". The finer Tech sheet / Sampling / Done columns derive
    // from the phase statuses.
    stage: { type: String, enum: SAMPLE_STYLE_STAGE_CODES, default: "brief", index: true },

    ownerId: { type: mongoose.Schema.Types.ObjectId, index: true },
    ownerName: { type: String, trim: true },

    // ── Brief — a snapshot of what the customer asked for, carried from the
    // enquiry product row and refreshed on sync. Read-only context for R&D.
    brief: {
      note: { type: String, trim: true },
      quantity: { type: Number, min: 0 },
      gender: { type: String, enum: GARMENT_GENDER_CODES },
      colour: { type: String, trim: true },
      fabricPreference: { type: String, trim: true },
      fabricComposition: { type: String, trim: true },
      gsm: { type: String, trim: true },
      fit: { type: String, trim: true },
      sizeRange: { type: String, trim: true },
      branding: { type: String, trim: true },
      brandingPlacement: { type: String, trim: true },
      trims: { type: String, trim: true },
      specialConstruction: { type: String, trim: true },
      // Missing from this snapshot until 19 Aug 2026 even though the enquiry
      // product row always carried it — R&D never saw what the customer
      // currently wears, which is exactly the kind of context that shapes a
      // tech pack.
      existingUniform: { type: String, trim: true },
      images: [imageSchema],
    },

    // ── Materials — the Merchandiser's upstream input. R&D can't start the
    // tech sheet until these are selected.
    materials: {
      status: { type: String, enum: SAMPLE_MATERIALS_STATUS_CODES, default: "pending" },
      items: [{ type: String, trim: true }],
      selectedBy: actorRef(),
      selectedAt: { type: Date },
    },

    // Staged Merchandiser/PM submissions awaiting a Sales decision — mirrors
    // Enquiry.costingChangeLog exactly, same reason: "anyone can fill
    // anything" (19 Aug 2026) means `materials` above is never written
    // directly by them, only by Sales/CEO/admin (bypassesApproval) or by an
    // approved entry here being copied over.
    materialsChangeLog: [
      new mongoose.Schema(
        {
          items: [{ type: String, trim: true }],
          status: { type: String, trim: true, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
          submittedBy: actorRef(),
          submittedAt: { type: Date, default: Date.now },
          decidedBy: actorRef(),
          decidedAt: { type: Date, default: null },
        },
        { timestamps: false },
      ),
    ],

    // ── Tech sheet — R&D produces it; Sales approves (gate 1).
    techSheet: {
      status: { type: String, enum: SAMPLE_TECHSHEET_STATUS_CODES, default: "pending" },
      file: { name: { type: String, trim: true }, url: { type: String, trim: true }, uploadedAt: { type: Date } },
      dueDate: { type: Date },
      startedAt: { type: Date },
      submittedAt: { type: Date },
      approvedAt: { type: Date },
      approvedBy: actorRef(),
      revisions: [revisionSchema],
    },

    // ── Sample — R&D runs sampling production; Sales approves (gate 2).
    sample: {
      status: { type: String, enum: SAMPLE_SAMPLING_STATUS_CODES, default: "not_started" },
      dueDate: { type: Date },
      startedAt: { type: Date },
      submittedAt: { type: Date },
      approvedAt: { type: Date },
      approvedBy: actorRef(),
      rounds: [roundSchema],
      revisions: [revisionSchema],
      // What the submission to Sales actually carries — raised alongside
      // "submit" (20 Aug 2026, explicit request): the raw materials actually
      // consumed making the physical sample (suggested from the registered
      // product's BOM, editable), and at least one photo of the sample
      // itself, so Sales can approve/reject with real evidence, not just a
      // status flip.
      consumptionRawItems: [
        {
          rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem" },
          rawItemName: { type: String, trim: true },
          variantId: { type: mongoose.Schema.Types.ObjectId },
          variantCombination: [{ type: String, trim: true }],
          quantity: { type: Number, min: 0 },
          unit: { type: String, trim: true },
          // Wastage/buffer % on top of `quantity`, same field the production
          // BOM already carries (StockItem's rawItems.allowancePercent) — so
          // Sales sees the same allowance R&D is planning around, not just a
          // bare consumed number (20 Aug 2026, explicit request).
          allowancePercent: { type: Number, default: 0, min: 0 },
          notes: { type: String, trim: true, default: "" },
        },
      ],
      photos: [imageSchema],
      // R&D ↔ Sales conversation about THIS sample specifically — not the
      // enquiry-level product chat (that's about the whole product, not
      // necessarily sampling), and not CoWork-backed: a plain embedded log
      // both sides already read/write the same SampleStyle record for, same
      // as everything else here. Doubles as the "attach more info" R&D
      // asked for — a message can carry a file with no text, text with no
      // file, or both (20 Aug 2026, explicit request).
      discussion: [
        {
          text: { type: String, trim: true, default: "" },
          attachment: {
            name: { type: String, trim: true },
            url: { type: String, trim: true },
            fileId: { type: String, trim: true },
            publicId: { type: String, trim: true },
          },
          by: actorRef(),
          at: { type: Date, default: Date.now },
        },
      ],
    },

    // ── Production (bulk / size-wise order) — DELIBERATELY SEPARATE from
    // `sample` above (19 Aug 2026, explicit request). `sample` is R&D's own
    // proto/fit/PP round-making, gated by the tech sheet, ending in a Sales
    // approval that just closes the SampleStyle. This is the real commercial
    // pipeline — Customer → Stock Item (finished good + BOM) → Customer
    // Request → (internal, auto-approved) quotation → Work Orders — driven
    // from R&D because R&D is the one who now knows the real product/BOM.
    // Reuses the SAME collections and the SAME WO-creation logic
    // (createWorkOrdersAndProgress, exported from quotationRoutes.js) Sales'
    // own "New Order on Behalf" flow already uses — this is a second front
    // door onto that pipeline, not a parallel one.
    production: {
      status: {
        type: String,
        enum: ["not_started", "customer_linked", "stock_item_linked", "submitted"],
        default: "not_started",
      },
      customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
      stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem" },
      customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest" },
      workOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }],
      // The audit trail R&D reads back — "customer created", "product
      // registered", "order request raised", "approved, N work orders
      // created" — exactly what the pipeline actually did, in order.
      log: [
        new mongoose.Schema(
          { kind: { type: String, trim: true }, note: { type: String, trim: true }, at: { type: Date, default: Date.now }, by: actorRef() },
          { _id: false },
        ),
      ],
    },

    // Shared timeline of every routing hop and gate decision (newest last).
    history: [historySchema],

    // Overall lifecycle of the style within sampling.
    status: { type: String, enum: SAMPLE_STYLE_STATUS_CODES, default: "active", index: true },

    createdBy: actorRef(),
    updatedBy: actorRef(),
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// One ACTIVE style per product per journey. Partial (scoped to isActive:true)
// rather than a flat unique index: a soft-deactivated duplicate must never
// block provisioning a fresh style under the same name.
//
// BUG FIX (19 Aug 2026): this index was declared here all along but had never
// actually been built on the live database — only the single-field indexes
// Mongoose derives from `index: true` on individual fields existed. Two
// concurrent provision calls (React StrictMode's double effect-invoke on
// mount, or Sales and R&D opening the same journey within milliseconds of
// each other) both passed provisionJourneyStyles' "does this already exist"
// read before either had committed its write, and with no unique index to
// stop the second insert, both landed — one SampleStyle per product turned
// into two, which is exactly the duplicate rows the R&D board showed. Cleaned
// up the existing duplicates in the database directly; this index plus the
// catch-and-requery guard in services/sampleStyleProvision.js close the race
// itself so it can't recur.
sampleStyleSchema.index(
  { journeyId: 1, productName: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

// Heal legacy routing values (an earlier build used brief/merchandiser) so old
// rows validate against the current enum instead of throwing on save.
sampleStyleSchema.pre("validate", function healStage() {
  if (this.stage && !SAMPLE_STYLE_STAGE_CODES.includes(this.stage)) this.stage = "materials";
});

module.exports = mongoose.models.SampleStyle || mongoose.model("SampleStyle", sampleStyleSchema);
