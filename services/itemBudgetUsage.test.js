"use strict";
/**
 * services/itemBudgetUsage.test.js
 *
 * THE ARITHMETIC OF THE ITEM-WISE BUDGET USAGE REPORT.
 *
 * Pure — the service takes commitments already loaded, so every rule below is
 * testable without a database, and the route stays a scope plus a projection.
 *
 * The report answers one question: which items and services are consuming each
 * budget head. The dangerous ways to answer it wrongly are all here — merging
 * two heads into one figure, merging two requests on a shared name, counting a
 * bill twice, counting an unbudgeted promise into a head it never touched, and
 * presenting "bills matched to these commitments" as the accounting actuals.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const usage = require("./itemBudgetUsage.service");

const RAW = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PACK = "bbbbbbbbbbbbbbbbbbbbbbbb";
const FABRIC = "111111111111111111111111";
const AMC = "222222222222222222222222";

let seq = 0;
const oid = (n) => String(n).padStart(24, "0");

/** One allocation, with the fields the release path actually maintains. */
const alloc = (over = {}) => ({
  spendLineId: oid(++seq),
  name: "Cotton Fabric",
  itemId: FABRIC,
  itemSku: "RAW-FAB-001",
  ledgerId: RAW,
  ledgerName: "Raw Material Purchase",
  budgetId: oid(900),
  financialYear: "2026-27",
  amount: 10000,
  releasedAmount: 0,
  remainingAmount: 10000,
  status: "committed",
  resolutionSource: "category_mapping",
  ...over,
});

const commitment = (allocations, over = {}) => ({
  _id: oid(++seq),
  spendRequestId: oid(++seq),
  spendRequestNumber: `SPR-${seq}`,
  companyId: oid(1),
  department: "Logistics",
  financialYear: "2026-27",
  amount: (allocations || []).reduce((t, a) => t + a.amount, 0),
  status: "committed",
  allocations,
  allocationMode: "line_wise",
  headCount: new Set((allocations || []).map((a) => String(a.ledgerId))).size,
  committedAt: new Date("2026-07-01T10:00:00.000Z"),
  committedByName: "Asha",
  ...over,
});

const report = (commitments, opts = {}) => usage.buildReport({ commitments, ...opts });
const groupFor = (r, name) => r.groups.find((g) => g.name === name);

/* ── 1 · TWO ALLOCATIONS FOR ONE ITEM AND HEAD ARE ONE ROW ────────────────── */

test("two allocations for the same item and head group into one row", () => {
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })]),
    commitment([alloc({ amount: 6000, remainingAmount: 6000 })]),
  ]);

  assert.equal(r.groups.length, 1);
  const g = r.groups[0];
  assert.equal(g.approved, 16000);
  assert.equal(g.reserved, 16000);
  assert.equal(g.billed, 0);
  /* Both requests are reachable underneath — a merged figure nobody can open
     is a figure nobody can check. */
  assert.equal(g.lines.length, 2);
  assert.equal(new Set(g.lines.map((l) => l.spendRequestNumber)).size, 2);
  assert.equal(r.summary.requestCount, 2);
});

/* ── 2 · ONE ITEM ACROSS TWO HEADS STAYS TWO FACTS ────────────────────────── */

test("one item bought out of two heads is never merged", () => {
  const r = report([
    commitment([
      alloc({ amount: 10000, remainingAmount: 10000 }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: PACK, ledgerName: "Packaging" }),
    ]),
  ]);

  assert.equal(r.groups.length, 2);
  const byHead = Object.fromEntries(r.groups.map((g) => [g.ledgerName, g]));
  assert.equal(byHead["Raw Material Purchase"].approved, 10000);
  assert.equal(byHead["Packaging"].approved, 4000);
  /* Same item identity, two rows — a single figure would belong to no budget
     line and could not be checked against one. */
  assert.equal(new Set(r.groups.map((g) => g.identityKey)).size, 1);
  assert.equal(r.summary.approved, 14000);
});

/* ── 3 · PARTIAL BILLING ──────────────────────────────────────────────────── */

