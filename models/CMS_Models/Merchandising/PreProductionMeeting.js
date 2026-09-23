// models/CMS_Models/Merchandising/PreProductionMeeting.js
//
// THE PRE-PRODUCTION MEETING — WHAT WAS REVIEWED, WHAT WAS AGREED, AND WHAT IS
// STILL OPEN.
//
// PPM is Pre-Production MEETING. It is not Production Planning and Control,
// which is a different application with a different job: PPC books capacity,
// allocates a line and releases production, and it does that AFTER reading
// what this record says. Nothing here plans anything.
//
// ── WHAT THIS RECORD IS ─────────────────────────────────────────────────────
// Coordination EVIDENCE, owned by Merchandising, rooted in one Execution File.
// It answers one question and no other:
//
//     Before PPC releases this order to Production, what was reviewed, what
//     was agreed, and what remains explicitly unresolved?
//
// ── AND THE FIVE THINGS IT IS NOT ───────────────────────────────────────────
//   1  It is not a readiness verdict. The conclusion is one of two neutral
//      sentences about the MEETING, and neither of them says "production
//      ready" — only PPC decides whether this order can be planned.
//   2  It is not another department's record. Store's status, IE's release and
//      PPC's receipt are REFERENCED by version and never written; a PPM that
//      could mark Store ready would be Merchandising asserting a fact it
//      cannot observe.
//   3  It is not a task list. A follow-up carries an optional reference to a
//      Task the Tasks app owns. No assignee, no due date, no reminder, no
//      personal queue — building those here would be a second Tasks app inside
//      a minute book.
//   4  It is not the Execution Pack. The pack is the exact set of approved
//      Merchandising records handed downstream; this is the record of a
//      conversation about them, and it references the pack rather than
//      restating it.
//   5  It is not a second approval system. Issuing reuses the Merchandising
//      capability ladder, and maker/checker is the same rule every other
//      Merchandising decision follows.
//
// ── WHY AN ISSUED MINUTE IS IMMUTABLE ───────────────────────────────────────
// Minutes are what somebody reads in March to find out what was agreed in
// September. A minute that can be edited afterwards answers a different
// question — what we would LIKE to have agreed — and is worth nothing in the
// argument it exists to settle. So an issued version takes no write at all:
// changing anything means a SUCCESSOR, and the earlier version stays exactly
// as it was, superseded and still readable.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* ── LIFECYCLE ─────────────────────────────────────────────────────────────
   DRAFT → CONDUCTED → ISSUED, plus the two ways a version leaves the line:
   CANCELLED (a draft somebody abandoned) and SUPERSEDED (an issued version a
   later one replaced). A CONDUCTED meeting is one that HAPPENED and whose
   minutes are not yet final — the gap where somebody writes up what was said. */
const PPM_STATE = Object.freeze({
  DRAFT: "DRAFT",
  CONDUCTED: "CONDUCTED",
  ISSUED: "ISSUED",
  CANCELLED: "CANCELLED",
  SUPERSEDED: "SUPERSEDED",
});
const PPM_STATES = Object.freeze(Object.values(PPM_STATE));

/** The states a version is still being worked on in. */
const OPEN_STATES = Object.freeze([PPM_STATE.DRAFT, PPM_STATE.CONDUCTED]);

/* ── THE MEETING'S OUTCOME ─────────────────────────────────────────────────
   Two sentences about the MEETING, and deliberately neither of them is a
   verdict on the order. "Production ready" is PPC's word and PPC's decision;
   a Merchandising record claiming it would be one department answering
   another's question. */
const PPM_CONCLUSION = Object.freeze({
  CONDUCTED_WITHOUT_OPEN_CLARIFICATIONS: "CONDUCTED_WITHOUT_OPEN_CLARIFICATIONS",
  CONDUCTED_WITH_OPEN_CLARIFICATIONS: "CONDUCTED_WITH_OPEN_CLARIFICATIONS",
});
const PPM_CONCLUSIONS = Object.freeze(Object.values(PPM_CONCLUSION));

