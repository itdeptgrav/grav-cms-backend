// models/CMS_Models/Merchandising/MerchandisingEvent.js
//
// MERCHANDISING'S APPEND-ONLY AUDIT TRAIL, AND ITS OUTBOX.
//
// ── TWO COLLECTIONS, ONE FILE, AND WHY THEY ARE NOT ONE ─────────────────────
// The frozen architecture separates AUDIT HISTORY (what happened, for a
// person reading the record's past) from INTEGRATION DELIVERY (what another
// app must eventually learn, with delivery state). Folding them together
// makes every audit row carry delivery bookkeeping it does not have, or every
// integration event pretend to be pure history while something mutates its
// status — the exact "mutable array as audit source" failure this replaces.
//
// AUDIT — `merchandising_audit_events`. Append-only. Nothing updates a row,
// nothing deletes one, and the service exposes no function that could. Every
// event names the company, the record, its revision where it has one, the
// actor (or the authoritative source app, for Sales-driven events), the
// action, the time, the reason where one was required, the correlation
// identity, and the previous/resulting state where a state moved.
//
// OUTBOX — `merchandising_outbox_events`. App-local, durable, written in the
// SAME transaction as the change it announces, so a committed decision and
// its cross-app announcement cannot exist without each other. Nothing
// consumes it yet — delivery is a later milestone's worker — and until then
// rows simply accumulate as PENDING, which is exactly what a durable outbox
// is for. It is not a global event bus and must not grow into one.
//
// No event in either collection may claim production readiness, PPC release,
// a buyer approval authored by Merchandising, task completion, or an
// acknowledgement from a receiving app. Those are other apps' statements.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Every action the audit trail can record. Closed list, on purpose. */
const AUDIT_ACTIONS = Object.freeze([
  "HANDOVER_ISSUED",
  "HANDOVER_SUPERSEDED",
  "HANDOVER_CANCELLED",
  "CLARIFICATION_REQUESTED",
  "HANDOVER_ACCEPTED",
  "FILE_CREATED",
  "FILE_UPDATED",
  "FILE_ASSIGNED",
  "FILE_HELD",
  "FILE_RESUMED",
  "FILE_CLOSED",
  "FILE_REOPENED",
  "SALES_CANCELLATION_MIRRORED",
  /* ── M3: the file's own selections ──────────────────────────────────
     One vocabulary for both families — Materials & Trims and Packaging
     share a lifecycle, so a history reader learns one set of words and
     the family is a field rather than a second set of actions. */
  "SELECTION_DRAFT_CREATED",
  "SELECTION_ROW_ADDED",
  "SELECTION_ROW_UPDATED",
  "SELECTION_ROW_WITHDRAWN",
  "SELECTION_INSTRUCTIONS_UPDATED",
  "SELECTION_SUBMITTED",
  "SELECTION_CHANGES_REQUESTED",
  "SELECTION_APPROVED",
  "SELECTION_SUPERSEDED",
  "SELECTION_LEGACY_ADOPTED",
  /* ── M4: the approval register ──────────────────────────────────────
     Merchandising creates and changes REQUIREMENTS. `APPROVAL_SOURCE_OBSERVED`
     is the one event about somebody else's decision, and it records what was
     SEEN and when — never a decision taken here. */
  "APPROVAL_REQUIREMENT_CREATED",
  "APPROVAL_REQUIREMENT_UPDATED",
  "APPROVAL_SOURCE_OBSERVED",
  /* ── M5: Time & Action ──────────────────────────────────────────────
     A plan's whole life. `TNA_MILESTONE_COMPLETION_OBSERVED` is the one
     action about somebody else's work, and it records what was SEEN. */
  "TNA_PLAN_CREATED",
  "TNA_BASELINE_APPROVED",
  "TNA_BASELINE_REVISED",
  "TNA_FORECAST_UPDATED",
  "TNA_MILESTONE_BLOCKED",
  "TNA_MILESTONE_UNBLOCKED",
  "TNA_RESCHEDULE_REQUESTED",
  "TNA_RESCHEDULE_APPROVED",
  "TNA_RESCHEDULE_REJECTED",
  "TNA_MILESTONE_COMPLETED",
  "TNA_MILESTONE_COMPLETION_OBSERVED",
  "TNA_MILESTONE_REOPENED",
  "TNA_PLAN_COMPLETED",
  "TNA_PLAN_CANCELLED",
  /* ── M6: department status, the pack, and the downstream decision ────
     `DEPARTMENT_STATUS_OBSERVED` is deliberately the same shape of word as
     M4's `APPROVAL_SOURCE_OBSERVED`: passive, about a READING, and never
     suggesting Merchandising decided anything.

     The two `..._BY_PPC` actions are recorded in Merchandising's history
     because they happened to a Merchandising record — but the actor on them
     is PPC's, and the sentence says so. */
  "DEPARTMENT_STATUS_OBSERVED",
  "PACK_DRAFTED",
  "PACK_REFRESHED",
  "PACK_SUBMITTED",
  "PACK_WITHDRAWN",
  "PACK_SUPERSEDED",
  "PACK_CANCELLED",
  "PACK_ACCEPTED_BY_PPC",
  /* ── M8: the Pre-Production Meeting ──────────────────────────────────
     Coordination evidence, not a readiness verdict. `PPM_SOURCE_MOVED` is
     the one action about somebody ELSE's record: it says a source an issued
     minute referenced has since changed, which is a fact about this file and
     never a change to the minute. */
  "PPM_DRAFTED",
  "PPM_UPDATED",
  "PPM_CONDUCTED",
  "PPM_ISSUED",
  "PPM_CANCELLED",
  "PPM_SUPERSEDED",
  "PPM_SOURCE_MOVED",
  "PACK_CLARIFICATION_REQUESTED_BY_PPC",
  /* ── M7: change control, and the enterprise operations ────────────────
     `CHANGE_OBSERVED` and `CHANGE_ACK_RECEIVED` are passive and about a
     READING — the same shape as M4's approval observation and M6's department
     status. Nobody in Merchandising decided either. */
  "CHANGE_OBSERVED",
  "CHANGE_ACKNOWLEDGED",
  "CHANGE_CLARIFICATION_REQUESTED",
  "CHANGE_IMPACT_ASSESSED",
  "CHANGE_IMPACT_COORDINATED",
  "CHANGE_IMPACT_CLOSED",
  "CHANGE_ACK_RECEIVED",
  "BULK_APPLIED",
  "CONFIGURATION_CHANGED",
  "EXPORT_GENERATED",
  "RECORD_ARCHIVED",
  /* ── PRE-ORDER DEVELOPMENT ────────────────────────────────────────────
     Merchandising's work BEFORE an order exists. `DEVELOPMENT_OBSERVED` is
     passive — Sales asked; Merchandising recorded that the request arrived. */
  "DEVELOPMENT_OBSERVED",
  "DEVELOPMENT_ACCEPTED",
  "DEVELOPMENT_CLARIFICATION_REQUESTED",
  "DEVELOPMENT_FILE_CREATED",
  "DEVELOPMENT_FILE_ASSIGNED",
  "DEVELOPMENT_FILE_HELD",
  "DEVELOPMENT_FILE_RESUMED",
  "DEVELOPMENT_FILE_CLOSED",
  "DEVELOPMENT_BOM_DRAFTED",
  "DEVELOPMENT_BOM_ROW_ADDED",
  "DEVELOPMENT_BOM_ROW_UPDATED",
  "DEVELOPMENT_BOM_ROW_REMOVED",
  "DEVELOPMENT_BOM_ADOPTED",
  "DEVELOPMENT_BOM_SUBMITTED",
  "DEVELOPMENT_BOM_APPROVED",
  "DEVELOPMENT_BOM_CHANGES_REQUESTED",
  "DEVELOPMENT_BOM_SUPERSEDED",
  /* Sales releases; Merchandising records that they did. */
  "DEVELOPMENT_RELEASED_BY_SALES",
  "DEVELOPMENT_BOM_ADOPTED_INTO_ORDER",
]);

