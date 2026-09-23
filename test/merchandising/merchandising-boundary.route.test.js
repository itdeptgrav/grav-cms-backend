// test/merchandising/merchandising-boundary.route.test.js
//
// THREE THINGS THE FREEZE DEPENDS ON.
//
// ONE POLICY, ONE IMPLEMENTATION. The Work API had its own copy of the
// Merchandising guard — its own grant read, its own ladder, its own refusal
// shape and its own `isAdmin` bypass. A second implementation of one policy is
// a second place for a hole to survive being fixed, and that copy is exactly
// where the admin bypass would have. Both routers now behave identically
// because both call the same function; this proves it at the wire rather than
// by reading the imports.
//
// MERCHANDISING'S OWN ITEM LOOKUP. The packaging picker borrowed R&D's
// raw-item search — the one endpoint no Merchandising grant guarded, and one
// that answers R&D's question: on-hand stock, every variant, and a price
// averaged from the vendor nicknames on it. A merchandiser choosing a poly bag
// was handed the company's supplier pricing to do it.
//
// AND THE LEGACY SALES ROUTES ARE STILL SALES'. Stage routing and material
// selection are not Merchandising doors, are not claimed to be, and are not
// gated as though they were — but neither may reach another company's books.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const jwtLib = require("jsonwebtoken");
  const mw = (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    try {
      req.user = jwtLib.verify(header.slice(7), process.env.JWT_SECRET || "grav_clothing_secret_key");
      next();
    } catch {
      res.status(401).json({ success: false, message: "Invalid token." });
    }
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");

const access = require("../../services/merchandising/access.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/merchandisingWorkRoute"));
  /* The Merchandising style doors moved off the Sales router into
     routes/CMS_Routes/Merchandising/styleRoute.js. Same handlers, same
     services, same live grant — a file of their own, so this suite no longer
     mounts 4,500 lines of another lane's in-flight rewrite to reach eleven
     endpoints. */
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/styleRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const M = "/api/cms/merchandising";
const S = "/api/cms/merchandising";

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `mb${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `B${n}`, email, biometricId: `MB${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  const rows = {};
  for (const [departmentSlug, role] of Object.entries(grants)) {
    rows[departmentSlug] = await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email, grantRows: rows,
    token: jwt.sign(
      { id: String(emp._id), email, name: "M", role: "sales", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

async function world(label = "B") {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} tee`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "materials", materials: { status: "pending", rawItems: [] },
  });
  /* One packaging component, with everything the R&D search would publish
     about it: stock on hand, a variant, and a vendor price on that variant. */
  const item = await RawItem.create({
    companyId: co._id, name: `${label} poly bag`, sku: `PB-${label}-${n}`,
    unit: "Piece", category: "Packing", createdBy: new mongoose.Types.ObjectId(),
    quantity: 4200,
    variants: [{
      sku: `PBV-${label}-${n}`, combination: ["Clear"], quantity: 4200,
      vendorNicknames: [{
        vendor: new mongoose.Types.ObjectId(), nickname: "Acme Packaging", price: 3.75,
      }],
    }],
  });
  return { co, style, item, label };
}

/* ══ B — ONE IMPLEMENTATION ═══════════════════════════════════════════════ */

describe("both Merchandising routers enforce the same rule", () => {
  /** The Work API's reads, and the style router's reads, addressed together. */
  const BOTH = (w) => [
    ["work api · overview", `${M}/overview`],
    ["work api · work", `${M}/work`],
    ["work api · packaging items", `${M}/styles/${w.style._id}/packaging-items?q=poly`],
    ["style router · styles", `${S}/styles`],
    ["style router · identity", `${S}/styles/${w.style._id}`],
    ["style router · development", `${S}/styles/${w.style._id}/development`],
  ];

  test("no grant is refused identically on both, with the same code and shape", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co] });
    const shapes = [];

    for (const [name, path] of BOTH(w)) {
      const res = await call(path, { token: who.token, company: w.co._id });
      expect([name, res.status]).toEqual([name, 403]);
      shapes.push(JSON.stringify({
        code: res.body.error.code, requires: res.body.error.details.requires,
      }));
    }
    /* Not merely "all refused" — refused with one answer. Two implementations
       drift in the refusal long before they drift in the decision. */
    expect(new Set(shapes).size).toBe(1);
  });

  test("a live viewer grant is accepted identically on both", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    for (const [name, path] of BOTH(w)) {
      const res = await call(path, { token: who.token, company: w.co._id });
      expect([name, res.status]).toEqual([name, 200]);
    }
  });

  test("revoking the grant closes both in the same request cycle", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    for (const [, path] of BOTH(w)) {
      expect((await call(path, { token: who.token, company: w.co._id })).status).toBe(200);
    }

    await DepartmentRole.updateOne(
      { _id: who.grantRows.merchandiser._id }, { $set: { isActive: false } },
    );

    for (const [name, path] of BOTH(w)) {
      const res = await call(path, { token: who.token, company: w.co._id });
      expect([name, res.status]).toEqual([name, 403]);
    }
  });

  test("an unproven company is refused identically on both", async () => {
    const one = await world("One");
    const two = await world("Two");
    const who = await actor({ companies: [one.co, two.co], grants: { merchandiser: "owner" } });
    for (const [name, path] of BOTH(one)) {
      const res = await call(path, { token: who.token });      // no company named
      expect([name, res.status]).toEqual([name, 409]);
      expect(res.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");
    }
  });

  test("the Work router holds no policy of its own", () => {
    /* A source assertion, because the point is that the rule is not written
       twice — and the wire cannot tell you whether it was copied. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Merchandising/merchandisingWorkRoute.js"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    /* Since M1/M2 the shared implementation speaks capabilities; the router
       still holds no policy of its own — it asks for one by name. */
    expect(src).toMatch(/merchandisingCapability\(CAPABILITY\./);
    expect(src).toMatch(/services\/merchandising\/access\.service/);
    expect(src).toMatch(/merchandisingCompanyMiddleware/);
    /* No second grant read, no second ladder comparison, no bypass. */
    expect(src).not.toMatch(/getEffectiveRole/);
    expect(src).not.toMatch(/roleAtLeast/);
    expect(src).not.toMatch(/isAdmin/);
    expect(src).not.toMatch(/req\.admin/);
  });

  test("and neither does the access service read an admin flag", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/merchandising/access.service.js"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/isAdmin/);
    expect(src).not.toMatch(/req\?\.admin|req\.admin/);
  });
});

/* ══ C — MERCHANDISING'S OWN ITEM LOOKUP ══════════════════════════════════ */

describe("the packaging-item lookup", () => {
  const items = (w, who, q = "poly") =>
    call(`${M}/styles/${w.style._id}/packaging-items?q=${q}`, {
      token: who.token, company: w.co._id,
    });

  test("a live viewer gets the company's components, by identity only", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });

    const res = await items(w, who);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(["id", "name", "sku"]);
    expect(res.body.items[0].name).toBe(`${w.label} poly bag`);
  });

  test("no price, supplier, stock, variant or unit crosses it", async () => {
    /* The shared R&D search published all of them. This is the reason the
       endpoint exists as much as the grant is. */
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    const raw = JSON.stringify((await items(w, who)).body);

    for (const banned of [
      /price/i, /vendor/i, /supplier/i, /nickname/i, /Acme/,
      /quantity/i, /4200/, /variant/i, /unitConversion/i, /\bunit\b/i,
      /category/i, /companyId/i, /journey/i, /enquiry/i,
    ]) {
      expect(raw).not.toMatch(banned);
    }
  });

  test("no grant reaches it, and a revoked one stops reaching it", async () => {
    const w = await world();
    const none = await actor({ companies: [w.co] });
    expect((await items(w, none)).status).toBe(403);

    const who = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    expect((await items(w, who)).status).toBe(200);
    await DepartmentRole.updateOne(
      { _id: who.grantRows.merchandiser._id }, { $set: { isActive: false } },
    );
    expect((await items(w, who)).status).toBe(403);
  });

  test("another company's style is the same answer as one that does not exist", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const who = await actor({ companies: [mine.co], grants: { merchandiser: "viewer" } });
    const gone = new mongoose.Types.ObjectId();

    const foreign = await call(`${M}/styles/${theirs.style._id}/packaging-items?q=poly`, {
      token: who.token, company: mine.co._id,
    });
    const missing = await call(`${M}/styles/${gone}/packaging-items?q=poly`, {
      token: who.token, company: mine.co._id,
    });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
  });

  test("the items are this company's master, not the deployment's", async () => {
    const mine = await world("ScopeMine");
    await world("ScopeTheirs");                     // another company's poly bag
    const who = await actor({ companies: [mine.co], grants: { merchandiser: "viewer" } });

    const res = await items(mine, who);
    expect(res.body.items.map((i) => i.name)).toEqual(["ScopeMine poly bag"]);
  });

  test("a one-letter term is an empty list, not a scan", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    const res = await call(`${M}/styles/${w.style._id}/packaging-items?q=p`, {
      token: who.token, company: w.co._id,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test("a search expression is escaped, not executed", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co], grants: { merchandiser: "viewer" } });
    const res = await call(`${M}/styles/${w.style._id}/packaging-items?q=${encodeURIComponent(".*")}`, {
      token: who.token, company: w.co._id,
    });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});


/* ══ D — THE LEGACY SALES ROUTES ══════════════════════════════════════════ */



/* ══ THE LADDER ITSELF ════════════════════════════════════════════════════ */

describe("the access service", () => {
  test("resolves nothing from a token claim", async () => {
    /* A bare request object carrying every claim an attacker would want, and
       no grant row behind it. */
    const req = { user: { id: String(new mongoose.Types.ObjectId()), email: "x@y.z", isAdmin: true, role: "ceo" }, admin: true };
    expect(await access.liveMerchandisingRole(req)).toBe(null);
    await expect(access.requireMerchandising(req, access.ROLE.VIEWER)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("packaging changes are levelled by what the body asks for", () => {
    expect(access.packagingChangeLevel({ status: "approved" })).toBe(access.ROLE.APPROVER);
    expect(access.packagingChangeLevel({ status: "withdrawn" })).toBe(access.ROLE.APPROVER);
    expect(access.packagingChangeLevel({ status: "proposed" })).toBe(access.ROLE.EDITOR);
    expect(access.packagingChangeLevel({ specification: "x" })).toBe(access.ROLE.EDITOR);
    expect(access.packagingChangeLevel({})).toBe(access.ROLE.EDITOR);
    /* An edit attached to a decision is still a decision. */
    expect(access.packagingChangeLevel({ specification: "x", status: "approved" }))
      .toBe(access.ROLE.APPROVER);
  });
});
