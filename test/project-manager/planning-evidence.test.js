// test/project-manager/planning-evidence.test.js
//
// Chunk 4B.2B. The §7 facts that need evidence from outside the WorkOrder,
// as truth tables over already-loaded plain data.
//
// No database. The module imports no mongoose, no model and no router, so
// schedule membership, execution evidence, the start gate, durable
// unreleased-start occurrences and the combined exception set are all provable
// in isolation.
//
// ── THE FOUR CLAIMS THESE TESTS DEFEND ──────────────────────────────────────
// 1. `WorkOrder.status === "scheduled"` is NOT schedule membership.
// 2. A failed lookup is NOT an empty result.
// 3. A release NEVER erases a historical unreleased-start occurrence.
// 4. A W10 manual mark is NEVER reported as a device scan.
"use strict";

const {
  SCHEDULE_SCHEDULED, SCHEDULE_NOT_SCHEDULED,
  STARTED, NOT_STARTED,
  SOURCE_SCANNER, SOURCE_MANUAL_MARK, SOURCE_UNKNOWN,
  GATE_ALLOWED, GATE_BLOCKED,
  EVENTS_PRESENT, EVENTS_NONE,
  EXCEPTION_SOURCE_ORDER,
  readTimestamp,
  deriveScheduleMembership, deriveProductionSource, deriveProductionStarted,
  deriveCanStartProduction, deriveUnreleasedStartOccurrences, deriveCombinedExceptions,
} = require("../../services/manufacturing/planningEvidence");
const {
  FACT_UNAVAILABLE, isReady,
  derivePlanningState, deriveMaterialsIssued, deriveMaterialsReady,
  deriveOperationsReady, derivePlanningCompleteable,
} = require("../../services/manufacturing/planningFacts");

const codes = (fact) => fact.exceptions.map((e) => e.code);
const line = (allocationStatus) => ({ rawItemId: "r1", quantityRequired: 10, allocationStatus });

const segment = (over = {}) => ({
  _id: "seg1",
  workOrderId: "wo1",
  scheduledStartTime: new Date("2026-09-10T03:30:00.000Z"),
  scheduledEndTime: new Date("2026-09-10T11:30:00.000Z"),
  durationMinutes: 480,
  position: 2,
  status: "scheduled",
  ...over,
});
const placement = (over = {}) => ({ scheduleId: "sch1", scheduleDate: "2026-09-10", segment: segment(), ...over });

const scan = (scannedBy) => ({ barcodeId: "WO-abc12345-1", scannedAt: new Date("2026-09-11T05:00:00.000Z"), scannedBy });
const MANUAL = scan("Rishee Ray (manual mark)");
const DEVICE = scan("Device 04");

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/* ═══ 0 · TIMESTAMP READING ═══════════════════════════════════════════════ */

