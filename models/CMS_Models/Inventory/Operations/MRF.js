// models/CMS_Models/Inventory/Operations/MRF.js

const mongoose = require("mongoose");

// ── Per-item return history entry ─────────────────────────────────────────────
const returnEntrySchema = new mongoose.Schema(
  {
    returnedQty: { type: Number, required: true, min: 0 },
    returnedAt: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, refPath: "recordedByModel", default: null },
    recordedByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
  },
  { _id: true }
);

// ── Product image attached by the requester ──────────────────────────────────
// Uploaded from the cowork side before the MRF is submitted, so the TL and the
// Store Person both see exactly which product is being asked for.
//
// `publicId` (Cloudinary) and `fileId` (Google Drive) are both kept, not one
// replacing the other: the cowork uploader moved from Cloudinary to Drive
// (components/features/mrf/MrfPhotoUploader.tsx), so an MRF raised before that
// switch still carries `publicId` and one raised after carries `fileId` —
// dropping the field this schema didn't yet have would have silently thrown
// away every new upload's ability to render reliably. Without `fileId`
// specifically, a freshly uploaded photo has only its bare `url` to render
// from, which 404s until Google's CDN indexes the file and has no fallback —
// exactly the "uploaded image is not showing" bug this was added to fix.
const productImageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true },
    publicId: { type: String, trim: true, default: "" },
    fileId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

// A single named value on an unmatched item ("Colour: Black, Navy") — mirrors
// RawItem's own attribute shape, so "register as new" can build variants the
// same way RawItemAddRequest's product.attributes used to.
const itemAttributeSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    values: [{ type: String, trim: true }],
  },
  { _id: false }
);

// ── The manager's decision on ONE line ───────────────────────────────────────
// Lines are approved and rejected one at a time, and an approved line goes to
// the Store at once — see services/mrfItemApproval.service.js, which is the only
// writer and the only reader that should interpret it.
//
// Absent on every line decided before item-wise approval existed: those lines'
// decisions are derived from the request-level tl* fields by `lineApproval`,
// and scripts/migrations/mrf-item-approval-backfill.js can write them down.
// Deliberately no defaults — "no record" and "awaiting" must stay distinguishable.
const lineApprovalSchema = new mongoose.Schema(
  {
    decision: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"] },
    // What the requester asked for. The line's own `requestedQty` becomes the
    // APPROVED quantity when a manager approves less, because that is the figure
    // every Store path issues, reserves and buys against.
    requestedQty: { type: Number, min: 0 },
    approvedQty: { type: Number, min: 0 },
    rejectedQty: { type: Number, min: 0 },
    reason: { type: String, trim: true, default: "" },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    decidedByName: { type: String, trim: true, default: "" },
    decidedById: { type: String, trim: true, default: "" },   // biometricId / cowork id
    decidedAt: { type: Date, default: null },
  },
  { _id: false }
);

