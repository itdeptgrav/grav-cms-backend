// test/industrial-engineering/ppc-companies.route.test.js
//
// PPC COMPANY DISCOVERY — THE ONE ROUTE THAT CANNOT REQUIRE A COMPANY.
//
// `GET /api/cms/ppc/companies` exists so a person who belongs to more than one
// company can choose which queue to open. The claims worth holding:
//
//   · it needs PPC's own read grant, and nothing else opens it — not an IE
//     role, not a Merchandising role, not a platform administrator;
//   · it does NOT need an acting company, because it supplies the choices from
//     which one is picked;
//   · an `X-Costing-Company` header neither narrows nor broadens the answer;
//   · the answer is the actor's own ACTIVE memberships, deduplicated, in stable
//     display-name order;
//   · each row carries exactly `companyId` and `displayName` — a chooser needs
//     a name and an id, not an address, a tax registration or a books date;
//   · and nothing chooses on the caller's behalf.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, ppcBase, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* Mounted in the order `server.js` mounts them — inbound packs first — so a
     request for `/companies` falls through the pack router exactly as it does
     in production rather than in an order only this test creates. */
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/inboundPacksRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/ieReleasesRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  ppcBase = `http://127.0.0.1:${server.address().port}/api/cms/ppc`;
  await SpCompanyMembership.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const ppc = (p, { method = "GET", body, token, company } = {}) =>
  fetch(`${ppcBase}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

async function company(name) {
  const n = ++seq;
  return Acc_Company.create({
    companyName: `${name} ${n}`,
    booksFromDate: new Date("2026-04-01"),
    /* Detail a chooser has no business receiving — asserted absent below. */
    gstin: `27AAAAA${String(n).padStart(4, "0")}A1Z5`,
    address: { line1: "12 Mill Road", city: "Tiruppur", state: "Tamil Nadu", pincode: "641604" },
  });
}

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `co${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `C${n}`, email, biometricId: `CO${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "C",
    });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    employeeId: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: `Person ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const names = (res) => res.body.companies.map((c) => c.displayName);
const ids = (res) => res.body.companies.map((c) => c.companyId);

/* ══ 1. WHO MAY ASK ═══════════════════════════════════════════════════════ */

describe("who may list their companies", () => {
  test("every PPC role can — viewer, approver and owner alike", async () => {
    const co = await company("Shared");
    for (const role of ["viewer", "approver", "owner"]) {
      const person = await actor({ companies: [co], grants: { ppc: role } });
      const res = await ppc("/companies", { token: person.token });
      expect(`${role}:${res.status}`).toBe(`${role}:200`);
      expect(res.body.success).toBe(true);
      expect(ids(res)).toEqual([String(co._id)]);
    }
  });

  test("an IE or Merchandising role, and a platform administrator, reach nothing", async () => {
    const co = await company("Refused");
    const refused = [
      ["ie viewer", await actor({ companies: [co], grants: { ie: "viewer" } })],
      ["ie approver", await actor({ companies: [co], grants: { ie: "approver" } })],
      ["merchandising owner", await actor({ companies: [co], grants: { merchandising: "owner" } })],
      /* `isAdmin` grants nothing: being able to administer the platform is not
         being able to do PPC's work, and `access.service.js` says so. */
      ["platform admin", await actor({ companies: [co], isAdmin: true })],
      ["no grant at all", await actor({ companies: [co] })],
    ];
    for (const [label, person] of refused) {
      const res = await ppc("/companies", { token: person.token });
      expect(`${label}:${res.status}`).toBe(`${label}:403`);
      expect(res.body.companies).toBeUndefined();
    }
  });

  test("authentication is required", async () => {
    const anonymous = await ppc("/companies");
    expect([401, 403]).toContain(anonymous.status);
    expect(anonymous.body.companies).toBeUndefined();

    const forged = await ppc("/companies", { token: "not-a-token" });
    expect([401, 403]).toContain(forged.status);
    expect(forged.body.companies).toBeUndefined();
  });

  test("a revoked PPC grant stops working on the very next request", async () => {
    const co = await company("Revoked");
    const person = await actor({ companies: [co], grants: { ppc: "viewer" } });
    expect((await ppc("/companies", { token: person.token })).status).toBe(200);
    await DepartmentRole.updateMany({ email: person.email }, { $set: { isActive: false } });
    expect((await ppc("/companies", { token: person.token })).status).toBe(403);
  });
});

/* ══ 2. WHAT COMES BACK ═══════════════════════════════════════════════════ */

describe("the list itself", () => {
  test("no acting company is needed, and an arbitrary one changes nothing", async () => {
    /* ── THE WHOLE POINT OF THE ROUTE ──────────────────────────────────
       A person in three companies has no acting company until they pick one,
       and this is what they pick from. Requiring one would answer only the
       people who did not need to ask. */
    const a = await company("Alpha");
    const b = await company("Bravo");
    const c = await company("Charlie");
    const outsider = await company("Zulu");
    const person = await actor({ companies: [a, b, c], grants: { ppc: "viewer" } });

    const bare = await ppc("/companies", { token: person.token });
    expect(bare.status).toBe(200);
    expect(ids(bare).sort()).toEqual([a, b, c].map((x) => String(x._id)).sort());

    /* A header naming one of their own companies must not NARROW the list... */
    const narrowed = await ppc("/companies", { token: person.token, company: b._id });
    expect(narrowed.body).toEqual(bare.body);

    /* ...one naming a company they do not belong to must not BROADEN it... */
    const broadened = await ppc("/companies", { token: person.token, company: outsider._id });
    expect(broadened.status).toBe(200);
    expect(broadened.body).toEqual(bare.body);
    expect(ids(broadened)).not.toContain(String(outsider._id));

    /* ...and a header that is not an id at all must not break it. */
    const rubbish = await ppc("/companies", { token: person.token, company: "not-an-id" });
    expect(rubbish.status).toBe(200);
    expect(rubbish.body).toEqual(bare.body);
  });

  test("several memberships come back in stable display-name order", async () => {
    const zeta = await Acc_Company.create({ companyName: "Zeta Mills", booksFromDate: new Date("2026-04-01") });
    const alpha = await Acc_Company.create({ companyName: "Alpha Mills", booksFromDate: new Date("2026-04-01") });
    const mid = await Acc_Company.create({ companyName: "Mid Mills", booksFromDate: new Date("2026-04-01") });
    /* Created out of order deliberately: insertion order must not be the
       answer, or a selector reshuffles itself between renders. */
    const person = await actor({ companies: [zeta, alpha, mid], grants: { ppc: "approver" } });

    const first = await ppc("/companies", { token: person.token });
    expect(names(first)).toEqual(["Alpha Mills", "Mid Mills", "Zeta Mills"]);
    /* Stable: asked twice, answered the same twice. */
    const second = await ppc("/companies", { token: person.token });
    expect(second.body).toEqual(first.body);
  });

  test("two membership rows reaching one company return one company", async () => {
    const co = await company("Duplicated");
    /* No membership from the helper — this test writes both rows itself, one
       per lookup path. The shared rule matches a membership by EMAIL or by
       EMPLOYEE REFERENCE, so a company reachable down both paths arrives twice
       and must still be offered once. (The two rows are deliberately split:
       `{companyId, email}` and `{companyId, employeeRef}` are each unique and
       sparse, so one row carrying both could not be duplicated at all.) */
    const person = await actor({ grants: { ppc: "viewer" } });
    await SpCompanyMembership.create({
      companyId: co._id, email: person.email, personName: "C",
    });
    await SpCompanyMembership.create({
      companyId: co._id, employeeRef: new mongoose.Types.ObjectId(person.employeeId),
      personName: "C",
    });
    expect(await SpCompanyMembership.countDocuments({ companyId: co._id })).toBe(2);

    const res = await ppc("/companies", { token: person.token });
    expect(res.body.companies).toHaveLength(1);
    expect(ids(res)).toEqual([String(co._id)]);
  });

  test("an inactive membership is not a choice", async () => {
    const live = await Acc_Company.create({ companyName: "Live Mills", booksFromDate: new Date("2026-04-01") });
    const lapsed = await Acc_Company.create({ companyName: "Lapsed Mills", booksFromDate: new Date("2026-04-01") });
    const person = await actor({ companies: [live, lapsed], grants: { ppc: "viewer" } });
    await SpCompanyMembership.updateOne(
      { companyId: lapsed._id, email: person.email }, { $set: { isActive: false } },
    );

    const res = await ppc("/companies", { token: person.token });
    expect(names(res)).toEqual(["Live Mills"]);
    expect(ids(res)).not.toContain(String(lapsed._id));
  });

  test("somebody else's company is absent, and an actor with no membership gets an empty list", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    await actor({ companies: [theirs], grants: { ppc: "owner" } });
    const me = await actor({ companies: [mine], grants: { ppc: "viewer" } });

    const res = await ppc("/companies", { token: me.token });
    expect(ids(res)).toEqual([String(mine._id)]);
    expect(ids(res)).not.toContain(String(theirs._id));

    /* A PPC person who belongs to nothing is answered, not refused — they have
       a grant, they simply have no companies yet, and the two are different
       facts with different fixes. */
    const homeless = await actor({ grants: { ppc: "viewer" } });
    const empty = await ppc("/companies", { token: homeless.token });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ success: true, companies: [] });
  });

  test("a row carries exactly a company id and a display name", async () => {
    const co = await company("Minimal");
    const person = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const res = await ppc("/companies", { token: person.token });

    expect(Object.keys(res.body).sort()).toEqual(["companies", "success"]);
    for (const row of res.body.companies) {
      expect(Object.keys(row).sort()).toEqual(["companyId", "displayName"]);
      expect(row.companyId).toMatch(/^[0-9a-f]{24}$/);
      expect(row.displayName).toBe(co.companyName);
    }

    /* ── AND NOTHING OF THE COMPANY RECORD ITSELF ──────────────────────
       Checked recursively and by value: the fixture company carries a tax
       registration, an address and a books date, and none of them is a thing a
       chooser needs. */
    const keys = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) { keys.push(k); walk(v); }
    };
    walk(res.body);
    for (const forbidden of [
      "gstin", "pan", "tan", "cin", "taxRegistration", "address", "line1", "city",
      "state", "pincode", "booksFromDate", "financialYear", "currency", "configuration",
      "settings", "logo", "email", "phone", "isActive", "membership", "membershipSource",
      "employeeRef", "personName", "role", "_id", "__v", "createdAt", "updatedAt",
    ]) expect(keys).not.toContain(forbidden);

    const stored = await Acc_Company.findById(co._id).lean();
    expect(JSON.stringify(res.body)).not.toContain(String(stored.gstin));
    expect(JSON.stringify(res.body)).not.toContain("Mill Road");
  });
});

