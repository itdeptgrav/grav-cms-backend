const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_CREDIT_DAYS,
  EDITABLE_FIELDS,
  CreditTermsError,
  parseCreditDays,
  isTermSet,
  buildUpdate,
} = require("./creditTerms.service");

const ACTOR = { id: "507f1f77bcf86cd799439011", name: "A Accountant", email: "a@grav.in" };
const NOW = new Date("2026-08-24T10:00:00.000Z");
const throws = (fn, code) =>
  assert.throws(fn, (e) => e instanceof CreditTermsError && e.code === code, `expected ${code}`);

/* ── 0 MEANS UNSET — the rule the whole slice turns on ───────────────────── */

test("0 is unset, NOT due-on-receipt", () => {
  assert.equal(parseCreditDays(0), null);
  assert.equal(parseCreditDays("0"), null);
});

test("saving 0 clears the term and clears its provenance source", () => {
  const u = buildUpdate({ creditPeriodDays: 0 }, ACTOR, NOW);
  assert.equal(u.creditPeriodDays, 0, "stored as the schema default every reader knows");
  assert.equal(u.creditTermsSource, null, "null source is what marks it unset");
});

test("an unset term is never reported as set", () => {
  assert.equal(isTermSet(0), false);
  assert.equal(isTermSet(null), false);
  assert.equal(isTermSet(undefined), false);
  assert.equal(isTermSet(30), true);
});

test("clearing is distinguishable from never having been touched", () => {
  const cleared = buildUpdate({ creditPeriodDays: "" }, ACTOR, NOW);
  assert.equal(cleared.creditPeriodDays, 0);
  assert.equal(cleared.creditTermsSource, null);
  assert.ok(cleared.creditTermsUpdatedAt, "cleared still records WHEN it was cleared");
});

/* ── Empty input is unset, not an error ──────────────────────────────────── */

test("empty, null and whitespace clear the term", () => {
  assert.equal(parseCreditDays(""), null);
  assert.equal(parseCreditDays(null), null);
  assert.equal(parseCreditDays(undefined), null);
  assert.equal(parseCreditDays("   "), null);
});

/* ── Negative values rejected ────────────────────────────────────────────── */

test("negative credit days are rejected", () => {
  throws(() => parseCreditDays(-1), "NEGATIVE");
  throws(() => parseCreditDays(-30), "NEGATIVE");
  throws(() => parseCreditDays("-5"), "NEGATIVE");
});

/* ── Absurd values rejected ──────────────────────────────────────────────── */

test("absurd credit days are rejected", () => {
  throws(() => parseCreditDays(366), "TOO_LARGE");
  throws(() => parseCreditDays(100000), "TOO_LARGE");
  throws(() => parseCreditDays(Number.MAX_SAFE_INTEGER), "TOO_LARGE");
});

test("the boundary itself is allowed", () => {
  assert.equal(parseCreditDays(MAX_CREDIT_DAYS), 365);
});

/* ── Non-number values rejected ──────────────────────────────────────────── */

test("non-numeric strings are rejected, not coerced to 0", () => {
  throws(() => parseCreditDays("abc"), "INVALID_TYPE");
  throws(() => parseCreditDays("30 days"), "INVALID_TYPE");
});

test("booleans are rejected — Number(true) would silently write 1-day terms", () => {
  throws(() => parseCreditDays(true), "INVALID_TYPE");
  throws(() => parseCreditDays(false), "INVALID_TYPE");
});

test("objects and arrays are rejected — Number([]) would silently be 0", () => {
  throws(() => parseCreditDays([]), "INVALID_TYPE");
  throws(() => parseCreditDays([30]), "INVALID_TYPE");
  throws(() => parseCreditDays({}), "INVALID_TYPE");
});

test("NaN and Infinity are rejected", () => {
  throws(() => parseCreditDays(NaN), "INVALID_TYPE");
  throws(() => parseCreditDays(Infinity), "INVALID_TYPE");
});

test("fractional days are rejected — half a day of credit is not a term", () => {
  throws(() => parseCreditDays(30.5), "NOT_INTEGER");
  throws(() => parseCreditDays("15.2"), "NOT_INTEGER");
});

/* ── Valid values save ───────────────────────────────────────────────────── */

test("ordinary terms save", () => {
  for (const d of [1, 7, 15, 30, 45, 60, 90, 120, 365]) {
    assert.equal(parseCreditDays(d), d);
  }
});

test("numeric strings from a form input are accepted", () => {
  assert.equal(parseCreditDays("30"), 30);
  assert.equal(parseCreditDays(" 45 "), 45);
});