test("a partly billed allocation reports what was billed and what remains", () => {
  const r = report([commitment([alloc({
    amount: 10000, releasedAmount: 4000, remainingAmount: 6000,
    status: "partially_released",
    releases: [{ voucherId: oid(11), voucherNumber: "PUR-1", amount: 4000, at: new Date("2026-08-01") }],
  })])]);

  const g = r.groups[0];
  assert.equal(g.approved, 10000);
  assert.equal(g.billed, 4000);
  assert.equal(g.reserved, 6000);
  assert.equal(g.status, usage.STATUS.PARTIAL);
  /* Approved is never rewritten by a release: "what was promised" and "what
     is still promised" stay two separate answers. */
  assert.equal(g.billed + g.reserved, g.approved);
});

test("a row written before remainingAmount existed falls back safely", () => {
  const legacyShape = alloc({ amount: 10000, releasedAmount: 4000 });
  delete legacyShape.remainingAmount;
  assert.deepEqual(usage.figuresOf(legacyShape), { approved: 10000, billed: 4000, reserved: 6000 });

  /* `blank is not zero`: a MISSING remaining falls back, a stored zero does
     not. Reading the missing one as zero would report every older row as
     fully billed, which is the opposite of the truth. */
  assert.equal(usage.figuresOf({ amount: 10000, releasedAmount: 0, remainingAmount: 0 }).reserved, 0);
  assert.equal(usage.figuresOf({ amount: 10000, releasedAmount: 0 }).reserved, 10000);

  /* And an over-billed row never reports negative reserved money — that is a
     real and separate problem, and a negative would corrupt every total that
     contained it. */
  const over = alloc({ amount: 10000, releasedAmount: 12000 });
  delete over.remainingAmount;
  assert.equal(usage.figuresOf(over).reserved, 0);
});

/* ── 4 · SEVERAL RELEASES, SUMMED ONCE ────────────────────────────────────── */

test("several voucher releases are summed once, and one voucher is listed once", () => {
  const r = report([commitment([alloc({
    amount: 10000, releasedAmount: 7000, remainingAmount: 3000,
    status: "partially_released",
    releases: [
      /* Two lines of the SAME invoice — two deliveries of one fabric. */
      { voucherId: oid(11), voucherNumber: "PUR-1", amount: 2500, at: new Date("2026-08-01") },
      { voucherId: oid(11), voucherNumber: "PUR-1", amount: 1500, at: new Date("2026-08-01") },
      { voucherId: oid(12), voucherNumber: "PUR-2", amount: 3000, at: new Date("2026-08-09") },
    ],
  })])]);

  const g = r.groups[0];
  assert.equal(g.billed, 7000);
  const line = g.lines[0];
  /* Every contribution is kept for the audit trail… */
  assert.equal(line.releases.length, 3);
  assert.equal(line.releases.reduce((t, x) => t + x.amount, 0), 7000);
  /* …while the BILL list shows two bills, not three. Summing per unique
     voucher would drop the second contribution; listing per row would show
     one bill twice. */
  assert.equal(line.vouchers.length, 2);
  assert.deepEqual(line.vouchers.map((v) => v.voucherNumber).sort(), ["PUR-1", "PUR-2"]);
});

/* ── 5 · CANCELLATION IS READ FROM THE STORED FIGURES ─────────────────────── */

test("a cancelled bill is reflected because the report reads current figures", () => {
  /* Before: two bills, ₹7,000 discharged. */
  const before = report([commitment([alloc({
    amount: 10000, releasedAmount: 7000, remainingAmount: 3000, status: "partially_released",
    releases: [
      { voucherId: oid(11), voucherNumber: "PUR-1", amount: 4000, at: new Date("2026-08-01") },
      { voucherId: oid(12), voucherNumber: "PUR-2", amount: 3000, at: new Date("2026-08-09") },
    ],
  })])]);
  assert.equal(before.groups[0].billed, 7000);

  /* After PUR-2 is cancelled the release path removes THAT voucher's rows and
     restores its amount. The report recomputes nothing — it reports what is
     stored now, which is the whole reason a cancellation shows up here at
     all. */
  const after = report([commitment([alloc({
    amount: 10000, releasedAmount: 4000, remainingAmount: 6000, status: "partially_released",
    releases: [{ voucherId: oid(11), voucherNumber: "PUR-1", amount: 4000, at: new Date("2026-08-01") }],
  })])]);
  assert.equal(after.groups[0].billed, 4000);
  assert.equal(after.groups[0].reserved, 6000);
  assert.equal(after.groups[0].lines[0].vouchers.length, 1);
  /* And the OTHER bill's discharge is untouched. */
  assert.equal(after.groups[0].lines[0].vouchers[0].voucherNumber, "PUR-1");
});

