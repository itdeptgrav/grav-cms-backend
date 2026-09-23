// services/customerOutstanding.test.js
//
// The sign conventions and the request validation, proved without a database.
//
// These are the rules that make a report trustworthy rather than plausible:
// which side a balance sits on, what a receivable total may and may not
// include, and what happens to a request whose scope cannot be understood.
// The database-facing behaviour (company isolation, spoofed ids, as-of
// cut-offs, statement reconciliation) needs real collections and lives in
// test/accountant/customer-outstanding.route.test.js.
//
// Run by `npm test` — node --test "services/**/*.test.js".

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const svc = require("./customerOutstanding.service");

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ID_B = "aaaaaaaaaaaaaaaaaaaaaaa2";
const COMPANY = new mongoose.Types.ObjectId().toString();
const ID_A_OID = new mongoose.Types.ObjectId().toString();

const ledger = (o = {}) => ({
  _id: ID_A,
  name: "Acme Exports Pvt Ltd",
  gstin: "27AAAAA0000A1Z5",
  groupName: "Sundry Debtors",
  openingBalance: 0,
  openingBalanceType: "Dr",
  ...o,
});

/* ── Opening balance ─────────────────────────────────────────────────────── */

test("a Dr opening balance is positive; a Cr opening balance is negative", () => {
  assert.equal(svc.openingSignedOf({ openingBalance: 5000, openingBalanceType: "Dr" }), 5000);
  assert.equal(svc.openingSignedOf({ openingBalance: 5000, openingBalanceType: "Cr" }), -5000);
});

test("a Cr opening stored as a NEGATIVE number is still read as Cr, not double-negated", () => {
  // Some import paths write the sign into the number, others into the type.
  // abs() + type is the only reading correct under both.
  assert.equal(svc.openingSignedOf({ openingBalance: -5000, openingBalanceType: "Cr" }), -5000);
});

test("a missing opening balance is zero, not NaN", () => {
  assert.equal(svc.openingSignedOf({}), 0);
  assert.equal(svc.openingSignedOf(null), 0);
});

/* ── The definition ──────────────────────────────────────────────────────── */

test("signed balance is opening + debits − credits", () => {
  assert.equal(svc.signedBalance(1000, 5000, 2000), 4000);
  assert.equal(svc.signedBalance(-1000, 5000, 2000), 2000);
  assert.equal(svc.signedBalance(0, 0, 3000), -3000);
});

test("a debit balance is a receivable and a credit balance is not", () => {
  const dr = svc.classifyBalance(4000);
  assert.equal(dr.type, "Dr");
  assert.equal(dr.receivable, 4000);
  assert.equal(dr.credit, 0);

  const cr = svc.classifyBalance(-4000);
  assert.equal(cr.type, "Cr");
  assert.equal(cr.receivable, 0, "a customer in credit owes us nothing");
  assert.equal(cr.credit, 4000);
  assert.equal(cr.amount, 4000, "the reported amount is unsigned; the type carries the side");
});

test("rounding dust is neither a receivable nor a credit", () => {
  const nil = svc.classifyBalance(0.001);
  assert.equal(nil.type, "Nil");
  assert.equal(nil.receivable, 0);
  assert.equal(nil.credit, 0);
});

/* ── Row building ────────────────────────────────────────────────────────── */

test("a row carries opening, movement, balance, side, count and last date", () => {
  const r = svc.buildOutstandingRow(
    ledger({ openingBalance: 1000, openingBalanceType: "Dr" }),
    { debit: 50000, credit: 20000, transactionCount: 4, lastTransactionDate: new Date("2026-08-01") },
  );
  assert.equal(r.openingBalance, 1000);
  assert.equal(r.openingType, "Dr");
  assert.equal(r.debit, 50000);
  assert.equal(r.credit, 20000);
  assert.equal(r.balance, 31000);
  assert.equal(r.balanceType, "Dr");
  assert.equal(r.receivable, 31000);
  assert.equal(r.customerCredit, 0);
  assert.equal(r.transactionCount, 4);
  assert.equal(r.gstin, "27AAAAA0000A1Z5");
  assert.match(r.code, /^C-[0-9A-Z]{5}$/);
});