describe("timestamps are read, never coerced", () => {
  test.each([undefined, null])("%p is absent", (v) => expect(readTimestamp(v)).toEqual({ absent: true }));

  test.each([
    ["a boolean", true],
    ["an array", []],
    ["an object", {}],
    ["a blank string", "   "],
    ["an unparseable string", "soon"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an Invalid Date", new Date("nope")],
  ])("%s is malformed, not absent and not a date", (_l, v) => {
    expect(readTimestamp(v)).toEqual({ malformed: true });
  });

  test("`new Date(true)` would have invented 1970 — it is rejected instead", () => {
    // `true` numeric-coerces to 1, so the coercion yields 1ms after the epoch:
    // a perfectly valid-looking Date invented out of a boolean.
    expect(new Date(true).getTime()).toBe(1);          // the trap
    expect(Number.isNaN(new Date(true).getTime())).toBe(false);
    expect(readTimestamp(true).malformed).toBe(true);  // the guard
  });

  test.each([
    ["a Date", new Date("2026-09-10T00:00:00.000Z")],
    ["an ISO string", "2026-09-10T00:00:00.000Z"],
    ["an epoch number", 1789000000000],
  ])("%s is valid", (_l, v) => expect(readTimestamp(v).value).toBe(v));
});

/* ═══ 1 · SCHEDULE MEMBERSHIP ═════════════════════════════════════════════ */

describe("schedule membership comes from ProductionSchedule, never from status", () => {
  test("a successful lookup with zero placements is CONFIDENTLY not scheduled", () => {
    expect(deriveScheduleMembership({ ok: true, placements: [] })).toEqual({
      state: SCHEDULE_NOT_SCHEDULED, placements: [], placementCount: 0, exceptions: [],
    });
  });

  test("one valid segment → scheduled, with only established facts", () => {
    const fact = deriveScheduleMembership({ ok: true, placements: [placement()] });
    expect(fact.state).toBe(SCHEDULE_SCHEDULED);
    expect(fact.placementCount).toBe(1);
    expect(fact.placements[0]).toEqual({
      scheduleId: "sch1",
      scheduleDate: "2026-09-10",
      segmentId: "seg1",
      scheduledStart: segment().scheduledStartTime,
      scheduledEnd: segment().scheduledEndTime,
      position: 2,
      status: "scheduled",
    });
  });

  test("no capacity, ownership or readiness is fabricated", () => {
    const fact = deriveScheduleMembership({
      ok: true,
      placements: [placement({ segment: segment({ exceedsCapacity: true, colorCode: "#fff" }) })],
    });
    const keys = Object.keys(fact.placements[0]);
    expect(keys).not.toContain("exceedsCapacity");
    expect(keys).not.toContain("colorCode");
    expect(keys).not.toContain("ready");
    expect(keys).not.toContain("owner");
  });

  test("a legitimate multi-day work order keeps EVERY segment", () => {
    // Collapsing three days to one arbitrary day would silently lose the plan.
    const days = [1, 2, 3].map((day) => placement({
      scheduleId: `sch${day}`,
      scheduleDate: `2026-09-1${day}`,
      segment: segment({
        _id: `seg${day}`, isMultiDay: true, currentDayNumber: day, totalDaysSpanned: 3,
      }),
    }));
    const fact = deriveScheduleMembership({ ok: true, placements: days });
    expect(fact.state).toBe(SCHEDULE_SCHEDULED);
    expect(fact.placementCount).toBe(3);
    expect(fact.placements.map((p) => p.dayNumber)).toEqual([1, 2, 3]);
    expect(fact.placements.map((p) => p.segmentId)).toEqual(["seg1", "seg2", "seg3"]);
    expect(fact.placements.every((p) => p.totalDays === 3)).toBe(true);
  });

  test.each([
    ["a failed lookup", { ok: false, reason: "connection_lost" }],
    ["no lookup result", undefined],
    ["a result with no ok flag", { placements: [] }],
    ["ok but no placements array", { ok: true }],
  ])("%s → unavailable with scheduleLookupUnavailable", (_l, lookup) => {
    const fact = deriveScheduleMembership(lookup);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["scheduleLookupUnavailable"]);
    expect(fact.placementCount).toBeNull();
  });

  test("a malformed schedule reference → unavailable, named", () => {
    const fact = deriveScheduleMembership({ ok: true, placements: [placement({ scheduleId: null })] });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["scheduleReferenceMalformed"]);
  });

  test.each([
    ["a non-object placement", placement({ segment: undefined })],
    ["a segment with no id", placement({ segment: segment({ _id: null }) })],
    ["a segment with no start time", placement({ segment: segment({ scheduledStartTime: null }) })],
    ["a segment with an unreadable end time", placement({ segment: segment({ scheduledEndTime: "soon" }) })],
  ])("%s → unavailable with schedulePlacementMalformed", (_l, bad) => {
    const fact = deriveScheduleMembership({ ok: true, placements: [bad] });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["schedulePlacementMalformed"]);
  });

  test("status 'scheduled' with NO membership still means not scheduled", () => {
    // The load-bearing claim. `status` is a byte someone set; membership is a
    // row in a day's scheduledWorkOrders[]. They disagree in production.
    const fact = deriveScheduleMembership({ ok: true, placements: [] });
    expect(fact.state).toBe(SCHEDULE_NOT_SCHEDULED);
  });

  test.each(["scheduled", "ready_to_start", "in_progress"])(
    "a status of %s passed alongside cannot manufacture membership", (status) => {
      // Behavioural, not structural: even if a caller hands the status in, the
      // answer is decided by placements alone.
      expect(deriveScheduleMembership({ ok: true, placements: [] }, status).state)
        .toBe(SCHEDULE_NOT_SCHEDULED);
      expect(deriveScheduleMembership({ ok: false }, status).state).toBe(FACT_UNAVAILABLE);
    });

  test("the signature takes only the lookup — status is not a parameter", () => {
    expect(deriveScheduleMembership.length).toBe(1);
  });
});

