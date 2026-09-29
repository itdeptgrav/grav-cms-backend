// test/accountant/item-budget-usage.route.test.js
//
// THE ITEM-WISE BUDGET USAGE REPORT, OVER HTTP.
//
// The arithmetic is proven in services/itemBudgetUsage.test.js. What can only
// be proven here is that the ROUTE reads real stored commitments, that the
// company boundary holds, and that the report is genuinely read-only — a
// reporting screen that could alter a commitment would be a screen that
// changed the budget by being looked at.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  /* Lane A Chunk 3A added the canonical company-scope guard, which the routers
     under test now mount. Pass-through doubles here on purpose: these suites
     are about budget and ledger behaviour, and company isolation has its own
     suite (company-isolation.route.test.js) that exercises the real guard. A
     mock has to offer what the module offers, or the router fails to load. */
  requireCompanyScope: (req, res, next) => next(),
  scopeCompanyIfPresent: (req, res, next) => next(),
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

let server, base, seq = 0;

const userOf = (companyId, role = "owner") => ({
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  role,
  companyId: String(companyId),
  permissions: role === "viewer" ? {} : { canEdit: true, canApprove: true },
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/budgets`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { user } = {}) =>
  fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seedCompany(name = "Acme") {
  const company = await Acc_Company.create({
    companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const head = async (label) => Acc_Ledger.create({
    companyId: company._id, name: `${label} ${++seq}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  return { company, raw: await head("Raw Material Purchase"), pack: await head("Packaging") };
}

const alloc = (over = {}) => ({
  spendLineId: new mongoose.Types.ObjectId(),
  name: "Cotton Fabric",
  itemId: new mongoose.Types.ObjectId(),
  itemSku: `RAW-FAB-${++seq}`,
  financialYear: "2026-27",
  amount: 10000, releasedAmount: 0, remainingAmount: 10000,
  status: "committed", resolutionSource: "category_mapping",
  ...over,
});

const commit = (co, allocations, over = {}) => Commitment.create({
  spendRequestId: new mongoose.Types.ObjectId(),
  spendRequestNumber: `SPR-${++seq}`,
  companyId: co.company._id,
  department: "Logistics",
  financialYear: "2026-27",
  amount: (allocations || []).reduce((t, a) => t + a.amount, 0) || over.amount || 0,
  status: "committed",
  ...(allocations ? { allocations } : {}),
  ...(allocations ? { allocationMode: "line_wise", headCount: 1 } : {}),
  committedAt: new Date("2026-07-01T10:00:00.000Z"),
  committedByName: "Asha",
  ...over,
});

/* ═══ THE GATES ══════════════════════════════════════════════════════════ */

describe("who may read it", () => {
  test("an unauthenticated caller reads nothing", async () => {
    expect((await call("/item-usage")).status).toBe(401);
  });

  test("a caller with no company is told so rather than shown everything", async () => {
    const { status, body } = await call("/item-usage", { user: { ...userOf(""), companyId: "" } });
    expect(status).toBe(400);
    expect(body.message).toMatch(/company is required/i);
  });

  test("a viewer may read it — this is a report, not a decision", async () => {
    const co = await seedCompany();
    await commit(co, [alloc({ ledgerId: co.raw._id, ledgerName: co.raw.name })]);
    const { status, body } = await call("/item-usage", { user: userOf(co.company._id, "viewer") });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

/* ═══ THE COMPANY BOUNDARY ═══════════════════════════════════════════════ */

describe("company boundary", () => {
  test("another company's commitments are not in the report or its totals", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    await commit(a, [alloc({ amount: 10000, remainingAmount: 10000, ledgerId: a.raw._id, ledgerName: a.raw.name })]);
    await commit(b, [alloc({ amount: 99000, remainingAmount: 99000, ledgerId: b.raw._id, ledgerName: b.raw.name, name: "Beta Fabric" })]);

    const { body } = await call("/item-usage", { user: userOf(a.company._id) });
    expect(body.summary.approved).toBe(10000);
    expect(JSON.stringify(body)).not.toContain("Beta Fabric");
    /* And B's head is not even offered as a filter — the filter list would
       otherwise enumerate another company's chart of accounts. */
    expect(body.filters.heads.map((h) => h.ledgerName)).not.toContain(b.raw.name);
  });

  test("the company cannot be widened by a query parameter", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    await commit(b, [alloc({ amount: 99000, remainingAmount: 99000, ledgerId: b.raw._id, ledgerName: b.raw.name, name: "Beta Fabric" })]);

    /* ── A REAL FINDING, REFUSED HERE ─────────────────────────────────────
       The router's shared `companyOf` prefers the header, then the query,
       then the session — so a caller whose session names A can ask for B and
       be handed it. That helper predates this route and serves every other
       route on it, so this endpoint refuses the DISAGREEMENT rather than
       quietly serving the wrong books. */
    const res = await call(`/item-usage?companyId=${b.company._id}`, { user: userOf(a.company._id) });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not yours to read/i);
    expect(JSON.stringify(res.body)).not.toContain("Beta Fabric");
  });

  test("the header cannot widen it either, and no company on the session still picks", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    await commit(b, [alloc({ amount: 99000, remainingAmount: 99000, ledgerId: b.raw._id, ledgerName: b.raw.name, name: "Beta Fabric" })]);

    const viaHeader = await fetch(`${base}/item-usage`, {
      headers: {
        "Content-Type": "application/json",
        "x-test-user": JSON.stringify(userOf(a.company._id)),
        "x-company-id": String(b.company._id),
      },
    });
    expect(viaHeader.status).toBe(403);

    /* And a session carrying no company of its own still resolves through the
       parameter — that is how a multi-company operator picks their books, and
       narrowing it was never this route's to do. */
    const operator = await call(`/item-usage?companyId=${b.company._id}`, {
      user: { ...userOf(b.company._id), companyId: "" },
    });
    expect(operator.status).toBe(200);
    expect(operator.body.summary.approved).toBe(99000);
  });
});

/* ═══ WHAT IT REPORTS ════════════════════════════════════════════════════ */

describe("the report over real stored commitments", () => {
  test("two heads on one request stay two rows, and the totals add up", async () => {
    const co = await seedCompany();
    await commit(co, [
      alloc({ amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: co.pack._id, ledgerName: co.pack.name, name: "Cartons" }),
    ]);

    const { body } = await call("/item-usage", { user: userOf(co.company._id) });
    expect(body.groups).toHaveLength(2);
    expect(body.summary.approved).toBe(14000);
    expect(body.groups.reduce((t, g) => t + g.approved, 0)).toBe(14000);
  });

  test("a partly billed line reports billed, reserved and its bills", async () => {
    const co = await seedCompany();
    const vId = new mongoose.Types.ObjectId();
    await commit(co, [alloc({
      amount: 10000, releasedAmount: 4000, remainingAmount: 6000, status: "partially_released",
      ledgerId: co.raw._id, ledgerName: co.raw.name,
      releases: [{ voucherId: vId, voucherNumber: "PUR-77", amount: 4000, at: new Date("2026-08-01") }],
    })], { status: "partially_released" });

    const { body } = await call("/item-usage", { user: userOf(co.company._id) });
    const g = body.groups[0];
    expect(g.approved).toBe(10000);
    expect(g.billed).toBe(4000);
    expect(g.reserved).toBe(6000);
    expect(g.status).toBe("partially_billed");
    expect(g.lines[0].vouchers[0].voucherNumber).toBe("PUR-77");
    /* The request is reachable from the row — a figure nobody can open is a
       figure nobody can check. */
    expect(g.lines[0].spendRequestNumber).toBeTruthy();
    expect(g.lines[0].spendRequestId).toBeTruthy();
  });

  test("a legacy commitment is counted apart and never itemised", async () => {
    const co = await seedCompany();
    await commit(co, [alloc({ amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name })]);
    /* No `allocations` at all — written before line-wise allocation existed. */
    await commit(co, null, {
      amount: 25000, ledgerId: co.raw._id, ledgerName: co.raw.name,
    });

    const { body } = await call("/item-usage", { user: userOf(co.company._id) });
    expect(body.groups).toHaveLength(1);
    expect(body.legacy.count).toBe(1);
    expect(body.legacy.value).toBe(25000);
    /* Its value is real; its composition is unknown. It is not split across
       items and not inside the itemised totals. */
    expect(body.summary.approved).toBe(10000);
  });

  test("an unbudgeted promise is visible and out of the head totals", async () => {
    const co = await seedCompany();
    await commit(co, [alloc({ amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name })]);
    await commit(co, [alloc({
      name: "Emergency courier", amount: 5000, remainingAmount: 5000, status: "unbudgeted",
      ledgerId: undefined, ledgerName: undefined, itemId: undefined, itemSku: undefined,
    })], { status: "unbudgeted" });

    const { body } = await call("/item-usage", { user: userOf(co.company._id) });
    expect(body.summary.approved).toBe(10000);
    expect(body.summary.unbudgetedCount).toBe(1);
    expect(body.summary.unbudgetedValue).toBe(5000);
    expect(body.groups.some((g) => g.unbudgeted)).toBe(true);
  });

  test("filters narrow rows and totals together, and the lists stay complete", async () => {
    const co = await seedCompany();
    await commit(co, [
      alloc({ amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: co.pack._id, ledgerName: co.pack.name, name: "Cartons" }),
    ]);

    const filtered = await call(`/item-usage?ledgerId=${co.pack._id}`, { user: userOf(co.company._id) });
    expect(filtered.body.groups).toHaveLength(1);
    expect(filtered.body.summary.approved).toBe(4000);
    /* Both heads are still offered, so the filter can be undone. */
    expect(filtered.body.filters.heads).toHaveLength(2);

    const searched = await call("/item-usage?search=cartons", { user: userOf(co.company._id) });
    expect(searched.body.summary.approved).toBe(4000);
  });

  test("pagination reports the whole matched set, not the visible page", async () => {
    const co = await seedCompany();
    for (let i = 0; i < 4; i += 1) {
      await commit(co, [alloc({
        amount: 1000 * (i + 1), remainingAmount: 1000 * (i + 1),
        ledgerId: co.raw._id, ledgerName: co.raw.name,
      })]);
    }
    const { body } = await call("/item-usage?limit=2", { user: userOf(co.company._id) });
    expect(body.groups).toHaveLength(2);
    expect(body.pagination.total).toBe(4);
    expect(body.pagination.totalPages).toBe(2);
    expect(body.summary.approved).toBe(10000);
  });
});

/* ═══ IT IS A REPORT ═════════════════════════════════════════════════════ */

describe("reading it changes nothing", () => {
  test("no commitment is touched by looking at the report", async () => {
    const co = await seedCompany();
    const c = await commit(co, [alloc({
      amount: 10000, releasedAmount: 4000, remainingAmount: 6000,
      ledgerId: co.raw._id, ledgerName: co.raw.name,
    })]);
    const before = await Commitment.findById(c._id).lean();

    await call("/item-usage", { user: userOf(co.company._id) });
    await call("/item-usage?search=cotton&kind=item", { user: userOf(co.company._id) });

    const after = await Commitment.findById(c._id).lean();
    expect(new Date(after.updatedAt).toISOString()).toBe(new Date(before.updatedAt).toISOString());
    expect(after.allocations[0].releasedAmount).toBe(4000);
    expect(after.allocations[0].remainingAmount).toBe(6000);
  });

  test("the route offers no write verb at all", async () => {
    const co = await seedCompany();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await fetch(`${base}/item-usage`, {
        method,
        headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(userOf(co.company._id)) },
        body: JSON.stringify({}),
      });
      expect([404, 405]).toContain(r.status);
    }
  });
});

