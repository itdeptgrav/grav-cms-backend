// test/production/embroidery-floor-access.route.test.js
//
// EMBROIDERY'S FLOOR — WHO, WHICH COMPANY, WHICH WORK, AND WHOSE HANDS.
//
// The Embroidery router mounted as server.js mounts it, with the employee
// authentication it inherits from the earlier /api/cms mount simulated the
// same way. Pinned:
//
//   · no session → 401; another department, and a PPC grant, → 403; a viewer
//     reads and cannot scan; an editor scans;
//   · a work order linked to ANOTHER company is absent from the queue, the
//     order read, the records and the barcode — answered like one that does
//     not exist, and it cannot be scanned;
//   · a historical work order with no Sales-line link is nobody's: hidden,
//     unscannable, and never given a company from its style, buyer, number,
//     barcode prefix or product name;
//   · the operator is resolved from the employee record — a forged name,
//     identity id or work-order detail in the body is not stored — and the
//     signed-in station is recorded separately as the submitter;
//   · an unknown or inactive badge is refused;
//   · the printed barcode format is unchanged, and a duplicate scan stays
//     idempotent without inflating the count;
//   · a scan writes no PPC response, capacity booking, Production release or
//     another department's actual.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const EmbroideryRecord = require("../../models/CMS_Models/Manufacturing/Embroidery/EmbroideryRecord");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