test("a ledger with no vouchers still reports its opening balance", () => {
  const r = svc.buildOutstandingRow(ledger({ openingBalance: 7500, openingBalanceType: "Dr" }), {});
  assert.equal(r.balance, 7500);
  assert.equal(r.balanceType, "Dr");
  assert.equal(r.transactionCount, 0);
});

test("receipts beyond the invoiced amount put the customer IN CREDIT, not in negative debt", () => {
  const r = svc.buildOutstandingRow(ledger(), { debit: 10000, credit: 15000 });
  assert.equal(r.balanceType, "Cr");
  assert.equal(r.balance, 5000);
  assert.equal(r.receivable, 0);
  assert.equal(r.customerCredit, 5000);
});

/* ── Totals ──────────────────────────────────────────────────────────────── */

test("a customer in credit does NOT reduce the receivable total", () => {
  const rows = [
    svc.buildOutstandingRow(ledger({ _id: ID_A }), { debit: 100000, credit: 0 }),
    svc.buildOutstandingRow(ledger({ _id: ID_B }), { debit: 0, credit: 40000 }),
  ];
  const t = svc.totalsOf(rows);
  assert.equal(t.receivable, 100000, "the debt the business is carrying is 1,00,000");
  assert.equal(t.customerCredit, 40000);
  assert.equal(t.netBalance, 60000, "netting is offered separately, for the control account");
  assert.equal(t.debtorCount, 1);
  assert.equal(t.creditCount, 1);
});

/* ── Filters ─────────────────────────────────────────────────────────────── */

const mixed = () => [
  svc.buildOutstandingRow(ledger({ _id: ID_A, name: "Big Dr" }), { debit: 100000, credit: 0 }),
  svc.buildOutstandingRow(ledger({ _id: ID_B, name: "Small Dr" }), { debit: 500, credit: 0 }),
  svc.buildOutstandingRow(ledger({ _id: ID_A, name: "In Credit" }), { debit: 0, credit: 20000 }),
  svc.buildOutstandingRow(ledger({ _id: ID_B, name: "Settled" }), { debit: 900, credit: 900 }),
];

test("balanceSide=debit keeps only receivables", () => {
  const out = svc.applyBalanceFilters(mixed(), { balanceSide: "debit" });
  assert.deepEqual(out.map((r) => r.name), ["Big Dr", "Small Dr"]);
});

test("balanceSide=credit keeps only customers in credit", () => {
  const out = svc.applyBalanceFilters(mixed(), { balanceSide: "credit" });
  assert.deepEqual(out.map((r) => r.name), ["In Credit"]);
});

test("balanceSide=both keeps every non-nil balance and drops the settled ledger", () => {
  const out = svc.applyBalanceFilters(mixed(), { balanceSide: "both" });
  assert.deepEqual(out.map((r) => r.name), ["Big Dr", "Small Dr", "In Credit"]);
});

test("minOutstanding is a materiality threshold on the magnitude, not a sign filter", () => {
  const out = svc.applyBalanceFilters(mixed(), { minOutstanding: 1000, balanceSide: "both" });
  assert.deepEqual(
    out.map((r) => r.name),
    ["Big Dr", "In Credit"],
    "a 20,000 credit clears a 1,000 minimum just as a 20,000 receivable would",
  );
});

/* ── Request validation — fail closed ────────────────────────────────────── */

test("a missing companyId is an error, never a default", () => {
  const { errors } = svc.parseReportQuery({});
  assert.ok(errors.some((e) => /companyId/.test(e)));
});

test("a malformed companyId is an error", () => {
  const { errors } = svc.parseReportQuery({ companyId: "not-an-id" });
  assert.ok(errors.some((e) => /companyId/.test(e)));
});

test("an unparseable asOf is an error, not silently today", () => {
  const { errors } = svc.parseReportQuery({ companyId: COMPANY, asOf: "yesterday" });
  assert.ok(errors.some((e) => /asOf/.test(e)));
});

