// services/manufacturing/planningEvidence.js
//
// Chunk 4B.2B — the §7 planning facts that need evidence from OUTSIDE the
// WorkOrder document, expressed as pure policy over already-loaded data.
//
// ── THE DIVISION OF LABOUR ──────────────────────────────────────────────────
// 4B.2A (planningFacts.js) covers everything derivable from one WorkOrder.
// This file covers the rest of §7 — schedule membership, production-start
// evidence and its source, `canStartProduction`, durable unreleased-start
// occurrences and the combined exception set.
//
// It is still PURE. No mongoose, no model, no router, no clock, no I/O. Every
// external lookup arrives as plain data with an EXPLICIT success flag, because
// the difference between "looked, found nothing" and "could not look" is the
// whole point of §7's totality rule and cannot be recovered from an empty
// array. Locating that data is the future adapter's job, not this module's.
//
// ── WHAT THIS FILE REFUSES TO DO ────────────────────────────────────────────
// - Infer scheduling from `WorkOrder.status`. Calendar placement is
//   ProductionSchedule membership and nothing else (§5, §7 authority table).
// - Treat a failed lookup as an empty result.
// - Derive a historical `productionStartedWithoutRelease` occurrence from the
//   CURRENT planning state. A derived comparison turns false the moment
//   someone releases the work, erasing the history (§9.2), so occurrences
//   arrive as durable records or the fact is `unavailable`.
// - Report a W10 manual mark as a device scan.

"use strict";

const {
  FACT_READY, FACT_NOT_READY, FACT_UNAVAILABLE,
  isReady, isUnavailable,
} = require("./planningFacts");
const { PLANNING_STATE_UNKNOWN, PLANNING_STATE_RELEASED } = require("../../constants/workOrderPlanningState");

/* ── Fact states specific to this layer ──────────────────────────────────── */

const SCHEDULE_SCHEDULED = "scheduled";
const SCHEDULE_NOT_SCHEDULED = "not_scheduled";

const STARTED = "started";
const NOT_STARTED = "not_started";

const SOURCE_SCANNER = "scanner";
const SOURCE_MANUAL_MARK = "manual_mark";
const SOURCE_UNKNOWN = "unknown";

const GATE_ALLOWED = "allowed";
const GATE_BLOCKED = "blocked";

const EVENTS_PRESENT = "present";
const EVENTS_NONE = "none";

/** The ledger label W10 writes: `${actorName} (manual mark)`. */
const MANUAL_MARK_SUFFIX = "(manual mark)";

const STARTABLE_STATUSES = Object.freeze(["scheduled", "ready_to_start"]);
const TERMINAL_STATUSES = Object.freeze(["completed", "cancelled", "forwarded"]);

const exception = (code, detail) => (detail === undefined ? { code } : { code, detail });
const freeze = (fact) => Object.freeze({ ...fact, exceptions: Object.freeze(fact.exceptions) });

/**
 * Read a timestamp WITHOUT letting JavaScript invent one.
 *
 * `new Date(true)` is 1970 and `new Date([])` is the epoch — coercions that
 * would turn junk into a confident start time. Only a real Date, a non-empty
 * string or a finite number is even considered, and the result still has to
 * parse. Anything else is `malformed`, which is NOT the same answer as absent.
 */
function readTimestamp(value) {
  if (value === undefined || value === null) return { absent: true };

  const isDate = value instanceof Date;
  const isString = typeof value === "string" && value.trim() !== "";
  const isNumber = typeof value === "number" && Number.isFinite(value);
  if (!isDate && !isString && !isNumber) return { malformed: true };

  const parsed = isDate ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return { malformed: true };
  return { value };
}

/* ═══ 1 · SCHEDULE MEMBERSHIP ═════════════════════════════════════════════ */