// ── Per-item sub-doc ──────────────────────────────────────────────────────────
const mrfItemSchema = new mongoose.Schema(
  {
    // Unset until the Store matches this line to a catalogue item (or
    // registers a new one) — see itemStatus "UNMATCHED" below. `rawItemName`
    // is required either way: before matching it's the requester's own name
    // for the thing they want, after matching it's the catalogue name.
    rawItem: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    rawItemName: { type: String, trim: true, required: true },
    rawItemSku: { type: String, trim: true, default: "" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],

    // Only meaningful pre-match, on an UNMATCHED line — carried onto the new
    // RawItem if the Store registers it rather than matching it to an
    // existing one. Ignored once `rawItem` is set.
    category: { type: String, trim: true, default: "" },
    attributes: [itemAttributeSchema],

    // Requester-supplied product context (free text — the catalogue record is
    // the source of truth for name/SKU, this is what the requester *meant*).
    description: { type: String, trim: true, default: "" },
    specifications: { type: String, trim: true, default: "" },
    images: { type: [productImageSchema], default: [] },

    // `unit` is the unit the REQUESTER chose and is authoritative for every
    // quantity on this line (requestedQty / issuedQty / returnedQty /
    // availableQty). `baseUnit` is only the catalogue unit — conversion to it
    // happens at the stock-adjustment boundary and nowhere else.
    requestedQty: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, required: true },
    baseUnit: { type: String, trim: true, default: "" },
    issuedQty: { type: Number, default: 0, min: 0 },
    returnedQty: { type: Number, default: 0, min: 0 },
    consumedQty: { type: Number, default: 0, min: 0 },

    itemStatus: {
      type: String,
      enum: [
        // TL-approved but `rawItem` isn't resolved yet — the Store must
        // match it to an existing catalogue item or register it as new
        // before it can be issued. Never set before TL approval; a
        // not-yet-decided line (matched or not) is just "PENDING".
        "UNMATCHED",
        "PENDING", "APPROVED", "PARTIALLY_ISSUED", "ISSUED",
        "PARTIALLY_RETURNED", "RETURNED", "OVERDUE", "REJECTED", "UNFULFILLED",
      ],
      default: "PENDING",
    },

    // The manager's item-wise decision — see lineApprovalSchema above.
    approval: { type: lineApprovalSchema, default: undefined },

    // ── Store availability reporting ──────────────────────────────────────
    // Set by the Store Person after the TL approves. Independent of
    // itemStatus: availability is "what the store found", itemStatus is
    // "how much has actually moved".
    availability: {
      type: String,
      enum: ["UNREVIEWED", "AVAILABLE", "PARTIAL", "NOT_AVAILABLE", "ALTERNATIVE"],
      default: "UNREVIEWED",
    },
    availableQty: { type: Number, default: null },     // in `unit`, as reported by store
    availabilityNote: { type: String, trim: true, default: "" },
    availabilityUpdatedAt: { type: Date, default: null },
    availabilityUpdatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    availabilityUpdatedByName: { type: String, trim: true, default: "" },

    // Populated when availability === "ALTERNATIVE"
    alternativeItem: {
      rawItem: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
      name: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "" },
    },

    returnHistory: [returnEntrySchema],
    issueHistory: [{
      issuedQty: { type: Number, required: true },
      notes: { type: String, default: "" },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      recordedAt: { type: Date, default: Date.now },
    }],
    // Also doubles as the store's note when rejecting a still-UNMATCHED line.
    storeNotes: { type: String, trim: true, default: "" },

    // A Purchase Form was raised for THIS line (not stocked, being bought) —
    // set by the requisition route once the form is saved. Lets the Store
    // screen show it was already actioned instead of offering the same
    // buttons again with no memory of it.
    /* ── THE PART OF THIS LINE THAT HAS TO BE BOUGHT ──────────────────────
     * Set when Store decides the shelf cannot cover this line — wholly, or
     * only the balance after what they could issue.
     *
     * Kept on the LINE and not on the request because a request is routinely
     * mixed: three items on the shelf and a fourth that has to be ordered is
     * the ordinary case, and one decision for the whole document would force
     * the store to send the three away too. `requestedQty − issuedQty` is not
     * the same number — a line can be short without anybody having decided to
     * buy the difference, and that difference is exactly what this records.
     */
    buyQty: { type: Number, default: 0, min: 0 },

    purchaseFormRaised: { type: Boolean, default: false },
    purchaseRequisitionId: { type: mongoose.Schema.Types.ObjectId, ref: "Requisition", default: null },
    purchaseRequisitionNumber: { type: String, trim: true, default: "" },
    purchaseFormRaisedAt: { type: Date, default: null },

    /* ── WHO IS SUPPLYING THIS LINE ──────────────────────────────────────────
     * Two answers, and they route to completely different work:
     *
     *   COMPANY_FULFILLED — the factory provides it. Stock is checked, held and
     *                       issued; a shortfall becomes a purchase request. The
     *                       behaviour every existing line has.
     *   CUSTOMER_SUPPLIED — the customer is sending it. Nothing is reserved,
     *                       no spend request is raised and no purchase order can
     *                       ever exist; a customer-material expectation is
     *                       created instead and Store receives against it.
     *
     * ── WHY THE LINE AND NOT THE REQUEST ─────────────────────────────────────
     * One development request routinely contains both: the customer sends the
     * fabric and the factory buys the trims. A request-level answer would force
     * that into a lie, and the person raising it would have to split one piece
     * of work into two documents to tell the truth.
     *
     * Defaulted to COMPANY_FULFILLED so every line that exists today, and every
     * line raised by a screen that has not learned about this, keeps exactly the
     * behaviour it has.
     */
    supplySource: {
      type: String,
      enum: ["COMPANY_FULFILLED", "CUSTOMER_SUPPLIED"],
      default: "COMPANY_FULFILLED",
    },

    /* ── WHERE THIS LINE MUST COME FROM, WHEN SOMEBODY SAID ──────────────────
     * A request that names a warehouse is naming a REQUIREMENT, not a
     * preference: the material has to come from that site because that is where
     * the work is. The availability read and the manual reserve drawer have both
     * been passing `line.warehouseId` as their preferred warehouse since stock
     * reservations were built (see the `availabilityFor` call in mrfRoutes), but
     * the field was never declared — so mongoose dropped it on every write and
     * the preference was silently always null.
     *
     * Declaring it makes that existing code mean what it says, and lets
     * automatic reservation honour the requirement instead of letting an
     * alphabetically-earlier warehouse win. Null stays the ordinary case: most
     * requests do not care, and those allocate across every usable location.
     */
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── WHAT AUTOMATIC RESERVATION DID, AND WHY ──────────────────────────────
     * Approving a request now attempts to hold the stock for it, so the store
     * no longer chooses locations by hand for the ordinary case. This records
     * the attempt — on the LINE, because eligibility is a per-line fact and a
     * mixed request (two lines on the shelf, one to be bought) is the ordinary
     * case, not the exception.
     *
     * It exists separately from StockReservation because the interesting
     * outcomes create no reservation at all: a line that is SHORT, SKIPPED or
     * ATTENTION has nothing held, and "we looked and found nothing" has to be
     * distinguishable from "nobody has looked yet". `attemptedAt === null` is
     * that second fact, and it is what puts a pre-existing approved request in
     * the Needs-attention queue with a Try-automatic-reservation action rather
     * than silently claiming it is short.
     *
     * The reserved locations and quantities are NOT duplicated here — they live
     * on the StockReservation this attempt created, which is the one authority
     * for what is held. This says what happened and why. */
    autoReserve: {
      attemptedAt: { type: Date, default: null },
      outcome: {
        type: String,
        enum: ["RESERVED", "PARTIAL", "SHORT", "SKIPPED", "ATTENTION"],
        default: null,
      },
      /* A machine-readable cause, so the UI can word the recovery rather than
         echoing a sentence the server happened to compose. */
      reason: { type: String, trim: true, default: "" },
      /* The sentence a store user reads. */
      message: { type: String, trim: true, default: "" },
      /* In the requester's business unit, both of them — the reserved figure is
         a copy of the reservation's for queue reads that must not join. */
      reservedQty: { type: Number, default: 0, min: 0 },
      shortQty: { type: Number, default: 0, min: 0 },
      /* WHICH approval path triggered this, and who was acting. */
      trigger: { type: String, trim: true, default: "" },
      actorName: { type: String, trim: true, default: "" },
      /* Retries are expected (a failed attempt is re-runnable); the count keeps
         a repeatedly-failing line visible rather than looking freshly tried. */
      attempts: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: true }
);

