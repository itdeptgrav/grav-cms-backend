// services/manufacturing/planningFacts.js
//
// Chunk 4B.2A — the §7 derived planning facts that need NOTHING but one
// WorkOrder document.
//
// ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
// Pure policy. No mongoose, no models, no router, no I/O, no clock. Every
// function takes plain data and returns a new plain object. That is what makes
// the truth tables in §7 testable as truth tables rather than as route
// behaviour, and it is why this file may be required from anywhere without
// dragging a database connection along.
//
// ── THE TOTALITY RULE ───────────────────────────────────────────────────────
// Every fact is TOTAL: it returns `unavailable` rather than guessing.
// `unavailable` is NOT `false`. It never satisfies a gate, and it is not the
// same answer as "no". A missing BOM snapshot and a BOM snapshot that says
// nothing is required are different facts, and only one of them is safe to
// plan from.
//
// This is also why facts are STRUCTURED OBJECTS and never bare booleans: an
// object is always truthy, so `if (materialsReady)` cannot silently pass an
// `unavailable`. Callers must compare `state`, or use `isReady()`.
//
// ── DELIBERATELY NOT HERE (4B.2B) ───────────────────────────────────────────
// Every fact below is derivable from the work-order document alone. The rest of
// §7 is not, and is NOT partially implemented here — see REQUIRED_EXTERNAL_
// EVIDENCE at the bottom for the exact inputs the later adapter must supply.

"use strict";

const {
  PLANNING_STATES,
  PLANNING_STATE_UNKNOWN,
} = require("../../constants/workOrderPlanningState");

/* ── Fact states ─────────────────────────────────────────────────────────── */

const FACT_READY = "ready";
const FACT_NOT_READY = "not_ready";
const FACT_UNAVAILABLE = "unavailable";

/** The only safe way to read a fact. `unavailable` is never ready. */
const isReady = (fact) => fact?.state === FACT_READY;
const isUnavailable = (fact) => fact?.state === FACT_UNAVAILABLE;

/* ── How a planning value came to be what it is ──────────────────────────── */

const ORIGIN_STORED = "stored";
const ORIGIN_LEGACY_ABSENT = "legacy_absent";
const ORIGIN_MALFORMED = "malformed";

/* ── Allocation vocabulary, mirrored from the WorkOrder sub-schema ───────── */

const ALLOCATION_STATES = Object.freeze([
  "not_allocated", "partially_allocated", "fully_allocated", "issued",
]);
const ALLOCATION_SATISFIED = Object.freeze(["fully_allocated", "issued"]);

const exception = (code, detail) => (detail === undefined ? { code } : { code, detail });
const freeze = (fact) => Object.freeze({ ...fact, exceptions: Object.freeze(fact.exceptions) });

/* ═══ 1 · PLANNING STATE ══════════════════════════════════════════════════ */

/**
 * Project the stored planning value, WITHOUT losing why it is what it is.
 *
 * `normalizePlanningState()` in the constants module answers "what value should
 * I show", and stays as it was. It cannot answer "is this a legacy record
 * nobody has classified, or a record holding a value this build does not
 * recognise" — and those need different handling. A legacy absence is expected
 * and is the review queue's ordinary input; a malformed stored value means
 * something wrote a value outside the enum, which is a defect and must surface
 * as an exception rather than blending into the legacy population.
 *
 * Reading NEVER writes. This returns a projection; nothing is persisted.
 */
function derivePlanningState(storedValue) {
  if (storedValue === undefined || storedValue === null) {
    return freeze({
      value: PLANNING_STATE_UNKNOWN,
      origin: ORIGIN_LEGACY_ABSENT,
      storedValue: null,
      exceptions: [],
    });
  }

  if (PLANNING_STATES.includes(storedValue)) {
    return freeze({
      value: storedValue,
      origin: ORIGIN_STORED,
      storedValue,
      exceptions: [],
    });
  }

  return freeze({
    value: PLANNING_STATE_UNKNOWN,
    origin: ORIGIN_MALFORMED,
    storedValue,
    exceptions: [exception("planningStateUnrecognized", { storedValue })],
  });
}

/* ═══ 2 · MATERIALS ═══════════════════════════════════════════════════════ */

