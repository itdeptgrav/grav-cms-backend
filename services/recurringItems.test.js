// services/recurringItems.test.js
//
// Pure tests for C0-E's recurring-items validation. No database, no clock,
// no HTTP — everything here is a decision the service makes on its own, which
// is exactly what the pure/Mongo split exists to make testable.
//
// Run by `npm test` via the `services/**/*.test.js` glob.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./recurringItems.service");

const ACTOR = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Priya Editor" };
const COMPANY = "bbbbbbbbbbbbbbbbbbbbbbbb";

/** A valid monthly outflow, with overrides folded in. */
function monthlyBody(overrides = {}) {
  return {
    companyId: COMPANY,
    name: "Office rent",
    type: "rent",
    direction: "outflow",
    amount: 85000,
    frequency: "monthly",
    dayOfMonth: 5,
    nextDueDate: "2026-09-05",
    startDate: "2026-01-05",
    ...overrides,
  };
}

/** A valid weekly outflow, with overrides folded in. */
function weeklyBody(overrides = {}) {
  return {
    companyId: COMPANY,
    name: "Weekly contractor payout",
    type: "payroll",
    direction: "outflow",
    amount: 42000,
    frequency: "weekly",
    dayOfWeek: 5,
    nextDueDate: "2026-08-28",
    startDate: "2026-01-02",
    ...overrides,
  };
}

/** Assert that `fn` throws a RecurringItemError carrying `code`. */
function throwsCode(fn, code, message) {
  assert.throws(
    fn,
    (e) => {
      assert.ok(
        e instanceof svc.RecurringItemError,
        `expected RecurringItemError, got ${e && e.name}: ${e && e.message}`,
      );
      assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
      return true;
    },
    message,
  );
}

/* ── Happy paths ─────────────────────────────────────────────────────────── */

test("buildCreate: a valid monthly outflow produces the exact document", () => {
  const doc = svc.buildCreate(monthlyBody(), ACTOR);

  assert.equal(doc.name, "Office rent");
  assert.equal(doc.type, "rent");
  assert.equal(doc.direction, "outflow");
  assert.equal(doc.amount, 85000);
  assert.equal(doc.frequency, "monthly");
  assert.equal(doc.dayOfMonth, 5);
  assert.equal(doc.dayOfWeek, null, "a monthly item carries no weekday rule");
  assert.equal(doc.status, "active", "defaults to active when unspecified");
  assert.equal(doc.source, "manual", "source is server-owned");
  assert.equal(doc.createdByName, "Priya Editor");
  assert.ok(doc.nextDueDate instanceof Date);
  assert.equal(doc.endDate, null, "an open-ended schedule is the default");
});

test("buildCreate: a valid weekly outflow produces the exact document", () => {
  const doc = svc.buildCreate(weeklyBody(), ACTOR);

  assert.equal(doc.frequency, "weekly");
  assert.equal(doc.dayOfWeek, 5);
  assert.equal(doc.dayOfMonth, null, "a weekly item carries no month-day rule");
  assert.equal(doc.direction, "outflow");
});

test("buildCreate: an inflow is just as valid as an outflow", () => {
  const doc = svc.buildCreate(
    monthlyBody({ name: "Sublet income", direction: "inflow", type: "other" }),
    ACTOR,
  );
  assert.equal(doc.direction, "inflow");
  assert.equal(doc.amount, 85000, "amount stays an unsigned magnitude");
});

test("buildCreate: every declared type and frequency is accepted", () => {
  for (const type of svc.TYPE) {
    const doc = svc.buildCreate(monthlyBody({ type }), ACTOR);
    assert.equal(doc.type, type);
  }
  // monthly/weekly need their own day field; quarterly/yearly do not.
  assert.equal(svc.buildCreate(monthlyBody({ frequency: "monthly" }), ACTOR).frequency, "monthly");
  assert.equal(svc.buildCreate(weeklyBody({ frequency: "weekly" }), ACTOR).frequency, "weekly");
  for (const frequency of ["quarterly", "yearly"]) {
    const body = monthlyBody({ frequency });
    delete body.dayOfMonth;
    assert.equal(svc.buildCreate(body, ACTOR).frequency, frequency);
  }
});