/**
 * §7 `isScheduled` / `scheduledPlacement` — ProductionSchedule membership.
 *
 * `WorkOrder.status === "scheduled"` is NOT evidence of membership and is never
 * consulted here. The two disagree in production: `status` is a byte someone
 * set, membership is a row in a day's `scheduledWorkOrders[]`.
 *
 * A multi-day work order legitimately holds SEVERAL segments — the sub-schema
 * carries `isMultiDay`, `currentDayNumber` and `totalDaysSpanned` precisely so
 * one placement can span days. Every valid segment is preserved; collapsing
 * them to one arbitrary day would silently lose the rest of the plan.
 *
 * @param lookup {{ ok: boolean, placements?: Array<{scheduleId, scheduleDate?, segment}>, reason?: string }}
 */
function deriveScheduleMembership(lookup) {
  if (!lookup || typeof lookup !== "object" || typeof lookup.ok !== "boolean") {
    return freeze({
      state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
      exceptions: [exception("scheduleLookupUnavailable", { reason: "no_lookup_result_supplied" })],
    });
  }

  if (lookup.ok !== true) {
    return freeze({
      state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
      exceptions: [exception("scheduleLookupUnavailable", { reason: lookup.reason ?? "lookup_failed" })],
    });
  }

  const raw = lookup.placements;
  if (!Array.isArray(raw)) {
    return freeze({
      state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
      exceptions: [exception("scheduleLookupUnavailable", { reason: "placements_missing_or_not_an_array" })],
    });
  }

  // A successful lookup that found nothing is a CONFIDENT answer, not missing
  // data. This is the one branch that can say "definitely not scheduled".
  if (raw.length === 0) {
    return freeze({
      state: SCHEDULE_NOT_SCHEDULED, placements: Object.freeze([]), placementCount: 0, exceptions: [],
    });
  }

  const placements = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      return freeze({
        state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
        exceptions: [exception("schedulePlacementMalformed", { index: i, reason: "not_an_object" })],
      });
    }

    const scheduleId = entry.scheduleId === undefined || entry.scheduleId === null ? "" : String(entry.scheduleId);
    if (scheduleId.trim() === "") {
      return freeze({
        state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
        exceptions: [exception("scheduleReferenceMalformed", { index: i, reason: "scheduleId_missing" })],
      });
    }

    const segment = entry.segment;
    if (!segment || typeof segment !== "object") {
      return freeze({
        state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
        exceptions: [exception("schedulePlacementMalformed", { index: i, reason: "segment_missing" })],
      });
    }

    const segmentId = segment._id === undefined || segment._id === null ? "" : String(segment._id);
    if (segmentId.trim() === "") {
      return freeze({
        state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
        exceptions: [exception("schedulePlacementMalformed", { index: i, reason: "segment_id_missing" })],
      });
    }

    const start = readTimestamp(segment.scheduledStartTime);
    const end = readTimestamp(segment.scheduledEndTime);
    if (start.absent || start.malformed || end.absent || end.malformed) {
      return freeze({
        state: FACT_UNAVAILABLE, placements: Object.freeze([]), placementCount: null,
        exceptions: [exception("schedulePlacementMalformed", {
          index: i,
          reason: start.absent || end.absent ? "scheduled_time_missing" : "scheduled_time_malformed",
        })],
      });
    }

    // Only established facts. No capacity, ownership or readiness is invented
    // here even though the segment carries fields that look adjacent to them.
    const placement = {
      scheduleId,
      scheduleDate: entry.scheduleDate ?? null,
      segmentId,
      scheduledStart: segment.scheduledStartTime,
      scheduledEnd: segment.scheduledEndTime,
    };
    if (segment.position !== undefined && segment.position !== null) placement.position = segment.position;
    if (segment.status !== undefined && segment.status !== null) placement.status = segment.status;
    if (segment.isMultiDay !== undefined && segment.isMultiDay !== null) placement.isMultiDay = segment.isMultiDay;
    if (segment.currentDayNumber !== undefined && segment.currentDayNumber !== null) placement.dayNumber = segment.currentDayNumber;
    if (segment.totalDaysSpanned !== undefined && segment.totalDaysSpanned !== null) placement.totalDays = segment.totalDaysSpanned;

    placements.push(Object.freeze(placement));
  }

  return freeze({
    state: SCHEDULE_SCHEDULED,
    placements: Object.freeze(placements),
    placementCount: placements.length,
    exceptions: [],
  });
}