let http, base, seq = 0;
const ROOT = "/api/cms/manufacturing/embroidery";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* As server.js does: /api/cms carries employee authentication, and the
     Embroidery router is mounted behind it. */
  app.use("/api/cms", EmployeeAuthMiddleware, (req, res, next) => next());
  app.use(ROOT, require("../../routes/CMS_Routes/Manufacturing/Embroidery/embroideryRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

const call = (path, { token, method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A signed-in person: `dept` is their department session, `grants` live rows. */
async function person({ companies = [], dept = "embroidery", role = "embroidery", grants = {}, name = "Emb" } = {}) {
  const n = ++seq;
  const email = `emb${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `E${n}`, email, biometricId: `EMB${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Embroidery", designation: "Operator" });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name, role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return { emp, email,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} E${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

/** A floor operator: an employee with a badge, and no system session at all. */
async function operator({ active = true, companies = [] } = {}) {
  const n = ++seq;
  const email = `op${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: "Asha", middleName: "K", lastName: `Op${n}`, email,
    biometricId: `OP${n}${Date.now()}`, identityId: `ID-${n}`, isActive: active, gender: "Female",
    department: "Embroidery", designation: "Machine operator" });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Asha" });
  return emp;
}

const company = async (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01") });
const barcodeFor = (woId, unit = 1) => `WO-${String(woId).slice(16, 24)}-${String(unit).padStart(3, "0")}`;

/** An approved order with one work order: linked to `linkCompany`, or historical. */
async function order(label, linkCompany, { quantity = 5 } = {}) {
  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-EMB-${++seq}`, reference: `REF-EMB-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 9,
    variants: [{ sku: `VE-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  const mo = await CustomerRequest.create({ requestId: `CR-EMB-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: `Buyer ${label}` }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  const saved = await CustomerRequest.findById(mo._id).lean();
  const wo = await WorkOrder.create({
    customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name, quantity, status: "in_progress",
    variantAttributes: [{ name: "Size", value: "M" }],
    ...(linkCompany ? { salesLineLink: { companyId: linkCompany._id, customerRequestId: mo._id,
      lineRef: saved.items[0].lineRef || `LN-${crypto.randomBytes(6).toString("hex")}`,
      basis: "sales_line", linkedAt: new Date() } } : {}),
  });
  return { item, mo, wo };
}

/** Two companies; ours has a linked and a historical order, theirs a linked one. */
async function world(label) {
  const mine = await company(`${label}Mine`);
  const theirs = await company(`${label}Theirs`);
  return {
    mine, theirs,
    linked: await order(`${label}L`, mine),
    historical: await order(`${label}H`, null),
    foreign: await order(`${label}F`, theirs),
    editor: await person({ companies: [mine] }),
    op: await operator(),
  };
}

const scan = (w, wo, unit, who = w.editor, over = {}) => call("/scan", { token: who.token, method: "POST",
  body: { barcode: barcodeFor(wo._id, unit), operatorBiometricId: w.op.biometricId, ...over } });

/* ══ WHO MAY USE IT ═══════════════════════════════════════════════════════ */

describe("who may use Embroidery's floor", () => {
  test("no session: 401 on every path", async () => {
    const w = await world("EmbNoSession");
    for (const [path, opts] of [["/queue", {}], ["/records", {}], ["/overview", {}],
      ["/signin", { method: "POST", body: { biometricId: w.op.biometricId } }],
      ["/scan", { method: "POST", body: { barcode: barcodeFor(w.linked.wo._id), operatorBiometricId: w.op.biometricId } }]]) {
      expect((await call(path, opts)).status).toBe(401);
    }
  });

  test("another department, and a PPC grant, are refused everywhere", async () => {
    const w = await world("EmbOtherDept");
    for (const who of [
      await person({ companies: [w.mine], dept: "sales", role: "sales" }),
      await person({ companies: [w.mine], dept: "ppc", role: "ppc", grants: { ppc: "owner" } }),
    ]) {
      expect((await call("/queue", { token: who.token })).status).toBe(403);
      expect((await call("/records", { token: who.token })).status).toBe(403);
      expect((await scan(w, w.linked.wo, 1, who)).status).toBe(403);
    }
    expect(await EmbroideryRecord.countDocuments({})).toBe(0);
  });

  test("once Embroidery grants exist: a viewer reads and cannot scan; an editor scans", async () => {
    const w = await world("EmbGrants");
    const viewer = await person({ companies: [w.mine], dept: "hr", role: "hr_manager", grants: { embroidery: "viewer" } });
    const editor = await person({ companies: [w.mine], dept: "hr", role: "hr_manager", grants: { embroidery: "editor" } });
    const ungranted = await person({ companies: [w.mine] }); // an Embroidery session, but grants now exist

    expect((await call("/queue", { token: viewer.token })).status).toBe(200);
    expect((await call("/overview", { token: viewer.token })).status).toBe(200);
    const refused = await scan(w, w.linked.wo, 1, viewer);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");
    expect((await scan(w, w.linked.wo, 1, editor)).status).toBe(200);
    expect((await call("/queue", { token: ungranted.token })).status).toBe(403);
  });
});

/* ══ WHICH COMPANY'S WORK ═════════════════════════════════════════════════ */

describe("another company's work, and work nobody can prove", () => {
  test("the queue and the order read hold this company's linked work only", async () => {
    const w = await world("EmbQueue");
    const t = { token: w.editor.token };
    const queue = await call("/queue", t);
    expect(queue.status).toBe(200);
    const numbers = JSON.stringify(queue.body.orders || []);
    expect(numbers).toContain(String(w.linked.wo.workOrderNumber));
    expect(numbers).not.toContain(String(w.foreign.wo.workOrderNumber));
    expect(numbers).not.toContain(String(w.historical.wo.workOrderNumber));

    const ours = await call(`/manufacturing-orders/${w.linked.mo._id}`, t);
    expect(ours.status).toBe(200);
    for (const mo of [w.foreign.mo, w.historical.mo]) {
      const res = await call(`/manufacturing-orders/${mo._id}`, t);
      expect(res.status).toBe(200);
      expect(res.body.workOrders || []).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(String(mo.requestId));
    }
  });

  test("their barcode cannot be scanned, and says only that it is not found", async () => {
    const w = await world("EmbForeign");
    const res = await scan(w, w.foreign.wo, 1);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(String(w.foreign.wo.workOrderNumber));
    expect(JSON.stringify(res.body)).not.toContain(String(w.foreign.item.name));
    expect(await EmbroideryRecord.countDocuments({})).toBe(0);
  });

  test("a historical unlinked work order is nobody's: hidden, unscannable, still unlinked", async () => {
    const w = await world("EmbHistorical");
    const theirEditor = await person({ companies: [w.theirs] });
    for (const who of [w.editor, theirEditor]) {
      const res = await scan(w, w.historical.wo, 1, who);
      expect(res.status).toBe(404);
      const queue = await call("/queue", { token: who.token });
      expect(JSON.stringify(queue.body.orders || [])).not.toContain(String(w.historical.wo.workOrderNumber));
    }
    expect((await WorkOrder.findById(w.historical.wo._id).lean()).salesLineLink).toBeUndefined();
    expect(await EmbroideryRecord.countDocuments({})).toBe(0);
  });

  test("records and the day's counts hold only this company's pieces", async () => {
    const w = await world("EmbRecords");
    expect((await scan(w, w.linked.wo, 1)).status).toBe(200);
    /* A record of the other company's work, written directly as an older
       build would have. */
    await EmbroideryRecord.create({ date: new Date().toISOString().slice(0, 10),
      barcodeId: barcodeFor(w.foreign.wo._id, 1), workOrderShortId: String(w.foreign.wo._id).slice(16, 24),
      unitNumber: 1, workOrderId: w.foreign.wo._id, companyId: w.theirs._id,
      productName: w.foreign.item.name, operatorName: "Their operator", operatorBiometricId: "THEIRS-1" });

    const res = await call("/records?from=2000-01-01&to=2100-01-01", { token: w.editor.token });
    expect(res.status).toBe(200);
    expect(res.body.records.map((r) => r.barcodeId)).toEqual([barcodeFor(w.linked.wo._id, 1)]);
    expect(JSON.stringify(res.body)).not.toContain("Their operator");
    expect(res.body.operators.map((o) => o.count)).toEqual([1]);

    const theirs = await call("/records?from=2000-01-01&to=2100-01-01",
      { token: (await person({ companies: [w.theirs] })).token });
    expect(theirs.body.records.map((r) => r.operatorName)).toEqual(["Their operator"]);
  });
});

/* ══ WHOSE HANDS, AND WHO SENT IT ═════════════════════════════════════════ */

describe("the operator is resolved, not typed", () => {
  test("a forged name, identity and product are ignored; both identities are recorded", async () => {
    const w = await world("EmbForged");
    const res = await scan(w, w.linked.wo, 2, w.editor, {
      operatorName: "Somebody Else", operatorIdentityId: "FAKE-9",
      productName: "Forged product", workOrderNumber: "WO-FORGED", unitNumber: 99, companyId: String(w.theirs._id),
    });
    expect(res.status).toBe(200);

    const stored = await EmbroideryRecord.findOne({ barcodeId: barcodeFor(w.linked.wo._id, 2) }).lean();
    expect(stored.operatorName).toBe(`Asha K ${w.op.lastName}`);
    expect(stored.operatorIdentityId).toBe(w.op.identityId);
    expect(String(stored.operatorEmployeeId)).toBe(String(w.op._id));
    expect(stored.productName).toBe(w.linked.item.name);
    expect(stored.unitNumber).toBe(2);
    expect(String(stored.companyId)).toBe(String(w.mine._id));
    expect(stored.orderLineRef).toBe(w.linked.wo.salesLineLink.lineRef);
    /* The station that sent it, kept apart from the hands that did it. */
    expect(String(stored.submittedBy.id)).toBe(String(w.editor.emp._id));
    expect(JSON.stringify(stored)).not.toMatch(/Somebody Else|FAKE-9|Forged product|WO-FORGED/);
  });

  test("an unknown badge, an inactive one, and another company's operator are refused", async () => {
    const w = await world("EmbBadge");
    const inactive = await operator({ active: false });
    const elsewhere = await operator({ companies: [w.theirs] });

    const unknown = await scan(w, w.linked.wo, 1, w.editor, { operatorBiometricId: "NOBODY-1" });
    expect(unknown.status).toBe(404);
    const off = await scan(w, w.linked.wo, 1, w.editor, { operatorBiometricId: inactive.biometricId });
    expect(off.status).toBe(403);
    const foreignOp = await scan(w, w.linked.wo, 1, w.editor, { operatorBiometricId: elsewhere.biometricId });
    expect(foreignOp.status).toBe(404);
    expect(await EmbroideryRecord.countDocuments({})).toBe(0);

    /* Sign-in answers the same way, and says whether the company was proved. */
    const signin = await call("/signin", { token: w.editor.token, method: "POST", body: { biometricId: w.op.biometricId } });
    expect(signin.status).toBe(200);
    expect(signin.body.operator).toMatchObject({ biometricId: w.op.biometricId, companyProof: "unproven" });
    expect((await call("/signin", { token: w.editor.token, method: "POST", body: { biometricId: elsewhere.biometricId } })).status).toBe(404);
  });
});

/* ══ WHAT MUST NOT CHANGE ═════════════════════════════════════════════════ */

describe("the floor keeps working exactly as it did", () => {
  test("the printed barcode format is unchanged, and the piece reads as before", async () => {
    const w = await world("EmbBarcode");
    const res = await scan(w, w.linked.wo, 1);
    expect(res.status).toBe(200);
    expect(res.body.piece).toMatchObject({
      barcodeId: barcodeFor(w.linked.wo._id, 1), unitNumber: 1, totalPieces: 5,
      workOrderShortId: String(w.linked.wo._id).slice(16, 24), productName: w.linked.item.name,
    });
    expect(res.body.progress).toMatchObject({ done: 1, total: 5, remaining: 4, nextUnit: 2 });
    expect(res.body.progress.nextBarcode).toBe(barcodeFor(w.linked.wo._id, 2));
    expect(res.body.progress.nextBarcode).toMatch(/^WO-[0-9a-f]{8}-\d{3}$/);
    /* A malformed barcode still explains the expected shape. */
    const bad = await call("/scan", { token: w.editor.token, method: "POST",
      body: { barcode: "NOT-A-BARCODE", operatorBiometricId: w.op.biometricId } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/WO-<id>-<piece>/);
  });

  test("a duplicate scan is idempotent and does not inflate the count", async () => {
    const w = await world("EmbDuplicate");
    const first = await scan(w, w.linked.wo, 3);
    const second = await scan(w, w.linked.wo, 3);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body.created).toBe(true);
    expect(second.body).toMatchObject({ created: false, alreadyDone: true });
    expect(second.body.record.barcodeId).toBe(first.body.record.barcodeId);
    expect(second.body.progress.done).toBe(1);
    expect(second.body.today.piecesDone).toBe(1);
    expect(await EmbroideryRecord.countDocuments({ workOrderId: w.linked.wo._id })).toBe(1);
  });

  test("a scan writes no PPC answer, no booking, no release and no other department's actual", async () => {
    const w = await world("EmbNoSideEffects");
    const before = await snapshotOutside();
    expect((await scan(w, w.linked.wo, 1)).status).toBe(200);

    const wo = await WorkOrder.findById(w.linked.wo._id).lean();
    expect(wo.cuttingProgress?.completed || 0).toBe(0);
    expect(wo.status).toBe("in_progress");
    expect(await snapshotOutside()).toEqual(before);
  });
});

/** Every collection except Embroidery's own record book. */
async function snapshotOutside() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (name === "embroideryrecords" || name.startsWith("system.")) continue;
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex");
  }
  return out;
}