/**
 * The cross-app facts Merchandising announces.
 *
 * The two handover decisions keep the names they were written with. The M3
 * selection events use the dotted form the Sales handover outbox established,
 * which reads as `<app>.<record>.<what happened>` and does not need a legend.
 */
const OUTBOX_KIND = Object.freeze({
  HANDOVER_ACCEPTED: "HANDOVER_ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",

  MATERIAL_TRIM_SUBMITTED: "merchandising.material_trim_card.submitted",
  MATERIAL_TRIM_APPROVED: "merchandising.material_trim_card.approved",
  MATERIAL_TRIM_SUPERSEDED: "merchandising.material_trim_card.superseded",

  PACKAGING_SUBMITTED: "merchandising.packaging_spec.submitted",
  PACKAGING_APPROVED: "merchandising.packaging_spec.approved",
  PACKAGING_SUPERSEDED: "merchandising.packaging_spec.superseded",

  DEVELOPMENT_SUBMITTED: "merchandising.development_requirements.submitted",
  DEVELOPMENT_APPROVED: "merchandising.development_requirements.approved",
  DEVELOPMENT_SUPERSEDED: "merchandising.development_requirements.superseded",

  /* ── M5 ─────────────────────────────────────────────────────────────
     Only facts another application would act on. A forecast that moves
     three times in a day is Merchandising's working state, not a company
     fact — see the spec's §9.2. Crossing a COMMITTED date is different. */
  TNA_PLAN_BASELINED: "merchandising.tna_plan.baselined",
  TNA_PLAN_REBASELINED: "merchandising.tna_plan.rebaselined",
  TNA_MILESTONE_BLOCKED: "merchandising.tna_milestone.blocked",
  TNA_MILESTONE_AT_RISK: "merchandising.tna_milestone.at_risk",
  TNA_PLAN_COMPLETED: "merchandising.tna_plan.completed",

  /* ── M6: what Merchandising announces downstream ──────────────────────
     Three, and only three. Merchandising announces what happened to ITS
     record — a version was sent, replaced, or taken back. It publishes
     nothing about PPC's decision, because that is PPC's to publish. */
  PACK_SUBMITTED: "merchandising.execution_pack.submitted",
  PACK_SUPERSEDED: "merchandising.execution_pack.superseded",
  PACK_WITHDRAWN: "merchandising.execution_pack.withdrawn",

  /* ── M7: what Merchandising announces about a change ──────────────────
     Two, and only two. Merchandising announces what happened to ITS impact
     record. It publishes nothing about Sales' change (Sales' own) and nothing
     about an application's acknowledgement (theirs). */
  CHANGE_IMPACT_COORDINATED: "merchandising.change_impact.coordinated",
  CHANGE_IMPACT_CLOSED: "merchandising.change_impact.closed",

  /* ── PRE-ORDER: WHAT MERCHANDISING PUBLISHES TO R&D AND COSTING ───────
     One kind, and only one. An approved development BOM is the single fact
     downstream needs: these materials, this identity, this revision. R&D
     then owns consumption and Costing owns rates — neither is announced
     here, because neither is Merchandising's to state. */
  DEVELOPMENT_BOM_APPROVED: "merchandising.development_bom.approved",
  DEVELOPMENT_BOM_SUPERSEDED: "merchandising.development_bom.superseded",
});

