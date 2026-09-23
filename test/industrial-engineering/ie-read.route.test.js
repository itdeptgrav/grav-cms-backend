// test/industrial-engineering/ie-read.route.test.js
//
// INDUSTRIAL ENGINEERING — CHUNK 1A, AT THE WIRE.
//
// The claims worth holding are the ones that decide whether this boundary is
// safe to build a department on:
//
//   · nobody reaches it without a session, and nobody without an `ie` grant;
//   · the company is the ACTOR'S, resolved server-side, and a request cannot
//     name one;
//   · a foreign style, an unprovable one and one that was never there are the
//     same answer;
//   · no Journey, enquiry, customer, supplier, salary, rate, cost or margin
//     leaves any response — checked by walking every key of every payload,
//     not by reading one fixture;
//   · an empty route stays missing rather than becoming zero or complete;
//   · the two legacy route sources are published separately and compared, and
//     every one of the eight states is reachable through HTTP;
//   · a duplicated operation code is AMBIGUOUS, never resolved by ordering;
//   · and a read writes nothing — asserted by spying on every mutation path
//     mongoose offers rather than by inspecting the records afterwards.
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

const { STATE } = require("../../services/industrialEngineering/routeComparison");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
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
  }).then(async (r) => {
    const text = await r.text();
    /* Express answers an unmatched verb with its own HTML 404. Parsed
       defensively so "this route does not exist" reads as a status rather
       than as a crash in the helper. */
    let body = null;
    try { body = JSON.parse(text || "null"); } catch { body = { nonJson: true }; }
    return { status: r.status, body };
  });

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ie${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `E${n}`, email, biometricId: `IE${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
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
      { id: String(emp._id), email, name: "IE Actor", role: "employee", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A company, a product, and a style of it whose company can be PROVED through
 * its Sales parents — which is the only way a SampleStyle's company exists.
 */
async function world(name, {
  technicalStatus = "draft",
  operations = undefined,
  productOperations = undefined,
  linkProduct = true,
} = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
    name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId,
    companyId: co._id, title: `Enquiry ${name}`, isActive: true,
    products: [{ product: "Tee", quantity: 500 }],
  });
  const product = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${n}`,
    reference: `REF-${name}-${n}`, category: "Garment",
    createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
    ...(productOperations ? { operations: productOperations } : {}),
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`,
    productName: "Tee", styleCode: `ST-${name}`, variantLabel: "Navy",
    journeyId: journey._id, enquiryId: enquiry._id,
    ...(linkProduct ? { sourceStockItemId: product._id } : {}),
    materials: { status: "pending", rawItems: [] },
    techSheet: { technical: { status: technicalStatus, ...(operations ? { operations } : {}) } },
  });
  return { co, journey, enquiry, product, style };
}

const op = (name, code, machineType = "SNLS", totalSam = 1) =>
  Operation.create({ name, operationCode: code, machineType, totalSam, durationSeconds: totalSam * 60 });

/** A stored technical row, in the shape the model actually holds. */
const techRow = (operationId, code, name, minutes, seconds) => ({
  operationId, operationCode: code, name, machineType: "SNLS",
  ...(minutes === undefined ? {} : { minutes }),
  ...(seconds === undefined ? {} : { seconds }),
});

/** A stored product row. `type` is the operation's name on this model. */
const prodRow = (code, type, minutes, seconds) => ({
  type, operationCode: code, machineType: "SNLS",
  ...(minutes === undefined ? {} : { minutes }),
  ...(seconds === undefined ? {} : { seconds }),
});

const ieViewer = (co) => actor({ companies: [co], grants: { ie: "viewer" } });

/* ══ 1–4. WHO MAY OPEN THE DOOR, AND WHAT THE DOOR OPENS ═══════════════════ */

describe("access", () => {
  test("no session reaches nothing", async () => {
    for (const path of ["/styles", "/styles/abc", "/operations"]) {
      const res = await call(path);
      expect(res.status).toBe(401);
    }
  });

  test("an employee with no IE grant is refused", async () => {
    const w = await world("NoGrant");
    const a = await actor({ companies: [w.co], grants: {} });
    for (const path of ["/styles", `/styles/${w.style._id}`, "/operations"]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(403);
      expect(res.body.error?.code || res.body.code).toBe("FORBIDDEN");
    }
  });

  test("a grant in another department is not an IE grant", async () => {
    const w = await world("OtherDept");
    for (const slug of ["project-manager", "production-supervisor", "sales", "merchandiser", "store"]) {
      const a = await actor({ companies: [w.co], grants: { [slug]: "owner" } });
      const res = await call("/styles", { token: a.token, company: w.co._id });
      expect(res.status).toBe(403);
    }
  });

  test("an IE viewer may read all three", async () => {
    const w = await world("Viewer");
    const a = await ieViewer(w.co);
    for (const path of ["/styles", `/styles/${w.style._id}`, "/operations"]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  test("a platform administrator follows the existing convention, not a new bypass", async () => {
    /* Same branch every other department guard in the codebase uses: an
       administrator is an owner. The COMPANY is still resolved from their own
       membership — an admin without one reaches nothing. */
    const w = await world("Admin");
    const a = await actor({ companies: [w.co], grants: {}, isAdmin: true });
    expect((await call("/styles", { token: a.token, company: w.co._id })).status).toBe(200);

    const stranger = await actor({ companies: [], grants: {}, isAdmin: true });
    const res = await call("/styles", { token: stranger.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });

  test("no IE write route exists — this chunk adds no writer", async () => {
    const w = await world("ReadOnly");
    const a = await actor({ companies: [w.co], grants: { ie: "owner" } });
    const paths = ["/styles", `/styles/${w.style._id}`, "/operations", "/styles/route", "/operations/1"];
    for (const path of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await call(path, { method, token: a.token, company: w.co._id, body: {} });
        /* 404 — the router holds no such verb at all. Never a 200, and never
           a 403 that would mean "this exists and you may not". */
        expect(res.status).toBe(404);
      }
    }
  });

  test("the read payload says it is read-only", async () => {
    const w = await world("SaysReadOnly");
    const a = await ieViewer(w.co);
    expect((await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id })).body.readOnly).toBe(true);
    expect((await call("/operations", { token: a.token, company: w.co._id })).body.readOnly).toBe(true);
  });
});

/* ══ 5. THE COMPANY IS THE ACTOR'S ════════════════════════════════════════ */

describe("company context is resolved server-side", () => {
  test("a request cannot name a company it does not hold", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const a = await ieViewer(mine.co);

    /* A single-membership actor's stated company is ignored entirely — the
       membership decides, and it decides the same way twice. */
    const res = await call(`/styles?actingCompanyId=${theirs.co._id}`, { token: a.token });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.reference)).toEqual(["ST-Mine"]);

    const spoofed = await call("/styles", { token: a.token, company: theirs.co._id });
    expect(spoofed.status).toBe(200);
    expect(spoofed.body.rows.map((r) => r.reference)).toEqual(["ST-Mine"]);
  });

  test("an actor with no membership at all is refused", async () => {
    const a = await actor({ companies: [], grants: { ie: "viewer" } });
    const res = await call("/styles", { token: a.token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(["TENANT_MEMBERSHIP_UNPROVEN", "COMPANY_CONTEXT_UNAVAILABLE"])
      .toContain(res.body.error?.code || res.body.code);
  });

  test("a multi-company actor must choose, and may only choose their own", async () => {
    const one = await world("MultiOne");
    const two = await world("MultiTwo");
    const outsider = await world("MultiOutsider");
    const a = await actor({ companies: [one.co, two.co], grants: { ie: "viewer" } });

    const unchosen = await call("/styles", { token: a.token });
    expect(unchosen.status).toBe(409);
    expect(unchosen.body.error?.code || unchosen.body.code).toBe("COMPANY_SELECTION_REQUIRED");

    const chosen = await call("/styles", { token: a.token, company: one.co._id });
    expect(chosen.status).toBe(200);
    expect(chosen.body.rows.map((r) => r.reference)).toEqual(["ST-MultiOne"]);

    const foreign = await call("/styles", { token: a.token, company: outsider.co._id });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error?.code || foreign.body.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");
  });
});

/* ══ 6–7. WHAT IS LISTED, AND WHAT IS INDISTINGUISHABLE ═══════════════════ */

describe("company scope over styles", () => {
  test("a same-company style is listed and readable", async () => {
    const w = await world("Listed");
    const a = await ieViewer(w.co);

    const list = await call("/styles", { token: a.token, company: w.co._id });
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0]).toMatchObject({
      styleId: String(w.style._id),
      reference: "ST-Listed",
      productName: "Tee",
      variantLabel: "Navy",
      technicalStatus: "draft",
    });

    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    expect(detail.status).toBe(200);
    expect(detail.body.style.styleId).toBe(String(w.style._id));
  });

  test("another company's style is not listed", async () => {
    const mine = await world("ScopeMine");
    await world("ScopeTheirs");
    const a = await ieViewer(mine.co);
    const list = await call("/styles", { token: a.token, company: mine.co._id });
    expect(list.body.rows.map((r) => r.reference)).toEqual(["ST-ScopeMine"]);
  });

  test("foreign, unprovable and absent style ids are the same answer", async () => {
    const mine = await world("Indist");
    const theirs = await world("IndistTheirs");
    /* Unprovable: it names a journey that does not exist and no enquiry, so
       no parent can attribute it to anybody. */
    const orphan = await SampleStyle.create({
      sampleStyleId: `SS-ORPHAN-${++seq}`, productName: "Tee", styleCode: "ST-Orphan",
      journeyId: new mongoose.Types.ObjectId(),
      materials: { status: "pending", rawItems: [] },
      techSheet: { technical: { status: "draft" } },
    });
    const a = await ieViewer(mine.co);

    const answers = [];
    for (const id of [
      String(theirs.style._id),
      String(orphan._id),
      String(new mongoose.Types.ObjectId()),
      "not-an-object-id",
    ]) {
      answers.push(await call(`/styles/${id}`, { token: a.token, company: mine.co._id }));
    }

    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body.error?.code || res.body.code).toBe("NOT_FOUND");
    }
    /* Byte for byte the same refusal: a body that varied would be an oracle
       for which ids are real and which belong to somebody else. */
    const shapes = answers.map((r) => JSON.stringify(r.body));
    expect(new Set(shapes).size).toBe(1);
    expect(shapes[0]).not.toMatch(/IndistTheirs|Orphan/);

    /* And neither the foreign nor the unprovable style is in the list. */
    const list = await call("/styles", { token: a.token, company: mine.co._id });
    expect(list.body.rows.map((r) => r.reference)).toEqual(["ST-Indist"]);
  });
});

/* ══ 8. NOTHING FORBIDDEN LEAVES ══════════════════════════════════════════ */

/** Every key at every depth of a payload. */
function allKeys(value, out = []) {
  if (Array.isArray(value)) { value.forEach((v) => allKeys(v, out)); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  }
  return out;
}

/* Named as fragments rather than exact keys, so a field added later under any
   of these names is caught the day it appears rather than the day somebody
   updates this list. */
const FORBIDDEN_KEY = /journey|enquiry|customer|buyer|supplier|quotation|salar|wage|rate|cost|margin|price|amount|invoice|payment|account/i;

describe("no Sales, no supplier and no money leaves any IE response", () => {
  test("every key of every payload, recursively", async () => {
    const o1 = await op("Side seam", "SEW-1");
    const w = await world("NonDisclosure", {
      technicalStatus: "approved",
      operations: [techRow(o1._id, "SEW-1", "Side seam", 1, 30)],
      productOperations: [{
        type: "Side seam", operationCode: "SEW-1", machineType: "SNLS",
        minutes: 2, seconds: 0,
        /* The stored product row DOES carry money. It is in the database and
           it must not be in the response. */
        operatorSalary: 25000, operatorCost: 7.5, salaryDept: "Stitching", salaryDesig: "Operator",
      }],
    });
    const a = await ieViewer(w.co);

    const responses = [
      await call("/styles", { token: a.token, company: w.co._id }),
      await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id }),
      await call("/operations", { token: a.token, company: w.co._id }),
      await call(`/styles/${new mongoose.Types.ObjectId()}`, { token: a.token, company: w.co._id }),
    ];

    for (const res of responses) {
      const offending = [...new Set(allKeys(res.body))].filter((k) => FORBIDDEN_KEY.test(k));
      expect(offending).toEqual([]);

      const text = JSON.stringify(res.body);
      /* And no value carries a parent's identity either. */
      expect(text).not.toMatch(String(w.journey._id));
      expect(text).not.toMatch(String(w.enquiry._id));
      expect(text).not.toMatch(/SJ-NonDisclosure|ENQ-NonDisclosure/);
      expect(text).not.toMatch(/25000|Stitching|Operator/);
      expect(text).not.toMatch(/\/costing/);
    }
  });

  test("the operation library publishes no salary basis from the master", async () => {
    const w = await world("OpSalary");
    await Operation.create({
      name: "Overlock", operationCode: "OVL-1", machineType: "OVERLOCK",
      totalSam: 1, durationSeconds: 60, salaryDept: "Stitching", salaryDesig: "Operator",
    });
    const a = await ieViewer(w.co);
    const res = await call("/operations", { token: a.token, company: w.co._id });
    expect(res.body.rows).toHaveLength(1);
    expect(Object.keys(res.body.rows[0]).sort()).toEqual([
      "ambiguous", "code", "codeState", "duplicateCodeCount", "durationSeconds",
      "machineType", "name", "operationId", "samMinutes",
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/Stitching|Operator|salar/i);
  });

  test("the full stored documents are never echoed", async () => {
    const o1 = await op("Hem", "HEM-1");
    const w = await world("NoDocs", { operations: [techRow(o1._id, "HEM-1", "Hem", 1, 0)] });
    const a = await ieViewer(w.co);
    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    /* The SampleStyle's own aggregates are absent, not merely unread. */
    for (const key of ["techSheet", "sample", "materials", "bomApproval", "production", "variants", "_id"]) {
      expect(allKeys(detail.body)).not.toContain(key);
    }
    expect(Object.keys(detail.body.routes.technical.rows[0]).sort()).toEqual([
      "legacy", "machineType", "name", "operationCode", "operationId", "samMinutes", "sequence", "timeSeconds",
    ]);
  });
});

/* ══ 9–10. MISSING IS MISSING, AND SAM IS DETERMINISTIC ═══════════════════ */

describe("an empty or untimed route", () => {
  test("stays missing rather than becoming zero or complete", async () => {
    const w = await world("EmptyRoute", { linkProduct: false });
    const a = await ieViewer(w.co);

    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    const technical = detail.body.routes.technical;
    expect(technical.present).toBe(false);
    expect(technical.operationCount).toBe(0);
    /* null, not 0 — an unengineered style is not a free one. */
    expect(technical.totalSamMinutes).toBeNull();
    expect(technical.samComplete).toBe(false);
    expect(detail.body.comparison.state).toBe(STATE.NO_ROUTE);
    expect(detail.body.gaps.map((g) => g.code)).toContain("NO_ROUTE_RECORDED");

    const list = await call("/styles", { token: a.token, company: w.co._id });
    expect(list.body.rows[0].samMinutes).toBeNull();
    expect(list.body.rows[0].samComplete).toBe(false);
    expect(list.body.rows[0].operationCount).toBe(0);
  });

  test("an untimed row keeps a null time and the total covers only the timed rows", async () => {
    /* ── WHAT "UNTIMED" LOOKS LIKE ON DISK ──────────────────────────────
       The stored subschema defaults `minutes` and `seconds` to 0, so a row
       nobody timed IS a 0/0 row. Both readings collapse to "no standard
       time" — the shared formula's answer — and neither is published as a
       zero-minute operation. */
    const [o1, o2] = [await op("A", "A-1"), await op("B", "B-1")];
    const w = await world("UntimedRow", {
      linkProduct: false,
      operations: [techRow(o1._id, "A-1", "A", 2, 0), techRow(o2._id, "B-1", "B")],
    });
    const a = await ieViewer(w.co);
    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    const technical = detail.body.routes.technical;

    expect(technical.rows[1].timeSeconds).toBeNull();
    expect(technical.rows[1].samMinutes).toBeNull();
    expect(technical.totalSamMinutes).toBe(2);
    expect(technical.samComplete).toBe(false);
    expect(technical.rowsMissingTime).toBe(1);

    const gap = detail.body.gaps.find((g) => g.code === "STANDARD_TIME_MISSING");
    expect(gap).toBeTruthy();
    expect(gap.owner).toBe("INDUSTRIAL_ENGINEERING");
    expect(gap.action).toBe("RECORD_STANDARD_TIME");
  });

  test("a technical record that is not approved is a gap owned by R&D", async () => {
    const w = await world("NotApproved", { technicalStatus: "draft", linkProduct: false });
    const a = await ieViewer(w.co);
    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    const gap = detail.body.gaps.find((g) => g.code === "TECHNICAL_RECORD_NOT_APPROVED");
    expect(gap.owner).toBe("RESEARCH_DEVELOPMENT");
    expect(gap.action).toBe("COMPLETE_TECHNICAL_RECORD");
  });
});

describe("SAM is calculated deterministically from row time", () => {
  test("minutes and seconds sum to one total, the same way every time", async () => {
    const [o1, o2, o3] = [await op("A", "A-2"), await op("B", "B-2"), await op("C", "C-2")];
    const w = await world("Sam", {
      linkProduct: false,
      operations: [
        techRow(o1._id, "A-2", "A", 1, 30),
        techRow(o2._id, "B-2", "B", 0, 45),
        techRow(o3._id, "C-2", "C", 2, 0),
      ],
    });
    const a = await ieViewer(w.co);

    const first = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    const second = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });

    expect(first.body.routes.technical.rows.map((r) => r.samMinutes)).toEqual([1.5, 0.75, 2]);
    expect(first.body.routes.technical.totalSamMinutes).toBe(4.25);
    expect(first.body.routes.technical.samComplete).toBe(true);
    /* Twice, identically — no ordering, rounding or float drift between reads. */
    expect(second.body.routes.technical.totalSamMinutes)
      .toBe(first.body.routes.technical.totalSamMinutes);
    /* And the worklist quotes the same number as the detail. */
    const list = await call("/styles", { token: a.token, company: w.co._id });
    expect(list.body.rows[0].samMinutes).toBe(4.25);
  });

  test("a product row timed only by totalSeconds is read, not discarded", async () => {
    const w = await world("TotalSeconds", {
      productOperations: [{ type: "Hem", operationCode: "HEM-9", machineType: "SNLS", totalSeconds: 90 }],
    });
    const a = await ieViewer(w.co);
    const detail = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    expect(detail.body.routes.product.rows[0].samMinutes).toBe(1.5);
    expect(detail.body.routes.product.totalSamMinutes).toBe(1.5);
  });
});

/* ══ 11. THE OPERATION MASTER ═════════════════════════════════════════════ */

describe("the operation library", () => {
  test("reports its own scope limitation rather than pretending to be scoped", async () => {
    const w = await world("Scope");
    const a = await ieViewer(w.co);
    const res = await call("/operations", { token: a.token, company: w.co._id });
    expect(res.body.scope.companyScoped).toBe(false);
    expect(res.body.scope.limitation).toBe("OPERATION_MASTER_NOT_COMPANY_SCOPED");
    expect(res.body.scope.message).toMatch(/global/i);
  });

  test("a duplicated code is AMBIGUOUS on every row that shares it, and none is canonical", async () => {
    const w = await world("Dupes");
    const first = await op("Side seam", "TS008");
    const second = await op("Side seam (both)", "TS008");
    await op("Hem", "HEM-U");
    const a = await ieViewer(w.co);

    const res = await call("/operations", { token: a.token, company: w.co._id });
    const rows = Object.fromEntries(res.body.rows.map((r) => [r.operationId, r]));

    for (const id of [String(first._id), String(second._id)]) {
      expect(rows[id].codeState).toBe("AMBIGUOUS");
      expect(rows[id].ambiguous).toBe(true);
      expect(rows[id].duplicateCodeCount).toBe(2);
    }
    /* Both are listed. Neither is dropped, merged or marked the real one. */
    expect(res.body.rows.filter((r) => r.code === "TS008")).toHaveLength(2);

    const unique = res.body.rows.find((r) => r.code === "HEM-U");
    expect(unique.codeState).toBe("UNIQUE");
    expect(unique.ambiguous).toBe(false);

    expect(res.body.ambiguity.duplicateCodes).toEqual(["TS008"]);
  });

  test("a duplicate split across pages is still a duplicate on page one", async () => {
    /* Detected over the whole register, not over the page — otherwise the same
       code reads as unique or ambiguous depending on how the caller paged. */
    const w = await world("DupePaged");
    await op("Aaa", "DUP-1");
    await op("Zzz", "DUP-1");
    const a = await ieViewer(w.co);
    const page = await call("/operations?limit=1", { token: a.token, company: w.co._id });
    expect(page.body.rows).toHaveLength(1);
    expect(page.body.rows[0].name).toBe("Aaa");
    expect(page.body.rows[0].codeState).toBe("AMBIGUOUS");
  });

  test("an uncoded operation is NOT_CODED rather than silently unique", async () => {
    const w = await world("Uncoded");
    await Operation.create({ name: "Nameless", machineType: "SNLS", totalSam: 1, durationSeconds: 60 });
    const a = await ieViewer(w.co);
    const res = await call("/operations", { token: a.token, company: w.co._id });
    expect(res.body.rows[0].codeState).toBe("NOT_CODED");
    expect(res.body.rows[0].ambiguous).toBe(false);
  });
});

/* ══ 12–13. THE TWO ROUTE SOURCES, AT THE WIRE ════════════════════════════ */

describe("the two legacy route sources are published separately and compared", () => {
  const scenario = async (name, { technical = [], product = [], linkProduct = true } = {}) => {
    const w = await world(name, {
      operations: technical.length ? technical : undefined,
      productOperations: product.length ? product : undefined,
      linkProduct,
    });
    const a = await ieViewer(w.co);
    const res = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    return { w, res };
  };

  test("MATCHED", async () => {
    const o1 = await op("A", "M-1");
    const { res } = await scenario("Matched", {
      technical: [techRow(o1._id, "M-1", "A", 1, 0)],
      product: [prodRow("M-1", "A", 1, 0)],
    });
    expect(res.body.comparison.state).toBe(STATE.MATCHED);
    /* Separate, and neither merged into the other. */
    expect(res.body.routes.technical.source).toBe("SAMPLE_STYLE_TECHNICAL_ROUTE");
    expect(res.body.routes.product.source).toBe("STOCK_ITEM_PRODUCT_ROUTE");
    expect(res.body.routes.technical.rows).toHaveLength(1);
    expect(res.body.routes.product.rows).toHaveLength(1);
  });

  test("DIFFERENT_TIME", async () => {
    const o1 = await op("A", "T-1");
    const { res } = await scenario("DiffTime", {
      technical: [techRow(o1._id, "T-1", "A", 1, 0)],
      product: [prodRow("T-1", "A", 2, 0)],
    });
    expect(res.body.comparison.state).toBe(STATE.DIFFERENT_TIME);
    expect(res.body.gaps.map((g) => g.code)).toContain("ROUTE_SOURCES_DISAGREE");
  });

  test("DIFFERENT_SEQUENCE", async () => {
    const [o1, o2] = [await op("A", "S-1"), await op("B", "S-2")];
    const { res } = await scenario("DiffSeq", {
      technical: [techRow(o1._id, "S-1", "A", 1, 0), techRow(o2._id, "S-2", "B", 1, 0)],
      product: [prodRow("S-2", "B", 1, 0), prodRow("S-1", "A", 1, 0)],
    });
    expect(res.body.comparison.state).toBe(STATE.DIFFERENT_SEQUENCE);
  });

  test("DIFFERENT_OPERATIONS", async () => {
    const o1 = await op("A", "O-1");
    const { res } = await scenario("DiffOps", {
      technical: [techRow(o1._id, "O-1", "A", 1, 0)],
      product: [prodRow("O-2", "B", 1, 0)],
    });
    expect(res.body.comparison.state).toBe(STATE.DIFFERENT_OPERATIONS);
  });

  test("ONLY_TECHNICAL_ROUTE", async () => {
    const o1 = await op("A", "OT-1");
    const { res } = await scenario("OnlyTech", { technical: [techRow(o1._id, "OT-1", "A", 1, 0)] });
    expect(res.body.comparison.state).toBe(STATE.ONLY_TECHNICAL_ROUTE);
    expect(res.body.gaps.map((g) => g.code)).toContain("PRODUCT_ROUTE_MISSING");
  });

  test("ONLY_PRODUCT_ROUTE", async () => {
    const { res } = await scenario("OnlyProduct", { product: [prodRow("OP-1", "A", 1, 0)] });
    expect(res.body.comparison.state).toBe(STATE.ONLY_PRODUCT_ROUTE);
    expect(res.body.gaps.map((g) => g.code)).toContain("TECHNICAL_ROUTE_MISSING");
  });

  test("NO_ROUTE", async () => {
    const { res } = await scenario("NoRoute", {});
    expect(res.body.comparison.state).toBe(STATE.NO_ROUTE);
  });

  test("AMBIGUOUS — a product row with no code cannot be matched", async () => {
    const o1 = await op("A", "AM-1");
    const { res } = await scenario("AmbigRows", {
      technical: [techRow(o1._id, "AM-1", "A", 1, 0)],
      product: [{ type: "A", machineType: "SNLS", minutes: 1, seconds: 0 }],
    });
    expect(res.body.comparison.state).toBe(STATE.AMBIGUOUS);
    expect(res.body.comparison.reason).toBe("ROWS_CANNOT_BE_MATCHED");
    expect(res.body.gaps.map((g) => g.code)).toContain("PRODUCT_OPERATION_CODE_MISSING");
  });

  test("AMBIGUOUS — a style naming two different products", async () => {
    const o1 = await op("A", "AM-2");
    const w = await world("TwoProducts", { operations: [techRow(o1._id, "AM-2", "A", 1, 0)] });
    const other = await StockItem.create({
      name: "Other", sku: `SKU-OTHER-${++seq}`, reference: `REF-OTHER-${seq}`,
      category: "Garment", createdBy: new mongoose.Types.ObjectId(),
      quantityOnHand: 0, minStock: 0, maxStock: 10,
      variants: [{ sku: `VAR-OTHER-${seq}`, cost: 0, salesPrice: 0 }],
    });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $set: { "production.stockItemId": other._id } });

    const a = await ieViewer(w.co);
    const res = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    expect(res.body.routes.product.linkState).toBe("AMBIGUOUS");
    expect(res.body.comparison.state).toBe(STATE.AMBIGUOUS);
    expect(res.body.comparison.reason).toBe("PRODUCT_SOURCE_NOT_IDENTIFIABLE");
  });

  test("a product that no longer exists is UNRESOLVED, not 'no product route'", async () => {
    const w = await world("DanglingProduct", { linkProduct: false });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $set: { sourceStockItemId: new mongoose.Types.ObjectId() } });
    const a = await ieViewer(w.co);
    const res = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    expect(res.body.routes.product.linkState).toBe("UNRESOLVED");
    expect(res.body.comparison.state).toBe(STATE.AMBIGUOUS);
  });

  test("every one of the eight states is reachable over HTTP", async () => {
    const seen = new Set();
    const o1 = await op("A", "E-1");
    const o2 = await op("B", "E-2");

    seen.add((await scenario("E-Matched", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0)], product: [prodRow("E-1", "A", 1, 0)],
    })).res.body.comparison.state);
    seen.add((await scenario("E-Time", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0)], product: [prodRow("E-1", "A", 3, 0)],
    })).res.body.comparison.state);
    seen.add((await scenario("E-Seq", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0), techRow(o2._id, "E-2", "B", 1, 0)],
      product: [prodRow("E-2", "B", 1, 0), prodRow("E-1", "A", 1, 0)],
    })).res.body.comparison.state);
    seen.add((await scenario("E-Ops", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0)], product: [prodRow("E-9", "Z", 1, 0)],
    })).res.body.comparison.state);
    seen.add((await scenario("E-OnlyTech", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0)],
    })).res.body.comparison.state);
    seen.add((await scenario("E-OnlyProd", { product: [prodRow("E-1", "A", 1, 0)] })).res.body.comparison.state);
    seen.add((await scenario("E-None", {})).res.body.comparison.state);
    seen.add((await scenario("E-Ambig", {
      technical: [techRow(o1._id, "E-1", "A", 1, 0)],
      product: [{ type: "A", machineType: "SNLS", minutes: 1 }],
    })).res.body.comparison.state);

    expect([...seen].sort()).toEqual([
      "AMBIGUOUS", "DIFFERENT_OPERATIONS", "DIFFERENT_SEQUENCE", "DIFFERENT_TIME",
      "MATCHED", "NO_ROUTE", "ONLY_PRODUCT_ROUTE", "ONLY_TECHNICAL_ROUTE",
    ]);
  });

  test("precedence: reordered AND retimed is reported as the order difference", async () => {
    const [o1, o2] = [await op("A", "P-1"), await op("B", "P-2")];
    const { res } = await scenario("Precedence", {
      technical: [techRow(o1._id, "P-1", "A", 1, 0), techRow(o2._id, "P-2", "B", 2, 0)],
      product: [prodRow("P-2", "B", 9, 0), prodRow("P-1", "A", 8, 0)],
    });
    expect(res.body.comparison.state).toBe(STATE.DIFFERENT_SEQUENCE);
    /* The rule order is published on the response, so a reader can see why
       this state won rather than the time difference that is also true. */
    expect(res.body.comparison.precedence[0]).toBe("PRODUCT_SOURCE_NOT_IDENTIFIABLE");
    expect(res.body.comparison.precedence.indexOf("SEQUENCE_DIFFERS"))
      .toBeLessThan(res.body.comparison.precedence.indexOf("STANDARD_TIME_DIFFERS"));
  });

  test("a technical row naming no registered operation is flagged, not hidden", async () => {
    const w = await world("Legacy", { linkProduct: false });
    /* `operationId` is schema-required on this array, so such a row can only
       reach the database through an older driver path. It is READ as it
       stands and named as legacy — never filtered out, never re-identified. */
    await SampleStyle.collection.updateOne(
      { _id: w.style._id },
      { $set: { "techSheet.technical.operations": [{ operationCode: "OLD-1", name: "Hand finish", minutes: 2, seconds: 0 }] } },
    );
    const a = await ieViewer(w.co);
    const res = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    expect(res.body.routes.technical.rows[0]).toMatchObject({
      operationId: null, operationCode: "OLD-1", name: "Hand finish", legacy: true, samMinutes: 2,
    });
    expect(res.body.gaps.map((g) => g.code)).toContain("OPERATION_NOT_IDENTIFIED");
  });
});

/* ══ THE OPERATION MASTER'S AMBIGUITY REACHES THE STYLE ═══════════════════ */

describe("a style whose routes name a duplicated master code", () => {
  /** Two registered operations sharing one code — the live TS008 case. */
  const duplicatePair = async (code) => [
    await op("Side seam", code),
    await op("Side seam (both sides)", code),
  ];

  const read = async (w) => {
    const a = await ieViewer(w.co);
    return call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
  };

  test("identical routes on a duplicated code are AMBIGUOUS, never MATCHED", async () => {
    /* Same code, same order, same time. Before this rule the answer was
       MATCHED — the strongest claim the comparison can make, resting on a key
       that names two different operations. */
    const [first] = await duplicatePair("TS008");
    const w = await world("DupMatched", {
      operations: [techRow(first._id, "TS008", "Side seam", 1, 0)],
      productOperations: [prodRow("TS008", "Side seam", 1, 0)],
    });

    const res = await read(w);
    expect(res.status).toBe(200);
    expect(res.body.comparison.state).toBe(STATE.AMBIGUOUS);
    expect(res.body.comparison.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
    expect(res.body.comparison.details.duplicatedCodes).toEqual(["TS008"]);

    /* And it is a typed gap pointing at the REGISTER, not at the routes —
       the routes are not what anybody has to change. */
    const gap = res.body.gaps.find((g) => g.code === "OPERATION_CODE_NOT_UNIQUE");
    expect(gap).toBeTruthy();
    expect(gap.owner).toBe("INDUSTRIAL_ENGINEERING");
    expect(gap.action).toBe("RECONCILE_OPERATION_REGISTER");
    expect(gap.message).toMatch(/more than one registered operation/i);
  });

  test("the same style reads MATCHED once the register holds the code once", async () => {
    /* The control. Identical fixture, one master record — so the rule is
       shown to be about the DUPLICATE and not about the code or the routes. */
    const only = await op("Side seam", "TS008");
    const w = await world("DupControl", {
      operations: [techRow(only._id, "TS008", "Side seam", 1, 0)],
      productOperations: [prodRow("TS008", "Side seam", 1, 0)],
    });
    const res = await read(w);
    expect(res.body.comparison.state).toBe(STATE.MATCHED);
    expect(res.body.gaps.map((g) => g.code)).not.toContain("OPERATION_CODE_NOT_UNIQUE");
  });

  test("case and padding in the stored code do not evade the check", async () => {
    /* The register's own rows, the technical route and the product route can
       each hold a different casing of one code. All three are normalised the
       same way, or the check silently passes. */
    const lower = await Operation.create({
      name: "Side seam", operationCode: " ts008 ", machineType: "SNLS",
      totalSam: 1, durationSeconds: 60,
    });
    await Operation.create({
      name: "Side seam (both)", operationCode: "Ts008", machineType: "SNLS",
      totalSam: 1, durationSeconds: 60,
    });
    const w = await world("DupCase", {
      operations: [techRow(lower._id, "ts008", "Side seam", 1, 0)],
      productOperations: [prodRow("TS008", "Side seam", 1, 0)],
    });

    const res = await read(w);
    expect(res.body.comparison.state).toBe(STATE.AMBIGUOUS);
    expect(res.body.comparison.reason).toBe("OPERATION_CODE_NOT_UNIQUE");
    expect(res.body.comparison.details.duplicatedCodes).toEqual(["TS008"]);
  });

  test("a duplicate elsewhere in the register leaves this style alone", async () => {
    /* The register holds a real duplicate — of a code these routes never
       name. One mistyped code must not make every style in the company
       ambiguous. */
    await duplicatePair("TS008");
    const mine = await op("Hem", "HEM-1");
    const w = await world("DupUnrelated", {
      operations: [techRow(mine._id, "HEM-1", "Hem", 1, 0)],
      productOperations: [prodRow("HEM-1", "Hem", 1, 0)],
    });

    const res = await read(w);
    expect(res.body.comparison.state).toBe(STATE.MATCHED);
    expect(res.body.comparison.reason).toBe("SOURCES_AGREE");
    expect(res.body.gaps.map((g) => g.code)).not.toContain("OPERATION_CODE_NOT_UNIQUE");

    /* The library still reports the duplicate, because that IS its question. */
    const a = await ieViewer(w.co);
    const ops = await call("/operations", { token: a.token, company: w.co._id });
    expect(ops.body.ambiguity.duplicateCodes).toEqual(["TS008"]);
  });

  test("unique codes keep every existing comparison result", async () => {
    /* All four content states, re-proved with a live duplicate sitting in the
       register beside them. */
    await duplicatePair("TS008");
    const [a1, b1] = [await op("A", "U-1"), await op("B", "U-2")];

    const cases = [
      ["UniqMatched", [techRow(a1._id, "U-1", "A", 1, 0)], [prodRow("U-1", "A", 1, 0)], STATE.MATCHED],
      ["UniqTime", [techRow(a1._id, "U-1", "A", 1, 0)], [prodRow("U-1", "A", 3, 0)], STATE.DIFFERENT_TIME],
      ["UniqSeq",
        [techRow(a1._id, "U-1", "A", 1, 0), techRow(b1._id, "U-2", "B", 1, 0)],
        [prodRow("U-2", "B", 1, 0), prodRow("U-1", "A", 1, 0)], STATE.DIFFERENT_SEQUENCE],
      ["UniqOps", [techRow(a1._id, "U-1", "A", 1, 0)], [prodRow("U-9", "Z", 1, 0)], STATE.DIFFERENT_OPERATIONS],
    ];

    for (const [name, operations, productOperations, expected] of cases) {
      const w = await world(name, { operations, productOperations });
      const res = await read(w);
      expect(res.body.comparison.state).toBe(expected);
    }
  });

  test("the worklist reports the same state, and one style's duplicate does not spread", async () => {
    /* Two styles in one company on one page: one names the duplicated code,
       the other does not. The page's register lookup is shared; the ambiguity
       must not be. */
    const [dup] = await duplicatePair("TS008");
    const clean = await op("Hem", "HEM-2");
    const co = await Acc_Company.create({
      companyName: `DupPage ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const journey = await SalesJourney.create({
      journeyId: `SJ-DP-${seq}`, companyId: co._id, accountId: new mongoose.Types.ObjectId(),
      ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: "J", isActive: true,
    });

    const make = async (label, operationId, code) => {
      const product = await StockItem.create({
        name: `Tee ${label}`, sku: `SKU-DP-${label}-${seq}`, reference: `REF-DP-${label}-${seq}`,
        category: "Garment", createdBy: new mongoose.Types.ObjectId(),
        quantityOnHand: 0, minStock: 0, maxStock: 10,
        variants: [{ sku: `VAR-DP-${label}-${seq}`, cost: 0, salesPrice: 0 }],
        operations: [prodRow(code, "Op", 1, 0)],
      });
      return SampleStyle.create({
        sampleStyleId: `SS-DP-${seq}-${label}`, productName: `Tee ${label}`,
        styleCode: `ST-DP-${label}`, journeyId: journey._id, sourceStockItemId: product._id,
        materials: { status: "pending", rawItems: [] },
        techSheet: { technical: { status: "draft", operations: [techRow(operationId, code, "Op", 1, 0)] } },
      });
    };
    await make("DUP", dup._id, "TS008");
    await make("CLEAN", clean._id, "HEM-2");

    const a = await ieViewer(co);
    const list = await call("/styles", { token: a.token, company: co._id });
    expect(list.status).toBe(200);
    const byRef = Object.fromEntries(list.body.rows.map((r) => [r.reference, r]));

    expect(byRef["ST-DP-DUP"].comparisonState).toBe(STATE.AMBIGUOUS);
    expect(byRef["ST-DP-DUP"].gaps.map((g) => g.code)).toContain("OPERATION_CODE_NOT_UNIQUE");
    /* The neighbour on the same page is untouched. */
    expect(byRef["ST-DP-CLEAN"].comparisonState).toBe(STATE.MATCHED);
    expect(byRef["ST-DP-CLEAN"].gaps.map((g) => g.code)).not.toContain("OPERATION_CODE_NOT_UNIQUE");
  });

  test("a one-sided route on a duplicated code stays a presence state", async () => {
    /* Presence outranks the duplicate: with no second route there is nothing
       the ambiguous code could be confused WITH. */
    const [dup] = await duplicatePair("TS008");
    const w = await world("DupOneSided", {
      operations: [techRow(dup._id, "TS008", "Side seam", 1, 0)],
      linkProduct: false,
    });
    const res = await read(w);
    expect(res.body.comparison.state).toBe(STATE.ONLY_TECHNICAL_ROUTE);
  });

  test("reading a style with a duplicated code still writes nothing", async () => {
    /* The register is consulted, never reconciled: no canonical record is
       chosen, nothing is merged, and neither operation is touched. */
    const [first, second] = await duplicatePair("TS008");
    const w = await world("DupReadOnly", {
      operations: [techRow(first._id, "TS008", "Side seam", 1, 0)],
      productOperations: [prodRow("TS008", "Side seam", 1, 0)],
    });
    const a = await ieViewer(w.co);
    const before = await Operation.find({ operationCode: "TS008" }).sort({ _id: 1 }).lean();

    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "bulkWrite", "deleteOne", "deleteMany"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];
    try {
      await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
      await call("/styles", { token: a.token, company: w.co._id });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    /* Both master records survive, unchanged and unranked. */
    const after = await Operation.find({ operationCode: "TS008" }).sort({ _id: 1 }).lean();
    expect(after).toEqual(before);
    expect(after.map((o) => String(o._id))).toEqual([first, second].map((o) => String(o._id)).sort());
  });
});

