// models/CMS_Models/Requests/SpendRequest.js
//
// A DEPARTMENT ASKING TO SPEND MONEY OUTSIDE.
//
// ── WHY THIS IS NOT AN MRF ──────────────────────────────────────────────────
// An MRF asks the store to issue stock it already holds: it has a raw item, a
// catalogue unit, an availability check, an issue and a return. None of that
// exists for a service. Getting the compressor repaired has a vendor, a quote
// and a rupee amount, and no stock to reserve, issue or take back.
//
// Overloading MRF with a second shape would have put half its fields
// permanently empty on every row of one kind and the other half empty on the
// other — and every screen, aggregation and lifecycle rule would then have had
// to ask which kind it was holding before it could read anything. A separate
// collection is the smaller change: MRF stays exactly what it is.
//
// ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
// Any link to a budget. A request carries an account head so it can later be
// counted against one, but nothing here commits, reserves or consumes budget,
// and no field claims to. Spending against a budget is a separate decision
// with its own approvals, and a half-built version of it recorded in this
// collection would be a number somebody trusts.
//
// Recurring GENERATION, for the same reason. A subscription is not one
// purchase; it is a commitment that repeats, and minting the next one on a
// schedule is a promise this collection is not entitled to make on its own.
// The TERMS are recorded — see the `recurring` field — because raising it once
// and writing down "quarterly from April" is strictly better than raising it
// twelve times and writing down nothing.

const mongoose = require("mongoose");

/**
 * What is being asked for. Not a spend category — that is the account head.
 *
 *   PRODUCT   a physical thing to buy: a laptop, a spare part, a chair
 *   SERVICE   work, access or usage bought from a vendor: a repair, an AMC,
 *             a subscription, a consultant, hosting
 *
 * ── WHY `SOFTWARE` IS NOT A THIRD ONE ───────────────────────────────────────
 * It never described a different KIND of ask. A software subscription is work
 * and access bought from a vendor, which is what SERVICE already means, so the
 * third option only asked people to draw a line that does not exist — is a
 * hosted design tool software, or a service? Two categories that a person can
 * separate without thinking beat three that invite a pause.
 *
 * ── AND WHY IT IS STILL IN THE ENUM ─────────────────────────────────────────
 * Rows written before this exist and must still load. The value is accepted by
 * the SCHEMA and refused by the ROUTE, so nothing new can be created with it
 * while everything already saved reads normally — as Service, which is what it
 * always was. No migration, no rewritten history.
 */
const REQUEST_TYPES = ["PRODUCT", "SERVICE", "SOFTWARE"];

/** The two a request may be RAISED as. */
const CURRENT_REQUEST_TYPES = ["PRODUCT", "SERVICE"];

/** What each is called on screen. A legacy row reads as what it always was. */
const REQUEST_TYPE_LABEL = {
  PRODUCT: "Product",
  SERVICE: "Service",
  SOFTWARE: "Service",
};

/* ── THE CHAIN, AS ONE FIELD ────────────────────────────────────────────────
 * employee raises → TL → Finance → Store & Purchase raises the PO/WO.
 *
 * One field rather than a status plus a separate stage, because two fields
 * that can disagree eventually do, and then no screen knows which to believe.
 *
 * `submitted` is what the first version of this router wrote, before the chain
 * existed. Kept in the enum so a row saved then still loads; read as "waiting
 * on the TL". See services/spendApproval.service.js. */
const STATUSES = [
  "draft",
  "submitted",
  "pending_tl",
  "pending_finance",
  /* The requester checks what Store actually found before anybody approves
     money against it — see spendApproval's note on why. */
  "awaiting_requester_confirmation",
  "requester_revision_requested",
  "requester_confirmed",
  "approved",
  "ordered",
  /* Finance sent it back over the FIGURE, not the need. Alive, and waiting on
     the requester to revise it, move it to another approved head, ask for
     more budget, or withdraw. See spendApproval.BUDGET_EXCEPTION. */
  "budget_exception",
  "rejected",
  "cancelled",
];

const PRIORITIES = ["NORMAL", "HIGH", "URGENT"];

/**
 * One line of the ask.
 *
 * `amount` is stored, and it is ALWAYS quantity × rate — recomputed on the way
 * in, never taken from the client. It is stored rather than derived on read
 * because the rate of a thing bought in March is a fact about that purchase,
 * and a total recomputed later from a rate somebody has since edited would
 * quietly restate what was approved.
 */
const lineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /* Every line says why it is needed. The request's purpose covers the ask;
       this covers the line — "the old one failed inspection" beside a figure
       that is otherwise two numbers multiplied together. */
    whyNeeded: { type: String, required: true, trim: true },
    /* ── WHAT THE REQUESTER ASKED FOR, IN THEIR OWN WORDS ───────────────────
       `name` is what STORE proposes to buy it as — the name a vendor and
       finance will read. This is the phrase the requester actually typed.
       Both, because the confirmation screen's whole question is "is what Store
       found the thing you meant", and that is unanswerable if only one of the
       two survives. */
    requestedName: { type: String, trim: true },

    /* What the store wrote down about the thing being bought — size, grade,
       model, the detail a vendor needs to quote the right item. Distinct from
       `whyNeeded`, which is the reason rather than the thing. Carried on the
       line because it belongs to the item, not to the request. */
    spec: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, required: true, trim: true },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },

    /* ── THE QUOTE THIS LINE WAS PRICED FROM ────────────────────────────────
       Commercial terms used to live only on the request, on the reasoning that
       Store had one quote from one vendor. That is wrong for anything with
       more than one line: a laptop and an annual service contract are two
       vendors, two tax rates and two delivery dates, and holding one of each
       for the whole request meant the second line's terms were simply lost.

       All optional. Every request written before these has them empty and
       falls back to the request-level fields, which is why those stay. */
    /* ── WHO THE REQUESTER SUGGESTED, IF ANYBODY ────────────────────────────
       Information, never an instruction. A requester who has been quoted by
       somebody is worth listening to; they are not the person who negotiates
       terms, so Store may use them or use anybody else. Carried so finance can
       see BOTH — "they asked for Sharma and Store went to Verma" is a question
       worth being able to ask, and it is unanswerable if only one name
       survives. */
    suggestedVendorName: { type: String, trim: true },
    /* Why Store went elsewhere. Only meaningful when the two names differ. */
    vendorNote: { type: String, trim: true },

    vendorName: { type: String, trim: true },
    /* The supplier master this name was picked from, when it was picked rather
       than typed. The NAME is what every screen and purchase order renders and
       stays authoritative — a supplier can be renamed, and the quote was given
       under the name on it. This is the join for reporting: four spellings of
       one supplier add up when they share an id. Absent on a genuinely new
       supplier, which is ordinary. */
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    gstin: { type: String, trim: true, uppercase: true },
    quoteRef: { type: String, trim: true },
    gstPercent: { type: Number, min: 0, max: 100 },
    /* Stored rather than recomputed on read: the rate can be edited later, and
       a total that silently re-derives is a total that stops matching the
       invoice somebody approved. */
    taxAmount: { type: Number, min: 0 },
    lineTotal: { type: Number, min: 0 },
    expectedDeliveryDate: { type: Date },

    /* ── CONFIRMED, LINE BY LINE ────────────────────────────────────────────
       One line of a quote can be exactly right while another is the wrong
       model from the wrong vendor. Confirming the whole request as one would
       force the requester to reject a line they are happy with in order to
       object to one they are not. */
    /* ── THE QUOTE, AS A FILE ───────────────────────────────────────────────
       Per line, because the vendor is per line: a request buying a laptop from
       one supplier and an AMC from another has two quotes, and one shared
       attachment list cannot say which is which.

       Metadata only — the bytes live in the same private Drive folder the
       document-level attachments use, and are streamed back through the same
       authenticated route. Never a link anybody with the URL can open.

       This is what makes the requester's confirmation worth answering: "Sharma
       Systems, ₹50,000" is a claim, and the quote PDF beside it is the thing
       that lets somebody agree to it. */
    attachments: [
      {
        _id: false,
        fileId: { type: String, required: true, trim: true },
        fileName: { type: String, trim: true },
        fileType: { type: String, trim: true },
        fileSize: { type: Number, min: 0 },
        /* quote | photo | spec | other */
        label: { type: String, trim: true, default: "quote" },
        uploadedAt: { type: Date, default: Date.now },
        uploadedByName: { type: String, trim: true },
      },
    ],

    confirmedAt: { type: Date },
    confirmedByName: { type: String, trim: true },
    revisionRequested: { type: Boolean, default: false },
    revisionReason: { type: String, trim: true },
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

const spendRequestSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, unique: true, index: true },

    title: { type: String, required: true, trim: true },
    requestType: { type: String, enum: REQUEST_TYPES, required: true },

    /* Who asked. `requestedById` is the biometricId, which is what approver
       routing keys on everywhere else in this app — see mrfApprover.service. */
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    requestedByName: { type: String, trim: true },
    requestedById: { type: String, trim: true, index: true },
    department: { type: String, trim: true },

    /* The head this will be charged to, named at the time of asking so finance
       is not guessing later. The company is carried with it because a ledger id
       means nothing without one. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", index: true },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    /* A SNAPSHOT of the name, not a substitute for the id: a head renamed next
       year must not silently restate what this request was for. */
    ledgerName: { type: String, trim: true },

    /* Optional for now — a request often starts before a vendor is chosen, and
       demanding one here would only teach people to type "TBD". */
    vendorName: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true },
    /* The vendor's own reference for the quote this request is built from.
       Finance is approving a specific quoted figure; when the invoice arrives
       three weeks later, this is what ties the two together without anybody
       having to remember the conversation. Optional — plenty of small
       purchases are quoted over the phone and never get a number. */
    quoteRef: { type: String, trim: true },

    /* ── THE BUDGET EXCEPTION, AS FINANCE RAISED IT ─────────────────────────
       Recorded rather than recomputed. The head moves — other requests commit
       against it every day — and a requester opening this next week has to see
       the overrun finance actually objected to, not what the arithmetic says
       today. */
    budgetExceptionAt: { type: Date },
    budgetExceptionBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    budgetExceptionByName: { type: String, trim: true },
    budgetExceptionNote: { type: String, trim: true },
    budgetExceptionOverrun: { type: Number, min: 0 },
    budgetExceptionAvailable: { type: Number },

    /* ── AND THE REQUESTER'S ANSWER TO IT ───────────────────────────────────
       `additional_budget` is the only answer that leaves a record here:
       revising edits the request and withdrawing cancels it, but asking for
       more money is a new question for finance and has to carry its reason. */
    budgetAskReason: { type: String, trim: true },
    budgetAskAt: { type: Date },

    /* ── THE REQUESTER'S CONFIRMATION ───────────────────────────────────────
       Stamped when every purchasable line has been confirmed. Finance refuses
       to approve without it, which is the whole point: the figure may fit the
       budget perfectly and still be the wrong item. */
    /* ── AND THE ORDER RAISED FROM IT ───────────────────────────────────────
       Both directions, so neither screen has to search the other collection to
       answer "has this been ordered yet". Set once, when the order is raised;
       an approval that has one cannot be ordered again. */
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder" },
    purchaseOrderNumber: { type: String, trim: true },

    requesterConfirmedAt: { type: Date },
    requesterConfirmedByName: { type: String, trim: true },
    /* What the requester said when they sent it back. Cleared when they
       later confirm, so a stale objection never sits under a confirmed
       quote. */
    revisionRequestedAt: { type: Date },
    revisionNote: { type: String, trim: true },

    neededBy: { type: Date },
    priority: { type: String, enum: PRIORITIES, default: "NORMAL" },
    purpose: { type: String, required: true, trim: true },

    items: {
      type: [lineSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "A request needs at least one line.",
      },
    },
    /* The sum of the lines, recomputed server-side on every write. */
    totalAmount: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: STATUSES, default: "submitted", index: true },

    /* The TL this waits on. Resolved from the org chart at submit — the same
       resolver MRF uses — and left blank when the chart cannot answer, in
       which case the request starts at finance rather than parking against
       somebody who does not exist. */
    approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approverName: { type: String, trim: true },
    approverBiometricId: { type: String, trim: true },

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

    /* ── WHO SAID YES, AND WHEN ──────────────────────────────────────────
     * Two approvals, recorded separately rather than as one "approvedBy":
     * they are different questions asked by different people, and a single
     * field would lose which of them a given name answered. */
    tlApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    tlApprovedByName: { type: String, trim: true },
    tlApprovedAt: { type: Date },

    financeApprovedBy: { type: String, trim: true }, // the books' user email
    financeApprovedByName: { type: String, trim: true },
    financeApprovedAt: { type: Date },

    /* ── WHICH BUDGET LINE THIS BELONGS TO ────────────────────────────────
     * Worked out when the request is raised and stored with it, rather than
     * recomputed whenever somebody looks. Two reasons: the answer depends on
     * which cycle was in force at the time, and finance approving in October
     * needs to see the head this was raised against in August — not the one it
     * would match today.
     *
     * `budgetMatchStatus` is never a refusal. A request against an unbudgeted
     * head is a real request, and hiding or blocking it is how spending moves
     * to a channel nobody is measuring. */
    budgetCycleId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Budget" },
    budgetLineId: { type: mongoose.Schema.Types.ObjectId },
    budgetFinancialYear: { type: String, trim: true },
    budgetDepartment: { type: String, trim: true },
    /* ── THE PLANNED ITEM THE REQUEST NAMED ─────────────────────────────────
       Carried forward from the intake request so the thing finance approves,
       and the thing Store fulfils, are both tied to the row of the budget that
       was actually agreed — not just to the accounting head. Additive: absent
       on everything raised before planned items existed. */
    plannedItemKey: { type: String, trim: true, index: true },
    plannedItemName: { type: String, trim: true },
    plannedItemAmount: { type: Number, min: 0 },
    budgetAccountHeadId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    budgetMatchStatus: {
      type: String,
      enum: ["matched", "no_budget_line", "wrong_department", "inactive_cycle"],
      default: "no_budget_line",
      index: true,
    },
    /* What the head looked like when this was raised. A record of the numbers
       the approver actually saw, which is not the same as the numbers today. */
    budgetSnapshot: {
      approved: { type: Number },
      committedBefore: { type: Number },
      actual: { type: Number },
      availableBefore: { type: Number },
      requested: { type: Number },
      availableAfter: { type: Number },
    },

    /* ── QUOTE, PROFORMA, PROOF ───────────────────────────────────────────
     * METADATA ONLY. The bytes live in the private Drive folder the voucher
     * attachments already use, and are streamed back through an authenticated
     * route — never a link anybody with the URL can open.
     *
     * Optional at submission, deliberately. A repair often needs approving
     * before a vendor will quote it, and demanding a quote up front would only
     * teach people to attach something meaningless. Finance may ask for proof
     * before approving, and the review card says when that is expected.
     *
     * `uploadedBy` is stamped from the session, never from the body: a client
     * that could name the uploader could name somebody else. */
    attachments: [
      {
        _id: false,
        fileId: { type: String, required: true, trim: true },
        fileName: { type: String, trim: true },
        fileType: { type: String, trim: true },
        fileSize: { type: Number, min: 0 },
        /* quote | proforma | invoice | screenshot | other */
        label: { type: String, trim: true, default: "other" },
        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        uploadedByName: { type: String, trim: true },
      },
    ],

    /* ── A HEAD THE DEPARTMENT DOES NOT HAVE ──────────────────────────────
     * The escape hatch. A department picks from the heads finance approved for
     * them, which is a short list and usually the right one — but a genuinely
     * new kind of spend has no line yet, and refusing it outright would send
     * that spending to a channel nobody is measuring.
     *
     * So they may ask for one, in words: what they want to call it and why.
     * Deliberately NOT a free choice from the chart of accounts — picking an
     * arbitrary ledger looks like a budgeted request and is not one. This is
     * a request FOR a head, and it reaches finance marked as such. */
    unbudgetedHeadRequest: { type: Boolean, default: false },
    requestedHeadName: { type: String, trim: true },
    requestedHeadReason: { type: String, trim: true },

    /* ── HOW FINANCE APPROVED IT ──────────────────────────────────────────
     * Finance may always approve. What changes is what the approval is ON THE
     * RECORD as: within the envelope, past it, or against no envelope at all.
     * A blanket "approved" would lose the only distinction that matters when
     * somebody later asks how the year went over. */
    budgetApprovalKind: {
      type: String,
      enum: ["within_budget", "over_budget", "unbudgeted"],
    },

    /* The promise this became. Set once; see budgetCommitment.service. */
    commitmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_BudgetCommitment" },
    commitmentStatus: { type: String, trim: true },

    /* ── WHAT THE STORE PRICED IT AT ──────────────────────────────────────
     * Filled by Store & Purchase when they decide a request cannot come off
     * the shelf and has to be bought. The requester never sees these fields
     * and is never asked for them — they do not know the vendor, the rate or
     * the tax treatment, and asking produced guesses that finance then had to
     * undo. Store owns pricing and sourcing; the department owns the need.
     *
     * ── WHY GST SITS ON THE REQUEST AND NOT THE LINE ──────────────────────
     * Because it is a quote, not an invoice. What Store has at this point is
     * one rate from one vendor at one tax rate; a per-line rate would invite
     * a precision nobody has yet, and the voucher that eventually posts is
     * where the real per-line tax is decided. `gstPercent` here exists so
     * finance is agreeing to the amount that will actually leave the bank.
     */
    gstPercent: { type: Number, min: 0, max: 100, default: 0 },
    /* Net of tax — the sum of the lines, which is what `totalAmount` holds —
     * and what tax adds on top of it. Stored rather than derived on read for
     * the reason every other figure here is: a total recomputed later from a
     * rate somebody has since edited would quietly restate what was approved. */
    taxAmount: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0, default: 0 },

    /* When Store expects it to arrive. NOT the same as `neededBy`, which is
     * the requester's own date: one is a promise, the other is a hope, and
     * collapsing them loses the gap finance is often deciding about. */
    expectedDeliveryDate: { type: Date },

    /* ── WHO PRICED IT, AND WHEN ──────────────────────────────────────────
     * The gate finance approval sits behind. A request with no `pricedAt` is
     * a request nobody has costed, and approving one would be finance
     * agreeing to a number that does not exist yet.
     *
     * Absent on requests raised straight through the purchase door, where the
     * raiser supplies rates themselves — those are priced at creation, and
     * the route stamps this then. */
    pricedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    pricedByName: { type: String, trim: true },
    pricedAt: { type: Date },

    /* ── THE MATERIAL REQUEST THIS IS THE BALANCE OF ──────────────────────
     * Set when Store could not fill an MRF from stock and sent the shortfall
     * to be bought. Both halves stay live: the MRF keeps whatever was issued
     * and this carries only what has to be purchased, so neither document
     * pretends to be the whole story.
     *
     * Absent on every other spend request, which is most of them. */
    sourceMrfId: { type: mongoose.Schema.Types.ObjectId, ref: "MRF", index: true },
    sourceMrfNumber: { type: String, trim: true },

    /* ── WHERE THIS CAME FROM ────────────────────────────────────────────
     * Set when the request was not typed into the purchase form directly but
     * arrived through the unified intake and was classified as something that
     * has to be bought. A pointer back to the ask, so "why was this raised"
     * has an answer that is not somebody's memory.
     *
     * Absent on every request raised the older way, which is the truth about
     * those: nobody classified them, because the form asked the requester to. */
    intakeRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "IntakeRequest", index: true },

    /* ── SOMETHING THAT COMES BACK ────────────────────────────────────────
     * CAPTURED, NOT GENERATED. This records what finance agreed to when they
     * agreed to a subscription, an AMC or a retainer: how often it recurs and
     * from when. It does NOT create the next one, reserve twelve months of
     * budget, or post anything on a schedule.
     *
     * That restraint is the point. The header of this file says recurring is
     * absent because "a subscription is not one purchase; it is a commitment
     * that repeats" — and that is still true of GENERATING them. What changed
     * is that raising it once and recording the term is strictly better than
     * raising it twelve times and recording nothing, whereas a half-built
     * scheduler would be a number somebody trusts. When the recurring engine
     * is built it reads these fields; until then they are a record of terms. */
    recurring: {
      isRecurring: { type: Boolean, default: false },
      /* MONTHLY | QUARTERLY | HALF_YEARLY | YEARLY — see requestIntake.service */
      frequency: { type: String, trim: true, uppercase: true },
      startsOn: { type: Date },
      /* Open-ended is normal for an AMC; a blank end is not a missing value. */
      endsOn: { type: Date },
      note: { type: String, trim: true },
    },

    /* ── THE ORDER STORE RAISED ──────────────────────────────────────────
     * A reference, not a link: a service is a work order and a product is a
     * purchase order, they live in different collections, and this request is
     * the thing that authorised either. Store types what they raised so the
     * requester can see it happened. */
    orderReference: { type: String, trim: true },
    orderedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    orderedByName: { type: String, trim: true },
    orderedAt: { type: Date },

    submittedAt: { type: Date },
    decidedAt: { type: Date },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    decidedByName: { type: String, trim: true },
    decisionNote: { type: String, trim: true },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