/**
 * Affirmative proof that this work order genuinely requires no materials.
 *
 * An empty `rawMaterials` array is NOT that proof. It is equally consistent
 * with a BOM snapshot that was never generated and with legacy data that lost
 * its lines. `[].every(...)` returns `true` in JavaScript, and that accident
 * must never become product policy — so the empty case demands evidence
 * instead of being folded into the "all lines satisfied" branch.
 */
function hasNoMaterialsEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return false;

  // A snapshot that exists and counts zero required lines.
  const snapshot = evidence.bomSnapshot;
  if (snapshot && typeof snapshot === "object"
    && Number.isInteger(snapshot.requiredLineCount)
    && snapshot.requiredLineCount === 0) return true;

  // Or an explicit recorded decision — same shape discipline as the shortage
  // marker (§11.2): a decision without an actor, a time and a reason is not a
  // decision, it is a blank field.
  const decision = evidence.noMaterialsRequired;
  return Boolean(
    decision && typeof decision === "object"
    && decision.decidedBy
    && decision.decidedAt
    && typeof decision.reason === "string"
    && decision.reason.trim() !== "",
  );
}

function readAllocationLines(rawMaterials) {
  if (!Array.isArray(rawMaterials)) {
    return { fatal: exception("rawMaterialsUnavailable", { reason: "missing_or_not_an_array" }) };
  }

  for (let i = 0; i < rawMaterials.length; i += 1) {
    const line = rawMaterials[i];
    if (!line || typeof line !== "object") {
      return { fatal: exception("rawMaterialLineMalformed", { index: i }) };
    }
    const status = line.allocationStatus;
    if (typeof status !== "string" || status.trim() === "") {
      return { fatal: exception("allocationStatusMissing", { index: i }) };
    }
    if (!ALLOCATION_STATES.includes(status)) {
      return { fatal: exception("allocationStatusUnrecognized", { index: i, allocationStatus: status }) };
    }
  }

  return { statuses: rawMaterials.map((line) => line.allocationStatus) };
}

/**
 * Shared spine for `materialsReady` and `materialsIssued` — same evidence
 * requirement, same failure modes, different satisfying set.
 *
 * A recorded shortage is NOT a parameter here, deliberately. A shortage makes
 * planning completable with an exception; it never makes materials ready
 * (§7, §11.2). Keeping it out of this function makes that structural rather
 * than a rule someone could later relax.
 */
function deriveAllocationFact(rawMaterials, evidence, satisfying) {
  const read = readAllocationLines(rawMaterials);
  if (read.fatal) {
    return freeze({
      state: FACT_UNAVAILABLE, noMaterialsRequired: false, lineCount: null,
      exceptions: [read.fatal],
    });
  }

  const { statuses } = read;

  if (statuses.length === 0) {
    return hasNoMaterialsEvidence(evidence)
      ? freeze({ state: FACT_READY, noMaterialsRequired: true, lineCount: 0, exceptions: [] })
      : freeze({
        state: FACT_UNAVAILABLE, noMaterialsRequired: false, lineCount: 0,
        exceptions: [exception("emptyMaterialsWithoutEvidence")],
      });
  }

  const satisfied = statuses.every((status) => satisfying.includes(status));
  return freeze({
    state: satisfied ? FACT_READY : FACT_NOT_READY,
    noMaterialsRequired: false,
    lineCount: statuses.length,
    exceptions: [],
  });
}

/** §7 `materialsReady` — every line `fully_allocated` or `issued`. */
function deriveMaterialsReady(rawMaterials, evidence) {
  return deriveAllocationFact(rawMaterials, evidence, ALLOCATION_SATISFIED);
}

/** §7 `materialsIssued` — every line `issued`. Store owns that transition. */
function deriveMaterialsIssued(rawMaterials, evidence) {
  return deriveAllocationFact(rawMaterials, evidence, ["issued"]);
}

/* ═══ 3 · OPERATIONS ══════════════════════════════════════════════════════ */

