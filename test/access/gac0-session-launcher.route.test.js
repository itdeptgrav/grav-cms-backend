// test/access/gac0-session-launcher.route.test.js
//
// GAC-0 — CHARACTERIZATION ONLY. Launcher answers versus API answers, and what
// an EXISTING session keeps after something is revoked, over real HTTP.
//
// Some assertions pin behaviour the single-organisation decision calls unsafe
// (a stale department session re-minted by switch-department; a deactivated
// employee's token still passing EmployeeAuthMiddlewear; a de-admined token
// still bypassing the role guard). They exist so GAC-4 must flip them
// deliberately. See docs/audits/single-organisation-access-gac0-2026-09-25.md.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "gac0-session-launcher-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { setRole, requireDepartmentRole } = require("../../services/departmentRoles");
const { invalidate } = require("../../services/memo");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  /* Probes: the ordinary CMS token middleware, alone and in front of the
     shared department-role guard, as server.js composes them for writes. */
  app.get("/probe/session", EmployeeAuthMiddleware, (req, res) => res.json({ ok: true, user: req.user }));
  app.get("/probe/sales", EmployeeAuthMiddleware, requireDepartmentRole("sales", "viewer"), (req, res) => res.json({ ok: true }));
  app.get("/probe/hr", EmployeeAuthMiddleware, requireDepartmentRole("hr", "viewer"), (req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => {
  const t = await r.text();
  let b = null; try { b = JSON.parse(t || "null"); } catch { b = { nonJson: true }; }
  return { status: r.status, body: b };
});

const seed = async () => {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
};
const dept = (slug) => AccessDepartment.findOne({ slug });

async function employeeIn(d, { isAdminClaim = false } = {}) {
  const i = ++n;
  const email = `gac0.session${i}@grav.test`;
  const emp = await Employee.create({
    firstName: "S", lastName: `L${i}`, email, biometricId: `GSL${i}`,
    isActive: true, gender: "Other", department: "Tech", accessDepartmentId: d?._id,
  });
  const token = jwt.sign(
    { v: 2, id: String(emp._id), subject: "employee", email, name: `S L${i}`,
      employeeId: emp.biometricId, deptId: String(d?._id || ""), deptSlug: d?.slug || "",
      role: d?.slug || "", userType: d?.slug || "", isAdmin: isAdminClaim, tv: 0 },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );
  return { emp, email, token };
}

async function deptUserIn(d, { isAdmin = false } = {}) {
  const i = ++n;
  const user = await DeptUser.create({
    name: `Dept ${i}`, email: `gac0.dept${i}@grav.test`, passwordHash: "x",
    departmentId: d._id, isAdmin, isActive: true,
  });
  const token = jwt.sign(
    { v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug,
      email: user.email, isAdmin, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );
  return { user, token };
}

const tiles = (res) => (res.body?.departments || []).map((d) => d.slug);

/* ══ (d) LAUNCHER ACCESS DISAGREEING WITH API ACCESS ═════════════════════ */

describe("launcher tile versus API guard", () => {
  test("GAC-AR1: a platform administrator is shown the PPC tile, switches in, and PPC's API now AGREES (200)", async () => {
    await seed();
    await Acc_Company.create({ companyName: `GAC0 Launch ${++n}`, booksFromDate: new Date("2026-04-01") });
    const { token } = await deptUserIn(await dept("ceo"), { isAdmin: true });

    const verify = await call("/api/auth/verify", { method: "POST", token });
    expect(verify.status).toBe(200);
    expect(tiles(verify)).toContain("ppc");

    const sw = await call("/api/auth/switch-department", { method: "POST", token, body: { slug: "ppc" } });
    expect(sw.status).toBe(200);
    const book = await call("/api/cms/ppc/order-book?view=all", { token: sw.body.token });
    // GAC-0 pinned 403 here (tile shown, API refused). The database-verified
    // administrator is owner in every application now, so they agree.
    expect(book.status).toBe(200);
  });

  test("GAC-AR1: an assignment without a role no longer shows a Sales tile — launcher and guard agree", async () => {
    await seed();
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone-else@grav.test", role: "owner" });
    const actor = await employeeIn(await dept("sales"));

    // GAC-0 pinned "tile shown, guard refuses". The launcher is now the
    // resolver's answer, so neither offers Sales.
    expect(tiles(await call("/api/auth/verify", { method: "POST", token: actor.token }))).not.toContain("sales");
    const probe = await call("/probe/sales", { token: actor.token });
    expect(probe.status).toBe(403);
    expect(probe.body.code).toBe("NO_DEPARTMENT_ROLE");
  });

  test("GAC-AR1: an HR role without the HR department passes the HR guard AND now shows the HR tile", async () => {
    await seed();
    const actor = await employeeIn(await dept("sales"));
    await setRole({ departmentSlug: "hr", email: actor.email, name: "R", role: "owner" });

    // GAC-0 pinned "no tile". The role IS the application grant now.
    expect(tiles(await call("/api/auth/verify", { method: "POST", token: actor.token }))).toContain("hr");
    expect((await call("/probe/hr", { token: actor.token })).status).toBe(200);
  });

  test("a department nobody holds a role in is open to any signed-in caller at the role guard", async () => {
    await seed();
    const actor = await employeeIn(await dept("sales"));
    expect(await DepartmentRole.countDocuments({ departmentSlug: "sales" })).toBe(0);
    expect((await call("/probe/sales", { token: actor.token })).status).toBe(200);
  });
});

/* ══ (e) REVOCATION AND AN EXISTING SESSION ══════════════════════════════ */

describe("revocation behaviour for an existing session", () => {
  test("revoking a department role takes effect on the next request at the role guard", async () => {
    await seed();
    const actor = await employeeIn(await dept("sales"));
    await setRole({ departmentSlug: "sales", email: actor.email, name: "R", role: "viewer" });
    expect((await call("/probe/sales", { token: actor.token })).status).toBe(200);

    await setRole({ departmentSlug: "sales", email: actor.email, role: null });
    expect((await call("/probe/sales", { token: actor.token })).status).toBe(403);
  });

  test("a deactivated employee is refused by /verify but still passes EmployeeAuthMiddlewear", async () => {
    await seed();
    const actor = await employeeIn(await dept("sales"));
    await Employee.updateOne({ _id: actor.emp._id }, { $set: { isActive: false, status: "inactive" } });

    expect((await call("/api/auth/verify", { method: "POST", token: actor.token })).status).toBe(401);
    expect((await call("/probe/session", { token: actor.token })).status).toBe(200);
  });

  test("GAC-AR1: an isAdmin claim no longer bypasses the role guard once the database is not calling them admin", async () => {
    await seed();
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone-else@grav.test", role: "owner" });
    const actor = await employeeIn(await dept("sales"), { isAdminClaim: true });
    // No DeptUser, no admin flag anywhere in the database. GAC-0 pinned 200.
    expect(await DeptUser.countDocuments({ isAdmin: true })).toBe(0);
    expect((await call("/probe/sales", { token: actor.token })).status).toBe(403);
  });

  test("GAC-AR1: a revoked department session is refused by /verify AND by switch-department", async () => {
    await seed();
    const { user, token } = await deptUserIn(await dept("sales"));
    expect((await call("/api/auth/verify", { method: "POST", token })).status).toBe(200);

    // Revocation as the admin API performs it: bump tokenVersion.
    await DeptUser.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    expect((await call("/api/auth/verify", { method: "POST", token })).status).toBe(401);

    // GAC-0 pinned 200 and a fresh token here. The switch now checks the
    // token version too.
    const sw = await call("/api/auth/switch-department", { method: "POST", token, body: { slug: "sales" } });
    expect(sw.status).toBe(401);
    expect(sw.body.code).toBe("SESSION_REVOKED");
  });
});