/* ═══ 2 · PRODUCTION SOURCE ═══════════════════════════════════════════════ */

describe("a manual mark is never reported as a device scan", () => {
  test("every entry labelled '(manual mark)' → manual_mark", () => {
    expect(deriveProductionSource([MANUAL, scan("Someone Else (manual mark)")])).toBe(SOURCE_MANUAL_MARK);
  });

  test("every entry without that suffix → scanner", () => {
    expect(deriveProductionSource([DEVICE, scan("Device 11")])).toBe(SOURCE_SCANNER);
  });

  test("mixed manual and device evidence → unknown, not one or the other", () => {
    expect(deriveProductionSource([MANUAL, DEVICE])).toBe(SOURCE_UNKNOWN);
  });

  test.each([
    ["an empty label", scan("")],
    ["a blank label", scan("   ")],
    ["a missing label", { barcodeId: "x" }],
    ["a non-string label", scan(42)],
  ])("%s makes the source illegible → unknown", (_l, entry) => {
    expect(deriveProductionSource([DEVICE, entry])).toBe(SOURCE_UNKNOWN);
  });

  test.each([[undefined], [null], ["nope"], [[]]])("%p → unknown", (entries) => {
    expect(deriveProductionSource(entries)).toBe(SOURCE_UNKNOWN);
  });

  test("the suffix is matched at the END, not anywhere in the label", () => {
    expect(deriveProductionSource([scan("(manual mark) audit device")])).toBe(SOURCE_SCANNER);
  });
});

/* ═══ 3 · PRODUCTION STARTED — the §7 truth table ═════════════════════════ */

describe("productionStarted implements the §7 table row by row", () => {
  const okLedger = (entries = []) => ({ ok: true, entries });
  const TS = new Date("2026-09-11T04:00:00.000Z");

  test("valid timestamp + in_progress → started, no exception", () => {
    expect(deriveProductionStarted({ status: "in_progress", actualStartDate: TS, ledger: okLedger([DEVICE]) })).toEqual({
      state: STARTED, startedAt: TS, source: SOURCE_SCANNER, exceptions: [],
    });
  });

  test.each(["pending", "planned", "scheduled"])(
    "valid timestamp + %s → STARTED plus startedButNotInProgress", (status) => {
      const fact = deriveProductionStarted({ status, actualStartDate: TS, ledger: okLedger([DEVICE]) });
      expect(fact.state).toBe(STARTED);       // evidence is never erased
      expect(fact.startedAt).toBe(TS);
      expect(codes(fact)).toEqual(["startedButNotInProgress"]);
    });

  test("ledger entries with no timestamp → started, startedAt null, startedWithoutTimestamp", () => {
    const fact = deriveProductionStarted({ status: "scheduled", ledger: okLedger([MANUAL]) });
    expect(fact.state).toBe(STARTED);
    expect(fact.startedAt).toBeNull();
    expect(fact.source).toBe(SOURCE_MANUAL_MARK);
    expect(codes(fact)).toEqual(["startedWithoutTimestamp"]);
  });

  test("in_progress with neither timestamp nor ledger evidence → not started + inProgressWithoutEvidence", () => {
    const fact = deriveProductionStarted({ status: "in_progress", ledger: okLedger([]) });
    expect(fact.state).toBe(NOT_STARTED);
    expect(fact.startedAt).toBeNull();
    expect(fact.source).toBeNull();
    expect(codes(fact)).toEqual(["inProgressWithoutEvidence"]);
  });

  test.each(["pending", "planned", "scheduled", "ready_to_start"])(
    "no evidence and %s → plain not started, no exception", (status) => {
      expect(deriveProductionStarted({ status, ledger: okLedger([]) })).toEqual({
        state: NOT_STARTED, startedAt: null, source: null, exceptions: [],
      });
    });

  test.each([
    ["a failed lookup", { ok: false, reason: "timeout" }],
    ["no ledger result", undefined],
    ["ok with no entries array", { ok: true }],
  ])("%s and no timestamp → unavailable + executionEvidenceUnavailable", (_l, ledger) => {
    const fact = deriveProductionStarted({ status: "in_progress", ledger });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(fact.startedAt).toBeNull();
    expect(fact.source).toBeNull();
    expect(codes(fact)).toEqual(["executionEvidenceUnavailable"]);
  });

  test("a failed ledger does NOT erase a proven start — it only downgrades the source", () => {
    // §7's "ledger unreadable → unavailable" row assumes no timestamp. A valid
    // actualStartDate is independent evidence and stands on its own.
    const fact = deriveProductionStarted({ status: "in_progress", actualStartDate: TS, ledger: { ok: false } });
    expect(fact.state).toBe(STARTED);
    expect(fact.startedAt).toBe(TS);
    expect(fact.source).toBe(SOURCE_UNKNOWN);
    expect(codes(fact)).toEqual(["executionEvidenceUnavailable"]);
  });

  test("timestamp-only evidence has no legible source → unknown, still started", () => {
    const fact = deriveProductionStarted({ status: "in_progress", actualStartDate: TS, ledger: okLedger([]) });
    expect(fact.state).toBe(STARTED);
    expect(fact.source).toBe(SOURCE_UNKNOWN);
  });

  test("an INVALID non-null timestamp is malformed, not missing", () => {
    const fact = deriveProductionStarted({ status: "in_progress", actualStartDate: "soon", ledger: okLedger([]) });
    expect(fact.state).toBe(FACT_UNAVAILABLE);   // something is stored, unreadable
    expect(codes(fact)).toContain("actualStartDateMalformed");
  });

  test("a malformed timestamp does not erase a ledger-proven start", () => {
    const fact = deriveProductionStarted({ status: "in_progress", actualStartDate: true, ledger: okLedger([MANUAL]) });
    expect(fact.state).toBe(STARTED);
    expect(fact.source).toBe(SOURCE_MANUAL_MARK);
    expect(codes(fact)).toEqual(["actualStartDateMalformed", "startedWithoutTimestamp"]);
  });

  test("mixed ledger sources keep the start and only blur the source", () => {
    const fact = deriveProductionStarted({ status: "in_progress", ledger: okLedger([MANUAL, DEVICE]) });
    expect(fact.state).toBe(STARTED);
    expect(fact.source).toBe(SOURCE_UNKNOWN);
  });

  test("a manual-mark-only start is labelled manual_mark, never scanner", () => {
    expect(deriveProductionStarted({ status: "in_progress", actualStartDate: TS, ledger: okLedger([MANUAL]) }).source)
      .toBe(SOURCE_MANUAL_MARK);
  });

  test("genuine not-started is distinguishable from unavailable", () => {
    expect(deriveProductionStarted({ status: "pending", ledger: okLedger([]) }).state).toBe(NOT_STARTED);
    expect(deriveProductionStarted({ status: "pending", ledger: { ok: false } }).state).toBe(FACT_UNAVAILABLE);
  });
});

