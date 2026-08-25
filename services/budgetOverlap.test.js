const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scopeRank,
  candidateFrom,
  compareCandidates,
  isArbitraryTie,
  covers,
  assignMovements,
  contestedLedgers,
} = require("./budgetOverlap.service");

const LEDGER = "aaaaaaaaaaaaaaaaaaaaaaaa";

const budget = (over = {}) => ({
  _id: "b1",
  startDate: "2026-04-01T00:00:00.000Z",
  endDate: "2027-03-31T00:00:00.000Z",
  scope: "company",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const line = (over = {}) => ({ _id: "l1", ledgerId: LEDGER, nature: "expense", ...over });
const cand = (b = {}, l = {}) => candidateFrom(budget(b), line(l));

const mv = (over = {}) => ({
  ledgerId: LEDGER,
  voucherId: "v1",
  voucherDate: "2026-08-15T00:00:00.000Z",
  debit: 100000,
  credit: 0,
  ...over,
});

/* ── Scope ranking ───────────────────────────────────────────────────────── */

test("project beats department beats company", () => {
  assert.ok(scopeRank("project") < scopeRank("department"));
  assert.ok(scopeRank("department") < scopeRank("company"));
});

test("an unset or unknown scope ranks as company, matching the list filter", () => {
  assert.equal(scopeRank(undefined), scopeRank("company"));
  assert.equal(scopeRank(null), scopeRank("company"));
  assert.equal(scopeRank("nonsense"), scopeRank("company"));
});

/* ── Building candidates ─────────────────────────────────────────────────── */

test("a line with no ledger cannot claim anything", () => {
  assert.equal(candidateFrom(budget(), line({ ledgerId: null })), null);
});

test("a budget with no usable window is refused rather than treated as forever", () => {
  assert.equal(candidateFrom(budget({ startDate: null }), line()), null);
  assert.equal(candidateFrom(budget({ endDate: "not a date" }), line()), null);
  // End before start is corrupt, not an empty window that claims nothing.
  assert.equal(
    candidateFrom(budget({ startDate: "2027-01-01", endDate: "2026-01-01" }), line()),
    null,
  );
});

/* ── The precedence rule ─────────────────────────────────────────────────── */

test("scope wins before period: a yearly project budget beats a quarterly company one", () => {
  const project = cand({ _id: "p", scope: "project" });
  const companyQ = cand({
    _id: "c",
    scope: "company",
    startDate: "2026-07-01",
    endDate: "2026-09-30",
  });
  assert.ok(compareCandidates(project, companyQ) < 0);
});

test("department beats company over the same period", () => {
  const dept = cand({ _id: "d", scope: "department" });
  const co = cand({ _id: "c", scope: "company" });
  assert.ok(compareCandidates(dept, co) < 0);
});

test("within one scope the narrower period wins", () => {
  const year = cand({ _id: "y" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" });
  assert.ok(compareCandidates(quarter, year) < 0);
});

test("same scope and same span: the budget drawn up later wins", () => {
  const older = cand({ _id: "a", createdAt: "2026-01-01" });
  const newer = cand({ _id: "b", createdAt: "2026-06-01" });
  assert.ok(compareCandidates(newer, older) < 0);
});

test("the comparator is a total order — two distinct lines never tie", () => {
  const a = cand({ _id: "a" }, { _id: "l1" });
  const b = cand({ _id: "a" }, { _id: "l2" });
  assert.notEqual(compareCandidates(a, b), 0);
  // And it is antisymmetric, so the sort cannot depend on input order.
  assert.equal(Math.sign(compareCandidates(a, b)), -Math.sign(compareCandidates(b, a)));
});

test("a decision reaching the id tie-break is reported as arbitrary", () => {
  const a = cand({ _id: "a" }, { _id: "l1" });
  const b = cand({ _id: "b" }, { _id: "l2" });
  assert.equal(isArbitraryTie(a, b), true);
  // Anything that genuinely distinguishes them is not arbitrary.
  assert.equal(isArbitraryTie(a, cand({ _id: "b", scope: "department" })), false);
  assert.equal(
    isArbitraryTie(a, cand({ _id: "b", startDate: "2026-07-01", endDate: "2026-09-30" })),
    false,
  );
});

/* ── Windows ─────────────────────────────────────────────────────────────── */

test("period bounds are inclusive at both ends, matching the actuals query", () => {
  const c = cand({ startDate: "2026-04-01T00:00:00.000Z", endDate: "2027-03-31T00:00:00.000Z" });
  assert.equal(covers(c, Date.parse("2026-04-01T00:00:00.000Z")), true);
  assert.equal(covers(c, Date.parse("2027-03-31T00:00:00.000Z")), true);
  assert.equal(covers(c, Date.parse("2026-03-31T23:59:59.999Z")), false);
  assert.equal(covers(c, Date.parse("2027-03-31T00:00:00.001Z")), false);
});

/* ── Which heads need the per-voucher pass ───────────────────────────────── */

test("a head claimed once is not contested", () => {
  assert.deepEqual(contestedLedgers([cand()]), []);
});

test("two lines on one head are contested even inside a single budget", () => {
  const a = cand({ _id: "b1" }, { _id: "l1" });
  const b = cand({ _id: "b1" }, { _id: "l2" });
  assert.deepEqual(contestedLedgers([a, b]), [LEDGER]);
});

/* ── Assignment ──────────────────────────────────────────────────────────── */

test("one voucher matching two budgets is counted once, by the winner", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });

  const { won, stats } = assignMovements({ candidates: [year, quarter], movements: [mv()] });

  assert.equal(won.get(quarter.key).debit, 100000);
  assert.equal(won.get(year.key).debit, 0, "the loser must read zero, not its old figure");
  assert.equal(stats.contestedMovements, 1);
  assert.equal(stats.duplicateSigned, 100000, "exactly what the old roll-up overstated by");
});

test("a loser that won nothing still gets an entry, so it cannot fall back", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });
  const { won } = assignMovements({ candidates: [year, quarter], movements: [mv()] });
  assert.ok(won.has(year.key));
});

