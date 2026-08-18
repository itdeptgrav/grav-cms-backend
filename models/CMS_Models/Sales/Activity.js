// models/CMS_Models/Sales/Activity.js
//
// CRMActivity — the account-level interaction timeline: notes, calls, email
// logs, meetings, site visits, tasks, and follow-ups. Distinct from the
// LEGACY activities embedded in a Lead (models/CMS_Models/Sales/Lead.js
// `activities[]`) — this is the unified, shared timeline Step 01 requires,
// and Lead Chunk 1 extends it to also cover a Lead that has no Account yet
// (see ADR-002: a Lead may exist before an Account does). "Overdue" is NEVER
// stored: it is derived from status=planned + a past dueDate, exposed as the
// `isOverdue` virtual and computed in task queries.
//
// OWNING CONTEXT (Lead Chunk 1). Exactly one of `accountId` / `leadId` was
// required before this chunk (`accountId` only); now an Activity belongs to
// EITHER an Account OR a pre-Account Lead — never neither. `accountId` moved
// from a required field to a pre-validate invariant covering both fields, so
// existing Account-owned activities (which always pass accountId) are
// completely unaffected; only a new Lead-owned activity can now omit it.
//
// `links[]` is the forward-compatible hook for later modules — an activity can
// reference an opportunity, style, quotation, order, shipment, or claim once
// those exist, without adding nullable columns to tables that don't exist yet.
const mongoose = require("mongoose");
const {
  ACTIVITY_TYPE_CODES,
  ACTIVITY_STATUS_CODES,
  ACTIVITY_PRIORITY_CODES,
  ACTIVITY_VISIBILITY_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const activitySchema = new mongoose.Schema(
  {
    activityId: { type: String, unique: true },
    // Required at the DOCUMENT level (see the pre-validate hook below), not
    // the field level, since a pre-Account Lead activity legitimately has no
    // accountId. Every existing caller (routes/CMS_Routes/Sales/activities.js)
    // still enforces accountId itself before creating, so its behaviour is
    // unchanged.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", index: true },
    // Pre-Account Lead ownership (Lead Chunk 1 / ADR-002). Set instead of
    // accountId for a Lead-timeline activity; never set alongside a Lead's
    // resulting Account before Chunk 5's conversion bridge exists.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    // Journey TAG, not an owner. An activity logged from a Sales Journey stage
    // is still Account-owned (accountId set) — journeyRef/stage only record which
    // journey and stage it was logged from, so the journey's action panel can
    // show just its own timeline while the activity still rolls up on the
    // Account. Never a third owner: the exactly-one-of(accountId, leadId)
    // invariant below is untouched.
    //
    // It stores the journey's human REFERENCE (SJ-YYYY-NNNN), not a Mongo _id —
    // that reference is the journey's stable identifier everywhere (routes, the
    // adapter DTO's `id`), and the frontend never sees the raw _id.
    journeyRef: { type: String, trim: true, index: true },
    stage: { type: String, trim: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    activityType: { type: String, enum: ACTIVITY_TYPE_CODES, required: true },
    subject: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    activityDate: { type: Date, default: Date.now },
    dueDate: { type: Date }, // for tasks / follow-ups
    status: { type: String, enum: ACTIVITY_STATUS_CODES, default: "planned" },
    priority: { type: String, enum: ACTIVITY_PRIORITY_CODES, default: "normal" },

    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDepartment" },
    ownerName: { type: String, trim: true },
    // Free text at the SCHEMA level on purpose — this model is shared with
    // Account/Journey activities (routes/CMS_Routes/Sales/activities.js,
    // components/sales/crm/journey/*), which are untouched by this chunk and
    // still use a free-text Outcome field. The Lead correction chunk's
    // structured vocabulary (ACTIVITY_OUTCOME_CODES, "No Answer"/"Replied /
    // Connected"/"Meeting Completed"/"Other") is enforced only where a Lead's
    // own routes create an Activity — see routes/CMS_Routes/Sales/leads.js.
    outcome: { type: String, trim: true },
    nextActionDate: { type: Date },
    // Interaction metadata (Lead command-centre chunk). Free text at the SCHEMA
    // level for the same reason `outcome` is — this model is shared with
    // Account/Journey activities that never set them; the Lead-scoped route
    // (routes/CMS_Routes/Sales/leads.js) validates them against
    // ACTIVITY_CHANNEL_CODES / ACTIVITY_DIRECTION_CODES on write. `channel` is
    // the messaging medium (WhatsApp / SMS / Other); `direction` is inbound vs
    // outbound; `contactName` is who the interaction was with (a pre-Account
    // Lead has no CRMContact to reference via contactId).
    channel: { type: String, trim: true },
    direction: { type: String, trim: true },
    contactName: { type: String, trim: true },
    visibility: { type: String, enum: ACTIVITY_VISIBILITY_CODES, default: "internal" },

    // Forward links to later modules (module code + record id). Empty for now.
    links: [
      {
        module: { type: String, trim: true },
        recordId: { type: mongoose.Schema.Types.ObjectId },
        _id: false,
      },
    ],

    completedAt: { type: Date },
    completedBy: actorRef(),

    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

activitySchema.index({ accountId: 1, activityDate: -1 });
activitySchema.index({ leadId: 1, activityDate: -1 });
activitySchema.index({ ownerId: 1, dueDate: 1, status: 1 });
activitySchema.index({ contactId: 1 });

// Exactly one owning context: never neither (orphan), never both (an
// Activity that is simultaneously Account- and Lead-owned has no single
// timeline it belongs to, and would let a Lead's pre-conversion history leak
// onto an Account's timeline before Chunk 5's conversion bridge exists).
// Document-level (pre-validate), not a field-level `required`, because which
// one is required depends on the other.
activitySchema.pre("validate", function (next) {
  const hasAccount = Boolean(this.accountId);
  const hasLead = Boolean(this.leadId);
  if (!hasAccount && !hasLead) {
    return next(new Error("A CRM Activity must belong to either an Account (accountId) or a Lead (leadId)."));
  }
  if (hasAccount && hasLead) {
    return next(new Error("A CRM Activity cannot belong to both an Account and a Lead at the same time."));
  }
  next();
});

// Derived, never stored — a planned item whose due date has passed.
activitySchema.virtual("isOverdue").get(function () {
  return this.status === "planned" && this.dueDate instanceof Date && this.dueDate.getTime() < Date.now();
});

activitySchema.pre("save", async function (next) {
  if (!this.activityId) {
    const count = await mongoose.model("CRMActivity").countDocuments();
    this.activityId = `ACT-${String(count + 1).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.model("CRMActivity", activitySchema);