test("a valid save records the value and full provenance", () => {
  const u = buildUpdate({ creditPeriodDays: 45 }, ACTOR, NOW);
  assert.equal(u.creditPeriodDays, 45);
  assert.equal(u.creditTermsSource, "manual");
  assert.equal(u.creditTermsUpdatedAt, NOW);
  assert.equal(u.creditTermsUpdatedBy, ACTOR.id);
  assert.equal(u.creditTermsUpdatedByName, ACTOR.name);
});

test("provenance falls back to email when a name is absent", () => {
  const u = buildUpdate({ creditPeriodDays: 30 }, { id: "x", email: "b@grav.in" }, NOW);
  assert.equal(u.creditTermsUpdatedByName, "b@grav.in");
});

/* ── Unrelated ledger fields cannot be changed through this endpoint ─────── */

test("unrelated ledger fields are REFUSED, not silently dropped", () => {
  throws(() => buildUpdate({ creditPeriodDays: 30, openingBalance: 999999 }, ACTOR, NOW), "UNSUPPORTED_FIELD");
  throws(() => buildUpdate({ creditPeriodDays: 30, nature: "revenue" }, ACTOR, NOW), "UNSUPPORTED_FIELD");
  throws(() => buildUpdate({ creditPeriodDays: 30, groupId: "abc" }, ACTOR, NOW), "UNSUPPORTED_FIELD");
  throws(() => buildUpdate({ creditPeriodDays: 30, companyId: "abc" }, ACTOR, NOW), "UNSUPPORTED_FIELD");
  throws(() => buildUpdate({ creditPeriodDays: 30, name: "Renamed Party" }, ACTOR, NOW), "UNSUPPORTED_FIELD");
});

test("the built update contains ONLY known keys — nothing can ride along", () => {
  const u = buildUpdate({ creditPeriodDays: 30 }, ACTOR, NOW);
  assert.deepEqual(Object.keys(u).sort(), [
    "creditPeriodDays",
    "creditTermsSource",
    "creditTermsUpdatedAt",
    "creditTermsUpdatedBy",
    "creditTermsUpdatedByName",
  ]);
});

test("provenance is never taken from the request body", () => {
  throws(
    () => buildUpdate({ creditPeriodDays: 30, creditTermsSource: "inherited" }, ACTOR, NOW),
    "UNSUPPORTED_FIELD",
  );
  throws(
    () => buildUpdate({ creditPeriodDays: 30, creditTermsUpdatedBy: "someone-else" }, ACTOR, NOW),
    "UNSUPPORTED_FIELD",
  );
});

test("creditLimit is NOT editable in this slice", () => {
  throws(() => buildUpdate({ creditPeriodDays: 30, creditLimit: 500000 }, ACTOR, NOW), "UNSUPPORTED_FIELD");
  assert.deepEqual(EDITABLE_FIELDS, ["creditPeriodDays"]);
});

test("a body with nothing to update is refused", () => {
  throws(() => buildUpdate({}, ACTOR, NOW), "NOTHING_TO_UPDATE");
});

test("a non-object body is refused rather than coerced", () => {
  throws(() => buildUpdate(null, ACTOR, NOW), "INVALID_BODY");
  throws(() => buildUpdate([{ creditPeriodDays: 30 }], ACTOR, NOW), "INVALID_BODY");
  throws(() => buildUpdate("creditPeriodDays=30", ACTOR, NOW), "INVALID_BODY");
});

/* ── C0-B1 boundary: this slice dates nothing ────────────────────────────── */

test("no due date, bill term or voucher field is ever produced", () => {
  const u = buildUpdate({ creditPeriodDays: 30 }, ACTOR, NOW);
  for (const forbidden of ["dueDate", "billName", "billAllocations", "vouchers", "ledgerEntries"]) {
    assert.equal(forbidden in u, false, `${forbidden} must not appear — dating is a later slice`);
  }
});

/* ── Unauthorized user cannot edit ───────────────────────────────────────── */

const { canEditTerms } = require("./creditTerms.service");

test("a read-only accounting role cannot edit terms", () => {
  assert.equal(canEditTerms({ role: "viewer", permissions: { canEdit: false } }), false);
});

test("an editor can", () => {
  assert.equal(canEditTerms({ role: "editor", permissions: { canEdit: true } }), true);
});

test("a missing permissions object is refused, never assumed permissive", () => {
  assert.equal(canEditTerms({ role: "owner" }), false, "role alone is not permission");
  assert.equal(canEditTerms({ permissions: null }), false);
  assert.equal(canEditTerms({}), false);
});

test("no user at all is refused", () => {
  assert.equal(canEditTerms(null), false);
  assert.equal(canEditTerms(undefined), false);
});

test("a truthy-but-not-true canEdit is refused — strict equality only", () => {
  // A stray "false" string, or a 1 from a legacy map, must not open the gate.
  assert.equal(canEditTerms({ permissions: { canEdit: "false" } }), false);
  assert.equal(canEditTerms({ permissions: { canEdit: 1 } }), false);
  assert.equal(canEditTerms({ permissions: { canEdit: "yes" } }), false);
});