/* ══ 14–15. SEARCH AND PAGING ═════════════════════════════════════════════ */

describe("literal search", () => {
  test("regular-expression characters are matched literally, never compiled", async () => {
    const w = await world("Search");
    await op("Bar tack (heavy)", "BT-1");
    await op("Bar tack heavy", "BT-2");
    await op("Hem", "HM-1");
    const a = await ieViewer(w.co);

    const res = await call(`/operations?q=${encodeURIComponent("tack (heavy)")}`,
      { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.code)).toEqual(["BT-1"]);
  });

  test("a term that would be a broken pattern is an ordinary empty result", async () => {
    const w = await world("SearchBad");
    await op("Hem", "HM-2");
    const a = await ieViewer(w.co);
    for (const term of ["(", "[a-", "*", "\\", ".*", "a{2,"]) {
      const res = await call(`/operations?q=${encodeURIComponent(term)}`,
        { token: a.token, company: w.co._id });
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([]);
    }
  });

  test("a dot does not match every character", async () => {
    const w = await world("SearchDot");
    await op("A.B", "DOT-1");
    await op("AXB", "DOT-2");
    const a = await ieViewer(w.co);
    const res = await call(`/operations?q=${encodeURIComponent("A.B")}`,
      { token: a.token, company: w.co._id });
    expect(res.body.rows.map((r) => r.code)).toEqual(["DOT-1"]);
  });
});