test("a fully billed allocation reads as fully billed, not as still committed", () => {
  const r = report([commitment([alloc({
    amount: 10000, releasedAmount: 10000, remainingAmount: 0, status: "released",
    releases: [{ voucherId: oid(11), voucherNumber: "PUR-1", amount: 10000, at: new Date("2026-08-01") }],
  })])]);
  assert.equal(r.groups[0].status, usage.STATUS.FULLY);
  assert.equal(r.groups[0].reserved, 0);
});

/* ── 6 · UNBUDGETED IS VISIBLE, AND OUT OF THE HEAD TOTALS ────────────────── */

test("an unbudgeted promise is shown but never joins a budget-head total", () => {
  const un = alloc({
    name: "Emergency courier", amount: 5000, remainingAmount: 5000,
    status: "unbudgeted", ledgerId: undefined, ledgerName: undefined, budgetId: undefined,
    itemId: undefined, itemSku: undefined,
  });
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })]),
    commitment([un]),
  ]);

  /* Visible… */
  const row = r.groups.find((g) => g.unbudgeted);
  assert.ok(row, "the unbudgeted promise is not on the report at all");
  assert.equal(row.approved, 5000);
  assert.equal(row.status, usage.STATUS.UNBUDGETED);
  assert.equal(row.ledgerId, null);

  /* …and out of the three head figures, with its own total beside them.
     Inside them it would produce a number no budget line could reconcile,
     and the gap would be blamed on the budget. */
  assert.equal(r.summary.approved, 10000);
  assert.equal(r.summary.reserved, 10000);
  assert.equal(r.summary.unbudgetedCount, 1);
  assert.equal(r.summary.unbudgetedValue, 5000);
});

/* ── 7 · LEGACY STAYS SEPARATE, AND IS NEVER GUESSED ──────────────────────── */

test("a commitment with no allocations is reported as legacy, not itemised", () => {
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })]),
    /* Written before line-wise allocation existed: `allocations` is absent,
       and that absence is load-bearing. */
    commitment(undefined, { amount: 25000, ledgerId: RAW, ledgerName: "Raw Material Purchase" }),
  ]);

  assert.equal(r.groups.length, 1);
  assert.equal(r.legacy.count, 1);
  assert.equal(r.legacy.value, 25000);
  assert.equal(r.summary.legacyCount, 1);
  assert.equal(r.summary.legacyValue, 25000);
  /* Its value is real and its composition is unknown. It is NOT split across
     items, and it is not in the itemised totals. */
  assert.equal(r.summary.approved, 10000);
  assert.equal(r.legacy.rows[0].spendRequestNumber, r.legacy.rows[0].spendRequestNumber);
  assert.ok(!("itemId" in r.legacy.rows[0]));
});

test("an empty allocations array is legacy too, not an itemised commitment of nothing", () => {
  const r = report([commitment([], { amount: 8000 })]);
  assert.equal(r.groups.length, 0);
  assert.equal(r.legacy.count, 1);
  assert.equal(r.legacy.value, 8000);
});

/* ── 8 · ITEM AND SERVICE IDENTITIES STAY DISTINCT ────────────────────────── */

test("an item and a service are never folded together", () => {
  const r = report([commitment([
    alloc({ name: "Lift", amount: 10000, remainingAmount: 10000 }),
    alloc({
      name: "Lift", amount: 6000, remainingAmount: 6000,
      itemId: undefined, itemSku: undefined, serviceId: AMC, serviceCode: "SVC-AMC-1",
    }),
  ])]);

  assert.equal(r.groups.length, 2);
  const kinds = r.groups.map((g) => g.kind).sort();
  assert.deepEqual(kinds, ["item", "service"]);
  /* Same name, same head, two different things. A name is not an identity. */
  assert.equal(new Set(r.groups.map((g) => g.identityKey)).size, 2);
});