/* ── dayOfWeek 0 is Sunday, NOT "unset" ──────────────────────────────────── */

test("buildCreate: dayOfWeek 0 is Sunday — a real value, not a missing one", () => {
  // The trap this pins: `if (!dayOfWeek)` would read Sunday as absent and
  // reject a perfectly good schedule. Note this is the OPPOSITE of the
  // "0 means unset" rule creditPeriodDays/defaultCreditDays follow elsewhere
  // in C0 — the two must not be confused.
  const doc = svc.buildCreate(weeklyBody({ dayOfWeek: 0 }), ACTOR);
  assert.equal(doc.dayOfWeek, 0);
});

test("buildCreate: dayOfWeek 6 (Saturday) is in range", () => {
  assert.equal(svc.buildCreate(weeklyBody({ dayOfWeek: 6 }), ACTOR).dayOfWeek, 6);
});

/* ── Required fields ─────────────────────────────────────────────────────── */

test("buildCreate: companyId is required", () => {
  const body = monthlyBody();
  delete body.companyId;
  throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED");
});

test("buildCreate: name is required, and whitespace does not count as a name", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ name: "" }), ACTOR), "REQUIRED");
  throwsCode(() => svc.buildCreate(monthlyBody({ name: "   " }), ACTOR), "REQUIRED");
  const body = monthlyBody();
  delete body.name;
  throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED");
});

test("buildCreate: name is trimmed rather than stored with its padding", () => {
  assert.equal(svc.buildCreate(monthlyBody({ name: "  Rent  " }), ACTOR).name, "Rent");
});

test("buildCreate: nextDueDate and startDate are both required", () => {
  for (const field of ["nextDueDate", "startDate"]) {
    const body = monthlyBody();
    delete body[field];
    throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED", `${field} should be required`);
  }
});

/* ── Amount ──────────────────────────────────────────────────────────────── */

test("buildCreate: amount must be strictly positive", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: 0 }), ACTOR), "NOT_POSITIVE");
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: -100 }), ACTOR), "NOT_POSITIVE");
});

test("buildCreate: amount accepts a decimal — money is not always whole rupees", () => {
  assert.equal(svc.buildCreate(monthlyBody({ amount: 1234.5 }), ACTOR).amount, 1234.5);
});

test("buildCreate: a numeric string amount, as a form sends, is accepted", () => {
  assert.equal(svc.buildCreate(monthlyBody({ amount: "85000" }), ACTOR).amount, 85000);
});

test("buildCreate: a non-numeric amount is refused, not read as NaN", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: "8,00,000" }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: "abc" }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: Infinity }), ACTOR), "INVALID_TYPE");
});

test("buildCreate: amount is required, not silently defaulted to zero", () => {
  const body = monthlyBody();
  delete body.amount;
  throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED");
});

/* ── Enums ───────────────────────────────────────────────────────────────── */

test("buildCreate: an unknown type/direction/frequency/status is refused", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ type: "bribes" }), ACTOR), "INVALID_ENUM");
  throwsCode(() => svc.buildCreate(monthlyBody({ direction: "sideways" }), ACTOR), "INVALID_ENUM");
  throwsCode(() => svc.buildCreate(monthlyBody({ frequency: "fortnightly" }), ACTOR), "INVALID_ENUM");
  throwsCode(() => svc.buildCreate(monthlyBody({ status: "deleted" }), ACTOR), "INVALID_ENUM");
});

test("buildCreate: enum matching is exact — case and padding are not normalised away", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ direction: "Outflow" }), ACTOR), "INVALID_ENUM");
  throwsCode(() => svc.buildCreate(monthlyBody({ type: " rent" }), ACTOR), "INVALID_ENUM");
});