/* ── WHAT A PRE-PRODUCTION MEETING REVIEWS ────────────────────────────────
   A closed list, because a minute book with free-form headings cannot be read
   across orders — "was the folder discussed on any of these twelve styles?"
   has no answer once every meeting invents its own sections. */
const REVIEW_TOPIC = Object.freeze({
  CONSTRUCTION: "CONSTRUCTION",
  MEASUREMENT_FIT: "MEASUREMENT_FIT",
  MATERIAL_TRIM: "MATERIAL_TRIM",
  PACKAGING_PRESENTATION: "PACKAGING_PRESENTATION",
  QUALITY_CHECKPOINTS: "QUALITY_CHECKPOINTS",
  TESTING: "TESTING",
  MACHINE_ATTACHMENT: "MACHINE_ATTACHMENT",
  PRODUCTION_HANDLING: "PRODUCTION_HANDLING",
  BUYER_INSTRUCTIONS: "BUYER_INSTRUCTIONS",
  SHIPMENT_CRITICAL: "SHIPMENT_CRITICAL",
});
const REVIEW_TOPICS = Object.freeze(Object.values(REVIEW_TOPIC));

/** Where a decision or clarification has got to. */
const DECISION_STATUS = Object.freeze({
  OPEN: "OPEN",
  ANSWERED: "ANSWERED",
  CLOSED: "CLOSED",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});
const DECISION_STATUSES = Object.freeze(Object.values(DECISION_STATUS));

/** Only the two that mean somebody still owes an answer. */
const UNRESOLVED_STATUSES = Object.freeze([DECISION_STATUS.OPEN, DECISION_STATUS.ANSWERED]);

/** Which department owns a decision. The same vocabulary the status register
 *  uses, plus Merchandising and Sales, who are also asked things. */
const OWNER_DEPARTMENT = Object.freeze({
  MERCHANDISING: "MERCHANDISING",
  SALES: "SALES",
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  SUPPLY_CHAIN: "SUPPLY_CHAIN",
  STORE: "STORE",
  IE: "IE",
  PPC: "PPC",
  QUALITY: "QUALITY",
  PRODUCTION: "PRODUCTION",
  LOGISTICS: "LOGISTICS",
});
const OWNER_DEPARTMENTS = Object.freeze(Object.values(OWNER_DEPARTMENT));

/* ── A SOURCE THAT IS NOT THERE ───────────────────────────────────────────
   Three different absences, and a screen that rendered them all as a blank
   would make them the same one. `UNAVAILABLE` is an application that has no
   integration; `NOT_REPORTED` is one that has and has not; `UNKNOWN` is a
   reference this file has no way to resolve. None of them is ever turned into
   zero, complete, approved or ready. */
const SOURCE_AVAILABILITY = Object.freeze({
  PRESENT: "PRESENT",
  UNKNOWN: "UNKNOWN",
  NOT_REPORTED: "NOT_REPORTED",
  UNAVAILABLE: "UNAVAILABLE",
});
const SOURCE_AVAILABILITIES = Object.freeze(Object.values(SOURCE_AVAILABILITY));

/**
 * ONE REFERENCED SOURCE, BY VERSION.
 *
 * Every field is an IDENTITY or a state word. No quantity, no rate, no
 * supplier, no margin: a minute records which version was on the table, and
 * anybody who needs the contents opens the record it names.
 */