/* ═══ AN UNSCOPED COMMITMENT IS NOT EVERYBODY'S ══════════════════════════════
 *
 * The route read `companyId === selected OR companyId missing`, which handed
 * every historical unscoped commitment to EVERY company's report. On a list
 * screen that is a stale row. On a financial report it is one company's
 * spending counted into another company's totals, and it looks completely
 * ordinary on the page.
 *
 * An unscoped commitment now appears only when its own spend request PROVES
 * it belongs here. Ownership that cannot be proven is not assumed in either
 * direction — the row is excluded, and the count of what was withheld is
 * reported so the omission is visible rather than silent.
 */

/** A spend request that names a company — the only proof of ownership. */
const request = (co, over = {}) => SpendRequest.create({
  title: "Run", requestType: "PRODUCT", purpose: "Q3", department: "Logistics",
  companyId: co ? co.company._id : undefined,
  requestedBy: new mongoose.Types.ObjectId(), requestedById: "EMP1",
  requestedByName: "Rutu", status: "approved",
  items: [{ name: "Fabric", whyNeeded: "x", quantity: 1, unit: "roll", rate: 1000, amount: 1000, lineTotal: 1000 }],
  totalAmount: 1000, grandTotal: 1000,
  ...over,
});

describe("legacy company attribution", () => {
  test("an unscoped commitment does not appear in a company it cannot be proven to own", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    const reqB = await request(b);

    /* Written before `companyId` existed. Its request belongs to B. */
    await Commitment.create({
      spendRequestId: reqB._id, spendRequestNumber: "SPR-OLD-B",
      department: "Logistics", financialYear: "2026-27",
      amount: 99000, status: "committed",
      allocations: [alloc({ amount: 99000, remainingAmount: 99000, name: "Beta Fabric", ledgerId: b.raw._id, ledgerName: b.raw.name })],
      allocationMode: "line_wise", headCount: 1,
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const seenByA = await call("/item-usage", { user: userOf(a.company._id) });
    expect(seenByA.body.summary.approved).toBe(0);
    expect(JSON.stringify(seenByA.body)).not.toContain("Beta Fabric");
    /* And it is not offered as "legacy" either — legacy means the VALUE
       cannot be split across items, not that the COMPANY is unknown. */
    expect(seenByA.body.legacy.count).toBe(0);

    /* B, whose request proves it, does see it. */
    const seenByB = await call("/item-usage", { user: userOf(b.company._id) });
    expect(seenByB.body.summary.approved).toBe(99000);
    expect(JSON.stringify(seenByB.body)).toContain("Beta Fabric");
  });

  test("an unscoped commitment whose request names no company reaches neither report", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    /* Ownership genuinely unprovable — and a guess in either direction would
       put real money in the wrong books. */
    const orphan = await request(null);
    await Commitment.create({
      spendRequestId: orphan._id, spendRequestNumber: "SPR-ORPHAN",
      department: "Logistics", financialYear: "2026-27",
      amount: 40000, status: "committed",
      allocations: [alloc({ amount: 40000, remainingAmount: 40000, name: "Orphan Fabric" })],
      allocationMode: "line_wise", headCount: 1,
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    for (const co of [a, b]) {
      const { body } = await call("/item-usage", { user: userOf(co.company._id) });
      expect(body.summary.approved).toBe(0);
      expect(JSON.stringify(body)).not.toContain("Orphan Fabric");
      /* Withheld, and said so — a report that quietly dropped rows would be
         indistinguishable from one with nothing to drop. Only the count is
         disclosed; naming the record is what the exclusion prevents. */
      expect(body.ownershipUnknown.count).toBe(1);
      expect(body.ownershipUnknown.note).toMatch(/excluded from every figure/i);
    }
  });

  test("a legacy commitment and an ownership-unknown one are different things", async () => {
    const a = await seedCompany("Acme");
    /* Legacy: belongs to A, but has no allocations, so its VALUE cannot be
       attributed to items. */
    await commit(a, null, { amount: 25000, ledgerId: a.raw._id, ledgerName: a.raw.name });
    /* Ownership unknown: no companyId, and a request that proves nothing. */
    const orphan = await request(null);
    await Commitment.create({
      spendRequestId: orphan._id, spendRequestNumber: "SPR-ORPHAN-2",
      amount: 40000, status: "committed",
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const { body } = await call("/item-usage", { user: userOf(a.company._id) });
    expect(body.legacy.count).toBe(1);
    expect(body.legacy.value).toBe(25000);
    /* The orphan is NOT counted as legacy — that would describe another
       company's possible spending as this company's unattributable spending. */
    expect(body.ownershipUnknown.count).toBe(1);
    expect(body.summary.legacyValue).toBe(25000);
  });

  test("an unscoped LEGACY commitment is attributed only where its request proves it", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    const reqA = await request(a);
    /* No companyId AND no allocations — both unknowns at once, which is
       exactly the case the two ideas must not be confused on. */
    await Commitment.create({
      spendRequestId: reqA._id, spendRequestNumber: "SPR-OLD-A",
      ledgerId: a.raw._id, ledgerName: a.raw.name,
      amount: 12000, status: "committed",
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const seenByA = await call("/item-usage", { user: userOf(a.company._id) });
    /* Deterministically A's, through its request — and legacy, because it
       has no allocations. */
    expect(seenByA.body.legacy.count).toBe(1);
    expect(seenByA.body.legacy.value).toBe(12000);
    expect(seenByA.body.ownershipUnknown.count).toBe(0);

    const seenByB = await call("/item-usage", { user: userOf(b.company._id) });
    expect(seenByB.body.legacy.count).toBe(0);
    /* Proven to be A's — so B is told nothing at all about it, not even that
       an unresolved record exists. */
    expect(seenByB.body.ownershipUnknown.count).toBe(0);
  });
});

/* ═══ GROUPING IS A SERVER QUERY ═════════════════════════════════════════ */

describe("grouping over the whole population", () => {
  test("a head total covers every matching item, not the current item page", async () => {
    const co = await seedCompany();
    /* 60 distinct items under one head — more than any page of them. */
    for (let i = 0; i < 60; i += 1) {
      await commit(co, [alloc({
        name: `Item ${i}`, itemSku: `SKU-${i}`, amount: 1000, remainingAmount: 1000,
        ledgerId: co.raw._id, ledgerName: co.raw.name,
      })]);
    }

    const items = await call("/item-usage?limit=10", { user: userOf(co.company._id) });
    expect(items.body.groups).toHaveLength(10);
    expect(items.body.pagination.total).toBe(60);

    const heads = await call("/item-usage?limit=10&groupBy=head", { user: userOf(co.company._id) });
    expect(heads.body.groupBy).toBe("head");
    expect(heads.body.heads).toHaveLength(1);
    /* The whole head, not the ten items a page would have carried. */
    expect(heads.body.heads[0].approved).toBe(60000);
    expect(heads.body.heads[0].itemsTotal).toBe(60);
    expect(heads.body.heads[0].rows).toHaveLength(10);
    expect(heads.body.heads[0].itemsCapped).toBe(true);
    /* And head mode pages HEADS — one head is one page. */
    expect(heads.body.pagination.total).toBe(1);
  });

  test("two departments on one item and head are two rows, in both groupings", async () => {
    const co = await seedCompany();
    const shared = { itemId: new mongoose.Types.ObjectId(), itemSku: "RAW-SHARED" };
    await commit(co, [alloc({ ...shared, amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name })],
      { department: "Logistics" });
    await commit(co, [alloc({ ...shared, amount: 4000, remainingAmount: 4000, ledgerId: co.raw._id, ledgerName: co.raw.name })],
      { department: "Production" });

    const items = await call("/item-usage", { user: userOf(co.company._id) });
    expect(items.body.groups).toHaveLength(2);
    expect(items.body.groups.map((g) => g.department).sort()).toEqual(["Logistics", "Production"]);
    expect(items.body.summary.approved).toBe(14000);

    const heads = await call("/item-usage?groupBy=head", { user: userOf(co.company._id) });
    /* One head, ₹14,000 — with the two departments still truthful beneath. */
    expect(heads.body.heads).toHaveLength(1);
    expect(heads.body.heads[0].approved).toBe(14000);
    expect(heads.body.heads[0].rows.map((r) => r.department).sort()).toEqual(["Logistics", "Production"]);
  });

  test("a filter narrows both groupings identically", async () => {
    const co = await seedCompany();
    await commit(co, [
      alloc({ amount: 10000, remainingAmount: 10000, ledgerId: co.raw._id, ledgerName: co.raw.name }),
      alloc({ amount: 4000, remainingAmount: 4000, ledgerId: co.pack._id, ledgerName: co.pack.name, name: "Cartons" }),
    ]);

    const byItem = await call(`/item-usage?ledgerId=${co.pack._id}`, { user: userOf(co.company._id) });
    const byHead = await call(`/item-usage?ledgerId=${co.pack._id}&groupBy=head`, { user: userOf(co.company._id) });
    expect(byItem.body.summary.approved).toBe(4000);
    expect(byHead.body.summary.approved).toBe(4000);
    expect(byHead.body.heads).toHaveLength(1);
    expect(byHead.body.heads[0].approved).toBe(4000);
  });
});

/* ═══ OWNERSHIP HAS THREE ANSWERS, NOT TWO ═══════════════════════════════════
 *
 * The route queried only THIS company's requests and treated every unscoped
 * commitment it did not match as "ownership unknown". So a commitment whose
 * request proves it belongs to company B was reported to company A as one of
 * A's own unresolved records — an alarm about somebody else's data, raised on
 * a screen that cannot show it and by a team who cannot fix it. Worse, the
 * count itself leaked that B's records exist.
 */

describe("three-way ownership", () => {
  test("A is told only about what is genuinely unresolvable, never about B's", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");

    /* 1 · proven A's — included in A's figures. */
    const reqA = await request(a);
    await Commitment.create({
      spendRequestId: reqA._id, spendRequestNumber: "SPR-A",
      amount: 10000, status: "committed",
      allocations: [alloc({ amount: 10000, remainingAmount: 10000, name: "Acme Fabric", ledgerId: a.raw._id, ledgerName: a.raw.name })],
      allocationMode: "line_wise", headCount: 1,
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    /* 2 · proven B's — excluded from A in silence. */
    const reqB = await request(b);
    await Commitment.create({
      spendRequestId: reqB._id, spendRequestNumber: "SPR-B",
      amount: 99000, status: "committed",
      allocations: [alloc({ amount: 99000, remainingAmount: 99000, name: "Beta Fabric", ledgerId: b.raw._id, ledgerName: b.raw.name })],
      allocationMode: "line_wise", headCount: 1,
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    /* 3 · genuinely unresolvable — a request that records no company. */
    const orphan = await request(null);
    await Commitment.create({
      spendRequestId: orphan._id, spendRequestNumber: "SPR-ORPHAN-3",
      amount: 7000, status: "committed",
      allocations: [alloc({ amount: 7000, remainingAmount: 7000, name: "Orphan Fabric" })],
      allocationMode: "line_wise", headCount: 1,
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const seenByA = await call("/item-usage", { user: userOf(a.company._id) });
    expect(seenByA.body.summary.approved).toBe(10000);
    expect(JSON.stringify(seenByA.body)).toContain("Acme Fabric");
    expect(JSON.stringify(seenByA.body)).not.toContain("Beta Fabric");
    expect(JSON.stringify(seenByA.body)).not.toContain("Orphan Fabric");
    /* ONE unknown — the orphan. B's commitment is proven to be B's, so it is
       neither shown nor counted: counting it would raise an alarm about data
       A cannot see and tell A that it exists. */
    expect(seenByA.body.ownershipUnknown.count).toBe(1);

    /* And the mirror image holds for B. */
    const seenByB = await call("/item-usage", { user: userOf(b.company._id) });
    expect(seenByB.body.summary.approved).toBe(99000);
    expect(JSON.stringify(seenByB.body)).not.toContain("Acme Fabric");
    expect(seenByB.body.ownershipUnknown.count).toBe(1);
  });

  test("a commitment whose request has been deleted is unknown, not adopted", async () => {
    const a = await seedCompany("Acme");
    const gone = new mongoose.Types.ObjectId();
    await Commitment.create({
      spendRequestId: gone, spendRequestNumber: "SPR-GONE",
      amount: 3000, status: "committed",
      committedAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    const { body } = await call("/item-usage", { user: userOf(a.company._id) });
    /* Nothing proves anything either way, so it is disclosed rather than
       quietly adopted into whichever company happened to be looking. */
    expect(body.ownershipUnknown.count).toBe(1);
    expect(body.summary.approved).toBe(0);
    expect(body.legacy.count).toBe(0);
  });

  test("no unknowns at all when every unscoped commitment is provably placed", async () => {
    const a = await seedCompany("Acme");
    const b = await seedCompany("Beta");
    for (const co of [a, a, b]) {
      const req = await request(co);
      await Commitment.create({
        spendRequestId: req._id, spendRequestNumber: `SPR-${++seq}`,
        amount: 1000, status: "committed",
        allocations: [alloc({ amount: 1000, remainingAmount: 1000, ledgerId: co.raw._id, ledgerName: co.raw.name })],
        allocationMode: "line_wise", headCount: 1,
        committedAt: new Date("2026-07-01T10:00:00.000Z"),
      });
    }

    const seenByA = await call("/item-usage", { user: userOf(a.company._id) });
    expect(seenByA.body.summary.approved).toBe(2000);
    /* A clean report says zero. A count that included B's two-thirds would
       be a permanent warning nobody could ever clear. */
    expect(seenByA.body.ownershipUnknown.count).toBe(0);
  });
});