test("a voucher outside the quarter goes to the year, which is the only claimant", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });

  const { won, stats } = assignMovements({
    candidates: [year, quarter],
    movements: [mv({ voucherDate: "2026-11-15" })],
  });

  assert.equal(won.get(year.key).debit, 100000);
  assert.equal(won.get(quarter.key).debit, 0);
  assert.equal(stats.contestedMovements, 0, "one claimant is not a contest");
  assert.equal(stats.duplicateSigned, 0);
});

test("a movement no line's period covers is counted by nobody", () => {
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });
  const { won, stats } = assignMovements({
    candidates: [quarter],
    movements: [mv({ voucherDate: "2026-11-15" })],
  });
  assert.equal(won.get(quarter.key).debit, 0);
  assert.equal(stats.unclaimedMovements, 1);
});

test("assignment is per (head, voucher): one voucher can feed two budgets on two heads", () => {
  const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const a = cand({ _id: "a" }, { _id: "la", ledgerId: LEDGER });
  const b = cand({ _id: "b", scope: "department" }, { _id: "lb", ledgerId: OTHER });

  const { won } = assignMovements({
    candidates: [a, b],
    movements: [mv({ voucherId: "v1" }), mv({ voucherId: "v1", ledgerId: OTHER, debit: 5000 })],
  });

  assert.equal(won.get(a.key).debit, 100000);
  assert.equal(won.get(b.key).debit, 5000);
});

test("a voucher hitting one head twice is one voucher in the count", () => {
  const c = cand();
  // The aggregation already sums a voucher's entries into one row per head.
  const { won } = assignMovements({ candidates: [c], movements: [mv({ debit: 150000 })] });
  assert.equal(won.get(c.key).voucherCount, 1);
  assert.equal(won.get(c.key).debit, 150000);
});

test("credit movement is carried through unchanged — the sign rule lives elsewhere", () => {
  const c = cand({}, { nature: "revenue" });
  const { won } = assignMovements({
    candidates: [c],
    movements: [mv({ debit: 0, credit: 900000 })],
  });
  assert.equal(won.get(c.key).credit, 900000);
  assert.equal(won.get(c.key).debit, 0);
});

test("an arbitrary tie is counted so the route can admit to it", () => {
  const a = cand({ _id: "a" }, { _id: "l1" });
  const b = cand({ _id: "b" }, { _id: "l2" });
  const { stats } = assignMovements({ candidates: [a, b], movements: [mv()] });
  assert.equal(stats.contestedMovements, 1);
  assert.equal(stats.ambiguousMovements, 1);
});

test("a contest decided on a real rule is not counted as ambiguous", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });
  const { stats } = assignMovements({ candidates: [year, quarter], movements: [mv()] });
  assert.equal(stats.ambiguousMovements, 0);
});

test("three claimants: the winner takes it and the duplicate count knows about both losers", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const dept = cand({ _id: "d", scope: "department" }, { _id: "ld" });
  const proj = cand({ _id: "p", scope: "project" }, { _id: "lp" });

  const { won, stats } = assignMovements({ candidates: [year, dept, proj], movements: [mv()] });

  assert.equal(won.get(proj.key).debit, 100000);
  assert.equal(won.get(dept.key).debit, 0);
  assert.equal(won.get(year.key).debit, 0);
  assert.equal(stats.duplicateSigned, 200000, "two losers were each adding it to the headline");
});

test("the winner does not depend on the order candidates arrive in", () => {
  const year = cand({ _id: "y" }, { _id: "ly" });
  const quarter = cand({ _id: "q", startDate: "2026-07-01", endDate: "2026-09-30" }, { _id: "lq" });

  const forward = assignMovements({ candidates: [year, quarter], movements: [mv()] });
  const reverse = assignMovements({ candidates: [quarter, year], movements: [mv()] });

  assert.equal(forward.won.get(quarter.key).debit, reverse.won.get(quarter.key).debit);
  assert.equal(forward.won.get(year.key).debit, reverse.won.get(year.key).debit);
});
