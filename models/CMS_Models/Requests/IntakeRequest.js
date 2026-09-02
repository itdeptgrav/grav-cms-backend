// models/CMS_Models/Requests/IntakeRequest.js
//
// WHAT SOMEBODY ASKED FOR, BEFORE ANYBODY DECIDED HOW TO GET IT.
//
// ── WHY A THIRD COLLECTION AND NOT A FIELD ON ONE OF THE OTHER TWO ──────────
// MRF and SpendRequest are both FULFILMENT records. An MRF has a catalogue
// item, an availability check, an issue and a return. A SpendRequest has a
// vendor, a rate and a rupee total finance agreed to. Neither shape can hold a
// request whose kind is not yet known, because each of them already IS an
// answer to the question this record exists to defer.
//
// Overloading either would have put half its fields permanently empty on every
// row of the other kind, and every screen would then have had to ask what it
// was holding before it could read anything — which is the exact argument
// SpendRequest's own header makes for not being an MRF.
//
// ── WHAT THIS BECOMES ───────────────────────────────────────────────────────
// On classification this record spawns the real fulfilment document and keeps
// a pointer to it:
//
//   store stock        →  MRF          (mrfId)
//   buy / repair / AMC →  SpendRequest (spendRequestId)
//
// From that moment the LIVE state lives there, not here. This record keeps
// what it always was — the ask, who made it, who agreed the department needed
// it, and which door it went out of. Copying the fulfilment status back here
// would be a second copy of a fact, and the two would eventually disagree.
//
// ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
// Money. A line may carry an estimated rate, because a requester often knows
// roughly what a thing costs and finance is better off seeing the guess than
// nothing — but nothing here is a price the company agreed to, no total is
// authoritative, and no budget is touched. That happens on the spend request
// this becomes, where it always happened.
//
// An account head. The requester is not asked for one, because they do not
// know whether their ask costs the company anything. It is chosen at
// classification, by the people who know it does.

const mongoose = require("mongoose");

const intake = require("../../../services/requestIntake.service");

/**
 * A picture of the thing.
 *
 * The SAME shape as MRF's own `productImageSchema`, deliberately: a store-issue
 * classification hands these straight to the MRF it becomes, and two shapes
 * that have to be translated on the way are two shapes that drift.
 *
 * Uploaded by the browser straight to Cloudinary — the pattern every other
 * image in this CMS already uses (see lib/cloudinaryUpload.js) — so what
 * arrives here is a URL and an id, never bytes.
 */
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true },
    publicId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/**
 * One line of the ask.
 *
 * Deliberately looser than either fulfilment shape. An MRF line needs a
 * catalogue item and a SpendRequest line needs a rate; at intake the requester
 * has neither and should not be made to invent them. What they do have is a
 * name, a quantity and a unit.
 *
 * ── AND A CATALOGUE ITEM, WHEN THEY RECOGNISE ONE ───────────────────────────
 * `rawItem` is set when the requester picked the thing out of the store's
 * catalogue rather than describing it. It is NOT a classification and must not
 * be read as one: the catalogue holding an item says nothing about whether the
 * store has any today, and deciding that is still the store's job.
 *
 * What it does buy is real. A line that names a catalogue item arrives at the
 * store already matched — issuable rather than sitting in the UNMATCHED queue
 * waiting for somebody to work out which "bond paper" was meant. A line without
 * one is not a failure and never was: something the store has never stocked is
 * still a thing to ask for.
 *
 * `rate` is a hint, not a commitment — "the last one was about four thousand".
 * It travels to whoever ends up buying it and is re-decided there.
 *
 * ── AND PICTURES, FOR THE THINGS THAT HAVE NO NAME YET ──────────────────────
 * `images` are the requester's own reference photos, and they matter most
 * exactly where the catalogue cannot help: a part with no name anybody agrees
 * on, a fitting somebody is holding, the broken thing itself. A photo of it
 * settles in one look what three rounds of chat would not.
 *
 * A line that named a catalogue item usually needs none — the store registered
 * a picture when they registered the item, and the screens show that one. The
 * field is still allowed there, because "the one I have looks like this and it
 * is not what the catalogue shows" is a real thing to say.
 *
 * ── WHY THERE IS NO VENDOR HERE ─────────────────────────────────────────────
 * There was, briefly. It is a fulfilment decision made by the people who
 * negotiate with vendors, and it is already asked at classification — asking
 * the requester too meant the same answer collected twice from the person less
 * qualified to give it, plus a second row of inputs on every line of the form.
 */
const lineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /* Unset when the requester described the thing instead of picking it. */
    rawItem: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    rawItemSku: { type: String, trim: true, default: "" },

/* ── FUTURE ITEM-WISE BUDGET ATTRIBUTION (INERT) ────────────────────────────
   Where this line's own budget head will live once a request can charge
   several unrelated items to several approved lines.

   NOTHING READS THIS YET, and that is deliberate. The request-level
   `ledgerId` / `budgetLineId` remain the single source of truth for
   commitments, budget checks and actuals until a later chunk migrates the
   workflow deliberately. Two authorities for "which budget is this?" running
   at once is exactly the ambiguity this field exists to remove, so it is
   added now — additively, so no existing document needs migrating — and left
   unpopulated.

   `status` is not derivable from `budgetLedgerId` alone. A null head means
   "unresolved" when nobody has looked and "manual_selection_required" once a
   human has been asked and has not answered, and the difference decides
   whether a screen shows a prompt or a warning.

   Vocabulary is shared with services/itemBudgetHead.service.js:
   `resolutionSource` takes exactly its `source` values. */
    budgetAllocation: {
      type: new mongoose.Schema(
        {
          budgetLedgerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Acc_Ledger",
            default: null,
          },
          budgetLedgerName: { type: String, trim: true, default: "" },
          resolutionSource: {
            type: String,
            enum: ["item_override", "category_mapping", "unresolved"],
            default: "unresolved",
          },
          resolutionCategory: { type: String, trim: true, default: "" },
          selectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
          selectedByName: { type: String, trim: true, default: "" },
          selectedAt: { type: Date, default: null },
          status: {
            type: String,
            enum: ["resolved", "unresolved", "manual_selection_required"],
            default: "unresolved",
          },
        },
        { _id: false },
      ),
      /* Absent, not defaulted. Every request written before this chunk has no
         allocation at all, and a default would manufacture an "unresolved"
         decision on thousands of historical lines that nobody ever made. */
      default: undefined,
    },

    /* The unit the STORE keeps it in, which is not always the unit the
       requester asked in. Carried so the MRF this may become has both. */
    baseUnit: { type: String, trim: true, default: "" },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    /* Optional, and an ESTIMATE. The spend request this may become carries the
       agreed rate; this is what the requester thought it would be. */
    rate: { type: Number, min: 0 },
    note: { type: String, trim: true },
    images: { type: [imageSchema], default: [] },

    /* ── THE LINE THE STORE COULD NOT GET ───────────────────────────────────
       Per line, because a request is not one decision. A box of blades may be
       on the shelf, a dock may have to be bought, and the discontinued part
       may be gettable from nobody at all — and the first two should not be
       held up by the third.

       The whole request is only returned when EVERY line fails; short of
       that, the fulfillable lines go ahead and these are recorded here so the
       requester can see exactly which ones did not, and why, instead of
       finding a short delivery and having to ask. */
    unfulfilled: { type: Boolean, default: false },
    unfulfilledReason: { type: String, trim: true },
    unfulfilledAt: { type: Date },
    unfulfilledByName: { type: String, trim: true },
  },
  { _id: true },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    byName: { type: String, trim: true },
    action: { type: String, trim: true },
    note: { type: String, trim: true },
  },
  { _id: false },
);

const intakeRequestSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, unique: true, index: true },

    /* Composed from the lines when the requester did not write one. For a
       one-line request the title and the item name are the same sentence, and
       demanding both is demanding it twice. */
    title: { type: String, required: true, trim: true },
    purpose: { type: String, required: true, trim: true },

    /* ── THE ONE CLASSIFICATION THE REQUESTER CAN MAKE ────────────────────
       A thing, or something done. They know which; they do not know whether
       the store has it or which head finance books it against, and this is
       deliberately not either of those questions. Two values only — see
       requestIntake.service for why there is no third. */
    requestType: { type: String, enum: intake.REQUEST_TYPES, default: "PRODUCT" },

    /* Who asked. `requestedById` is the biometricId, which is the identity
       approver routing keys on everywhere else in this app. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    requestedByName: { type: String, trim: true },
    requestedById: { type: String, trim: true, index: true },
    department: { type: String, trim: true },

    neededBy: { type: Date },
    priority: { type: String, enum: intake.PRIORITIES, default: "NORMAL" },
    note: { type: String, trim: true },

    items: {
      type: [lineSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "A request needs at least one line.",
      },
    },
    /* The sum of quantity × estimated rate, over the lines that carry one.
       Recomputed server-side, and labelled an estimate everywhere it appears —
       it is what the requester guessed, not what anything costs. */
    estimatedTotal: { type: Number, default: 0, min: 0 },
    /* False the moment any line has no rate: a total that silently treats a
       missing rate as zero is a number somebody will read as complete. */
    estimateComplete: { type: Boolean, default: false },

    /* ── THE ONE THING THE REQUESTER IS ASKED ABOUT FULFILMENT ─────────────
       Not "is this a recurring spend" — a checkbox saying this comes back. It
       is here rather than at classification because the requester is the only
       one who knows whether they will need it again next month, and it changes
       what finance is being asked to agree to. The SCHEDULE is captured later,
       by whoever classifies it, because "quarterly from April" is a commercial
       term and not something the person who needs the thing decides. */
    repeats: { type: Boolean, default: false },

    status: { type: String, enum: intake.STATUSES, default: intake.PENDING_TL, index: true },

    /* The manager this waits on. Resolved from the org chart at submit — the
       same resolver MRF uses — and left blank when the chart cannot answer, in
       which case it goes straight to the fulfilment desk rather than parking
       against somebody who does not exist. */
    approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approverName: { type: String, trim: true },
    approverBiometricId: { type: String, trim: true, index: true },

    /* ── WHO IT WAITS ON, AND WHY THAT PERSON ─────────────────────────────
     * Every id the approver could be signed in as. An HR record can carry
     * both a `biometricId` and an `identityId`, and a CoWork session presents
     * whichever one its own doc uses — matching on a single field silently
     * empties the approval queue for anybody whose two ids differ. The same
     * field, for the same reason, as MRF's `approverAltIds`. */
    approverAltIds: { type: [String], default: [] },

    /* WHY routing landed where it did. `RESOLVED` is the ordinary case; every
     * other value means no manager could be named, and the request took the
     * fallback route instead of waiting for a TL step nobody could take.
     *
     * Stored rather than re-derived, because HR changes and the reason a
     * request skipped the TL step in August is a fact about August. */
    approverResolution: {
      type: String,
      enum: [
        "RESOLVED",
        "NO_MANAGER",
        "MANAGER_NOT_FOUND",
        "MANAGER_INACTIVE",
        "MANAGER_NO_BIOMETRIC",
        "SELF_MANAGED",
      ],
      default: "RESOLVED",
    },
    /* The sentence the desk shows when the chain broke. Composed once, on the
     * server, so the requester, the fulfiller and finance read the same words
     * about the same row. Empty on a resolved request. */
    approverResolutionNote: { type: String, trim: true, default: "" },

    /* ── THE DEPARTMENT'S APPROVAL CHAIN ──────────────────────────────────
     * A request walks UP the reporting line and stops at the edge of the
     * requester's own department:
     *
     *     Soumya (IT) → Pramod (IT) → Rakesh (IT) ─╫─ CEO (not IT)
     *
     * Rakesh is the most senior person in IT, so the chain ends with him, and
     * his OWN request has nobody above him inside the department — it skips
     * approval entirely and goes straight to Store.
     *
     * ── WHY IT IS FROZEN HERE AND NOT DERIVED ─────────────────────────────
     * Built once, when the request is raised, and written down. HR
     * reorganises; a request in flight must not be re-routed underneath the
     * people already looking at it, and an approval is a record of who was
     * actually asked — not a function of today's org chart. The same reason
     * the single approver stopped being re-derived.
     *
     * ── AND WHY EVERY STEP CARRIES ITS OWN STATE ──────────────────────────
     * "Pramod approved, Rakesh has not" is the question the requester, the
     * chain and the store desk are all asking, and an index alone cannot
     * answer it after a rejection. Absent is not a state: every step is
     * written `pending` and moves from there.
     *
     * EMPTY on every request raised before this existed, and on one whose
     * requester is the most senior person in their department. Those two look
     * identical here and are told apart by `chainStop`. */
    approvalChain: [
      {
        _id: false,
        order: { type: Number, required: true },
        employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        name: { type: String, trim: true },
        /* Both ids a session could present — see approvalChain.service. */
        loginId: { type: String, trim: true },
        altIds: { type: [String], default: [] },
        department: { type: String, trim: true },
        designation: { type: String, trim: true },
        status: {
          type: String,
          enum: ["pending", "approved", "rejected"],
          default: "pending",
        },
        approvedAt: { type: Date },
        rejectedAt: { type: Date },
        note: { type: String, trim: true },
      },
    ],

    /* Whose turn it is, as a position in the chain above. */
    currentApproverIndex: { type: Number, default: 0 },

    /* WHY the chain ended where it did — see approvalChain.STOP. "Nobody
     * approved this" and "there was nobody in the department to ask" look
     * identical from an empty chain and are completely different facts, and
     * only one of them is worth telling somebody about. */
    chainStop: { type: String, trim: true },
    chainStopReason: { type: String, trim: true },

    tlApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    tlApprovedByName: { type: String, trim: true },
    tlApprovedAt: { type: Date },

    /* ── THE BUDGET HEAD, CHOSEN BY THE MANAGER ───────────────────────────
       Not by the requester, who does not know it, and no longer by Store, who
       knows the shelf rather than the department's envelope. The manager is
       already reading the request to decide whether the department needs it;
       they are the one person on the chain who knows both.
     
       Set at approval and read at classification, so a spend request carries a
       head somebody with budget authority actually chose. Absent on every
       request approved before this rule existed — those render as "Budget head
       not set" rather than being migrated into a guess. */
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    /* A SNAPSHOT of the name, not a substitute for the id: a head renamed next
       year must not silently restate what this request was for. */
    ledgerName: { type: String, trim: true },
    budgetLineId: { type: mongoose.Schema.Types.ObjectId },
    budgetFinancialYear: { type: String, trim: true },

    /* ── THE REST OF THE BUDGET CONTEXT ───────────────────────────────────
     * WHICH CYCLE the line belongs to. `budgetLineId` alone identifies a line
     * only if you already know which budget document holds it — an id inside
     * an `items[]` array is not addressable on its own. Store & Purchase, and
     * anybody reading this later, need both to point at the allocation.
     *
     * WHICH DEPARTMENT is being charged: the REQUESTER's, taken off the
     * matched allocation line rather than off the request, because the
     * registry canonicalises spellings and the two can differ ("logistics" on
     * the request, "Logistics" on the budget). The one on the line is the one
     * the money is filed under.
     *
     * AND WHETHER IT MATCHED — the same vocabulary SpendRequest already uses,
     * so a request and the spend request it becomes describe their budget
     * position in one language. `matched` is the ordinary case;
     * `no_budget_line` is what an unbudgeted-head ask records, and it is not a
     * failure — it is a real request finance has to see.
     *
     * All three are additive. Absent on every request approved before this
     * existed, which reads as "not recorded" rather than as a wrong value. */
    budgetCycleId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Budget" },
    budgetDepartment: { type: String, trim: true },
    /* ── THE PLANNED ITEM INSIDE THE HEAD ───────────────────────────────────
       The head is the accounting bucket; this is the row finance actually
       agreed to. Spending against the bucket alone lets somebody buy the thing
       finance refused out of the money approved for something else.

       `plannedItemKey` is the working row's `rowId` where it has one, and a
       positional key where the row predates rowId — which is why the NAME is
       stored beside it rather than looked up on read. A key that later
       resolves to a differently-named row is refused, instead of the request
       quietly reattaching to whatever moved into that slot.

       `plannedItemAmount` is what was approved for that row when the request
       was raised. A snapshot, like `budgetSnapshot` — the plan can be revised,
       and the figure the requester was answering has to survive that.

       All three absent on every request raised before this, which is what
       "No planned item linked" means on those rows. */
    plannedItemKey: { type: String, trim: true, index: true },
    plannedItemName: { type: String, trim: true },
    plannedItemAmount: { type: Number, min: 0 },

    budgetMatchStatus: {
      type: String,
      enum: ["matched", "no_budget_line"],
    },
    /* What the head looked like when the manager chose it — the numbers they
       were actually looking at, which are not the numbers today. */
    budgetSnapshot: {
      approved: { type: Number },
      committed: { type: Number },
      actual: { type: Number },
      available: { type: Number },
    },

    /* ── OR A HEAD THAT DOES NOT EXIST YET ────────────────────────────────
       The escape hatch, and the reason requiring a head is not a trap. A
       department with nothing approved — or a genuinely new kind of spend —
       may ask for one in words. It reaches finance marked as a request FOR a
       head rather than dressed up as a budgeted ask against an arbitrary
       ledger. */
    unbudgetedHeadRequest: { type: Boolean, default: false },
    requestedHeadName: { type: String, trim: true },
    requestedHeadReason: { type: String, trim: true },

    /* ── HOW IT IS BEING FULFILLED, AND WHO SAID SO ────────────────────────
       `fulfilmentKind` is one of requestIntake.KIND_IDS. Recorded with the
       person and the moment because "who decided this was a purchase rather
       than something the store had" is the question asked when a request took
       three weeks. */
    fulfilmentKind: { type: String, enum: intake.KIND_IDS },
    classifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    classifiedByName: { type: String, trim: true },
    classifiedAt: { type: Date },
    classificationNote: { type: String, trim: true },

    /* ── WHAT IT BECAME ───────────────────────────────────────────────────
       Exactly one of these is set, and only after classification. The live
       state of the request is read from whichever it is. */
    mrfId: { type: mongoose.Schema.Types.ObjectId, ref: "MRF", index: true },
    mrfNumber: { type: String, trim: true },
    spendRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "SpendRequest", index: true },
    spendRequestNumber: { type: String, trim: true },

    submittedAt: { type: Date },
    decidedAt: { type: Date },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    decidedByName: { type: String, trim: true },
    decisionNote: { type: String, trim: true },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

intakeRequestSchema.index({ requestedBy: 1, createdAt: -1 });
intakeRequestSchema.index({ status: 1, createdAt: -1 });
/* The approvals queue's own read: what is addressed to me and still waiting. */
intakeRequestSchema.index({ approverBiometricId: 1, status: 1, createdAt: 1 });
intakeRequestSchema.index({ approverAltIds: 1, status: 1 });

/* REQ-2608-0001. The same shape as MRF-…… and SPR-…… so the three read as
   siblings on one desk, and a different prefix so no screen can mistake the
   ask for either of the things it may become. */
intakeRequestSchema.pre("validate", async function (next) {
  if (!this.requestNumber) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `REQ-${yy}${mm}-`;
    const last = await mongoose
      .model("IntakeRequest")
      .findOne({ requestNumber: { $regex: `^${prefix}` } })
      .sort({ requestNumber: -1 })
      .lean();
    const seq = last ? parseInt(last.requestNumber.slice(-4), 10) + 1 : 1;
    this.requestNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  }
  next();
});

module.exports =
  mongoose.models.IntakeRequest || mongoose.model("IntakeRequest", intakeRequestSchema);