const sourceReferenceSchema = new mongoose.Schema(
  {
    /* Which source this is — `EXECUTION_PACK`, `MATERIAL_TRIM`, `IE_RELEASE`
       and so on. A closed list lives in the service; the model stores the key
       so a source added later does not need a migration. */
    key: { type: String, trim: true, required: true },
    label: { type: String, trim: true, default: "" },
    availability: {
      type: String, enum: SOURCE_AVAILABILITIES, required: true,
      default: SOURCE_AVAILABILITY.UNKNOWN,
    },
    /* The owning application's own reference, as IT publishes it. This is a
       BUSINESS CODE — `IEREL-000000123` — and it is for a human to read. It is
       not an identity: codes are renamed, reused across companies and reissued,
       so nothing downstream may decide two records are the same because their
       references match. */
    reference: { type: String, trim: true, default: "" },
    /* THE RECORD ITSELF, where the owning application publishes an id.
       Recorded so a later reader can ask "is this the same record?" — the one
       question a reference cannot answer — without joining into another
       application's collection to find out. Null where the owner publishes no
       id, and on every version issued before this field existed; a reader
       treats that absence as "not established", never as agreement. */
    recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    versionNo: { type: Number, default: null },
    revisionNo: { type: Number, default: null },
    state: { type: String, trim: true, default: "" },
    /* When the owning record last moved, where it publishes that. Used to
       notice that a source has changed under an issued minute. */
    sourceUpdatedAt: { type: Date, default: null },
    /* The sentence a reader is shown when there is nothing to show. */
    note: { type: String, trim: true, default: "", maxlength: 400 },
  },
  { _id: false },
);

/** One observation under one topic. Not an edit of the record it is about. */
const reviewNoteSchema = new mongoose.Schema(
  {
    topic: { type: String, enum: REVIEW_TOPICS, required: true },
    /* What was said. The meeting's own words, and the reason this is evidence
       rather than a status: it is not derivable from any other record. */
    observation: { type: String, trim: true, required: true, maxlength: 4000 },
    /* Optional — which source the observation was about, so a reader can open
       it. A reference, never a write. */
    sourceKey: { type: String, trim: true, default: "" },
    recordedBy: actorRef(),
    recordedAt: { type: Date, required: true },
  },
  { _id: false },
);

/** A decision taken, or a clarification somebody still owes. */
const decisionSchema = new mongoose.Schema(
  {
    /* Server-minted, stable across versions so a successor can say "this is
       the same open point, still open". */
    decisionRef: { type: String, trim: true, required: true },
    topic: { type: String, enum: REVIEW_TOPICS, default: undefined },
    decision: { type: String, trim: true, required: true, maxlength: 4000 },
    ownerDepartment: { type: String, enum: OWNER_DEPARTMENTS, required: true },
    status: { type: String, enum: DECISION_STATUSES, required: true, default: DECISION_STATUS.OPEN },
    sourceKey: { type: String, trim: true, default: "" },
    /* What the answer was, once there is one. */
    closureNote: { type: String, trim: true, default: "", maxlength: 4000 },
    /* ── AN OPTIONAL POINTER AT A TASK SOMEBODY ELSE OWNS ────────────────
       Where follow-up work is needed it lives in the Tasks app, which has
       assignees, due dates and reminders and is built for it. This is the
       reference, and nothing more: no assignee, no date, no state of its own.
       A PPM that owned the task would be a second Tasks app growing inside a
       minute book, one field at a time. */
    externalTaskRef: { type: String, trim: true, default: "", maxlength: 120 },
    recordedBy: actorRef(),
    recordedAt: { type: Date, required: true },
    updatedBy: actorRef(),
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** Who was in the room, and who was expected and was not. */
const attendeeSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 200 },
    /* ── EVIDENCE, NOT PERMISSION ────────────────────────────────────────
       This says which department a person spoke for in a meeting. It grants
       nothing: every write on this record is decided by the live Merchandising
       grant, and an attendee row has never been consulted for one. */
    department: { type: String, enum: OWNER_DEPARTMENTS, required: true },
    role: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false },
);

const preProductionMeetingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },

    /* ── ROOTED IN ONE EXECUTION FILE ─────────────────────────────────── */
    fileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile",
      required: true, index: true, immutable: true,
    },
    fileNumber: { type: String, trim: true, required: true, immutable: true },
    handoverRef: { type: String, trim: true, required: true, immutable: true },
    handoverLineRef: { type: String, trim: true, required: true, immutable: true },
    /* ── THE PERMANENT LINE AND STYLE IDENTITY ────────────────────────────
       Not the product name. Two colourways of one style, or two lines of one
       order carrying the same words, are different meetings — and a minute
       book keyed on a name merges them the first time somebody repeats a
       style. These come from the file's own accepted projection and are never
       body-authored. */
    orderRef: { type: String, trim: true, required: true, immutable: true },
    orderLineRef: { type: String, trim: true, required: true, immutable: true },
    styleRef: { type: String, trim: true, default: "", immutable: true },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },

    /* PPM-YYYY-NNNN, for a person to quote. Shared across the versions of one
       meeting the way a handover's reference is shared across its versions. */
    ppmRef: { type: String, trim: true, required: true, immutable: true },
    versionNo: { type: Number, required: true, min: 1, immutable: true },

    state: {
      type: String, enum: PPM_STATES, required: true,
      default: PPM_STATE.DRAFT, index: true,
    },

    /* ── MEETING DETAILS ──────────────────────────────────────────────── */
    plannedMeetingDate: { type: Date, default: null },
    actualMeetingAt: { type: Date, default: null },
    locationOrMode: { type: String, trim: true, default: "", maxlength: 200 },
    chairperson: { type: String, trim: true, default: "", maxlength: 200 },
    merchandisingRepresentative: { type: String, trim: true, default: "", maxlength: 200 },
    attendees: { type: [attendeeSchema], default: () => [] },
    /* Departments who were expected and did not come. Recorded because their
       absence is exactly what a reader needs three months later, and because
       leaving it out would make an incomplete meeting look complete. */
    absentDepartments: { type: [String], enum: OWNER_DEPARTMENTS, default: () => [] },

    /* ── WHAT WAS ON THE TABLE ────────────────────────────────────────────
       Server-derived, every time. A browser cannot state which revision was
       reviewed: that is the whole value of the snapshot. */
    sourceReferences: { type: [sourceReferenceSchema], default: () => [] },
    /* When the snapshot was taken, so a later comparison has something to
       compare against. */
    sourcesCapturedAt: { type: Date, default: null },
    /* WHICH CONTRACT PRODUCED THIS SNAPSHOT.
       Stamped by the code that captured it, and never inferred afterwards.

       A reader has to tell two absences apart: minutes taken before a source
       was captured at all, and minutes that captured it and found nothing.
       They look identical in the data — both are a missing row — and they
       mean opposite things: the first is a gap in what this record was ever
       able to say, the second is a positive statement that there was nothing
       to review. Only the version the capture ran under can separate them,
       so it is stored, and nothing downstream may guess it from a date, from
       a null, or from which fields happen to be filled in.

       Null on every version issued before this field existed. That absence is
       itself the answer — it names the legacy contract — and it is read as
       "this record could not have told you", never as "there was nothing". */
    sourcesContractVersion: { type: Number, default: null },

    reviewNotes: { type: [reviewNoteSchema], default: () => [] },
    decisions: { type: [decisionSchema], default: () => [] },

    /* ── THE CONCLUSION ───────────────────────────────────────────────────
       Derived from the decisions at the moment of issue, never authored: a
       meeting with an open clarification cannot be recorded as one without,
       however anybody would prefer to word it. */
    conclusion: { type: String, enum: PPM_CONCLUSIONS, default: undefined },

    /* ── THE THREE ACTS ───────────────────────────────────────────────── */
    conductedAt: { type: Date, default: null },
    conductedBy: actorRef(),
    issuedAt: { type: Date, default: null },
    issuedBy: actorRef(),
    cancelledAt: { type: Date, default: null },
    cancelledBy: actorRef(),
    cancellationReason: { type: String, trim: true, default: "", maxlength: 1000 },

    /* ── SUPERSESSION ─────────────────────────────────────────────────────
       An issued version is replaced, never edited. Both ends of the link are
       stored so either version can be read alone. */
    supersededAt: { type: Date, default: null },
    supersededByVersionNo: { type: Number, default: null },
    successorOfVersionNo: { type: Number, default: null },
    /* Which topics the successor has to look at again, because the source
       behind them moved. Carried forward at creation and cleared only by a
       fresh observation under that topic. */
    topicsRequiringReReview: { type: [String], enum: REVIEW_TOPICS, default: () => [] },

    revision: { type: Number, default: 0 },
    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_pre_production_meetings" },
);

