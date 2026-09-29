// test/production/cutting-queue-access.route.test.js
//
// CUTTING'S WORK QUEUE AND CUT RECORDING — WHO, WHICH COMPANY, WHICH WORK.
//
// The Cutting routers mounted exactly as server.js mounts them. Pinned:
//
//   · no session → 401; another department → 403, on the queue and on every
//     recording path; a Cutting session (or, once grants exist, a Cutting
//     grant) is admitted; PPC access is not Cutting access;
//   · a WorkOrder linked to ANOTHER company is absent everywhere — queue,
//     order detail, WorkOrder view, recording, barcodes — answered like an id
//     that does not exist, and nothing about it is changed;
//   · a WorkOrder linked to this company works as before and says `linked`;
//   · a historical WorkOrder with no Sales-line link is nobody's: NEITHER
//     company can see or change it, and it is never given a company from its
//     style, customer or number;
//   · the "who cut these units?" record takes the cutter's identity from the
//     employee record and the recorder from the session — a forged name,
//     department or WorkOrder number in the body is not stored;
//   · the project manager's read of an order keeps working, company-scoped.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Measurement = require("../../models/Customer_Models/Measurement");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");

let http, base, seq = 0;
const ROOT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* As server.js mounts them. */
  app.use(ROOT, require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes"));
  app.use(ROOT, require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes"));
  app.use(ROOT, require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/bulkCuttingRoutes.js"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

const call = (path, { token, method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A signed-in person: `dept` is their department session; `grants` live DepartmentRole rows. */
async function person({ companies = [], dept = "cutting-master", role = "cutting_master", grants = {}, name = null } = {}) {
  const n = ++seq;
  const email = `cq${n}@grav.test`;
  const emp = await Employee.create({ firstName: name || "Cutter", lastName: `N${n}`, email, biometricId: `CQ${n}`,
    isActive: true, gender: "Other", department: "Cutting", designation: "Cutting master" });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name: "P", role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return { emp, token: jwt.sign({ id: String(emp._id), email, name: `${name || "Cutter"} N${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

const company = async (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01") });
const lineRef = () => `LN-${(++seq).toString(16).padStart(12, "0")}`;

/** An approved order with one WorkOrder: linked to `linkCompany`, or historical (no link) when null. */
async function order(label, linkCompany, { measured = false } = {}) {
  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-CQ-${++seq}`, reference: `REF-CQ-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 10,
    numberOfPanels: 2, variants: [{ sku: `V-CQ-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  const mo = await CustomerRequest.create({ requestId: `CR-CQ-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: `Buyer ${label}` }, status: "quotation_sales_approved",
    ...(measured ? { requestType: "measurement_conversion" } : {}),
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: 10 }] });
  const saved = await CustomerRequest.findById(mo._id).lean();
  const wo = await WorkOrder.create({
    customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name, quantity: 10, status: "in_progress",
    variantId: String(item.variants[0]._id), variantAttributes: [{ name: "Size", value: "M" }],
    ...(linkCompany ? { salesLineLink: { companyId: linkCompany._id, customerRequestId: mo._id,
      lineRef: saved.items[0].lineRef || lineRef(), basis: "sales_line", linkedAt: new Date() } } : {}),
  });
  let measurement = null;
  if (measured) {
    measurement = await Measurement.create({ organizationId: new mongoose.Types.ObjectId(), organizationName: "Org",
      name: `M-${++seq}`, poRequestId: mo._id, createdBy: new mongoose.Types.ObjectId(),
      employeeMeasurements: [{ employeeId: new mongoose.Types.ObjectId(), employeeName: "Asha", employeeUIN: `U${seq}`, gender: "female",
        products: [{ productId: item._id, productName: item.name, quantity: 1, measurements: [] }] }] });
  }
  return { item, mo, wo, measurement };
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
    cutter: await person({ companies: [mine] }),
  };
}

/* ══ WHO MAY USE IT ═══════════════════════════════════════════════════════ */

describe("who may use Cutting's queue", () => {
  test("no session: 401 on the queue and on recording", async () => {
    const w = await world("NoSession");
    expect((await call("/manufacturing-orders")).status).toBe(401);
    expect((await call(`/work-orders/${w.linked.wo._id}/update-cutting`, { method: "POST", body: { quantityCut: 1 } })).status).toBe(401);
  });

  test("another department, even with a membership in this company, is refused on every path — and so is PPC", async () => {
    const w = await world("OtherDept");
    for (const who of [
      await person({ companies: [w.mine], dept: "sales", role: "sales" }),
      await person({ companies: [w.mine], dept: "ppc", role: "ppc", grants: { ppc: "owner" } }),
    ]) {
      const t = { token: who.token };
      expect((await call("/manufacturing-orders", t)).status).toBe(403);
      expect((await call(`/work-orders/${w.linked.wo._id}/bulk-cutting`, t)).status).toBe(403);
      expect((await call(`/work-orders/${w.linked.wo._id}/update-cutting`, { ...t, method: "POST", body: { quantityCut: 1 } })).status).toBe(403);
      expect((await call(`/work-orders/${w.linked.wo._id}/generate-bulk-barcodes`, { ...t, method: "POST", body: { quantityToGenerate: 1 } })).status).toBe(403);
      expect((await call("/cutting-master-records", { ...t, method: "POST", body: { employeeId: String(w.cutter.emp._id), woId: String(w.linked.wo._id), quantityCut: 1 } })).status).toBe(403);
    }
    expect((await WorkOrder.findById(w.linked.wo._id).lean()).cuttingProgress?.completed || 0).toBe(0);
  });

  test("once Cutting grants exist, a Cutting grant is needed; a viewer may read and not record", async () => {
    const w = await world("Grants");
    const editor = await person({ companies: [w.mine], dept: "hr", role: "hr_manager", grants: { "cutting-master": "editor" } });
    const viewer = await person({ companies: [w.mine], grants: { "cutting-master": "viewer" } });
    const ungranted = await person({ companies: [w.mine] }); // a Cutting session, but grants now exist
    expect((await call("/manufacturing-orders", { token: editor.token })).status).toBe(200);
    expect((await call("/manufacturing-orders", { token: viewer.token })).status).toBe(200);
    expect((await call(`/work-orders/${w.linked.wo._id}/update-cutting`, { token: viewer.token, method: "POST", body: { quantityCut: 1 } })).status).toBe(403);
    expect((await call(`/work-orders/${w.linked.wo._id}/update-cutting`, { token: editor.token, method: "POST", body: { quantityCut: 1 } })).status).toBe(200);
    expect((await call("/manufacturing-orders", { token: ungranted.token })).status).toBe(403);
  });
});

/* ══ WHICH COMPANY'S WORK ═════════════════════════════════════════════════ */

describe("another company's work is absent, and unchanged", () => {
  test("the queue lists only this company's linked orders — not theirs, and not an unprovable one", async () => {
    const w = await world("Queue");
    const res = await call("/manufacturing-orders", { token: w.cutter.token });
    expect(res.status).toBe(200);
    const ids = res.body.manufacturingOrders.map((o) => String(o._id));
    expect(ids).toContain(String(w.linked.mo._id));
    expect(ids).not.toContain(String(w.foreign.mo._id));
    expect(ids).not.toContain(String(w.historical.mo._id));
  });

  test("their order, their WorkOrder, and every recording path answer 404 and change nothing", async () => {
    const w = await world("Foreign");
    const t = { token: w.cutter.token };
    const id = w.foreign.wo._id;
    expect((await call(`/manufacturing-orders/${w.foreign.mo._id}`, t)).status).toBe(404);
    expect((await call(`/work-orders/${id}/bulk-cutting`, t)).status).toBe(404);
    expect((await call(`/work-orders/${id}/employee-measurements`, t)).status).toBe(404);
    expect((await call(`/work-orders/${id}/update-cutting`, { ...t, method: "POST", body: { quantityCut: 5 } })).status).toBe(404);
    expect((await call(`/work-orders/${id}/generate-bulk-barcodes`, { ...t, method: "POST", body: { quantityToGenerate: 1 } })).status).toBe(404);
    const rec = await call("/cutting-master-records", { ...t, method: "POST",
      body: { employeeId: String(w.cutter.emp._id), woId: String(id), quantityCut: 5 } });
    expect(rec.status).toBe(404);
    expect(JSON.stringify(rec.body)).not.toContain(w.foreign.wo.workOrderNumber);
    const after = await WorkOrder.findById(id).lean();
    expect(after.cuttingProgress?.completed || 0).toBe(0);
    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
  });

  test("a measurement order of theirs cannot be read or marked cut", async () => {
    const mine = await company("MeasMine");
    const theirs = await company("MeasTheirs");
    const cutter = await person({ companies: [mine] });
    const f = await order("MeasF", theirs, { measured: true });
    const t = { token: cutter.token };
    expect((await call(`/manufacturing-orders/${f.mo._id}/search-employees`, t)).status).toBe(404);
    const emp = f.measurement.employeeMeasurements[0];
    const res = await call(`/employee-measurements/${f.measurement._id}/update-status`, { ...t, method: "POST",
      body: { employeeId: String(emp.employeeId), productName: f.item.name } });
    expect(res.status).toBe(404);
    expect((await Measurement.findById(f.measurement._id).lean()).employeeMeasurements[0].products[0].qrGenerated).not.toBe(true);
  });

  test("a person with no membership in any company is refused a company, not shown everyone's", async () => {
    const w = await world("NoMember");
    const stranger = await person({ companies: [] });
    const res = await call("/manufacturing-orders", { token: stranger.token });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(String(w.linked.mo._id));
  });
});

/* ══ LINKED AND HISTORICAL WORK ═══════════════════════════════════════════ */

describe("our work keeps working", () => {
  test("a linked WorkOrder: view, record progress and generate barcodes as before, labelled linked", async () => {
    const w = await world("Linked");
    const t = { token: w.cutter.token };
    const view = await call(`/work-orders/${w.linked.wo._id}/bulk-cutting`, t);
    expect(view.status).toBe(200);
    expect(view.body.workOrder).toMatchObject({ panelCount: 2, companyProof: "linked" });
    const upd = await call(`/work-orders/${w.linked.wo._id}/update-cutting`, { ...t, method: "POST", body: { quantityCut: 4, action: "add" } });
    expect(upd.status).toBe(200);
    expect(upd.body.workOrder).toMatchObject({ cuttingStatus: "in_progress", cuttingProgress: { completed: 4, remaining: 6 } });
    const codes = await call(`/work-orders/${w.linked.wo._id}/generate-bulk-barcodes`, { ...t, method: "POST", body: { quantityToGenerate: 2 } });
    expect(codes.status).toBe(200);
    const woNo = w.linked.wo.workOrderNumber.startsWith("WO-") ? w.linked.wo.workOrderNumber : `WO-${w.linked.wo.workOrderNumber}`;
    expect(codes.body.barcodes.map((b) => b.id)).toEqual([`${woNo}-005`, `${woNo}-005`, `${woNo}-006`, `${woNo}-006`]);
    const detail = await call(`/manufacturing-orders/${w.linked.mo._id}`, t);
    expect(detail.status).toBe(200);
  });

  test("an unlinked historical WorkOrder belongs to NEITHER company: both are refused, and it is never linked", async () => {
    const w = await world("Historical");
    /* A second company, with its own Cutting user, and the same unprovable
       order in front of both of them. */
    const theirCutter = await person({ companies: [w.theirs] });
    const id = w.historical.wo._id;

    for (const who of [w.cutter, theirCutter]) {
      const t = { token: who.token };
      expect((await call("/manufacturing-orders", t)).body.manufacturingOrders.map((o) => String(o._id)))
        .not.toContain(String(w.historical.mo._id));
      expect((await call(`/manufacturing-orders/${w.historical.mo._id}`, t)).status).toBe(404);
      expect((await call(`/work-orders/${id}/bulk-cutting`, t)).status).toBe(404);
      expect((await call(`/work-orders/${id}/update-cutting`, { ...t, method: "POST", body: { quantityCut: 2 } })).status).toBe(404);
      expect((await call(`/work-orders/${id}/generate-bulk-barcodes`, { ...t, method: "POST", body: { quantityToGenerate: 1 } })).status).toBe(404);
      expect((await call("/cutting-master-records", { ...t, method: "POST",
        body: { employeeId: String(who.emp._id), woId: String(id), quantityCut: 2, startUnit: 1, endUnit: 2 } })).status).toBe(404);
    }

    const after = await WorkOrder.findById(id).lean();
    expect(after.salesLineLink).toBeUndefined();     // never inferred from style, customer or number
    expect(after.cuttingProgress?.completed || 0).toBe(0);
    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
  });
});

/* ══ WHO CUT IT, AND WHO SAID SO ══════════════════════════════════════════ */

describe("the cut record trusts the records, not the body", () => {
  test("a forged name, department and WorkOrder number are not stored; the recorder is the session", async () => {
    const w = await world("Forged");
    const worker = await person({ companies: [w.mine], name: "Ravi" });
    const res = await call("/cutting-master-records", { token: w.cutter.token, method: "POST", body: {
      employeeId: String(worker.emp._id), employeeName: "Somebody Else", biometricId: "FAKE-1",
      department: "Finance", designation: "CEO",
      woId: String(w.linked.wo._id), woNumber: "WO-FORGED", stockItemName: "Forged tee",
      quantityCut: 3, startUnit: 1, endUnit: 3,
    } });
    expect(res.status).toBe(201);
    const stored = await CuttingMasterRecord.findOne({ employeeId: worker.emp._id }).lean();
    expect(stored).toMatchObject({ employeeName: `Ravi N${worker.emp.lastName.slice(1)}`, biometricId: worker.emp.biometricId,
      department: "Cutting", designation: "Cutting master" });
    expect(stored.entries[0]).toMatchObject({ woNumber: w.linked.wo.workOrderNumber, stockItemName: w.linked.item.name,
      quantityCut: 3, companyProof: "linked" });
    expect(String(stored.entries[0].recordedBy.id)).toBe(String(w.cutter.emp._id));
    expect(JSON.stringify(stored)).not.toMatch(/Somebody Else|FAKE-1|Finance|WO-FORGED|Forged tee/);
  });

  test("an employee that does not exist, or no WorkOrder at all, records nothing", async () => {
    const w = await world("NoEmp");
    const t = { token: w.cutter.token, method: "POST" };
    const ghost = await call("/cutting-master-records", { ...t, body: { employeeId: String(new mongoose.Types.ObjectId()), employeeName: "Ghost", woId: String(w.linked.wo._id), quantityCut: 1 } });
    expect(ghost.status).toBe(400);
    const noWo = await call("/cutting-master-records", { ...t, body: { employeeId: String(w.cutter.emp._id), employeeName: "X", quantityCut: 1 } });
    expect(noWo.status).toBe(400);
    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
  });
});

/* ══ THE PROJECT MANAGER'S READ ═══════════════════════════════════════════ */

describe("the project manager's Cutting tab", () => {
  test("still reads an order, company-scoped: ours yes, theirs 404", async () => {
    const w = await world("PmTab");
    const pm = await person({ companies: [w.mine], dept: "project-manager", role: "project_manager" });
    const ours = await call(`/manufacturing-orders/${w.linked.mo._id}`, { token: pm.token });
    expect(ours.status).toBe(200);
    expect(ours.body.workOrders.map((x) => String(x._id))).toEqual([String(w.linked.wo._id)]);
    expect((await call(`/manufacturing-orders/${w.foreign.mo._id}`, { token: pm.token })).status).toBe(404);
  });
});
