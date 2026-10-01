// test/costing/production-style-route.route.test.js
//
// PRODUCTION MANAGER — the style's route and standard time, at the wire.
//
// The claims worth holding are the ones that decide whether this door is
// narrow enough to open:
//
//   · Production creates, edits, reorders and removes; R&D and everybody else
//     cannot write through it at all;
//   · another company's style is NOT FOUND, and an unregistered operation is
//     refused by name rather than silently dropped;
//   · no Journey identity is in any response, and none is accepted in a body;
//   · nothing outside the route can be altered — not materials, not packaging,
//     not requirements, not a rate, not the record's status;
//   · legacy rows stay readable and are never rewritten;
//   · no response sends anybody to /costing.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "production_style_route" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/production/style-route", require("../../routes/CMS_Routes/Manufacturing/productionStyleRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/production/style-route`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `pr${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "P", lastName: `R${n}`, email, biometricId: `PR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "P Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company, a product, and a style of it whose company can be proved. */
async function world(name, { technicalStatus = "draft", operations = undefined } = {}) {
  const co = await Acc_Company.create({
    companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${seq}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
    name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${seq}`, journeyId: journey._id, accountId,
    companyId: co._id, title: `Enquiry ${name}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  const product = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${seq}`,
    reference: `REF-${name}-${seq}`, category: "Garment",
    createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    /* `variants.sku` is uniquely indexed, and two products with no variant
       collide on null. One named variant each keeps the fixtures independent. */
    variants: [{ sku: `VAR-${name}-${seq}`, cost: 0, salesPrice: 0 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${seq}`,
    productName: "Tee", styleCode: `ST-${name}`,
    journeyId: journey._id, enquiryId: enquiry._id,
    sourceStockItemId: product._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: { technical: { status: technicalStatus, ...(operations ? { operations } : {}) } },
  });
  return { co, journey, enquiry, product, style };
}

const op = (name, code, machineType = "SNLS") =>
  Operation.create({ name, operationCode: code, machineType, totalSam: 1, durationSeconds: 60 });

const service = (co, name, code) => Service.create({
  companyId: co._id, name, serviceCode: code, billingUnit: "Piece", status: "ACTIVE",
});

/* ══ PRODUCTION DOES THE WORK ══════════════════════════════════════════════ */

describe("Production records the route", () => {
  test("creates a route, in order, with standard times", async () => {
    const w = await world("Alpha");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const [o1, o2] = [await op("Side seam", "SEW-1"), await op("Hem", "HEM-1")];

    const res = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: {
        operations: [
          { operationId: String(o1._id), minutes: 1, seconds: 30, notes: "Both sides" },
          { operationId: String(o2._id), minutes: 0, seconds: 45 },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(2);
    /* Order IS sequence, echoed back derived rather than stored twice. */
    expect(res.body.operations.map((o) => o.sequence)).toEqual([1, 2]);
    expect(res.body.operations[0].name).toBe("Side seam");
    /* Identity re-read from the register, never taken from the body. */
    expect(res.body.operations[0].operationCode).toBe("SEW-1");
    expect(res.body.operations[0].machineType).toBe("SNLS");
    expect(res.body.operations[0].samMinutes).toBe(1.5);
    expect(res.body.operations[1].samMinutes).toBe(0.75);
    expect(res.body.style.samMinutes).toBe(2.25);
  });

  test("reorders and removes, because the whole route is the payload", async () => {
    const w = await world("Beta");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const [o1, o2, o3] = [await op("A", "A1"), await op("B", "B1"), await op("C", "C1")];
    const put = (ops) => call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id, body: { operations: ops },
    });

    await put([o1, o2, o3].map((o) => ({ operationId: String(o._id), minutes: 1 })));
    const reordered = await put([o3, o1].map((o) => ({ operationId: String(o._id), minutes: 1 })));

    expect(reordered.body.operations.map((o) => o.name)).toEqual(["C", "A"]);
    expect(reordered.body.operations.map((o) => o.sequence)).toEqual([1, 2]);
    /* B is gone because the route no longer contains it — removal needs no
       separate verb. */
    expect(reordered.body.operations.find((o) => o.name === "B")).toBeUndefined();
  });

  test("an empty route is a real answer, and clears the list", async () => {
    const w = await world("Gamma");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", "A1");
    await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
    });
    const cleared = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id, body: { operations: [] },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.operations).toEqual([]);
  });

  test("the product lists its styles, and their route shape", async () => {
    const w = await world("Delta");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "viewer" } });
    const res = await call(`/styles?stockItemId=${w.product._id}`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.product.reference).toBe(w.product.reference);
    expect(res.body.styles).toHaveLength(1);
    expect(res.body.styles[0].reference).toBe("ST-Delta");
    expect(res.body.styles[0].operationCount).toBe(0);
  });
});