test("buildCreate: a client cannot set `source` — it is provenance, not input", () => {
  // Not merely ignored: refused, so a caller never believes a claimed origin
  // was recorded. `source` is absent from CREATE_FIELDS for this reason.
  throwsCode(
    () => svc.buildCreate(monthlyBody({ source: "seeded_from_history" }), ACTOR),
    "UNSUPPORTED_FIELD",
  );
  assert.ok(!svc.CREATE_FIELDS.includes("source"));
});

/* ── Type-coercion refusals ──────────────────────────────────────────────── */

test("buildCreate: booleans are refused wherever a number or string is expected", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: true }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ name: true }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ type: true }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: true }), ACTOR), "INVALID_TYPE");
  // `new Date(true)` is a real moment in 1970 — this must never slip through.
  throwsCode(() => svc.buildCreate(monthlyBody({ nextDueDate: true }), ACTOR), "INVALID_TYPE");
});

test("buildCreate: objects and arrays are refused wherever a scalar is expected", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: { v: 5 } }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ amount: [5] }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ name: ["Rent"] }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: [5] }), ACTOR), "INVALID_TYPE");
  throwsCode(
    () => svc.buildCreate(monthlyBody({ nextDueDate: [2026, 9, 5] }), ACTOR),
    "INVALID_TYPE",
  );
});

test("buildCreate: the body itself must be a plain object", () => {
  throwsCode(() => svc.buildCreate(null, ACTOR), "INVALID_BODY");
  throwsCode(() => svc.buildCreate([], ACTOR), "INVALID_BODY");
  throwsCode(() => svc.buildCreate("nope", ACTOR), "INVALID_BODY");
});

/* ── The epoch trap ──────────────────────────────────────────────────────── */

test("buildCreate: a null date is 'missing', never 1970 — the new Date(null) trap", () => {
  // `new Date(null)` is the Unix epoch, not an Invalid Date. A schedule
  // silently anchored to 1 Jan 1970 would put every occurrence in the past.
  throwsCode(() => svc.buildCreate(monthlyBody({ nextDueDate: null }), ACTOR), "REQUIRED");
  throwsCode(() => svc.buildCreate(monthlyBody({ startDate: null }), ACTOR), "REQUIRED");
});

test("buildCreate: an unparseable date is refused rather than stored as Invalid Date", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ nextDueDate: "not-a-date" }), ACTOR), "INVALID_DATE");
});

/* ── Schedule rules ──────────────────────────────────────────────────────── */

test("buildCreate: a monthly item requires dayOfMonth", () => {
  const body = monthlyBody();
  delete body.dayOfMonth;
  throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED");
});

test("buildCreate: a weekly item requires dayOfWeek", () => {
  const body = weeklyBody();
  delete body.dayOfWeek;
  throwsCode(() => svc.buildCreate(body, ACTOR), "REQUIRED");
});

test("buildCreate: dayOfMonth must be 1..31, dayOfWeek 0..6", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: 0 }), ACTOR), "OUT_OF_RANGE");
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: 32 }), ACTOR), "OUT_OF_RANGE");
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: -1 }), ACTOR), "OUT_OF_RANGE");
  throwsCode(() => svc.buildCreate(weeklyBody({ dayOfWeek: 7 }), ACTOR), "OUT_OF_RANGE");
  throwsCode(() => svc.buildCreate(weeklyBody({ dayOfWeek: -1 }), ACTOR), "OUT_OF_RANGE");
});

test("buildCreate: a fractional day is refused, not floored", () => {
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfMonth: 5.5 }), ACTOR), "NOT_INTEGER");
});

