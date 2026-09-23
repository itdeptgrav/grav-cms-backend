// test/ppc/ppc-app-entry.test.js
//
// PPC IS A LAUNCHABLE DEPARTMENT — AND STILL ONLY FOR THE PEOPLE GRANTED IT.
//
// PPC's screens, routes and role checks all existed, and nobody could open the
// app: there was no `ppc` AccessDepartment, so no employee's department list
// could contain it, the launcher showed no tile, `switch-department` refused
// the slug, and the shell's DepartmentGuard turned everyone but an admin away.
//
// This pins the chain end to end — seeded, idempotent, listed, switchable,
// landing on the Order Book — and the two refusals that matter as much:
//
//   · an account without the PPC department sees no tile and cannot switch in;
//   · an account WITH the department but WITHOUT a PPC role reaches the shell
//     and nothing inside it — the tile is a door, not a grant.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
/* One secret for every signer and verifier in this file. Without JWT_SECRET,
   `config/jwt.js` (which `switch-department` signs with) falls back to its own
   dev-only key while the older EmployeeAuthMiddleware falls back to a different
   literal, so a switched session would fail to verify at PPC's routes — an
   artefact of an unset secret, not of PPC. Set before any module reads it. */
process.env.JWT_SECRET = process.env.JWT_SECRET || "ppc-app-entry-test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const cookieParser = (() => { try { return require("cookie-parser"); } catch { return null; } })();

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { setRole } = require("../../services/departmentRoles");
const { invalidate } = require("../../services/memo");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  if (cookieParser) app.use(cookieParser());
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  /* All three PPC routers, exactly as server.js mounts them. */
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/ieReleasesRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/capacityRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(company ? { "X-Costing-Company": String(company) } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => {
  const t = await r.text();
  let b = null; try { b = JSON.parse(t || "null"); } catch { b = { nonJson: true }; }
  return { status: r.status, body: b };
});

/* The session route memoises the active department list; the harness clears
   collections between tests, so the cache is dropped after each seed. */
const seed = async () => {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
};

