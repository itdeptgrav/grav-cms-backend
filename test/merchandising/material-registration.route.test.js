// test/merchandising/material-registration.route.test.js
//
// A MERCHANDISER MAY NAME A MATERIAL STORE HAS NOT GOT — AND NOTHING MORE.
//
// The catalogue picker could already find what Store stocks. What it could not
// do was answer the commonest case on a development file: the buyer specified
// a lining nobody has bought yet, so it is not in the catalogue, so the row
// holds a merchandiser's spelling and R&D guesses. This registers it.
//
// The whole question is whether the door stays narrow. Eight claims:
//
//   1  THE FLOW COMPLETES. Register, and the item comes back in the same shape
//      a search result has — selectable immediately, with no variant question
//      to answer — and a BOM row then references it by id.
//
//   2  IT IS MERCHANDISING'S GRANT. `selection.write` opens it; reading a file
//      does not; and no Store capability is required or consulted.
//
//   3  IT IS NARROW, AND REFUSES RATHER THAN DROPS. Stock, re-order levels,
//      discounts, variants, attributes, conversions and suppliers are all
//      refused by name, and nothing is saved. A caller is never told "created"
//      about a field that was thrown away.
//
//   4  IT DOES NOT CREATE STORE CONFIGURATION. A category Store does not have
//      and a unit this company has not defined are both refused. There is no
//      `customCategory`/`customUnit` back door.
//
//   5  OWNERSHIP IS THE SESSION'S. A payload naming another company is
//      ignored, not merged, and the item lands in the caller's company.
//
//   6  THE SAME MATERIAL IS NOT REGISTERED TWICE. Detection is on the master
//      identity, not the minted SKU — which carries a random tail and would
//      let the same yarn in four times — and it is company-scoped, so it never
//      answers what somebody else stocks.
//
//   7  THE ANSWER IS IDENTITY ONLY. Asserted on the JSON text, so a field
//      added to RawItem tomorrow cannot arrive quietly.
//
//   8  THE CATALOGUE IS STILL NOT COMPULSORY. Describing an unregistered
//      material in the merchandiser's own words still works, unchanged.
//
// And the reason the item exists is on the record: an audit row in
// Merchandising's own history, naming the actor, the company, the development
// file, the screen and the Store item created.
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
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