test("buildCreate: a day field that does not apply to the frequency is refused, not ignored", () => {
  // Storing-and-ignoring would leave a row that reads to the next person as
  // though a weekday rule were in force.
  throwsCode(() => svc.buildCreate(monthlyBody({ dayOfWeek: 3 }), ACTOR), "INAPPLICABLE_FIELD");
  throwsCode(() => svc.buildCreate(weeklyBody({ dayOfMonth: 5 }), ACTOR), "INAPPLICABLE_FIELD");
  const q = monthlyBody({ frequency: "quarterly", dayOfWeek: 3 });
  delete q.dayOfMonth;
  throwsCode(() => svc.buildCreate(q, ACTOR), "INAPPLICABLE_FIELD");
});

test("buildCreate: dayOfMonth is OPTIONAL for quarterly and yearly", () => {
  const withDay = svc.buildCreate(monthlyBody({ frequency: "quarterly", dayOfMonth: 20 }), ACTOR);
  assert.equal(withDay.dayOfMonth, 20);

  const withoutDay = monthlyBody({ frequency: "yearly" });
  delete withoutDay.dayOfMonth;
  assert.equal(svc.buildCreate(withoutDay, ACTOR).dayOfMonth, null);
});

test("buildCreate: a month-end rule (dayOfMonth 31) survives an already-clamped nextDueDate", () => {
  // The exact case the model's header calls out: these are allowed to differ,
  // because the day field is the RULE and nextDueDate is the next OCCURRENCE.
  // Cross-validating them would reject this real schedule.
  const doc = svc.buildCreate(
    monthlyBody({ dayOfMonth: 31, nextDueDate: "2026-02-28", startDate: "2026-01-31" }),
    ACTOR,
  );
  assert.equal(doc.dayOfMonth, 31);
  assert.equal(doc.nextDueDate.toISOString().slice(0, 10), "2026-02-28");
});

test("buildCreate: an off-cycle FIRST occurrence is allowed, not treated as a typo", () => {
  // Rent whose rule is the 5th but whose first payment was agreed for the
  // 20th. Rejecting this would block a legitimate setup.
  const doc = svc.buildCreate(monthlyBody({ dayOfMonth: 5, nextDueDate: "2026-09-20" }), ACTOR);
  assert.equal(doc.dayOfMonth, 5);
  assert.equal(doc.nextDueDate.toISOString().slice(0, 10), "2026-09-20");
});

/* ── Date ordering ───────────────────────────────────────────────────────── */

test("buildCreate: nextDueDate cannot precede startDate", () => {
  throwsCode(
    () => svc.buildCreate(monthlyBody({ startDate: "2026-09-05", nextDueDate: "2026-08-05" }), ACTOR),
    "DATE_ORDER",
  );
});

test("buildCreate: endDate cannot precede startDate", () => {
  throwsCode(
    () => svc.buildCreate(monthlyBody({ endDate: "2025-01-01" }), ACTOR),
    "DATE_ORDER",
  );
});

test("buildCreate: a startDate in the past is fine — schedules predate their register entry", () => {
  const doc = svc.buildCreate(
    monthlyBody({ startDate: "2020-04-01", nextDueDate: "2026-09-05" }),
    ACTOR,
  );
  assert.equal(doc.startDate.toISOString().slice(0, 10), "2020-04-01");
});

/* ── Unknown fields ──────────────────────────────────────────────────────── */

test("buildCreate: an unknown field is refused outright, not silently dropped", () => {
  throwsCode(
    () => svc.buildCreate(monthlyBody({ approvedBy: "me", isVerified: true }), ACTOR),
    "UNSUPPORTED_FIELD",
  );
});

test("buildCreate: provenance fields cannot be supplied by the caller", () => {
  for (const field of ["createdBy", "createdByName", "updatedBy", "updatedByName"]) {
    throwsCode(
      () => svc.buildCreate(monthlyBody({ [field]: "forged" }), ACTOR),
      "UNSUPPORTED_FIELD",
      `${field} should be refused`,
    );
  }
});

/* ── buildUpdate ─────────────────────────────────────────────────────────── */