test("an unidentified line is never merged with another by name", () => {
  const bare = (over) => alloc({
    name: "Bearings", itemId: undefined, itemSku: undefined,
    serviceId: undefined, serviceCode: undefined, ...over,
  });
  const r = report([
    commitment([bare({ amount: 3000, remainingAmount: 3000 })]),
    commitment([bare({ amount: 2000, remainingAmount: 2000 })]),
  ]);

  /* Two requests that both said "bearings" are not evidence of one item.
     Merging them would manufacture an item that does not exist and attribute
     real money to it. */
  assert.equal(r.groups.length, 2);
  assert.ok(r.groups.every((g) => g.kind === usage.KIND.UNIDENTIFIED));
  assert.equal(r.summary.approved, 5000);
});

test("a stored SKU identifies where an id is missing, and a name never does", () => {
  const bySku = usage.identityOf({ name: "Cotton", itemSku: "RAW-FAB-001" }, {});
  assert.equal(bySku.kind, usage.KIND.ITEM);
  assert.equal(bySku.key, "sku:raw-fab-001");

  const byName = usage.identityOf({ name: "Cotton" }, { _id: "c1" });
  assert.equal(byName.kind, usage.KIND.UNIDENTIFIED);
  /* Keyed by the LINE, so the name can never become a join key. */
  assert.match(byName.key, /^line:c1:/);
});

/* ── 9 · YEAR BOUNDARIES ──────────────────────────────────────────────────── */

test("a financial-year filter keeps the years apart", () => {
  const commitments = [
    commitment([alloc({ amount: 10000, remainingAmount: 10000, financialYear: "2026-27" })],
      { financialYear: "2026-27" }),
    commitment([alloc({ amount: 7000, remainingAmount: 7000, financialYear: "2025-26" })],
      { financialYear: "2025-26" }),
  ];

  assert.equal(report(commitments).summary.approved, 17000);
  assert.equal(report(commitments, { filters: { financialYear: "2026-27" } }).summary.approved, 10000);
  assert.equal(report(commitments, { filters: { financialYear: "2025-26" } }).summary.approved, 7000);

  /* The filter list describes everything in scope, so a year can be
     deselected after it has been selected. */
  const filtered = report(commitments, { filters: { financialYear: "2026-27" } });
  assert.deepEqual(filtered.filters.financialYears, ["2025-26", "2026-27"]);
});

/* ── 10 · FILTERS AND GROUPING PRESERVE TOTALS ────────────────────────────── */

test("filtering narrows the rows and the totals together, never one alone", () => {
  const commitments = [
    commitment([
      alloc({ amount: 10000, remainingAmount: 10000 }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: PACK, ledgerName: "Packaging",
        itemId: undefined, itemSku: "RAW-PKG-9", name: "Cartons" }),
    ]),
  ];

  const all = report(commitments);
  assert.equal(all.summary.approved, 14000);

  const packOnly = report(commitments, { filters: { ledgerId: PACK } });
  assert.equal(packOnly.groups.length, 1);
  assert.equal(packOnly.summary.approved, 4000);
  /* The visible rows and the headline figure agree — a total that ignored the
     filter would be read as the filter having found more than it shows. */
  assert.equal(packOnly.groups.reduce((t, g) => t + g.approved, 0), packOnly.summary.approved);

  const searched = report(commitments, { filters: { search: "cartons" } });
  assert.equal(searched.summary.approved, 4000);
  const byKind = report(commitments, { filters: { kind: usage.KIND.ITEM } });
  assert.equal(byKind.summary.approved, 14000);
});

test("regrouping by head preserves the totals exactly", () => {
  const commitments = [
    commitment([
      alloc({ amount: 10000, remainingAmount: 10000 }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: PACK, ledgerName: "Packaging" }),
    ]),
    commitment([alloc({ amount: 6000, remainingAmount: 6000 })]),
  ];
  const r = report(commitments);

  const byHead = new Map();
  for (const g of r.groups) {
    byHead.set(g.ledgerId, (byHead.get(g.ledgerId) || 0) + g.approved);
  }
  assert.equal([...byHead.values()].reduce((a, b) => a + b, 0), r.summary.approved);
  assert.equal(byHead.get(RAW), 16000);
  assert.equal(byHead.get(PACK), 4000);
});

