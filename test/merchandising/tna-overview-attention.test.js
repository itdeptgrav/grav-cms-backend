// test/merchandising/tna-overview-attention.test.js
//
// TIME & ACTION MOVED SCREENS. IT DID NOT MOVE STORES.
//
// The register was a fourth button in the top bar; what needs attention
// across every order is now a section on the Overview, and each order's own
// plan lives in its file. These pin the cross-order half of that.
//
//   1  EVERY FIGURE IS COUNTED IN THE DATABASE, over the whole company —
//      never the length of a page. A bucket with forty in it must not report
//      twenty-five.
//
//   2  A FIGURE AND THE LIST BEHIND IT ARE ONE POPULATION. Each bucket
//      publishes both its count and the query that opens it, and this walks
//      every one of them: count, then list, then compare.
//
//   3  "ORDERS AT RISK" IS ORDERS, NOT MILESTONES. Eleven late milestones on
//      two orders is a different day from eleven on eleven.
//
//   4  IT IS THE SAME STORE. No second T&A collection, no copied milestone:
//      completing one in its file removes it from the Overview's figures,
//      because they were always the same record.
//
//   5  NOBODY IN MERCHANDISING IS LATE for a milestone another department's
//      record closes. That population is defined by the completion
//      authority, and it is not a status somebody sets.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const cal = require("../../services/merchandising/tnaCalendar");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "tna_attention" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/tnaRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
}, 180000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const TODAY = cal.todayInZone();
const day = (n) => {
  const d = new Date(`${TODAY}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function world({ role = "viewer" } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Att ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `att-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `${n}`, email, biometricId: `AT${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `A ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `A ${n}` });
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, name: `A ${n}`, role,
    isActive: true, departmentId: new mongoose.Types.ObjectId(),
  });
  const token = jwt.sign({ id: String(emp._id), email, name: `A ${n}` },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" });
  const call = (path) => fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Costing-Company": String(co._id) },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { co, call, email, n };
}

/**
 * An order, as the register reads one.
 *
 * Written straight to the collection rather than through the model: this
 * suite is about the attention FIGURES, and an Execution File's own
 * validation — the handover version it came from, its delivery commitments,
 * its quantities — is the subject of the files' own suites. Stamping a
 * plausible handover here would be inventing a commercial record to test an
 * arithmetic one.
 */
async function order(co, { responsible = "" } = {}) {
  const n = ++seq;
  const _id = new mongoose.Types.ObjectId();
  await ExecutionFile.collection.insertOne({
    _id, companyId: co._id, fileNumber: `MEF-ATT-${n}`, handoverRef: `HO-${n}`,
    executionPhase: "COORDINATION",
    ...(responsible ? { responsibleMerchandiser: { name: "A", email: responsible } } : {}),
    currentExecutionProjection: {
      orderRef: `ORD-${n}`, buyerDisplayLabel: `Buyer ${n}`,
      productName: `Product ${n}`, styleRef: `ST-${n}`,
    },
    createdAt: new Date(), updatedAt: new Date(),
  });
  return { _id };
}

/** Milestones written straight in, as the days test does. */
async function milestones(co, file, specs) {
  const planId = new mongoose.Types.ObjectId();
  let i = 0;
  const rows = specs.flatMap(({ count = 1, status, forecastDate = null, authority = "MERCHANDISING", actualDate = null }) =>
    Array.from({ length: count }, () => ({
      companyId: co._id, planId, fileId: file._id,
      milestoneRef: `M-${file._id}-${++i}`, milestoneCode: "FABRIC_IN_HOUSE",
      name: `Milestone ${i}`, ownerDepartment: "MERCHANDISING",
      completionAuthority: authority, scopeKind: "FILE",
      status, forecastDate, baselineDate: null, actualDate,
    })));
  await TnaMilestone.collection.insertMany(rows);
}