/* ═══ 2 · PRODUCTION-START SOURCE ═════════════════════════════════════════ */

/**
 * §7 source table, read off the SHARED ledger.
 *
 * W8 (`productionSyncService`) records device scans; W10 (`mark-stage`) writes
 * into the SAME collection, labelling each entry `"<actor> (manual mark)"`.
 * Calling every ledger entry a device scan would misreport who did the work,
 * so the label is read back rather than assumed.
 *
 * Source ambiguity NEVER erases the start. It only ever answers `unknown`.
 */
function deriveProductionSource(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return SOURCE_UNKNOWN;

  let manual = 0;
  let scanner = 0;
  let illegible = 0;

  for (const entry of entries) {
    const label = entry && typeof entry === "object" ? entry.scannedBy : undefined;
    if (typeof label !== "string" || label.trim() === "") { illegible += 1; continue; }
    if (label.trim().endsWith(MANUAL_MARK_SUFFIX)) manual += 1;
    else scanner += 1;
  }

  if (illegible > 0) return SOURCE_UNKNOWN;      // cannot read every entry
  if (manual > 0 && scanner > 0) return SOURCE_UNKNOWN;  // genuinely mixed
  if (manual > 0) return SOURCE_MANUAL_MARK;
  if (scanner > 0) return SOURCE_SCANNER;
  return SOURCE_UNKNOWN;
}

/* ═══ 3 · PRODUCTION STARTED ══════════════════════════════════════════════ */

/**
 * §7 `productionStarted` — four independent fields, exactly as approved.
 *
 * ── PRECEDENCE, STATED EXPLICITLY ───────────────────────────────────────────
 * Execution evidence outranks status. A timestamp or a ledger entry ESTABLISHES
 * that work began; an incompatible status adds an exception BESIDE that
 * conclusion and never overturns it. The only case where evidence fails to
 * establish a start is where there is none.
 *
 * §7's table lists "ledger unreadable → unavailable". That row assumes there is
 * no timestamp: a valid `actualStartDate` is independent evidence, so a failed
 * ledger downgrades the SOURCE to `unknown` and records
 * `executionEvidenceUnavailable` — it does not delete a proven start. Where
 * there is no timestamp and the ledger cannot be read, nothing is established
 * and the fact is `unavailable`.
 *
 * @param input {{ status?, actualStartDate?, ledger?: { ok: boolean, entries?: [] } }}
 */
function deriveProductionStarted({ status, actualStartDate, ledger } = {}) {
  const exceptions = [];
  const result = (state, startedAt, source) => freeze({ state, startedAt, source, exceptions });

  const stamp = readTimestamp(actualStartDate);
  if (stamp.malformed) {
    // Something is stored and it cannot be read. That is not "missing".
    exceptions.push(exception("actualStartDateMalformed", { actualStartDate }));
  }
  const hasTimestamp = Boolean(stamp.value !== undefined && !stamp.absent && !stamp.malformed);

  const ledgerOk = Boolean(ledger && typeof ledger === "object" && ledger.ok === true);
  const ledgerReadable = ledgerOk && Array.isArray(ledger.entries);
  const entries = ledgerReadable ? ledger.entries : [];
  if (!ledgerReadable) {
    exceptions.push(exception("executionEvidenceUnavailable", {
      reason: !ledger || typeof ledger !== "object" || typeof ledger.ok !== "boolean"
        ? "no_ledger_result_supplied"
        : (ledgerOk ? "entries_missing_or_not_an_array" : (ledger.reason ?? "lookup_failed")),
    }));
  }
  const hasLedgerEvidence = ledgerReadable && entries.length > 0;

  const statusValue = typeof status === "string" ? status : null;
  const inProgress = statusValue === "in_progress";

  /* ── Evidence establishes a start ──────────────────────────────────────── */

  if (hasTimestamp) {
    if (!inProgress && ["pending", "planned", "scheduled"].includes(statusValue)) {
      exceptions.push(exception("startedButNotInProgress", { status: statusValue }));
    }
    // Source needs a legible ledger; without one it is `unknown`, never a guess.
    return result(STARTED, actualStartDate, ledgerReadable ? deriveProductionSource(entries) : SOURCE_UNKNOWN);
  }

  if (hasLedgerEvidence) {
    exceptions.push(exception("startedWithoutTimestamp"));
    return result(STARTED, null, deriveProductionSource(entries));
  }

  /* ── No evidence of a start ────────────────────────────────────────────── */

  // A lookup we could not perform is not an empty ledger. Nothing is
  // established either way, so the fact is unavailable — which never satisfies
  // a gate and is not the same answer as "not started".
  if (!ledgerReadable || stamp.malformed) {
    return result(FACT_UNAVAILABLE, null, null);
  }

  if (inProgress) {
    exceptions.push(exception("inProgressWithoutEvidence"));
    return result(NOT_STARTED, null, null);
  }

  return result(NOT_STARTED, null, null);
}

