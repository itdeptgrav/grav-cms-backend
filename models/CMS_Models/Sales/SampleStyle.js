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
  SAMPLE_ROUND_OUTCOME_CODES,
  SAMPLE_STYLE_STATUS_CODES,
  SAMPLE_STYLE_STAGE_CODES,
  GARMENT_GENDER_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const imageSchema = new mongoose.Schema(
  { fileId: { type: String, trim: true }, name: { type: String, trim: true }, url: { type: String, trim: true } },
  { _id: false },
);

// A revision bounced back from a Sales gate — the note + who/when.
//
// `roundId` says WHICH round was rejected. Without it the revisions and the
// rounds were two parallel lists that could only be lined up by comparing
// timestamps, so "what was wrong with the second fit sample" had no answer.
// Absent on tech-sheet revisions, which are not about a round.
const revisionSchema = new mongoose.Schema(
  {
    note: { type: String, trim: true },
    roundId: { type: mongoose.Schema.Types.ObjectId },
    at: { type: Date, default: Date.now },
    by: actorRef(),
  },
  { _id: false },
);

// One physical sample round on the ladder (Proto → Fit → … → PP).
//
// A round used to be four fields — number, type, note, date — which recorded
// THAT a sample happened and nothing about it. It is now the record of the
// sample itself: what was made (`images`), how it was judged (`outcome`) and
// what was said (`feedback`, in the customer's or Sales' words).
//
// `outcome` moves on its own, not with sample.status: a style can be back in
// progress on round 4 while rounds 1–3 stay individually rejected or
// superseded. "superseded" is for a round nobody ruled on before the next one
// was made — common, and not the same as rejected.
const roundSchema = new mongoose.Schema(
  {
    roundNo: { type: Number, min: 1 },
    type: { type: String, enum: SAMPLE_ROUND_TYPE_CODES },
    note: { type: String, trim: true },
    images: [imageSchema],
    outcome: { type: String, enum: SAMPLE_ROUND_OUTCOME_CODES, default: "pending" },
    feedback: { type: String, trim: true },
    judgedAt: { type: Date },
    judgedBy: actorRef(),
    madeAt: { type: Date, default: Date.now },
  },
  { _id: true },
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

    // ── Variants ────────────────────────────────────────────────────────────
    //
    // One enquiry product can be developed as SEVERAL styles at once — the same
    // polo in navy poly-cotton and in white PC, offered together so the
    // customer picks. Each is its own record with its own tech sheet, its own
    // sample ladder and its own gates, because that is what they are: separate
    // things being made. What makes them siblings is sharing a product.
    //
    // `variantKey` is the empty string for the BASE variant — the style
    // provisioning raises straight from the enquiry product. Every existing row
    // is therefore a base variant with no migration, and a journey that never
    // asks for a variant behaves exactly as it did.
    //
    // The uniqueness that used to be { journeyId, productName } is now
    // { journeyId, productName, variantKey }, so two variants of one product
    // can coexist while two BASE styles for one product still cannot.
    variantKey: { type: String, trim: true, default: "", index: true },
    /** What to call it on screen: "White PC", "Heavier GSM", "Contrast collar". */
    variantLabel: { type: String, trim: true },
    /** Why this variant exists — the ask it answers. */
    variantNote: { type: String, trim: true },
    /** The style it was branched from, for ordering and for "same as X, but…". */
    variantOf: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", index: true, sparse: true },
    /**
     * Set once the customer picks between siblings. Only one per product should
     * ever be true; the route that sets it clears the others in the same save.
     * Not a status — a style can be approved and still not be the one chosen.
     */
    variantChosen: { type: Boolean, default: false },

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

// One style per product per journey.
// One BASE style per product per journey, and one style per named variant of
// it. See the `variantKey` field for why the key grew a third part.
//
// NOTE for deploys: this replaces a unique { journeyId, productName }. Mongo
// does not drop a renamed index on its own — run scripts/dropLegacyStyleIndex.js
// once, or the old one keeps refusing the second variant.
sampleStyleSchema.index({ journeyId: 1, productName: 1, variantKey: 1 }, { unique: true });

// Heal legacy routing values (an earlier build used brief/merchandiser) so old
// rows validate against the current enum instead of throwing on save.
sampleStyleSchema.pre("validate", function healStage() {
  if (this.stage && !SAMPLE_STYLE_STAGE_CODES.includes(this.stage)) this.stage = "materials";
});

module.exports = mongoose.models.SampleStyle || mongoose.model("SampleStyle", sampleStyleSchema);
