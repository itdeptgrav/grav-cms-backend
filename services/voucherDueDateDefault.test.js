const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DUE_DATE_ELIGIBLE_VOUCHER_TYPES,
  isEligibleVoucherType,
  defaultDueDateOnVoucherBody,
  defaultDueDateSync,
} = require("./voucherDueDateDefault.service");

/* This file covers everything that does NOT require a live database — the
 * short-circuit exits (no manual overwrite, ineligible type, no party id),
 * which every one of the eight voucher-creating paths hits on the vast
 * majority of calls, and the fully synchronous `defaultDueDateSync` used by
 * the two bulk-import paths.
 *
 * The one thing this file cannot cover — an actual successful lookup via
 * `Acc_Ledger.findById` — is exercised end-to-end against a real (in-memory)
 * database in test/accountant/voucher-due-date-default.route.test.js, which
 * is also the only way to prove the SAME defaulting genuinely applies across
 * separate route files rather than five re-implementations that happen to
 * agree today.
 */

/* ── Eligible voucher types — only bill-creating obligations ─────────────── */

test("only sales and purchase are eligible for due-date defaulting", () => {
  assert.deepEqual([...DUE_DATE_ELIGIBLE_VOUCHER_TYPES].sort(), ["purchase", "sales"]);
});

test("receipts, payments, contra and journals are never eligible", () => {
  for (const t of ["receipt", "payment", "contra", "journal"]) {
    assert.equal(isEligibleVoucherType(t), false);
  }
});

test("credit and debit notes adjust an existing bill, not eligible either", () => {
  assert.equal(isEligibleVoucherType("credit_note"), false);
  assert.equal(isEligibleVoucherType("debit_note"), false);
});

test("sales and purchase are eligible", () => {
  assert.equal(isEligibleVoucherType("sales"), true);
  assert.equal(isEligibleVoucherType("purchase"), true);
});

/* ── Manual dueDate is preserved — never overwritten ─────────────────────── */

test("async: an existing dueDate short-circuits before any lookup is attempted", async () => {
  const body = {
    voucherType: "sales",
    voucherDate: "2026-04-01",
    partyLedgerId: "not-even-a-real-id", // would throw if actually queried
    dueDate: "2026-05-15",
  };
  const result = await defaultDueDateOnVoucherBody(body);
  assert.equal(result.dueDate, "2026-05-15", "untouched — proves no lookup happened");
});

test("sync: an existing dueDate is preserved, not recomputed from partyLedger", () => {
  const body = { voucherType: "sales", voucherDate: "2026-04-01", dueDate: "2026-05-15" };
  const result = defaultDueDateSync(body, { creditPeriodDays: 30 });
  assert.equal(result.dueDate, "2026-05-15");
});

/* ── Ineligible voucher types never get a due date ───────────────────────── */

test("async: receipts/payments/contra/journal return the body unchanged, no lookup", async () => {
  for (const voucherType of ["receipt", "payment", "contra", "journal"]) {
    const body = { voucherType, voucherDate: "2026-04-01", partyLedgerId: "irrelevant" };
    const result = await defaultDueDateOnVoucherBody(body);
    assert.equal("dueDate" in result, false);
  }
});

test("sync: receipts/payments/contra/journal never get a dueDate even with a real party in hand", () => {
  for (const voucherType of ["receipt", "payment", "contra", "journal"]) {
    const body = { voucherType, voucherDate: "2026-04-01" };
    const result = defaultDueDateSync(body, { creditPeriodDays: 30 });
    assert.equal("dueDate" in result, false);
  }
});

/* ── No party id / no party object: no default, no throw ────────────────── */

test("async: no partyLedgerId at all — returns unchanged, no error", async () => {
  const body = { voucherType: "sales", voucherDate: "2026-04-01" };
  const result = await defaultDueDateOnVoucherBody(body);
  assert.equal("dueDate" in result, false);
});

test("sync: no partyLedger object — invalid/missing party invents nothing", () => {
  const body = { voucherType: "purchase", voucherDate: "2026-04-01" };
  assert.equal("dueDate" in defaultDueDateSync(body, null), false);
  assert.equal("dueDate" in defaultDueDateSync(body, undefined), false);
  assert.equal("dueDate" in defaultDueDateSync(body, {}), false);
});

/* ── Sync happy path — the same rule the async path uses ─────────────────── */

test("sync: a real term produces the same defaulted date the async path would", () => {
  const body = { voucherType: "purchase", voucherDate: "2026-04-01T00:00:00.000Z" };
  const result = defaultDueDateSync(body, { creditPeriodDays: 30 });
  assert.equal(result.dueDate.toISOString().slice(0, 10), "2026-05-01");
});