let server, base, salesBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "material_registration" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/developmentRoute"));
  app.use("/api/cms/sales/development-requests", require("../../routes/CMS_Routes/Sales/developmentRequests"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales/development-requests`;
  await RawItem.syncIndexes();
  await DevelopmentFile.syncIndexes();
  await DevelopmentBomRevision.syncIndexes();
}, 120000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const req = (root) => (p, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${root}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  });

const call = (p, o) => req(base)(p, o);
const sales = (p, o) => req(salesBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `reg-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "R", lastName: `Eg${n}`, email, biometricId: `RG${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    id: String(emp._id),
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

/** A company with its own unit master — without units nothing can be registered. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Reg ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await Unit.create([
    { companyId: co._id, name: "Metre", status: "Active" },
    { companyId: co._id, name: "Piece", status: "Active" },
    { companyId: co._id, name: "Retired roll", status: "Inactive" },
  ]);
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-R-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-R-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `Tee ${n}`, quantity: 500 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  return { co, journey, enquiry, productLineRef: String(saved.products[0].productLineRef) };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    sales: await actor({ companies: [co], grants: { sales: "approver" } }),
  };
}

async function draftOn(w, c) {
  const asked = await sales(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
    ...at(w, c.sales), method: "POST",
    body: {
      requirementSummary: "Lightweight running tee — mesh body, reflective trim, transfer labels.",
      requestedCategories: ["FABRIC", "TRIMS", "LABELS"],
      requiredByDate: "2026-10-15",
    },
  });
  if (asked.status >= 400) throw new Error(`Sales could not ask: ${asked.text}`);
  const file = await DevelopmentFile.findOne({
    companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef,
  }).lean();
  await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
  await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
  return file;
}

const draftOf = (w, file) => DevelopmentBomRevision.findOne({
  companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
}).lean();

/** The drawer's request, with sensible defaults a test can override. */
const registerBody = (file, over = {}) => ({
  fileId: String(file._id),
  name: over.name !== undefined ? over.name : `Bamboo jersey ${++seq}`,
  category: over.category !== undefined ? over.category : "Fabric",
  unit: over.unit !== undefined ? over.unit : "Metre",
  ...over.extra,
});

/* Registering creates something, so it takes an idempotency key like every
   other creating command on this router — a fresh one per call here, because
   each of these tests is a distinct request rather than a retry. The retry and
   race behaviour has its own suite. */
const register = (w, c, file, over = {}, who = "editor") => call("/catalogue/materials", {
  ...at(w, c[who]), method: "POST", key: over.key || uniq(), body: registerBody(file, over),
});

/* ══ 1 — THE FLOW COMPLETES ══════════════════════════════════════════════ */

describe("register, select, add to the BOM", () => {
  test("the created item comes back in the same shape a search result has", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { name: "Bamboo jersey 180" });
    expect(res.status).toBe(201);

    const search = await call("/catalogue/materials?q=Bamboo", at(w, c.editor));
    const fromSearch = search.body.rows.find((r) => r.name === "Bamboo jersey 180");
    expect(fromSearch).toBeTruthy();
    /* Field for field the same row, so the drawer selects it with the code it
       already has rather than a second, nearly identical path. */
    expect(Object.keys(res.body.item).sort()).toEqual(Object.keys(fromSearch).sort());
    expect(res.body.item).toEqual(fromSearch);
  });

  test("it is selectable at once — there is no variant to choose", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file);
    expect(res.body.item.variantChoice).toBe("none");
    expect(res.body.item.variants).toEqual([]);
    expect(res.body.item.variantCount).toBe(0);
  });

  test("a BOM row then references it by id, and the server writes its name", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const made = await register(w, c, file, { name: "Recycled ribbed cuffing" });
    const draft = await draftOf(w, file);

    const row = await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        expectedRevision: draft.revision,
        category: "FABRIC",
        rawItemId: made.body.item.rawItemId,
        /* A client insisting on its own words is not obeyed. */
        rawItemName: "WHATEVER THE DRAWER FELT LIKE",
        placement: "Cuffs and collar",
      },
    });
    expect(row.status).toBe(201);

    const after = await draftOf(w, file);
    expect(after.rows).toHaveLength(1);
    expect(String(after.rows[0].rawItemId)).toBe(made.body.item.rawItemId);
    expect(after.rows[0].rawItemName).toBe("Recycled ribbed cuffing");
    expect(after.rows[0].variantId).toBeNull();
  });

  test("the item is created empty, and is Store's to stock", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const made = await register(w, c, file);
    const stored = await RawItem.findById(made.body.item.rawItemId).lean();
    expect(stored.quantity).toBe(0);
    expect(stored.minStock).toBe(0);
    expect(stored.maxStock).toBe(0);
    expect(stored.discounts).toEqual([]);
    expect(stored.variants).toEqual([]);
    expect(stored.stockTransactions || []).toEqual([]);
  });

  test("the classification is derived from the category, so the picker can see it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const fabric = await register(w, c, file, { category: "Fabric" });
    expect(fabric.body.item.usedAs).toBe("FABRIC");
    const zip = await register(w, c, file, { category: "Zippers", unit: "Piece" });
    expect(zip.body.item.usedAs).toBe("TRIM");
  });

  test("a classification a garment's BOM cannot hold is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { extra: { usedAs: "MACHINE_SPARE" } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("usedAs");
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ 2 — IT IS MERCHANDISING'S GRANT ═════════════════════════════════════ */

describe("who may register a material", () => {
  test("a viewer may read a file and may not register anything", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, {}, "viewer");
    expect(res.status).toBe(403);
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("selecting materials is what opens it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    expect((await register(w, c, file, {}, "editor")).status).toBe(201);
    expect((await register(w, c, file, {}, "approver")).status).toBe(201);
  });

  test("no Store grant is held, and none is needed", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    /* The cast holds `merchandiser` roles only — no SpCompanyMembership
       capability grant, no `sp.master.maintain`. */
    expect((await register(w, c, file)).status).toBe(201);
  });

  test("a development file from another company answers as one that is not there", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const them = await cast(theirs.co);
    await draftOn(mine, c);
    const foreign = await draftOn(theirs, them);

    const res = await call("/catalogue/materials", {
      ...at(mine, c.editor), method: "POST", key: uniq(),
      body: { fileId: String(foreign._id), name: "Probe", category: "Fabric", unit: "Metre" },
    });
    expect(res.status).toBe(404);
    expect(await RawItem.countDocuments({ companyId: mine.co._id })).toBe(0);
  });
});

/* ══ 3 — NARROW, AND REFUSED RATHER THAN DROPPED ═════════════════════════ */

describe("what this door will not accept", () => {
  const smuggled = [
    ["opening stock", { quantity: 400 }],
    ["a re-order level", { minStock: 100 }],
    ["an upper level", { maxStock: 2000 }],
    ["a quantity discount", { discounts: [{ minQuantity: 500, price: 182.5 }] }],
    ["an attribute structure", { attributes: [{ name: "GSM", values: ["135"] }] }],
    ["variants", { variants: [{ combination: ["Slate"], sku: "X-SL" }] }],
    ["a supplier", { primaryVendor: "6512c1e0f1a2b3c4d5e6f701" }],
    ["a purchase price", { supplierPrice: 182.5 }],
    ["a lead time", { leadTimeDays: 21 }],
    ["a supplier alias with its price", {
      variants: [{ combination: ["Slate"], vendorNicknames: [{ vendor: "6512c1e0f1a2b3c4d5e6f701", nickname: "M-135", price: 182.5 }] }],
    }],
    ["a conversion factor", { unitConversions: [{ toUnit: "Piece", quantity: 4 }] }],
  ];

  test.each(smuggled)("%s is refused, and nothing is saved", async (_label, extra) => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { extra });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the refusal names the field, so the caller can act on it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { extra: { minStock: 100, discounts: [{ minQuantity: 5, price: 1 }] } });
    expect(res.body.error.details.fields).toEqual(expect.arrayContaining(["minStock", "discounts"]));
    expect(res.body.message).toContain("Store");
  });

  test("a field is never silently dropped — a refusal or the field, never neither", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { extra: { minStock: 250 } });
    /* Had this been dropped instead, the caller would hold a 201 and believe
       a re-order level of 250 was recorded. */
    expect(res.status).toBe(403);
  });
});

/* ══ 4 — IT DOES NOT CREATE STORE CONFIGURATION ══════════════════════════ */

describe("categories and units stay Store's", () => {
  test("a category Store does not have is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { category: "Unobtainium" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("CATEGORY_NOT_IN_STORE");
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a unit this company has not defined is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, { unit: "Furlong" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("UNIT_NOT_IN_COMPANY");
  });

  test("an inactive unit is not one this company has", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    expect((await register(w, c, file, { unit: "Retired roll" })).status).toBe(400);
  });

  test("another company's unit is not one this company has", async () => {
    const mine = await world();
    const theirs = await world();
    await Unit.create({ companyId: theirs.co._id, name: "Their bolt", status: "Active" });
    const c = await cast(mine.co);
    const file = await draftOn(mine, c);

    expect((await register(mine, c, file, { unit: "Their bolt" })).status).toBe(400);
  });

  test("there is no customCategory or customUnit back door", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    for (const extra of [{ customCategory: "Unobtainium" }, { customUnit: "Furlong" }]) {
      const res = await register(w, c, file, { extra });
      expect(res.status).toBe(403);
      expect(res.body.error.details.reason).toBe("STORE_CONFIGURATION_NOT_PERMITTED_HERE");
    }
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the form is offered Store's shelves, this company's units, and BOM classifications only", async () => {
    const w = await world();
    const c = await cast(w.co);
    await RawItem.create({ companyId: w.co._id, name: "Odd", sku: `ODD-${++seq}`, customCategory: "Reflectives" });

    const res = await call("/catalogue/registration-options", at(w, c.editor));
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(expect.arrayContaining([
      { name: "Fabric", source: "standard" },
      { name: "Reflectives", source: "company" },
    ]));
    expect(res.body.units).toEqual([{ name: "Metre" }, { name: "Piece" }]);
    expect(res.body.usedAs.map((u) => u.value)).toEqual(
      ["FABRIC", "TRIM", "LABEL", "GARMENT_ACCESSORY", "SAMPLE_PACKAGING"],
    );
  });
});

/* ══ 5 — OWNERSHIP IS THE SESSION'S ══════════════════════════════════════ */

describe("company ownership and actor identity", () => {
  test("a payload naming another company is ignored, not merged", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const file = await draftOn(mine, c);

    const res = await register(mine, c, file, {
      name: "Claimed elsewhere",
      extra: { companyId: String(theirs.co._id), siteId: String(new mongoose.Types.ObjectId()) },
    });
    expect(res.status).toBe(201);

    const stored = await RawItem.findById(res.body.item.rawItemId).lean();
    expect(String(stored.companyId)).toBe(String(mine.co._id));
    expect(await RawItem.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("createdBy is the session's actor, not the payload's", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file, {
      extra: { createdBy: String(new mongoose.Types.ObjectId()) },
    });
    const stored = await RawItem.findById(res.body.item.rawItemId).lean();
    expect(String(stored.createdBy)).toBe(c.editor.id);
  });

  test("the other company never sees it", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const them = await cast(theirs.co);
    const file = await draftOn(mine, c);
    await register(mine, c, file, { name: "Only ours" });

    const res = await call("/catalogue/materials?q=Only", at(theirs, them.editor));
    expect(res.body.rows).toHaveLength(0);
    expect(res.text).not.toContain("Only ours");
  });
});

/* ══ 6 — THE SAME MATERIAL IS NOT REGISTERED TWICE ═══════════════════════ */

describe("duplicate detection", () => {
  test("the same material twice is refused, and the existing one is handed back", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const first = await register(w, c, file, { name: "Poly mesh 135" });
    expect(first.status).toBe(201);

    const again = await register(w, c, file, { name: "Poly mesh 135" });
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe("RAW_ITEM_ALREADY_REGISTERED");
    expect(again.body.error.details.existing._id).toBe(first.body.item.rawItemId);
    expect(again.body.error.details.existing.name).toBe("Poly mesh 135");
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("case, spacing and punctuation are not a different material", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    await register(w, c, file, { name: "Poly mesh 135" });

    for (const name of ["poly mesh 135", "POLY  MESH  135", "Poly-mesh 135"]) {
      const res = await register(w, c, file, { name });
      expect(res.status).toBe(409);
    }
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("detection is not on the minted SKU, which carries a random tail", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const first = await register(w, c, file, { name: "Poly mesh 135" });
    const stored = await RawItem.findById(first.body.item.rawItemId).lean();
    /* Two registrations a second apart would mint two different codes, so a
       SKU check would have let the second one through. */
    const again = await register(w, c, file, { name: "Poly mesh 135" });
    expect(again.status).toBe(409);
    expect(stored.sku).toMatch(/^RAW-FAB-POLMES135-\d{3}$/);
  });

  test("the same name in a different unit is a different material", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    expect((await register(w, c, file, { name: "Cord", unit: "Metre" })).status).toBe(201);
    expect((await register(w, c, file, { name: "Cord", unit: "Piece" })).status).toBe(201);
  });

  test("it never answers what another company stocks", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const them = await cast(theirs.co);
    const file = await draftOn(mine, c);
    const foreignFile = await draftOn(theirs, them);
    await register(theirs, them, foreignFile, { name: "Shared name" });

    /* Registers cleanly here. Had the check reached across the boundary, the
       refusal itself would have disclosed the other company's catalogue. */
    const res = await register(mine, c, file, { name: "Shared name" });
    expect(res.status).toBe(201);
  });
});

/* ══ 7 — THE ANSWER IS IDENTITY ONLY ═════════════════════════════════════ */

describe("what comes back", () => {
  test("no balance, no level, no vendor, no price, no discount, no ledger", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const res = await register(w, c, file);
    for (const leak of [
      "quantity", "minStock", "maxStock", "primaryVendor", "alternateVendors",
      "vendorNicknames", "discounts", "price", "budgetLedgerName",
      "stockTransactions", "supplierCode", "leadTimeDays",
    ]) {
      expect(res.text).not.toContain(leak);
    }
  });

  test("the duplicate refusal discloses identity and nothing else", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const first = await register(w, c, file, { name: "Poly mesh 135" });
    /* Store then stocks it and prices it, as Store does. */
    await RawItem.updateOne({ _id: first.body.item.rawItemId }, {
      $set: {
        quantity: 420, minStock: 100, discounts: [{ minQuantity: 500, price: 182.5 }],
        primaryVendor: new mongoose.Types.ObjectId(), budgetLedgerName: "Fabric purchases",
      },
    });

    const again = await register(w, c, file, { name: "Poly mesh 135" });
    expect(again.status).toBe(409);
    for (const leak of ["420", "182.5", "primaryVendor", "budgetLedgerName", "discounts"]) {
      expect(again.text).not.toContain(leak);
    }
  });
});

/* ══ 8 — THE CATALOGUE IS STILL NOT COMPULSORY ═══════════════════════════ */

describe("describing an unregistered material still works", () => {
  test("a row in the merchandiser's own words is unchanged", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const draft = await draftOf(w, file);

    const res = await call(`/development/${file._id}/bom/rows`, {
      ...at(w, c.editor), method: "POST",
      body: {
        expectedRevision: draft.revision,
        category: "TRIM",
        rawItemName: "Reflective tape, buyer's nominated supplier",
        rawItemSku: "buyer ref RT-12",
        selectionNote: "Not in our catalogue yet.",
        placement: "Back yoke",
      },
    });
    expect(res.status).toBe(201);

    const after = await draftOf(w, file);
    expect(after.rows[0].rawItemId).toBeNull();
    expect(after.rows[0].rawItemName).toBe("Reflective tape, buyer's nominated supplier");
    /* And registering was not required to get there. */
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ THE REASON IT EXISTS IS ON THE RECORD ═══════════════════════════════ */

describe("the audit row", () => {
  test("names the actor, the company, the file, the screen and the item", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    const made = await register(w, c, file, { name: "Audited jersey" });
    const row = await MerchandisingAuditEvent.findOne({
      companyId: w.co._id, action: "DEVELOPMENT_MATERIAL_REGISTERED",
    }).lean();

    expect(row).toBeTruthy();
    expect(String(row.actor.id)).toBe(c.editor.id);
    expect(row.actor.email).toBe(c.editor.email);
    expect(String(row.developmentFileId)).toBe(String(file._id));
    expect(row.source).toBe("merchandising");
    expect(row.details.rawItemId).toBe(made.body.item.rawItemId);
    expect(row.details.rawItemName).toBe("Audited jersey");
    expect(row.details.sourceDepartment).toBe("merchandising");
    expect(row.details.sourceScreen).toBe("DEVELOPMENT_BOM");
    expect(row.correlationId).toBeTruthy();
    expect(row.at).toBeInstanceOf(Date);
  });

  test("a refused registration leaves no audit row behind", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);

    await register(w, c, file, { extra: { minStock: 100 } });
    expect(await MerchandisingAuditEvent.countDocuments({
      companyId: w.co._id, action: "DEVELOPMENT_MATERIAL_REGISTERED",
    })).toBe(0);
  });
});