async function employeeIn(dept, { extra = [], company = null } = {}) {
  const n = ++seq;
  const email = `ppcentry${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `E${n}`, email, biometricId: `PPE${n}`,
    isActive: true, gender: "Other", department: "Tech",
    accessDepartmentId: dept?._id,
    additionalDepartmentIds: extra.map((d) => d._id),
  });
  if (company) {
    await SpCompanyMembership.create({ companyId: company._id, email, employeeRef: emp._id, personName: "P" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { v: 2, id: String(emp._id), subject: "employee", email, name: `PPC Entry ${n}`,
        employeeId: emp.biometricId, deptId: String(dept?._id || ""), deptSlug: dept?.slug || "",
        role: dept?.slug || "", userType: dept?.slug || "", isAdmin: false, tv: 0 },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* ══ SEEDING ══════════════════════════════════════════════════════════════ */

describe("the ppc department is seeded", () => {
  test("it exists, with the app's name, and lands on the Order Book", async () => {
    await seed();
    const ppc = await AccessDepartment.findOne({ key: "ppc" }).lean();
    expect(ppc).toBeTruthy();
    expect(ppc.slug).toBe("ppc");
    expect(ppc.name).toBe("Production Planning & Control");
    expect(ppc.dashboardPath).toBe("/ppc/order-book");
    expect(ppc.legacyModel).toBeNull();
    expect(ppc.isActive).toBe(true);
    expect(ppc.showOnOnboarding).toBe(true);
  });

  test("it sorts right after IE, and every sort order stays distinct", async () => {
    await seed();
    const rows = await AccessDepartment.find({}).sort({ sortOrder: 1 }).select("slug sortOrder").lean();
    const order = rows.map((r) => r.slug);
    expect(order.indexOf("ppc")).toBe(order.indexOf("ie") + 1);
    expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(rows.length);
  });

  test("re-seeding is idempotent and keeps an administrator's edits", async () => {
    await seed();
    await AccessDepartment.updateOne({ key: "ppc" }, { $set: { name: "PPC (renamed)" } });
    const count = await AccessDepartment.countDocuments();
    await seed(); await seed();
    expect(await AccessDepartment.countDocuments()).toBe(count);
    expect((await AccessDepartment.findOne({ key: "ppc" }).lean()).name).toBe("PPC (renamed)");
  });

  test("registering the department grants nobody a PPC role", async () => {
    await seed();
    expect(await DepartmentRole.countDocuments({ departmentSlug: "ppc" })).toBe(0);
  });
});

/* ══ THE TILE AND THE SWITCH ══════════════════════════════════════════════ */

describe("a person granted PPC sees the tile and lands on the Order Book", () => {
  test("PPC appears in their authorised application list", async () => {
    await seed();
    const ppc = await AccessDepartment.findOne({ slug: "ppc" });
    const actor = await employeeIn(ppc);
    const res = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect(res.status).toBe(200);
    const tile = (res.body.departments || []).find((d) => d.slug === "ppc");
    expect(tile).toBeTruthy();
    expect(tile.name).toBe("Production Planning & Control");
    expect(tile.dashboardPath).toBe("/ppc/order-book");
  });

  test("switching in returns /ppc/order-book and a session carrying the ppc slug", async () => {
    await seed();
    const sales = await AccessDepartment.findOne({ slug: "sales" });
    const ppc = await AccessDepartment.findOne({ slug: "ppc" });
    const actor = await employeeIn(sales, { extra: [ppc] });

    const list = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect((list.body.departments || []).map((d) => d.slug).sort()).toEqual(["ppc", "sales"]);

    const res = await call("/api/auth/switch-department", { method: "POST", token: actor.token, body: { slug: "ppc" } });
    expect(res.status).toBe(200);
    expect(res.body.redirectTo).toBe("/ppc/order-book");
    expect(res.body.department?.slug).toBe("ppc");
    expect(jwt.decode(res.body.token).deptSlug).toBe("ppc");
  });

  test("with a PPC role too, the switched session reads the Order Book", async () => {
    await seed();
    const co = await Acc_Company.create({ companyName: `Entry Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
    const ppc = await AccessDepartment.findOne({ slug: "ppc" });
    const actor = await employeeIn(ppc, { company: co });
    await setRole({ departmentSlug: "ppc", email: actor.email, name: "Planner", role: "viewer" });

    const sw = await call("/api/auth/switch-department", { method: "POST", token: actor.token, body: { slug: "ppc" } });
    const book = await call("/api/cms/ppc/order-book?view=all", { token: sw.body.token, company: co._id });
    expect(book.status).toBe(200);
    expect(Array.isArray(book.body.rows)).toBe(true);
  });
});

describe("a person without the grant gains nothing", () => {
  test("no PPC department: no tile, and switching in is refused without disclosure", async () => {
    await seed();
    const sales = await AccessDepartment.findOne({ slug: "sales" });
    const actor = await employeeIn(sales);
    const list = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect((list.body.departments || []).map((d) => d.slug)).not.toContain("ppc");

    const res = await call("/api/auth/switch-department", { method: "POST", token: actor.token, body: { slug: "ppc" } });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not have access/i);
    expect(res.body.token).toBeUndefined();
  });

  test("the department without a PPC role opens the door and nothing behind it", async () => {
    await seed();
    const co = await Acc_Company.create({ companyName: `NoRole Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
    const ppc = await AccessDepartment.findOne({ slug: "ppc" });
    const actor = await employeeIn(ppc, { company: co });
    const sw = await call("/api/auth/switch-department", { method: "POST", token: actor.token, body: { slug: "ppc" } });
    expect(sw.status).toBe(200);
    for (const path of ["/api/cms/ppc/companies", "/api/cms/ppc/order-book?view=all", "/api/cms/ppc/capacity/lines"]) {
      const r = await call(path, { token: sw.body.token, company: co._id });
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
  });

  test("another department's role is not a PPC role", async () => {
    await seed();
    const co = await Acc_Company.create({ companyName: `Other Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
    const ppc = await AccessDepartment.findOne({ slug: "ppc" });
    const actor = await employeeIn(ppc, { company: co });
    await setRole({ departmentSlug: "merchandiser", email: actor.email, name: "M", role: "owner" });
    await setRole({ departmentSlug: "ie", email: actor.email, name: "M", role: "owner" });
    const r = await call("/api/cms/ppc/order-book?view=all", { token: actor.token, company: co._id });
    expect(r.status).toBe(403);
  });
});
