// models/CMS_Models/IndustrialEngineering/IeLineLayout.js
//
// THE LINE LAYOUT — BULLETIN OPERATIONS ARRANGED INTO STATIONS.
//
// An engineering STANDARD: this is how the work divides across a line, and what
// that division costs in balance. It is not a production plan, not a floor
// drawing and not an assignment of anybody or anything.
//
// ── WHY THIS IS NOT PRODUCTION'S `CanvasLayout` ─────────────────────────────
// The audit for this chunk read it, and the two records answer different
// questions with different boundaries:
//
//   · OWNERSHIP — `CanvasLayout` belongs to the Production dashboard; the
//     supervisor draws the floor on it.
//   · TENANCY — its key is `organizationId: String` defaulting to "default".
//     IE's boundary is a resolved `companyId` ObjectId proved from membership.
//     Adopting a string with a default as a tenant key would silently put every
//     company's layout in one bucket.
//   · IDENTITY — it holds `machineId` references to physical `Machine` assets
//     with x/y coordinates, separators and canvas zoom. This chunk is forbidden
//     to name an asset at all.
//   · LIFECYCLE — no draft state, no optimistic revision, no history, and its
//     route hard-deletes.
//
// The Chunk 0 audit already recorded that `CanvasLayout` is the supervisor's
// physical floor layout and "must not be adopted as" an IE line-balance
// standard. So this is a separate IE-owned record, and Production's is left
// exactly as it is.
//
// ── BOUND TO ONE BULLETIN, FOR EVER ─────────────────────────────────────────
// A layout binds to the engineering file, the exact bulletin revision, the
// exact ordered row identities, and the APPROVED standard time each row carried
// when the layout was opened. Those are copied in and never re-read: a balance
// is only meaningful against the work content it was calculated from. When the
// bulletin moves afterwards the layout is not rebased and not deleted — it is
// reported as source-changed, and a new layout may be opened for the new
// revision beside it.
//
// ── AND NOTHING IS ALLOCATED ────────────────────────────────────────────────
// No employee, no machine asset, no serial number, no capacity, no target
// output, no shift and no calendar. There is no field for any of them. Chunk 7
// owns capacity; approval, release and Production acknowledgement are not built.
"use strict";

const mongoose = require("mongoose");

/* One status in this chunk, written out rather than implied. Submit, approve
   and release do not exist here. */
/* ── DRAFT IS WHERE A LINE IS PLANNED; APPROVED IS WHERE IT STOPS ─────────
   Chunk 7C2 adds the second. An APPROVED layout is permanent evidence of a plan
   a second person accepted: it is never edited, never re-balanced and never
   rebased, and the way to change the plan is to open a new DRAFT. */
const LAYOUT_STATUS = ["DRAFT", "APPROVED"];

/* Chunk 6C adds one: applying a reusable template is an edit, but it is a
   different KIND of edit, and the trail has to be able to say which template
   and which revision of it produced the arrangement. */
const EVENT_TYPES = [
  "LINE_LAYOUT_CREATED", "LINE_LAYOUT_EDITED", "LINE_LAYOUT_TEMPLATE_APPLIED",
  /* Chunk 7C2. The last entry any layout ever receives. */
  "LINE_LAYOUT_APPROVED",
];

/** How the layout relates to the bulletin as it stands now. Derived, never stored. */
const SOURCE_STATE = ["CURRENT", "SOURCE_CHANGED"];

const LIMITS = Object.freeze({
  STATIONS: 200,
  ASSIGNMENTS_PER_STATION: 100,
  LABEL: 120,
  NOTE: 1000,
  SUMMARY: 300,
  HISTORY: 200,
});

/* ── THE SOURCE ROW, FROZEN AT BINDING ────────────────────────────────────
   Everything the balance is calculated from, copied from the bulletin row and
   from the APPROVED method study that gave it a standard time. `minutes` is the
   figure a second person approved under maker-checker in Chunk 4B — never a
   proposed SAM, and never a number a client sent. */
const sourceRowSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    /* The approved standard time and where it came from, so the balance can be
       re-derived and audited without reading the study back. */
    standardTimeMinutes: { type: Number, required: true, min: 0 },
    standardTimeSource: { type: String, trim: true, default: "" },
    methodStudyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedSubmissionId: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },

    /* ── THE REQUIRED-MACHINE EVIDENCE, AS THE BULLETIN ROW FROZE IT ───────
       Copied from the row, which copied it from the Chunk 5A profile when the
       row was authored. Held here too so compatibility is decided from the
       layout alone, without re-reading a library that has since moved.
       `null` for a row authored before Chunk 6B — there is nothing truthful to
       put here, and compatibility for it is UNKNOWN. */
    requirementSnapshot: {
      type: new mongoose.Schema({
        capturedAt: { type: Date, default: null },
        ieOperationRevision: { type: Number, default: null },
        requirementsConfigured: { type: Boolean, default: false },
        machineTypes: {
          type: [new mongoose.Schema({
            machineType: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
          }, { _id: false })],
          default: () => [],
        },
      }, { _id: false }),
      default: null,
    },
  },
  { _id: false },
);