test("asOf is pushed to the end of the day so same-day vouchers are included", () => {
  const { filters } = svc.parseReportQuery({ companyId: COMPANY, asOf: "2026-08-31" });
  // Asserted as an INSTANT, not with getHours(): the point of the business
  // timezone is that this is the same moment on a UTC server and an IST one,
  // and a local-time assertion would pass on this laptop and hide the bug in
  // production. 23:59:59.999 IST on 31 Aug is 18:29:59.999Z.
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  assert.equal(
    filters.asOf.getTime(),
    Date.UTC(2026, 7, 31, 23, 59, 59, 999) - offsetMs,
  );
});

test("a date-only boundary is read in BUSINESS time, not server time", () => {
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  const { filters } = svc.parseReportQuery({
    companyId: COMPANY,
    from: "2026-06-01",
    to: "2026-06-30",
  });
  assert.equal(filters.from.getTime(), Date.UTC(2026, 5, 1) - offsetMs);
  assert.equal(filters.to.getTime(), Date.UTC(2026, 5, 30, 23, 59, 59, 999) - offsetMs);
});

test("a boundary carrying its own time or zone is honoured as given", () => {
  const { filters } = svc.parseReportQuery({
    companyId: COMPANY,
    asOf: "2026-08-31T10:00:00.000Z",
  });
  assert.equal(filters.asOf.toISOString(), "2026-08-31T10:00:00.000Z");
});

/* ── The as-of date is never absent ──────────────────────────────────────── */

test("a missing asOf resolves to the END OF TODAY in business time, never to open-ended", () => {
  const now = new Date("2026-09-07T04:00:00.000Z"); // 09:30 IST on 7 Sep
  const eff = svc.effectiveAsOf(null, now);
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  assert.equal(eff.getTime(), Date.UTC(2026, 8, 7, 23, 59, 59, 999) - offsetMs);
  assert.ok(eff > now, "the bound is later today, so today's vouchers count");
});

test("a late-evening IST instant still resolves to TODAY's end, not tomorrow's", () => {
  // 23:00 IST on 7 Sep is 17:30Z on 7 Sep. A UTC-based day calculation would
  // agree here; the case that separates them is the other side of midnight.
  const eff = svc.effectiveAsOf(null, new Date("2026-09-07T17:30:00.000Z"));
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  assert.equal(eff.getTime(), Date.UTC(2026, 8, 7, 23, 59, 59, 999) - offsetMs);
});

test("00:30 IST belongs to the NEW business day, not the previous UTC one", () => {
  // 00:30 IST on 8 Sep is 19:00Z on 7 Sep. Reading the day in UTC would date
  // the report 7 Sep and drop everything posted in that first half-hour.
  const eff = svc.effectiveAsOf(null, new Date("2026-09-07T19:00:00.000Z"));
  const offsetMs = svc.BUSINESS_UTC_OFFSET_MINUTES * 60000;
  assert.equal(eff.getTime(), Date.UTC(2026, 8, 8, 23, 59, 59, 999) - offsetMs);
});

test("an explicit asOf is never overridden by the default", () => {
  const explicit = new Date("2026-06-30T18:29:59.999Z");
  assert.equal(svc.effectiveAsOf(explicit, new Date("2026-09-07")).getTime(), explicit.getTime());
});

test("from must not be after to", () => {
  const { errors } = svc.parseReportQuery({
    companyId: COMPANY,
    from: "2026-08-01",
    to: "2026-07-01",
  });
  assert.ok(errors.some((e) => /from must not be after to/.test(e)));
});

test("a negative minOutstanding is an error", () => {
  const { errors } = svc.parseReportQuery({ companyId: COMPANY, minOutstanding: "-5" });
  assert.ok(errors.some((e) => /minOutstanding/.test(e)));
});

test("an unknown balanceSide or scope is an error", () => {
  assert.ok(svc.parseReportQuery({ companyId: COMPANY, balanceSide: "sideways" }).errors.length);
  assert.ok(svc.parseReportQuery({ companyId: COMPANY, scope: "everything" }).errors.length);
});

test("scope=selected with no usable ids is refused rather than widened to all", () => {
  const { errors } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "selected",
    ledgerIds: "not-an-id,also-not",
  });
  assert.ok(errors.some((e) => /Select at least one customer/.test(e)));
});

