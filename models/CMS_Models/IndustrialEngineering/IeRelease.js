// models/CMS_Models/IndustrialEngineering/IeRelease.js
//
// IE CHUNK 8A-i — THE IMMUTABLE RELEASE RECORD.
//
// The moment Industrial Engineering hands a complete, approved aggregate to
// Planning: one approved Operation Bulletin Version, one approved Line Layout at
// one exact revision, and one approved Capacity Standard bound to that revision.
//
// ── THERE IS NO DRAFT RELEASE ───────────────────────────────────────────────
// The states are `ISSUED`, `SUPERSEDED` and `WITHDRAWN`. A release exists only
// once it has been issued, so the state cannot be reached by any route, present
// or future, without this file changing — the same device that keeps a bulletin
// version from holding a second draft.
//
// ── AND `aggregateFingerprint` IS NOT THE BULLETIN'S FINGERPRINT ────────────
// This is the distinction the whole record turns on. `source.sourceFingerprint`
// proves the bulletin ROWS and nothing else. A release whose bulletin is
// unchanged but whose line layout was rearranged, or whose capacity standard was
// re-planned, is a DIFFERENT thing to hand somebody — and reusing the bulletin's
// fingerprint here would collapse the two, so the second release would be
// refused as a duplicate of the first and Planning would never learn the line
// had changed. `aggregateFingerprint` is computed over the complete canonical
// frozen payload: bulletin, layout and capacity standard together.
//
// ── EVERYTHING IS COPIED, NOTHING IS REFERENCED ─────────────────────────────
// A release is read months later, argued about, and planned against. If it
// resolved its members live it would silently restate itself the moment anybody
// approved a newer version of anything. So the rows, the metrics, the inputs,
// the calculation, the ramp and the readiness are all copied at issue — the
// discipline `IeCapacityStandard.ramp` already follows.
"use strict";

const mongoose = require("mongoose");

/* ── THE THREE STATES ───────────────────────────────────────────────────────
   ISSUED      the current head of this style's release line
   SUPERSEDED  terminal. A later release of a moved aggregate replaced it
   WITHDRAWN   terminal. Declared here so the enum is the accepted one; nothing
               in this slice writes it, and there is no withdrawal command */
const STATE = Object.freeze({
  ISSUED: "ISSUED", SUPERSEDED: "SUPERSEDED", WITHDRAWN: "WITHDRAWN",
});
const STATES = Object.freeze(Object.values(STATE));
const TERMINAL = Object.freeze(new Set([STATE.SUPERSEDED, STATE.WITHDRAWN]));

/* No acknowledgement, clarification or delivery type. Delivery is a READ of
   this collection, not an event, so an audit trail that could name one would
   invite a screen to render a control for something that does not exist. */
const EVENT_TYPES = Object.freeze([
  "RELEASE_ISSUED",
  "RELEASE_SUPERSEDED",
]);

const LIMITS = Object.freeze({
  NOTE: 2000,
  OVERRIDE_REASON_MIN: 10,
  OVERRIDE_REASON_MAX: 2000,
  SUMMARY: 300,
  HISTORY: 200,
});

/** A bounded audit line. Never a copy of the frozen payload. */
const releaseEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    /* The version this event is ABOUT — which for a supersession is the
       superseded release's own number, not its successor's. */
    versionNo: { type: Number, required: true, min: 1 },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

/** One frozen bulletin row, exactly as the approved version held it. */
const frozenRowSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    machineType: { type: String, trim: true, default: "" },
    standardTimeMinutes: { type: Number, required: true, min: 0 },
    standardTimeSource: { type: String, trim: true, default: "" },
    methodStudyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedSubmissionId: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },
    requirementSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

/**
 * THE OVERRIDE EVIDENCE FOR AN OPERATION RETIRED AFTER APPROVAL.
 *
 * An operation can be retired between bulletin approval and release. Blocking
 * the release would strand an approved bulletin behind a library change nobody
 * made against it — so it may be overridden, once, with a reason, by somebody
 * other than the person who retired it. Everything needed to re-examine that
 * decision is frozen here: what was retired, when, by whom, when the bulletin
 * was approved, why the override was granted and who granted it.
 */
const overrideSchema = new mongoose.Schema(
  {
    ieOperationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    retiredAt: { type: Date, default: null },
    retiredByName: { type: String, trim: true, default: "" },
    bulletinApprovedAt: { type: Date, default: null },
    reason: { type: String, required: true, trim: true, maxlength: LIMITS.OVERRIDE_REASON_MAX },
    overriddenBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    overriddenByName: { type: String, trim: true, default: "" },
    overriddenAt: { type: Date, required: true },
  },
  { _id: false },
);

const ieReleaseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    /* Stable across every version of one style's release line, and SERVER-OWNED:
       a caller that could name it could append a version to somebody else's
       chain. */
    releaseRef: { type: String, required: true, trim: true, immutable: true },
    versionNo: { type: Number, required: true, min: 1, immutable: true },

    ieStyleFileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "IeStyleFile", required: true, immutable: true,
    },
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", required: true, immutable: true,
    },

    state: { type: String, enum: STATES, required: true, default: STATE.ISSUED },

    /* Server-computed over the complete canonical frozen payload — see the
       header. Never accepted from a caller, and never the bulletin's own. */
    aggregateFingerprint: { type: String, required: true, trim: true, immutable: true },

    /* ── THE FROZEN AGGREGATE ─────────────────────────────────────────────
       Deliberately `Mixed` below the first level: a frozen payload must keep the
       shape it had when it was frozen, not be re-validated against a schema that
       has moved on — the same rule `IeStyleFile.source.snapshot` follows. The
       fields a reader navigates by are typed; the evidence is kept verbatim. */
    source: {
      bulletinVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
      bulletinVersionNo: { type: Number, required: true, min: 1 },
      sourceFingerprint: { type: String, required: true, trim: true },
      sourceApprovalDigest: { type: String, trim: true, default: "" },
      sourceRequirementDigest: { type: String, trim: true, default: "" },
      rows: { type: [frozenRowSchema], default: () => [] },
      garmentSamMinutes: { type: Number, required: true, min: 0 },
      samRowCount: { type: Number, required: true, min: 0 },
      samDerivation: { type: String, trim: true, default: "" },

      lineLayout: { type: mongoose.Schema.Types.Mixed, required: true },
      capacityStandard: { type: mongoose.Schema.Types.Mixed, required: true },
      ramp: { type: mongoose.Schema.Types.Mixed, default: null },

      capturedAt: { type: Date, required: true },
    },

    issuedBy: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    issuedByName: { type: String, trim: true, default: "" },
    issuedAt: { type: Date, required: true, immutable: true },

    supersededByVersionNo: { type: Number, default: null, min: 1 },

    retiredOperationOverrides: { type: [overrideSchema], default: () => [] },

    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    history: { type: [releaseEventSchema], default: () => [] },
  },
  { timestamps: true, collection: "ie_releases" },
);

/* ═══ INDEXES ══════════════════════════════════════════════════════════════ */

/* The arbiter for version allocation. "Read the highest, add one" is two
   operations, and two operations are what a race gets between; this index is
   what makes the loser lose, inside its own transaction. */
ieReleaseSchema.index(
  { companyId: 1, releaseRef: 1, versionNo: 1 },
  { unique: true, name: "ie_release_version_per_ref" },
);

/* ONE ISSUED RELEASE PER AGGREGATE. Re-issuing an identical aggregate is a
   no-op that returns the release which already exists, not a second version —
   and this index is what makes that structural rather than a check somebody
   remembered to write. Partial on ISSUED, so a superseded release releases the
   slot and a genuinely changed aggregate can take it. */
ieReleaseSchema.index(
  { companyId: 1, ieStyleFileId: 1, aggregateFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { state: STATE.ISSUED },
    name: "ie_release_one_issued_per_aggregate",
  },
);

/* The reads the future PPC queue needs: one style's release line newest first,
   and everything a company currently has issued. */
ieReleaseSchema.index({ companyId: 1, ieStyleFileId: 1, versionNo: -1 });
ieReleaseSchema.index({ companyId: 1, state: 1, issuedAt: -1, _id: -1 });

/* ═══ THE IMMUTABILITY GUARD ═══════════════════════════════════════════════
 *
 * A release is evidence of a handover. Its content is immutable from the
 * instant it exists, and the ONLY movement it ever makes is a supersession.
 *
 * ── WHY A `pre("save")` HOOK ALONE WOULD BE DECORATION ─────────────────────
 * Document middleware runs on `save()` and on nothing else, while every IE
 * service writes through atomic update queries. So the guard covers every path,
 * and the rule is about the QUERY rather than about a list of fields: a
 * protected-path allowlist can only ever contain the ways somebody has already
 * thought of, and would leave `companyId`, `releaseRef`, `issuedByName` and
 * every field added later writable on an issued release.
 */
const SUPERSEDE_FIELDS = Object.freeze([
  "state", "supersededByVersionNo", "history", "updatedAt", "__v",
]);