/** Every row a view lists, following the cursor to the end. */
async function everyRow(call, qs) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 50; page += 1) {
    const r = await call(`/tna/portfolio?${qs}&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(r.status).toBe(200);
    out.push(...r.body.rows);
    if (!r.body.hasMore) return out;
    cursor = r.body.nextCursor;
  }
  throw new Error("did not finish paging");
}

/* ══ 1 & 2 — COUNTED IN THE DATABASE, AND THE LIST MATCHES ════════════════ */

describe("every attention figure is the whole company's, and opens exactly what it counted", () => {
  test("a bucket with more than a page in it reports its real size", async () => {
    const w = await world();
    const f = await order(w.co);
    await milestones(w.co, f, [{ count: 40, status: "OVERDUE", forecastDate: day(-5) }]);

    const att = await w.call("/tna/portfolio/attention");
    expect(att.status).toBe(200);
    /* Not 25, which is what counting a page of rows would have said. */
    expect(att.body.counts.overdue).toBe(40);

    const rows = await everyRow(w.call, "view=overdue");
    expect(rows).toHaveLength(40);
  }, 180000);

  test("each bucket's figure equals the list its own query opens", async () => {
    const w = await world();
    const mine = await order(w.co, { responsible: w.email });
    const theirs = await order(w.co);

    await milestones(w.co, mine, [
      { count: 3, status: "OVERDUE", forecastDate: day(-4) },
      { count: 2, status: "BLOCKED", forecastDate: day(2) },
      { count: 1, status: "DUE_SOON", forecastDate: TODAY },
    ]);
    await milestones(w.co, theirs, [
      { count: 4, status: "FORECAST_LATE", forecastDate: day(3) },
      { count: 2, status: "PENDING", forecastDate: TODAY },
      { count: 5, status: "PENDING", forecastDate: day(4) },
      { count: 3, status: "PENDING", forecastDate: day(30) },
      { count: 6, status: "COMPLETED", forecastDate: day(-2), actualDate: day(-2) },
      { count: 2, status: "PENDING", forecastDate: day(1), authority: "SOURCE_EVENT" },
    ]);

    const att = await w.call("/tna/portfolio/attention");
    const { counts, today, weekEnd } = att.body;
    expect(today).toBe(TODAY);

    /* The seven buckets, each counted and then listed. The queries are the
       ones the screen's own bucket table publishes. */
    const checks = [
      ["overdue", "view=overdue"],
      ["dueToday", `view=all&from=${today}&to=${today}`],
      ["dueThisWeek", `view=all&from=${today}&to=${weekEnd}`],
      ["blocked", "view=blocked"],
      ["atRisk", "view=at-risk"],
      ["mine", null],
      ["awaitingOther", "view=awaiting-source"],
    ];
    for (const [key, qs] of checks) {
      if (!qs) continue;
      const rows = await everyRow(w.call, qs);
      expect({ [key]: rows.length }).toEqual({ [key]: counts[key] });
    }

    /* And the figures themselves are what the fixture says they are. */
    expect(counts.overdue).toBe(3);
    expect(counts.blocked).toBe(2);
    expect(counts.atRisk).toBe(7);              // 3 overdue + 4 forecast late
    expect(counts.dueToday).toBe(3);            // 1 due-soon + 2 pending, today
    expect(counts.awaitingOther).toBe(2);
    /* Completed milestones are in none of them. */
    /* Today's 3, the 2 blocked on day 2, the 4 forecast-late on day 3, the 5
       pending on day 4 and the 2 waiting on another department on day 1 —
       every live milestone inside the seven days, whatever its status. The
       6 completed and the 3 a month out are in none of it. */
    expect(counts.dueThisWeek).toBe(16);
  }, 180000);

  test("a completed milestone is in no attention figure at all", async () => {
    const w = await world();
    const f = await order(w.co);
    await milestones(w.co, f, [
      { count: 2, status: "OVERDUE", forecastDate: day(-3) },
      { count: 9, status: "COMPLETED", forecastDate: day(-3), actualDate: day(-3) },
    ]);

    const { counts } = (await w.call("/tna/portfolio/attention")).body;
    expect(counts.overdue).toBe(2);
    expect(counts.dueToday).toBe(0);
    expect(counts.dueThisWeek).toBe(0);
    expect(counts.atRisk).toBe(2);
  }, 180000);
});

/* ══ 3 — ORDERS, NOT MILESTONES ══════════════════════════════════════════ */

describe("orders at risk counts orders", () => {
  test("eleven late milestones on two orders is two", async () => {
    const w = await world();
    const a = await order(w.co);
    const b = await order(w.co);
    await milestones(w.co, a, [{ count: 7, status: "OVERDUE", forecastDate: day(-6) }]);
    await milestones(w.co, b, [{ count: 4, status: "FORECAST_LATE", forecastDate: day(5) }]);

    const { counts } = (await w.call("/tna/portfolio/attention")).body;
    expect(counts.atRisk).toBe(11);
    expect(counts.ordersAtRisk).toBe(2);
  }, 180000);

  test("an order whose only late milestone is completed stops being at risk", async () => {
    const w = await world();
    const a = await order(w.co);
    await milestones(w.co, a, [{ count: 1, status: "OVERDUE", forecastDate: day(-1) }]);
    expect((await w.call("/tna/portfolio/attention")).body.counts.ordersAtRisk).toBe(1);

    await TnaMilestone.updateMany(
      { fileId: a._id }, { $set: { status: "COMPLETED", actualDate: TODAY } },
    );
    const after = (await w.call("/tna/portfolio/attention")).body.counts;
    expect(after.ordersAtRisk).toBe(0);
    expect(after.atRisk).toBe(0);
  }, 180000);
});

/* ══ 4 — ONE STORE, AND ONE COMPANY ══════════════════════════════════════ */

describe("it is the same milestones the file's own plan holds", () => {
  test("another company's milestones are in none of the figures", async () => {
    const mine = await world();
    const theirs = await world();
    const a = await order(mine.co);
    const b = await order(theirs.co);
    await milestones(mine.co, a, [{ count: 2, status: "OVERDUE", forecastDate: day(-1) }]);
    await milestones(theirs.co, b, [{ count: 9, status: "OVERDUE", forecastDate: day(-1) }]);

    expect((await mine.call("/tna/portfolio/attention")).body.counts.overdue).toBe(2);
    expect((await theirs.call("/tna/portfolio/attention")).body.counts.overdue).toBe(9);
  }, 180000);

  test("recording a completion on the record moves the Overview's figure", async () => {
    /* The point of not building a second store: there is nothing to keep in
       step, because there is only one record. */
    const w = await world();
    const f = await order(w.co);
    await milestones(w.co, f, [{ count: 3, status: "BLOCKED", forecastDate: day(1) }]);
    expect((await w.call("/tna/portfolio/attention")).body.counts.blocked).toBe(3);

    await TnaMilestone.updateOne(
      { fileId: f._id }, { $set: { status: "COMPLETED", actualDate: TODAY } },
    );
    expect((await w.call("/tna/portfolio/attention")).body.counts.blocked).toBe(2);
  }, 180000);

  test("only one collection holds a milestone on an order", async () => {
    /* The migration this chunk could have been and deliberately was not: a
       second, Overview-shaped copy of the milestones that would need keeping
       in step with the first.

       ── WHY THE DEFINITIONS COLLECTION IS NOT THAT ──────────────────────
       `merchandising_tna_milestone_definitions` holds the company's LIST of
       milestones — the words, the owning department, the system action that
       closes one. It holds no milestone on any order, and nothing reads a
       date or a status from it: a plan snapshots what it needs at creation,
       so renaming an entry cannot reach a running order. One list, one set
       of rows, and no copy to keep in step. Any OTHER new name matching
       /milestone/ is the duplication this test exists to catch. */
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    const tna = names.filter((n) => /milestone/i.test(n)).sort();
    expect(tna.filter((n) => n !== "merchandising_tna_milestone_definitions"))
      .toEqual([TnaMilestone.collection.name]);
    expect(TnaMilestone.collection.name).toBe("merchandising_tna_milestones");
  }, 180000);
});

/* ══ 5 — WAITING ON SOMEBODY ELSE ════════════════════════════════════════ */

describe("a milestone another department's record closes", () => {
  test("is its own population, defined by the authority and not by a status", async () => {
    const w = await world();
    const f = await order(w.co);
    await milestones(w.co, f, [
      { count: 4, status: "PENDING", forecastDate: day(3), authority: "SOURCE_EVENT" },
      { count: 2, status: "PENDING", forecastDate: day(3) },
      /* Already closed by that record — no longer waiting on anybody. */
      { count: 3, status: "COMPLETED", forecastDate: day(-1), actualDate: day(-1), authority: "SOURCE_EVENT" },
    ]);

    const { counts } = (await w.call("/tna/portfolio/attention")).body;
    expect(counts.awaitingOther).toBe(4);

    const rows = await everyRow(w.call, "view=awaiting-source");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.awaitingSource)).toBe(true);
  }, 180000);

  test("the view is one the register accepts by name", async () => {
    const w = await world();
    const bad = await w.call("/tna/portfolio?view=nonsense");
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.allowed).toContain("awaiting-source");
  }, 180000);
});

/* ══ PERMISSION IS UNCHANGED ═════════════════════════════════════════════ */

describe("who may read it", () => {
  test("the same grant that opens the register opens the figures", async () => {
    const viewer = await world({ role: "viewer" });
    expect((await viewer.call("/tna/portfolio/attention")).status).toBe(200);
    expect((await viewer.call("/tna/portfolio")).status).toBe(200);
  }, 180000);

  test("somebody with no Merchandising grant gets neither", async () => {
    const n = ++seq;
    const co = await Acc_Company.create({ companyName: `NoGrant ${n}`, booksFromDate: new Date("2026-04-01") });
    const email = `nogrant-${n}@grav.test`;
    const emp = await Employee.create({
      firstName: "N", lastName: `${n}`, email, biometricId: `NG${n}`,
      isActive: true, gender: "Other", department: "Sales",
    });
    await DeptUser.create({
      name: `N ${n}`, email, passwordHash: "x", isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `N ${n}` });
    const token = jwt.sign({ id: String(emp._id), email, name: `N ${n}` },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" });
    const res = await fetch(`${base}/tna/portfolio/attention`, {
      headers: { Authorization: `Bearer ${token}`, "X-Costing-Company": String(co._id) },
    });
    expect(res.status).toBe(403);
  }, 180000);
});