/** Which payload fields each kind must carry, by name. */
const OUTBOX_REQUIRED = Object.freeze({
  [OUTBOX_KIND.HANDOVER_ACCEPTED]: ["handoverVersionId", "handoverRef", "handoverLineRef", "sourceVersionNo"],
  [OUTBOX_KIND.CLARIFICATION_REQUESTED]: ["handoverVersionId", "handoverRef", "handoverLineRef", "sourceVersionNo"],
  [OUTBOX_KIND.MATERIAL_TRIM_SUBMITTED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.MATERIAL_TRIM_APPROVED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.MATERIAL_TRIM_SUPERSEDED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.PACKAGING_SUBMITTED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.PACKAGING_APPROVED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.PACKAGING_SUPERSEDED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.DEVELOPMENT_SUBMITTED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.DEVELOPMENT_APPROVED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.DEVELOPMENT_SUPERSEDED]: ["executionFileId", "family", "revisionId", "revisionNo"],
  [OUTBOX_KIND.TNA_PLAN_BASELINED]: ["executionFileId", "planId", "baselineNo"],
  /* A pack event that named no version would be undeliverable — PPC would
     have nothing to decide about. */
  [OUTBOX_KIND.PACK_SUBMITTED]: ["executionFileId", "packId", "packVersionNo"],
  [OUTBOX_KIND.PACK_SUPERSEDED]: ["executionFileId", "packId", "packVersionNo"],
  [OUTBOX_KIND.PACK_WITHDRAWN]: ["executionFileId", "packId", "packVersionNo"],
  /* A coordination event that named no change version would be
     unacknowledgeable — a receiver could not say which version it had seen. */
  [OUTBOX_KIND.CHANGE_IMPACT_COORDINATED]: ["executionFileId", "changeRef", "changeVersionNo"],
  [OUTBOX_KIND.CHANGE_IMPACT_CLOSED]: ["executionFileId", "changeRef", "changeVersionNo"],
  /* A development event that named no revision would be unusable: R&D could
     not say which selection it engineered against. */
  [OUTBOX_KIND.DEVELOPMENT_BOM_APPROVED]: ["developmentFileId", "bomRevisionNo"],
  [OUTBOX_KIND.DEVELOPMENT_BOM_SUPERSEDED]: ["developmentFileId", "bomRevisionNo"],
  [OUTBOX_KIND.TNA_PLAN_REBASELINED]: ["executionFileId", "planId", "baselineNo"],
  [OUTBOX_KIND.TNA_MILESTONE_BLOCKED]: ["executionFileId", "planId", "milestoneRef"],
  [OUTBOX_KIND.TNA_MILESTONE_AT_RISK]: ["executionFileId", "planId", "milestoneRef"],
  [OUTBOX_KIND.TNA_PLAN_COMPLETED]: ["executionFileId", "planId"],
});

const auditEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recordType: {
      type: String,
      enum: [
        "HANDOVER_VERSION", "HANDOVER_RECEIPT", "EXECUTION_FILE", "SELECTION_REVISION",
        "APPROVAL_REGISTER", "TNA_PLAN", "EXECUTION_PACK", "DEPARTMENT_STATUS",
        "PRE_PRODUCTION_MEETING",
        "CHANGE_NOTICE", "CHANGE_IMPACT", "BULK_OPERATION", "CONFIGURATION",
        "DEVELOPMENT_REQUEST", "DEVELOPMENT_FILE", "DEVELOPMENT_BOM",
      ],
      required: true,
    },
    recordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* The record's revision or version at the moment of the event, where the
       record has one. */
    recordRevision: { type: Number, default: null },

    /* ── WHICH FILE THIS ACT BELONGS TO ────────────────────────────────
       Added when the pre-order work landed, after finding that M3–M7 had
       been writing these two fields into a `strict` schema that had no
       place for them — so mongoose dropped them silently, and the Execution
       File's own history showed handover events and nothing else. A tab
       titled "every act on this file" was showing a fraction of them.

       `fileId` is an EXECUTION file; `developmentFileId` is the pre-order
       one. Deliberately two fields rather than one polymorphic reference: a
       query for one must never return the other's history, and the two
       records have different lifecycles and different readers. */
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    fileNumber: { type: String, trim: true, default: "" },
    developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    developmentNumber: { type: String, trim: true, default: "" },

    action: { type: String, enum: AUDIT_ACTIONS, required: true },

    /* WHO. A person, or the authoritative source — a Sales-driven event on a
       Merchandising record (a mirrored cancellation) is the source app's act,
       and inventing a person for it would be a false attribution. */
    actor: actorRef(),
    source: { type: String, enum: ["sales", "merchandising"], required: true },

    at: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },
    correlationId: { type: String, trim: true, required: true },

    previousState: { type: String, trim: true, default: "" },
    resultingState: { type: String, trim: true, default: "" },

    /* Small, allowlisted extras a history line needs — a version number, an
       assignee name. Never a spread of the record. */
    details: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true, collection: "merchandising_audit_events" },
);

/* One file's history, oldest first — the Changes & History read. */
auditEventSchema.index({ companyId: 1, recordId: 1, at: 1, _id: 1 });

const outboxEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* The cross-app fact being announced. Only decisions another app must
       learn get a row — today that is Merchandising's answer travelling back
       toward Sales. */
    kind: {
      type: String,
      enum: [...Object.values(OUTBOX_KIND)],
      required: true,
    },
    /* ── ONE COLLECTION, TWO PAYLOAD SHAPES ───────────────────────────
       An outbox row is identity and outcome, never a copy of the record.
       The handover decisions and the M3 selection decisions name different
       records, so the fields either needs are all declared here and none is
       schema-required — a field required for one kind would be impossible
       for the other. What each kind must carry is enforced below, where the
       rule can say WHICH kind is missing WHAT. */
    payload: {
      /* Handover decisions (M1/M2). */
      handoverVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      handoverRef: { type: String, trim: true, default: undefined },
      handoverLineRef: { type: String, trim: true, default: undefined },
      sourceVersionNo: { type: Number, default: null },
      clarificationCategory: { type: String, trim: true, default: undefined },
      /* Selection decisions (M3). */
      family: { type: String, trim: true, default: undefined },
      revisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      revisionNo: { type: Number, default: null },
      supersededRevisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersededRevisionNo: { type: Number, default: null },
      /* Time & Action (M5). */
      planId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* ── M6 ─────────────────────────────────────────────────────────── */
      packId: { type: mongoose.Schema.Types.ObjectId, default: null },
      packVersionNo: { type: Number, default: null },
      supersedesPackVersionNo: { type: Number, default: null },
      department: { type: String, trim: true, default: undefined },
      statusCode: { type: String, trim: true, default: undefined },
      availability: { type: String, trim: true, default: undefined },
      receiptState: { type: String, trim: true, default: undefined },
      /* ── M7 ─────────────────────────────────────────────────────────── */
      changeRef: { type: String, trim: true, default: undefined },
      changeVersionNo: { type: Number, default: null },
      impactRef: { type: String, trim: true, default: undefined },
      changeKind: { type: String, trim: true, default: undefined },
      decision: { type: String, trim: true, default: undefined },
      affectedApplications: [{ type: String, trim: true }],
      application: { type: String, trim: true, default: undefined },
      ackState: { type: String, trim: true, default: undefined },
      /* ── PRE-ORDER DEVELOPMENT ──────────────────────────────────────── */
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      developmentNumber: { type: String, trim: true, default: undefined },
      bomRevisionNo: { type: Number, default: null },
      requestRef: { type: String, trim: true, default: undefined },
      requestVersionNo: { type: Number, default: null },
      productLineRef: { type: String, trim: true, default: undefined },
      rowCount: { type: Number, default: null },
      baselineNo: { type: Number, default: null },
      previousBaselineNo: { type: Number, default: null },
      milestoneRef: { type: String, trim: true, default: undefined },
      milestoneCode: { type: String, trim: true, default: undefined },
      ownerDepartment: { type: String, trim: true, default: undefined },
      reasonCode: { type: String, trim: true, default: undefined },
      milestoneCount: { type: Number, default: null },
      daysLate: { type: Number, default: null },
      /* Both: the file the decision was about, where there is one. */
      executionFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    correlationId: { type: String, trim: true, required: true },
    /* ── TWO STATES, AND NO TERMINAL FAILURE ──────────────────────────────
       An announcement that could not be carried stays PENDING and is tried
       again. There is deliberately no FAILED: a failed row is a row somebody
       has to notice, and nobody notices a status. What a failure produces
       instead is an attempt count and the last error, both visible, on a row
       the next sweep will pick up. */
    status: { type: String, enum: ["PENDING", "DELIVERED"], default: "PENDING", index: true },
    deliveredAt: { type: Date, default: null },
    /* ── M6: what a retry needs in order to be diagnosable ────────────────
       Without these, "delivery is not working" is the whole of what anybody
       can say. With them, the row says how many times it has been tried, when
       last, and what went wrong. */
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: true, collection: "merchandising_outbox_events" },
);

/* Replay safety: one outbox row per decision. A retried acceptance reuses its
   correlation identity and cannot enqueue the announcement twice. */
outboxEventSchema.index({ correlationId: 1, kind: 1 }, { unique: true });