/* ═══ 4 · CAN START PRODUCTION ════════════════════════════════════════════ */

describe("canStartProduction enforces all six approved conditions", () => {
  const issued = deriveMaterialsIssued([line("issued")]);
  const notIssued = deriveMaterialsIssued([line("fully_allocated")]);
  const issuedUnavailable = deriveMaterialsIssued([]);
  const notStarted = deriveProductionStarted({ status: "scheduled", ledger: { ok: true, entries: [] } });
  const started = deriveProductionStarted({ status: "in_progress", actualStartDate: new Date("2026-09-11"), ledger: { ok: true, entries: [] } });
  const startUnavailable = deriveProductionStarted({ status: "scheduled", ledger: { ok: false } });

  const allowedInput = {
    planningState: "released", materialsIssued: issued, status: "scheduled", productionStarted: notStarted,
  };

  test("all six satisfied → allowed", () => {
    expect(deriveCanStartProduction(allowedInput)).toEqual({
      state: GATE_ALLOWED, blockedBy: [], unavailableBecause: [], exceptions: [],
    });
  });

  test("ready_to_start also satisfies the status gate", () => {
    expect(deriveCanStartProduction({ ...allowedInput, status: "ready_to_start" }).state).toBe(GATE_ALLOWED);
  });

  test.each(["not_started", "in_progress", "complete"])(
    "planningState %s → blocked, planningStateNotReleased", (planningState) => {
      const fact = deriveCanStartProduction({ ...allowedInput, planningState });
      expect(fact.state).toBe(GATE_BLOCKED);
      expect(fact.blockedBy).toContain("planningStateNotReleased");
    });

  test("planningState unknown → blocked with BOTH codes, since the remedies differ", () => {
    // "not released" needs a release; "unknown" needs a human classification.
    const fact = deriveCanStartProduction({ ...allowedInput, planningState: "unknown" });
    expect(fact.state).toBe(GATE_BLOCKED);
    expect(fact.blockedBy).toEqual(["planningStateUnknown", "planningStateNotReleased"]);
  });

  test("a planning-state FACT object is accepted, not just a bare string", () => {
    expect(deriveCanStartProduction({ ...allowedInput, planningState: derivePlanningState("released") }).state)
      .toBe(GATE_ALLOWED);
    expect(deriveCanStartProduction({ ...allowedInput, planningState: derivePlanningState(undefined) }).blockedBy)
      .toContain("planningStateUnknown");
  });

  test("materials not issued → blocked, materialsNotIssued", () => {
    const fact = deriveCanStartProduction({ ...allowedInput, materialsIssued: notIssued });
    expect(fact.state).toBe(GATE_BLOCKED);
    expect(fact.blockedBy).toEqual(["materialsNotIssued"]);
  });

  test("a legitimate no-materials order still passes the issued gate", () => {
    const none = deriveMaterialsIssued([], { bomSnapshot: { requiredLineCount: 0 } });
    expect(isReady(none)).toBe(true);
    expect(deriveCanStartProduction({ ...allowedInput, materialsIssued: none }).state).toBe(GATE_ALLOWED);
  });

  test.each(["pending", "planned", "in_progress", "paused", "delayed", "partial_allocation"])(
    "status %s → blocked, statusNotStartable", (status) => {
      const fact = deriveCanStartProduction({ ...allowedInput, status });
      expect(fact.state).toBe(GATE_BLOCKED);
      expect(fact.blockedBy).toContain("statusNotStartable");
    });

  test.each(["completed", "cancelled", "forwarded"])("terminal status %s → blocked, statusTerminal", (status) => {
    const fact = deriveCanStartProduction({ ...allowedInput, status });
    expect(fact.state).toBe(GATE_BLOCKED);
    expect(fact.blockedBy).toContain("statusTerminal");
    expect(fact.blockedBy).not.toContain("statusNotStartable");
  });

  test("already started → blocked, productionAlreadyStarted", () => {
    const fact = deriveCanStartProduction({ ...allowedInput, productionStarted: started });
    expect(fact.state).toBe(GATE_BLOCKED);
    expect(fact.blockedBy).toEqual(["productionAlreadyStarted"]);
  });

  test("every failing condition is reported, not just the first", () => {
    const fact = deriveCanStartProduction({
      planningState: "unknown", materialsIssued: notIssued, status: "completed", productionStarted: started,
    });
    expect(fact.blockedBy).toEqual([
      "planningStateUnknown", "planningStateNotReleased",
      "materialsNotIssued", "statusTerminal", "productionAlreadyStarted",
    ]);
  });

  test.each([
    ["materials-issued unavailable", { materialsIssued: issuedUnavailable }],
    ["production evidence unavailable", { productionStarted: startUnavailable }],
    ["no planning state", { planningState: undefined }],
    ["no status", { status: undefined }],
    ["nothing supplied at all", null],
  ])("%s → unavailable, never allowed", (_l, override) => {
    const fact = deriveCanStartProduction(override === null ? {} : { ...allowedInput, ...override });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(fact.state).not.toBe(GATE_ALLOWED);
    expect(fact.unavailableBecause.length).toBeGreaterThan(0);
  });

  test("a definite block outranks an unavailable — we already know it is not allowed", () => {
    const fact = deriveCanStartProduction({
      ...allowedInput, status: "completed", materialsIssued: issuedUnavailable,
    });
    expect(fact.state).toBe(GATE_BLOCKED);
    expect(fact.blockedBy).toContain("statusTerminal");
    expect(fact.unavailableBecause).toContain("materialsIssuedUnavailable");
  });

  test("schedule membership is NOT a prerequisite — no new gate was added", () => {
    const withoutSchedule = deriveCanStartProduction(allowedInput);
    const withUnscheduled = deriveCanStartProduction({
      ...allowedInput, schedule: deriveScheduleMembership({ ok: true, placements: [] }),
    });
    const withFailedLookup = deriveCanStartProduction({
      ...allowedInput, schedule: deriveScheduleMembership({ ok: false }),
    });
    expect(withoutSchedule.state).toBe(GATE_ALLOWED);
    expect(withUnscheduled.state).toBe(GATE_ALLOWED);
    expect(withFailedLookup.state).toBe(GATE_ALLOWED);
  });
});

