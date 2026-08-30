// test/auth/cowork-sso-apps.route.test.js
//
// WHICH EXTERNAL APP A TILE OPENS, AND WHOSE GRANT DECIDES IT.
//
// There used to be exactly one app on another origin — CoWork — and the SSO
// bridge found it with `findOne({ externalBaseUrl: { $ne: "" } })`. Material
// Requests is a second: same origin, its own department, its own grant, so
// somebody can raise a material request for the store without being handed the
// whole workspace.
//
// With two rows matching, the old lookup picked whichever came back first and
// then checked the caller against THAT department's grant — the wrong question,
// and half the time the wrong answer. These pin the fix: the tile names itself,
// the grant checked is the one on the tile clicked, and a client written before
// any of this still opens the app it always did.
//
// Firebase is stubbed. What is under test is the ACCESS decision and the
// destination, which are Mongo and route logic; minting a custom token is
// Google's job and exercising it here would test their SDK.
"use strict";

process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");

jest.mock("../../config/firebaseAdmin", () => ({
  auth: { createCustomToken: jest.fn(async (uid) => `custom-token-for-${uid}`) },
  db: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, id: "GR0108", data: () => ({ authUid: "uid-1" }) }) }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
    }),
  },
}));

const AccessDepartment = require("../../models/Access/AccessDepartment");
const Employee = require("../../models/Employee");
const deptAuth = require("../../routes/auth/deptAuth");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", deptAuth);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const COWORK_URL = "https://cowork.grav.in";

/** The two external tiles, plus one ordinary CMS department. */
async function seed() {
  const n = seq++;
  const cowork = await AccessDepartment.create({
    key: `COWORK_${n}`, slug: `cowork-${n}`, name: "CoWork", isActive: true,
    dashboardPath: "/coworking", externalBaseUrl: COWORK_URL,
  });
  const mrf = await AccessDepartment.create({
    key: `MRF_${n}`, slug: `mrf-${n}`, name: "Material Requests", isActive: true,
    /* The path inside that origin. This is what makes the tile open the app
       rather than somebody else's dashboard. */
    dashboardPath: "/mrf", externalBaseUrl: COWORK_URL,
  });
  const store = await AccessDepartment.create({
    key: `STORE_${n}`, slug: `store-${n}`, name: "Store", isActive: true,
    dashboardPath: "/store/dashboard",
  });
  return { cowork, mrf, store };
}

async function employeeHolding(depts) {
  const n = seq++;
  return Employee.create({
    firstName: "Rakesh", lastName: "Biswal", email: `rakesh${n}@demo.example`,
    isActive: true, gender: "Other",
    coworkEmployeeId: "GR0108",
    accessDepartmentId: depts[0]?._id,
    ...(depts.length > 1 ? { additionalDepartmentIds: depts.slice(1).map((d) => d._id) } : {}),
  });
}

const sso = (employee, body) =>
  fetch(`${base}/cowork-sso`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deptAuth.signToken({
        v: 2, subject: "employee", id: String(employee._id), email: employee.email,
      })}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* ── THE GRANT CHECKED IS THE TILE CLICKED ────────────────────────────────── */

test("Material Requests opens for somebody who holds only Material Requests", async () => {
  /* The whole point of the second tile: the store's raw-material requesters
     are not workspace users, and should not have to be. */
  const { mrf } = await seed();
  const employee = await employeeHolding([mrf]);

  const { status, body } = await sso(employee, { slug: mrf.slug });
  expect(status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.redirectBaseUrl).toBe(COWORK_URL);
  expect(body.redirectPath).toBe("/mrf");
});

test("and CoWork does not open for them", async () => {
  const { cowork, mrf } = await seed();
  const employee = await employeeHolding([mrf]);

  const { status, body } = await sso(employee, { slug: cowork.slug });
  expect(status).toBe(403);
  expect(body.code).toBe("NO_COWORK_ACCESS");
  expect(body.message).toMatch(/CoWork/);
});

test("holding CoWork does not open Material Requests either — each tile is its own", async () => {
  const { cowork, mrf } = await seed();
  const employee = await employeeHolding([cowork]);

  expect((await sso(employee, { slug: cowork.slug })).status).toBe(200);
  const refused = await sso(employee, { slug: mrf.slug });
  expect(refused.status).toBe(403);
  expect(refused.body.message).toMatch(/Material Requests/);
});

test("somebody who holds both opens either, and lands in the right place", async () => {
  const { cowork, mrf } = await seed();
  const employee = await employeeHolding([cowork, mrf]);

  const toWorkspace = await sso(employee, { slug: cowork.slug });
  expect(toWorkspace.status).toBe(200);
  expect(toWorkspace.body.redirectPath).toBe("/coworking");

  const toMrf = await sso(employee, { slug: mrf.slug });
  expect(toMrf.status).toBe(200);
  expect(toMrf.body.redirectPath).toBe("/mrf");
});

/* ── THE CLIENT THAT DOES NOT NAME A TILE ─────────────────────────────────── */

test("a client written before this still opens the app it always did", async () => {
  /* No slug in the body — the browser tab somebody left open across the
     deploy. It must not start refusing them. */
  const { cowork } = await seed();
  const employee = await employeeHolding([cowork]);

  const { status, body } = await sso(employee, {});
  expect(status).toBe(200);
  expect(body.redirectBaseUrl).toBe(COWORK_URL);
});

/* ── WHAT IS NOT AN EXTERNAL APP ──────────────────────────────────────────── */

test("an ordinary CMS department is not openable through this bridge", async () => {
  /* Store is a CMS department with a dashboardPath and no external origin.
     Naming it here must not hand anybody a Firebase token. */
  const { store, mrf } = await seed();
  const employee = await employeeHolding([store, mrf]);

  const { status, body } = await sso(employee, { slug: store.slug });
  expect(status).toBe(500);
  expect(body.code).toBe("NOT_CONFIGURED");
});

test("a slug nobody has is refused, not silently swapped for another app", async () => {
  const { mrf } = await seed();
  const employee = await employeeHolding([mrf]);

  const { status } = await sso(employee, { slug: "does-not-exist" });
  expect(status).toBe(500);
});

/* ── THE DESTINATION IS A PATH, NEVER A URL ───────────────────────────────── */

test("a department whose path is an absolute URL yields no destination", async () => {
  /* The handoff appends this to the app's own origin. Letting a full address
     through would turn the sign-in bridge into an open redirect for anybody
     who can edit a department. */
  const n = seq++;
  const evil = await AccessDepartment.create({
    key: `EVIL_${n}`, slug: `evil-${n}`, name: "Elsewhere", isActive: true,
    dashboardPath: "https://evil.example/steal", externalBaseUrl: COWORK_URL,
  });
  const employee = await employeeHolding([evil]);

  const { status, body } = await sso(employee, { slug: evil.slug });
  expect(status).toBe(200);
  expect(body.redirectPath).toBeNull();
});