/* What the schema cannot say, because two kinds need different fields. */
outboxEventSchema.pre("validate", function requirePayloadForKind(next) {
  for (const field of OUTBOX_REQUIRED[this.kind] || []) {
    const held = this.payload?.[field];
    if (held === undefined || held === null || held === "") {
      return next(new Error(`An outbox event of kind "${this.kind}" needs payload.${field}.`));
    }
  }
  return next();
});

/* ── WHAT THIS APPLICATION HAS ALREADY BEEN TOLD ───────────────────────────
 *
 * One row per Sales event Merchandising has applied, keyed on the event's own
 * id. It is what makes delivery idempotent as a DATABASE fact rather than as
 * a property of however carefully each handler was written: a duplicate
 * delivery — a retry sweep racing the immediate attempt, an operator running
 * the sweep twice — finds the row, does nothing, and says so.
 *
 * It records only that an event was seen and what came of it. The consequences
 * live on the records they belong to. */
const intakeLedgerSchema = new mongoose.Schema(
  {
    sourceEventId: {
      type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true,
    },
    sourceKind: { type: String, trim: true, required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    handoverRef: { type: String, trim: true, default: "" },
    handoverLineRef: { type: String, trim: true, default: "" },
    sourceVersionNo: { type: Number, default: null },
    /* APPLIED — something changed. NOOP — the event was understood and
       nothing needed to change, which is a successful delivery too. */
    outcome: { type: String, enum: ["APPLIED", "NOOP"], required: true },
    note: { type: String, trim: true, default: "" },
    appliedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "merchandising_intake_ledger" },
);

/* ── A RETRY IS NOT A SECOND DECISION ──────────────────────────────────────
 *
 * The M3 commands that must survive a double-click, a lost response or a
 * client retry — creating a draft, submitting, approving, asking for changes,
 * adopting legacy data — carry an idempotency key. This is where a completed
 * command records what it produced, so the same key replays the original
 * answer instead of taking the decision twice.
 *
 * The unique index is the mechanism, not the bookkeeping: two approvals racing
 * with one key means the loser fails at the database and is handed the
 * winner's result. `requestHash` catches the other failure — the same key
 * deliberately reused for a DIFFERENT request, which is a client bug and is
 * told so rather than silently replaying an unrelated answer.
 */
const commandLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* What the key is scoped to: one command on one record. A key is not
       global, so two different commands may legitimately share one. */
    scope: { type: String, trim: true, required: true },
    idempotencyKey: { type: String, trim: true, required: true },
    requestHash: { type: String, trim: true, required: true },
    /* Enough to rebuild the reply, never a copy of the record. */
    result: {
      revisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      revisionNo: { type: Number, default: null },
      state: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "" },
    },
    /* ── AND THE REPLY ITSELF, FOR COMMANDS THAT PROMISE AN IDENTICAL RETRY ──
       `result` above is a summary in four fixed fields, which is enough to
       say WHAT happened and not enough to say it the same way twice: a caller
       whose connection dropped and who retried got a differently-shaped object
       from the caller who did not, and had to special-case the retry — which
       is the one path nobody tests.

       This holds the public response verbatim, so a replay is the first
       answer rather than a reconstruction of it. It is optional and additive:
       every existing writer keeps filling `result` alone and is unaffected,
       and a replay falls back to `result` when no payload was stored. */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, required: true },
  },
  { timestamps: true, collection: "merchandising_command_ledger" },
);

commandLedgerSchema.index(
  { companyId: 1, scope: 1, idempotencyKey: 1 }, { unique: true },
);

module.exports = {
  AUDIT_ACTIONS, OUTBOX_KIND, OUTBOX_REQUIRED,
  MerchandisingCommandLedger: mongoose.models.MerchandisingCommandLedger
    || mongoose.model("MerchandisingCommandLedger", commandLedgerSchema),
  MerchandisingIntakeLedger: mongoose.models.MerchandisingIntakeLedger
    || mongoose.model("MerchandisingIntakeLedger", intakeLedgerSchema),
  MerchandisingAuditEvent: mongoose.models.MerchandisingAuditEvent
    || mongoose.model("MerchandisingAuditEvent", auditEventSchema),
  MerchandisingOutboxEvent: mongoose.models.MerchandisingOutboxEvent
    || mongoose.model("MerchandisingOutboxEvent", outboxEventSchema),
};