/**
 * §7 `operationsReady`.
 *
 * ── KNOWN COMPATIBILITY LIMITATION: EXPLICIT ZERO (decision 14) ─────────────
 * §7 says an explicitly-set `plannedTimeSeconds === 0` is READY — a real
 * operation that genuinely takes no measurable time is a valid plan. That rule
 * is NOT implementable today: the sub-schema declares
 * `plannedTimeSeconds: { default: 0 }`, so a stored `0` is indistinguishable
 * from a field the planner never filled in. Guessing "explicit" would let an
 * untimed operation pass the planning gate.
 *
 * So zero DEGRADES TO `not_ready` — the same answer as missing — until decision
 * 14 fixes the schema default. This is a deliberate, documented under-approval,
 * not an oversight, and 4B.2A does not change the schema to resolve it.
 */
function deriveOperationsReady(operations) {
  if (!Array.isArray(operations)) {
    return freeze({
      state: FACT_UNAVAILABLE, operationCount: null, zeroDurationDegraded: false,
      exceptions: [exception("operationsUnavailable", { reason: "missing_or_not_an_array" })],
    });
  }

  // An empty plan is not a plan — but it is a legible answer, not missing data.
  if (operations.length === 0) {
    return freeze({
      state: FACT_NOT_READY, operationCount: 0, zeroDurationDegraded: false, exceptions: [],
    });
  }

  // Structural defects first: they make the whole fact unavailable, and an
  // unavailable fact must not be downgraded to a mere "not ready" by a later
  // rule that happened to match.
  const seen = new Set();
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    if (!op || typeof op !== "object") {
      return freeze({
        state: FACT_UNAVAILABLE, operationCount: operations.length, zeroDurationDegraded: false,
        exceptions: [exception("operationMalformed", { index: i })],
      });
    }

    const id = op._id === undefined || op._id === null ? "" : String(op._id);
    if (id.trim() === "") {
      return freeze({
        state: FACT_UNAVAILABLE, operationCount: operations.length, zeroDurationDegraded: false,
        exceptions: [exception("operationIdMissing", { index: i })],
      });
    }
    if (seen.has(id)) {
      return freeze({
        state: FACT_UNAVAILABLE, operationCount: operations.length, zeroDurationDegraded: false,
        exceptions: [exception("operationIdDuplicated", { index: i, operationId: id })],
      });
    }
    seen.add(id);

    const duration = op.plannedTimeSeconds;
    const absent = duration === undefined || duration === null;
    if (!absent && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) {
      // A numeric STRING lands here too. "12" is not a duration; it is a value
      // that was never validated, and treating it as 12 would hide that.
      return freeze({
        state: FACT_UNAVAILABLE, operationCount: operations.length, zeroDurationDegraded: false,
        exceptions: [exception("operationDurationMalformed", { index: i, plannedTimeSeconds: duration })],
      });
    }
  }

  // Only now the readiness question. Missing and zero both answer "not ready";
  // zero is reported separately so the degradation stays visible.
  let missing = 0;
  let zero = 0;
  for (const op of operations) {
    const duration = op.plannedTimeSeconds;
    if (duration === undefined || duration === null) missing += 1;
    else if (duration === 0) zero += 1;
  }

  if (missing > 0 || zero > 0) {
    return freeze({
      state: FACT_NOT_READY,
      operationCount: operations.length,
      zeroDurationDegraded: zero > 0,
      exceptions: zero > 0
        ? [exception("operationDurationZeroIndistinguishable", { count: zero })]
        : [],
    });
  }

  return freeze({
    state: FACT_READY, operationCount: operations.length, zeroDurationDegraded: false, exceptions: [],
  });
}

/* ═══ 4 · ACCEPTED SHORTAGE ═══════════════════════════════════════════════ */

/**
 * The §11.2 shortage marker, validated as a whole.
 *
 * This is taken as an INPUT rather than read from the document, because the
 * field does not exist on the schema yet (decision 7, sequence step 4). Adding
 * it here to make this function tidier would be inventing storage ahead of the
 * slice that owns it.
 *
 * A partial marker is not a decision. `shortageAccepted: true` with a blank
 * reason is exactly the "implicit in planningNotes" failure the decision
 * document refuses, so it is reported as a defect rather than honoured.
 */