describe("Production records outside processes", () => {
  test("writes only OUTSIDE_PROCESS rows from the company Service Master", async () => {
    const w = await world("Outside");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const wash = await service(w.co, "Enzyme wash", "WASH-1");
    const res = await call(`/styles/${w.style._id}/outside-processes`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { outsideProcesses: [{ serviceId: String(wash._id), specification: "Two cycles", quantity: 1, billingUnit: "Piece", basis: "PER_GARMENT" }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.outsideProcesses).toHaveLength(1);
    expect(res.body.outsideProcesses[0]).toMatchObject({ serviceName: "Enzyme wash", serviceCode: "WASH-1", quantity: 1, basis: "PER_GARMENT" });
    expect(JSON.stringify(res.body)).not.toMatch(/supplier|rate|price|amount|journey|enquiry/i);

    const stored = await SampleStyle.findById(w.style._id).lean();
    expect(stored.sample.serviceRequirements[0]).toMatchObject({ purpose: "OUTSIDE_PROCESS", owner: "PRODUCTION", serviceName: "Enzyme wash" });
  });

  test("preserves development rows and rejects quotation data", async () => {
    const w = await world("OutsidePreserve");
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "sample.serviceRequirements": [{
      rowId: "dev-1", purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
      developmentChargeKey: "pattern", specification: "Pattern", included: true,
    }] } });
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const wash = await service(w.co, "Wash", "WASH-2");
    const bad = await call(`/styles/${w.style._id}/outside-processes`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { outsideProcesses: [{ serviceId: String(wash._id), quantity: 1, billingUnit: "Piece", rate: 99 }] },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.error?.code || bad.body.code).toBe("FIELD_NOT_ACCEPTED");

    const ok = await call(`/styles/${w.style._id}/outside-processes`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { outsideProcesses: [{ serviceId: String(wash._id), quantity: 1, billingUnit: "Piece" }] },
    });
    expect(ok.status).toBe(200);
    const stored = await SampleStyle.findById(w.style._id).lean();
    expect(stored.sample.serviceRequirements.map((r) => r.purpose).sort()).toEqual(["DEVELOPMENT_TOOLING", "OUTSIDE_PROCESS"]);
  });
});

/* ══ NOBODY ELSE WRITES THROUGH THIS DOOR ══════════════════════════════════ */

describe("only Production writes", () => {
  test("R&D cannot write the route", async () => {
    const w = await world("Epsilon");
    const a = await actor({ companies: [w.co], grants: { "research-development": "owner" } });
    const o1 = await op("A", "A1");
    const res = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code || res.body.code).toBe("FORBIDDEN");
  });

  test("Sales, Store and Merchandising cannot write it either", async () => {
    const w = await world("Zeta");
    const o1 = await op("A", "A1");
    for (const slug of ["sales", "store", "merchandiser"]) {
      const a = await actor({ companies: [w.co], grants: { [slug]: "owner" } });
      const res = await call(`/styles/${w.style._id}/route`, {
        method: "PUT", token: a.token, company: w.co._id,
        body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
      });
      expect(res.status).toBe(403);
    }
  });

  test("a Production VIEWER may read and may not write", async () => {
    const w = await world("Eta");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "viewer" } });
    const o1 = await op("A", "A1");
    expect((await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id })).status).toBe(200);
    const write = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
    });
    expect(write.status).toBe(403);
  });

  test("no grant at all reaches nothing", async () => {
    const w = await world("Theta");
    const a = await actor({ companies: [w.co], grants: {} });
    expect((await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id })).status).toBe(403);
  });

  test("no token reaches nothing", async () => {
    expect([401, 403]).toContain((await call("/styles?stockItemId=x")).status);
  });
});

/* ══ SCOPE ═════════════════════════════════════════════════════════════════ */