/** A stored row, as `.lean()` would hand it back. */
function existingMonthly(overrides = {}) {
  return {
    name: "Office rent",
    type: "rent",
    direction: "outflow",
    amount: 85000,
    frequency: "monthly",
    dayOfMonth: 5,
    dayOfWeek: null,
    nextDueDate: new Date("2026-09-05"),
    startDate: new Date("2026-01-05"),
    endDate: null,
    status: "active",
    ...overrides,
  };
}

test("buildUpdate: a partial patch touches only the keys it names", () => {
  const $set = svc.buildUpdate({ amount: 90000 }, existingMonthly(), ACTOR);

  assert.equal($set.amount, 90000);
  assert.ok(!("name" in $set), "an omitted field must not be blanked");
  assert.ok(!("notes" in $set));
  assert.ok(!("frequency" in $set));
  assert.equal($set.updatedByName, "Priya Editor");
});

test("buildUpdate: an empty patch is refused rather than writing only provenance", () => {
  throwsCode(() => svc.buildUpdate({}, existingMonthly(), ACTOR), "NOTHING_TO_UPDATE");
});

test("buildUpdate: the whitelist is enforced, and is NOT the create whitelist", () => {
  throwsCode(() => svc.buildUpdate({ source: "manual" }, existingMonthly(), ACTOR), "UNSUPPORTED_FIELD");
  throwsCode(() => svc.buildUpdate({ createdBy: "x" }, existingMonthly(), ACTOR), "UNSUPPORTED_FIELD");
  // companyId is absent on purpose: re-tenanting a row is not an edit.
  throwsCode(() => svc.buildUpdate({ companyId: COMPANY }, existingMonthly(), ACTOR), "UNSUPPORTED_FIELD");
  assert.ok(!svc.UPDATE_FIELDS.includes("companyId"));
});

test("buildUpdate: status transitions (pause / resume / end) are ordinary updates", () => {
  for (const status of svc.STATUS) {
    assert.equal(svc.buildUpdate({ status }, existingMonthly(), ACTOR).status, status);
  }
  throwsCode(() => svc.buildUpdate({ status: "archived" }, existingMonthly(), ACTOR), "INVALID_ENUM");
});

