// services/forecastExpectedDate.test.js
//
// Pure tests for Chunk 1-C's manual expected-date validation. No database, no
// clock — every date is supplied, so these mean the same thing on any machine.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./forecastExpectedDate.service");

const ACTOR = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Priya Editor" };
const NOW = new Date("2026-08-24T09:30:00Z");
const AS_OF = "2026-08-24";

function setBody(overrides = {}) {
  return {
    companyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    ledgerId: "cccccccccccccccccccccccc",
    billName: "RC/0091/26-27",
    forecastExpectedDate: "2026-09-15",
    asOfDate: AS_OF,
    ...overrides,
  };
}

function clearBody(overrides = {}) {
  return {
    companyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    ledgerId: "cccccccccccccccccccccccc",
    billName: "RC/0091/26-27",
    ...overrides,
  };
}

function throwsCode(fn, code, msg) {
  assert.throws(
    fn,
    (e) => {
      assert.ok(
        e instanceof svc.ForecastExpectedDateError,
        `expected ForecastExpectedDateError, got ${e && e.name}: ${e && e.message}`,
      );
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      return true;
    },
    msg,
  );
}

/* ── Happy path ──────────────────────────────────────────────────────────── */

test("a valid set payload produces scope and $set", () => {
  const r = svc.buildSet(setBody({ notes: "Confirmed by phone with AP team" }), ACTOR, NOW);

  assert.deepEqual(r.scope, {
    companyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    ledgerId: "cccccccccccccccccccccccc",
    billName: "RC/0091/26-27",
  });
  assert.equal(r.$set.forecastExpectedDate.toISOString(), "2026-09-15T00:00:00.000Z");
  assert.equal(r.$set.forecastExpectedDateSource, "manual");
  assert.equal(r.$set.forecastExpectedDateNotes, "Confirmed by phone with AP team");
  assert.equal(r.$set.forecastExpectedDateUpdatedBy, ACTOR.id);
  assert.equal(r.$set.forecastExpectedDateUpdatedByName, "Priya Editor");
  assert.equal(r.$set.forecastExpectedDateUpdatedAt, NOW);
});

test("the expected date is normalised to UTC midnight, whatever time came in", () => {
  const r = svc.buildSet(
    setBody({ forecastExpectedDate: "2026-09-15T17:45:33.123Z" }),
    ACTOR,
    NOW,
  );
  assert.equal(r.$set.forecastExpectedDate.toISOString(), "2026-09-15T00:00:00.000Z");
});

test("an expected date exactly ON asOfDate is allowed — today is a real answer", () => {
  const r = svc.buildSet(setBody({ forecastExpectedDate: AS_OF }), ACTOR, NOW);
  assert.equal(r.$set.forecastExpectedDate.toISOString(), "2026-08-24T00:00:00.000Z");
});

test("notes are optional and default to an empty string", () => {
  const r = svc.buildSet(setBody(), ACTOR, NOW);
  assert.equal(r.$set.forecastExpectedDateNotes, "");
});

test("notes are trimmed", () => {
  const r = svc.buildSet(setBody({ notes: "  chased twice  " }), ACTOR, NOW);
  assert.equal(r.$set.forecastExpectedDateNotes, "chased twice");
});

test("the $set touches ONLY forecast fields — never dueDate or anything accounting", () => {
  const r = svc.buildSet(setBody({ notes: "x" }), ACTOR, NOW);
  assert.deepEqual(Object.keys(r.$set).sort(), [
    "forecastExpectedDate",
    "forecastExpectedDateNotes",
    "forecastExpectedDateSource",
    "forecastExpectedDateUpdatedAt",
    "forecastExpectedDateUpdatedBy",
    "forecastExpectedDateUpdatedByName",
  ]);
  assert.ok(!("dueDate" in r.$set), "the contractual due date is never written here");
  assert.ok(!("source" in r.$set));
  assert.ok(!("creditDaysUsed" in r.$set));
});

/* ── Required fields ─────────────────────────────────────────────────────── */

test("companyId, ledgerId and billName are each required", () => {
  for (const field of ["companyId", "ledgerId", "billName"]) {
    const b = setBody();
    delete b[field];
    throwsCode(() => svc.buildSet(b, ACTOR, NOW), "REQUIRED", `${field} should be required`);
    throwsCode(() => svc.buildSet(setBody({ [field]: "" }), ACTOR, NOW), "REQUIRED");
    throwsCode(() => svc.buildSet(setBody({ [field]: "   " }), ACTOR, NOW), "REQUIRED");
  }
});

