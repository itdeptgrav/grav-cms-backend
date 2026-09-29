// services/partyStatementPack.test.js
//
// THE ASSEMBLY STEP, WITHOUT A DATABASE.
//
// `partyStatementPack` is deliberately not a calculation: it resolves a scope,
// calls the individual statement per party, and adds nothing up that is not a
// sum of what came back. That makes it testable by handing it statements and
// asserting on what it does with them — which is the only way to state the
// rules that matter here without seeding a company for each:
//
//   • the resolved population is capped BEFORE any statement is generated,
//     because `scope=all` names no ids and so slips past the id-list cap
//   • an empty filtered scope resolves to an empty pack
//   • an id scope is exact — the screen's search is not re-applied on top
//   • the totals are sums of the statements, signs intact
//
// The behaviour that needs real collections — company and party-kind
// isolation, date boundaries, the containers, no writes — is in
// test/accountant/{customer,supplier}-statement-pack.route.test.js.
//
// Run by `npm test` — node --test "services/**/*.test.js".

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const party = require("./partyOutstanding.service");
const pack = require("./partyStatementPack.service");

const COMPANY_ID = "6650a1b2c3d4e5f601020300";

/**
 * Swap the three functions the service reads from the balance engine, run
 * `fn`, and put them back. The engine itself is exercised by its own suites;
 * what is under test here is what this module does around it.
 */
async function withEngine({ ledgers = [], statementOf, company = { companyName: "Alpha" } }, fn) {
  const saved = {
    companyHeader: party.companyHeader,
    resolvePartyLedgers: party.resolvePartyLedgers,
    partyLedgerStatement: party.partyLedgerStatement,
  };
  const calls = { resolve: [], statements: [] };
  party.companyHeader = async () => company;
  party.resolvePartyLedgers = async (kind, companyId, opts) => {
    calls.resolve.push({ kind: kind.key, companyId: String(companyId), opts });
    return ledgers;
  };
  party.partyLedgerStatement = async (kind, filters) => {
    calls.statements.push(String(filters.ledgerId));
    return statementOf(filters.ledgerId);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    Object.assign(party, saved);
  }
}

const ledger = (id, name) => ({ _id: id, name, gstin: "", groupName: "Sundry Debtors" });

/** A statement as `partyLedgerStatement` returns one, with the figures given. */
const statement = (id, name, { openingSigned = 0, debit = 0, credit = 0, txns = 0 } = {}) => {
  const closingSigned = openingSigned + debit - credit;
  const side = (n) => (n < 0 ? "Cr" : "Dr");
  return {
    ledger: { ledgerId: String(id), code: `C-${id}`, name, gstin: "", groupName: "" },
    opening: { amount: Math.abs(openingSigned), type: side(openingSigned), signed: openingSigned },
    closing: { amount: Math.abs(closingSigned), type: side(closingSigned), signed: closingSigned },
    totals: { debit, credit, transactionCount: txns },
    rows: [],
  };
};

/* ── The cap is on the RESOLVED population ───────────────────────────────── */

test("a scope resolving to more parties than the cap is refused before any statement", async () => {
  /* `parseReportQuery` caps the ID LIST, but `scope=all` sends no ids. Without
     a second check here a company with thousands of debtors would walk into
     ~3 queries per party and a document nobody can open. */
  const many = Array.from({ length: pack.MAX_PACK_LEDGERS + 1 }, (_, i) =>
    ledger(`id${i}`, `Party ${i}`),
  );
  const { calls } = await withEngine(
    { ledgers: many, statementOf: (id) => statement(id, "x") },
    async () => {
      await assert.rejects(
        () => pack.partyStatementPack("customer", { companyId: COMPANY_ID, scope: "all" }),
        (e) => {
          assert.equal(e.code, "EXPORT_TOO_LARGE");
          assert.equal(e.resolvedLedgerCount, pack.MAX_PACK_LEDGERS + 1);
          assert.match(e.message, /At most 2000 can be exported/);
          assert.match(e.message, /customers/);
          return true;
        },
      );
    },
  );
  assert.equal(calls.statements.length, 0, "not one statement may be generated first");
});