function readAcceptedShortage(shortage) {
  if (!shortage || typeof shortage !== "object" || shortage.shortageAccepted !== true) {
    return { accepted: false, exception: null };
  }

  const missing = [];
  if (typeof shortage.shortageReason !== "string" || shortage.shortageReason.trim() === "") missing.push("shortageReason");
  if (!shortage.shortageAcceptedBy) missing.push("shortageAcceptedBy");
  if (!shortage.shortageAcceptedAt) missing.push("shortageAcceptedAt");
  if (!Array.isArray(shortage.shortageLines)) missing.push("shortageLines");

  if (missing.length > 0) {
    return { accepted: false, exception: exception("shortageMarkerIncomplete", { missing }) };
  }

  return {
    accepted: true,
    exception: exception("acceptedShortage", {
      reason: shortage.shortageReason,
      acceptedBy: shortage.shortageAcceptedBy,
      acceptedAt: shortage.shortageAcceptedAt,
      lineCount: shortage.shortageLines.length,
    }),
  };
}

/* ═══ 5 · PLANNING COMPLETEABLE ═══════════════════════════════════════════ */

/**
 * Is the evidence sufficient to COMPLETE planning (§5.1 `complete`)?
 *
 * READ-ONLY. It changes neither `planningState` nor `status`; it answers
 * whether a completion attempt would be justified by the evidence on hand.
 *
 * `operationsReady` is required outright. Materials may be satisfied either by
 * real readiness or by a valid accepted shortage — and in the shortage case
 * `materialsReady` STAYS not ready in the returned facts. The shortage buys a
 * completion with a recorded exception; it never rewrites the material fact.
 */
function derivePlanningCompleteable({ materials, operations, shortage } = {}) {
  const accepted = readAcceptedShortage(shortage);
  const exceptions = [];
  if (accepted.exception) exceptions.push(accepted.exception);

  const result = (state) => freeze({
    state,
    materials: materials ?? null,
    operations: operations ?? null,
    acceptedShortage: accepted.accepted ? accepted.exception : null,
    exceptions,
  });

  // Any unavailable input makes the whole fact unavailable. A shortage cannot
  // rescue it: a shortage is a decision about KNOWN short lines, and unknown
  // material evidence is not a known shortage.
  if (isUnavailable(operations) || isUnavailable(materials) || !materials || !operations) {
    return result(FACT_UNAVAILABLE);
  }

  if (!isReady(operations)) return result(FACT_NOT_READY);

  if (isReady(materials)) return result(FACT_READY);

  return result(accepted.accepted ? FACT_READY : FACT_NOT_READY);
}

/* ═══ 6 · THE 4B.2B BOUNDARY ══════════════════════════════════════════════ */

/**
 * The §7 facts this module deliberately does NOT compute, with the external
 * evidence each one needs. Listed so the boundary is explicit and so the next
 * slice adds an adapter rather than discovering these one at a time.
 *
 * Nothing here is stubbed, half-computed or defaulted. A caller that needs
 * these must supply the evidence; this module never queries for it.
 */
const REQUIRED_EXTERNAL_EVIDENCE = Object.freeze({
  isScheduled: "ProductionSchedule membership — never a WorkOrder.status value",
  scheduledPlacement: "ProductionSchedule entry (schedule id, slot, sequence)",
  productionStarted: "timeline.actualStartDate + ProductionCompletionScanRecord entries",
  productionStartedSource: "ledger `scannedBy` — '(manual mark)' suffix distinguishes W10 from W8 scans",
  canStartProduction: "planningState + materialsIssued + WorkOrder.status + the above",
  productionStartedWithoutRelease: "the durable appended event store (§9.2), not a derived comparison",
  hasPlanningExceptions: "union of document-local exceptions above with the durable external events",
});

module.exports = {
  FACT_READY, FACT_NOT_READY, FACT_UNAVAILABLE,
  ORIGIN_STORED, ORIGIN_LEGACY_ABSENT, ORIGIN_MALFORMED,
  ALLOCATION_STATES, ALLOCATION_SATISFIED,
  isReady, isUnavailable,
  derivePlanningState,
  hasNoMaterialsEvidence,
  deriveMaterialsReady,
  deriveMaterialsIssued,
  deriveOperationsReady,
  readAcceptedShortage,
  derivePlanningCompleteable,
  REQUIRED_EXTERNAL_EVIDENCE,
};