test("forecastExpectedDate is required for a set", () => {
  const b = setBody();
  delete b.forecastExpectedDate;
  throwsCode(() => svc.buildSet(b, ACTOR, NOW), "REQUIRED");
  throwsCode(() => svc.buildSet(setBody({ forecastExpectedDate: null }), ACTOR, NOW), "REQUIRED");
  throwsCode(() => svc.buildSet(setBody({ forecastExpectedDate: "" }), ACTOR, NOW), "REQUIRED");
});

/* ── Date rules ──────────────────────────────────────────────────────────── */

test("an unparseable expected date is refused, not stored as Invalid Date", () => {
  throwsCode(
    () => svc.buildSet(setBody({ forecastExpectedDate: "not-a-date" }), ACTOR, NOW),
    "INVALID_DATE",
  );
});

test("an expected date BEFORE asOfDate is refused", () => {
  // Accepting it would record an expectation that can never appear on a row —
  // the caller would believe the bill was in the forecast when it was not.
  throwsCode(
    () => svc.buildSet(setBody({ forecastExpectedDate: "2026-08-23" }), ACTOR, NOW),
    "DATE_IN_PAST",
  );
  throwsCode(
    () => svc.buildSet(setBody({ forecastExpectedDate: "2020-01-01" }), ACTOR, NOW),
    "DATE_IN_PAST",
  );
});

test("with no asOfDate supplied, the injected clock's day is used for the past check", () => {
  const b = setBody({ forecastExpectedDate: "2026-08-23" });
  delete b.asOfDate;
  throwsCode(() => svc.buildSet(b, ACTOR, NOW), "DATE_IN_PAST");

  const ok = setBody({ forecastExpectedDate: "2026-08-24" });
  delete ok.asOfDate;
  assert.ok(svc.buildSet(ok, ACTOR, NOW).$set.forecastExpectedDate);
});

test("a malformed asOfDate is refused rather than silently ignored", () => {
  throwsCode(() => svc.buildSet(setBody({ asOfDate: "rubbish" }), ACTOR, NOW), "INVALID_DATE");
});

/* ── Coercion refusals ───────────────────────────────────────────────────── */

test("booleans are refused wherever a scalar is expected", () => {
  // `new Date(true)` is a valid moment in 1970 — this must never slip through.
  throwsCode(() => svc.buildSet(setBody({ forecastExpectedDate: true }), ACTOR, NOW), "INVALID_TYPE");
  throwsCode(() => svc.buildSet(setBody({ companyId: true }), ACTOR, NOW), "INVALID_TYPE");
  throwsCode(() => svc.buildSet(setBody({ billName: false }), ACTOR, NOW), "INVALID_TYPE");
  throwsCode(() => svc.buildSet(setBody({ notes: true }), ACTOR, NOW), "INVALID_TYPE");
});

test("objects and arrays are refused wherever a scalar is expected", () => {
  throwsCode(
    () => svc.buildSet(setBody({ forecastExpectedDate: [2026, 9, 15] }), ACTOR, NOW),
    "INVALID_TYPE",
  );
  throwsCode(() => svc.buildSet(setBody({ companyId: { $ne: null } }), ACTOR, NOW), "INVALID_TYPE");
  throwsCode(() => svc.buildSet(setBody({ billName: ["a"] }), ACTOR, NOW), "INVALID_TYPE");
  throwsCode(() => svc.buildSet(setBody({ notes: { text: "x" } }), ACTOR, NOW), "INVALID_TYPE");
});

test("a real Date instance is accepted for the expected date", () => {
  const r = svc.buildSet(
    setBody({ forecastExpectedDate: new Date("2026-09-20T00:00:00Z") }),
    ACTOR,
    NOW,
  );
  assert.equal(r.$set.forecastExpectedDate.toISOString(), "2026-09-20T00:00:00.000Z");
});

test("the body itself must be a plain object", () => {
  throwsCode(() => svc.buildSet(null, ACTOR, NOW), "INVALID_BODY");
  throwsCode(() => svc.buildSet([], ACTOR, NOW), "INVALID_BODY");
  throwsCode(() => svc.buildSet("nope", ACTOR, NOW), "INVALID_BODY");
});