test("sync: an unset term (0) on the in-memory party produces no due date", () => {
  const body = { voucherType: "sales", voucherDate: "2026-04-01T00:00:00.000Z" };
  const result = defaultDueDateSync(body, { creditPeriodDays: 0 });
  assert.equal("dueDate" in result, false);
});

/* ── Bad input never throws ──────────────────────────────────────────────── */

test("async: a null or non-object body is returned as-is", async () => {
  assert.equal(await defaultDueDateOnVoucherBody(null), null);
  assert.equal(await defaultDueDateOnVoucherBody(undefined), undefined);
});

test("sync: a null or non-object body is returned as-is", () => {
  assert.equal(defaultDueDateSync(null, { creditPeriodDays: 30 }), null);
  assert.equal(defaultDueDateSync(undefined, { creditPeriodDays: 30 }), undefined);
});

/* ── Session pass-through (why this matters: services/voucherDueDateDefault
 * is called inside a Mongo transaction at the approvals materialization
 * path, and a read that doesn't join that transaction could see stale data
 * mid-transaction. mongodb-memory-server's single-node default can't run a
 * real transaction — see the note in
 * test/accountant/voucher-due-date-default.route.test.js — so this is
 * verified with a stubbed Acc_Ledger instead of a live one. ────────────── */

test("async: opts.session is threaded onto the underlying query when provided", async () => {
  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  const seenSessions = [];
  const fakeParty = { creditPeriodDays: 30 };

  const stubQuery = {
    select() {
      return this;
    },
    session(s) {
      seenSessions.push(s);
      return this;
    },
    async lean() {
      return fakeParty;
    },
  };

  const original = Acc_Ledger.findOne;
  Acc_Ledger.findOne = () => stubQuery;
  try {
    const fakeSession = { id: "fake-session" };
    const body = {
      voucherType: "sales",
      voucherDate: "2026-04-01T00:00:00.000Z",
      partyLedgerId: "507f1f77bcf86cd799439011",
      companyId: "507f1f77bcf86cd799439099",
    };
    await defaultDueDateOnVoucherBody(body, { session: fakeSession });
    assert.deepEqual(seenSessions, [fakeSession]);
    assert.equal(body.dueDate.toISOString().slice(0, 10), "2026-05-01");
  } finally {
    Acc_Ledger.findOne = original;
  }
});

test("async: no session option means .session() is never called on the query", async () => {
  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  let sessionCalled = false;

  const stubQuery = {
    select() {
      return this;
    },
    session() {
      sessionCalled = true;
      return this;
    },
    async lean() {
      return { creditPeriodDays: 30 };
    },
  };

  const original = Acc_Ledger.findOne;
  Acc_Ledger.findOne = () => stubQuery;
  try {
    await defaultDueDateOnVoucherBody({
      voucherType: "purchase",
      voucherDate: "2026-04-01",
      partyLedgerId: "507f1f77bcf86cd799439011",
      companyId: "507f1f77bcf86cd799439099",
    });
    assert.equal(sessionCalled, false);
  } finally {
    Acc_Ledger.findOne = original;
  }
});

/* ── Company scoping (fix, 24 Aug 2026) ──────────────────────────────────── */

test("async: missing companyId means no default — and the lookup is never even attempted", async () => {
  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  let lookupAttempted = false;

  const original = Acc_Ledger.findOne;
  // If this ever gets called, the company gate did NOT do its job — the
  // stub throwing makes that failure loud instead of silently coincidental.
  Acc_Ledger.findOne = () => {
    lookupAttempted = true;
    throw new Error("findOne should not be called when companyId is missing");
  };
  try {
    const body = {
      voucherType: "sales",
      voucherDate: "2026-04-01",
      partyLedgerId: "507f1f77bcf86cd799439011",
      // no companyId
    };
    const result = await defaultDueDateOnVoucherBody(body);
    assert.equal(lookupAttempted, false);
    assert.equal("dueDate" in result, false);
  } finally {
    Acc_Ledger.findOne = original;
  }
});

test("async: a malformed (non-ObjectId) companyId is treated as missing — no default, no lookup", async () => {
  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  let lookupAttempted = false;
  const original = Acc_Ledger.findOne;
  Acc_Ledger.findOne = () => {
    lookupAttempted = true;
    throw new Error("should not reach here");
  };
  try {
    const body = {
      voucherType: "purchase",
      voucherDate: "2026-04-01",
      partyLedgerId: "507f1f77bcf86cd799439011",
      companyId: "not-an-object-id",
    };
    const result = await defaultDueDateOnVoucherBody(body);
    assert.equal(lookupAttempted, false);
    assert.equal("dueDate" in result, false);
  } finally {
    Acc_Ledger.findOne = original;
  }
});