test("exactly the cap is allowed — the refusal is above it, not at it", async () => {
  const atCap = Array.from({ length: pack.MAX_PACK_LEDGERS }, (_, i) => ledger(`id${i}`, `P${i}`));
  const { result } = await withEngine(
    { ledgers: atCap, statementOf: (id) => statement(id, "x") },
    () => pack.partyStatementPack("customer", { companyId: COMPANY_ID, scope: "all" }),
  );
  assert.equal(result.statements.length, pack.MAX_PACK_LEDGERS);
});

test("the cap is the one every other export uses", () => {
  assert.equal(pack.MAX_PACK_LEDGERS, party.MAX_EXPORT_LEDGERS);
});

/* ── Scope ───────────────────────────────────────────────────────────────── */

test("an empty filtered scope resolves to an empty pack, not a full one", async () => {
  const { result, calls } = await withEngine(
    { ledgers: [], statementOf: () => null },
    () =>
      pack.partyStatementPack("customer", {
        companyId: COMPANY_ID,
        scope: "filtered",
        restrictToIds: true,
        ledgerIds: [],
      }),
  );
  assert.deepEqual(result.statements, []);
  assert.equal(result.resolvedLedgerCount, 0);
  assert.equal(result.totals.partyCount, 0);
  assert.equal(calls.resolve[0].opts.restrictToIds, true, "the id list IS the population");
  assert.deepEqual(calls.resolve[0].opts.ledgerIds, []);
});

test("an id scope does not re-apply the screen's search on top of the ids", async () => {
  /* The ids already are the filtered result. Searching again could only drop
     parties the user had selected. */
  const { calls } = await withEngine(
    { ledgers: [], statementOf: () => null },
    () =>
      pack.partyStatementPack("customer", {
        companyId: COMPANY_ID,
        scope: "selected",
        restrictToIds: true,
        ledgerIds: ["a"],
        search: "acme",
      }),
  );
  assert.equal(calls.resolve[0].opts.search, "");
});

test("a scope with no id list passes the search through", async () => {
  const { calls } = await withEngine(
    { ledgers: [], statementOf: () => null },
    () =>
      pack.partyStatementPack("customer", {
        companyId: COMPANY_ID,
        scope: "all",
        search: "acme",
      }),
  );
  assert.equal(calls.resolve[0].opts.search, "acme");
  assert.equal(calls.resolve[0].opts.restrictToIds, false);
});

test("the scope line names the kind and the resolved count", () => {
  const k = party.PARTY_KINDS.supplier;
  assert.equal(
    pack.describeScope(k, { scope: "all" }, { resolvedCount: 12 }),
    "Scope: all accounting suppliers (12)",
  );
  assert.equal(
    pack.describeScope(k, { scope: "selected" }, { resolvedCount: 2 }),
    "Scope: selected suppliers (2)",
  );
  assert.equal(
    pack.describeScope(k, { scope: "filtered" }, { resolvedCount: 0 }),
    "Scope: current filtered result (0)",
  );
});

test("a missing or unknown company is null, never an empty-but-successful pack", async () => {
  assert.equal(await pack.partyStatementPack("customer", { companyId: "not-an-id" }), null);
  const saved = party.companyHeader;
  party.companyHeader = async () => null;
  try {
    assert.equal(await pack.partyStatementPack("customer", { companyId: COMPANY_ID }), null);
  } finally {
    party.companyHeader = saved;
  }
});

/* ── The period is the request's, not the first statement's ──────────────── */

test("the period comes off the filters, so an EMPTY pack still states one", () => {
  const from = new Date("2026-04-01T00:00:00Z");
  const to = new Date("2026-06-30T23:59:59Z");
  assert.deepEqual(pack.packPeriod({ from, to }), {
    from,
    to,
    asOf: null,
    periodEnd: to,
    isRange: true,
  });
});

