// services/forecastCashLedgerConfig.test.js
//
// Pure tests for Chunk 1-D's operating-cash ledger selection. No database.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("./forecastCashLedgerConfig.service");

const ACTOR = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Priya Editor" };
const CO = "bbbbbbbbbbbbbbbbbbbbbbbb";
const L1 = "111111111111111111111111";
const L2 = "222222222222222222222222";
const L3 = "333333333333333333333333";

function body(overrides = {}) {
  return { companyId: CO, includedLedgerIds: [L1], ...overrides };
}

function throwsCode(fn, code, msg) {
  assert.throws(
    fn,
    (e) => {
      assert.ok(
        e instanceof svc.ForecastCashLedgerConfigError,
        `expected ForecastCashLedgerConfigError, got ${e && e.name}: ${e && e.message}`,
      );
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      return true;
    },
    msg,
  );
}

/* ── Valid config ────────────────────────────────────────────────────────── */

test("a valid config produces scope and $set", () => {
  const r = svc.buildUpdate(
    body({ includedLedgerIds: [L1, L2], excludedLedgerIds: [L3], notes: "CEO accounts excluded" }),
    ACTOR,
  );

  assert.deepEqual(r.scope, { companyId: CO });
  assert.deepEqual(r.$set.includedLedgerIds, [L1, L2]);
  assert.deepEqual(r.$set.excludedLedgerIds, [L3]);
  assert.deepEqual(r.$set.odLedgerIds, []);
  assert.equal(r.$set.notes, "CEO accounts excluded");
  assert.equal(r.$set.updatedBy, ACTOR.id);
  assert.equal(r.$set.updatedByName, "Priya Editor");
});

test("omitted arrays default to empty, not undefined", () => {
  const r = svc.buildUpdate({ companyId: CO }, ACTOR);
  assert.deepEqual(r.$set.includedLedgerIds, []);
  assert.deepEqual(r.$set.excludedLedgerIds, []);
  assert.deepEqual(r.$set.odLedgerIds, []);
});

test("an empty included list is allowed — 'none of these are operating cash' is an answer", () => {
  const r = svc.buildUpdate(body({ includedLedgerIds: [], excludedLedgerIds: [L1] }), ACTOR);
  assert.deepEqual(r.$set.includedLedgerIds, []);
});

test("the $set contains only config fields and provenance", () => {
  const r = svc.buildUpdate(body({ notes: "x" }), ACTOR);
  assert.deepEqual(Object.keys(r.$set).sort(), [
    "excludedLedgerIds",
    "includedLedgerIds",
    "notes",
    "odLedgerIds",
    "updatedBy",
    "updatedByName",
  ]);
  assert.ok(!("companyId" in r.$set), "companyId is scope, not a writable field");
});

/* ── Required / types ────────────────────────────────────────────────────── */

test("companyId is required and must be a valid id", () => {
  const b = body();
  delete b.companyId;
  throwsCode(() => svc.buildUpdate(b, ACTOR), "REQUIRED");
  throwsCode(() => svc.buildUpdate(body({ companyId: "" }), ACTOR), "REQUIRED");
  throwsCode(() => svc.buildUpdate(body({ companyId: "nope" }), ACTOR), "INVALID_ID");
  throwsCode(() => svc.buildUpdate(body({ companyId: true }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate(body({ companyId: { $ne: null } }), ACTOR), "INVALID_TYPE");
});

test("a non-array ledger list is refused", () => {
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: L1 }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: {} }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: true }), ACTOR), "INVALID_TYPE");
  throwsCode(() => svc.buildUpdate(body({ odLedgerIds: 5 }), ACTOR), "INVALID_TYPE");
});

test("an invalid id inside a list is refused", () => {
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: [L1, "junk"] }), ACTOR), "INVALID_ID");
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: [123] }), ACTOR), "INVALID_ID");
});

test("booleans and objects inside a list are refused, not stringified", () => {
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: [true] }), ACTOR), "INVALID_TYPE");
  throwsCode(
    () => svc.buildUpdate(body({ includedLedgerIds: [{ $ne: null }] }), ACTOR),
    "INVALID_TYPE",
  );
});

test("a duplicate id is refused rather than silently de-duplicated", () => {
  // A duplicate means the caller's own state was inconsistent; collapsing it
  // quietly hides that from them.
  throwsCode(() => svc.buildUpdate(body({ includedLedgerIds: [L1, L1] }), ACTOR), "DUPLICATE_ID");
  throwsCode(() => svc.buildUpdate(body({ odLedgerIds: [L2, L2] }), ACTOR), "DUPLICATE_ID");
});

/* ── Role conflicts ──────────────────────────────────────────────────────── */

test("a ledger cannot be both included and excluded", () => {
  throwsCode(
    () => svc.buildUpdate(body({ includedLedgerIds: [L1], excludedLedgerIds: [L1] }), ACTOR),
    "ROLE_CONFLICT",
  );
});