// Remaining quantity still owed on this line, in the requester's unit.
mrfItemSchema.virtual("remainingQty").get(function () {
  if (["REJECTED", "UNFULFILLED"].includes(this.itemStatus)) return 0;
  // Still waiting on the manager — the Store owes nothing on it yet.
  if (this.approval && this.approval.decision === "PENDING") return 0;
  return Math.max(0, (this.requestedQty || 0) - (this.issuedQty || 0));
});

// ── Audit trail entry — powers "who did what, when" in the status UI ─────────
const statusEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, trim: true, required: true }, // CREATED | TL_APPROVED | ISSUED | …
    actorName: { type: String, trim: true, default: "" },
    actorRole: { type: String, trim: true, default: "" },  // employee | tl | store | system
    detail: { type: String, trim: true, default: "" },
    // Set on item-level events (ITEM_APPROVED / ITEM_REJECTED) so the trail can
    // say which line a decision was about. Absent on request-level events.
    itemId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    itemName: { type: String, trim: true, default: undefined },
  },
  { _id: false }
);

// ── Main MRF schema ───────────────────────────────────────────────────────────
const mrfSchema = new mongoose.Schema(
  {
    /* ── Chunk 1B: tenant ownership ─────────────────────────────────────────
       Optional, and deliberately so: every request raised before the boundary
       existed carries no company and is a legacy-global record. Absence never
       means "visible to everybody" — the list filters exclude it, and reading
       it needs the explicit legacy mode plus sp.legacy.read. Nothing here is
       backfilled; adopting a legacy request is a separate authorised action
       this chunk does not perform. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Numbering stays globally unique: MRF numbers are minted by the existing
       read-max+1 hook and every current one is unique across the database.
       Scoping this the way the PO number was scoped would need those numbers
       re-issued, which Chunk 1 forbids. The sequence allocator will take this
       over when material requests move to it — not in 1B. */
    /* Not `unique` here any more: uniqueness is company-scoped, declared as a
       compound index below. Mongoose never DROPS an index it stops declaring,
       so the legacy global `mrfNumber_1` survives on existing deployments and
       has to be retired deliberately — see
       scripts/migrations/store-purchase-mrf-number-index.js. */
    mrfNumber: { type: String, trim: true, required: true },

    // Who the materials are FOR
    requestedFor: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    requestedForName: { type: String, trim: true, default: "" },
    requestedForDept: { type: String, trim: true, default: "" },
    requestedForId: { type: String, trim: true, default: "" }, // employee ID / badge

    // How the MRF was created
    /* ── WHAT WORK THIS REQUEST IS FOR ───────────────────────────────────────
     * The requester is asked ONE thing — what the material is for — and the
     * system infers the rest. They are never asked which document type should be
     * created, whether a receipt is needed, or how the stock should be valued:
     * those are consequences of the answer, not further questions.
     *
     * `GENERAL` is the default and means what every request has meant until now.
     */
    purpose: {
      type: String,
      enum: ["GENERAL", "PRODUCTION", "DEVELOPMENT_SAMPLE", "TESTING"],
      default: "GENERAL",
    },

    /* ── THE WORK CONTEXT, AS A REFERENCE AND NEVER AS TEXT ──────────────────
     * At most ONE of these. A development for a sample, an execution file for a
     * confirmed order — and nothing for the ordinary request that is simply for
     * the factory.
     *
     * They are references because the customer's identity is resolved THROUGH
     * them on the server. A free-text order number could not be walked to an
     * owner, and a `customerId` accepted from the request would let whoever
     * fills the form decide whose fabric arrives — which is the one thing
     * ownership must never depend on. The MRF is the demand; Merchandising and
     * Sales are the authority for who the customer is.
     *
     * Stamped automatically when a request is raised from a development, so the
     * requester is not asked a question the screen they came from already knows
     * the answer to.
     */
    developmentFileId: { type: mongoose.Schema.Types.ObjectId, ref: "Development", default: null, index: true },
    executionFileId: { type: mongoose.Schema.Types.ObjectId, ref: "ExecutionFile", default: null, index: true },

    // SELF     → employee raised it themselves via Cowork
    // BYPASS   → store raised it on behalf of the employee
    creationMode: {
      type: String,
      enum: ["SELF", "BYPASS"],
      default: "SELF",
    },

    // Who actually created it (employee if SELF, ProjectManager if BYPASS)
    createdByRef: { type: mongoose.Schema.Types.ObjectId, refPath: "createdByModel", required: true },
    createdByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "Employee" },
    createdByName: { type: String, trim: true, default: "" },

    requestType: {
      type: String,
      enum: ["TIME_BASED", "USES_BASED"],
      required: true,
    },

    // Return deadline — TIME_BASED requests only. When the material must come
    // BACK to the store.
    deadline: { type: Date, default: null },

    // When the requester needs the material IN HAND. Applies to every request
    // type, and is the date the TL and the Store plan around — distinct from
    // `deadline`, which is about returning it afterwards.
    neededBy: { type: Date, default: null },

    reason: { type: String, trim: true, default: "" },

    // Priority
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },

    // Cost centre / project reference (optional, for tracking)
    costCentre: { type: String, trim: true, default: "" },
    projectReference: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: [
        "PENDING",           // awaiting Primary Manager / TL approval
        "APPROVED",          // TL approved — with the store now
        "PARTIALLY_ISSUED",
        "ISSUED",
        "PARTIALLY_RETURNED",
        "COMPLETED",
        "REJECTED",          // TL said no
        "UNFULFILLED",       // TL said yes, store cannot supply it
        "CANCELLED",
      ],
      default: "PENDING",
    },

    items: [mrfItemSchema],

    /* ── THE MANAGER'S DECISIONS, ROLLED UP ─────────────────────────────────
       Beside `status`, not inside it: `status` is the Store's lifecycle and a
       request is "with the Store" (APPROVED) as soon as ONE line is approved,
       while other lines may still be waiting. This says how far the manager has
       got — written by services/mrfItemApproval.service.js on every decision.
       Absent on requests decided before item-wise approval; readers fall back
       to `approvalStatusOf`, which derives the same answer. */
    approvalStatus: {
      type: String,
      enum: [
        "AWAITING_APPROVAL",    // nothing decided yet
        "PARTIALLY_PROCESSED",  // some lines decided, some still waiting
        "APPROVED",             // every line approved in full
        "PARTIALLY_APPROVED",   // all decided; some rejected or approved for less
        "REJECTED",             // every line rejected
        "CANCELLED",            // withdrawn while lines still waited
      ],
    },
    lastDecisionAt: { type: Date, default: null },

    // ═══════════════════════════════════════════════════════════════════════
    // Approval routing — Employee → Primary Manager/TL → Store
    // Resolved at creation time from the HR Employee record:
    //   requester.primaryManager.managerId → Employee → biometricId
    // The TL's approval queue is filtered on approverBiometricId, which is the
    // same id their cowork session carries (req.coworkUser.employeeId).
    // ═══════════════════════════════════════════════════════════════════════
    approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    approverBiometricId: { type: String, trim: true, default: "" },
    approverName: { type: String, trim: true, default: "" },

    // An HR record can carry both a biometricId and an identityId, and a
    // cowork session identifies itself with whichever one its
    // cowork_employees doc uses. Matching on a single field silently drops
    // the approval queue and every notification for anyone whose two ids
    // differ, so every id the approver could be logged in as is stored and
    // all of them are matched.
    approverAltIds: { type: [String], default: [] },

    // The requester's cowork session id — the id their notifications must be
    // addressed to. Kept separate from requestedForId, which is the HR badge
    // number shown on store screens; the two are usually equal but not always.
    requesterCoworkId: { type: String, trim: true, default: "" },

    // Why routing landed where it did — drives the contextual message shown to
    // the requester when no TL could be found.
    approverResolution: {
      type: String,
      enum: [
        "RESOLVED",
        "NO_MANAGER",             // employee has no primaryManager in HR
        "MANAGER_NOT_FOUND",      // managerId points at a missing Employee doc
        "MANAGER_INACTIVE",       // manager exists but is inactive/suspended
        "MANAGER_NO_BIOMETRIC",   // manager has no biometricId → cannot log in to cowork
        "SELF_MANAGED",           // requester is their own manager
      ],
      default: "RESOLVED",
    },

    // TL → Store, or straight to Store when no TL could be resolved.
    approvalRoute: { type: String, enum: ["TL", "AUTO_STORE"], default: "TL" },
    autoForwarded: { type: Boolean, default: false },
    autoForwardReason: { type: String, trim: true, default: "" },

    // ═══════════════════════════════════════════════════════════════════════
    // THE STORE'S FULFILMENT DECISION
    // ═══════════════════════════════════════════════════════════════════════
    // A department's request does not go to finance because it exists. It goes
    // to finance because MONEY HAS TO BE SPENT — and the only people who know
    // whether that is true are the ones who can see the shelf.
    //
    // So a TL-approved request stops here first. Store answers one question,
    // three ways:
    //
    //   issue_from_stock     we have it. Stock moves, nothing is bought, no
    //                        budget is touched and finance never hears about
    //                        it. Issuing something the company already owns
    //                        spends nothing.
    //   partial_buy_balance  we have some. What we have is issued; only the
    //                        shortfall is priced and sent on.
    //   buy_or_service       we have none of it, or it was never stock — a
    //                        repair, an AMC, a vendor purchase. Priced and
    //                        sent on whole.
    //
    // ── WHY THIS IS RECORDED AND NOT INFERRED ──────────────────────────────
    // "Nothing was issued" and "Store decided to buy it" look identical from
    // the quantities alone, and they are completely different facts: the first
    // is a request nobody has looked at, the second is a commitment somebody
    // made. Only one of them should reach finance.
    fulfilmentDecision: {
      type: String,
      enum: ["issue_from_stock", "partial_buy_balance", "buy_or_service"],
    },
    fulfilmentDecidedAt: { type: Date },
    fulfilmentDecidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    fulfilmentDecidedByName: { type: String, trim: true, default: "" },
    fulfilmentNote: { type: String, trim: true, default: "" },

    // What the balance became, when there was one. A reference rather than a
    // status copy: the spend request's own state is the live one, and keeping
    // a second copy here is how two screens start disagreeing about whether
    // finance has answered.
    spendRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "SpendRequest", default: null },
    spendRequestNumber: { type: String, trim: true, default: "" },

    // ── TL approval layer ──────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════
    // WHERE THIS CAME FROM, WHEN IT CAME OFF THE UNIFIED REQUESTS DESK
    // ═══════════════════════════════════════════════════════════════════════
    // A back-pointer to the IntakeRequest that was classified as store stock,
    // and the budget head the requester's manager had already chosen on it.
    //
    // ── WHY THE HEAD IS CARRIED ONTO SOMETHING THAT SPENDS NOTHING ─────────
    // Issuing stock the company already owns spends nothing, so this head is
    // normally never used — it is recorded and ignored, which is exactly what
    // the manager was told would happen when they were asked for it.
    //
    // It matters for the one case where that turns out to be wrong: the store
    // cannot supply it after all, and the ask has to be bought instead. The
    // decision the manager already made is then still here, and nobody has to
    // send the request back up the chain to have the same question answered
    // twice. Denormalised alongside `intakeRequestId` so the figures read even
    // if the originating request is later archived.
    //
    // Absent on every MRF raised through the material app directly, which is
    // the truth about those: nobody chose a head, because that flow never
    // asks for one.
    intakeRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "IntakeRequest" },
    intakeRequestNumber: { type: String, trim: true, default: "" },
    budgetLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    budgetLedgerName: { type: String, trim: true, default: "" },
    budgetCycleId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Budget" },
    budgetLineId: { type: mongoose.Schema.Types.ObjectId },
    budgetFinancialYear: { type: String, trim: true, default: "" },
    budgetDepartment: { type: String, trim: true, default: "" },
    /* ── THE PLANNED ITEM THE REQUEST NAMED ─────────────────────────────────
       Fulfilment context: the store is issuing against the row of the budget
       that was agreed, not just against an accounting head. Additive — absent
       on every MRF raised before planned items existed. */
    plannedItemKey: { type: String, trim: true, index: true },
    plannedItemName: { type: String, trim: true },
    plannedItemAmount: { type: Number, min: 0 },
    // A head the department ASKED for rather than one finance had approved.
    // Carried for the same reason, and flagged so nothing reads it as budgeted.
    budgetHeadRequested: { type: Boolean, default: false },

    tlApproved: { type: Boolean, default: false },
    tlApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    tlApprovedByName: { type: String, trim: true, default: "" },
    tlApprovedAt: { type: Date, default: null },
    tlRejected: { type: Boolean, default: false },
    tlRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    tlRejectedByName: { type: String, trim: true, default: "" },
    tlRejectedAt: { type: Date, default: null },
    tlRejectionNote: { type: String, trim: true, default: "" },

    // ── PM approval layer — RETAINED FOR HISTORY ONLY ─────────────────────
    // PM approval is no longer part of the flow (Employee → TL → Store).
    // These fields stay so pre-existing MRFs keep rendering their audit trail;
    // nothing writes to them any more.
    pmApproved: { type: Boolean, default: false },
    pmApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmApprovedAt: { type: Date, default: null },
    pmRejected: { type: Boolean, default: false },
    pmRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmRejectedAt: { type: Date, default: null },
    pmRejectionNote: { type: String, default: "" },

    // Store actions audit
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    rejectedAt: { type: Date, default: null },
    rejectionNote: { type: String, trim: true, default: "" },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, refPath: "cancelledByModel", default: null },
    cancelledByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
    cancelledAt: { type: Date, default: null },
    cancellationNote: { type: String, trim: true, default: "" },

    // Store closed it as impossible to supply (TL approved, but no stock and no
    // alternative). Distinct from REJECTED so the requester can tell the two apart.
    unfulfilledAt: { type: Date, default: null },
    unfulfilledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    unfulfilledByName: { type: String, trim: true, default: "" },
    unfulfilledReason: { type: String, trim: true, default: "" },

    // Set the first time the store touches availability — used to tell
    // "sitting in the store queue" apart from "store is working on it".
    storeReviewedAt: { type: Date, default: null },

    storeNotes: { type: String, trim: true, default: "" },

    // ── MRF-scoped chat (messages live in the MrfChatMessage collection) ──
    chatMessageCount: { type: Number, default: 0 },
    chatLastMessageAt: { type: Date, default: null },
    chatLastMessageBy: { type: String, trim: true, default: "" },

    // Statuses / actions in chronological order.
    statusHistory: { type: [statusEventSchema], default: [] },
  },
  { timestamps: true }
);