test("the totals are over everything matched, not over the visible page", () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    commitment([alloc({ amount: 1000 * (i + 1), remainingAmount: 1000 * (i + 1), itemId: oid(500 + i) })]));
  const r = report(many, { page: 1, limit: 2 });

  assert.equal(r.groups.length, 2);
  assert.equal(r.pagination.total, 7);
  assert.equal(r.pagination.totalPages, 4);
  /* 1000+…+7000. A summary that counted page one would be quietly wrong. */
  assert.equal(r.summary.approved, 28000);
});

/* ── 12 · THE FIGURE IS NOT "ALL ACCOUNTING ACTUALS" ──────────────────────── */

test("nothing in the service names its billed figure an actual", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require("node:path").join(__dirname, "itemBudgetUsage.service.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
  /* `actual` is the ledger's word for money that has been posted. This figure
     counts only vouchers matched to these commitments — a voucher posted
     straight to the ledger is a real actual and is not in it. Borrowing the
     word would make the screen look like a general ledger it is not, and the
     difference would be read as missing money. */
  assert.ok(!/\bactuals?\b/i.test(code), "the service borrows the word 'actual'");
  assert.ok(!/\bspent\b/i.test(code), "the service says 'spent'");
});

test("a release carrying no amount contributes nothing rather than NaN", () => {
  const r = report([commitment([alloc({
    amount: 10000, releasedAmount: 4000, remainingAmount: 6000,
    releases: [{ voucherId: oid(11), voucherNumber: "PUR-1" }],
  })])]);
  const line = r.groups[0].lines[0];
  assert.equal(line.releases[0].amount, 0);
  assert.equal(Number.isFinite(r.groups[0].billed), true);
  assert.equal(r.groups[0].billed, 4000);
});

test("the latest activity is the newest bill, or the commitment date", () => {
  const r = report([commitment([alloc({
    amount: 10000, releasedAmount: 4000, remainingAmount: 6000,
    releases: [
      { voucherId: oid(11), voucherNumber: "PUR-1", amount: 2000, at: new Date("2026-08-01") },
      { voucherId: oid(12), voucherNumber: "PUR-2", amount: 2000, at: new Date("2026-09-12") },
    ],
  })])]);
  assert.equal(r.groups[0].latestActivityAt.toISOString(), new Date("2026-09-12").toISOString());

  const never = report([commitment([alloc({ amount: 10000, remainingAmount: 10000 })])]);
  assert.equal(never.groups[0].latestActivityAt.toISOString(),
    new Date("2026-07-01T10:00:00.000Z").toISOString());
});

test("the snapshot is reported as stored, not refreshed from a master", () => {
  const r = report([commitment([alloc({
    name: "Cotton Fabric (2026 spec)", itemSku: "RAW-FAB-OLD",
    ledgerName: "Raw Material Purchase (old name)",
  })])]);
  const g = r.groups[0];
  /* What they were WHEN THE PROMISE WAS MADE. Replacing them with today's
     names would rewrite the record the commitment exists to keep. */
  assert.equal(g.name, "Cotton Fabric (2026 spec)");
  assert.equal(g.sku, "RAW-FAB-OLD");
  assert.equal(g.ledgerName, "Raw Material Purchase (old name)");
});

/* ══ EVERY LABEL ON A GROUP IS TRUE OF ALL OF IT ═════════════════════════════
 *
 * The key was identity + head, while `department` and `financialYear` were
 * copied from the FIRST row into the group. So the same item on the same head,
 * bought by two departments or in two years, became one total wearing one of
 * their labels — and the other department's money was reported as the first
 * one's. It reconciles against nothing, and nobody can tell by looking.
 */

test("the same item and head in two departments stays two truthful rows", () => {
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })], { department: "Logistics" }),
    commitment([alloc({ amount: 4000, remainingAmount: 4000 })], { department: "Production" }),
  ]);

  assert.equal(r.groups.length, 2);
  const byDept = Object.fromEntries(r.groups.map((g) => [g.department, g.approved]));
  assert.deepEqual(byDept, { Logistics: 10000, Production: 4000 });
  /* One item, one head — and still two rows, because two departments spent
     the money and a row must not claim otherwise. */
  assert.equal(new Set(r.groups.map((g) => g.identityKey)).size, 1);
  assert.equal(new Set(r.groups.map((g) => g.ledgerId)).size, 1);
  /* Reconcilable: the parts are still the whole. */
  assert.equal(r.groups.reduce((t, g) => t + g.approved, 0), r.summary.approved);
  assert.equal(r.summary.approved, 14000);
});

