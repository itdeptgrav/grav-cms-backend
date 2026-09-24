// models/CMS_Models/Sales/SalesHandoverEvent.js
//
// SALES' OWN RECORD OF WHAT IT PUBLISHED, AND ITS OUTBOX TOWARD MERCHANDISING.
//
// ── THE BOUNDARY THIS RESTORES ──────────────────────────────────────────────
// Sales publishes its fact. Merchandising receives it and mirrors it. Neither
// application writes the other's records.
//
// The producer used to break that in two places at once: on cancellation it
// reached into the Merchandising Execution File and set it CANCELLED itself,
// and it wrote HANDOVER_ISSUED / SUPERSEDED / CANCELLED rows straight into the
// Merchandising audit collection. Both worked. Both meant that a change to how
// Merchandising records a cancellation was a change to Sales code, that a
// Merchandising transaction could be rolled back by a Sales failure, and that
// the Merchandising audit trail contained rows no Merchandising code had
// written and none could explain.
//
// So Sales now writes only Sales records — this history, and this outbox —
// and Merchandising's receiver does the Merchandising mutation.
//
// ── TWO COLLECTIONS, ONE FILE ───────────────────────────────────────────────
// HISTORY (`sales_handover_audit_events`) is append-only: what Sales did, who
// did it, when, and why. Nothing updates a row and nothing deletes one.
//
// OUTBOX (`sales_handover_outbox_events`) is delivery bookkeeping, written in
// the SAME transaction as the version change it announces — so a committed
// commercial decision and its announcement cannot exist without one another.
// A row stays PENDING until a receiver confirms it has applied the event, and
// a delivery attempt that fails leaves it PENDING to be tried again. That is
// the whole mechanism: durable, local, retryable, and emphatically not a
// global event bus.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** The three things Sales can say about a handover. Closed list, on purpose. */
const HANDOVER_EVENT_KINDS = Object.freeze({
  ISSUED: "sales.merchandising_handover.issued",
  SUPERSEDED: "sales.merchandising_handover.superseded",
  CANCELLED: "sales.merchandising_handover.cancelled",
});

const KIND_VALUES = Object.freeze(Object.values(HANDOVER_EVENT_KINDS));

/** Sales' own append-only history of its handover acts. */
/** What Sales can record about a CHANGE to an already-handed-over line. */
const CHANGE_KIND_VALUES = Object.freeze([
  "sales.change_notice.issued",
  "sales.change_notice.superseded",
  "sales.change_notice.cancelled",
  /* ── PRE-ORDER ──────────────────────────────────────────────────────
     The development request, before any order exists. It joins this enum
     rather than opening a third Sales trail, because it is the same story
     about the same commercial opportunity — a reader following one Journey
     product line sees the request, the handover and every change on it in
     one place, in order. */
  "sales.development_request.issued",
  "sales.development_request.superseded",
  "sales.development_request.cancelled",
  "sales.development_release.authorised",
  /* Sales reviewed the approved selection against the customer requirement
     and asked Merchandising to change it. The counterpart of the release:
     the same decision point, answered the other way. */
  "sales.development_changes.requested",
]);

const auditSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* Required for a handover event; absent on a change event, which names
       its notice below instead. */
    handoverVersionId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    handoverRef: { type: String, trim: true, required: true },
    handoverLineRef: { type: String, trim: true, required: true },
    versionNo: { type: Number, required: true },

    /* ── M7 ────────────────────────────────────────────────────────────
       A change to a handed-over line belongs in the same story as the
       handover itself, so the change actions join this enum rather than
       opening a second Sales audit trail that a reader would have to
       reconcile against this one. */
    action: { type: String, enum: [...KIND_VALUES, ...CHANGE_KIND_VALUES], required: true },
    actor: actorRef(),
    at: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },
    correlationId: { type: String, trim: true, required: true, index: true },

    previousState: { type: String, trim: true, default: "" },
    resultingState: { type: String, trim: true, default: "" },

    /* ── M7: which change, and which version of it ──────────────────────── */
    changeRef: { type: String, trim: true, default: "" },
    noticeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    changeKind: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "sales_handover_audit_events" },
);

/* One line's whole story — handovers and changes together, newest first. */
auditSchema.index({ companyId: 1, handoverRef: 1, handoverLineRef: 1, at: -1 });

/* One line's publication history, oldest first. */
auditSchema.index({ companyId: 1, handoverRef: 1, handoverLineRef: 1, at: 1, _id: 1 });

/**
 * The outbox toward Merchandising.
 *
 * `payload` is identity and outcome only — never a copy of the projection.
 * The receiver reads the authoritative version by id, so there is exactly one
 * statement of what was confirmed and no chance of a stale duplicate of it
 * travelling separately.
 */
const outboxSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: [...KIND_VALUES, ...CHANGE_KIND_VALUES], required: true },

    payload: {
      /* Required for a handover event; a change event names its notice
         instead — see `noticeId` below. Both are announcements about the same
         order line, and the receiver resolves the file from the line identity
         either way. */
      handoverVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* ── REQUIRED PER KIND, NOT PER FIELD ────────────────────────────
         This outbox now carries three event families about the same
         commercial opportunity: the handover, changes to it, and the
         pre-order development request. A handover event names an order line;
         a development event names a Journey product line, which does not
         exist as an order line yet.

         Blanket `required: true` would have forced a development event to
         invent a handover reference it does not have. The guard below asks
         each KIND for the fields that kind genuinely needs, so nothing is
         loosened — an undeliverable event is still refused, by name. */
      handoverRef: { type: String, trim: true, default: undefined },
      handoverLineRef: { type: String, trim: true, default: undefined },
      versionNo: { type: Number, default: null },
      /* On a supersession, the version that replaced this one. */
      supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersededByVersionNo: { type: Number, default: null },
      /* ── M7: what a change event carries ─────────────────────────────
         The stable change identity, the version, and the kind — enough for
         Merchandising's receiver to resolve the file, dedupe the delivery and
         refuse a stale one. Deliberately NOT the projection: the receiver
         reads the notice for that, so a payload cannot drift from the record
         it describes. */
      changeRef: { type: String, trim: true, default: undefined },
      changeKind: { type: String, trim: true, default: undefined },
      noticeId: { type: mongoose.Schema.Types.ObjectId, default: null },
      supersedesVersionNo: { type: Number, default: null },
      /* ── PRE-ORDER ──────────────────────────────────────────────────── */
      requestRef: { type: String, trim: true, default: undefined },
      requestVersionNo: { type: Number, default: null },
      requestId: { type: mongoose.Schema.Types.ObjectId, default: null },
      journeyId: { type: mongoose.Schema.Types.ObjectId, default: null },
      productLineRef: { type: String, trim: true, default: undefined },
      releaseReference: { type: String, trim: true, default: undefined },
      /* ── WHAT A RELEASE BINDS ────────────────────────────────────────
         A release names one exact approved material revision, and the
         identity of one is `{companyId, developmentFileId, revisionNo}`.
         Carried on the event rather than looked up by the receiver: delivery
         is asynchronous, and a receiver that resolves "the current revision"
         for itself will resolve a different one if Merchandising approved
         another in the gap. Both are listed in OUTBOX_REQUIRED below, so an
         unbound release cannot become a deliverable event at all. */
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      bomRevisionNo: { type: Number, default: null },
      /* True when Sales took back a release rather than reviewing an approved
         revision. The receiver's ordinary handler refuses a released file, and
         refuses it correctly — this says the refusal has been answered. */
      reopenReleased: { type: Boolean, default: false },
      reason: { type: String, trim: true, default: "" },
    },

    /* The moment Sales acted — the ordering the receiver honours, so a
       delayed retry cannot apply an older statement over a newer one. */
    occurredAt: { type: Date, required: true, index: true },
    actor: actorRef(),
    correlationId: { type: String, trim: true, required: true },

    status: { type: String, enum: ["PENDING", "DELIVERED"], default: "PENDING", index: true },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "" },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "sales_handover_outbox_events" },
);

/* Replay safety: one row per act per kind. A retried issue reuses its
   correlation identity and cannot enqueue the same announcement twice. */
outboxSchema.index({ correlationId: 1, kind: 1 }, { unique: true });
/* The retry sweep: this company's undelivered events, oldest first. */
outboxSchema.index({ status: 1, occurredAt: 1, _id: 1 });

/* What each kind must carry to be deliverable at all. */
const OUTBOX_REQUIRED = Object.freeze({
  "sales.merchandising_handover.issued": ["handoverRef", "handoverLineRef", "versionNo"],
  "sales.merchandising_handover.superseded": ["handoverRef", "handoverLineRef", "versionNo"],
  "sales.merchandising_handover.cancelled": ["handoverRef", "handoverLineRef", "versionNo"],
  "sales.change_notice.issued": ["changeRef", "handoverRef", "handoverLineRef"],
  "sales.change_notice.superseded": ["changeRef", "handoverRef", "handoverLineRef"],
  "sales.change_notice.cancelled": ["changeRef", "handoverRef", "handoverLineRef"],
  /* A development event is rooted on the Journey product line — the identity
     that exists before any order does. */
  "sales.development_request.issued": ["requestRef", "journeyId", "productLineRef"],
  "sales.development_request.superseded": ["requestRef", "journeyId", "productLineRef"],
  "sales.development_request.cancelled": ["requestRef", "journeyId", "productLineRef"],
  /* A release carries the binding as well as the line: without it the
     receiver would have to choose a revision, which is the whole defect. */
  "sales.development_release.authorised": [
    "requestRef", "journeyId", "productLineRef", "developmentFileId", "bomRevisionNo",
  ],
  /* And so does a request for changes — it is a decision ABOUT a revision,
     and a receiver that had to guess which one could reopen the wrong
     selection. The reason travels too: Merchandising cannot act on
     "Sales wants something different". */
  "sales.development_changes.requested": [
    "requestRef", "journeyId", "productLineRef", "developmentFileId", "bomRevisionNo", "reason",
  ],
});

outboxSchema.pre("validate", function requirePayloadForKind(next) {
  for (const field of OUTBOX_REQUIRED[this.kind] || []) {
    const held = this.payload?.[field];
    if (held === undefined || held === null || held === "") {
      return next(new Error(
        `A Sales outbox event of kind "${this.kind}" needs payload.${field}.`,
      ));
    }
  }
  return next();
});

module.exports = {
  CHANGE_KIND_VALUES, OUTBOX_REQUIRED,
  HANDOVER_EVENT_KINDS,
  SalesHandoverAuditEvent: mongoose.models.SalesHandoverAuditEvent
    || mongoose.model("SalesHandoverAuditEvent", auditSchema),
  SalesHandoverOutboxEvent: mongoose.models.SalesHandoverOutboxEvent
    || mongoose.model("SalesHandoverOutboxEvent", outboxSchema),
};