/* ═══ 4 · CAN START PRODUCTION ════════════════════════════════════════════ */

/**
 * §7 `canStartProduction` — the FULL six-condition gate.
 *
 * An earlier draft said only `released && materialsIssued`, which silently
 * dropped the status gate the live route already enforces. All six conditions
 * are evaluated, and every failing one is reported: a caller showing a disabled
 * button needs all the reasons, not the first.
 *
 * Schedule membership is deliberately NOT a condition. The approved decision
 * does not require it, and adding it here would introduce a new prerequisite
 * behind a refactor.
 *
 * ── WHY `blocked` OUTRANKS `unavailable` ────────────────────────────────────
 * A definite block is a definite answer. If one condition is provably false we
 * know starting is not permitted, whatever else is unreadable. Only when no
 * condition definitely fails but some fact could not be established is the
 * verdict `unavailable`. Neither ever reads as allowed.
 */
function deriveCanStartProduction({ planningState, materialsIssued, status, productionStarted } = {}) {
  const blockedBy = [];
  const unavailableBecause = [];
  const exceptions = [];

  // 1 & 6 — the planning axis. `unknown` is called out separately from
  // "not released" because they are different facts with different remedies:
  // one needs a release, the other needs a human classification (§5.2).
  const stateValue = typeof planningState === "string"
    ? planningState
    : (planningState && typeof planningState === "object" ? planningState.value : undefined);

  if (stateValue === undefined || stateValue === null) {
    unavailableBecause.push(exception("planningStateUnavailable"));
  } else {
    if (stateValue === PLANNING_STATE_UNKNOWN) blockedBy.push(exception("planningStateUnknown"));
    if (stateValue !== PLANNING_STATE_RELEASED) {
      blockedBy.push(exception("planningStateNotReleased", { planningState: stateValue }));
    }
  }

  // 2 — materials issued, including the legitimate no-materials case.
  if (!materialsIssued || typeof materialsIssued !== "object") {
    unavailableBecause.push(exception("materialsIssuedUnavailable", { reason: "not_supplied" }));
  } else if (isUnavailable(materialsIssued)) {
    unavailableBecause.push(exception("materialsIssuedUnavailable", { reason: "evidence_unavailable" }));
  } else if (!isReady(materialsIssued)) {
    blockedBy.push(exception("materialsNotIssued"));
  }

  // 3 & 5 — the EXISTING status gate, preserved rather than reinvented.
  const statusValue = typeof status === "string" ? status : null;
  if (statusValue === null) {
    unavailableBecause.push(exception("statusUnavailable"));
  } else {
    if (TERMINAL_STATUSES.includes(statusValue)) {
      blockedBy.push(exception("statusTerminal", { status: statusValue }));
    } else if (!STARTABLE_STATUSES.includes(statusValue)) {
      blockedBy.push(exception("statusNotStartable", { status: statusValue }));
    }
  }

  // 4 — not already started.
  if (!productionStarted || typeof productionStarted !== "object") {
    unavailableBecause.push(exception("productionEvidenceUnavailable", { reason: "not_supplied" }));
  } else if (productionStarted.state === FACT_UNAVAILABLE) {
    unavailableBecause.push(exception("productionEvidenceUnavailable", { reason: "evidence_unavailable" }));
  } else if (productionStarted.state === STARTED) {
    blockedBy.push(exception("productionAlreadyStarted"));
  }

  exceptions.push(...blockedBy, ...unavailableBecause);

  let state = GATE_ALLOWED;
  if (blockedBy.length > 0) state = GATE_BLOCKED;
  else if (unavailableBecause.length > 0) state = FACT_UNAVAILABLE;

  return freeze({
    state,
    blockedBy: Object.freeze(blockedBy.map((e) => e.code)),
    unavailableBecause: Object.freeze(unavailableBecause.map((e) => e.code)),
    exceptions,
  });
}