/* ── THE TWO INVARIANTS, AS INDEXES ────────────────────────────────────────
   Stated to the database rather than checked in the service, because two
   concurrent creates both read "no draft exists" and only an index can decide
   which of them is right. */

/** One meeting reference per file+version — the identity of a version. */
preProductionMeetingSchema.index(
  { companyId: 1, fileId: 1, versionNo: 1 }, { unique: true },
);

/** AT MOST ONE ACTIVE DRAFT per Execution File. A conducted meeting counts:
 *  it is the same version still being written up, and a second one alongside
 *  it would be two minute books for one conversation. */
preProductionMeetingSchema.index(
  { companyId: 1, fileId: 1 },
  { unique: true, partialFilterExpression: { state: { $in: [...OPEN_STATES] } } },
);

/** AT MOST ONE CURRENT ISSUED VERSION per Execution File. */
preProductionMeetingSchema.index(
  { companyId: 1, fileId: 1, state: 1 },
  { unique: true, partialFilterExpression: { state: PPM_STATE.ISSUED } },
);

/** The version list, newest first. */
preProductionMeetingSchema.index({ companyId: 1, fileId: 1, createdAt: -1 });

/* ── A FROZEN MINUTE TAKES NO WRITE, DOWN ANY PATH ─────────────────────────
   The service refuses first, with a sentence somebody can act on. This is the
   floor under it, and it has to cover more than `save()`: a document guard
   protects the one path the service happens to use today and says nothing
   about the eight query paths a future helper will reach for. `updateMany`
   with a careless filter, a cleanup script's `deleteMany`, a
   `findOneAndUpdate` in a migration — each of those rewrites or destroys
   evidence without ever constructing a document.

   So the rule is enforced twice: on the document, and on every query that
   could mutate or remove one. */
const FROZEN_STATES = Object.freeze([
  PPM_STATE.ISSUED, PPM_STATE.CANCELLED, PPM_STATE.SUPERSEDED,
]);

/* ── THE ONE CHANGE A FROZEN RECORD MAY TAKE ───────────────────────────────
   An issued version is retired when its successor is issued. That is the only
   legitimate write, and it is narrow in four ways at once: the record must
   have been ISSUED when it was read, it must be becoming SUPERSEDED, the
   paths touched must be exactly the supersession bookkeeping, and the caller
   must have declared the intent by setting `$locals.supersedingToVersionNo`
   to the version taking over.

   That last one is what keeps this from being an allowlist. Without it, any
   caller who happened to set `state` and `supersededByVersionNo` could retire
   a record; with it, the declaration has to be made in code, by name, which
   only the successor-issue service does. Nothing here lets anybody touch
   identity, evidence or meeting content — those paths are not on the list at
   all, and a save carrying one is refused even mid-supersession. */
const SUPERSESSION_PATHS = Object.freeze([
  "state", "supersededAt", "supersededByVersionNo", "revision", "updatedAt",
]);

/**
 * Whether this save is the sanctioned issued → superseded retirement.
 *
 * Every clause has to hold. A partial match is a bug somewhere, and the right
 * answer to a bug near permanent evidence is to refuse the write.
 */
function isSanctionedSupersession(doc, loadedState) {
  const intent = doc.$locals.supersedingToVersionNo;
  if (!Number.isInteger(intent)) return false;
  if (loadedState !== PPM_STATE.ISSUED) return false;
  if (doc.get("state") !== PPM_STATE.SUPERSEDED) return false;
  if (doc.get("supersededByVersionNo") !== intent) return false;
  return doc.modifiedPaths().every((p) => SUPERSESSION_PATHS.includes(p));
}

/* Mongoose has no supported way to ask "what state was this in when it was
   read", so remember it at the two moments it can change underneath us: when
   a document is loaded, and after it is written. Reading `this.state` inside
   the guard would ask the wrong question — by then it is already whatever the
   caller set. */
