// test/project-manager/planning-facts.test.js
//
// Chunk 4B.2A. The §7 derived planning facts that need only one WorkOrder
// document — as truth tables, not as route behaviour.
//
// These tests touch NO database. The module under test imports no mongoose, no
// model and no router, so every rule below is exercised as pure data in and
// pure data out. That is the point of the slice: policy provable in isolation
// before any adapter or route can obscure it.
//
// ── THE RULE THESE TESTS EXIST TO PROTECT ───────────────────────────────────
// `unavailable` is not `false`. "We cannot tell" and "no" are different
// answers, and only one of them is safe to plan from. Facts are structured
// objects precisely so `if (fact)` — always truthy — cannot pass an
// `unavailable` through a gate.
"use strict";

const {
  FACT_READY, FACT_NOT_READY, FACT_UNAVAILABLE,
  ORIGIN_STORED, ORIGIN_LEGACY_ABSENT, ORIGIN_MALFORMED,
  isReady, isUnavailable,
  derivePlanningState,
  deriveMaterialsReady, deriveMaterialsIssued,
  deriveOperationsReady,
  readAcceptedShortage, derivePlanningCompleteable,
  REQUIRED_EXTERNAL_EVIDENCE,
} = require("../../services/manufacturing/planningFacts");
const { normalizePlanningState } = require("../../constants/workOrderPlanningState");

const codes = (fact) => fact.exceptions.map((e) => e.code);
const line = (allocationStatus) => ({ rawItemId: "r1", quantityRequired: 10, allocationStatus });
const op = (over = {}) => ({ _id: "op1", operationCode: "SJ-01", plannedTimeSeconds: 120, ...over });

/** Recursively freeze, so any attempt to mutate an input throws in strict mode. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const VALID_SHORTAGE = {
  shortageAccepted: true,
  shortageReason: "Customer accepted a short run to hit the ship date",
  shortageAcceptedBy: { id: "e1", email: "pm@grav.in" },
  shortageAcceptedAt: "2026-09-03T10:00:00.000Z",
  shortageLines: [{ rawItemId: "r1", quantityRequired: 10, quantityAllocated: 4 }],
};

/* ═══ 1 · PLANNING STATE ══════════════════════════════════════════════════ */

describe("planning state keeps WHY it became unknown", () => {
  test.each(["unknown", "not_started", "in_progress", "complete", "released"])(
    "%s survives as a stored value", (value) => {
      expect(derivePlanningState(value)).toEqual({
        value, origin: ORIGIN_STORED, storedValue: value, exceptions: [],
      });
    });

  test.each([undefined, null])("%p is legacy absence, not a defect", (value) => {
    expect(derivePlanningState(value)).toEqual({
      value: "unknown", origin: ORIGIN_LEGACY_ABSENT, storedValue: null, exceptions: [],
    });
  });

  test.each(["planned", "", "RELEASED", 3, {}])(
    "%p is malformed — unknown, but distinguishably so", (stored) => {
      const fact = derivePlanningState(stored);
      expect(fact.value).toBe("unknown");
      expect(fact.origin).toBe(ORIGIN_MALFORMED);
      expect(codes(fact)).toEqual(["planningStateUnrecognized"]);
    });

  test("legacy absence and a malformed value are NOT the same fact", () => {
    // Both project to `unknown`. Only one of them is a defect worth surfacing,
    // and collapsing them would bury a bad write in the legacy population.
    const absent = derivePlanningState(undefined);
    const malformed = derivePlanningState("planned");
    expect(absent.value).toBe(malformed.value);
    expect(absent.origin).not.toBe(malformed.origin);
    expect(absent.exceptions).toHaveLength(0);
    expect(malformed.exceptions).toHaveLength(1);
  });

  test("normalizePlanningState stays backward-compatible", () => {
    for (const v of ["unknown", "not_started", "in_progress", "complete", "released"]) {
      expect(normalizePlanningState(v)).toBe(derivePlanningState(v).value);
    }
    expect(normalizePlanningState(undefined)).toBe("unknown");
    expect(normalizePlanningState("planned")).toBe("unknown");
  });

  test("projection performs no write — the input is untouched", () => {
    const doc = deepFreeze({ planningState: "complete" });
    expect(() => derivePlanningState(doc.planningState)).not.toThrow();
    expect(doc).toEqual({ planningState: "complete" });
  });
});