test("a non-object user cannot smuggle permission through coercion", () => {
  assert.equal(canEditTerms("owner"), false);
  assert.equal(canEditTerms(true), false);
});

/* ── companyId is scope, never a settable field ──────────────────────────── */

test("companyId cannot be smuggled through buildUpdate as a field to set", () => {
  throws(
    () => buildUpdate({ creditPeriodDays: 30, companyId: "507f1f77bcf86cd799439099" }, ACTOR, NOW),
    "UNSUPPORTED_FIELD",
  );
});

/* ── C0-C: effectiveCreditDays / resolveDueDate ──────────────────────────── */

const { effectiveCreditDays, resolveDueDate } = require("./creditTerms.service");

test("effectiveCreditDays reads a set term straight through", () => {
  assert.equal(effectiveCreditDays({ creditPeriodDays: 30 }), 30);
  assert.equal(effectiveCreditDays({ creditPeriodDays: 1 }), 1);
  assert.equal(effectiveCreditDays({ creditPeriodDays: 365 }), 365);
});

test("effectiveCreditDays: 0 is unset, same rule as everywhere else in this module", () => {
  assert.equal(effectiveCreditDays({ creditPeriodDays: 0 }), null);
});

test("effectiveCreditDays: a missing or malformed party never throws", () => {
  assert.equal(effectiveCreditDays(null), null);
  assert.equal(effectiveCreditDays(undefined), null);
  assert.equal(effectiveCreditDays({}), null);
  assert.equal(effectiveCreditDays("not an object"), null);
  assert.equal(effectiveCreditDays({ creditPeriodDays: null }), null);
  assert.equal(effectiveCreditDays({ creditPeriodDays: -5 }), null);
});

test("resolveDueDate: due date defaults from the party's term", () => {
  const due = resolveDueDate({
    voucherDate: "2026-04-01T00:00:00.000Z",
    partyLedger: { creditPeriodDays: 30 },
  });
  assert.equal(due.toISOString().slice(0, 10), "2026-05-01");
});

test("resolveDueDate: no terms set means no due date — null, not a guess", () => {
  const due = resolveDueDate({
    voucherDate: "2026-04-01T00:00:00.000Z",
    partyLedger: { creditPeriodDays: 0 },
  });
  assert.equal(due, null);
});

test("resolveDueDate: an invalid or missing party invents nothing", () => {
  assert.equal(resolveDueDate({ voucherDate: "2026-04-01" }), null);
  assert.equal(resolveDueDate({ voucherDate: "2026-04-01", partyLedger: null }), null);
  assert.equal(resolveDueDate({ voucherDate: "2026-04-01", partyLedger: {} }), null);
});

test("resolveDueDate: a missing or unparseable voucherDate never invents a date", () => {
  assert.equal(resolveDueDate({ partyLedger: { creditPeriodDays: 30 } }), null);
  assert.equal(
    resolveDueDate({ voucherDate: "not-a-date", partyLedger: { creditPeriodDays: 30 } }),
    null,
  );
  assert.equal(
    resolveDueDate({ voucherDate: null, partyLedger: { creditPeriodDays: 30 } }),
    null,
  );
});

test("resolveDueDate: correctly rolls a month boundary (31 Jan + 5 → 5 Feb)", () => {
  const due = resolveDueDate({
    voucherDate: "2026-01-31T00:00:00.000Z",
    partyLedger: { creditPeriodDays: 5 },
  });
  assert.equal(due.toISOString().slice(0, 10), "2026-02-05");
});

test("resolveDueDate: correctly rolls a year boundary", () => {
  const due = resolveDueDate({
    voucherDate: "2026-12-28T00:00:00.000Z",
    partyLedger: { creditPeriodDays: 10 },
  });
  assert.equal(due.toISOString().slice(0, 10), "2027-01-07");
});

test("resolveDueDate: accepts an actual Date instance for voucherDate, not only a string", () => {
  const due = resolveDueDate({
    voucherDate: new Date("2026-06-01T00:00:00.000Z"),
    partyLedger: { creditPeriodDays: 15 },
  });
  assert.equal(due.toISOString().slice(0, 10), "2026-06-16");
});

test("resolveDueDate: UTC arithmetic, not local time — same result regardless of a DST-observing TZ", () => {
  // A date that sits inside a US DST transition window (2nd Sunday of March
  // 2026 is Mar 8). Millisecond arithmetic in a DST-observing local timezone
  // could land a day off; UTC calendar-date arithmetic cannot.
  const due = resolveDueDate({
    voucherDate: "2026-03-05T00:00:00.000Z",
    partyLedger: { creditPeriodDays: 5 },
  });
  assert.equal(due.toISOString().slice(0, 10), "2026-03-10");
});