test("ledgerIds accept both a comma-joined string and repeated params, deduplicated", () => {
  const a = new mongoose.Types.ObjectId().toString();
  const b = new mongoose.Types.ObjectId().toString();
  const { filters } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "selected",
    ledgerIds: [`${a},${b}`, a],
  });
  assert.deepEqual(filters.ledgerIds.sort(), [a, b].sort());
});

test("malformed ids inside a valid selection are dropped, not passed to Mongo", () => {
  const a = new mongoose.Types.ObjectId().toString();
  const { errors, filters } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "selected",
    ledgerIds: `${a},<script>`,
  });
  assert.equal(errors.length, 0);
  assert.deepEqual(filters.ledgerIds, [a]);
});

test("more ledgers than the cap is refused", () => {
  const many = Array.from({ length: svc.MAX_EXPORT_LEDGERS + 1 }, () =>
    new mongoose.Types.ObjectId().toString(),
  );
  const { errors } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "selected",
    ledgerIds: many.join(","),
  });
  assert.ok(errors.some((e) => /At most/.test(e)));
});

/* ── "Current filtered result" is defined by its id list ─────────────────── */

test("scope=filtered with an EMPTY list is valid and stays empty", () => {
  const { errors, filters } = svc.parseReportQuery({
    companyId: COMPANY,
    scope: "filtered",
    ledgerIds: "",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(filters.ledgerIds, []);
  assert.equal(filters.ledgerIdsProvided, true, "present-but-empty is not absent");
  assert.equal(filters.restrictToIds, true, "and it must still narrow to nothing");
});

test("scope=filtered with NO ledgerIds at all is refused, never widened to every customer", () => {
  const { errors } = svc.parseReportQuery({ companyId: COMPANY, scope: "filtered" });
  assert.ok(
    errors.some((e) => /must send the ledger ids/.test(e)),
    "an absent id list on an id-defined scope is a caller bug, and the safe answer is a refusal",
  );
});

test("both id scopes are marked as restricting to their ids; `all` is not", () => {
  const q = (scope, extra = {}) =>
    svc.parseReportQuery({ companyId: COMPANY, scope, ...extra }).filters.restrictToIds;
  assert.equal(q("selected", { ledgerIds: ID_A_OID }), true);
  assert.equal(q("filtered", { ledgerIds: "" }), true);
  assert.equal(q("all", { ledgerIds: ID_A_OID }), false);
});

/* ── The applied-filters line ────────────────────────────────────────────── */

test("the filter summary names the scope, the search, the minimum and the side", () => {
  const s = svc.describeFilters(
    {
      scope: "filtered",
      search: "acme",
      minOutstanding: 5000,
      balanceSide: "debit",
    },
    {},
  );
  assert.match(s, /current filtered result/);
  assert.match(s, /"acme"/);
  assert.match(s, /5,000/);
  assert.match(s, /receivable \(Dr\) only/);
});

test("an id-scoped summary says how many ledgers actually resolved", () => {
  assert.match(
    svc.describeFilters({ scope: "selected", balanceSide: "both" }, { resolvedCount: 3 }),
    /selected customers \(3\)/,
  );
  assert.match(
    svc.describeFilters({ scope: "filtered", balanceSide: "both" }, { resolvedCount: 12 }),
    /current filtered result \(12\)/,
  );
});

test("an id-scoped summary does NOT claim a search it did not apply", () => {
  const s = svc.describeFilters(
    { scope: "filtered", search: "acme", balanceSide: "both", restrictToIds: true },
    { resolvedCount: 2 },
  );
  assert.ok(
    !/acme/.test(s),
    "the ids ARE the filter; printing the screen's search would describe a narrowing that never ran",
  );
});

test("the minimum balance is described for every scope, including selected", () => {
  for (const scope of ["all", "filtered", "selected"]) {
    assert.match(
      svc.describeFilters({ scope, minOutstanding: 5000, balanceSide: "both" }, {}),
      /Minimum balance: ₹5,000/,
      `${scope} must state the minimum it applied`,
    );
  }
});