/* ═══ 2 · MATERIALS READY ═════════════════════════════════════════════════ */

describe("materialsReady — an empty array is never self-evident", () => {
  const ready = (rawMaterials, evidence) => deriveMaterialsReady(rawMaterials, evidence);

  test("every line fully_allocated → ready", () => {
    expect(ready([line("fully_allocated"), line("fully_allocated")])).toEqual({
      state: FACT_READY, noMaterialsRequired: false, lineCount: 2, exceptions: [],
    });
  });

  test("every line issued → ready (issued is further along)", () => {
    expect(ready([line("issued")]).state).toBe(FACT_READY);
  });

  test("mixed fully_allocated and issued → ready", () => {
    expect(ready([line("fully_allocated"), line("issued")]).state).toBe(FACT_READY);
  });

  test("any partially_allocated line → not ready", () => {
    expect(ready([line("fully_allocated"), line("partially_allocated")]).state).toBe(FACT_NOT_READY);
  });

  test("any not_allocated line → not ready", () => {
    expect(ready([line("issued"), line("not_allocated")]).state).toBe(FACT_NOT_READY);
  });

  test.each([undefined, null, "nope", 7, {}])("%p as rawMaterials → unavailable", (value) => {
    const fact = ready(value);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["rawMaterialsUnavailable"]);
  });

  test("a malformed line → unavailable, not 'not ready'", () => {
    expect(codes(ready([line("issued"), null]))).toEqual(["rawMaterialLineMalformed"]);
  });

  test("a line with no allocationStatus → unavailable", () => {
    expect(codes(ready([{ rawItemId: "r1" }]))).toEqual(["allocationStatusMissing"]);
  });

  test("an unknown allocation enum → unavailable", () => {
    const fact = ready([line("reserved")]);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["allocationStatusUnrecognized"]);
  });

  test("a structural defect outranks a would-be 'not ready'", () => {
    // not_allocated alone would be `not_ready`; the malformed sibling makes the
    // whole fact unavailable, because we can no longer see every line.
    expect(ready([line("not_allocated"), line("reserved")]).state).toBe(FACT_UNAVAILABLE);
  });

  test("empty + zero-line BOM snapshot → ready, noMaterialsRequired", () => {
    expect(ready([], { bomSnapshot: { requiredLineCount: 0 } })).toEqual({
      state: FACT_READY, noMaterialsRequired: true, lineCount: 0, exceptions: [],
    });
  });

  test("empty + an explicit no-materials decision → ready", () => {
    expect(ready([], {
      noMaterialsRequired: { decidedBy: "e1", decidedAt: "2026-09-03", reason: "Service-only order" },
    }).state).toBe(FACT_READY);
  });

  test("empty WITHOUT evidence → unavailable, never ready", () => {
    // The `[].every() === true` trap. This is the assertion that stops it
    // becoming product policy by accident.
    const fact = ready([]);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["emptyMaterialsWithoutEvidence"]);
    expect(isReady(fact)).toBe(false);
  });

  test.each([
    ["a snapshot with lines", { bomSnapshot: { requiredLineCount: 3 } }],
    ["a snapshot with no count", { bomSnapshot: {} }],
    ["a decision with no reason", { noMaterialsRequired: { decidedBy: "e1", decidedAt: "x", reason: "  " } }],
    ["a decision with no actor", { noMaterialsRequired: { decidedAt: "x", reason: "why" } }],
    ["a bare truthy flag", { noMaterialsRequired: true }],
  ])("empty + %s is not affirmative evidence", (_label, evidence) => {
    expect(ready([], evidence).state).toBe(FACT_UNAVAILABLE);
  });

  test("an accepted shortage does NOT make materials ready", () => {
    // A shortage buys a completion with an exception. It never rewrites this.
    const fact = deriveMaterialsReady([line("partially_allocated")], { shortage: VALID_SHORTAGE });
    expect(fact.state).toBe(FACT_NOT_READY);
  });
});

/* ═══ 3 · MATERIALS ISSUED ════════════════════════════════════════════════ */