describe("pagination is bounded and stable", () => {
  test("the operation library pages without skipping or repeating a row", async () => {
    const w = await world("PageOps");
    for (const n of ["A", "B", "C", "D", "E"]) await op(`Op ${n}`, `PG-${n}`);
    const a = await ieViewer(w.co);

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const res = await call(`/operations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: a.token, company: w.co._id });
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(2);
      expect(res.body.rows.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.rows.map((r) => r.code));
      cursor = res.body.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toEqual(["PG-A", "PG-B", "PG-C", "PG-D", "PG-E"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the style worklist pages the same way", async () => {
    const co = await Acc_Company.create({
      companyName: `PageStyles ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    const journey = await SalesJourney.create({
      journeyId: `SJ-PS-${seq}`, companyId: co._id, accountId: new mongoose.Types.ObjectId(),
      ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: "J", isActive: true,
    });
    for (const n of [1, 2, 3]) {
      await SampleStyle.create({
        /* `{journeyId, productName, variantKey}` is uniquely indexed, so three
           styles under one journey need three product names. */
        sampleStyleId: `SS-PS-${seq}-${n}`, productName: `Tee ${n}`, styleCode: `ST-PS-${n}`,
        journeyId: journey._id, materials: { status: "pending", rawItems: [] },
        techSheet: { technical: { status: "draft" } },
      });
    }
    const a = await ieViewer(co);

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const res = await call(`/styles?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: a.token, company: co._id });
      expect(res.status).toBe(200);
      expect(res.body.sort).toBe("updatedAt:desc,_id:desc");
      seen.push(...res.body.rows.map((r) => r.reference));
      cursor = res.body.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen.sort()).toEqual(["ST-PS-1", "ST-PS-2", "ST-PS-3"]);
  });

  test("an oversized limit is bounded, and the bound is published", async () => {
    const w = await world("Bounded");
    const a = await ieViewer(w.co);
    for (const path of ["/styles?limit=100000", "/operations?limit=100000"]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(200);
      /* Capped, and it SAYS so — a silent cap reads as "that is all of them". */
      expect(res.body.limit).toBe(100);
      expect(res.body.hasMore).toBe(false);
      expect(res.body).toHaveProperty("nextCursor");
    }
  });

  test("a nonsense limit or page marker is refused by name, never ignored", async () => {
    const w = await world("BadPaging");
    const a = await ieViewer(w.co);
    for (const path of [
      "/styles?limit=0", "/styles?limit=-1", "/styles?limit=abc", "/styles?limit=2.5",
      "/operations?limit=0", "/styles?cursor=nonsense", "/operations?cursor=nonsense",
    ]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(400);
      expect(res.body.error?.code || res.body.code).toBe("VALIDATION");
    }
  });

  test("a page marker cannot reach another company's styles", async () => {
    const mine = await world("CursorMine");
    const theirs = await world("CursorTheirs");
    const a = await ieViewer(mine.co);
    /* A marker is a POSITION, not a filter. Forged with another company's
       style id, it moves the caller inside their own bounded list. */
    const forged = Buffer.from(JSON.stringify({ t: Date.now() + 1e6, i: String(theirs.style._id) }), "utf8")
      .toString("base64url");
    const res = await call(`/styles?cursor=${encodeURIComponent(forged)}`,
      { token: a.token, company: mine.co._id });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.reference)).toEqual(["ST-CursorMine"]);
  });
});

/* ══ 16. A READ WRITES NOTHING ════════════════════════════════════════════ */

describe("nothing is written, migrated or backfilled by a read", () => {
  test("no mutation path on any model is reached", async () => {
    const o1 = await op("A", "MUT-1");
    const w = await world("Mutation", {
      operations: [techRow(o1._id, "MUT-1", "A", 1, 0)],
      productOperations: [prodRow("MUT-1", "A", 2, 0)],
    });
    const a = await ieViewer(w.co);

    /* Spies installed AFTER every fixture exists, so only the reads are
       measured. Every verb mongoose offers, not a chosen few. */
    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate",
        "findOneAndReplace", "replaceOne", "bulkWrite", "insertMany", "create",
        "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];

    try {
      for (const path of [
        "/styles", `/styles/${w.style._id}`, "/operations", "/operations?q=A",
        `/styles/${new mongoose.Types.ObjectId()}`,
      ]) {
        const res = await call(path, { token: a.token, company: w.co._id });
        expect([200, 404]).toContain(res.status);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("the stored records are byte-for-byte unchanged afterwards", async () => {
    const o1 = await op("A", "UNCH-1");
    const w = await world("Unchanged", {
      operations: [techRow(o1._id, "UNCH-1", "A", 1, 0)],
      productOperations: [prodRow("UNCH-1", "A", 2, 0)],
    });
    const a = await ieViewer(w.co);

    const before = {
      style: await SampleStyle.findById(w.style._id).lean(),
      product: await StockItem.findById(w.product._id).lean(),
      operation: await Operation.findById(o1._id).lean(),
    };

    await call("/styles", { token: a.token, company: w.co._id });
    await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });
    await call("/operations", { token: a.token, company: w.co._id });

    expect(await SampleStyle.findById(w.style._id).lean()).toEqual(before.style);
    expect(await StockItem.findById(w.product._id).lean()).toEqual(before.product);
    expect(await Operation.findById(o1._id).lean()).toEqual(before.operation);
  });
});