test("the same item and head in two financial years stays two truthful rows", () => {
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000, financialYear: "2026-27" })],
      { financialYear: "2026-27" }),
    commitment([alloc({ amount: 4000, remainingAmount: 4000, financialYear: "2025-26" })],
      { financialYear: "2025-26" }),
  ]);

  assert.equal(r.groups.length, 2);
  const byYear = Object.fromEntries(r.groups.map((g) => [g.financialYear, g.approved]));
  assert.deepEqual(byYear, { "2026-27": 10000, "2025-26": 4000 });
  assert.equal(r.groups.reduce((t, g) => t + g.approved, 0), 14000);
});

test("no group carries a label that is untrue of any rupee inside it", () => {
  const r = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })], { department: "Logistics" }),
    commitment([alloc({ amount: 4000, remainingAmount: 4000 })], { department: "Production" }),
    commitment([alloc({ amount: 2000, remainingAmount: 2000, financialYear: "2025-26" })],
      { department: "Logistics", financialYear: "2025-26" }),
  ]);

  for (const g of r.groups) {
    for (const line of g.lines) {
      assert.equal(
        String(line.department).toLowerCase(), String(g.department).toLowerCase(),
        `group labelled ${g.department} contains a ${line.department} line`,
      );
      assert.equal(line.financialYear, g.financialYear);
    }
  }
  assert.equal(r.groups.length, 3);
});

test("one department spelled two ways is still one department", () => {
  /* Ordered so the FIRST spelling seen is not the commonest one — otherwise
     "commonest" and "first" agree and the assertion proves nothing. */
  const r = report([
    commitment([alloc({ amount: 4000, remainingAmount: 4000 })], { department: "logistics" }),
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })], { department: "Logistics" }),
    commitment([alloc({ amount: 1000, remainingAmount: 1000 })], { department: "Logistics" }),
  ]);

  /* Fragmenting a total across three spellings of one word would be a
     different kind of untruth. Normalised for the key… */
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].approved, 15000);
  /* …and the label is the commonest spelling, ties alphabetical — NOT
     "whichever row came first", which would here have said "logistics". */
  assert.equal(r.groups[0].department, "Logistics");
  assert.equal(usage.commonestLabel(["b", "a", "a"]), "a");
  assert.equal(usage.commonestLabel(["b", "a"]), "a");
  assert.equal(usage.commonestLabel([]), null);
});

test("a department filter returns only the matching allocation rows", () => {
  const commitments = [
    commitment([
      alloc({ amount: 10000, remainingAmount: 10000 }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: PACK, ledgerName: "Packaging", name: "Cartons" }),
    ], { department: "Logistics" }),
    commitment([alloc({ amount: 7000, remainingAmount: 7000 })], { department: "Production" }),
  ];

  const prod = report(commitments, { filters: { department: "Production" } });
  assert.equal(prod.summary.approved, 7000);
  assert.equal(prod.groups.length, 1);
  assert.equal(prod.groups[0].department, "Production");
  /* Case-insensitively, because one department is written several ways. */
  assert.equal(report(commitments, { filters: { department: "production" } }).summary.approved, 7000);

  const year = report(commitments, { filters: { financialYear: "2026-27" } });
  assert.equal(year.summary.approved, 21000);
});

/* ══ THE HEAD VIEW IS COMPLETE, NOT PAGE-LOCAL ═══════════════════════════════
 *
 * The page used to receive a PAGE of item groups and fold those by head. With
 * more than one page, "By budget head" showed the total of whatever items were
 * on page 1 while looking like the head's total — a partial figure announcing
 * itself as a finished one, which nobody re-checks.
 */