/* ── Whitelist and provenance ────────────────────────────────────────────── */

test("an unsupported field is refused outright, not silently dropped", () => {
  throwsCode(
    () => svc.buildSet(setBody({ dueDate: "2026-01-01" }), ACTOR, NOW),
    "UNSUPPORTED_FIELD",
  );
  throwsCode(() => svc.buildSet(setBody({ amount: 5000 }), ACTOR, NOW), "UNSUPPORTED_FIELD");
});

test("provenance cannot be supplied by the caller", () => {
  for (const f of [
    "forecastExpectedDateSource",
    "forecastExpectedDateUpdatedBy",
    "forecastExpectedDateUpdatedByName",
    "forecastExpectedDateUpdatedAt",
  ]) {
    throwsCode(
      () => svc.buildSet(setBody({ [f]: "forged" }), ACTOR, NOW),
      "UNSUPPORTED_FIELD",
      `${f} should be refused`,
    );
  }
});

test("notes longer than the cap are refused", () => {
  throwsCode(
    () => svc.buildSet(setBody({ notes: "x".repeat(svc.MAX_NOTES_LENGTH + 1) }), ACTOR, NOW),
    "TOO_LONG",
  );
  assert.ok(svc.buildSet(setBody({ notes: "x".repeat(svc.MAX_NOTES_LENGTH) }), ACTOR, NOW));
});

/* ── Clear ───────────────────────────────────────────────────────────────── */

test("a valid clear payload wipes every forecast field, and nothing else", () => {
  const r = svc.buildClear(clearBody());

  assert.deepEqual(r.scope, {
    companyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    ledgerId: "cccccccccccccccccccccccc",
    billName: "RC/0091/26-27",
  });
  assert.deepEqual(r.$set, {
    forecastExpectedDate: null,
    forecastExpectedDateSource: null,
    forecastExpectedDateNotes: "",
    forecastExpectedDateUpdatedBy: null,
    forecastExpectedDateUpdatedByName: null,
    forecastExpectedDateUpdatedAt: null,
  });
  assert.ok(!("dueDate" in r.$set), "clearing never touches the contractual due date");
});

test("clear requires the same three identifiers", () => {
  for (const f of ["companyId", "ledgerId", "billName"]) {
    const b = clearBody();
    delete b[f];
    throwsCode(() => svc.buildClear(b), "REQUIRED", `${f} should be required`);
  }
});

test("clear refuses extra fields — including a date, which it has no use for", () => {
  throwsCode(
    () => svc.buildClear(clearBody({ forecastExpectedDate: "2026-09-15" })),
    "UNSUPPORTED_FIELD",
  );
  throwsCode(() => svc.buildClear(clearBody({ notes: "why" })), "UNSUPPORTED_FIELD");
});

test("clear refuses coercible identifiers too", () => {
  throwsCode(() => svc.buildClear(clearBody({ companyId: { $ne: null } })), "INVALID_TYPE");
  throwsCode(() => svc.buildClear(clearBody({ billName: true })), "INVALID_TYPE");
});

/* ── Permission ──────────────────────────────────────────────────────────── */

test("canEdit reads canEdit, and a missing permissions object is never allowed", () => {
  assert.equal(svc.canEdit({ permissions: { canEdit: true } }), true);
  assert.equal(svc.canEdit({ permissions: { canEdit: false } }), false);
  assert.equal(svc.canEdit({}), false);
  assert.equal(svc.canEdit(null), false);
});

test("canEdit is the SAME function as creditTerms.canEditTerms, not a copy", () => {
  const creditTerms = require("./creditTerms.service");
  assert.equal(svc.canEdit, creditTerms.canEditTerms);
});

/* ── Scope guard ─────────────────────────────────────────────────────────── */

test("scope guard: this service predicts nothing", () => {
  // Chunk 1-C records what a PERSON says. Suggesting or deriving a date from
  // ageing or payment history is the behavioural model, which is not built.
  const exported = Object.keys(svc);
  for (const forbidden of ["predict", "suggest", "estimate", "deriveExpectedDate", "lag", "score"]) {
    assert.ok(!exported.includes(forbidden), `${forbidden} is a later chunk, not 1-C`);
  }
});
