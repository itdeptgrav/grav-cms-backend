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

/* ── "THIS STYLE DOES NOT NEED ONE", RECORDED WHERE THE ROWS ARE ──────────
   Three explicit, department-owned answers, all the same three fields. See
   `services/styleApplicability.js` for why `required` has no default: absent
   is a question nobody asked, and it must never read as "no". */
const { decisionSchemaFields } = require("../../../services/styleApplicability");
const applicabilityDecision = () => decisionSchemaFields(mongoose);

/* `publicId` is not optional decoration: enquiry images have been uploaded to
   Cloudinary since 19 Aug 2026 and are stored as {publicId, name, url}, while
   older ones are Drive's {fileId, name, url}. Mongoose strips anything not
   declared here, so a brief built from a Cloudinary image used to arrive at
   R&D with its publicId silently removed — the thumbnail transform in the
   frontend's driveImage.js keys on exactly that field. */
const imageSchema = new mongoose.Schema(
  {
    fileId: { type: String, trim: true }, // Drive (legacy)
    publicId: { type: String, trim: true }, // Cloudinary
    name: { type: String, trim: true },
    url: { type: String, trim: true },
  },
  { _id: false },
);

// One raw item picked for this style, variant-wise — the Merchandiser's
// materials pick AND R&D's sample consumption both use this exact shape
// (24 Aug 2026), so the same sync-onto-the-stock-item logic handles either
// source without a case-by-case translation.
const rawItemPickSchema = new mongoose.Schema(
  {
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem" },
    rawItemName: { type: String, trim: true },
    rawItemSku: { type: String, trim: true },
    // The RAW ITEM's own physical variant (colour/vendor combination) —
    // distinct from productVariantId below.
    variantId: { type: mongoose.Schema.Types.ObjectId },
    variantCombination: [{ type: String, trim: true }],
    // Which variant of the LINKED STOCK ITEM this row is for — absent means
    // "every variant" (a trim like a button is usually the same across
    // sizes; a fabric quantity usually is not, which is exactly why this
    // exists instead of one flat list for the whole product).
    productVariantId: { type: mongoose.Schema.Types.ObjectId },
    productVariantLabel: { type: String, trim: true },
    // Optional — the Merchandiser is picking WHAT'S needed, not always
    // measuring HOW MUCH yet; R&D fills the real consumption later. Present
    // when they do know it.
    quantity: { type: Number, min: 0 },
    unit: { type: String, trim: true },
  },
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

    // WHERE THIS STYLE CAME FROM.
    //
    // `journey` — the original and still the common case: a customer enquired,
    //   a journey was raised, and this style is one product row on it.
    // `house`   — an IN-HOUSE SAMPLE with no customer behind it at all
    //   (31 Aug 2026, explicit request: "without any customer reference we are
    //   gonna make the sample... most of the time it happen ki some samples are
    //   needed to make even though none of any customer make the order").
    //   Raised from Sales -> Sampling, it runs the SAME merchandiser -> PM ->
    //   R&D -> production -> sales-approval pipeline; the only thing it lacks
    //   is a journey and a real customer.
    //
    // Stored explicitly rather than inferred from `journeyId == null`, because
    // "has no journey" and "is deliberately an in-house sample" are different
    // claims, and every screen that badges these needs the second one.
    sampleType: { type: String, enum: ["journey", "house"], default: "journey", index: true },

    // Linkage — the journey is the spine; the enquiry is where the product row
    // (this style's origin) lives.
    //
    // OPTIONAL SINCE 31 Aug 2026. A house sample has no journey, and inventing
    // a fake one to satisfy a required field would put a phantom journey in
    // every Pipeline list and report. Everything downstream already tolerates a
    // null here — `withJourney()` resolves it to null, the R&D board never
    // filters on it, and `createWorkOrdersAndProgress` never reads it. The
    // uniqueness rule that DID depend on it is now a partial index (see below).
    journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesJourney", index: true },
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

    // ── Raised from a registered product ────────────────────────────────────
    //
    // The item-master entry the enquiry row named, when it named one. Distinct
    // from `production.stockItemId` further down, which is the OPPOSITE
    // direction: that is the product this style became after being developed.
    // This is the product it came from, already developed.
    //
    // It is what lets the Style & Sample stage prove the claim it makes. Saying
    // "no development needed" without being able to show WHY would be worse
    // than asking for the work: the reader has to take it on trust, and six
    // months later nobody can tell a waived style from a forgotten one.
    sourceStockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", index: true, sparse: true },
    sourceStockItemReference: { type: String, trim: true },

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
      // Missing from this snapshot until 19 Aug 2026 even though the enquiry
      // product row always carried it — R&D never saw what the customer
      // currently wears, which is exactly the kind of context that shapes a
      // tech pack.
      existingUniform: { type: String, trim: true },
      // The rest of what the enquiry row knows, snapshotted so R&D reads the
      // WHOLE product rather than the subset this brief used to carry
      // (24 Aug 2026, explicit request). Mongoose strips anything not
      // declared here, so briefFromProduct's additions have to be mirrored.
      logo: { type: Boolean, default: false },
      embroidery: { type: Boolean, default: false },
      printing: { type: Boolean, default: false },
      stockItemReference: { type: String, trim: true },
      /** Salesperson-defined spec — see Enquiry's products[].customSpecs. */
      customSpecs: [
        new mongoose.Schema(
          { label: { type: String, trim: true }, value: { type: String, trim: true, default: "" } },
          { _id: false },
        ),
      ],
      images: [imageSchema],
      /* ── WHAT IS TO BE EMBROIDERED OR PRINTED, AND WHERE ────────────────
         One row per decoration, carried from the enquiry product line and
         refreshed on every provision, exactly like the rest of this brief.

         Rows projected from a pre-structured enquiry (the old logo/embroidery/
         printing booleans) arrive here too, marked `legacy`, so R&D reads one
         shape for both.

         ── THIS ARTWORK IS THE BUYER'S, NOT AN APPROVED FILE ───────────────
         Everything in `artwork` came from the customer: a logo off an email, a
         photo of a uniform they already wear. None of it has been digitised,
         colour-separated or approved by anyone. The approved asset for this
         style is `techSheet.file`, which has an approver and a date; a screen
         showing both must say which is which. `artworkIsCustomerReference`
         below is that statement, in the data rather than in a comment only. */
      brandingRequirements: [
        new mongoose.Schema(
          {
            /* The enquiry requirement this came from — stable across edits,
               so a screen can point back at one decoration rather than at
               "the second row". */
            ref: { type: String, trim: true },
            type: { type: String, trim: true },
            placement: { type: String, trim: true },
            width: { type: Number },
            height: { type: Number },
            unit: { type: String, trim: true },
            colourNotes: { type: String, trim: true },
            notes: { type: String, trim: true },
            artworkState: { type: String, trim: true },
            artwork: [imageSchema],
            legacy: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      /** Always true today. Read it rather than assuming from a field name. */
      artworkIsCustomerReference: { type: Boolean, default: true },
    },

    // ── Materials — the Merchandiser's upstream input. R&D can't start the
    // tech sheet until these are selected.
    materials: {
      status: { type: String, enum: SAMPLE_MATERIALS_STATUS_CODES, default: "pending" },
      // Free-text "Item — Vendor" rows — the ORIGINAL shape, kept for the
      // history already recorded this way and for callers that only need a
      // name to show, not a real BOM entry.
      items: [{ type: String, trim: true }],
      // The structured, variant-wise sibling of `items` above (24 Aug 2026,
      // explicit request — "the raw item are goona fill as per the variant
      // wise... keep the consumption input... optional"). This is what syncs
      // onto the linked stock item's BOM once approved, and what R&D's own
      // sample-submission step reads to auto-suggest what's already known —
      // `items` alone (a name and a vendor, no real rawItemId/variantId/
      // quantity) can't drive either.
      rawItems: [rawItemPickSchema],

      /* ══ WHAT THE GARMENT IS PACKED IN — MERCHANDISING'S SELECTION ═════
         Which packaging components this style needs: poly bag, hang tag,
         barcode sticker, carton, label.

         ── WHY THIS IS SEPARATE FROM R&D'S ROW ─────────────────────────
         Merchandising knows WHICH components a style requires; they are not
         measuring the garment. How many of each is confirmed after sampling
         and is R&D's, in `sample.packagingRequirements`. One record holding
         both is how a figure nobody measured ends up presented as a fact —
         the same mistake the material shortlist had to be corrected for.

         So there is deliberately no quantity, no unit, no basis, no supplier
         and no rate here. Identity, a readable snapshot, and what to make
         of it. */
      packagingSelections: [
        new mongoose.Schema({
          /* Stable row identity, minted server-side. Two legitimate rows may
             name the same item — two different printed bags — and keying by
             what they name would silently merge them. */
          rowId: { type: String, trim: true, maxlength: 40 },
          /* The company-scoped ITEM MASTER. A poly bag is a material the
             company buys; it needs no second master, and giving it one would
             mean two places to quote the same thing. */
          rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
          /* Snapshots, for readability only. The id is the identity — a
             renamed master must not orphan the row, and a name must never be
             what a lookup matches on. */
          rawItemName: { type: String, trim: true, default: "" },
          rawItemSku: { type: String, trim: true, default: "" },
          variantId: { type: mongoose.Schema.Types.ObjectId },
          variantLabel: { type: String, trim: true, default: "" },
          /* "Printed poly bag, 300x400mm" — the packing instruction, which
             is Merchandising's to state and R&D's to work to. */
          specification: { type: String, trim: true, default: "", maxlength: 2000 },
          status: {
            type: String,
            enum: ["proposed", "approved", "withdrawn"],
            default: "proposed",
          },
          selectedBy: actorRef(),
          selectedAt: { type: Date, default: Date.now },
          /* Withdrawn rather than deleted: a component that was required and
             then dropped is a decision somebody may need to explain. */
          withdrawnAt: { type: Date },
          withdrawnBy: actorRef(),
          withdrawnReason: { type: String, trim: true, maxlength: 1000 },
        }, { _id: false }),
      ],

      /* ══ IS THIS STYLE PACKED AT ALL? — MERCHANDISING'S ANSWER ════════
         An EMPTY `packagingSelections` is not "no packaging". It is a style
         nobody has looked at yet, and those two states are the whole reason
         this field exists: Central Costing used to be unable to tell them
         apart, so somebody costing the garment declared packaging "not
         applicable" from a screen that could not know.

         Merchandising chooses the components, so Merchandising answers this.
         `false` means the customer supplies the packaging, or the goods ship
         loose — a commercial fact, with its reason. R&D then measures only
         what was selected; they do not get to decide that a selected
         component is unnecessary. */
      packagingDecision: applicabilityDecision(),

      /* ══ HOW THE GOODS ARE PACKED OUT — MERCHANDISING'S CONFIGURATION ══
         How many finished garments go in one carton is a PACK CONFIGURATION,
         agreed with the buyer alongside the folding and the carton marks. It
         is not a measurement, so it is not R&D's, and it is not a route, so it
         is not IE's — it belongs with the packaging specification, here.

         It also already exists as `sample.shipment.garmentsPerCarton`, which
         is R&D's unversioned working record. That one stays, for the sampling
         screens that use it; a costing reads THIS one, because a carton
         capacity that changes has to change as an approved decision with a
         number attached rather than as an edit nobody can point to.

         Post-order the same fact is carried by the in-force PACKAGING
         `SelectionRevision` on the Execution File, which is versioned by
         construction. This is the pre-order form of the same decision. */
      packingConfiguration: {
        revision: { type: Number, min: 0, default: 0 },
        garmentsPerCarton: { type: Number, min: 1, default: undefined },
        decidedBy: actorRef(),
        decidedAt: { type: Date },
        notes: { type: String, trim: true, default: "", maxlength: 500 },
      },

      selectedBy: actorRef(),
      selectedAt: { type: Date },
      // Optional target date Sales sets when routing to the Merchandiser
      // (28 Aug 2026, explicit request: "an input need to ask for the sales
      // while click for the sent to merchantiser... do u want to set deadline
      // ok.. so this is optional"). Attached to the hand-off email when
      // present; nothing enforces it — a target the Merchandiser is told, not
      // a gate that blocks anything.
      deadline: { type: Date },
    },

    // ── Project Manager's BOM sign-off — the gate between Materials and
    // R&D (28 Aug 2026, explicit request: "the second step will be Take
    // Approval From Production manager... and once approved, then only the
    // next step means the send to R&D button will goona enable").
    //
    // NOT A NEW `stage`. The style stays at `materials` throughout; this is a
    // sub-state of it. Adding a fourth stage code would have rippled into the
    // R&D app's own queries, the kanban columns, STAGE_ORDER's backward-move
    // arithmetic and every existing row's meaning — for a gate that only ever
    // decides whether ONE button is enabled.
    //
    // The decision is made from the emailed request itself, not in the CMS
    // (same request: "on that mail they need to approve/reject the request...
    // don't keep manual button here for production manager approval"), so
    // there is no logged-in actor to record — `decidedByEmail` is whichever
    // recipient opened the link, and `decidedByName` their Access Control
    // name. See routes/CMS_Routes/Sales/sampleBomApproval.js.
    bomApproval: {
      status: { type: String, enum: ["none", "pending", "approved", "rejected"], default: "none", index: true },
      /**
       * Rotated on every request, and the ONLY thing the emailed decision link
       * carries besides the style id. Rotating it is what expires the previous
       * round's email: a stale "Approve" link from a superseded request
       * resolves to a token that no longer matches and is refused, so an
       * approval can never be replayed against a BOM that has since changed.
       */
      token: { type: String, trim: true, select: false },
      round: { type: Number, default: 0 },
      requestedAt: { type: Date },
      requestedBy: actorRef(),
      /** Who the request went to, captured at send time so Sales can see it. */
      requestedTo: [{ type: String, trim: true }],
      decidedAt: { type: Date },
      decidedByName: { type: String, trim: true },
      decidedByEmail: { type: String, trim: true },
      /** Required on a rejection — what Merchandising has to fix. */
      note: { type: String, trim: true },
      // Optional target date Sales sets when requesting the approval — same
      // reasoning and same "informational, not enforced" nature as
      // materials.deadline above. Cleared and re-set on every new request
      // (including "Send Approval Again"), alongside token/round/requestedAt.
      deadline: { type: Date },
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
          rawItems: [rawItemPickSchema],
          // Explicit "no materials needed for this style", not just an
          // empty form nobody filled in yet (26 Aug 2026, "the sales person
          // can also skip this part") — carried through so approving this
          // entry later still resolves materials as done, not "still
          // pending", even though items is empty either way.
          skip: { type: Boolean, default: false },
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

      /* ══ THE STRUCTURED TECHNICAL RECORD ═══════════════════════════════
         R&D's own facts about this style, as data rather than as a PDF.

         ── WHY THIS EXISTS ──────────────────────────────────────────────
         The tech sheet has always been a FILE. Everything a costing needs —
         what each material actually consumes per finished piece, in what
         unit, with what allowance — lived either in a drawing nobody can
         read programmatically, or in `materials.rawItems`, where the
         Merchandiser had typed it.

         That second one is the ownership mistake this corrects. The
         Merchandiser selects WHICH materials; they are not measuring the
         garment. A quantity they entered was being read as a final
         per-garment consumption and shown as "0.2625 kg + 5%" as though it
         had been established. It had not been.

         So consumption, unit, allowance and specification are recorded HERE,
         by R&D, who own the fact. The file stays as supporting evidence.

         ── AND WHY IT IS SEPARATE FROM `sample.consumptionRawItems` ──────
         That records what one physical sample round actually consumed, and
         it is only meaningful once Sales approves the sample. This is the
         engineered figure for the style, which a costing needs long before
         any sample exists. Two different facts; two records. */
      technical: {
        /* `draft` while R&D works, `submitted` awaiting Sales, `approved`
           once Sales accepts, `rework` when Sales sends it back. Distinct
           from `techSheet.status` above, which is the FILE's gate and stays
           exactly as it was. */
        status: {
          type: String,
          enum: ["not_started", "draft", "submitted", "approved", "rework"],
          default: "not_started",
        },
        /* Increments on every submission. The frozen copy in
           `technicalRevisions` carries the same number, so an approved
           costing can always name the revision it read. */
        revision: { type: Number, default: 0 },
        startedAt: { type: Date },
        startedBy: actorRef(),
        submittedAt: { type: Date },
        submittedBy: actorRef(),
        approvedAt: { type: Date },
        approvedBy: actorRef(),
        /* ── AND WHEN AN APPROVED RECORD WAS REOPENED ──────────────────
           Set by the tech sheet's `revise` action, which is the only way an
           approved technical record becomes editable again. Recorded on the
           record itself rather than only in the sheet's note list, because
           "this approved record was deliberately reopened, by whom, and why"
           is a fact about the record — and without it a reader seeing status
           `rework` on a style that has an approved revision behind it has to
           infer how it got there. Absent on every record nobody reopened. */
        reopenedAt: { type: Date },
        reopenedBy: actorRef(),
        reopenReason: { type: String, trim: true },

        /* ── ONE ROW PER APPROVED MATERIAL ──────────────────────────────
           The identity half (rawItemId, name, sku, variant) is COPIED from
           the approved BOM and is not editable here — R&D may not silently
           substitute another item. If the wrong material was selected, the
           row is sent back to Merchandising with a reason, which is an
           action with a history rather than an edit. */
        materials: [
          new mongoose.Schema({
            /* Identity — from the approved BOM, never chosen on this screen. */
            rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
            rawItemName: { type: String, trim: true },
            rawItemSku: { type: String, trim: true },
            variantId: { type: mongoose.Schema.Types.ObjectId },
            variantCombination: [{ type: String, trim: true }],

            /* R&D's facts. */
            specification: { type: String, trim: true, default: "", maxlength: 2000 },
            /* Per FINISHED PIECE. Named in full because "quantity" is what
               the Merchandiser's shortlist used to hold, and the whole point
               of this record is that the two are different claims. */
            consumptionPerPiece: { type: Number, min: 0 },
            unit: { type: String, trim: true, default: "" },
            /* Explicit, and separate from the consumption. Never folded into
               it: `sample.consumptionRawItems` learned that lesson the hard
               way, where an allowance already inside the quantity had to be
               documented so nothing multiplied it in twice. */
            allowancePercent: { type: Number, min: 0, default: null },
            evidenceNote: { type: String, trim: true, default: "", maxlength: 1000 },

            /* Which product variants this row applies to. Empty with
               `appliesToAllVariants` true means every size — the usual case
               for a trim; a fabric often differs by size, which is why this
               is expressible at all. */
            appliesToAllVariants: { type: Boolean, default: true },
            appliesToVariantIds: [{ type: mongoose.Schema.Types.ObjectId }],
            appliesToVariantLabels: [{ type: String, trim: true }],

            /* Set when R&D sends this material back to Merchandising. The row
               stays, so the record shows what was questioned and why. */
            returnedToMaterials: {
              at: { type: Date },
              by: actorRef(),
              reason: { type: String, trim: true, maxlength: 1000 },
            },
          }, { _id: false }),
        ],

        /* ── OPERATIONS AND THEIR SAM ────────────────────────────────────
           Chosen from the registered Operation master by identity. R&D
           records the TIME; what a minute costs is company policy, read at
           costing time. No rate is entered here and none is stored. */
        operations: [
          new mongoose.Schema({
            operationId: { type: mongoose.Schema.Types.ObjectId, ref: "Operation", required: true },
            operationCode: { type: String, trim: true, default: "" },
            name: { type: String, trim: true },
            machineType: { type: String, trim: true, default: "" },
            minutes: { type: Number, min: 0, default: 0 },
            seconds: { type: Number, min: 0, default: 0 },
            notes: { type: String, trim: true, default: "", maxlength: 1000 },
          }, { _id: false }),
        ],

        /* ── PACKAGING, OUTSIDE SERVICES AND DEVELOPMENT WORK ────────────
           Only where applicable. Each maps to an EXISTING central-costing
           requirement family rather than becoming a free-text cost line —
           that is the difference between a requirement the costing can
           source and a number somebody typed. */
        requirements: [
          new mongoose.Schema({
            family: {
              type: String,
              /* ── PACKAGING IS NOT HERE, DELIBERATELY ──────────────────
                 It has its own record — `sample.packagingRequirements`, the
                 R&D technical consumption source the costing has read since
                 the family was built, with its own basis, evidence and
                 include/exclude decision. Listing it here as well made two
                 writable homes for one fact, and only one of them was ever
                 read: a packaging row recorded through this generic field
                 would have been invisible to every costing.

                 Kept OUT of the enum rather than merely unused, so the
                 mistake is refused at the schema instead of discovered when
                 a costing reports no packaging for a style that plainly has
                 some. */
              enum: ["SERVICE", "DEVELOPMENT_TOOLING"],
              required: true,
            },
            name: { type: String, trim: true, required: true, maxlength: 200 },
            specification: { type: String, trim: true, default: "", maxlength: 2000 },
            quantity: { type: Number, min: 0 },
            /* "per garment", "per run", "per screen" — what the quantity is
               counted in. A quantity with no basis is not a requirement. */
            basis: { type: String, trim: true, default: "" },
            unit: { type: String, trim: true, default: "" },
            rationale: { type: String, trim: true, default: "", maxlength: 1000 },
          }, { _id: false }),
        ],
      },

      /* ── EVERY SUBMITTED REVISION, FROZEN ──────────────────────────────
         Appended on submission and never edited. Sales returning a sheet
         starts a new revision; the one they saw stays exactly as it was, so
         "what did we approve in September" has an answer. */
      technicalRevisions: [
        new mongoose.Schema({
          revision: { type: Number, required: true },
          submittedAt: { type: Date, required: true },
          submittedBy: actorRef(),
          /* The file as it stood at submission — the record and its evidence
             are frozen together, or the pair proves nothing. */
          file: { name: { type: String, trim: true }, url: { type: String, trim: true }, uploadedAt: { type: Date } },
          /* Deliberately `Mixed`: a frozen snapshot must keep the shape it
             had, not be re-validated against a schema that has moved on. */
          snapshot: { type: mongoose.Schema.Types.Mixed },
          outcome: {
            type: String,
            enum: ["submitted", "approved", "returned"],
            default: "submitted",
          },
          decidedAt: { type: Date },
          decidedBy: actorRef(),
          decisionNote: { type: String, trim: true, maxlength: 2000 },
        }, { _id: false }),
      ],
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
      // ── WHAT THE GARMENT IS PACKED IN ────────────────────────────────
      // Poly bags, hang tags, cartons. Costing had no way to answer packaging
      // at all before this: the ITEMS existed in the item master and could
      // carry supplier quotations, and nothing anywhere connected a garment to
      // them — so every costing reported packaging as a family with no source
      // and offered a hand-typed override instead.
      //
      // Shaped like `consumptionRawItems` on purpose. It is the same kind of
      // fact: R&D says WHICH item and HOW MUCH, and the Store quotation
      // register says what it costs. No rate lives here — duplicating a
      // supplier price onto the technical record is how the costing and the
      // quotation start disagreeing, and only one of them is dated.
      packagingRequirements: [
        {
          /* This row's own identity — minted server-side and preserved across
             edits. Two legitimate rows naming the same item and variant are
             two rows; keyed by what they name they would be one. */
          rowId: { type: String, trim: true, maxlength: 40 },
          /* ── WHICH MERCHANDISING SELECTION THIS ANSWERS ─────────────────
             The `rowId` of the approved `materials.packagingSelections` row.
             Additive and optional: every requirement written before the
             selection layer existed has none, keeps working, and is reported
             as legacy rather than backfilled into a selection nobody made.

             The link is by ROW, not by item, because two legitimate
             selections may name the same item — an inner bag and an outer
             bag — and joining on the item would collapse them into one
             requirement and lose a component. */
          sourceSelectionRowId: { type: String, trim: true, maxlength: 40 },
          /* The company-scoped item master. A poly bag is a material the
             company buys; it needs no second master, and giving it one would
             mean two places to quote the same thing. */
          rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem" },
          rawItemName: { type: String, trim: true, default: "" },
          rawItemSku: { type: String, trim: true, default: "" },
          variantId: { type: mongoose.Schema.Types.ObjectId },
          variantLabel: { type: String, trim: true, default: "" },
          /* What R&D actually specified — "printed poly bag, 300×400mm".
             Distinct from the item's own name, which is the master's. */
          specification: { type: String, trim: true, default: "", maxlength: 2000 },
          /* ── MISSING IS MISSING, NEVER ZERO ────────────────────────────
             No default. A packaging row whose quantity nobody recorded is an
             unfinished technical record, and defaulting it to 0 would cost
             the garment as though it shipped unpacked. The assembly blocks
             on it and names R&D. */
          quantity: { type: Number, min: 0, default: undefined },
          unit: { type: String, trim: true, default: "" },
          /* ── PER GARMENT, OR PER RUN ──────────────────────────────────
             A poly bag is one per garment and scales with the order. A master
             carton holds forty and is bought per run; a shipping mark plate
             is bought once whatever the run. Costing dilutes the second kind
             across the quantity, which is a different number, so it cannot be
             guessed from the item. */
          basis: {
            type: String,
            /* ── THREE GENUINELY DIFFERENT SHAPES ───────────────────────
               PER_GARMENT   a poly bag: one each, scales with the run.
               PER_CARTON    a master carton: one per N garments, so it
                             scales in STEPS — 26 garments at 25 to a carton
                             is two cartons, not 1.04.
               FIXED_PER_RUN a shipping-mark plate: bought once whatever the
                             run, diluted across it. Does not scale at all.

               PER_CARTON is additive and is NOT a synonym for
               FIXED_PER_RUN — neither of the original two could express
               "one carton per 25 garments", which is why it exists. */
            enum: ["PER_GARMENT", "PER_CARTON", "FIXED_PER_RUN"],
            default: "PER_GARMENT",
          },
          /* ── THE CONVERSION LIVES ON THE SHIPMENT, NOT HERE ────────────
             A carton basis needs "how many garments per carton", and that
             fact ALREADY EXISTS as `sample.shipment.garmentsPerCarton` —
             R&D-recorded, with the same ceiling rule, and read by the
             freight family since it was built.

             Repeating it on the packaging row would be two answers to one
             question about one style: a carton that holds 25 for freight and
             40 for packaging is a contradiction nobody would ever be told
             about. So there is deliberately no field here — the assembly
             reads the shipment, and refuses the row when it is unset. */
          /* Where the figure came from — measured on the approved sample, or
             planned by merchandising. The costing labels it, and treats a
             planned figure as provisional evidence. */
          /* ── THE SAME TWO WORDS THE TECHNICAL SOURCE SPEAKS ──────────
             `BOM_PLANNED` is what a planned MATERIAL row is called
             (`technicalSource.EVIDENCE`), and a planned packaging or service
             row is the same kind of claim. A synonym here would mean the
             costing had to translate between two vocabularies for one fact,
             and the translation is where they stop agreeing.

             Defaulted to PLANNED, never MEASURED: "measured on the sample" is
             a claim the sample demonstrated this figure, and it is what lets
             a costing treat the row as verified. A row nobody answered for
             has demonstrated nothing. */
          /* -- NO DEFAULT, BECAUSE NOBODY ANSWERED --------------------
             `BOM_PLANNED` looked like the safe default and was still a
             claim the schema made on somebody's behalf. It also contradicted
             the write path, which REQUIRES the answer: a row could only
             acquire this value by never being asked, and at rest it read
             identically to a row where a person had chosen "planned".

             Missing stays missing. Costing reads an absent evidence AS
             planned — the weaker reading, applied where the consequence
             lives — and it can never become "measured" on its own. */
          evidence: {
            type: String,
            enum: ["SAMPLE_MEASURED", "BOM_PLANNED"],
            default: undefined,
          },
          /* Recorded and then decided against. Kept rather than deleted: "we
             considered a hang tag and dropped it" is a fact worth having, and
             a removed row leaves no trace of the decision. */
          included: { type: Boolean, default: true },
          excludedReason: { type: String, trim: true, default: "", maxlength: 500 },
          notes: { type: String, trim: true, default: "" },
        },
      ],

      // ── WHAT IS SENT OUTSIDE, AND HOW MUCH OF IT ─────────────────────
      // Dyeing, printing, embroidery, washing, testing. The Service master
      // records what the company BUYS; nothing recorded what a style
      // REQUIRES, so outside services were a family with no source in exactly
      // the same way packaging was.
      //
      // This describes the requirement, never the charge. `Service.defaultRate`
      // is planning guidance by its own schema's account, and the costing
      // never reads it: the rate comes from a dated service quotation.
      /* ── WHAT THE FINISHED GARMENT SHIPS AS ─────────────────────────
         Freight is quoted per kilogram or per carton, and neither could be
         answered anywhere in this system: there was no weight field on the
         style, the product or the item, and the packaging rows record that a
         carton is USED without ever saying how many garments one holds.

         So a freight rate could be configured, be applicable, and still
         produce nothing. These are the two facts that make it calculable,
         and they are R&D's: they are measured on the sample, like every
         other fact in this block.

         Absent, never zero — a garment of no weight would cost nothing to
         send, which is the failure this whole family exists to avoid. */
      shipment: {
        /* ── GRAMS, SAID IN THE FIELD NAME ────────────────────────────
           A bare `packedWeight` is a number whose unit lives in somebody's
           head, and a costing that reads kilograms as grams is out by a
           thousand. Packed, not net: the freight bill is for what leaves the
           building, bag and tag included. */
        packedWeightGrams: { type: Number, min: 0, default: undefined },
        /* How many finished garments one shipping carton holds. Used with
           ceiling division — 250 garments at 40 a carton is 7 cartons, and
           the seventh is charged in full. */
        garmentsPerCarton: { type: Number, min: 1, default: undefined },
        /* What was actually weighed or counted, in R&D's words. */
        notes: { type: String, trim: true, default: "", maxlength: 500 },
      },

      /* ══ THE PACKED WEIGHT, APPROVED AND FROZEN — R&D'S EVIDENCE ═══════
         `shipment` above is a WORKING record: R&D edits it while sampling,
         and nothing about it is versioned. Central Costing froze a figure read
         from it, so a weight typed after a costing was built silently changed
         what the freight line had been calculated from, with nothing recording
         that it had happened.

         A costing may only read an APPROVED revision of this measurement. The
         revision number is what makes two readings comparable: a costing
         freezes `{revision, approvedAt}`, and a later measurement is a new
         revision rather than an edit of the one somebody costed.

         This is deliberately NOT part of the R&D technical revision and NOT
         part of the IE bulletin: Industrial Engineering confirms the route and
         the consumption a garment is MADE by, and does not become the approver
         of a weighing merely because a costing needs both. */
      packingMeasurement: {
        /* Never reset, never reused. 0 means nothing has been approved. */
        revision: { type: Number, min: 0, default: 0 },
        /* Grams, for the same reason the working record says so. */
        packedWeightGrams: { type: Number, min: 0, default: undefined },
        measuredBy: actorRef(),
        measuredAt: { type: Date },
        /* Approved by a second person, as every costable fact here is. */
        approvedBy: actorRef(),
        approvedAt: { type: Date },
        notes: { type: String, trim: true, default: "", maxlength: 500 },
      },

      /* ══ DOES ANYTHING GO OUTSIDE? — PRODUCTION'S ANSWER ══════════════
         `serviceRequirements` holds two departments' rows and an empty array
         answers neither of them. Production owns the outside-process half
         (`services/production/styleRoute.service.js` is the only door), so
         Production is asked whether this style is finished entirely in-house.

         `false` — with its reason — is what makes the outside-services family
         answerable. An empty list on its own never was and never will be: a
         style whose finishing nobody has considered looks identical to one
         that genuinely goes nowhere, and costing the second is right only by
         luck. */
      outsideProcessDecision: applicabilityDecision(),

      /* ══ IS THERE DEVELOPMENT OR TOOLING? — MERCHANDISING'S ANSWER ═════
         The other half of the same array, and the same argument. Merchandising
         states what one-time work a style needs — pattern, marker, screens,
         moulds, a machine setup — through
         `services/merchandising/styleDevelopment.service.js`, and answers here
         whether it needs any at all.

         Row-level exclusions are a different and narrower fact: "we considered
         screens and dropped them" lives on the row, with its own reason, and
         says nothing about whether the style needs development work. */
      developmentDecision: applicabilityDecision(),

      serviceRequirements: [
        {
          /* ── THIS ROW'S OWN IDENTITY ──────────────────────────────
             A style may legitimately need the same service twice — two
             different washes quoted separately — or the same charge type
             twice, screens for the body and screens for the sleeve. Keyed by
             what they NAME, those two rows are one row: they collide in the
             costing, and one of them is either merged away or counted
             twice. Neither is a thing anybody asked for.

             Minted server-side, preserved across edits and resubmissions, and
             never taken from the browser unless the style already carries it.
             The costing's line key is built from it. */
          rowId: { type: String, trim: true, maxlength: 40 },
          /* The company-scoped Service master. */
          serviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Service" },
          serviceCode: { type: String, trim: true, default: "" },
          serviceName: { type: String, trim: true, default: "" },
          /* ── RECURRING WORK, OR ONE-TIME SETUP ──────────────────
             The same Service master answers both, and they are completely
             different costs. A wash is bought per garment and scales with the
             run; making the screens to print with is bought ONCE and diluted
             across it. Costing them alike is a hundredfold error in one
             direction or the other on a 500-piece order.

             `OUTSIDE_PROCESS` is the default because every row written before
             this field existed is one — that is what the collection was for.
             `DEVELOPMENT_TOOLING` is a deliberate statement, and it forces
             the basis to the whole run. */
          purpose: {
            type: String,
            enum: ["OUTSIDE_PROCESS", "DEVELOPMENT_TOOLING"],
            default: "OUTSIDE_PROCESS",
          },
          /* ── AND WHERE A ONE-TIME CHARGE COMES FROM ───────────────
             `SUPPLIER_QUOTATION` when somebody outside does the work and has
             quoted for it; `COMPANY_POLICY` when the company does it itself
             and Finance has published a standing charge. Never both: two
             sources for one requirement is two answers, and nothing here
             chooses between them.

             Absent on an OUTSIDE_PROCESS row, which has only one source. */
          developmentSource: {
            type: String,
            enum: ["SUPPLIER_QUOTATION", "COMPANY_POLICY"],
            default: undefined,
          },
          /* Which configured charge, by its policy key. NOT an amount: R&D
             says what work is needed, Finance says what the company charges
             for it, and the engine reads the effective entry at calculation
             time. A figure typed here would be a second, undated answer. */
          developmentChargeKey: { type: String, trim: true, default: "", maxlength: 60 },
          /* What R&D asked for — "garment wash, enzyme, 2 cycles". The
             master's description is generic; this is about this style. */
          specification: { type: String, trim: true, default: "", maxlength: 2000 },
          /* ── MISSING IS MISSING HERE TOO ──────────────────────────────── */
          quantity: { type: Number, min: 0, default: undefined },
          /* How the supplier bills it — per piece, per kg, per lot. Text, for
             the reason `Service.billingUnit` gives: service billing units are
             not stock units and forcing them into the Unit Master corrupts
             both. */
          billingUnit: { type: String, trim: true, default: "" },
          basis: {
            type: String,
            enum: ["PER_GARMENT", "FIXED_PER_RUN"],
            default: "PER_GARMENT",
          },
          /* Which desk stated the requirement. The SAM beside it is R&D's;
             a finishing process is often Production's call, and a costing
             that cannot say which has nobody to ask when it is wrong. */
          owner: {
            type: String,
            enum: ["RND", "PRODUCTION"],
            default: "RND",
          },
          /* ── THE SAME TWO WORDS THE TECHNICAL SOURCE SPEAKS ──────────
             `BOM_PLANNED` is what a planned MATERIAL row is called
             (`technicalSource.EVIDENCE`), and a planned packaging or service
             row is the same kind of claim. A synonym here would mean the
             costing had to translate between two vocabularies for one fact,
             and the translation is where they stop agreeing.

             Defaulted to PLANNED, never MEASURED: "measured on the sample" is
             a claim the sample demonstrated this figure, and it is what lets
             a costing treat the row as verified. A row nobody answered for
             has demonstrated nothing. */
          /* -- NO DEFAULT, BECAUSE NOBODY ANSWERED --------------------
             `BOM_PLANNED` looked like the safe default and was still a
             claim the schema made on somebody's behalf. It also contradicted
             the write path, which REQUIRES the answer: a row could only
             acquire this value by never being asked, and at rest it read
             identically to a row where a person had chosen "planned".

             Missing stays missing. Costing reads an absent evidence AS
             planned — the weaker reading, applied where the consequence
             lives — and it can never become "measured" on its own. */
          evidence: {
            type: String,
            enum: ["SAMPLE_MEASURED", "BOM_PLANNED"],
            default: undefined,
          },
          included: { type: Boolean, default: true },
          excludedReason: { type: String, trim: true, default: "", maxlength: 500 },
          notes: { type: String, trim: true, default: "" },
        },
      ],

      // The operations (process steps + time) R&D actually ran making this
      // sample — raised alongside consumptionRawItems (24 Aug 2026, explicit
      // request), same shape as StockItem.operations so it can be synced
      // straight onto the product on approval. Deliberately NOT required —
      // R&D may not always time every step, and the raw-item evidence above
      // is what approval actually gates on.
      // The operations R&D actually ran making this sample — the proof of
      // what was done, and (since 2 Sept 2026) the source the product's own
      // operations and operation-wise cost are overwritten from when Sales
      // approves.
      //
      // The four costing fields are resolved SERVER-SIDE at submit, not typed
      // by R&D: the salary basis comes from the registered operation's own
      // department/designation and the rate from payroll — see
      // services/operationCosting.js. They are stored here rather than only
      // computed at approval so Sales can see what each operation costs on
      // the review screen, before deciding.
      operations: [
        {
          type: { type: String, trim: true },
          operationCode: { type: String, trim: true, default: "" },
          /* WHICH REGISTERED OPERATION THIS IS, BY IDENTITY.
             Additive and optional — every row written before this has none
             and still resolves by code. It exists because the register holds
             duplicate codes, and a stored id is the one match a duplicate
             cannot confuse. Stamped by services/operationCosting.js the first
             time a row resolves. */
          operationId: { type: mongoose.Schema.Types.ObjectId, ref: "Operation" },
          /* THE CODE THAT NAMED MORE THAN ONE REGISTERED OPERATION.
             Empty on every ordinary row. Set by services/operationCosting.js
             when a row's code matched several records and therefore resolved
             to none, so the costing preview can refuse BY CODE — "reconcile
             the duplicate" is unactionable without knowing which one. It is
             rewritten (and cleared) every time the operations are re-costed,
             so a reconciled duplicate stops blocking. */
          ambiguousOperationCode: { type: String, trim: true, default: "" },
          machine: { type: String, trim: true },
          machineType: { type: String, trim: true },
          minutes: { type: Number, min: 0, default: 0 },
          seconds: { type: Number, min: 0, default: 0 },
          totalSeconds: { type: Number, min: 0, default: 0 },
          salaryDept: { type: String, trim: true, default: "" },
          salaryDesig: { type: String, trim: true, default: "" },
          operatorSalary: { type: Number, min: 0, default: 0 },
          operatorCost: { type: Number, min: 0, default: 0 },
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
      // HOW MANY OF EACH VARIANT TO MAKE — SET BY SALES, READ BY R&D
      // (26 Aug 2026, explicit request: "Sales person will set the qty of the
      // corresponding product-variant wise... once after approved the techpack
      // (send by the r&d team) so that the r&d team can't set the qty as per
      // there own ok, only they can see the qty").
      //
      // This is new state, not a rename. Until now the order quantities were
      // never persisted anywhere on the style at all: R&D typed them into
      // local React state in the Quantities step of its production wizard and
      // POSTed them straight through to the CustomerRequest and the work
      // orders. Nothing recorded what was ordered, or who decided it — so
      // there was nothing for R&D to "only see", and no way for Sales to say
      // it first.
      //
      // Order quantity is a COMMERCIAL fact (what the customer is buying),
      // which is why it belongs to Sales, and why it is gated on the tech
      // sheet being approved: before that the spec can still change, so a
      // quantity against a variant list that may not survive is premature.
      orderVariants: [
        new mongoose.Schema(
          {
            // The StockItem variant this quantity is against. Not a ref: the
            // variants are subdocuments of StockItem, so this is their _id
            // within that document, resolved through the parent.
            variantId: { type: mongoose.Schema.Types.ObjectId, required: true },
            // Denormalised so the figure stays readable if the variant is
            // later renamed or removed from the register — same reasoning as
            // rawItemName on the materials picks above.
            variantLabel: { type: String, trim: true, default: "" },
            sku: { type: String, trim: true, default: "" },
            quantity: { type: Number, required: true, min: 0 },
          },
          { _id: false },
        ),
      ],
      orderVariantsSetAt: { type: Date, default: null },
      orderVariantsSetBy: actorRef(),
      // The audit trail R&D reads back — "customer created", "product
      // registered", "order request raised", "approved, N work orders
      // created" — exactly what the pipeline actually did, in order.
      log: [
        new mongoose.Schema(
          {
            kind: { type: String, trim: true }, note: { type: String, trim: true },
            at: { type: Date, default: Date.now }, by: actorRef(),
            /* WHICH WORK ORDER THIS ENTRY IS ABOUT, WHERE ONE APPLIES.
               Additive and optional — every existing entry has none and reads
               back exactly as before. It exists so an entry can be recognised
               as ALREADY WRITTEN: a cancellation that is replayed (the same
               call made twice, or a repair run over a historical record)
               must reconcile the style without appending a second account of
               the same event. Matching on the note's prose would work until
               somebody reworded it. */
            workOrderId: { type: mongoose.Schema.Types.ObjectId },
          },
          { _id: false },
        ),
      ],
    },

    // Shared timeline of every routing hop and gate decision (newest last).
    history: [historySchema],

    // Overall lifecycle of the style within sampling.
    status: { type: String, enum: SAMPLE_STYLE_STATUS_CODES, default: "active", index: true },

    // Set when the CUSTOMER rejects this SAMPLE — denormalized here so R&D's
    // existing style view/history renderer surfaces it with no new UI code
    // (26 Aug 2026). Cleared back to false only by a fresh customer-approval
    // decision recording approved:true for the same product.
    customerRejected: { type: Boolean, default: false },

    // The customer's verdict on the finished sample, asked as a chat-style
    // prompt in Style & Sample right after Sales' own internal approval
    // (26 Aug 2026, explicit request — replacing the earlier Cost &
    // Invoicing customer-approval step, which "is just handling only one
    // thing that is the customer approval" and moved here since the
    // decision belongs with the sample, before any pricing happens). Sales
    // records the customer's answer on their behalf — there is no customer
    // login here to do it themselves, same reasoning as costingLifecycle's
    // customerApprovalLog. Cache fields for quick reads; `log` is
    // append-only, mirroring that same pattern, so a changed mind never
    // erases what was said before.
    customerApproval: {
      approved: { type: Boolean, default: null },
      decidedAt: { type: Date, default: null },
      decidedBy: actorRef(),
      note: { type: String, trim: true, default: "" },
      log: [
        {
          approved: { type: Boolean, required: true },
          decidedAt: { type: Date, default: Date.now },
          decidedBy: actorRef(),
          note: { type: String, trim: true, default: "" },
          _id: false,
        },
      ],
      // The WhatsApp side of this same decision (26 Aug 2026, "the approval
      // request need to auto sent to that customer ok in whatsapp") — a
      // template message with Approve/Reject quick-reply buttons. messageId
      // is Meta's own wamid for the sent message; the webhook's incoming
      // button-tap payload carries that same id back as `context.id`, which
      // is how a reply gets matched to THIS style with no ambiguity even if
      // several approval requests are in flight for the same customer at
      // once. status tracks Meta's own delivery callbacks (sent → delivered
      // → read), separate from approved/decidedAt above, which only ever
      // reflects an actual button tap.
      whatsapp: {
        sentAt: { type: Date, default: null },
        phone: { type: String, trim: true, default: "" },
        messageId: { type: String, trim: true, default: "" },
        status: { type: String, enum: ["sent", "delivered", "read", "failed", null], default: null },
        statusUpdatedAt: { type: Date, default: null },
        error: { type: String, trim: true, default: "" },
      },
    },

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
//
// PARTIAL SINCE 31 Aug 2026, for the house-sample flow. The rule this encodes
// is "one style per product per JOURNEY" — which is meaningless without a
// journey. Left unfiltered, every in-house sample carries `journeyId: null`,
// Mongo indexes null as an ordinary value, and the SECOND house sample ever
// raised for "Polo Shirt" would be refused as a duplicate of the first.
//
// The filter covers exactly the rows the rule was written for, so uniqueness
// for journey-linked styles is unchanged. House samples are deliberately left
// UNCONSTRAINED: sampling the same garment twice — a year apart, or two
// colourways by two salespeople — is normal work, not a mistake to block.
//
// NOTE for deploys: Mongo will not re-spec an existing index in place. Run
// scripts/migrateSampleStyleIndex.js once after deploying, or the old
// non-partial index keeps rejecting the second house sample.
sampleStyleSchema.index(
  { journeyId: 1, productName: 1, variantKey: 1 },
  {
    unique: true,
    /* A rejected design that Sales replaces stays in history but no longer
       owns the live product-name slot. This lets the enquiry raise a new
       version with the same customer-facing name without deleting the old
       style or any of its rounds and decisions. */
    partialFilterExpression: { journeyId: { $type: "objectId" }, isActive: true },
  },
);

// Heal legacy routing values (an earlier build used brief/merchandiser) so old
// rows validate against the current enum instead of throwing on save.
sampleStyleSchema.pre("validate", function healStage() {
  if (this.stage && !SAMPLE_STYLE_STAGE_CODES.includes(this.stage)) this.stage = "materials";
});

module.exports = mongoose.models.SampleStyle || mongoose.model("SampleStyle", sampleStyleSchema);