/** One row placed at a station. The row id IS the assignment's identity. */
const assignmentSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    /* Server-captured from the bound source row, so a station reads correctly
       without resolving anything, and so a client cannot dictate the minutes a
       balance is computed from. */
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    standardTimeMinutes: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/**
 * One station on the line.
 *
 * `stationId` is minted by the server once and survives relabelling and
 * reordering — a station is a decision about the line, and the audit trail has
 * to be able to name the same one twice. A station with no assignments is
 * legitimate and deliberately counts towards `stationCount`.
 */
const stationSchema = new mongoose.Schema(
  {
    stationId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    label: { type: String, trim: true, default: "", maxlength: LIMITS.LABEL },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
    assignments: { type: [assignmentSchema], default: () => [] },

    /* ── WHAT THIS STATION IS PLANNED TO BE EQUIPPED WITH (Chunk 6B) ───────
       Machine TYPES and how many of each. A plan, in the same vocabulary the
       operation states its requirement in, so the two can be compared.

       It is deliberately expressible without any of the things this chunk must
       not hold: there is no machine id, no serial number, no maintenance
       status, no availability, no operator, no shift and no allocation — and no
       field one could be put in. "This station is planned with two single-needle
       lockstitch machines" is an engineering statement about the line; "machine
       SN-4471 is free on Tuesday" is Maintenance's and Production's, and this
       record cannot express it. */
    plannedMachineTypes: {
      type: [new mongoose.Schema({
        machineType: { type: String, required: true, trim: true, maxlength: LIMITS.LABEL },
        quantity: { type: Number, required: true, min: 1, max: 999 },
      }, { _id: false })],
      default: () => [],
    },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the stations. */
const layoutEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    layoutRevision: { type: Number, required: true, min: 1 },
    changed: { type: [{ type: String, trim: true }], default: () => [] },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },

    /* ── WHICH TEMPLATE PRODUCED THIS ARRANGEMENT ─────────────────────────
       Set only on `LINE_LAYOUT_TEMPLATE_APPLIED`, and null on every other
       event. The trail used to carry the template's NAME in its summary alone,
       and a name is not an identity: an active name is released when a template
       is retired, so two templates can hold the same one and a reader could not
       tell which of them was applied.

       These are RECORDED, not resolved through. Nothing reads them to fetch a
       template, and no reference or coupling exists in either direction: the
       template may afterwards be renamed, edited or retired, and this event
       says what it said on the day it was written. */
    templateId: { type: mongoose.Schema.Types.ObjectId, default: null },
    templateRevision: { type: Number, default: null, min: 1 },
  },
  { _id: false },
);

const ieLineLayoutSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    ieStyleFileId: { type: mongoose.Schema.Types.ObjectId, ref: "IeStyleFile", required: true },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", required: true },

    /* The bulletin revision this layout was bound to. Part of its identity:
       a different bulletin is a different line, and gets its own layout. */
    bulletinRevision: { type: Number, required: true, min: 1 },

    /* ── THE FINGERPRINT OF THE WHOLE SOURCE ──────────────────────────────
       A stable hash over the ordered rows AND the approved evidence behind
       each one — row id, operation, operation revision, method study,
       approved submission and the approved minutes.

       The bulletin revision alone is not the source. Chunk 4B lets a row that
       is already approved be re-timed and approved AGAIN without the bulletin
       moving at all, and that second approval is a different standard: a
       different study, decided by different people on a different day. A
       layout balanced against the first one is evidence of the first one, and
       must not quietly present itself as a balance of the second.

       So the fingerprint is part of the layout's identity. Server-computed
       always — a client that could send it could make one source look like
       another. */
    sourceFingerprint: { type: String, required: true, trim: true },

    /* ── THE FINGERPRINT'S TWO HALVES, KEPT SEPARATELY ────────────────────
       So a superseded layout can say WHICH half moved — a newly approved
       standard, or newly frozen requirement evidence — instead of reporting one
       undifferentiated "source changed". Absent on layouts written before
       Chunk 6B, and a missing half is never treated as a changed one. */
    sourceApprovalDigest: { type: String, trim: true, default: "" },
    sourceRequirementDigest: { type: String, trim: true, default: "" },

    sourceRows: { type: [sourceRowSchema], default: () => [] },

    /* ── WHICH APPROVED BULLETIN VERSION THIS LAYOUT BALANCES (Chunk 7C2) ──
       Added BESIDE `bulletinRevision`, `sourceFingerprint`, the two digests and
       `sourceRows`, every one of which keeps its present meaning and its
       present writer. Nothing above is renamed or reinterpreted.

       Neither field carries a default, and that is the Chunk 1D rule: a
       `default: null` writes a null onto every legacy document the moment an
       unrelated field is saved, fabricating the claim "this layout was
       considered and has no bulletin version". A layout balanced before 7C1
       existed has neither field, which is the truthful answer — it was balanced
       against a mutable embedded bulletin, and nothing stored proves which
       approved version that was. Such a layout stays readable historical
       evidence and is refused for approval. There is no backfill, because there
       is nothing truthful to backfill with. */
    ieBulletinVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "IeBulletinVersion" },
    bulletinVersionNo: { type: Number, min: 1 },

    status: { type: String, enum: LAYOUT_STATUS, default: "DRAFT", required: true },
    revision: { type: Number, default: 1, min: 1 },

    /* ── WHO ACCEPTED THIS PLAN, AND WHICH REVISION OF IT ──────────────────
       `approvedRevision` is the revision that was APPROVED — the one the
       approver read and decided on — while `revision` moves to the next number
       in the same write. Keeping both means a reader can say "revision 4 was
       approved, and the record is at 5" without inferring it. All four are
       absent on a DRAFT for the same reason the version fields are absent on a
       legacy layout: an unapproved plan has no approver, and a null would say
       somebody considered it. */
    approvedBy: { type: mongoose.Schema.Types.ObjectId },
    approvedByName: { type: String, trim: true },
    approvedAt: { type: Date },
    approvedRevision: { type: Number, min: 1 },

    stations: { type: [stationSchema], default: () => [] },
    history: { type: [layoutEventSchema], default: () => [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_line_layouts" },
);

/* ── ONE DRAFT LAYOUT PER FILE PER EXACT SOURCE ────────────────────────────
 * Opening a layout twice must resume the first one, and "look then insert" is
 * two operations that two simultaneous requests both pass.
 *
 * The key is the bulletin revision AND the source fingerprint, because those
 * are the two ways the thing being balanced can change:
 *
 *   · the bulletin moves — rows added, reordered, re-noted, re-timed;
 *   · the approved standard behind an unchanged row moves, when a later method
 *     study for the same row and operation revision is approved.
 *
 * Keying on the revision alone made the second invisible: the open endpoint
 * returned the layout built from last month's approval and the index refused a
 * new one, so a line could never be re-balanced against a standard somebody had
 * just approved. Both are in the key now, and each distinct source gets its own
 * layout while every earlier one stays as evidence.
 *
 * Partial on DRAFT so the rule stays "one open layout per source" when a later
 * chunk adds statuses beyond it. This model is not yet accepted or deployed, so
 * the earlier revision-only index is replaced rather than carried. */
ieLineLayoutSchema.index(
  { companyId: 1, ieStyleFileId: 1, bulletinRevision: 1, sourceFingerprint: 1 },
  {
    unique: true,
    name: "ie_line_layout_one_draft_per_source",
    partialFilterExpression: { status: "DRAFT" },
  },
);

/* ── AND ONE DRAFT PER APPROVED BULLETIN VERSION (Chunk 7C2) ───────────────
 * A version-backed layout is identified by the exact approved version it
 * balances, not by a revision-and-fingerprint pair that two versions could in
 * principle share. Opening twice against one approved version resumes the same
 * DRAFT; approving it releases the slot, so the successor DRAFT can be opened
 * against that same version without touching the approved one.
 *
 * Partial on BOTH `status: "DRAFT"` and `ieBulletinVersionId: { $exists: true }`,
 * which is what keeps legacy layouts safely outside it — they have no version
 * id, so they are not in this index at all and need no backfill to coexist.
 * (`$exists: true` is accepted in a partial filter; `$exists: false` is not,
 * which is the other reason the rule is expressed this way round.) */
ieLineLayoutSchema.index(
  { companyId: 1, ieStyleFileId: 1, ieBulletinVersionId: 1 },
  {
    unique: true,
    name: "ie_line_layout_one_draft_per_bulletin_version",
    partialFilterExpression: { status: "DRAFT", ieBulletinVersionId: { $exists: true } },
  },
);

/* The file's layouts, newest first — the list endpoint's own order. */
ieLineLayoutSchema.index({ companyId: 1, ieStyleFileId: 1, createdAt: -1, _id: -1 });

/* ═══ AN APPROVED LAYOUT IS PERMANENT EVIDENCE ═════════════════════════════
 *
 * The services filter on `status: "DRAFT"` in every mutation, so nothing
 * legitimate reaches an approved layout. This is the second layer, for the
 * writes that do not go through a service — and it is needed for the same
 * reason the bulletin version's guard is: document middleware runs on `save()`
 * and on nothing else, while every IE mutation is an atomic update query.
 *
 * ── THE RULE IS ABOUT THE DOCUMENT, NOT ABOUT THE FIELDS ──────────────────
 * An approved layout accepts NO write at all. There is no allowlist here as
 * there is on a bulletin version, because a layout has no onward transition:
 * `APPROVED` is where it stops. A metadata-only write — a touched timestamp, an
 * appended history line, a re-stamped approver — is therefore refused exactly
 * as a rewritten station list is, which is what stops immutability being
 * bypassed one harmless-looking field at a time.
 */
const approvedImmutable = (what) => {
  const err = new Error(
    `An approved line layout is permanent evidence of a plan somebody accepted. ${what} `
    + "Open a new draft layout instead.",
  );
  err.name = "IeLineLayoutImmutable";
  err.code = "IE_LAYOUT_IMMUTABLE";
  return err;
};

/* `save()` — creation is allowed, and so is the approval transition itself when
   it arrives as a document save. Everything else on an approved layout stops. */
ieLineLayoutSchema.pre("save", function freezeApproved(next) {
  if (this.isNew) return next();
  const touched = [...new Set(this.modifiedPaths().map((p) => String(p).split(".")[0]))];
  if (!touched.length) return next();

  /* ── A `save()` MAY NOT MOVE THE STATUS IN EITHER DIRECTION ─────────────
     Reading `this.status` alone would be a hole: a save that sets it BACK to
     DRAFT makes the field modified, so the document would no longer look
     approved to this hook and would let itself be un-approved. Approval is
     performed by one conditional update in the service and by nothing else, so
     no legitimate save touches this field at all. */
  if (touched.includes("status")) {
    return next(approvedImmutable("A layout's status is moved by approving it, not by saving it."));
  }
  if (this.status !== "APPROVED") return next();
  return next(approvedImmutable(`${touched.join(", ")} cannot change.`));
});

/* ── AND EVERY QUERY-LAYER WRITE ────────────────────────────────────────────
 * An approved layout accepts NO write. Not "no write to the fields somebody
 * thought to list" — no write.
 *
 * ── WHY THE FIELD ALLOWLIST WAS THE WRONG SHAPE ────────────────────────────
 * The first version of this guard protected a named set: the stations, the
 * frozen source, the approval metadata. That list can only ever be a list of
 * the ways somebody has already thought of. It left `companyId`,
 * `ieStyleFileId`, `sampleStyleId`, `createdBy`, `updatedByName` and every
 * field added to this schema in future writable on an approved layout — and
 * moving an approved plan into another company is not a lesser kind of rewrite
 * than moving its stations.
 *
 * So the rule is about the QUERY, not about the fields: any non-empty mutation
 * has to name the exact scalar `status: "DRAFT"` in its filter. That is the
 * only proof a query can offer, without a second read, that it cannot land on
 * an approved layout — and it is what every service mutation already carries,
 * so nothing legitimate has to change to satisfy it.
 *
 * A filter naming several statuses (`$in`, `$ne`) is not enough: it would be
 * safe for one member and not for another, and the write could not say which
 * one it believed it was making. */
const touchedLayoutPaths = (update = {}) => {
  const paths = new Set();
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith("$")) {
      if (key === "$setOnInsert") continue;
      for (const path of Object.keys(value || {})) paths.add(String(path).split(".")[0]);
      continue;
    }
    paths.add(String(key).split(".")[0]);
  }
  return [...paths];
};

const namesDraft = (filter = {}) => filter.status === "DRAFT";

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace"]) {
  ieLineLayoutSchema.pre(op, function refuseApprovedWrite(next) {
    if (this.getOptions?.().upsert) {
      /* An upsert would create a layout with no source behind it. Opening
         inserts; nothing upserts. */
      return next(approvedImmutable("A layout is opened, never upserted."));
    }
    const touched = touchedLayoutPaths(this.getUpdate() || {});
    if (!touched.length) return next();
    if (namesDraft(this.getFilter?.() || {})) return next();
    return next(approvedImmutable(
      `${touched.join(", ")} cannot be written without naming \`status: "DRAFT"\`, `
      + "so the write cannot be shown not to land on an approved layout.",
    ));
  });
}

ieLineLayoutSchema.pre("replaceOne", function refuseReplace(next) {
  return next(approvedImmutable("A layout cannot be replaced wholesale."));
});

module.exports = mongoose.models.IeLineLayout
  || mongoose.model("IeLineLayout", ieLineLayoutSchema);
module.exports.LAYOUT_STATUS = LAYOUT_STATUS;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.SOURCE_STATE = SOURCE_STATE;
module.exports.LIMITS = LIMITS;