test("a ledger cannot be both operating cash and OD", () => {
  throwsCode(
    () => svc.buildUpdate(body({ includedLedgerIds: [L1], odLedgerIds: [L1] }), ACTOR),
    "ROLE_CONFLICT",
  );
});

test("a ledger cannot be both excluded and OD", () => {
  throwsCode(
    () => svc.buildUpdate(body({ includedLedgerIds: [], excludedLedgerIds: [L1], odLedgerIds: [L1] }), ACTOR),
    "ROLE_CONFLICT",
  );
});

test("the same ledger in three different roles is refused, not resolved by precedence", () => {
  throwsCode(
    () =>
      svc.buildUpdate(
        body({ includedLedgerIds: [L1], excludedLedgerIds: [L1], odLedgerIds: [L1] }),
        ACTOR,
      ),
    "ROLE_CONFLICT",
  );
});

/* ── Whitelist / provenance ──────────────────────────────────────────────── */

test("an unsupported field is refused outright", () => {
  throwsCode(() => svc.buildUpdate(body({ openingCash: 999 }), ACTOR), "UNSUPPORTED_FIELD");
  throwsCode(() => svc.buildUpdate(body({ companyName: "x" }), ACTOR), "UNSUPPORTED_FIELD");
});

test("provenance cannot be supplied by the caller", () => {
  for (const f of ["updatedBy", "updatedByName", "createdAt", "updatedAt"]) {
    throwsCode(
      () => svc.buildUpdate(body({ [f]: "forged" }), ACTOR),
      "UNSUPPORTED_FIELD",
      `${f} should be refused`,
    );
  }
});

test("the body must be a plain object", () => {
  throwsCode(() => svc.buildUpdate(null, ACTOR), "INVALID_BODY");
  throwsCode(() => svc.buildUpdate([], ACTOR), "INVALID_BODY");
});

test("notes are optional, trimmed and capped", () => {
  assert.equal(svc.buildUpdate(body(), ACTOR).$set.notes, "");
  assert.equal(svc.buildUpdate(body({ notes: "  hi  " }), ACTOR).$set.notes, "hi");
  throwsCode(
    () => svc.buildUpdate(body({ notes: "x".repeat(svc.MAX_NOTES_LENGTH + 1) }), ACTOR),
    "TOO_LONG",
  );
});

/* ── Suggestions ─────────────────────────────────────────────────────────── */

test("an OD-group ledger is suggested as OD, whatever it is called", () => {
  assert.equal(svc.suggestRole({ name: "HDFC OD", groupName: "Bank OD A/c" }), "od");
  // The group is a structural fact and outranks any name pattern.
  assert.equal(
    svc.suggestRole({ name: "CEO's Personal OD", groupName: "Bank OD A/c" }),
    "od",
  );
});

test("an ordinary company cash/bank ledger is suggested as included", () => {
  assert.equal(svc.suggestRole({ name: "HDFC BANK A/C (CA-6085)", groupName: "Bank Accounts" }), "included");
  assert.equal(svc.suggestRole({ name: "INDIAN BANK (CA-3512)", groupName: "Bank Accounts" }), "included");
  assert.equal(svc.suggestRole({ name: "Petty Cash A/c", groupName: "Cash-in-Hand" }), "included");
  assert.equal(svc.suggestRole({ name: "Cash in Hand", groupName: "Cash-in-Hand" }), "included");
});

test("the real personal accounts on this chart are suggested excluded", () => {
  // These are the exact three the audit found being counted as company cash.
  assert.equal(svc.suggestRole({ name: "CEO Bank A/c (PA-6353)", groupName: "Bank Accounts" }), "excluded");
  assert.equal(svc.suggestRole({ name: "CEO's HDFC BANK A/C (PA-6160)", groupName: "Bank Accounts" }), "excluded");
  assert.equal(svc.suggestRole({ name: "CEO's Personal Cash", groupName: "Cash-in-Hand" }), "excluded");
});

test("the personal heuristic does not overfit — a plain officer title is NOT flagged", () => {
  // The possessive apostrophe is the discriminator: "CEO's HDFC Bank" reads
  // as a person's account, "CEO Operations Account" does not.
  assert.equal(svc.looksPersonal("CEO Operations Account"), false);
  assert.equal(svc.looksPersonal("Director Fees Payable"), false);
  assert.equal(svc.looksPersonal("Partner Bank A/c (CA-1234)"), false);
  assert.equal(svc.looksPersonal("HDFC BANK A/C (CA-6085)"), false);
  assert.equal(svc.looksPersonal("Cash"), false);
});