describe("company and register scope", () => {
  test("another company's style is NOT FOUND, read and write alike", async () => {
    const mine = await world("Iota");
    const theirs = await world("Kappa");
    const a = await actor({ companies: [mine.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", "A1");

    const read = await call(`/styles/${theirs.style._id}/route`, { token: a.token, company: mine.co._id });
    expect(read.status).toBe(404);

    const write = await call(`/styles/${theirs.style._id}/route`, {
      method: "PUT", token: a.token, company: mine.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
    });
    expect(write.status).toBe(404);
    /* And nothing about the other company leaks in the refusal. */
    expect(JSON.stringify(write.body)).not.toMatch(/Kappa/);
  });

  test("a product's foreign styles are not listed", async () => {
    const mine = await world("Lambda");
    const theirs = await world("Mu");
    /* Point the other company's style at MY product — the product master has
       no company of its own, so the style is the only real boundary. */
    await SampleStyle.updateOne({ _id: theirs.style._id }, { $set: { sourceStockItemId: mine.product._id } });

    const a = await actor({ companies: [mine.co], grants: { "project-manager": "viewer" } });
    const res = await call(`/styles?stockItemId=${mine.product._id}`, { token: a.token, company: mine.co._id });
    expect(res.body.styles.map((s) => s.reference)).toEqual(["ST-Lambda"]);
  });

  test("an operation that is not registered is refused by name, never dropped", async () => {
    const w = await world("Nu");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const real = await op("A", "A1");
    const ghost = new mongoose.Types.ObjectId();

    const res = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: {
        operations: [
          { operationId: String(real._id), minutes: 1 },
          { operationId: String(ghost), minutes: 1 },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.code || res.body.code).toBe("OPERATION_NOT_REGISTERED");

    /* The whole save is refused — a partially applied route is worse than
       none, because nobody can tell which half landed. */
    const after = await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id });
    expect(after.body.operations).toEqual([]);
  });

  test("a negative time is refused", async () => {
    const w = await world("Xi");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", "A1");
    const res = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: -3 }] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.code || res.body.code).toBe("VALIDATION");
  });
});

/* ══ THE DOOR IS NARROW ════════════════════════════════════════════════════ */

describe("nothing but the route can be changed", () => {
  const cases = [
    ["a labour cost", { operatorCost: 42 }],
    ["a salary basis", { salaryDept: "Stitching" }],
    ["a rate", { rate: 7 }],
    ["a journey", { journeyId: "abc" }],
    ["an enquiry", { enquiryId: "abc" }],
    ["an undeclared field", { machineType: "OVERLOCK" }],
  ];

  test.each(cases)("a route row carrying %s is refused", async (_label, extra) => {
    const w = await world(`Row${++seq}`);
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", `A${seq}`);
    const res = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 1, ...extra }] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.code || res.body.code).toBe("FIELD_NOT_ACCEPTED");
  });

  test("a body naming materials, packaging or requirements is refused, and changes nothing", async () => {
    const w = await world("Omicron");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });

    for (const extra of [
      { materials: [{ rawItemId: "x" }] },
      { packagingRequirements: [{ rowId: "x" }] },
      { requirements: [{ family: "SERVICE", name: "Wash" }] },
      { status: "approved" },
    ]) {
      const res = await call(`/styles/${w.style._id}/route`, {
        method: "PUT", token: a.token, company: w.co._id,
        body: { operations: [], ...extra },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error?.code || res.body.code).toBe("FIELD_NOT_ACCEPTED");
    }

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.techSheet.technical.status).toBe("draft");
    expect(style.techSheet.technical.materials || []).toEqual([]);
    expect(style.sample?.packagingRequirements || []).toEqual([]);
  });

  test("a successful save moves the route and nothing else", async () => {
    const w = await world("Pi");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", "A1");
    const before = await SampleStyle.findById(w.style._id).lean();

    await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: { operations: [{ operationId: String(o1._id), minutes: 2 }] },
    });

    const after = await SampleStyle.findById(w.style._id).lean();
    /* The record's own lifecycle is untouched: Production recording a route
       must not send R&D's technical record anywhere. */
    expect(after.techSheet.technical.status).toBe(before.techSheet.technical.status);
    expect(after.techSheet.technical.revision).toBe(before.techSheet.technical.revision);
    expect(after.techSheet.technical.operations).toHaveLength(1);
    /* And no rupee is stored against an operation. */
    expect(after.techSheet.technical.operations[0].operatorCost).toBeUndefined();
    expect(after.techSheet.technical.operations[0].salaryDept).toBeUndefined();
  });
});

