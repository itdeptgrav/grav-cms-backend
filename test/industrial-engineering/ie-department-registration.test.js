// test/industrial-engineering/ie-department-registration.test.js
//
// IE IS A LAUNCHABLE DEPARTMENT, NOT A ROW IN THE FRONTEND'S ROLE PICKER.
//
// Registering `ie` in the frontend's Access Control vocabulary made the ROLE
// grantable and nothing else: with no `AccessDepartment` row the department
// cannot appear in anybody's authorised application list, `switch-department`
// refuses a slug it does not know, and the app is reachable only by typing the
// URL. This pins the whole chain — seeded, idempotent, listed, grantable,
// switchable, and refused to somebody who does not hold it.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { getRole, setRole } = require("../../services/departmentRoles");
const { invalidate } = require("../../services/memo");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

/* The session route memoises the active department list for 30 seconds. The
   shared harness clears collections between tests, so a cached list would hold
   ids that no longer exist and every actor would resolve to no department.
   Dropped after each seed — the cache is a performance decision, not a fact
   under test. */
const seed = async () => {
  const out = await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
  return out;
};

/** An employee whose primary department is the given AccessDepartment. */
async function employeeIn(dept, { extra = [] } = {}) {
  const n = ++seq;
  const email = `iedept${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `D${n}`, email, biometricId: `IED${n}`,
    isActive: true, gender: "Other", department: "Tech",
    accessDepartmentId: dept?._id,
    additionalDepartmentIds: extra.map((d) => d._id),
  });
  return {
    emp,
    email,
    token: jwt.sign(
      {
        v: 2, id: String(emp._id), subject: "employee", email,
        name: "IE Dept", employeeId: emp.biometricId,
        deptId: String(dept?._id || ""), deptSlug: dept?.slug || "",
        role: dept?.slug || "", userType: dept?.slug || "", isAdmin: false, tv: 0,
      },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/* ══ SEEDING ══════════════════════════════════════════════════════════════ */

describe("the ie department is seeded", () => {
  test("it is created on a clean database, with the agreed identity", async () => {
    expect(await AccessDepartment.countDocuments()).toBe(0);
    await seed();

    const ie = await AccessDepartment.findOne({ key: "ie" }).lean();
    expect(ie).toBeTruthy();
    expect(ie.slug).toBe("ie");
    expect(ie.name).toBe("Industrial Engineering");
    expect(ie.dashboardPath).toBe("/industrial-engineering/orders");
    /* No legacy model: nobody ever signed in to an IE module, so there is no
       collection to mirror and no legacy login to keep working. */
    expect(ie.legacyModel).toBeNull();
    expect(ie.isActive).toBe(true);
    expect(ie.showOnOnboarding).toBe(true);
    expect(typeof ie.description).toBe("string");
    expect(ie.description.length).toBeGreaterThan(10);
  });

  test("it sorts with the make-side departments, not at the end", async () => {
    await seed();
    const rows = await AccessDepartment.find({}).sort({ sortOrder: 1 }).select("slug sortOrder").lean();
    const order = rows.map((r) => r.slug);
    expect(order.indexOf("ie")).toBeGreaterThan(order.indexOf("merchandiser"));
    expect(order.indexOf("ie")).toBeLessThan(order.indexOf("accountant"));
    /* Every sort order is still distinct — a tie would make the rail's order
       depend on insertion, which is not a decision anybody made. */
    const orders = rows.map((r) => r.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  test("re-running the seeder is idempotent and overwrites nothing", async () => {
    await seed();
    const before = await AccessDepartment.findOne({ key: "ie" }).lean();
    const countBefore = await AccessDepartment.countDocuments();

    /* An administrator renames it and changes where it opens. */
    await AccessDepartment.updateOne(
      { key: "ie" },
      { $set: { name: "IE (renamed by an admin)", dashboardPath: "/industrial-engineering/orders?view=mine" } },
    );

    await seed();
    await seed();

    expect(await AccessDepartment.countDocuments()).toBe(countBefore);
    const after = await AccessDepartment.findOne({ key: "ie" }).lean();
    /* The seeder is strictly additive: the administrator's wording survives. */
    expect(after.name).toBe("IE (renamed by an admin)");
    expect(after.dashboardPath).toBe("/industrial-engineering/orders?view=mine");
    expect(String(after._id)).toBe(String(before._id));
  });
});

/* ══ GRANTING AND LISTING ═════════════════════════════════════════════════ */

describe("the ie grant", () => {
  test("Access Control can grant an IE role, and the role service reads it back", async () => {
    await seed();
    const ie = await AccessDepartment.findOne({ slug: "ie" }).lean();
    const email = `iegrant${++seq}@grav.test`;

    await setRole({ departmentSlug: "ie", email, name: "Engineer", role: "viewer" });

    const stored = await DepartmentRole.findOne({ departmentSlug: "ie", email }).lean();
    expect(stored).toBeTruthy();
    expect(stored.role).toBe("viewer");
    expect(await getRole("ie", email)).toBe("viewer");
    expect(ie.slug).toBe("ie");
  });

  test("it appears in the authorised application list of somebody who holds it", async () => {
    await seed();
    const ie = await AccessDepartment.findOne({ slug: "ie" });
    const actor = await employeeIn(ie);

    const res = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const slugs = (res.body.departments || []).map((d) => d.slug);
    expect(slugs).toContain("ie");
  });

  test("it does NOT appear for somebody who does not hold it", async () => {
    await seed();
    const sales = await AccessDepartment.findOne({ slug: "sales" });
    const actor = await employeeIn(sales);

    const res = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect(res.status).toBe(200);
    expect((res.body.departments || []).map((d) => d.slug)).not.toContain("ie");
  });
});

/* ══ SWITCHING IN ═════════════════════════════════════════════════════════ */

describe("switching into Industrial Engineering", () => {
  test("returns the IE landing path, so the launcher lands on Orders", async () => {
    await seed();
    const ie = await AccessDepartment.findOne({ slug: "ie" });
    const actor = await employeeIn(ie);

    const res = await call("/api/auth/switch-department", {
      method: "POST", token: actor.token, body: { slug: "ie" },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.redirectTo).toBe("/industrial-engineering/orders");
    expect(res.body.department?.slug).toBe("ie");
    expect(typeof res.body.token).toBe("string");
  });

  test("the minted session carries the ie slug", async () => {
    await seed();
    const ie = await AccessDepartment.findOne({ slug: "ie" });
    const actor = await employeeIn(ie);

    const res = await call("/api/auth/switch-department", {
      method: "POST", token: actor.token, body: { slug: "ie" },
    });
    const decoded = jwt.decode(res.body.token);
    expect(decoded.deptSlug).toBe("ie");
  });

  test("an account without the IE department cannot switch into it", async () => {
    await seed();
    const sales = await AccessDepartment.findOne({ slug: "sales" });
    const actor = await employeeIn(sales);

    const res = await call("/api/auth/switch-department", {
      method: "POST", token: actor.token, body: { slug: "ie" },
    });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    /* Non-disclosing: the refusal says nothing about whether `ie` exists. */
    expect(res.body.message).toMatch(/do not have access/i);
  });

  test("holding a second department reaches IE without losing the first", async () => {
    await seed();
    const sales = await AccessDepartment.findOne({ slug: "sales" });
    const ie = await AccessDepartment.findOne({ slug: "ie" });
    const actor = await employeeIn(sales, { extra: [ie] });

    const list = await call("/api/auth/verify", { method: "POST", token: actor.token });
    expect((list.body.departments || []).map((d) => d.slug).sort()).toEqual(["ie", "sales"]);

    const res = await call("/api/auth/switch-department", {
      method: "POST", token: actor.token, body: { slug: "ie" },
    });
    expect(res.body.redirectTo).toBe("/industrial-engineering/orders");
  });
});