/* ═══ 5 · DURABLE UNRELEASED-START OCCURRENCES ════════════════════════════ */

describe("an unreleased-start occurrence is historical and survives a release", () => {
  const event = (over = {}) => ({
    _id: "ev1", source: SOURCE_MANUAL_MARK, observedAt: new Date("2026-09-11T04:00:00.000Z"),
    workOrderId: "wo1", planningStateAtObservation: "in_progress", evidenceId: "scan-77", ...over,
  });

  test("an unresolved occurrence is present and counted", () => {
    const fact = deriveUnreleasedStartOccurrences({ ok: true, events: [event()] });
    expect(fact.state).toBe(EVENTS_PRESENT);
    expect(fact.occurrenceCount).toBe(1);
    expect(fact.unresolvedCount).toBe(1);
    expect(fact.occurrences[0].resolved).toBe(false);
    expect(fact.occurrences[0].source).toBe(SOURCE_MANUAL_MARK);
    expect(fact.occurrences[0].planningStateAtObservation).toBe("in_progress");
  });

  test("a resolved occurrence is distinct from an unresolved one", () => {
    const fact = deriveUnreleasedStartOccurrences({
      ok: true, events: [event(), event({ _id: "ev2", resolvedAt: new Date("2026-09-12") })],
    });
    expect(fact.occurrenceCount).toBe(2);
    expect(fact.unresolvedCount).toBe(1);
    expect(fact.occurrences.map((o) => o.resolved)).toEqual([false, true]);
  });

  test("a LATER release does not delete, rewrite or filter the occurrence", () => {
    // The load-bearing claim of §9.2. A derived comparison would vanish here.
    const store = { ok: true, events: [event()] };
    const before = deriveUnreleasedStartOccurrences(store, "in_progress");
    const after = deriveUnreleasedStartOccurrences(store, "released");

    expect(after.occurrenceCount).toBe(before.occurrenceCount);
    expect(after.occurrences[0].eventId).toBe("ev1");
    expect(after.occurrences[0].observedAt).toEqual(before.occurrences[0].observedAt);
    expect(after.occurrences[0].planningStateAtObservation).toBe("in_progress");
    // Release only offers to RESOLVE it, as a display hint.
    expect(before.occurrences[0].resolvableByCurrentRelease).toBe(false);
    expect(after.occurrences[0].resolvableByCurrentRelease).toBe(true);
    expect(after.occurrences[0].resolved).toBe(false);
  });

  test("an already-resolved occurrence is not re-offered for resolution", () => {
    const fact = deriveUnreleasedStartOccurrences(
      { ok: true, events: [event({ resolvedAt: new Date("2026-09-12") })] }, "released",
    );
    expect(fact.occurrences[0].resolved).toBe(true);
    expect(fact.occurrences[0].resolvableByCurrentRelease).toBe(false);
  });

  test("multiple distinct occurrences all survive", () => {
    const fact = deriveUnreleasedStartOccurrences({
      ok: true,
      events: [
        event({ _id: "ev1", source: SOURCE_SCANNER }),
        event({ _id: "ev2", source: SOURCE_MANUAL_MARK }),
        event({ _id: "ev3", source: SOURCE_UNKNOWN }),
      ],
    }, "released");
    expect(fact.occurrenceCount).toBe(3);
    expect(fact.occurrences.map((o) => o.eventId)).toEqual(["ev1", "ev2", "ev3"]);
    expect(fact.occurrences.map((o) => o.source)).toEqual([SOURCE_SCANNER, SOURCE_MANUAL_MARK, SOURCE_UNKNOWN]);
  });

  test("a successful lookup with no events → none, confidently", () => {
    expect(deriveUnreleasedStartOccurrences({ ok: true, events: [] })).toEqual({
      state: EVENTS_NONE, occurrences: [], occurrenceCount: 0, unresolvedCount: 0, exceptions: [],
    });
  });

  test.each([
    ["no event store at all (step 8 not built yet)", undefined],
    ["a failed lookup", { ok: false, reason: "collection_missing" }],
    ["ok with no events array", { ok: true }],
    ["a result with no ok flag", { events: [] }],
  ])("%s → unavailable, NOT 'none'", (_l, store) => {
    const fact = deriveUnreleasedStartOccurrences(store, "released");
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["unreleasedStartEventsUnavailable"]);
    expect(fact.occurrenceCount).toBeNull();
  });

  test.each([
    ["a non-object event", null],
    ["an event with no id", { source: SOURCE_SCANNER, observedAt: new Date("2026-09-11") }],
    ["an event with an unreadable observedAt", { _id: "ev9", observedAt: "soon" }],
    ["an event with no observedAt", { _id: "ev9" }],
  ])("%s → unavailable with unreleasedStartEventMalformed", (_l, bad) => {
    const fact = deriveUnreleasedStartOccurrences({ ok: true, events: [event(), bad] });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["unreleasedStartEventMalformed"]);
  });

  test("current planning state is never evidence of an occurrence", () => {
    // An unreleased work order with a started production but NO durable event
    // must not manufacture one.
    const fact = deriveUnreleasedStartOccurrences({ ok: true, events: [] }, "not_started");
    expect(fact.state).toBe(EVENTS_NONE);
    expect(fact.occurrenceCount).toBe(0);
  });
});