test("buildUpdate: the same coercion refusals apply on update", () => {
  throwsCode(() => svc.buildUpdate({ amount: true }, existingMonthly(), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate({ amount: [1] }, existingMonthly(), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate({ amount: 0 }, existingMonthly(), ACTOR), "NOT_POSITIVE");
  throwsCode(() => svc.buildUpdate({ name: "" }, existingMonthly(), ACTOR), "REQUIRED");
  throwsCode(() => svc.buildUpdate({ nextDueDate: null }, existingMonthly(), ACTOR), "REQUIRED");
});

test("buildUpdate: changing only dayOfMonth on an already-monthly item is allowed", () => {
  const $set = svc.buildUpdate({ dayOfMonth: 12 }, existingMonthly(), ACTOR);
  assert.equal($set.dayOfMonth, 12);
  assert.equal($set.frequency, "monthly", "frequency is carried from the stored row");
  assert.equal($set.dayOfWeek, null);
});

test("buildUpdate: switching monthly → weekly requires the weekly field, and clears the monthly one", () => {
  // The stored dayOfMonth must NOT be dragged into the merged shape and then
  // refused as inapplicable — the caller supplied the right field for the new
  // frequency, and that is what should be validated.
  const $set = svc.buildUpdate(
    { frequency: "weekly", dayOfWeek: 1 },
    existingMonthly(),
    ACTOR,
  );
  assert.equal($set.frequency, "weekly");
  assert.equal($set.dayOfWeek, 1);
  assert.equal($set.dayOfMonth, null, "the stale monthly rule is cleared, not left behind");
});

test("buildUpdate: switching weekly → monthly without a dayOfMonth is refused", () => {
  const existingWeekly = existingMonthly({
    frequency: "weekly",
    dayOfMonth: null,
    dayOfWeek: 5,
  });
  throwsCode(() => svc.buildUpdate({ frequency: "monthly" }, existingWeekly, ACTOR), "REQUIRED");
});

test("buildUpdate: switching weekly → monthly WITH a dayOfMonth clears the weekday rule", () => {
  const existingWeekly = existingMonthly({
    frequency: "weekly",
    dayOfMonth: null,
    dayOfWeek: 5,
  });
  const $set = svc.buildUpdate({ frequency: "monthly", dayOfMonth: 1 }, existingWeekly, ACTOR);
  assert.equal($set.dayOfMonth, 1);
  assert.equal($set.dayOfWeek, null);
});

test("buildUpdate: date order is validated against the MERGED result, not the patch alone", () => {
  // Moving nextDueDate before the STORED startDate must fail even though the
  // patch alone says nothing about startDate.
  throwsCode(
    () => svc.buildUpdate({ nextDueDate: "2025-01-01" }, existingMonthly(), ACTOR),
    "DATE_ORDER",
  );
  // And the mirror: moving startDate past the STORED nextDueDate.
  throwsCode(
    () => svc.buildUpdate({ startDate: "2027-01-01" }, existingMonthly(), ACTOR),
    "DATE_ORDER",
  );
});

test("buildUpdate: an explicit empty endDate clears it back to open-ended", () => {
  const withEnd = existingMonthly({ endDate: new Date("2027-01-01") });
  const $set = svc.buildUpdate({ endDate: "" }, withEnd, ACTOR);
  assert.ok("endDate" in $set);
  assert.equal($set.endDate, null);
});

test("buildUpdate: a valid endDate after startDate is accepted", () => {
  const $set = svc.buildUpdate({ endDate: "2027-03-31" }, existingMonthly(), ACTOR);
  assert.equal($set.endDate.toISOString().slice(0, 10), "2027-03-31");
});

test("buildUpdate: ledgerId can be linked and unlinked", () => {
  assert.equal(svc.buildUpdate({ ledgerId: "cccccccccccccccccccccccc" }, existingMonthly(), ACTOR).ledgerId, "cccccccccccccccccccccccc");
  assert.equal(svc.buildUpdate({ ledgerId: "" }, existingMonthly(), ACTOR).ledgerId, null);
  assert.equal(svc.buildUpdate({ ledgerId: null }, existingMonthly(), ACTOR).ledgerId, null);
});

/* ── Permission predicate ────────────────────────────────────────────────── */

test("canEdit: reads canEdit, and a missing permissions object is never 'allowed'", () => {
  assert.equal(svc.canEdit({ permissions: { canEdit: true } }), true);
  assert.equal(svc.canEdit({ permissions: { canEdit: false } }), false);
  assert.equal(svc.canEdit({ permissions: {} }), false);
  assert.equal(svc.canEdit({}), false);
  assert.equal(svc.canEdit(null), false);
  assert.equal(svc.canEdit(undefined), false);
});

test("canEdit: is the SAME function as creditTerms.canEditTerms, not a second copy", () => {
  // One implementation, so the two can never drift — the alias exists only to
  // read honestly at a recurring-items call site.
  const creditTerms = require("./creditTerms.service");
  assert.equal(svc.canEdit, creditTerms.canEditTerms);
});

/* ── C0-E scope guard, asserted in code ──────────────────────────────────── */

test("scope guard: this service generates no occurrences and no forecast rows", () => {
  // C0-E is the register only. If a later slice adds projection here, this
  // test should be updated deliberately — not deleted quietly.
  const exported = Object.keys(svc);
  for (const forbidden of ["project", "projectOccurrences", "forecast", "expand", "occurrencesBetween", "advance"]) {
    assert.ok(!exported.includes(forbidden), `${forbidden} is Chunk 1's job, not C0-E's`);
  }
  // And the built document describes a schedule; it holds no generated dates.
  const doc = svc.buildCreate(monthlyBody(), ACTOR);
  assert.ok(!("occurrences" in doc));
  assert.ok(!("projectedDates" in doc));
});