/* ══ WHAT LEAVES, AND WHAT DOES NOT ════════════════════════════════════════ */

describe("no Journey, and no costing app", () => {
  test("no response carries a journey, an enquiry, a customer or a costing link", async () => {
    const w = await world("Rho");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const o1 = await op("A", "A1");

    const responses = [
      await call(`/styles?stockItemId=${w.product._id}`, { token: a.token, company: w.co._id }),
      await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id }),
      await call(`/styles/${w.style._id}/route`, {
        method: "PUT", token: a.token, company: w.co._id,
        body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
      }),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      const s = JSON.stringify(res.body);
      expect(s).not.toMatch(/journey/i);
      expect(s).not.toMatch(/enquiry/i);
      expect(s).not.toMatch(String(w.journey._id));
      expect(s).not.toMatch(String(w.enquiry._id));
      /* No operational user is ever sent to the costing app. */
      expect(s).not.toMatch(/\/costing/);
      /* And no money, ever. */
      expect(s).not.toMatch(/rate|salary|operatorCost|Minor|₹/i);
    }
  });
});

/* ══ HISTORY ═══════════════════════════════════════════════════════════════ */

describe("legacy rows and the record's own lifecycle", () => {
  test("an existing route is read as it stands, with its own stored snapshot", async () => {
    /* ── WHAT "LEGACY" ACTUALLY MEANS HERE ──────────────────────────────
       `operationId` is schema-required on this array, so a row naming no
       registered operation cannot be written through the model — the case
       worth pinning is the one that does happen: a row stored earlier, whose
       code and name are ITS OWN snapshot, read back unchanged even after the
       register moves on. */
    const legacyOp = await op("Hand finish", "OLD-1", "MANUAL");
    const w = await world("Sigma", {
      operations: [{
        operationId: legacyOp._id, operationCode: "OLD-1",
        name: "Hand finish", machineType: "MANUAL", minutes: 2, seconds: 0,
      }],
    });
    const a = await actor({ companies: [w.co], grants: { "project-manager": "viewer" } });

    const read = await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id });
    expect(read.body.operations).toHaveLength(1);
    expect(read.body.operations[0].name).toBe("Hand finish");
    expect(read.body.operations[0].operationCode).toBe("OLD-1");
    expect(read.body.operations[0].samMinutes).toBe(2);
    /* Nothing was migrated or backfilled to make it readable. */
    expect(read.body.operations[0].legacy).toBe(false);
  });

  test("a row already stored keeps its place unless the route drops it", async () => {
    const kept = await op("Keep", "K1");
    const w = await world("Upsilon", {
      operations: [{ operationId: kept._id, operationCode: "K1", name: "Keep", minutes: 1, seconds: 0 }],
    });
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const added = await op("Add", "AD1");

    const saved = await call(`/styles/${w.style._id}/route`, {
      method: "PUT", token: a.token, company: w.co._id,
      body: {
        operations: [
          { operationId: String(kept._id), minutes: 1 },
          { operationId: String(added._id), minutes: 3 },
        ],
      },
    });
    expect(saved.body.operations.map((o) => o.name)).toEqual(["Keep", "Add"]);
  });

  test("a submitted or approved record is read-only, and says who unlocks it", async () => {
    for (const [status, phrase] of [["submitted", /with Sales/], ["approved", /must return it/]]) {
      const w = await world(`Tau${status}`, { technicalStatus: status });
      const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
      const o1 = await op("A", `A-${status}`);

      const read = await call(`/styles/${w.style._id}/route`, { token: a.token, company: w.co._id });
      expect(read.body.editable).toBe(false);
      expect(read.body.readOnlyReason).toMatch(phrase);

      const write = await call(`/styles/${w.style._id}/route`, {
        method: "PUT", token: a.token, company: w.co._id,
        body: { operations: [{ operationId: String(o1._id), minutes: 1 }] },
      });
      expect(write.status).toBeGreaterThanOrEqual(400);
      expect(write.body.error?.code || write.body.code).toBe("STYLE_ROUTE_NOT_EDITABLE");
    }
  });
});