test("`to` wins over `asOf`, and `asOf` alone is an as-on pack", () => {
  const to = new Date("2026-06-30T23:59:59Z");
  const asOf = new Date("2026-12-31T23:59:59Z");
  assert.equal(pack.packPeriod({ to, asOf }).periodEnd, to);
  assert.equal(pack.packPeriod({ asOf }).periodEnd, asOf);
  assert.equal(pack.packPeriod({ asOf }).isRange, false);
});

/* ── Totals are sums, with the signs left alone ──────────────────────────── */

test("totals add the statements up and count only the parties that moved", () => {
  const totals = pack.packTotals([
    statement("a", "A", { openingSigned: 5000, debit: 12000, credit: 4000, txns: 2 }),
    statement("b", "B", { openingSigned: -2000, debit: 7500, credit: 0, txns: 1 }),
    statement("c", "C", {}),
  ]);
  assert.deepEqual(totals, {
    partyCount: 3,
    partiesWithMovement: 2,
    transactionCount: 3,
    debit: 19500,
    credit: 4000,
    openingSigned: 3000,
    closingSigned: 18500,
  });
});

test("a payable pack's signed totals stay NEGATIVE — nothing absolutes them", () => {
  const totals = pack.packTotals([
    statement("a", "A", { openingSigned: -5000, debit: 4000, credit: 12000, txns: 2 }),
    statement("b", "B", { openingSigned: 2000, debit: 0, credit: 7500, txns: 1 }),
  ]);
  assert.equal(totals.openingSigned, -3000);
  assert.equal(totals.closingSigned, -18500);
  assert.equal(totals.debit, 4000);
  assert.equal(totals.credit, 19500);
});

/* ── What the pack hands the writers ─────────────────────────────────────── */

test("the pack carries its kind's labels, company, period and scope", async () => {
  const { result } = await withEngine(
    {
      ledgers: [ledger("a", "Acme")],
      statementOf: (id) => statement(id, "Acme", { debit: 100, txns: 1 }),
      company: { companyName: "Alpha Metals", gstin: "27X" },
    },
    () =>
      pack.partyStatementPack("supplier", {
        companyId: COMPANY_ID,
        scope: "all",
        asOf: new Date("2026-06-30T23:59:59Z"),
      }),
  );
  assert.equal(result.reportType, "supplier-statement-pack");
  assert.equal(result.partyKind, "supplier");
  assert.equal(result.title, "Supplier Statement Pack");
  assert.equal(result.labels.filenameStem, "supplier-statements");
  assert.equal(result.labels.column, "Supplier");
  assert.equal(result.labels.primarySide, "Cr");
  assert.equal(result.company.companyName, "Alpha Metals");
  assert.equal(result.scopeSummary, "Scope: all accounting suppliers (1)");
  assert.equal(result.filters.companyId, COMPANY_ID);
  assert.equal(result.statements.length, 1);
});

test("a ledger that vanishes between resolving and stating is skipped, not half-emitted", async () => {
  const { result } = await withEngine(
    {
      ledgers: [ledger("a", "A"), ledger("gone", "Gone"), ledger("c", "C")],
      statementOf: (id) => (String(id) === "gone" ? null : statement(id, String(id))),
    },
    () => pack.partyStatementPack("customer", { companyId: COMPANY_ID, scope: "all" }),
  );
  assert.deepEqual(result.statements.map((s) => s.ledger.name), ["a", "c"]);
  assert.equal(result.resolvedLedgerCount, 3, "what the scope resolved to is still reported");
  assert.equal(result.totals.partyCount, 2, "the totals count what was actually stated");
});

test("statements are generated one at a time, in the resolved order", async () => {
  /* Sequential on purpose: three queries per party against the same Mongo the
     rest of the app is using. The order is also the order every format lists
     parties in, so the three downloads of one request agree. */
  const { calls } = await withEngine(
    {
      ledgers: [ledger("a", "A"), ledger("b", "B"), ledger("c", "C")],
      statementOf: (id) => statement(id, String(id)),
    },
    () => pack.partyStatementPack("customer", { companyId: COMPANY_ID, scope: "all" }),
  );
  assert.deepEqual(calls.statements, ["a", "b", "c"]);
});