/* ═══ 5 · DURABLE UNRELEASED-START OCCURRENCES ════════════════════════════ */

/**
 * §9.2 `productionStartedWithoutRelease` — projected from DURABLE records.
 *
 * This function does not take the current planning state as evidence, and that
 * is structural rather than a rule. A derived comparison of
 * `planningState !== "released"` turns false the moment someone releases the
 * work, and the historical violation disappears — which is exactly why the
 * decision made this an appended immutable event.
 *
 * If no event store exists yet, the honest answer is `unavailable`. An
 * occurrence is never manufactured from current state.
 *
 * `currentPlanningState` is accepted for DISPLAY only: it can mark an
 * occurrence as resolvable by the release that has since happened. It never
 * removes, rewrites or filters an occurrence.
 *
 * @param store {{ ok: boolean, events?: [], reason?: string }}
 */
function deriveUnreleasedStartOccurrences(store, currentPlanningState) {
  const unavailable = (reason) => freeze({
    state: FACT_UNAVAILABLE,
    occurrences: Object.freeze([]), occurrenceCount: null, unresolvedCount: null,
    exceptions: [exception("unreleasedStartEventsUnavailable", { reason })],
  });

  if (!store || typeof store !== "object" || typeof store.ok !== "boolean") {
    return unavailable("no_event_store_supplied");
  }
  if (store.ok !== true) return unavailable(store.reason ?? "lookup_failed");
  if (!Array.isArray(store.events)) return unavailable("events_missing_or_not_an_array");

  if (store.events.length === 0) {
    return freeze({
      state: EVENTS_NONE,
      occurrences: Object.freeze([]), occurrenceCount: 0, unresolvedCount: 0, exceptions: [],
    });
  }

  const released = currentPlanningState === PLANNING_STATE_RELEASED;
  const occurrences = [];

  for (let i = 0; i < store.events.length; i += 1) {
    const event = store.events[i];
    if (!event || typeof event !== "object") {
      return freeze({
        state: FACT_UNAVAILABLE,
        occurrences: Object.freeze([]), occurrenceCount: null, unresolvedCount: null,
        exceptions: [exception("unreleasedStartEventMalformed", { index: i, reason: "not_an_object" })],
      });
    }

    const eventId = event._id === undefined || event._id === null ? "" : String(event._id);
    const observed = readTimestamp(event.observedAt);
    if (eventId.trim() === "" || observed.absent || observed.malformed) {
      return freeze({
        state: FACT_UNAVAILABLE,
        occurrences: Object.freeze([]), occurrenceCount: null, unresolvedCount: null,
        exceptions: [exception("unreleasedStartEventMalformed", {
          index: i,
          reason: eventId.trim() === "" ? "event_id_missing" : "observed_at_unreadable",
        })],
      });
    }

    const resolvedAt = readTimestamp(event.resolvedAt);
    const resolved = Boolean(resolvedAt.value !== undefined && !resolvedAt.absent && !resolvedAt.malformed);

    occurrences.push(Object.freeze({
      eventId,
      source: event.source ?? SOURCE_UNKNOWN,
      observedAt: event.observedAt,
      workOrderId: event.workOrderId ?? null,
      planningStateAtObservation: event.planningStateAtObservation ?? null,
      evidenceId: event.evidenceId ?? null,
      resolved,
      resolvedAt: resolved ? event.resolvedAt : null,
      // Display hint only. The occurrence stands either way.
      resolvableByCurrentRelease: !resolved && released,
    }));
  }

  return freeze({
    state: EVENTS_PRESENT,
    occurrences: Object.freeze(occurrences),
    occurrenceCount: occurrences.length,
    unresolvedCount: occurrences.filter((o) => !o.resolved).length,
    exceptions: [],
  });
}