describe("materialsIssued — Store owns the issued transition", () => {
  test("every line issued → ready", () => {
    expect(deriveMaterialsIssued([line("issued"), line("issued")]).state).toBe(FACT_READY);
  });

  test("mixed allocated and issued → NOT ready (allocated is not issued)", () => {
    expect(deriveMaterialsIssued([line("fully_allocated"), line("issued")]).state).toBe(FACT_NOT_READY);
  });

  test.each(["not_allocated", "partially_allocated", "fully_allocated"])(
    "%s → not ready", (status) => {
      expect(deriveMaterialsIssued([line(status)]).state).toBe(FACT_NOT_READY);
    });

  test("empty + affirmative evidence → ready", () => {
    expect(deriveMaterialsIssued([], { bomSnapshot: { requiredLineCount: 0 } })).toEqual({
      state: FACT_READY, noMaterialsRequired: true, lineCount: 0, exceptions: [],
    });
  });

  test("empty without evidence → unavailable", () => {
    expect(deriveMaterialsIssued([]).state).toBe(FACT_UNAVAILABLE);
  });

  test.each([undefined, "nope"])("%p → unavailable", (value) => {
    expect(deriveMaterialsIssued(value).state).toBe(FACT_UNAVAILABLE);
  });

  test("an unknown enum → unavailable", () => {
    expect(deriveMaterialsIssued([line("reserved")]).state).toBe(FACT_UNAVAILABLE);
  });

  test("an accepted shortage does NOT make materials issued", () => {
    expect(deriveMaterialsIssued([line("partially_allocated")], { shortage: VALID_SHORTAGE }).state)
      .toBe(FACT_NOT_READY);
  });
});

/* ═══ 4 · OPERATIONS ══════════════════════════════════════════════════════ */

describe("operationsReady — and the explicit-zero limitation", () => {
  test("every operation with a positive finite duration → ready", () => {
    expect(deriveOperationsReady([op({ _id: "a" }), op({ _id: "b", plannedTimeSeconds: 45 })])).toEqual({
      state: FACT_READY, operationCount: 2, zeroDurationDegraded: false, exceptions: [],
    });
  });

  test("an empty array → not ready — an empty plan is not a plan", () => {
    // Legible, not missing: we can see there are no operations.
    expect(deriveOperationsReady([])).toEqual({
      state: FACT_NOT_READY, operationCount: 0, zeroDurationDegraded: false, exceptions: [],
    });
  });

  test.each([undefined, null, "nope", 7])("%p as operations → unavailable", (value) => {
    const fact = deriveOperationsReady(value);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["operationsUnavailable"]);
  });

  test("a missing _id → unavailable", () => {
    expect(codes(deriveOperationsReady([op({ _id: undefined })]))).toEqual(["operationIdMissing"]);
    expect(codes(deriveOperationsReady([op({ _id: "  " })]))).toEqual(["operationIdMissing"]);
  });

  test("duplicate _ids → unavailable", () => {
    const fact = deriveOperationsReady([op({ _id: "same" }), op({ _id: "same" })]);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["operationIdDuplicated"]);
  });

  test("ids are compared by string value, so ObjectId-like objects still collide", () => {
    const id = { toString: () => "64b7f0c2e1a2b3c4d5e6f7a8" };
    expect(deriveOperationsReady([op({ _id: id }), op({ _id: id })]).state).toBe(FACT_UNAVAILABLE);
  });

  test("a missing duration → not ready", () => {
    const fact = deriveOperationsReady([op(), op({ _id: "b", plannedTimeSeconds: undefined })]);
    expect(fact.state).toBe(FACT_NOT_READY);
    expect(fact.zeroDurationDegraded).toBe(false);
  });

  test("a ZERO duration degrades to not ready (decision 14 not yet implemented)", () => {
    // The schema declares `plannedTimeSeconds: { default: 0 }`, so a stored 0
    // cannot be told apart from a field nobody filled in. §7 would call an
    // EXPLICIT zero ready; until the default is fixed we must not guess, so it
    // answers the same as missing — and says so.
    const fact = deriveOperationsReady([op({ _id: "a", plannedTimeSeconds: 0 })]);
    expect(fact.state).toBe(FACT_NOT_READY);
    expect(fact.zeroDurationDegraded).toBe(true);
    expect(codes(fact)).toEqual(["operationDurationZeroIndistinguishable"]);
  });

  test("a zero among positives still degrades the whole plan", () => {
    expect(deriveOperationsReady([op({ _id: "a" }), op({ _id: "b", plannedTimeSeconds: 0 })]).state)
      .toBe(FACT_NOT_READY);
  });

  test.each([
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a numeric string", "120"],
    ["a non-numeric string", "soon"],
    ["an object", {}],
    ["a boolean", true],
  ])("%s duration → unavailable", (_label, plannedTimeSeconds) => {
    const fact = deriveOperationsReady([op({ plannedTimeSeconds })]);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(codes(fact)).toEqual(["operationDurationMalformed"]);
  });

  test("a malformed operation entry → unavailable", () => {
    expect(codes(deriveOperationsReady([op(), null]))).toEqual(["operationMalformed"]);
  });

  test("a structural defect outranks a would-be 'not ready'", () => {
    expect(deriveOperationsReady([op({ _id: "a", plannedTimeSeconds: 0 }), op({ _id: undefined })]).state)
      .toBe(FACT_UNAVAILABLE);
  });
});