mrfSchema.index({ requestedFor: 1, status: 1, createdAt: -1 });
mrfSchema.index({ status: 1, createdAt: -1 });
mrfSchema.index({ requestType: 1, deadline: 1 });
mrfSchema.index({ creationMode: 1, createdAt: -1 });
// TL approval queue lookup — the hot path for the cowork approvals page.
mrfSchema.index({ approverBiometricId: 1, status: 1, createdAt: -1 });
mrfSchema.index({ approverAltIds: 1, status: 1 });

/* ── Company-scoped variants of the hot paths ────────────────────────────────
   Every list, queue and count now carries `companyId`, so the pre-existing
   indexes above would be prefix-mismatched for them. These lead with the
   company for the same reason the queries do. */
/* One number per company. Two companies may both hold MRF/2026-27/0001;
   within a company the number is the identity of the paper. */
mrfSchema.index({ companyId: 1, mrfNumber: 1 }, { unique: true });
mrfSchema.index({ companyId: 1, status: 1, createdAt: -1 });
mrfSchema.index({ companyId: 1, requestedFor: 1, status: 1, createdAt: -1 });
mrfSchema.index({ companyId: 1, approverBiometricId: 1, status: 1, createdAt: -1 });
mrfSchema.index({ companyId: 1, approverAltIds: 1, status: 1 });