test("a head total covers every matching item, not the current item page", () => {
  /* 60 distinct items under one head — more than any page of them. */
  const commitments = Array.from({ length: 60 }, (_, i) => commitment([alloc({
    name: `Item ${i}`, itemId: oid(600 + i), itemSku: `SKU-${i}`,
    amount: 1000, remainingAmount: 1000,
  })]));

  const items = report(commitments, { limit: 10 });
  assert.equal(items.groups.length, 10);
  assert.equal(items.pagination.total, 60);

  const heads = report(commitments, { limit: 10, groupBy: "head" });
  assert.equal(heads.heads.length, 1);
  /* The whole head, not the ten items a page would have carried. */
  assert.equal(heads.heads[0].approved, 60000);
  assert.equal(heads.heads[0].itemsTotal, 60);
  /* And the drill-down list is capped rather than complete — which it SAYS,
     because a capped list that stayed silent would be the same lie one level
     down. */
  assert.equal(heads.heads[0].rows.length, 10);
  assert.equal(heads.heads[0].itemsCapped, true);

  /* The summary agrees with the head figures either way round. */
  assert.equal(heads.summary.approved, 60000);
  assert.equal(items.summary.approved, 60000);
});

test("head mode paginates HEADS, and item mode paginates items", () => {
  const commitments = [
    ...Array.from({ length: 12 }, (_, i) => commitment([alloc({
      name: `Raw ${i}`, itemId: oid(700 + i), amount: 1000, remainingAmount: 1000,
    })])),
    commitment([alloc({ amount: 5000, remainingAmount: 5000, ledgerId: PACK, ledgerName: "Packaging" })]),
  ];

  const items = report(commitments, { limit: 5 });
  assert.equal(items.groupBy, "item");
  assert.equal(items.pagination.total, 13);
  assert.deepEqual(items.heads, []);

  const heads = report(commitments, { limit: 5, groupBy: "head" });
  assert.equal(heads.groupBy, "head");
  /* Two heads, so one page — not three pages of items. */
  assert.equal(heads.pagination.total, 2);
  assert.equal(heads.pagination.totalPages, 1);
  assert.deepEqual(heads.groups, []);
  assert.equal(heads.heads.reduce((t, h) => t + h.approved, 0), 17000);
});

test("both groupings are built from the same population and total identically", () => {
  const commitments = [
    commitment([
      alloc({ amount: 10000, remainingAmount: 10000 }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: PACK, ledgerName: "Packaging", name: "Cartons" }),
    ], { department: "Logistics" }),
    commitment([alloc({ amount: 6000, remainingAmount: 6000 })], { department: "Production" }),
  ];

  const items = report(commitments, { limit: 200 });
  const heads = report(commitments, { limit: 200, groupBy: "head" });

  assert.equal(items.summary.approved, heads.summary.approved);
  assert.equal(
    items.groups.reduce((t, g) => t + g.approved, 0),
    heads.heads.reduce((t, h) => t + h.approved, 0),
  );
  /* And a filter narrows both the same way — a grouping that survived a
     filter differently would be a way of getting two answers to one
     question. */
  const f = { filters: { department: "Production" } };
  assert.equal(report(commitments, { ...f }).summary.approved,
    report(commitments, { ...f, groupBy: "head" }).summary.approved);
});

test("the head view keeps department and financial year truthful underneath", () => {
  const heads = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })], { department: "Logistics" }),
    commitment([alloc({ amount: 4000, remainingAmount: 4000 })], { department: "Production" }),
  ], { groupBy: "head" });

  assert.equal(heads.heads.length, 1);
  assert.equal(heads.heads[0].approved, 14000);
  /* One head, and two truthful item rows under it — the head total does not
     flatten the departments away. */
  assert.equal(heads.heads[0].rows.length, 2);
  assert.deepEqual(heads.heads[0].rows.map((r) => r.department).sort(), ["Logistics", "Production"]);
});

test("unbudgeted rows fold into their own head bucket, not into a real head", () => {
  const heads = report([
    commitment([alloc({ amount: 10000, remainingAmount: 10000 })]),
    commitment([alloc({
      name: "Courier", amount: 5000, remainingAmount: 5000, status: "unbudgeted",
      ledgerId: undefined, ledgerName: undefined, itemId: undefined, itemSku: undefined,
    })]),
  ], { groupBy: "head" });

  const real = heads.heads.find((h) => !h.unbudgeted);
  const un = heads.heads.find((h) => h.unbudgeted);
  assert.equal(real.approved, 10000);
  assert.ok(un, "the unbudgeted promise vanished from the head view");
  assert.equal(un.approved, 5000);
  assert.equal(un.ledgerId, null);
  /* And it is still out of the three head figures in the summary. */
  assert.equal(heads.summary.approved, 10000);
  assert.equal(heads.summary.unbudgetedValue, 5000);
});