/* ═══ 5 · SHORTAGE MARKER ═════════════════════════════════════════════════ */

describe("the shortage marker is validated as a whole, or it is not a decision", () => {
  test("a complete marker is accepted and reported as an exception", () => {
    const read = readAcceptedShortage(VALID_SHORTAGE);
    expect(read.accepted).toBe(true);
    expect(read.exception.code).toBe("acceptedShortage");
    expect(read.exception.detail.lineCount).toBe(1);
  });

  test.each([undefined, null, {}, { shortageAccepted: false }])(
    "%p is simply no shortage, with no defect reported", (value) => {
      expect(readAcceptedShortage(value)).toEqual({ accepted: false, exception: null });
    });

  test.each([
    ["a blank reason", { shortageReason: "   " }, "shortageReason"],
    ["no actor", { shortageAcceptedBy: undefined }, "shortageAcceptedBy"],
    ["no timestamp", { shortageAcceptedAt: undefined }, "shortageAcceptedAt"],
    ["no lines", { shortageLines: undefined }, "shortageLines"],
  ])("%s is a defect, not an acceptance", (_label, override, missingField) => {
    const read = readAcceptedShortage({ ...VALID_SHORTAGE, ...override });
    expect(read.accepted).toBe(false);
    expect(read.exception.code).toBe("shortageMarkerIncomplete");
    expect(read.exception.detail.missing).toContain(missingField);
  });
});

/* ═══ 6 · PLANNING COMPLETEABLE ═══════════════════════════════════════════ */

describe("planningCompleteable — read-only, and never rewrites a fact", () => {
  const materialsReady = deriveMaterialsReady([line("fully_allocated")]);
  const materialsShort = deriveMaterialsReady([line("partially_allocated")]);
  const materialsUnavailable = deriveMaterialsReady([]);
  const opsReady = deriveOperationsReady([op()]);
  const opsNotReady = deriveOperationsReady([]);
  const opsUnavailable = deriveOperationsReady(undefined);

  test("operations ready + materials ready → ready, no exceptions", () => {
    const fact = derivePlanningCompleteable({ materials: materialsReady, operations: opsReady });
    expect(fact.state).toBe(FACT_READY);
    expect(fact.acceptedShortage).toBeNull();
    expect(fact.exceptions).toEqual([]);
  });

  test("materials short + a valid accepted shortage → ready, WITH the exception", () => {
    const fact = derivePlanningCompleteable({
      materials: materialsShort, operations: opsReady, shortage: VALID_SHORTAGE,
    });
    expect(fact.state).toBe(FACT_READY);
    expect(fact.acceptedShortage.code).toBe("acceptedShortage");
  });

  test("the shortage never rewrites materialsReady", () => {
    // The load-bearing assertion of §11.2: completion becomes possible, the
    // material fact does not improve.
    const fact = derivePlanningCompleteable({
      materials: materialsShort, operations: opsReady, shortage: VALID_SHORTAGE,
    });
    expect(fact.materials.state).toBe(FACT_NOT_READY);
    expect(isReady(fact.materials)).toBe(false);
  });

  test("materials short with NO shortage → not ready", () => {
    expect(derivePlanningCompleteable({ materials: materialsShort, operations: opsReady }).state)
      .toBe(FACT_NOT_READY);
  });

  test("an incomplete shortage marker cannot buy a completion", () => {
    const fact = derivePlanningCompleteable({
      materials: materialsShort,
      operations: opsReady,
      shortage: { ...VALID_SHORTAGE, shortageReason: "" },
    });
    expect(fact.state).toBe(FACT_NOT_READY);
    expect(fact.acceptedShortage).toBeNull();
    expect(codes(fact)).toEqual(["shortageMarkerIncomplete"]);
  });

  test("operations not ready → not ready, even with materials ready", () => {
    expect(derivePlanningCompleteable({ materials: materialsReady, operations: opsNotReady }).state)
      .toBe(FACT_NOT_READY);
  });

  test.each([
    ["operations unavailable", { materials: materialsReady, operations: opsUnavailable }],
    ["materials unavailable", { materials: materialsUnavailable, operations: opsReady }],
    ["both unavailable", { materials: materialsUnavailable, operations: opsUnavailable }],
    ["no inputs at all", {}],
  ])("%s → unavailable, never ready", (_label, input) => {
    const fact = derivePlanningCompleteable(input);
    expect(fact.state).toBe(FACT_UNAVAILABLE);
    expect(isReady(fact)).toBe(false);
  });

  test("a shortage cannot rescue UNAVAILABLE material evidence", () => {
    // A shortage is a decision about known short lines. Unknown evidence is
    // not a known shortage.
    expect(derivePlanningCompleteable({
      materials: materialsUnavailable, operations: opsReady, shortage: VALID_SHORTAGE,
    }).state).toBe(FACT_UNAVAILABLE);
  });

  test("a genuine empty operation plan is not confused with missing data", () => {
    expect(derivePlanningCompleteable({ materials: materialsReady, operations: opsNotReady }).state)
      .toBe(FACT_NOT_READY);
    expect(derivePlanningCompleteable({ materials: materialsReady, operations: opsUnavailable }).state)
      .toBe(FACT_UNAVAILABLE);
  });

  test("a genuine zero-line BOM is not confused with a missing one", () => {
    const zeroLine = deriveMaterialsReady([], { bomSnapshot: { requiredLineCount: 0 } });
    const missing = deriveMaterialsReady([]);
    expect(derivePlanningCompleteable({ materials: zeroLine, operations: opsReady }).state).toBe(FACT_READY);
    expect(derivePlanningCompleteable({ materials: missing, operations: opsReady }).state).toBe(FACT_UNAVAILABLE);
  });
});

