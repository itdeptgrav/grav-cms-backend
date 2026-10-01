// test/production/packaging-access.route.test.js
//
// PACKAGING & DISPATCH'S EXECUTION ROUTES — WHO, WHICH COMPANY, WHICH WORK.
//
// Both Packaging routers mounted exactly as server.js mounts them. Pinned:
//
//   · no session → 401; an unrelated department → 403; a Packaging VIEWER
//     reads but cannot record; a Packaging EDITOR records;
//   · Production planning and the executive office may READ (their own screens
//     already show these numbers) and may never write;
//   · a WorkOrder linked to ANOTHER company is absent everywhere — lists,
//     detail, remaining units, barcode lookup — and naming one in a write
//     answers like an id that does not exist, changing nothing;
//   · a historical WorkOrder with no Sales-line link is nobody's: neither
//     company sees it, and neither can pack or dispatch it;
//   · a batch naming one foreign, unlinked or mismatched record fails WHOLE:
//     the valid rows in it are not written either;
//   · the existing quantity, duplicate and completion rules still hold for a
//     valid same-company request;
//   · recording packing changes no PPC publication, no capacity booking and
//     releases nothing to Production.
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
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

let http, packBase, viewBase, seq = 0;
const PACK = "/api/cms/manufacturing/packaging";
const VIEW = "/api/cms/manufacturing/packaging-dispatch-view";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* As server.js mounts them — the guarded target door first, then these. */
  app.use(`${PACK}/packing-targets`, require("../../routes/CMS_Routes/Manufacturing/Packaging/packingTargetRoutes"));
  app.use(PACK, require("../../routes/CMS_Routes/Manufacturing/Packaging/packagingRoutes"));
  app.use(VIEW, require("../../routes/CMS_Routes/Manufacturing/Packaging/packagingDispatchViewRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  packBase = `http://127.0.0.1:${http.address().port}${PACK}`;
  viewBase = `http://127.0.0.1:${http.address().port}${VIEW}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

const request = (root) => (path, { token, method = "GET", body } = {}) => fetch(`${root}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const pack = (...a) => request(packBase)(...a);
const view = (...a) => request(viewBase)(...a);

/** A signed-in person: `dept` is their department session; `grants` live DepartmentRole rows. */
async function person({ companies = [], dept = "packaging-dispatch", role = "packaging_dispatch", grants = {} } = {}) {
  const n = ++seq;
  const email = `pk${n}@grav.test`;
  const emp = await Employee.create({ firstName: "Packer", lastName: `N${n}`, email, biometricId: `PK${n}`,
    isActive: true, gender: "Other", department: "Packaging", designation: "Packer" });
  for (const co of companies) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "P" });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name: "P", role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return { emp, email, token: jwt.sign({ id: String(emp._id), email, name: `Packer N${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

const company = async (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: new Date("2026-04-01") });
const lineRef = () => `LN-${(++seq).toString(16).padStart(12, "0")}`;

/** An approved order with one WorkOrder: linked to `linkCompany`, or historical (no link) when null. */
async function order(label, linkCompany, { quantity = 10 } = {}) {
  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-PK-${++seq}`, reference: `REF-PK-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 10,
    numberOfPanels: 2, variants: [{ sku: `V-PK-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  const mo = await CustomerRequest.create({ requestId: `CR-PK-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: `Buyer ${label}` }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  const saved = await CustomerRequest.findById(mo._id).lean();
  const wo = await WorkOrder.create({
    customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name, quantity, status: "in_progress",
    variantId: String(item.variants[0]._id), variantAttributes: [{ name: "Size", value: "M" }],
    ...(linkCompany ? { salesLineLink: { companyId: linkCompany._id, customerRequestId: mo._id,
      lineRef: saved.items[0].lineRef || lineRef(), basis: "sales_line", linkedAt: new Date() } } : {}),
  });
  const progress = await EmployeeProductionProgress.create({
    manufacturingOrderId: mo._id, workOrderId: wo._id, employeeId: new mongoose.Types.ObjectId(),
    employeeName: `Asha ${label}`, employeeUIN: `UIN-${seq}`, totalUnits: quantity, unitStart: 1, unitEnd: quantity,
  });
  return { item, mo, wo, progress };
}

/** Two companies, three orders: ours, a historical one, and another company's. */
async function world(label) {
  const mine = await company(`${label}Mine`);
  const theirs = await company(`${label}Theirs`);
  return {
    mine, theirs,
    linked: await order(`${label}L`, mine),
    historical: await order(`${label}H`, null),
    foreign: await order(`${label}F`, theirs),
    editor: await person({ companies: [mine] }),
  };
}

/** What a work order and its person look like right now. */
const state = async (o) => ({
  wo: await WorkOrder.findById(o.wo._id).lean(),
  progress: await EmployeeProductionProgress.findById(o.progress._id).lean(),
});

const doneBody = (o, units = [1, 2]) => ({
  groups: [{ workOrderId: String(o.wo._id), isMeasurement: true,
    employees: [{ progressDocId: String(o.progress._id), scannedUnits: units }] }],
});

/* ══ WHO MAY USE IT ══════════════════════════════════════════════════════ */

describe("who may use Packaging's execution routes", () => {
  test("no session: 401 on reads and on writes", async () => {
    const w = await world("NoSession");
    expect((await view("/manufacturing-orders")).status).toBe(401);
    expect((await pack("/pending-pieces")).status).toBe(401);
    expect((await pack("/done", { method: "POST", body: doneBody(w.linked) })).status).toBe(401);
    expect((await view("/dispatch/bulk", { method: "POST", body: { workOrderId: String(w.linked.wo._id), quantity: 1 } })).status).toBe(401);
  });

  test("an unrelated department: 403 everywhere, however it is dressed", async () => {
    const w = await world("Outsider");
    for (const outsider of [
      await person({ companies: [w.mine], dept: "sales", role: "sales" }),
      await person({ companies: [w.mine], dept: "cutting-master", role: "cutting_master" }),
      await person({ companies: [w.mine], dept: "embroidery", role: "embroidery" }),
      await person({ companies: [w.mine], dept: "ppc", role: "ppc", grants: { ppc: "editor" } }),
    ]) {
      expect((await view("/manufacturing-orders", { token: outsider.token })).status).toBe(403);
      expect((await pack("/pending-pieces", { token: outsider.token })).status).toBe(403);
      expect((await pack("/done", { token: outsider.token, method: "POST", body: doneBody(w.linked) })).status).toBe(403);
    }
    /* And nothing they were refused was written. */
    const after = await state(w.linked);
    expect(after.wo.packagedQuantity || 0).toBe(0);
    expect(after.progress.packagedUnits || 0).toBe(0);
  });

  test("a Packaging viewer reads but cannot record; an editor records", async () => {
    const w = await world("ViewerEditor");
    const viewer = await person({ companies: [w.mine], dept: "x", role: "x", grants: { "packaging-dispatch": "viewer" } });
    const editor = await person({ companies: [w.mine], dept: "x", role: "x", grants: { "packaging-dispatch": "editor" } });

    expect((await view("/manufacturing-orders", { token: viewer.token })).status).toBe(200);
    const refused = await pack("/done", { token: viewer.token, method: "POST", body: doneBody(w.linked) });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");
    expect((await state(w.linked)).progress.packagedUnits || 0).toBe(0);

    expect((await pack("/done", { token: editor.token, method: "POST", body: doneBody(w.linked) })).status).toBe(200);
    expect((await state(w.linked)).progress.packagedUnits).toBe(2);
  });

  test("Production planning and the executive office read, and may never write", async () => {
    const w = await world("SharedReaders");
    const pm = await person({ companies: [w.mine], dept: "project-manager", role: "project_manager", grants: { "project-manager": "editor" } });
    const ceo = await person({ companies: [w.mine], dept: "ceo", role: "ceo", grants: { ceo: "owner" } });

    for (const reader of [pm, ceo]) {
      expect((await view(`/manufacturing-orders/${w.linked.mo._id}/bulk`, { token: reader.token })).status).toBe(200);
      expect((await pack("/logs-by-mo", { token: reader.token })).status).toBe(200);
      /* Reading the floor is not being on it — even as an editor elsewhere. */
      expect((await pack("/done", { token: reader.token, method: "POST", body: doneBody(w.linked) })).status).toBe(403);
      expect((await view("/dispatch/bulk", { token: reader.token, method: "POST",
        body: { workOrderId: String(w.linked.wo._id), quantity: 1 } })).status).toBe(403);
    }
    const after = await state(w.linked);
    expect(after.wo.packagedQuantity || 0).toBe(0);
    expect(after.wo.dispatchedQuantity || 0).toBe(0);
  });
});

/* ══ WHOSE WORK ══════════════════════════════════════════════════════════ */

describe("only this company's work is visible", () => {
  test("lists and aggregates carry this company's orders and nothing else", async () => {
    const w = await world("Lists");
    const list = await view("/manufacturing-orders", { token: w.editor.token });
    expect(list.status).toBe(200);
    const ids = list.body.manufacturingOrders.map((m) => String(m._id));
    expect(ids).toContain(String(w.linked.mo._id));
    expect(ids).not.toContain(String(w.foreign.mo._id));
    expect(ids).not.toContain(String(w.historical.mo._id));

    /* The same rule in the packaging app's own aggregates. */
    const logs = await pack("/logs-by-mo", { token: w.editor.token });
    expect(logs.status).toBe(200);
    const logged = JSON.stringify(logs.body);
    expect(logged).not.toContain(String(w.foreign.mo._id));
    expect(logged).not.toContain(String(w.historical.wo._id));
  });

  test("another company's order and a historical one are not found, by id", async () => {
    const w = await world("Detail");
    for (const target of [w.foreign, w.historical]) {
      expect((await view(`/manufacturing-orders/${target.mo._id}`, { token: w.editor.token })).status).toBe(404);
      expect((await view(`/manufacturing-orders/${target.mo._id}/employees`, { token: w.editor.token })).status).toBe(404);
      expect((await pack(`/mo-employees/${target.mo._id}`, { token: w.editor.token })).status).toBe(404);
      expect((await pack(`/remaining-units/${target.wo._id}`, { token: w.editor.token })).status).toBe(404);
    }
    /* Ours still answers. */
    expect((await pack(`/remaining-units/${w.linked.wo._id}`, { token: w.editor.token })).status).toBe(200);
    expect((await view(`/manufacturing-orders/${w.linked.mo._id}`, { token: w.editor.token })).status).toBe(200);
  });

  test("a barcode names work, not a company: the lookup stays inside it", async () => {
    const w = await world("Barcode");
    const mine = `WO-${String(w.linked.wo._id).slice(-8)}-001`;
    const foreign = `WO-${String(w.foreign.wo._id).slice(-8)}-001`;

    /* Another company's order is not a door at all. */
    expect((await view(`/manufacturing-orders/${w.foreign.mo._id}/lookup-by-barcodes`,
      { token: w.editor.token, method: "POST", body: { barcodes: [foreign] } })).status).toBe(404);

    /* And its barcode matches nothing inside ours. */
    const crossed = await view(`/manufacturing-orders/${w.linked.mo._id}/lookup-by-barcodes`,
      { token: w.editor.token, method: "POST", body: { barcodes: [foreign] } });
    expect(crossed.status).toBe(200);
    expect(crossed.body.success).toBe(false);

    /* The packaging app's own scan path answers only for this company. */
    const foreignScan = await pack("/fetch-order", { token: w.editor.token, method: "POST", body: { barcodes: [foreign] } });
    expect(foreignScan.status).toBe(400);
    expect(JSON.stringify(foreignScan.body)).not.toContain(String(w.foreign.mo._id));
    expect((await pack("/fetch-order", { token: w.editor.token, method: "POST", body: { barcodes: [mine] } })).status).toBe(200);
  });
});

/* ══ WRITES ══════════════════════════════════════════════════════════════ */

describe("packing and dispatch write only this company's work, and whole", () => {
  test("/done: foreign, unlinked and mismatched ids are not found, and write nothing", async () => {
    const w = await world("DoneScope");
    for (const target of [w.foreign, w.historical]) {
      const res = await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(target) });
      expect(res.status).toBe(404);
      const after = await state(target);
      expect(after.wo.packagedQuantity || 0).toBe(0);
      expect(after.progress.packagedUnits || 0).toBe(0);
    }

    /* A person of one work order, named under another: refused, not attributed. */
    const mismatched = { groups: [{ workOrderId: String(w.linked.wo._id), isMeasurement: true,
      employees: [{ progressDocId: String(w.foreign.progress._id), scannedUnits: [1] }] }] };
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: mismatched })).status).toBe(404);
    expect((await state(w.linked)).wo.packagedQuantity || 0).toBe(0);
  });

  test("/done: a mixed batch fails whole — the valid rows are not written either", async () => {
    const w = await world("DoneAtomic");
    const mixed = { groups: [
      { workOrderId: String(w.linked.wo._id), isMeasurement: true,
        employees: [{ progressDocId: String(w.linked.progress._id), scannedUnits: [1, 2] }] },
      { workOrderId: String(w.foreign.wo._id), isMeasurement: true,
        employees: [{ progressDocId: String(w.foreign.progress._id), scannedUnits: [1] }] },
    ] };
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: mixed })).status).toBe(404);
    expect((await state(w.linked)).progress.packagedUnits || 0).toBe(0);
    expect((await state(w.foreign)).progress.packagedUnits || 0).toBe(0);
  });

  test("the existing quantity and duplicate rules still hold for valid work", async () => {
    const w = await world("Rules");
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(w.linked, [1, 2, 3]) })).status).toBe(200);
    const first = await state(w.linked);
    expect(first.progress.packagedUnits).toBe(3);
    expect(first.wo.packagedQuantity).toBe(3);

    /* Re-scanning the same units is a no-op, as it always was. */
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(w.linked, [1, 2, 3]) })).status).toBe(200);
    expect((await state(w.linked)).progress.packagedUnits).toBe(3);

    /* A unit outside the person's range is not counted. */
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(w.linked, [999]) })).status).toBe(200);
    expect((await state(w.linked)).progress.packagedUnits).toBe(3);
  });

  test("bulk dispatch: another company's or an unlinked work order is not found", async () => {
    const w = await world("BulkScope");
    for (const target of [w.foreign, w.historical]) {
      const res = await view("/dispatch/bulk", { token: w.editor.token, method: "POST",
        body: { workOrderId: String(target.wo._id), quantity: 1 } });
      expect(res.status).toBe(404);
      expect((await state(target)).wo.dispatchedQuantity || 0).toBe(0);
    }
  });

  test("person-wise dispatch: a mixed batch writes nothing", async () => {
    const w = await world("PersonWise");
    /* Pack ours first, so the only thing standing between it and a dispatch
       is the foreign id beside it. */
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(w.linked, [1, 2]) })).status).toBe(200);

    const mixed = { items: [
      { progressDocId: String(w.linked.progress._id) },
      { progressDocId: String(w.foreign.progress._id) },
    ] };
    expect((await view("/dispatch/person-wise", { token: w.editor.token, method: "POST", body: mixed })).status).toBe(404);
    expect((await state(w.linked)).progress.isDispatched).not.toBe(true);
    expect((await state(w.foreign)).progress.isDispatched).not.toBe(true);

    /* Ours alone still dispatches. */
    expect((await view("/dispatch/person-wise", { token: w.editor.token, method: "POST",
      body: { items: [{ progressDocId: String(w.linked.progress._id) }] } })).status).toBe(200);
    expect((await state(w.linked)).progress.isDispatched).toBe(true);
  });
});

/* ══ WHAT PACKING IS NOT ═════════════════════════════════════════════════ */

describe("recording packing stays Packaging's own act", () => {
  test("it writes no PPC publication, no capacity booking and releases nothing", async () => {
    const w = await world("Boundaries");
    const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
    const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");

    const before = {
      publications: await PpcStagePublication.countDocuments({}),
      bookings: await PpcCapacityBooking.countDocuments({}),
    };
    expect((await pack("/done", { token: w.editor.token, method: "POST", body: doneBody(w.linked, [1, 2]) })).status).toBe(200);
    expect((await view("/dispatch/person-wise", { token: w.editor.token, method: "POST",
      body: { items: [{ progressDocId: String(w.linked.progress._id) }] } })).status).toBe(200);

    expect(await PpcStagePublication.countDocuments({})).toBe(before.publications);
    expect(await PpcCapacityBooking.countDocuments({})).toBe(before.bookings);

    /* And the work order's own state is packing and dispatch — never a
       release into Production. */
    const after = await state(w.linked);
    expect(after.wo.packagedQuantity).toBe(2);
    expect(after.wo.dispatchedQuantity).toBe(2);
    expect(after.wo.planningState === "released").toBe(false);
  });

  test("the recorder is the session, not a name in the body", async () => {
    const w = await world("Actor");
    await pack("/done", { token: w.editor.token, method: "POST",
      body: { ...doneBody(w.linked, [1]), packagedBy: "Someone Else", notes: "n" } });
    const after = await state(w.linked);
    const recorded = (after.progress.packagingHistory || []).map((h) => h.packagedBy).join(" ");
    expect(recorded).not.toContain("Someone Else");
    expect(recorded).toContain("Packer");
  });
});