/* ═══ 6 · COMBINED EXCEPTIONS ═════════════════════════════════════════════ */

describe("the combined exception set is deterministic and never falsely empty", () => {
  const materials = deriveMaterialsReady([line("partially_allocated")]);
  const materialsIssued = deriveMaterialsIssued([line("partially_allocated")]);
  const operations = deriveOperationsReady([{ _id: "op1", plannedTimeSeconds: 30 }]);
  const schedule = deriveScheduleMembership({ ok: true, placements: [placement()] });
  const productionStarted = deriveProductionStarted({ status: "pending", actualStartDate: new Date("2026-09-11"), ledger: { ok: true, entries: [DEVICE] } });
  const unreleasedStarts = deriveUnreleasedStartOccurrences({ ok: true, events: [] });
  const SHORTAGE = {
    shortageAccepted: true, shortageReason: "Ship date", shortageAcceptedBy: { id: "e1" },
    shortageAcceptedAt: "2026-09-03", shortageLines: [{ rawItemId: "r1" }],
  };
  const completeable = derivePlanningCompleteable({ materials, operations, shortage: SHORTAGE });

  const allExamined = {
    planningState: derivePlanningState("in_progress"),
    materials, materialsIssued, operations, completeable, schedule, productionStarted, unreleasedStarts,
  };

  test("every source examined and none in exception → empty, state none", () => {
    const clean = deriveCombinedExceptions({
      planningState: derivePlanningState("released"),
      materials: deriveMaterialsReady([line("issued")]),
      materialsIssued: deriveMaterialsIssued([line("issued")]),
      operations,
      completeable: derivePlanningCompleteable({
        materials: deriveMaterialsReady([line("issued")]), operations,
      }),
      schedule,
      productionStarted: deriveProductionStarted({ status: "pending", ledger: { ok: true, entries: [] } }),
      unreleasedStarts,
    });
    expect(clean).toEqual({ state: EVENTS_NONE, exceptions: [], count: 0, unexaminedSources: [] });
  });

  test("order follows the fixed source order, not the caller's key order", () => {
    const forward = deriveCombinedExceptions(allExamined);
    const reversed = {};
    [...Object.keys(allExamined)].reverse().forEach((k) => { reversed[k] = allExamined[k]; });
    expect(deriveCombinedExceptions(reversed).exceptions).toEqual(forward.exceptions);
    expect(EXCEPTION_SOURCE_ORDER).toEqual([
      "planningState", "materials", "materialsIssued", "operations",
      "completeable", "schedule", "productionStarted", "unreleasedStarts",
    ]);
  });

  test("an accepted shortage is retained BESIDE the not-ready material fact", () => {
    const fact = deriveCombinedExceptions(allExamined);
    expect(codes(fact)).toContain("acceptedShortage");
    expect(materials.state).toBe("not_ready");   // unchanged by the shortage
    expect(fact.state).toBe(EVENTS_PRESENT);
  });

  test("a production contradiction is carried through", () => {
    expect(codes(deriveCombinedExceptions(allExamined))).toContain("startedButNotInProgress");
  });

  test("identical repeated exceptions de-duplicate", () => {
    const malformed = derivePlanningState("planned");
    const fact = deriveCombinedExceptions({
      ...allExamined, planningState: malformed, materials: { state: "not_ready", exceptions: malformed.exceptions },
    });
    expect(codes(fact).filter((c) => c === "planningStateUnrecognized")).toHaveLength(1);
  });

  test("distinct durable occurrences are NEVER de-duplicated away", () => {
    // They share a code; only the event identity distinguishes them, and
    // losing one would lose a historical violation.
    const events = deriveUnreleasedStartOccurrences({
      ok: true,
      events: [
        { _id: "ev1", source: SOURCE_SCANNER, observedAt: new Date("2026-09-11") },
        { _id: "ev2", source: SOURCE_MANUAL_MARK, observedAt: new Date("2026-09-12") },
      ],
    });
    const fact = deriveCombinedExceptions({ ...allExamined, unreleasedStarts: events });
    const occurrences = fact.exceptions.filter((e) => e.code === "productionStartedWithoutRelease");
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((e) => e.detail.eventId)).toEqual(["ev1", "ev2"]);
    expect(occurrences.map((e) => e.detail.source)).toEqual([SOURCE_SCANNER, SOURCE_MANUAL_MARK]);
  });

  test.each([
    ["a failed schedule lookup", { schedule: deriveScheduleMembership({ ok: false }) }],
    ["a failed ledger lookup", { productionStarted: deriveProductionStarted({ status: "pending", ledger: { ok: false } }) }],
    ["no durable event store", { unreleasedStarts: deriveUnreleasedStartOccurrences(undefined) }],
    ["an unsupplied source", { schedule: undefined }],
    ["unavailable materials", { materials: deriveMaterialsReady([]) }],
  ])("%s makes the set unavailable, never a confident 'no exceptions'", (_l, override) => {
    const fact = deriveCombinedExceptions({ ...allExamined, ...override });
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(fact.unexaminedSources.length).toBeGreaterThan(0);
  });

  test("missing external evidence does not become hasPlanningExceptions: false", () => {
    const fact = deriveCombinedExceptions({});
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(fact.unexaminedSources).toEqual([...EXCEPTION_SOURCE_ORDER]);
    expect(Boolean(fact)).toBe(true);   // a bare boolean would have read false
  });

  test("an unavailable source still contributes what it DID find", () => {
    const fact = deriveCombinedExceptions({
      ...allExamined, schedule: deriveScheduleMembership({ ok: false, reason: "timeout" }),
    });
    expect(codes(fact)).toContain("scheduleLookupUnavailable");
    expect(fact.unexaminedSources).toContain("schedule");
  });

  test("structured details are preserved, not flattened to codes", () => {
    const fact = deriveCombinedExceptions(allExamined);
    const shortage = fact.exceptions.find((e) => e.code === "acceptedShortage");
    expect(shortage.detail.reason).toBe("Ship date");
    expect(shortage.detail.lineCount).toBe(1);
  });
});

