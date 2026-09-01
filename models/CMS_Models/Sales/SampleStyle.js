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
      // The operations (process steps + time) R&D actually ran making this
      // sample — raised alongside consumptionRawItems (24 Aug 2026, explicit
      // request), same shape as StockItem.operations so it can be synced
      // straight onto the product on approval. Deliberately NOT required —
      // R&D may not always time every step, and the raw-item evidence above
      // is what approval actually gates on.
      operations: [
        {
          type: { type: String, trim: true },
          operationCode: { type: String, trim: true, default: "" },
          machine: { type: String, trim: true },
          machineType: { type: String, trim: true },
          minutes: { type: Number, min: 0, default: 0 },
          seconds: { type: Number, min: 0, default: 0 },
          totalSeconds: { type: Number, min: 0, default: 0 },
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
          { kind: { type: String, trim: true }, note: { type: String, trim: true }, at: { type: Date, default: Date.now }, by: actorRef() },
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
  { unique: true, partialFilterExpression: { journeyId: { $type: "objectId" } } },
);

// Heal legacy routing values (an earlier build used brief/merchandiser) so old
// rows validate against the current enum instead of throwing on save.
sampleStyleSchema.pre("validate", function healStage() {
  if (this.stage && !SAMPLE_STYLE_STAGE_CODES.includes(this.stage)) this.stage = "materials";
});

module.exports = mongoose.models.SampleStyle || mongoose.model("SampleStyle", sampleStyleSchema);