preProductionMeetingSchema.post("init", function rememberState() {
  this.$locals.loadedState = this.get("state");
});
preProductionMeetingSchema.post("save", function rememberState() {
  this.$locals.loadedState = this.get("state");
  /* The declaration is spent. A second save on the same in-memory document
     cannot ride on it. */
  this.$locals.supersedingToVersionNo = undefined;
});

const frozenRefusal = (state, detail) => new Error(
  `A ${state} pre-production meeting is permanent evidence and takes no edit `
  + `(${detail}). Create a successor instead.`,
);

preProductionMeetingSchema.pre("save", function guardFrozen(next) {
  if (this.isNew) return next();
  const loaded = this.$locals.loadedState;
  /* Reaching a frozen state is the transition itself, and is allowed. Only a
     version that was ALREADY frozen when it was read is closed. */
  if (!FROZEN_STATES.includes(loaded)) return next();
  if (!this.isModified()) return next();
  if (isSanctionedSupersession(this, loaded)) return next();
  return next(frozenRefusal(loaded, `attempted: ${this.modifiedPaths().join(", ")}`));
});

preProductionMeetingSchema.pre("deleteOne", { document: true, query: false },
  function guardFrozenDelete(next) {
    const state = this.$locals.loadedState ?? this.get("state");
    if (!FROZEN_STATES.includes(state)) return next();
    return next(frozenRefusal(state, "attempted: delete"));
  });

/**
 * THE SAME RULE, ASKED OF A QUERY.
 *
 * A query does not carry documents, so the only way to know whether it is
 * about to touch evidence is to look. This reads the matched records first
 * and refuses the whole statement if ANY of them is frozen — not the frozen
 * subset, the statement. A `updateMany` that quietly skipped the issued rows
 * and changed the rest would be a half-applied migration nobody could reason
 * about afterwards.
 *
 * The read joins the caller's session, so inside a transaction it sees that
 * transaction's own writes rather than the state before it started.
 */
async function guardFrozenQuery(next) {
  const options = (typeof this.getOptions === "function" && this.getOptions()) || {};

  /* An upsert is refused outright. Its filter matches nothing by definition
     when it inserts, so there is no record to inspect — and what it would
     insert is a meeting with a lifecycle state nobody's service decided. */
  if (options.upsert) {
    return next(new Error(
      "A pre-production meeting is not created by upsert. Its lifecycle is decided by "
      + "the Merchandising service, which is where its state, version and evidence come from.",
    ));
  }

  try {
    const matched = await this.model
      .find(this.getFilter())
      .select("_id state versionNo")
      .setOptions({ session: options.session || null })
      .lean();
    const frozen = matched.filter((m) => FROZEN_STATES.includes(m.state));
    if (!frozen.length) return next();
    const worst = frozen[0];
    return next(frozenRefusal(worst.state,
      `${frozen.length} matched by ${this.op}, including version ${worst.versionNo}`));
  } catch (err) {
    return next(err);
  }
}

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate",
  "replaceOne", "findOneAndReplace",
  "deleteOne", "deleteMany", "findOneAndDelete",
]) {
  preProductionMeetingSchema.pre(op, { document: false, query: true }, guardFrozenQuery);
}

module.exports = {
  PPM_STATE, PPM_STATES, OPEN_STATES, FROZEN_STATES, SUPERSESSION_PATHS,
  PPM_CONCLUSION, PPM_CONCLUSIONS,
  REVIEW_TOPIC, REVIEW_TOPICS,
  DECISION_STATUS, DECISION_STATUSES, UNRESOLVED_STATUSES,
  OWNER_DEPARTMENT, OWNER_DEPARTMENTS,
  SOURCE_AVAILABILITY, SOURCE_AVAILABILITIES,
  PreProductionMeeting: mongoose.models.PreProductionMeeting
    || mongoose.model("PreProductionMeeting", preProductionMeetingSchema),
};