/* ═══ 7 · PURITY ══════════════════════════════════════════════════════════ */

describe("the module is pure and its results are frozen", () => {
  test("no helper mutates its input", () => {
    const lookup = deepFreeze({ ok: true, placements: [placement(), placement({ segment: segment({ _id: "seg2" }) })] });
    const ledger = deepFreeze({ ok: true, entries: [MANUAL, DEVICE] });
    const store = deepFreeze({ ok: true, events: [{ _id: "ev1", source: SOURCE_SCANNER, observedAt: new Date("2026-09-11") }] });

    expect(() => {
      const schedule = deriveScheduleMembership(lookup);
      const productionStarted = deriveProductionStarted({ status: "in_progress", ledger });
      const unreleasedStarts = deriveUnreleasedStartOccurrences(store, "released");
      deriveCanStartProduction({
        planningState: "released",
        materialsIssued: deriveMaterialsIssued([line("issued")]),
        status: "scheduled",
        productionStarted,
      });
      deriveCombinedExceptions({ schedule, productionStarted, unreleasedStarts });
    }).not.toThrow();

    expect(lookup.placements).toHaveLength(2);
    expect(ledger.entries).toHaveLength(2);
    expect(store.events[0]._id).toBe("ev1");
  });

  test("returned facts and their nested collections are frozen", () => {
    const schedule = deriveScheduleMembership({ ok: true, placements: [placement()] });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule.placements)).toBe(true);
    expect(Object.isFrozen(schedule.placements[0])).toBe(true);
    expect(() => { schedule.state = SCHEDULE_NOT_SCHEDULED; }).toThrow();

    const gate = deriveCanStartProduction({});
    expect(Object.isFrozen(gate)).toBe(true);
    expect(() => { gate.state = GATE_ALLOWED; }).toThrow();
  });
});