test("the personal heuristic catches its intended signals", () => {
  assert.equal(svc.looksPersonal("Something (PA-1234)"), true);
  assert.equal(svc.looksPersonal("PA 9988 Account"), true);
  assert.equal(svc.looksPersonal("Personal Savings"), true);
  assert.equal(svc.looksPersonal("Director's Account"), true);
  assert.equal(svc.looksPersonal("Proprietor's Cash"), true);
  assert.equal(svc.looksPersonal("MD's Bank"), true);
  // A curly apostrophe is still an apostrophe.
  assert.equal(svc.looksPersonal("CEO’s HDFC"), true);
});

test("a missing or non-string name is not personal, and does not throw", () => {
  assert.equal(svc.looksPersonal(null), false);
  assert.equal(svc.looksPersonal(undefined), false);
  assert.equal(svc.looksPersonal(42), false);
});

/* ── Candidates ──────────────────────────────────────────────────────────── */

const LEDGERS = [
  { _id: L1, name: "HDFC BANK A/C (CA-6085)", groupName: "Bank Accounts", balance: 500 },
  { _id: L2, name: "CEO's Personal Cash", groupName: "Cash-in-Hand", balance: 200 },
  { _id: L3, name: "HDFC OD", groupName: "Bank OD A/c", balance: -900 },
];

test("with NO saved config, selected mirrors suggested", () => {
  const c = svc.buildCandidates(LEDGERS, null);
  assert.deepEqual(
    c.map((x) => [x.name, x.suggestedRole, x.selectedRole]),
    [
      ["HDFC BANK A/C (CA-6085)", "included", "included"],
      ["CEO's Personal Cash", "excluded", "excluded"],
      ["HDFC OD", "od", "od"],
    ],
  );
  assert.equal(c[0].currentBalance, 500);
  assert.equal(c[1].personalNameSignal, true, "the screen can say WHY it is pre-set");
  assert.equal(c[0].personalNameSignal, false);
});

test("with a saved config, selected comes from the config even against the suggestion", () => {
  // Finance overruled the heuristic: the personal-looking account IS company
  // cash here. The saved decision must win.
  const c = svc.buildCandidates(LEDGERS, {
    includedLedgerIds: [L1, L2],
    excludedLedgerIds: [],
    odLedgerIds: [L3],
  });
  const byName = Object.fromEntries(c.map((x) => [x.name, x]));
  assert.equal(byName["CEO's Personal Cash"].selectedRole, "included");
  assert.equal(byName["CEO's Personal Cash"].suggestedRole, "excluded", "the suggestion is still reported");
  assert.equal(byName["HDFC OD"].selectedRole, "od");
});

test("a ledger created after the config was saved falls back to its suggestion", () => {
  const c = svc.buildCandidates(LEDGERS, { includedLedgerIds: [L1], excludedLedgerIds: [], odLedgerIds: [] });
  const byName = Object.fromEntries(c.map((x) => [x.name, x]));
  // L2 and L3 are in no list; they must not vanish or default to included.
  assert.equal(byName["CEO's Personal Cash"].selectedRole, "excluded");
  assert.equal(byName["HDFC OD"].selectedRole, "od");
});

test("buildCandidates tolerates empty and malformed input", () => {
  assert.deepEqual(svc.buildCandidates([], null), []);
  assert.deepEqual(svc.buildCandidates(null, null), []);
  const c = svc.buildCandidates([{ _id: L1 }], null);
  assert.equal(c[0].name, null);
  assert.equal(c[0].currentBalance, null);
  assert.equal(c[0].selectedRole, "included");
});

test("buildCandidates does not mutate its inputs", () => {
  const ledgers = JSON.parse(JSON.stringify(LEDGERS));
  const before = JSON.stringify(ledgers);
  svc.buildCandidates(ledgers, { includedLedgerIds: [L1], excludedLedgerIds: [], odLedgerIds: [] });
  assert.equal(JSON.stringify(ledgers), before);
});

/* ── Permission ──────────────────────────────────────────────────────────── */

test("canEdit is the shared predicate, not a second copy", () => {
  const creditTerms = require("./creditTerms.service");
  assert.equal(svc.canEdit, creditTerms.canEditTerms);
  assert.equal(svc.canEdit({ permissions: { canEdit: false } }), false);
  assert.equal(svc.canEdit(null), false);
});

/* ── Scope guard ─────────────────────────────────────────────────────────── */

test("scope guard: OD is never folded into the cash roles", () => {
  // OD is borrowing, not cash. It has its own role and its own list, and no
  // code path here can turn an OD ledger into included cash implicitly.
  assert.equal(svc.ROLES.length, 3);
  assert.deepEqual([...svc.ROLES].sort(), ["excluded", "included", "od"]);
  const r = svc.buildUpdate(body({ includedLedgerIds: [], odLedgerIds: [L3] }), ACTOR);
  assert.deepEqual(r.$set.includedLedgerIds, []);
  assert.deepEqual(r.$set.odLedgerIds, [L3]);
});
