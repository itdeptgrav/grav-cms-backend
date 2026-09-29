// test/accountant/company-ownership-sync-legacy.route.test.js
//
// THE ONE PRODUCTION PATH THAT ASSIGNS COMPANY OWNERSHIP.
//
// `POST /accountant/auth/sync-legacy` upgrades a legacy CMS session into an
// organisation-aware one, and on the way it attaches companies to the
// organisation it lands on. It used to do that by assignment:
//
//     org.tallyCompanyIds = companies.map((c) => c._id);
//
// — every company in the database, to whichever organisation got there first,
// with no check that another organisation already held them. In a
// single-organisation deployment that is invisible. The moment a second
// organisation exists, a login seizes the first one's books.
//
// These tests drive the real route.
"use strict";

process.env.JWT_SECRET = "test_secret_for_ownership_sync_legacy";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

const {
  Acc_Organization,
  Acc_User,
} = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Acc_Department = require("../../models/Accountant_model/Acc_Department");

let server;
let origin;
let warnSpy;
let seq = 0;

beforeAll(async () => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  await Acc_Organization.init(); // the ownership index must exist before we start

  const app = express();
  app.use(express.json());
  app.use("/api/accountant/auth", require("../../routes/Accountant_Routes/Acc_auth"));
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  warnSpy.mockRestore();
  await new Promise((r) => server.close(r));
});

async function syncLegacy(token) {
  const res = await fetch(`${origin}/api/accountant/auth/sync-legacy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `auth_token=${token}` },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function legacyToken(claims = {}) {
  return jwt.sign(
    { id: new mongoose.Types.ObjectId().toString(), role: "accountant", ...claims },
    SECRET,
    { expiresIn: "24h" },
  );
}

async function makeDepartment(overrides = {}) {
  return Acc_Department.create({
    email: `accountant${++seq}@example.com`,
    password: "dept-password",
    name: `Accountant ${seq}`,
    employeeId: `ACC-${seq}`,
    phone: "9999999999",
    ...overrides,
  });
}

async function makeCompany() {
  return Acc_Company.create({
    companyName: `Co ${++seq}`,
    booksFromDate: new Date("2025-04-01"),
  });
}

const tokenFor = (dept) =>
  legacyToken({ id: dept._id.toString(), role: "admin", email: dept.email, name: dept.name });

const idsOf = async (orgId) =>
  ((await Acc_Organization.findById(orgId).lean())?.tallyCompanyIds || []).map(String);

/* ================================================================== */

/* GAC-2 correction (25 Sep 2026): the branch these tests used to drive — a
   legacy Accounting account with no Acc_User being auto-promoted to OWNER,
   with a new organisation and every company attached — is RETIRED. It was an
   access grant outside the canonical write. The route now refuses that case
   (403 ACCOUNTING_GRANT_REQUIRED) and attaches no company at all, so the
   seize risk these tests guarded against cannot arise from this route any
   more. What is pinned now: nothing is created or attached, and an upgrade
   of an EXISTING role holder leaves company ownership exactly as it was. */
describe("sync-legacy no longer promotes, creates or attaches", () => {
  test("a legacy account with no Accounting role is refused; no organisation, no company attached", async () => {
    const a = await makeCompany();
    const dept = await makeDepartment({ role: "admin" });

    const res = await syncLegacy(tokenFor(dept));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNTING_GRANT_REQUIRED");
    expect(await Acc_Organization.countDocuments()).toBe(0);
    expect(await Acc_User.countDocuments()).toBe(0);
    expect(await Acc_Organization.countDocuments({ tallyCompanyIds: a._id })).toBe(0);
  });

  test("upgrading an existing role holder leaves every organisation's companies untouched", async () => {
    const contested = await makeCompany();
    await makeCompany(); // unowned — must stay unowned
    const landing = await Acc_Organization.create({ name: `Landing ${++seq}`, tallyCompanyIds: [] });
    const incumbent = await Acc_Organization.create({ name: `Incumbent ${++seq}`, tallyCompanyIds: [contested._id] });
    const dept = await makeDepartment({ role: "admin" });
    const holder = new Acc_User({ organizationId: landing._id, name: dept.name, email: dept.email, role: "editor" });
    await holder.setPassword("a-long-enough-password");
    await holder.save();

    const res = await syncLegacy(tokenFor(dept));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await idsOf(landing._id)).toEqual([]);
    expect(await idsOf(incumbent._id)).toEqual([String(contested._id)]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(String(incumbent._id));
    expect(body).not.toContain(incumbent.name);
  });
});

describe("existing sync-legacy behaviour is preserved", () => {
  test("a CMS user outside the Accounting roster is still refused", async () => {
    await makeCompany();
    const res = await syncLegacy(
      legacyToken({ role: "employee", email: "logistics@example.com" }),
    );
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test("a deactivated department user is still refused", async () => {
    const dept = await makeDepartment({ role: "admin", isActive: false });
    const res = await syncLegacy(tokenFor(dept));
    expect(res.status).toBe(403);
  });

  test("no session at all is still a 401", async () => {
    const res = await fetch(`${origin}/api/accountant/auth/sync-legacy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