const touchedPaths = (update = {}) => {
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

const releaseImmutable = (what) => {
  const err = new Error(`An issued release is permanent evidence of a handover. ${what}`);
  err.name = "IeReleaseImmutable";
  err.code = "IE_RELEASE_IMMUTABLE";
  return err;
};

/* `save()` — creation is how every release comes into existence; every later
   save is refused. A save has no filter, so it cannot prove which state it is
   moving from, and a supersession that cannot prove that is not one. */
ieReleaseSchema.pre("save", function freezeOnSave(next) {
  if (this.isNew) return next();
  /* ── EVERY LATER SAVE, WHETHER OR NOT MONGOOSE THINKS IT IS DIRTY ───────
     Not "every save with modified paths". The frozen payload is `Mixed` below
     its first level, and Mongoose does not mark a Mixed subtree modified when
     somebody assigns into it — so a guard that trusted `modifiedPaths()` would
     wave through exactly the write most worth refusing. Nothing legitimate
     saves a release: it is created once and superseded by a conditional
     update. */
  const touched = [...new Set(this.modifiedPaths().map((p) => String(p).split(".")[0]))];
  return next(releaseImmutable(
    `${touched.length ? touched.join(", ") : "This document"} cannot change. `
    + "A moved aggregate is issued as a new version.",
  ));
});

/* ── THE ONE MOVEMENT THERE IS ─────────────────────────────────────────────
   `ISSUED` → `SUPERSEDED`, writing only the state, the successor's number and
   one bounded history line. The filter must name `state: "ISSUED"` as a scalar:
   that is the only proof a query can offer, without a second read, that it is
   making the move it believes it is. `SUPERSEDED` and `WITHDRAWN` are terminal
   and appear as no source state anywhere. */
for (const op of ["updateOne", "findOneAndUpdate", "findOneAndReplace"]) {
  ieReleaseSchema.pre(op, function judge(next) {
    if (this.getOptions?.().upsert) {
      return next(releaseImmutable("A release is issued, never upserted."));
    }
    const update = this.getUpdate() || {};
    const touched = touchedPaths(update);
    if (!touched.length) return next();

    const to = update?.$set?.state ?? (typeof update?.state === "string" ? update.state : null);
    if (to !== STATE.SUPERSEDED) {
      return next(releaseImmutable(
        `${touched.join(", ")} cannot change. The only movement a release makes is being superseded.`,
      ));
    }
    const from = this.getFilter?.()?.state;
    if (from !== STATE.ISSUED) {
      return next(releaseImmutable(
        "A supersession has to name `state: \"ISSUED\"` as the state it moves from, "
        + "so two callers cannot both believe they made the move.",
      ));
    }
    const stray = touched.filter((p) => !SUPERSEDE_FIELDS.includes(p));
    if (stray.length) {
      return next(releaseImmutable(`A supersession cannot write ${stray.join(", ")}.`));
    }
    if (!this.getOptions?.().session) {
      return next(releaseImmutable(
        "A supersession moves the head of a version chain and has to run inside the "
        + "transaction that issues its successor. This write has no session.",
      ));
    }
    const session = this.getOptions().session;
    if (typeof session.inTransaction !== "function" || !session.inTransaction()) {
      return next(releaseImmutable(
        "A supersession has to run inside a live transaction; this write has a session "
        + "that is not in one, so the successor might never exist.",
      ));
    }
    return next();
  });
}

/* ── A SUPERSESSION IS NEVER A BULK WRITE ───────────────────────────────────
 * `updateMany` is refused unconditionally — even naming `state: "ISSUED"`, even
 * writing only the permitted fields, even inside a live transaction. One
 * successor supersedes exactly ONE preceding release in one release line, and a
 * bulk write cannot have proved which release it is moving or that there was only
 * one: a filter matching two chains would supersede both and stamp them with a
 * successor number belonging to neither. The service reads the standing release
 * first and moves it by its own id, which is the only shape this move has. */
ieReleaseSchema.pre("updateMany", function refuseBulk(next) {
  return next(releaseImmutable(
    "Releases are never changed in bulk. One successor supersedes exactly one preceding "
    + "release, named by its own id.",
  ));
});

/* Replacements and deletions, refused outright. A replacement's field set is the
   whole document, so it can never be a supersession; and a release is never
   deleted, because a register whose rows can disappear cannot be cited. */
for (const op of ["replaceOne", "findOneAndReplace"]) {
  ieReleaseSchema.pre(op, function refuseReplace(next) {
    return next(releaseImmutable("A release cannot be replaced wholesale."));
  });
}
const noDeletion = () => releaseImmutable(
  "A release is never deleted. One that no longer describes the plan is superseded by a new version.",
);
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  ieReleaseSchema.pre(op, { query: true, document: false }, function refuseQueryDelete(next) {
    return next(noDeletion());
  });
}
ieReleaseSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(noDeletion());
});

module.exports = mongoose.models.IeRelease || mongoose.model("IeRelease", ieReleaseSchema);

module.exports.STATE = STATE;
module.exports.STATES = STATES;
module.exports.TERMINAL = TERMINAL;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
module.exports.SUPERSEDE_FIELDS = SUPERSEDE_FIELDS;