/* ═══ 7 · PURITY AND BOUNDARY ═════════════════════════════════════════════ */

describe("the module is pure, and its boundary is explicit", () => {
  test("no helper mutates its input", () => {
    const rawMaterials = deepFreeze([line("fully_allocated"), line("partially_allocated")]);
    const operations = deepFreeze([op({ _id: "a" }), op({ _id: "b", plannedTimeSeconds: 0 })]);
    const evidence = deepFreeze({ bomSnapshot: { requiredLineCount: 0 } });
    const shortage = deepFreeze({ ...VALID_SHORTAGE });

    // Strict mode: any write to a frozen object throws.
    expect(() => {
      deriveMaterialsReady(rawMaterials, evidence);
      deriveMaterialsIssued(rawMaterials, evidence);
      deriveOperationsReady(operations);
      readAcceptedShortage(shortage);
      derivePlanningCompleteable({
        materials: deriveMaterialsReady(rawMaterials, evidence),
        operations: deriveOperationsReady(operations),
        shortage,
      });
    }).not.toThrow();

    expect(rawMaterials).toEqual([
      { rawItemId: "r1", quantityRequired: 10, allocationStatus: "fully_allocated" },
      { rawItemId: "r1", quantityRequired: 10, allocationStatus: "partially_allocated" },
    ]);
    expect(operations[1].plannedTimeSeconds).toBe(0);
    expect(shortage.shortageLines).toHaveLength(1);
  });

  test("returned facts are frozen, so a caller cannot doctor a state", () => {
    const fact = deriveOperationsReady([op()]);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(() => { fact.state = FACT_READY; }).toThrow();
  });

  test("the deferred 4B.2B facts are named, not stubbed", () => {
    // Each needs evidence this module refuses to invent or query for.
    expect(Object.keys(REQUIRED_EXTERNAL_EVIDENCE).sort()).toEqual([
      "canStartProduction", "hasPlanningExceptions", "isScheduled",
      "productionStarted", "productionStartedSource",
      "productionStartedWithoutRelease", "scheduledPlacement",
    ]);
  });

  test("isUnavailable and isReady are the only safe reads", () => {
    const unavailable = deriveMaterialsReady([]);
    expect(Boolean(unavailable)).toBe(true);   // the trap a bare boolean would set
    expect(isReady(unavailable)).toBe(false);  // the guard against it
    expect(isUnavailable(unavailable)).toBe(true);
  });
});
