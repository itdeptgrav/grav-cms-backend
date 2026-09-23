// test/costing/source-app-requirements.route.test.js
//
// LANE B — the departmental requirements endpoint, at the wire.
//
// Three things a pure test cannot prove:
//
//   · a style belonging to another company is NOT FOUND, not merely filtered;
//   · a department grant opens exactly one app and no other — and holding none
//     is a refusal, never an empty list;
//   · no rate, supplier, policy value or costing URL appears in any response.
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

let server, base, seq = 0;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_source_apps" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/costing-inputs", require("../../routes/CMS_Routes/Costing/sourceRequirements"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/costing-inputs`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company } = {}) =>
  fetch(`${base}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** An actor with named department grants, a company membership, and no admin flag. */
async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `sa${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "S", lastName: `A${n}`, email, biometricId: `SA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "S Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** A company with a journey, an enquiry and a style that belongs to it. */
async function world(name) {
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
    enquiryId: `ENQ-${name}`, journeyId: journey._id, accountId,
    companyId: co._id, title: `Enquiry ${name}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
    /* The company delivers, so freight IS this order's cost — which is what
       makes the packed weight and the lane quotation genuinely wanted. */
    freight: { arrangement: "delivered" },
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${seq}`,
    productName: "Tee", styleCode: `ST-${name}`,
    journeyId: journey._id, enquiryId: enquiry._id,
    materials: { status: "pending", rawItems: [] },
  });
  return { co, journey, enquiry, style };
}

/* ══ COMPANY ISOLATION ═════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("another company's style is NOT FOUND, not forbidden", async () => {
    const mine = await world("Alpha");
    const theirs = await world("Beta");
    const a = await actor({ companies: [mine.co], grants: { "research-development": "editor" } });

    const ok = await call(`/requirements?sourceApp=RND&styleId=${mine.style._id}`, { token: a.token, company: mine.co._id });
    expect(ok.status).toBe(200);
    expect(ok.body.subject.styleId).toBe(String(mine.style._id));

    const foreign = await call(`/requirements?sourceApp=RND&styleId=${theirs.style._id}`, { token: a.token, company: mine.co._id });
    /* Telling somebody a style exists in another company is itself a
       disclosure, so it reads exactly like a style that does not exist. */
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toMatch(/Beta|ST-Beta/);
  });

  test("another company's enquiry is NOT FOUND", async () => {
    const mine = await world("Gamma");
    const theirs = await world("Delta");
    const a = await actor({ companies: [mine.co], grants: { sales: "editor" } });
    const foreign = await call(`/requirements?sourceApp=SALES&enquiryId=${theirs.enquiry._id}`, { token: a.token, company: mine.co._id });
    expect(foreign.status).toBe(404);
  });

  test("an actor with no proven company reaches nothing", async () => {
    const w = await world("Epsilon");
    /* A second company, so the single-company deployment fallback cannot
       apply — that rule holds only while NO membership exists anywhere and
       exactly one company does, and it is the live system's, not a hole. */
    await world("EpsilonTwo");
    const a = await actor({ companies: [], grants: { sales: "editor" } });
    const res = await call(`/requirements?sourceApp=SALES&enquiryId=${w.enquiry._id}`, { token: a.token });
    expect([400, 403, 404, 409]).toContain(res.status);
    expect(res.body?.success).not.toBe(true);
  });

  test("no token reaches nothing", async () => {
    const res = await call("/apps");
    expect([401, 403]).toContain(res.status);
  });
});

/* ══ DEPARTMENT ISOLATION ══════════════════════════════════════════════════ */

