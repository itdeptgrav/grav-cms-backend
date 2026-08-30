// test/requests/stand-in-login.route.test.js
//
// A LOGIN THAT IS A DEPARTMENT RATHER THAN A PERSON.
//
// ── THE BUG THIS SUITE EXISTS FOR ───────────────────────────────────────────
// Not every account in this CMS is an employee. The CEO signs in through the
// legacy `ceodepartments` collection and has no row in `employees` at all.
// Every route in the intake router begins by resolving the caller to an
// Employee, and when that failed it answered with a well-formed EMPTY LIST —
// `{success: true, requests: []}`.
//
// So the CEO opened the requests desk and was told, truthfully and uselessly,
// that nothing was waiting, while a request sat in the queue. Nobody reports
// that as a bug; they report it as a missing request, which is how it was
// found. fulfilmentAccess had granted the board this queue since it was
// written (`BOARD_DEPT_SLUGS`), but the grant was unreachable — the caller
// never got far enough to be asked about.
//
// ── WHAT IS ACTUALLY BEING ASSERTED ─────────────────────────────────────────
// Two halves, and the second matters as much as the first:
//
//   1. A department login SEES what its department is entitled to see.
//   2. A department login CANNOT DO the things that need a person. Every
//      identity this router stores is a ref into `employees`; a stand-in has
//      nothing valid to write, and writing its department id there would read
//      back later as a deleted employee. So the write paths refuse it — and
//      refuse it by SAYING SO, rather than by failing an ownership test with a
//      message about whose turn it is.
//
// The negative half is the fragile one. Anybody widening the stand-in later to
// "let the CEO raise a request too" will trip these, which is the point.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const IntakeRequest = require("../../models/CMS_Models/Requests/IntakeRequest");
const intake = require("../../services/requestIntake.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/intake",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/intakeRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/intake`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

/** A department account: a token with a deptId and no employee behind it. */
const asDept = (dept, { employeeId = "CEO001", name = "Chief Executive Officer" } = {}) =>
  jwt.sign(
    {
      v: 2,
      id: String(new mongoose.Types.ObjectId()),
      role: dept.slug,
      userType: dept.slug,
      deptId: String(dept._id),
      deptSlug: dept.slug,
      employeeId,
      name,
      email: `${dept.slug}@example.test`,
    },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

/** A real person, for the regression half. */
const asEmployee = (emp) =>
  jwt.sign(
    {
      id: String(emp._id),
      role: "employee",
      employeeId: emp.biometricId,
      name: `${emp.firstName} ${emp.lastName}`,
      email: emp.email,
    },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

const call = (token, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const makeDept = (slug, name) =>
  AccessDepartment.create({
    key: `${slug}-${++seq}`,
    slug,
    name,
    dashboardPath: `/d/${slug}`,
    isActive: true,
  });

/** A request already past department approval and sitting with Store. */
const waitingForStore = (requester) =>
  IntakeRequest.create({
    title: "Claude",
    purpose: "for improving efficiency and saving time",
    requestType: "SERVICE",
    requestedBy: requester._id,
    requestedByName: `${requester.firstName} ${requester.lastName}`,
    requestedById: requester.biometricId,
    department: requester.department,
    items: [{ name: "Claude", quantity: 1, unit: "month" }],
    status: intake.NEEDS_CLASSIFICATION,
    ledgerId: new mongoose.Types.ObjectId(),
    ledgerName: "Software Subscription Expenses",
    requestNumber: `REQ-TEST-${++seq}`,
  });

const makeEmployee = (over = {}) =>
  Employee.create({
    firstName: "RAKESH", lastName: "BISWAL",
    gender: "Other",
    biometricId: `E${1000 + ++seq}`,
    email: `e${seq}@example.test`,
    department: "IT",
    isActive: true,
    ...over,
  });

afterEach(async () => {
  await Promise.all([
    IntakeRequest.deleteMany({}),
    Employee.deleteMany({}),
    AccessDepartment.deleteMany({}),
  ]);
});

describe("a department login with no staff record", () => {
  test("the board sees the fulfilment queue instead of a silent empty list", async () => {
    const ceo = await makeDept("ceo", "Executive Office");
    const rakesh = await makeEmployee();
    await waitingForStore(rakesh);

    const { body } = await call(asDept(ceo), "/fulfilment");

    expect(body.success).toBe(true);
    // The whole bug in one assertion.
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].title).toBe("Claude");
  });

  test("/me admits what it is, so the desk can stop showing personal tabs", async () => {
    const ceo = await makeDept("ceo", "Executive Office");

    const { body } = await call(asDept(ceo), "/me");

    expect(body.me.canFulfil).toBe(true);
    expect(body.me.standIn).toBe(true);
    // Named, not slugged — this is rendered.
    expect(body.me.department).toBe("Executive Office");
    // It is nobody, so it manages nobody.
    expect(body.me.managesPeople).toBe(false);
  });

  test("a Store department account gets the queue too", async () => {
    const store = await makeDept("store", "Store & Purchase");
    const rakesh = await makeEmployee();
    await waitingForStore(rakesh);

    const { body } = await call(asDept(store, { employeeId: "" }), "/fulfilment");

    expect(body.requests).toHaveLength(1);
  });

  test("a department with no fulfilment grant is still refused", async () => {
    const qc = await makeDept("qc", "Quality Control");
    const rakesh = await makeEmployee();
    await waitingForStore(rakesh);

    const { status, body } = await call(asDept(qc), "/fulfilment");

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });
});

describe("what a department login may NOT do", () => {
  /* `requestedBy` is a required ref into `employees`. A stand-in has no id to
     put there, and a request nobody can be sent back to is not a request. */
  test("it cannot raise a request", async () => {
    const ceo = await makeDept("ceo", "Executive Office");

    const { status, body } = await call(asDept(ceo), "/", {
      method: "POST",
      body: { title: "x", requestType: "PRODUCT", items: [{ name: "y", quantity: 1 }] },
    });

    expect(status).toBe(403);
    expect(body.message).toMatch(/no staff record/i);
  });

  test("it cannot approve — and says why, rather than 'not your turn'", async () => {
    const ceo = await makeDept("ceo", "Executive Office");
    const rakesh = await makeEmployee();
    const req = await waitingForStore(rakesh);

    const { status, body } = await call(asDept(ceo), `/${req._id}/approve`, {
      method: "PATCH",
      body: {},
    });

    expect(status).toBe(403);
    expect(body.message).toMatch(/no staff record/i);
  });

  test("it cannot withdraw somebody else's request", async () => {
    const ceo = await makeDept("ceo", "Executive Office");
    const rakesh = await makeEmployee();
    const req = await waitingForStore(rakesh);

    const { status, body } = await call(asDept(ceo), `/${req._id}/cancel`, {
      method: "PATCH",
      body: {},
    });

    expect(status).toBe(403);
    expect(body.message).toMatch(/no staff record/i);
  });
});

describe("nobody we could identify at all", () => {
  /* No employee AND no department. This must not look like an empty desk —
     that was the original failure, and it would simply move rather than go. */
  test("says so instead of returning a clean empty list", async () => {
    const token = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), employeeId: "GHOST", name: "", email: "" },
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "10m" },
    );

    const { body } = await call(token, "/fulfilment");

    expect(body.requests).toHaveLength(0);
    expect(body.identityMissing).toBe(true);
  });

  test("/me carries the same flag", async () => {
    const token = jwt.sign(
      { id: String(new mongoose.Types.ObjectId()), employeeId: "GHOST", name: "", email: "" },
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "10m" },
    );

    const { body } = await call(token, "/me");

    expect(body.me.identityMissing).toBe(true);
    expect(body.me.canFulfil).toBe(false);
  });
});

describe("real employees are untouched", () => {
  /* The stand-in is a fallback and must never shadow a real person — including
     a person whose login also carries a department grant. */
  test("an employee is never a stand-in, even holding a department token", async () => {
    const store = await makeDept("store", "Store & Purchase");
    const emp = await makeEmployee({
      firstName: "SIPRAJYOTI", lastName: "S",
      department: "STORE",
      accessDepartmentId: store._id,
    });

    const token = jwt.sign(
      {
        v: 2, id: String(emp._id), employeeId: emp.biometricId,
        deptId: String(store._id), deptSlug: "store",
        name: "SIPRAJYOTI S", email: emp.email,
      },
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "10m" },
    );

    const { body } = await call(token, "/me");

    expect(body.me.standIn).toBe(false);
    expect(body.me.canFulfil).toBe(true);
    // The person's own name and HR department, not the department account's.
    expect(body.me.department).toBe("STORE");
  });

  test("an employee with no fulfilment grant still cannot see the queue", async () => {
    const emp = await makeEmployee();
    const { status } = await call(asEmployee(emp), "/fulfilment");
    expect(status).toBe(403);
  });
});