/* ══ 3. THE ROUTE'S OWN SHAPE ═════════════════════════════════════════════ */

describe("how the route is wired", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "routes", "CMS_Routes", "PPC", "ieReleasesRoute.js"), "utf8",
  );
  /* Just the `/companies` registration — the file legitimately uses
     `requireCompany` on the four routes beside it. */
  const block = source.slice(
    source.indexOf('router.get("/companies"'),
    source.indexOf('router.get("/ie-releases"'),
  );

  test("it reuses the shared membership rule and resolves no acting company", () => {
    expect(block).toContain("listMembershipCompanies(req.user)");
    expect(block).toContain("canRead");
    /* The two things that would make it answerable only to somebody who
       already knew the answer. */
    expect(block).not.toContain("requireCompany");
    expect(block).not.toContain("resolveCompanyForActor");
    expect(block).not.toMatch(/req\.merchandising/);
    /* No company accepted from the caller, and none chosen for them. */
    expect(block).not.toMatch(/req\.(body|query|params)/);
    expect(block).not.toMatch(/X-Costing-Company/i);
    expect(block).not.toMatch(/companies\[0\]|\.shift\(\)|\bfirst\b/);

    /* The rule is reused, not copied: no membership or company query lives in
       this router, and no IE or Merchandising service is imported for it. */
    expect(source).not.toContain("SpCompanyMembership");
    expect(source).not.toContain("Acc_Company");
    expect(source).not.toMatch(/require\([^)]*services\/(industrialEngineering|merchandising)[^)]*\)/);
    expect(source).not.toContain("resolveCompanyForActor");
  });

  test("it is registered ahead of every route that requires an acting company", () => {
    const at = (needle) => source.indexOf(needle);
    expect(at('router.get("/companies"')).toBeGreaterThan(-1);
    for (const later of [
      'router.get("/ie-releases"',
      'router.get("/ie-releases/:releaseId"',
      'router.post("/ie-releases/:releaseId/accept"',
      'router.post("/ie-releases/:releaseId/clarify"',
    ]) expect(at('router.get("/companies"')).toBeLessThan(at(later));
  });
});