describe("department isolation", () => {
  test("a grant opens its own app and refuses every other", async () => {
    const w = await world("Zeta");
    const a = await actor({ companies: [w.co], grants: { "research-development": "editor" } });

    const apps = await call("/apps", { token: a.token, company: w.co._id });
    expect(apps.body.apps).toEqual(["RND"]);

    const mine = await call(`/requirements?sourceApp=RND&styleId=${w.style._id}`, { token: a.token, company: w.co._id });
    expect(mine.status).toBe(200);

    for (const other of ["STORE", "SALES", "MERCHANDISING", "PRODUCTION"]) {
      const res = await call(`/requirements?sourceApp=${other}&styleId=${w.style._id}`, { token: a.token, company: w.co._id });
      /* Refused, not emptied: an empty list reads as "nothing is outstanding". */
      expect(res.status).toBe(403);
      expect(res.body.error?.code || res.body.code).toBe("FORBIDDEN");
      expect(res.body.requirements).toBeUndefined();
    }
  });

  test("no grant at all is a refusal and an empty app list", async () => {
    const w = await world("Eta");
    const a = await actor({ companies: [w.co], grants: {} });
    const apps = await call("/apps", { token: a.token, company: w.co._id });
    expect(apps.body.apps).toEqual([]);
    const res = await call(`/requirements?sourceApp=RND&styleId=${w.style._id}`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(403);
  });

  test("the Board list cannot be opened by anybody", async () => {
    const w = await world("Theta");
    const a = await actor({ companies: [w.co], grants: { board: "owner", sales: "owner" } });
    const res = await call(`/requirements?sourceApp=BOARD&enquiryId=${w.enquiry._id}`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(403);
  });
});

/* ══ WHAT A DEPARTMENT ACTUALLY GETS ═══════════════════════════════════════ */

describe("the panel payload", () => {
  test("R&D is told its own facts, the style it is on, and who it waits for", async () => {
    const w = await world("Iota");
    const a = await actor({ companies: [w.co], grants: { "research-development": "editor" } });
    const res = await call(`/requirements?sourceApp=RND&styleId=${w.style._id}`, { token: a.token, company: w.co._id });

    expect(res.body.subject.reference).toBe("ST-Iota");
    expect(res.body.subject.enquiryReference).toBe("ENQ-Iota");
    expect(res.body.sourceApp).toBe("RND");

    const keys = res.body.requirements.map((r) => r.key);
    expect(keys).toEqual(["MATERIAL_CONSUMPTION", "TECHNICAL_SPECIFICATION", "SHIPMENT_PACKED_WEIGHT"]);

    /* No BOM yet, so consumption waits on Merchandising and offers no action —
       sending R&D to a form that cannot accept the answer is the defect. */
    const consumption = res.body.requirements.find((r) => r.key === "MATERIAL_CONSUMPTION");
    expect(consumption.status).toBe("awaiting_other_department");
    expect(consumption.waitingOn.department).toBe("Merchandising");
    expect(consumption.action).toBeNull();

    /* And the company delivers, so the packed weight IS wanted, with a local
       action into R&D's own shipment section. */
    const weight = res.body.requirements.find((r) => r.key === "SHIPMENT_PACKED_WEIGHT");
    expect(weight.status).toBe("not_started");
    expect(weight.action.id).toBe("RND_SHIPMENT");
    expect(weight.action.section).toBe("shipment");

    expect(res.body.completion.complete).toBe(false);
  });

  test("the route is a real local action into Production's own workspace", async () => {
    const w = await world("Kappa");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const res = await call(`/requirements?sourceApp=PRODUCTION&styleId=${w.style._id}`, { token: a.token, company: w.co._id });

    const route = res.body.requirements.find((r) => r.key === "OPERATION_ROUTE_AND_SAM");
    /* It used to be a SOURCE_FORM_MISSING blocker with no action, because the
       route was entered on R&D's technical record and Production had nowhere
       to record it. The Route & SAM section closed that. */
    expect(route.status).toBe("not_started");
    expect(route.blocker).toBeNull();
    expect(route.action.id).toBe("PM_STYLE_ROUTE");
    expect(route.action.section).toBe("route-and-sam");
  });

  test("outside processes now have their own Production form, on the same tab", async () => {
    const w = await world("KappaTwo");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const res = await call(`/requirements?sourceApp=PRODUCTION&styleId=${w.style._id}`, { token: a.token, company: w.co._id });

    /* It used to be a typed blocker: recorded on R&D's record with no
       Production screen. The screen exists now, beside the route it
       accompanies, so the row carries a real local action and no blocker. */
    const outside = res.body.requirements.find((r) => r.key === "OUTSIDE_PROCESS_REQUIREMENT");
    expect(outside.blocker).toBeNull();
    expect(outside.action.id).toBe("PM_OUTSIDE_PROCESSES");
    expect(outside.action.section).toBe("outside-processes");
    /* Nothing on this style needs one yet, which is a question rather than an
       answer — and it is Production's question now. */
    expect(outside.status).toBe("not_started");
  });

  test("Board policy blocks by name, and no value of it is published", async () => {
    const w = await world("Lambda");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const res = await call(`/requirements?sourceApp=PRODUCTION&styleId=${w.style._id}`, { token: a.token, company: w.co._id });

    const labour = res.body.boardPolicy.find((b) => b.key === "LABOUR_METHODOLOGY");
    expect(labour.code).toBe("BOARD_POLICY_REQUIRED");
    expect(labour.policyName).toBe("Labour costing methodology");
    expect(labour.companyScope).toBe(String(w.co._id));
    expect(labour.effectiveFrom).toBeNull();

    /* ── `null` USED TO MEAN "THE RECORD CANNOT SAY" ────────────────────
       Before labour was migrated, `boardApproved` was null because
       `CostingPolicy` had no approval state to report — claiming a date it
       did not hold would have been worse than saying so. It has a Board
       record now, so `false` is a real answer: nothing is approved yet. */
    expect(labour.boardApproved).toBe(false);
    expect(labour.hasBoardRecord).toBe(true);
    expect(labour.policyState).toBe("NONE");

    /* ── AND STILL NO METHODOLOGY ───────────────────────────────────────
       A department is told whether the company has decided and who to ask.
       What it decided is not theirs to read from a requirements list. */
    const asJson = JSON.stringify(labour);
    for (const leak of ["productiveMinutes", "employerBurden", "IN_OVERHEAD", "efficiency"]) {
      expect(asJson).not.toMatch(new RegExp(leak, "i"));
    }
  });

  test("a migrated policy reports its state; an unmigrated one says it cannot", async () => {
    /* ── FOUR MIGRATED, THE REST NOT ────────────────────────────────────
       Financing, overhead, labour and input GST have Board records and report
       a real state. Development charges and the duty table are still fields
       on the mutable costing policy — or, for duty, nothing at all — and they
       say `null` rather than inventing an approval that never happened. */
    const w = await world("Mu");
    const a = await actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const res = await call(`/requirements?sourceApp=PRODUCTION&styleId=${w.style._id}`, { token: a.token, company: w.co._id });

    for (const b of res.body.boardPolicy) {
      if (b.hasBoardRecord) {
        expect(b.boardApproved).toBe(false);
        expect(b.policyState).toBe("NONE");
      } else {
        expect(b.boardApproved).toBeNull();
      }
    }
  });

  test("no response carries a rate, a supplier, a policy value or a costing link", async () => {
    const w = await world("Mu");
    for (const [slug, app] of [
      ["research-development", "RND"], ["sales", "SALES"], ["store", "STORE"],
      ["merchandiser", "MERCHANDISING"], ["project-manager", "PRODUCTION"],
    ]) {
      const a = await actor({ companies: [w.co], grants: { [slug]: "editor" } });
      for (const q of [`styleId=${w.style._id}`, `enquiryId=${w.enquiry._id}`]) {
        const res = await call(`/requirements?sourceApp=${app}&${q}`, { token: a.token, company: w.co._id });
        expect(res.status).toBe(200);
        const s = JSON.stringify(res.body);
        expect(s).not.toMatch(/Minor|₹|ratePercent|supplierName|quotationReference/i);
        /* No operational user is ever sent to the costing app. */
        expect(s).not.toMatch(/\/costing/);
        expect(s).not.toMatch(/https?:/);
        /* And Lane A's family is not described. */
        expect(s).not.toMatch(/packaging|PER_CARTON/i);
      }
    }
  });

  test("Store sees quotation presence and not one quoted figure", async () => {
    const w = await world("Nu");
    const a = await actor({ companies: [w.co], grants: { store: "viewer" } });
    const res = await call(`/requirements?sourceApp=STORE&styleId=${w.style._id}`, { token: a.token, company: w.co._id });
    const keys = res.body.requirements.map((r) => r.key);
    expect(keys).toEqual([
      "MATERIAL_QUOTATION", "SERVICE_QUOTATION", "FREIGHT_QUOTATION", "SOURCING_ORIGIN_EVIDENCE",
    ]);
    const material = res.body.requirements.find((r) => r.key === "MATERIAL_QUOTATION");
    expect(material.status).toBe("awaiting_other_department");
    expect(material.waitingOn.department).toBe("Merchandising");
  });

  test("a request naming neither a style nor an enquiry is refused", async () => {
    const w = await world("Xi");
    const a = await actor({ companies: [w.co], grants: { sales: "editor" } });
    const res = await call("/requirements?sourceApp=SALES", { token: a.token, company: w.co._id });
    expect(res.status).toBe(400);
  });
});