/* ═══ 6 · COMBINED EXCEPTIONS ═════════════════════════════════════════════ */

/**
 * The order sources are examined in. Fixed, so the output is deterministic
 * regardless of object key order or caller argument order.
 */
const EXCEPTION_SOURCE_ORDER = Object.freeze([
  "planningState", "materials", "materialsIssued", "operations",
  "completeable", "schedule", "productionStarted", "unreleasedStarts",
]);

/** Stable identity for de-duplication: the code plus its detail. */
const identityOf = (entry) => `${entry.code}::${JSON.stringify(entry.detail ?? null)}`;

/**
 * §7 `hasPlanningExceptions` — the union, as a STRUCTURED fact.
 *
 * A bare array could not distinguish "examined everything, found nothing" from
 * "could not examine half of it", and the second must never render as a
 * confident "no exceptions". So unexamined or unavailable sources are named,
 * and the state becomes `unavailable` while still listing whatever WAS found.
 *
 * De-duplication is by code + detail, so a repeated identical contradiction
 * collapses — but two durable occurrences carry distinct `eventId`s in their
 * detail and both survive. Losing one would lose a historical violation.
 */
function deriveCombinedExceptions(facts = {}) {
  const collected = [];
  const unexamined = [];
  const seen = new Set();

  const push = (entry) => {
    if (!entry || typeof entry.code !== "string") return;
    const id = identityOf(entry);
    if (seen.has(id)) return;
    seen.add(id);
    collected.push(Object.freeze({ ...entry }));
  };

  for (const source of EXCEPTION_SOURCE_ORDER) {
    const fact = facts[source];

    if (fact === undefined || fact === null) { unexamined.push(source); continue; }
    if (typeof fact !== "object") { unexamined.push(source); continue; }

    // An unavailable source has not been examined, whatever else it reports.
    if (fact.state === FACT_UNAVAILABLE) unexamined.push(source);

    if (Array.isArray(fact.exceptions)) fact.exceptions.forEach(push);

    // The accepted shortage lives beside the not-ready material fact rather
    // than replacing it (§11.2), so it is collected explicitly.
    if (source === "completeable" && fact.acceptedShortage) push(fact.acceptedShortage);

    // Durable occurrences each become their own exception, keyed by event id.
    if (source === "unreleasedStarts" && Array.isArray(fact.occurrences)) {
      for (const occurrence of fact.occurrences) {
        push(exception("productionStartedWithoutRelease", {
          eventId: occurrence.eventId,
          source: occurrence.source,
          observedAt: occurrence.observedAt,
          resolved: occurrence.resolved,
        }));
      }
    }
  }

  let state = EVENTS_NONE;
  if (unexamined.length > 0) state = FACT_UNAVAILABLE;
  else if (collected.length > 0) state = EVENTS_PRESENT;

  return freeze({
    state,
    exceptions: collected,
    count: collected.length,
    unexaminedSources: Object.freeze(unexamined),
  });
}

module.exports = {
  SCHEDULE_SCHEDULED, SCHEDULE_NOT_SCHEDULED,
  STARTED, NOT_STARTED,
  SOURCE_SCANNER, SOURCE_MANUAL_MARK, SOURCE_UNKNOWN,
  GATE_ALLOWED, GATE_BLOCKED,
  EVENTS_PRESENT, EVENTS_NONE,
  MANUAL_MARK_SUFFIX, STARTABLE_STATUSES, TERMINAL_STATUSES,
  EXCEPTION_SOURCE_ORDER,
  readTimestamp,
  deriveScheduleMembership,
  deriveProductionSource,
  deriveProductionStarted,
  deriveCanStartProduction,
  deriveUnreleasedStartOccurrences,
  deriveCombinedExceptions,
};