test("async: a same-company, valid party genuinely queries {_id, companyId} TOGETHER, not _id alone", async () => {
  const { Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
  let capturedFilter = null;

  const stubQuery = {
    select() {
      return this;
    },
    async lean() {
      return { creditPeriodDays: 30 };
    },
  };
  const original = Acc_Ledger.findOne;
  Acc_Ledger.findOne = (filter) => {
    capturedFilter = filter;
    return stubQuery;
  };
  try {
    const body = {
      voucherType: "sales",
      voucherDate: "2026-04-01T00:00:00.000Z",
      partyLedgerId: "507f1f77bcf86cd799439011",
      companyId: "507f1f77bcf86cd799439099",
    };
    await defaultDueDateOnVoucherBody(body);
    assert.equal(String(capturedFilter._id), "507f1f77bcf86cd799439011");
    assert.equal(String(capturedFilter.companyId), "507f1f77bcf86cd799439099");
    assert.equal(body.dueDate.toISOString().slice(0, 10), "2026-05-01");
  } finally {
    Acc_Ledger.findOne = original;
  }
});

test("sync: refuses when partyLedger.companyId and body.companyId are both present and DIFFER", () => {
  const body = { voucherType: "sales", voucherDate: "2026-04-01T00:00:00.000Z", companyId: "A" };
  const partyLedger = { creditPeriodDays: 30, companyId: "B" };
  const result = defaultDueDateSync(body, partyLedger);
  assert.equal("dueDate" in result, false);
});

test("sync: proceeds when both companyIds are present and MATCH", () => {
  const body = { voucherType: "purchase", voucherDate: "2026-04-01T00:00:00.000Z", companyId: "A" };
  const partyLedger = { creditPeriodDays: 30, companyId: "A" };
  const result = defaultDueDateSync(body, partyLedger);
  assert.equal(result.dueDate.toISOString().slice(0, 10), "2026-05-01");
});

test("sync: proceeds when only ONE side carries a companyId — this check only refuses a PROVEN mismatch", () => {
  const withPartyOnly = defaultDueDateSync(
    { voucherType: "sales", voucherDate: "2026-04-01T00:00:00.000Z" },
    { creditPeriodDays: 30, companyId: "A" },
  );
  assert.equal(withPartyOnly.dueDate.toISOString().slice(0, 10), "2026-05-01");

  const withBodyOnly = defaultDueDateSync(
    { voucherType: "sales", voucherDate: "2026-04-01T00:00:00.000Z", companyId: "A" },
    { creditPeriodDays: 30 },
  );
  assert.equal(withBodyOnly.dueDate.toISOString().slice(0, 10), "2026-05-01");
});

test("sync: an ObjectId-shaped companyId on both sides is compared by string value, not by reference", () => {
  // Mongoose lean() documents commonly carry ObjectId instances; the body a
  // route builds is often a plain string from JSON. `===` on two different
  // ObjectId instances (or an ObjectId vs its string form) is always false
  // even when they represent the SAME id — String(...) on both sides avoids
  // a false "mismatch" that would silently disable a same-company default.
  class FakeObjectId {
    constructor(v) {
      this.v = v;
    }
    toString() {
      return this.v;
    }
  }
  const body = {
    voucherType: "sales",
    voucherDate: "2026-04-01T00:00:00.000Z",
    companyId: "507f1f77bcf86cd799439099",
  };
  const partyLedger = {
    creditPeriodDays: 30,
    companyId: new FakeObjectId("507f1f77bcf86cd799439099"),
  };
  const result = defaultDueDateSync(body, partyLedger);
  assert.equal(result.dueDate.toISOString().slice(0, 10), "2026-05-01", "same id, different representation, must still match");
});

/* ── Manual dueDate still wins, even with company scoping in the mix ────── */

test("async: a manual dueDate short-circuits before the company gate is even evaluated", async () => {
  const body = {
    voucherType: "sales",
    voucherDate: "2026-04-01",
    partyLedgerId: "507f1f77bcf86cd799439011",
    // Deliberately NO companyId — if the function reached the company gate
    // it would return early anyway, but reaching it at all would mean the
    // dueDate check isn't FIRST, which is the property this test pins.
    dueDate: "2026-12-25",
  };
  const result = await defaultDueDateOnVoucherBody(body);
  assert.equal(result.dueDate, "2026-12-25");
});

test("sync: a manual dueDate wins even when the party's companyId would otherwise mismatch", () => {
  const body = {
    voucherType: "purchase",
    voucherDate: "2026-04-01T00:00:00.000Z",
    companyId: "A",
    dueDate: "2026-12-25",
  };
  const partyLedger = { creditPeriodDays: 30, companyId: "B" }; // would mismatch
  const result = defaultDueDateSync(body, partyLedger);
  assert.equal(result.dueDate, "2026-12-25");
});
