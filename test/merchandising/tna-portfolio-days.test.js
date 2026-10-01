// test/merchandising/tna-portfolio-days.test.js
//
// THE CALENDAR'S NUMBERS, AND THE LISTS BEHIND THEM.
//
//   1  A day's count is every matching milestone, not the first page of them.
//   2  Opening a day lists exactly the milestones its count counted — same
//      view, same filters, same records.
//   3  Milestones with no forecast date are counted and listed on their own,
//      never lost by a date range.
//   4  Paging through a register that starts with undated milestones reaches
//      every dated one after them.
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
const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "tna_days" });
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

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Days ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `days-${n}@grav.test`;
  const emp = await Employee.create({ firstName: "D", lastName: `${n}`, email, biometricId: `DY${n}`,
    isActive: true, gender: "Other", department: "Merchandising" });
  await DeptUser.create({ name: `D ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `D ${n}` });
  await DepartmentRole.create({ departmentSlug: "merchandiser", email, name: `D ${n}`, role: "viewer",
    isActive: true, departmentId: new mongoose.Types.ObjectId() });
  const token = jwt.sign({ id: String(emp._id), email, name: `D ${n}` },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" });
  const call = (path) => fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Costing-Company": String(co._id) },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { co, call };
}

/** Milestones as the counts see them: company, status, forecast date. */
async function milestones(co, specs) {
  const planId = new mongoose.Types.ObjectId();
  const fileId = new mongoose.Types.ObjectId();
  let i = 0;
  const rows = specs.flatMap(([count, status, forecastDate]) => Array.from({ length: count }, () => ({
    companyId: co._id, planId, fileId, milestoneRef: `M-${++i}`, milestoneCode: "FABRIC_IN_HOUSE",
    name: `Milestone ${i}`, ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    scopeKind: "FILE", status, forecastDate, baselineDate: null, actualDate: null,
  })));
  await TnaMilestone.collection.insertMany(rows);
}

/** Every row a view+filter lists, following the cursor to the end. */
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

describe("a calendar day counts everything on it", () => {
  test("a crowded day beyond one page is counted in full, and opens exactly those records", async () => {
    const { co, call } = await world();
    await milestones(co, [
      [40, "PENDING", "2026-11-10"],          // crowded: more than a page of 25
      [3, "OVERDUE", "2026-11-10"],
      [2, "FORECAST_LATE", "2026-11-12"],
      [1, "BLOCKED", "2026-11-12"],
      [5, "COMPLETED", "2026-11-20"],
      [4, "PENDING", "2026-12-15"],           // outside the month asked for
    ]);

    const month = await call("/tna/portfolio/days?view=all&from=2026-11-01&to=2026-11-30");
    expect(month.status).toBe(200);
    const byDate = Object.fromEntries(month.body.days.map((d) => [d.date, d]));
    expect(byDate["2026-11-10"].total).toBe(43);
    expect(byDate["2026-11-10"].byStatus).toEqual({ PENDING: 40, OVERDUE: 3 });
    expect(byDate["2026-11-12"].total).toBe(3);
    expect(byDate["2026-11-20"].total).toBe(5);
    expect(byDate["2026-12-15"]).toBeUndefined();

    /* Each day's number opens exactly its records. */
    for (const d of month.body.days) {
      const rows = await everyRow(call, `view=all&from=${d.date}&to=${d.date}`);
      expect(rows).toHaveLength(d.total);
      expect(new Set(rows.map((r) => r.forecastDate))).toEqual(new Set([d.date]));
    }
  }, 180000);

  test("the counts follow the view: at-risk counts only overdue and forecast-late", async () => {
    const { co, call } = await world();
    await milestones(co, [[4, "OVERDUE", "2026-11-03"], [2, "FORECAST_LATE", "2026-11-03"],
      [9, "PENDING", "2026-11-03"], [1, "COMPLETED", "2026-11-03"]]);
    const r = await call("/tna/portfolio/days?view=at-risk&from=2026-11-01&to=2026-11-30");
    expect(r.body.days).toEqual([{ date: "2026-11-03", total: 6, byStatus: { OVERDUE: 4, FORECAST_LATE: 2 } }]);
    const rows = await everyRow(call, "view=at-risk&from=2026-11-03&to=2026-11-03");
    expect(rows).toHaveLength(6);
  }, 180000);

  test("undated milestones are counted and listed, never lost", async () => {
    const { co, call } = await world();
    await milestones(co, [[7, "PENDING", null], [2, "BLOCKED", null], [5, "PENDING", "2026-11-05"]]);
    const r = await call("/tna/portfolio/days?view=all&from=2026-11-01&to=2026-11-30");
    expect(r.body.undated).toBe(9);
    const undated = await everyRow(call, "view=all&undated=1");
    expect(undated).toHaveLength(9);
    expect(undated.every((u) => u.forecastDate === null)).toBe(true);
    /* And under a view, only that view's undated ones. */
    const blocked = await call("/tna/portfolio/days?view=blocked&from=2026-11-01&to=2026-11-30");
    expect(blocked.body.undated).toBe(2);
  }, 180000);

  test("the range is bounded and validated", async () => {
    const { call } = await world();
    expect((await call("/tna/portfolio/days?view=all&from=2026-01-01&to=2026-06-30")).status).toBe(400);
    expect((await call("/tna/portfolio/days?view=all&from=2026-11-30&to=2026-11-01")).status).toBe(400);
    expect((await call("/tna/portfolio/days?view=nonsense&from=2026-11-01&to=2026-11-30")).status).toBe(400);
  }, 120000);

  test("another company's milestones are not counted", async () => {
    const a = await world();
    const b = await world();
    await milestones(b.co, [[5, "PENDING", "2026-11-05"]]);
    const r = await a.call("/tna/portfolio/days?view=all&from=2026-11-01&to=2026-11-30");
    expect(r.body.days).toEqual([]);
    expect(r.body.undated).toBe(0);
  }, 120000);
});

describe("paging past the undated milestones", () => {
  test("a register that begins with more than a page of undated milestones reaches every dated one", async () => {
    const { co, call } = await world();
    await milestones(co, [[30, "PENDING", null], [12, "PENDING", "2026-11-05"], [8, "PENDING", "2026-11-06"]]);
    const rows = await everyRow(call, "view=all");
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.forecastDate).length).toBe(20);
  }, 180000);
});