spendRequestSchema.index({ requestedBy: 1, createdAt: -1 });
spendRequestSchema.index({ status: 1, createdAt: -1 });
/* The approvals queue's own read: what is addressed to me and still waiting. */
spendRequestSchema.index({ approverBiometricId: 1, status: 1, createdAt: 1 });
spendRequestSchema.index({ approverAltIds: 1, status: 1 });

/* SPR-2608-0001. Same shape as the MRF number so the two read as siblings, and
   a different prefix so no screen can mistake one for the other. */
spendRequestSchema.pre("validate", async function (next) {
  if (!this.requestNumber) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `SPR-${yy}${mm}-`;
    const last = await mongoose
      .model("SpendRequest")
      .findOne({ requestNumber: { $regex: `^${prefix}` } })
      .sort({ requestNumber: -1 })
      .lean();
    const seq = last ? parseInt(last.requestNumber.slice(-4), 10) + 1 : 1;
    this.requestNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  }
  next();
});

module.exports =
  mongoose.models.SpendRequest || mongoose.model("SpendRequest", spendRequestSchema);
module.exports.REQUEST_TYPES = REQUEST_TYPES;
module.exports.CURRENT_REQUEST_TYPES = CURRENT_REQUEST_TYPES;
module.exports.REQUEST_TYPE_LABEL = REQUEST_TYPE_LABEL;
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