// Append an audit event. Callers should use this rather than pushing directly
// so every entry carries a consistent shape.
mrfSchema.methods.logEvent = function ({ action, actorName = "", actorRole = "", detail = "", itemId, itemName }) {
  this.statusHistory.push({
    at: new Date(), action, actorName, actorRole, detail,
    ...(itemId ? { itemId } : {}),
    ...(itemName ? { itemName } : {}),
  });
  return this;
};

// Auto-generate MRF number
/**
 * A number for a request that arrived without one.
 *
 * ── WHY THIS NO LONGER NUMBERS COMPANY-OWNED REQUESTS ───────────────────────
 * It used to read the highest existing number and add one. Two requests
 * submitted in the same moment both read the same "last", both computed the
 * same next, and the second lost — either to the unique index, or, worse, to a
 * silent collision on a deployment where that index was missing. It also
 * scanned every company's numbers to decide one company's next, which is not a
 * per-company sequence at all.
 *
 * Company-owned requests are now numbered by SpDocumentSequence, which is a
 * single atomic `$inc` and cannot hand the same value to two callers. This
 * hook refuses to invent one for them: a missing number here means a creation
 * path skipped the allocator, and quietly papering over that would restore the
 * race the allocator exists to remove.
 *
 * The read-last fallback survives for company-less records only — legacy
 * fixtures and pre-boundary data, which no longer grow.
 */
/* ── AT MOST ONE WORK CONTEXT ────────────────────────────────────────────────
   A request cannot be for a development AND for a confirmed order: they are
   different pieces of work with different customers, and whichever one a reader
   looked at would be arbitrary. Neither is the ordinary case and stays allowed. */
mrfSchema.pre("validate", function enforceOneWorkContext(next) {
  if (this.developmentFileId && this.executionFileId) {
    return next(new Error(
      "A material request is for a development or for a confirmed order, never for both.",
    ));
  }
  return next();
});

mrfSchema.pre("validate", async function (next) {
  if (this.mrfNumber) return next();

  if (this.companyId) {
    return next(new Error(
      "A material request must be numbered through SpDocumentSequence " +
      "(documentSequence.allocate with MATERIAL_REQUEST) before it is saved.",
    ));
  }

  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `MRF-${yy}${mm}-`;
  const last = await mongoose
    .model("MRF")
    .findOne({ mrfNumber: { $regex: `^${prefix}` } })
    .sort({ mrfNumber: -1 })
    .lean();
  const seq = last ? parseInt(last.mrfNumber.slice(-4), 10) + 1 : 1;
  this.mrfNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  next();
});

module.exports = mongoose.models.MRF || mongoose.model("MRF", mrfSchema);