/* ══ 4. THE NEIGHBOURS ════════════════════════════════════════════════════ */

describe("the routes beside it are unchanged", () => {
  test("the IE-release and inbound-pack routes still resolve a company, and still guard it", async () => {
    const co = await company("Neighbours");
    const viewer = await actor({ companies: [co], grants: { ppc: "viewer" } });
    const approver = await actor({ companies: [co], grants: { ppc: "approver" } });
    const outsider = await actor({ companies: [co], grants: { ie: "approver" } });

    /* Company discovery does not leak its company-free posture sideways: these
       still resolve an acting company, and still answer normally with one. */
    for (const p of ["/ie-releases", "/inbound-packs"]) {
      const withCompany = await ppc(p, { token: viewer.token, company: co._id });
      expect(`${p}:${withCompany.status}`).toBe(`${p}:200`);
      expect(withCompany.body.rows).toEqual([]);

      const refusedRole = await ppc(p, { token: outsider.token, company: co._id });
      expect(`${p}:${refusedRole.status}`).toBe(`${p}:403`);
    }

    /* Deciding still needs the approver grant and still refuses the viewer. */
    const denied = await ppc(`/ie-releases/${new mongoose.Types.ObjectId()}/accept`, {
      method: "POST", token: viewer.token, company: co._id, body: {},
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN");

    /* And an approver still gets the release routes' own typed not-found. */
    const missing = await ppc(`/ie-releases/${new mongoose.Types.ObjectId()}`, {
      token: approver.token, company: co._id,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
  });
});
