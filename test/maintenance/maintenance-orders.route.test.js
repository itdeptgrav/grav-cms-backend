// test/maintenance/maintenance-orders.route.test.js
//
// MAINTENANCE ORDERS — Service Orders (MSO) and Product Orders (MPO), and the
// Settings that decide which Item Master types Maintenance may select. The
// Maintenance router mounted as server.js mounts it. Pinned:
//
//   · a Service Order is Maintenance's own job: Draft → In progress → Repair
//     completed → Closed; the repair time is derived from two stored
//     timestamps; a closed order is final and the next problem is a NEW order;
//   · a Product Order starts from an EXISTING machine or item found by its
//     barcode (a machine tag or a Store sticker) or by search: Created → In
//     maintenance → Work in progress → Solved → Completed; nothing is created
//     but the order — no machine, no item, no barcode, and the Store's sticker
//     and item are byte-identical afterwards;
//   · an item must be of an allowed type; Asset always is; a voided sticker,
//     an unknown code or another department's label is refused, never guessed;
//   · every machine's history holds every order, newest first, with repeat-
//     repair figures; earlier orders never change;
//   · the model refuses rewriting what was raised, replacing or deleting;
//   · steps are forward-only and race-safe; a resubmitted create lands once;
//   · only an owner changes Settings, and changing them deletes no order.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const SystemSetting = require("../../models/DevOps/SystemSetting");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const storage = require("../../services/maintenance/maintenanceStorage");
const settings = require("../../services/maintenance/maintenanceSettings");

let http, base, seq = 0;
const ROOT = "/api/cms/maintenance";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms", EmployeeAuthMiddleware, (req, res, next) => next());
  app.use(ROOT, require("../../routes/CMS_Routes/Maintenance/maintenanceRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}${ROOT}`;
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

beforeEach(async () => {
  storage.resetStorageCache();
  await storage.ensureOrderStorage({ create: true });
});

const call = (path, { token, method = "GET", body } = {}) => fetch(`${base}${path}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function person({ dept = "maintenance", grant = null, name = "Tech", department = "Maintenance" } = {}) {
  const n = ++seq;
  const email = `mo${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `T${n}`, email, biometricId: `MO${n}${Date.now() % 100000}`,
    isActive: true, gender: "Other", department, designation: "Technician" });
  if (grant) await DepartmentRole.create({ departmentSlug: "maintenance", email, name, role: grant, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  return {
    emp, email, fullName: `${name} T${n}`,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} T${n}`, role: dept, deptSlug: dept, employeeId: emp.biometricId },
      process.env.JWT_SECRET, { expiresIn: "10m" }),
  };
}

let mseq = 0;
const machine = (name, extra = {}) => Machine.create({
  name, type: "SNLS", model: "DDL-8700", serialNumber: `SM-${String(++mseq).padStart(3, "0")}`, powerConsumption: "750W",
  location: "Sewing Section A", lastMaintenance: new Date("2026-09-01"), nextMaintenance: new Date("2026-12-01"),
  createdBy: new mongoose.Types.ObjectId(), ...extra,
});

/* Item Master rows and a Store sticker, inserted exactly as the Store stores
   them (raw, so no Store hook runs). */
async function storeItem(name, productType) {
  const r = await RawItem.collection.insertOne({ name, sku: `SKU-${++seq}`, productType, category: "General", unit: "Pcs",
    quantity: 3, status: "In Stock", variants: [], deletedAt: null });
  return String(r.insertedId);
}
async function storeSticker(itemId, extra = {}) {
  const r = await mongoose.connection.db.collection("barcodes").insertOne({ rawItem: new mongoose.Types.ObjectId(itemId),
    rawItemName: "label", quantity: 1, unit: "Pcs", identityState: "ACTIVATED", ...extra });
  return String(r.insertedId);
}

const key = () => `form-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const hash = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
const create = (token, body) => call("/orders", { token, method: "POST", body: { idempotencyKey: key(), ...body } });
const step = (token, id, action, body = {}) => call(`/orders/${id}/steps/${action}`, { token, method: "POST", body });
/* The Maintenance Report: the least a report needs, and "repair completed,
   then report" in one go (4 Oct 2026). */
const REPORT = { maintenanceType: "breakdown", rootCause: "Worn part found", workPerformed: "Part replaced", resolution: "Working again, tested", finalStatus: "operational",
  assetRef: "UNIT-07" /* only read for a free-form job, which names its own equipment */ };
const report = (token, id, body = {}) => step(token, id, "report", { ...REPORT, ...body });
const finish = async (token, id, body = {}) => { await step(token, id, "done"); return report(token, id, body); };
const tagOf = async (token, m) => (await call(`/sewing-machines/${m._id}/tag`, { token, method: "POST" })).body.tag.code;
/* Puts the repair clock's start back in time, through the step-only guard. */
const startedMinutesAgo = (id, min) => MaintenanceOrder.updateOne({ _id: id }, { $set: { workStartedAt: new Date(Date.now() - min * 60000) } });

describe("Settings: Allowed Product Types", () => {
  test("a fresh setting is Asset alone, and the types in use are reported", async () => {
    const owner = await person({ grant: "owner", name: "Owner" });
    await storeItem("Needle bar", "Spare Part");
    await storeItem("Mystery", "");
    const r = await call("/settings", { token: owner.token });
    expect(r.body.visibleItemTypes).toEqual(["Asset"]);
    expect(r.body.itemTypesInUse).toEqual(expect.arrayContaining([{ type: "Spare Part", count: 1 }]));
    expect(r.body.unclassifiedItems).toBe(1);
    expect(r.body.access.canConfigure).toBe(true);
  });

  test("an owner's choice persists; Asset cannot be removed by a save, an empty list or a tampered row", async () => {
    const owner = await person({ grant: "owner", name: "Owner" });
    const put = (list) => call("/settings/visible-item-types", { token: owner.token, method: "PUT", body: { visibleItemTypes: list } });
    expect((await put(["Spare Part", "Consumable"])).body.visibleItemTypes).toEqual(["Asset", "Spare Part", "Consumable"]);
    expect((await call("/settings", { token: owner.token })).body.visibleItemTypes).toEqual(["Asset", "Spare Part", "Consumable"]);
    expect((await put([])).body.visibleItemTypes).toEqual(["Asset"]);
    expect((await put(["asset", "Spare Part"])).body.visibleItemTypes).toEqual(["Asset", "Spare Part"]);
    await SystemSetting.updateOne({ key: settings.KEY }, { $set: { value: ["Consumable"] } });
    expect((await call("/settings", { token: owner.token })).body.visibleItemTypes).toEqual(["Asset", "Consumable"]);
  });

  test("only an owner may change them; an editor reads them; no grant at all is refused", async () => {
    await person({ grant: "owner", name: "Owner" });
    const editor = await person({ grant: "editor", name: "Ed" });
    const ungranted = await person({ name: "NoGrant" });
    expect((await call("/settings", { token: editor.token })).status).toBe(200);
    expect((await call("/settings/visible-item-types", { token: editor.token, method: "PUT", body: { visibleItemTypes: ["Spare Part"] } })).status).toBe(403);
    expect((await call("/settings", { token: ungranted.token })).status).toBe(403);
  });

  test("before any grant exists, a Maintenance session reads Settings but cannot change them", async () => {
    const early = await person({ name: "Early" });
    expect((await call("/settings", { token: early.token })).status).toBe(200);
    const put = await call("/settings/visible-item-types", { token: early.token, method: "PUT", body: { visibleItemTypes: ["Spare Part"] } });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");
  });
});

describe("Service Orders: Maintenance's own repair jobs", () => {
  test("Open → In progress → Repair completed (report pending) → report → Closed, with the repair time from two timestamps", async () => {
    const tech = await person({ grant: "editor", name: "Ravi" });
    const m = await machine("SM-001 Juki");
    const code = await tagOf(tech.token, m);

    const made = await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Needle mechanism not working" });
    expect(made.status).toBe(201);
    expect(made.body.order).toMatchObject({ orderNumber: "MSO-0001", orderType: "service", status: "OPEN",
      problem: "Needle mechanism not working", openedBy: { name: tech.fullName },
      subject: { kind: "machine", id: String(m._id), barcode: code, barcodeKind: "machine-tag", name: "SM-001 Juki", code: m.serialNumber, location: "Sewing Section A" } });
    const id = made.body.order.id;

    const started = await step(tech.token, id, "start");
    expect(started.body.order).toMatchObject({ status: "IN_PROGRESS", workStartedBy: { name: tech.fullName }, assignedTo: { name: tech.fullName } });
    await startedMinutesAgo(id, 85);

    /* Repair completed: the clock stops; nothing is asked; the report is next. */
    const done = await step(tech.token, id, "done");
    expect(done.status).toBe(200);
    expect(done.body.order).toMatchObject({ status: "DONE", statusLabel: "Report pending", repairMinutes: 85, repairDuration: "1 hr 25 min", report: null, finalReport: null });
    expect(done.body.order.actions.map((a) => a.key)).toEqual(["report"]);
    const stored = await MaintenanceOrder.findById(id).lean();
    expect(stored.workStartedAt).toBeInstanceOf(Date);
    expect(stored.workDoneAt).toBeInstanceOf(Date);
    expect(Math.round((stored.workDoneAt - stored.workStartedAt) / 60000)).toBe(stored.repairMinutes);

    /* No bare Close: the old step name is the report, and an empty report is refused. */
    const bare = await step(tech.token, id, "close");
    expect(bare.status).toBe(400);
    expect((await MaintenanceOrder.findById(id).lean()).status).toBe("DONE");

    const closed = await step(tech.token, id, "report", {
      maintenanceType: "breakdown", rootCause: "Needle bar bent", workPerformed: "Replaced the needle bar and re-timed the hook",
      resolution: "Machine stitches cleanly", finalStatus: "operational", recommendations: "Check the hook in a week",
      nextMaintenanceDate: "2099-01-15", remarks: "Operator informed",
      partsUsed: [{ name: "Needle bar", quantity: 1, unit: "Pcs" }, { name: "" }],
    });
    expect(closed.status).toBe(200);
    expect(closed.body.order).toMatchObject({ status: "CLOSED", closedBy: { name: tech.fullName }, actions: [], reportNumber: "MR-0001",
      report: { diagnosis: "Needle bar bent", workPerformed: "Replaced the needle bar and re-timed the hook", notes: "Operator informed" },
      partsUsed: [{ name: "Needle bar", quantity: 1, unit: "Pcs", item: null }],
      finalReport: { reportNumber: "MR-0001", maintenanceType: "breakdown", finalStatus: "operational", finalStatusLabel: "Operational",
        resolution: "Machine stitches cleanly", recommendations: "Check the hook in a week", technician: { name: tech.fullName }, submittedBy: { name: tech.fullName }, source: "submitted" } });
    expect(new Date(closed.body.order.finalReport.nextMaintenanceDate).toISOString().slice(0, 10)).toBe("2099-01-15");
    for (const a of ["start", "done", "report", "close", "cancel"]) expect((await step(tech.token, id, a, { ...REPORT, reason: "x x x" })).status).toBe(409);
    expect(closed.body.order.events.map((e) => e.action)).toEqual(["created", "start", "done", "report"]);
    expect(closed.body.order.events.at(-1).note).toBe("MR-0001");
  });

  test("the same machine's next problem is a NEW order; the first is never reopened or changed", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-001 Juki");
    const first = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Needle mechanism" })).body.order;
    await step(tech.token, first.id, "start");
    await startedMinutesAgo(first.id, 85);
    await finish(tech.token, first.id, { workPerformed: "Needle assembly repaired" });
    const frozen = await MaintenanceOrder.findById(first.id).lean();

    const second = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Timing off again" })).body.order;
    expect(second.orderNumber).toBe("MSO-0002");
    await step(tech.token, second.id, "start");
    await startedMinutesAgo(second.id, 45);
    await finish(tech.token, second.id, { workPerformed: "Timing adjustment" });

    expect(await MaintenanceOrder.findById(first.id).lean()).toEqual(frozen);
    const page = await call(`/subjects/machine/${m._id}`, { token: tech.token });
    expect(page.body.history.map((h) => h.orderNumber)).toEqual(["MSO-0002", "MSO-0001"]);
    expect(page.body.stats).toMatchObject({ repairs: 2, lastRepairMinutes: 45, averageRepairMinutes: 65, lastRepairDuration: "45 min",
      averageRepairDuration: "1 hr 5 min", daysSinceLastRepair: 0, open: 0 });
  });

  test("cancelling needs a reason and is allowed only before the repair is completed", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-002");
    const o = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Raised by mistake" })).body.order;
    expect((await step(tech.token, o.id, "cancel")).status).toBe(400);
    const c = await step(tech.token, o.id, "cancel", { reason: "Raised on the wrong machine" });
    expect(c.body.order).toMatchObject({ status: "CANCELLED", cancelReason: "Raised on the wrong machine" });
    const o2 = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Real problem" })).body.order;
    await step(tech.token, o2.id, "start");
    await step(tech.token, o2.id, "done");
    expect((await step(tech.token, o2.id, "cancel", { reason: "too late" })).status).toBe(409);
  });

  test("two people pressing Start at once: one moves it, the other is told it moved", async () => {
    const a = await person({ grant: "editor", name: "A" });
    const b = await person({ grant: "editor", name: "B" });
    const m = await machine("SM-003");
    const o = (await create(a.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Motor noise" })).body.order;
    const [x, y] = await Promise.all([step(a.token, o.id, "start"), step(b.token, o.id, "start")]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await MaintenanceOrder.findById(o.id).lean()).events.filter((e) => e.action === "start")).toHaveLength(1);
  });

  test("a resubmitted create lands once", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-004");
    const body = { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Belt slipping", idempotencyKey: key() };
    const [x, y] = await Promise.all([call("/orders", { token: tech.token, method: "POST", body }), call("/orders", { token: tech.token, method: "POST", body })]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.order.id).toBe(y.body.order.id);
    expect(await MaintenanceOrder.countDocuments()).toBe(1);
  });

  /* Found by the live run on 3 Oct 2026: a replay was answered correctly but
     had already taken a number, so the next real order was MSO-0003. */
  test("a resubmission uses up no number: the next order is the next number", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-005");
    const body = { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Belt slipping", idempotencyKey: key() };
    const first = await call("/orders", { token: tech.token, method: "POST", body });
    for (let i = 0; i < 3; i += 1) {
      const again = await call("/orders", { token: tech.token, method: "POST", body });
      expect(again.status).toBe(200);
      expect(again.body.order.id).toBe(first.body.order.id);
    }
    const next = await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Oil leak" });
    expect(first.body.order.orderNumber).toBe("MSO-0001");
    expect(next.body.order.orderNumber).toBe("MSO-0002");
    const reused = await call("/orders", { token: tech.token, method: "POST", body: { ...body, orderType: "product" } });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

/* 3 Oct 2026, the owner: "in service order not ask barcode … that is optional
   … any thing can register". A Service order is typed free-form; a machine
   may be linked, never required. Product orders still need an exact record. */
describe("Service Maintenance is free-form; a machine is optional", () => {
  test("raised with no machine at all: what, category, location, problem — and it runs the whole flow", async () => {
    const tech = await person({ grant: "editor" });
    const machinesBefore = await Machine.countDocuments();
    const r = await create(tech.token, { orderType: "service", service: { title: "AC servicing – office", category: "HVAC / AC", location: "1st floor office" }, problem: "Not cooling" });
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o.orderNumber).toBe("MSO-0001");
    expect(o.subject.kind).toBe("none");
    expect(o.subject.id).toBe("");
    expect(o.title).toBe("AC servicing – office");
    expect(o.service).toMatchObject({ title: "AC servicing – office", category: "HVAC / AC", location: "1st floor office" });
    expect(o.serviceTerms).toBeNull();
    expect(o.subject.barcode).toBe("");

    expect((await step(tech.token, o.id, "start")).body.order.status).toBe("IN_PROGRESS");
    await startedMinutesAgo(o.id, 40);
    const done = await step(tech.token, o.id, "done");
    expect(done.body.order.repairDuration).toBe("40 min");
    expect((await report(tech.token, o.id, { workPerformed: "Gas refilled, filters cleaned" })).body.order.status).toBe("CLOSED");

    const detail = await call(`/orders/${o.id}`, { token: tech.token });
    expect(detail.status).toBe(200);
    expect(detail.body.subjectNow).toBeNull();
    expect(detail.body.subjectStats).toBeNull();
    expect(await Machine.countDocuments()).toBe(machinesBefore);
  });

  test("found again by what, category or location; listed under 'no machine' in the history", async () => {
    const tech = await person({ grant: "editor" });
    await create(tech.token, { orderType: "service", service: { title: "Generator check", category: "Electrical", location: "Back yard" }, problem: "Monthly run" });
    for (const q of ["generator", "electrical", "back yard"]) {
      const list = await call(`/orders?type=service&search=${encodeURIComponent(q)}`, { token: tech.token });
      expect(list.body.orders.map((x) => x.title)).toEqual(["Generator check"]);
    }
    const general = await call("/history?subject=none", { token: tech.token });
    expect(general.body.entries.map((e) => e.title)).toEqual(["Generator check"]);
    const machinesOnly = await call("/history?subject=machine", { token: tech.token });
    expect(machinesOnly.body.entries).toHaveLength(0);
  });

  test("a linked machine fills the blanks with its own name and location, and the job joins its history", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SNLS-FREE");
    const r = await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, service: { category: "Machine" }, problem: "Skipping stitches" });
    expect(r.status).toBe(201);
    expect(r.body.order.title).toBe("SNLS-FREE");
    expect(r.body.order.service).toMatchObject({ title: "SNLS-FREE", category: "Machine", location: "Sewing Section A" });
    const page = await call(`/subjects/machine/${m._id}`, { token: tech.token });
    expect(page.body.history.map((h) => h.id)).toEqual([r.body.order.id]);
  });

  test("what is needed: a name when nothing is linked; Product orders still need an exact record", async () => {
    const tech = await person({ grant: "editor" });
    const noTitle = await create(tech.token, { orderType: "service", service: { title: " " }, problem: "Something" });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.message).toBe("A service name is required.");
    const badLink = await create(tech.token, { orderType: "service", subject: { kind: "machine", id: "nope" }, service: { title: "Lift" }, problem: "Stuck" });
    expect(badLink.status).toBe(400);
    const productFree = await create(tech.token, { orderType: "product", service: { title: "Lift" }, problem: "Stuck" });
    expect(productFree.status).toBe(400);
    expect(productFree.body.message).toBe("Choose the machine or product first.");
    const tooLong = await create(tech.token, { orderType: "service", service: { title: "x".repeat(201) }, problem: "Stuck" });
    expect(tooLong.status).toBe(400);
    expect(await MaintenanceOrder.countDocuments()).toBe(0);
  });

  test("a free-form resubmission lands once and takes one number", async () => {
    const tech = await person({ grant: "editor" });
    const body = { orderType: "service", service: { title: "Lift" }, problem: "Door not closing", idempotencyKey: key() };
    const a = await call("/orders", { token: tech.token, method: "POST", body });
    const b = await call("/orders", { token: tech.token, method: "POST", body });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.order.id).toBe(a.body.order.id);
    const next = await create(tech.token, { orderType: "service", service: { title: "Lift" }, problem: "Light out" });
    expect(next.body.order.orderNumber).toBe("MSO-0002");
  });

  test("the model refuses a free-form Product order and a free-form order with no title", async () => {
    const base = { orderNumber: "MPO-9999", subjectAtOpen: { name: "x" }, problem: "x x x", openedAt: new Date(), openedBy: { name: "t" }, events: [] };
    await expect(MaintenanceOrder.create({ ...base, orderType: "product", subject: { kind: "none" }, serviceInfo: { title: "Lift" }, status: "OPEN", idempotencyKey: key() }))
      .rejects.toThrow(/exact existing machine or item/);
    await expect(MaintenanceOrder.create({ ...base, orderNumber: "MSO-9999", orderType: "service", subject: { kind: "none" }, status: "OPEN", idempotencyKey: key() }))
      .rejects.toThrow(/what is being serviced/);
  });
});

/* 3 Oct 2026, the owner: "exact same … all input filled logic all copy" — a
   Service Maintenance job is raised with the Store's own service form, plus
   "Done by"; the vendor-side terms are checked exactly as the Store checks a
   service, against the Store's suppliers and Finance's budget heads. */
describe("Service Maintenance is the Store's service form", () => {
  const { Acc_Company, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
  const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
  async function books() {
    const co = await Acc_Company.create({ companyName: `GRAV Clothing ${++seq}`, booksFromDate: new Date("2026-04-01"), isPrimary: true });
    const vendor = (await Vendor.collection.insertOne({ companyName: "Cool Air Services", supplierCode: "SUP-0007", status: "Active", companyId: co._id })).insertedId;
    const inactive = (await Vendor.collection.insertOne({ companyName: "Old Vendor", status: "Inactive", companyId: co._id })).insertedId;
    const head = (await Acc_Ledger.collection.insertOne({ companyId: co._id, name: "Repairs & Maintenance", groupName: "Indirect Expenses", nature: "expense", budgetControl: "expense_budget" })).insertedId;
    const notHead = (await Acc_Ledger.collection.insertOne({ companyId: co._id, name: "Round Off", groupName: "Indirect Expenses", nature: "expense", budgetControl: "not_budgeted" })).insertedId;
    return { co, vendor: String(vendor), inactive: String(inactive), head: String(head), notHead: String(notHead) };
  }
  const outside = (b, extra = {}) => ({
    name: "AC annual maintenance", category: "Facilities", description: "Quarterly service of four split units. Gas excluded.",
    doneBy: "outside", billingUnit: "Per visit", defaultRate: 2500, leadTimeDays: 3, preferredVendorId: b.vendor, budgetLedgerId: b.head,
    sacCode: "998719", defaultGstRate: 18, recurring: { frequency: "QUARTERLY", noticeDays: 15 }, ...extra,
  });

  test("the form's lists are the Store's: active suppliers, spending budget heads, the billing units", async () => {
    const tech = await person({ grant: "viewer" });
    const b = await books();
    const r = await call("/service-options", { token: tech.token });
    expect(r.status).toBe(200);
    expect(r.body.suppliers).toEqual([{ id: b.vendor, name: "Cool Air Services", code: "SUP-0007" }]);
    expect(r.body.budgetHeads.map((h) => h.name)).toEqual(["Repairs & Maintenance"]);
    expect(r.body.billingUnitSuggestions).toEqual(["Per month", "Per visit", "Per trip", "Per licence", "Per hour", "Per job", "Lump sum"]);
    expect(r.body.recurringFrequencies).toEqual(["NONE", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"]);
  });

  test("done by an outside vendor: every term is kept, the supplier and head by id and by name", async () => {
    const tech = await person({ grant: "editor" });
    const b = await books();
    const vendorsBefore = hash(await Vendor.collection.find({}).sort({ _id: 1 }).toArray());
    const r = await create(tech.token, { orderType: "service", service: outside(b) });
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o.title).toBe("AC annual maintenance");
    expect(o.service).toMatchObject({ category: "Facilities", description: "Quarterly service of four split units. Gas excluded." });
    expect(o.problem).toBe("Quarterly service of four split units. Gas excluded.");
    expect(o.serviceTerms).toEqual({
      billingUnit: "Per visit", defaultRate: 2500, leadTimeDays: 3, preferredVendorId: b.vendor, preferredVendorName: "Cool Air Services",
      budgetLedgerId: b.head, budgetLedgerName: "Repairs & Maintenance", sacCode: "998719", defaultGstRate: 18,
      recurring: { frequency: "QUARTERLY", noticeDays: 15 },
    });
    expect(o.details.provider).toMatchObject({ kind: "outside", name: "Cool Air Services" });
    expect(hash(await Vendor.collection.find({}).sort({ _id: 1 }).toArray())).toBe(vendorsBefore);
  });

  test("done in-house: the name alone is enough, and no vendor term is kept even if sent", async () => {
    const tech = await person({ grant: "editor" });
    const b = await books();
    const r = await create(tech.token, { orderType: "service", service: { ...outside(b), doneBy: "in-house", description: "" } });
    expect(r.status).toBe(201);
    expect(r.body.order.serviceTerms).toBeNull();
    expect(r.body.order.details.provider).toEqual({ kind: "in-house", name: "", contact: "" });
    expect(r.body.order.problem).toBe("AC annual maintenance");
  });

  test("the Store's refusals, word for word, and nothing is raised", async () => {
    const tech = await person({ grant: "editor" });
    const b = await books();
    const cases = [
      [{ name: "" }, "A service name is required."],
      [{ defaultGstRate: 101 }, "defaultGstRate must be between 0 and 100."],
      [{ defaultRate: -1 }, "defaultRate must be between 0 and 9007199254740991."],
      [{ leadTimeDays: "soon" }, "leadTimeDays must be a number."],
      [{ recurring: { frequency: "WEEKLY" } }, "That recurring term is not one this system records."],
      [{ preferredVendorId: String(new mongoose.Types.ObjectId()) }, "That supplier was not found in this company."],
      [{ budgetLedgerId: b.notHead }, "Round Off has no recorded nature, so it cannot be confirmed as a budget head."],
      [{ billingUnit: "x".repeat(61) }, "billingUnit is longer than 60 characters."],
      [{ doneBy: "friends" }, "Say whether the work is in-house or by an outside vendor."],
    ];
    for (const [extra, message] of cases) {
      const r = await create(tech.token, { orderType: "service", service: outside(b, extra) });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(message);
    }
    expect(await MaintenanceOrder.countDocuments()).toBe(0);
  });

  /* Owner, 3 Oct 2026: Product Maintenance by an outside vendor shows — and
     keeps — the same Store fields. */
  test("Product Maintenance by an outside vendor keeps the same Store terms, checked the same way", async () => {
    const tech = await person({ grant: "editor" });
    const b = await books();
    const m = await machine("SM-VEND");
    const { name, category, description, ...terms } = outside(b);
    const r = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Motor rewinding", terms });
    expect(r.status).toBe(201);
    expect(r.body.order.serviceTerms).toMatchObject({ billingUnit: "Per visit", defaultRate: 2500, preferredVendorName: "Cool Air Services", budgetLedgerName: "Repairs & Maintenance", defaultGstRate: 18 });
    expect(r.body.order.details.provider).toMatchObject({ kind: "outside", name: "Cool Air Services" });
    const bad = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Motor", terms: { ...terms, defaultGstRate: 150 } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("defaultGstRate must be between 0 and 100.");
    const inHouse = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Belt", terms: { ...terms, doneBy: "in-house" } });
    expect(inHouse.body.order.serviceTerms).toBeNull();
    expect(inHouse.body.order.details.provider).toEqual({ kind: "in-house", name: "", contact: "" });
  });

  test("found by its supplier in the register", async () => {
    const tech = await person({ grant: "editor" });
    const b = await books();
    await create(tech.token, { orderType: "service", service: outside(b) });
    const list = await call("/orders?type=service&search=cool%20air", { token: tech.token });
    expect(list.body.orders.map((o) => o.title)).toEqual(["AC annual maintenance"]);
  });
});

/* 3 Oct 2026: the form became the Store's drawer, with the planning facts it
   was missing and photos/documents kept on Google Drive. */
describe("Job details and attachments", () => {
  const driveFile = (n) => ({ fileId: `1AbCdEfGhIjKlMnOp${n}`, name: `photo-${n}.jpg`, mimeType: "image/jpeg", size: 120000 + n });

  test("a service job keeps its planning facts and its files; product-only facts are not stored on it", async () => {
    const tech = await person({ grant: "editor" });
    const r = await create(tech.token, {
      orderType: "service", service: { title: "Lift", category: "Lift", location: "Main block" }, problem: "Door not closing",
      details: {
        priority: "urgent", maintenanceType: "breakdown", specification: "Door sensor and rollers. Motor excluded.", department: "Admin",
        targetDate: "2026-10-05", estimatedCost: "4500", provider: { kind: "outside", name: "Lift Co", contact: "98xxxxxx10" },
        notes: "Call before visiting", conditionReceived: "should not be stored", accessories: "nor this",
      },
      attachments: [driveFile(1), { ...driveFile(2), name: "quote.pdf", mimeType: "application/pdf" }],
    });
    expect(r.status).toBe(201);
    const d = r.body.order.details;
    expect(d).toMatchObject({ priority: "urgent", maintenanceType: "breakdown", department: "Admin", estimatedCost: 4500,
      provider: { kind: "outside", name: "Lift Co", contact: "98xxxxxx10" }, notes: "Call before visiting", conditionReceived: "", accessories: "" });
    expect(new Date(d.targetDate).toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(r.body.order.attachments.map((a) => [a.name, a.stage, a.uploadedBy])).toEqual([["photo-1.jpg", "raised", tech.fullName], ["quote.pdf", "raised", tech.fullName]]);
  });

  test("a product job keeps the condition it came in, what came with it and who handed it over", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SNLS-DET");
    const r = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Noisy", putIntoMaintenance: true,
      details: { priority: "high", maintenanceType: "preventive", conditionReceived: "Oil leaking", accessories: "Foot pedal, bobbin case", handedOverBy: "Line 2 supervisor", provider: { kind: "in-house", name: "ignored" } } });
    expect(r.status).toBe(201);
    expect(r.body.order.details).toMatchObject({ priority: "high", conditionReceived: "Oil leaking", accessories: "Foot pedal, bobbin case", handedOverBy: "Line 2 supervisor", provider: { kind: "in-house", name: "" } });
  });

  test("wrong values are refused in words, and nothing is raised", async () => {
    const tech = await person({ grant: "editor" });
    const base = { orderType: "service", service: { title: "Lift" }, problem: "Stuck" };
    const cases = [
      [{ details: { priority: "whenever" } }, "Choose a priority from the list."],
      [{ details: { maintenanceType: "magic" } }, "Choose a maintenance type from the list."],
      [{ details: { estimatedCost: -5 } }, "The estimated cost must be a number, zero or more."],
      [{ details: { targetDate: "not a date" } }, "The target date is not a date."],
      [{ attachments: [{ fileId: "x", name: "a.jpg" }] }, "A file did not finish uploading. Remove it and add it again."],
    ];
    for (const [extra, message] of cases) {
      const r = await create(tech.token, { ...base, ...extra });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(message);
    }
    expect(await MaintenanceOrder.countDocuments()).toBe(0);
  });

  test("files can be added at any stage, even after closing; nothing else on the job changes and none is removed", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Generator" }, problem: "Service due", attachments: [driveFile(1)] })).body.order;
    await step(tech.token, o.id, "start");
    await finish(tech.token, o.id, { workPerformed: "Oil and filter changed" });
    const before = await MaintenanceOrder.findById(o.id).lean();
    const r = await call(`/orders/${o.id}/attachments`, { token: tech.token, method: "POST", body: { attachments: [{ ...driveFile(3), name: "invoice.pdf", mimeType: "application/pdf" }] } });
    expect(r.status).toBe(200);
    expect(r.body.order.attachments.map((a) => [a.name, a.stage])).toEqual([["photo-1.jpg", "raised"], ["invoice.pdf", "later"]]);
    expect(r.body.order.events.at(-1)).toMatchObject({ action: "attached", note: "invoice.pdf" });
    const after = await MaintenanceOrder.findById(o.id).lean();
    for (const k of ["status", "problem", "report", "serviceInfo", "details", "openedAt", "closedAt", "orderNumber"]) expect(hash(after[k])).toBe(hash(before[k]));
    expect((await call(`/orders/${o.id}/attachments`, { token: tech.token, method: "POST", body: { attachments: [] } })).status).toBe(400);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $pull: { attachments: { name: "invoice.pdf" } } })).rejects.toThrow(/never replaced or deleted/);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $set: { attachments: [] } })).rejects.toThrow(/never replaced or deleted/);
  });

  test("a viewer cannot attach; a job keeps at most sixty files", async () => {
    const tech = await person({ grant: "editor" });
    const viewer = await person({ grant: "viewer" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Lift" }, problem: "Stuck" })).body.order;
    expect((await call(`/orders/${o.id}/attachments`, { token: viewer.token, method: "POST", body: { attachments: [driveFile(1)] } })).status).toBe(403);
    for (let batch = 0; batch < 3; batch += 1) {
      const r = await call(`/orders/${o.id}/attachments`, { token: tech.token, method: "POST", body: { attachments: Array.from({ length: 20 }, (_, i) => driveFile(batch * 20 + i)) } });
      expect(r.status).toBe(200);
    }
    const over = await call(`/orders/${o.id}/attachments`, { token: tech.token, method: "POST", body: { attachments: [driveFile(99)] } });
    expect(over.status).toBe(409);
    expect((await MaintenanceOrder.findById(o.id).lean()).attachments).toHaveLength(60);
  });

  /* 4 Oct 2026: proof of the work — any document or photo — goes with the
     Maintenance Report (it went with "Mark done" until the report existed). */
  test("the report keeps its proof files, marked as proof, in the same write", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Boiler" }, problem: "Pressure low", attachments: [driveFile(1)] })).body.order;
    await step(tech.token, o.id, "start");
    await step(tech.token, o.id, "done");
    const r = await report(tech.token, o.id, {
      workPerformed: "Valve replaced and pressure tested",
      attachments: [
        { ...driveFile(2), name: "service-report.pdf", mimeType: "application/pdf" },
        { ...driveFile(3), name: "readings.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        { ...driveFile(4), name: "after.jpg" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe("CLOSED");
    expect(r.body.order.attachments.map((a) => [a.name, a.stage, a.uploadedBy])).toEqual([
      ["photo-1.jpg", "raised", tech.fullName],
      ["service-report.pdf", "proof", tech.fullName],
      ["readings.xlsx", "proof", tech.fullName],
      ["after.jpg", "proof", tech.fullName],
    ]);
    expect(r.body.order.events.at(-1)).toMatchObject({ action: "report", to: "CLOSED", note: "MR-0001 · proof: service-report.pdf, readings.xlsx, after.jpg" });
    const view = await call(`/reports/${o.id}`, { token: tech.token });
    expect(view.body.report.proof.map((a) => a.name)).toEqual(["service-report.pdf", "readings.xlsx", "after.jpg"]);
  });

  test("proof is optional; a broken proof file refuses the report, uses no number, and the job stays Report pending", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Pump" }, problem: "Leak" })).body.order;
    await step(tech.token, o.id, "start");
    await step(tech.token, o.id, "done");
    const bad = await report(tech.token, o.id, { attachments: [{ fileId: "x", name: "half.pdf" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("A file did not finish uploading. Remove it and add it again.");
    const kept = await MaintenanceOrder.findById(o.id).lean();
    expect(kept.status).toBe("DONE");
    expect(kept.attachments).toEqual([]);
    expect(kept.finalReport).toBeUndefined();
    const ok = await report(tech.token, o.id);
    expect(ok.body.order).toMatchObject({ status: "CLOSED", reportNumber: "MR-0001", attachments: [] });
  });

  test("proof counts toward the sixty-file limit; other steps ignore attachments", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Lift" }, problem: "Stuck" })).body.order;
    for (let batch = 0; batch < 3; batch += 1) {
      await call(`/orders/${o.id}/attachments`, { token: tech.token, method: "POST", body: { attachments: Array.from({ length: 20 }, (_, i) => driveFile(batch * 20 + i)) } });
    }
    const started = await step(tech.token, o.id, "start", { attachments: [driveFile(70)] });
    expect(started.status).toBe(200);
    expect(started.body.order.attachments).toHaveLength(60);
    expect((await step(tech.token, o.id, "done", { attachments: [driveFile(71)] })).body.order.attachments).toHaveLength(60);
    const over = await report(tech.token, o.id, { attachments: [driveFile(72)] });
    expect(over.status).toBe(409);
    expect(over.body.message).toBe("A job keeps at most 60 files.");
    expect((await MaintenanceOrder.findById(o.id).lean()).status).toBe("DONE");
    expect((await report(tech.token, o.id)).status).toBe(200);
  });
});

/* 3 Oct 2026: the statuses were cut to Open → In progress → Done → Closed (+
   Cancelled). A job stored under a first-version word is read as its new
   status, counted under it, found by it, and can take its next step; the old
   step names still work for a screen opened before the change. */
/* 4 Oct 2026: the register's "Overdue" card — open or in progress, past the
   target / expected-back day (India's calendar). Done work is never overdue. */
describe("overdue jobs", () => {
  test("counted and filtered: past its day and not done; today and later are not overdue", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-DUE");
    const day = (offset) => new Date(Date.now() + 330 * 60000 + offset * 86400000).toISOString().slice(0, 10);
    const late = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Late", details: { targetDate: day(-2) } })).body.order;
    await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Due today", details: { targetDate: day(0) } });
    await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Later", details: { targetDate: day(3) } });
    await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "No date" });
    const lateDone = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Late but done", details: { targetDate: day(-1) } })).body.order;
    await step(tech.token, lateDone.id, "start");
    await step(tech.token, lateDone.id, "done");

    const list = await call("/orders?type=product", { token: tech.token });
    expect(list.body.overdue).toBe(1);
    const only = await call("/orders?type=product&due=overdue", { token: tech.token });
    expect(only.body.orders.map((o) => o.id)).toEqual([late.id]);
    expect((await call("/orders?type=service", { token: tech.token })).body.overdue).toBe(0);
    /* The overview's Overdue card counts by the same rule. */
    expect((await call("/overview", { token: tech.token })).body.overdue).toEqual({ service: 0, product: 1 });
  });
});

describe("the simplified statuses", () => {
  test("a job stored as SOLVED reads, counts and filters as Report pending, and closes only with its report", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-LEG");
    const o = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Legacy" })).body.order;
    await step(tech.token, o.id, "start");
    await step(tech.token, o.id, "done");
    await MaintenanceOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(o.id) }, { $set: { status: "SOLVED" } });
    const read = await call(`/orders/${o.id}`, { token: tech.token });
    expect(read.body.order).toMatchObject({ status: "DONE", statusLabel: "Report pending", isOpen: false });
    expect(read.body.order.actions.map((a) => a.key)).toEqual(["report"]);
    expect((await call("/orders?type=product", { token: tech.token })).body.counts).toEqual({ DONE: 1 });
    expect((await call("/orders?type=product&status=DONE", { token: tech.token })).body.orders.map((x) => x.id)).toEqual([o.id]);
    expect((await call(`/subjects/machine/${m._id}`, { token: tech.token })).body.stats.repairs).toBe(1);
    expect((await step(tech.token, o.id, "complete")).status).toBe(400); // the old step name now means the report…
    expect((await step(tech.token, o.id, "complete", REPORT)).body.order.status).toBe("CLOSED"); // …and closes with one
  });

  test("every new job is born Open, and the only steps are Start, Repair completed, Submit report and Cancel", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-NEW");
    for (const orderType of ["service", "product"]) {
      const o = (await create(tech.token, { orderType, subject: { kind: "machine", id: String(m._id) }, problem: "New", putIntoMaintenance: true })).body.order;
      expect(o.status).toBe("OPEN");
      expect(o.actions.map((a) => a.key)).toEqual(["start", "cancel"]);
    }
    expect((await MaintenanceOrder.find({}).lean()).map((o) => o.status)).toEqual(["OPEN", "OPEN"]);
  });
});

describe("Product Orders: an exact existing machine or item, put into maintenance", () => {
  test("scan a machine's barcode → that machine → put into maintenance → work → solved → completed; nothing else is created", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-001 Juki");
    const code = await tagOf(tech.token, m);
    const machinesBefore = await Machine.countDocuments();
    const machineBefore = await Machine.findById(m._id).select("+maintenanceTag").lean();

    const found = await call(`/subjects/resolve?code=${encodeURIComponent(code.toLowerCase())}`, { token: tech.token });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ kind: "machine", id: String(m._id), name: "SM-001 Juki", code: m.serialNumber, category: "Asset",
      location: "Sewing Section A", status: "Operational", scanned: { code, kind: "machine-tag" } });

    const made = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) },
      scanned: { code: found.body.scanned.code }, problem: "Motor maintenance", putIntoMaintenance: true });
    expect(made.status).toBe(201);
    /* Registering a product job IS handing it over: Open, with the time it came in. */
    expect(made.body.order).toMatchObject({ orderNumber: "MPO-0001", status: "OPEN", subject: { barcode: code, barcodeKind: "machine-tag" } });
    expect(made.body.order.inMaintenanceAt).toBeTruthy();
    const id = made.body.order.id;
    expect((await step(tech.token, id, "start")).body.order.status).toBe("IN_PROGRESS");
    await startedMinutesAgo(id, 130);
    expect((await step(tech.token, id, "done")).body.order).toMatchObject({ status: "DONE", repairDuration: "2 hr 10 min" });
    expect((await report(tech.token, id, { workPerformed: "Motor brushes replaced" })).body.order).toMatchObject({ status: "CLOSED", reportNumber: "MR-0001" });

    expect(await Machine.countDocuments()).toBe(machinesBefore);
    expect(await Machine.findById(m._id).select("+maintenanceTag").lean()).toEqual(machineBefore);

    /* Later, the same machine again: a new order, the old one untouched. */
    const frozen = await MaintenanceOrder.findById(id).lean();
    const again = await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, scanned: { code }, problem: "Oil leak" });
    expect(again.body.order).toMatchObject({ orderNumber: "MPO-0002", status: "OPEN" });
    expect((await step(tech.token, again.body.order.id, "start")).body.order.status).toBe("IN_PROGRESS");
    expect(await MaintenanceOrder.findById(id).lean()).toEqual(frozen);
  });

  test("a Store sticker finds its existing item; the sticker and the item are untouched; only allowed types", async () => {
    const owner = await person({ grant: "owner", name: "Owner" });
    const asset = await storeItem("Compressor", "Asset");
    const raw = await storeItem("Cotton fabric", "Raw Material");
    const sticker = await storeSticker(asset);
    const rawSticker = await storeSticker(raw);
    const voided = await storeSticker(asset, { identityState: "VOIDED" });
    const db = mongoose.connection.db;
    const before = { item: await db.collection("rawitems").findOne({ _id: new mongoose.Types.ObjectId(asset) }), sticker: await db.collection("barcodes").findOne({ _id: new mongoose.Types.ObjectId(sticker) }),
      items: await db.collection("rawitems").countDocuments(), stickers: await db.collection("barcodes").countDocuments() };

    for (const form of [`itemid=${sticker}`, `https://cms.grav.in/store/dashboard/item-info?itemid=${sticker}`, sticker]) {
      const r = await call(`/subjects/resolve?code=${encodeURIComponent(form)}`, { token: owner.token });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ kind: "item", id: asset, name: "Compressor", type: "Asset", scanned: { code: sticker, kind: "store-sticker" } });
    }
    expect((await call(`/subjects/resolve?code=itemid=${voided}`, { token: owner.token })).body.kind).toBe("voided-sticker");
    const blocked = await call(`/subjects/resolve?code=itemid=${rawSticker}`, { token: owner.token });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("TYPE_NOT_ALLOWED");
    expect((await create(owner.token, { orderType: "product", subject: { kind: "item", id: raw }, problem: "Should not be allowed" })).status).toBe(404);

    await call("/settings/visible-item-types", { token: owner.token, method: "PUT", body: { visibleItemTypes: ["Raw Material"] } });
    expect((await call(`/subjects/resolve?code=itemid=${rawSticker}`, { token: owner.token })).status).toBe(200);

    const made = await create(owner.token, { orderType: "product", subject: { kind: "item", id: asset }, scanned: { code: `itemid=${sticker}` }, problem: "Pressure drops", putIntoMaintenance: true });
    expect(made.body.order).toMatchObject({ orderNumber: "MPO-0001", subject: { kind: "item", id: asset, barcode: sticker, barcodeKind: "store-sticker", name: "Compressor", type: "Asset" } });

    expect(await db.collection("rawitems").findOne({ _id: new mongoose.Types.ObjectId(asset) })).toEqual(before.item);
    expect(await db.collection("barcodes").findOne({ _id: new mongoose.Types.ObjectId(sticker) })).toEqual(before.sticker);
    expect(await db.collection("rawitems").countDocuments()).toBe(before.items);
    expect(await db.collection("barcodes").countDocuments()).toBe(before.stickers);
  });

  test("unknown codes and other departments' labels are refused, never guessed", async () => {
    const tech = await person({ grant: "editor" });
    for (const [raw, kind] of [["MCH-ZZZZZZZZ", "unknown-tag"], [`itemid=${new mongoose.Types.ObjectId()}`, "unknown-sticker"],
      ["loc=LOC-ABCD2345", "store-location"], ["WO-359e7172-009", "garment-piece"], ["hello", "unknown"], ["", "empty"]]) {
      const r = await call(`/subjects/resolve?code=${encodeURIComponent(raw)}`, { token: tech.token });
      expect(r.status).toBe(404);
      expect(r.body.kind).toBe(kind);
    }
    expect(await MaintenanceOrder.countDocuments()).toBe(0);
  });

  test("search offers sewing machines and allowed items only", async () => {
    const tech = await person({ grant: "editor" });
    await machine("Juki SM-9");
    await storeItem("Juki spare motor", "Asset");
    await storeItem("Juki thread", "Raw Material");
    const r = await call("/subjects/search?q=juki", { token: tech.token });
    expect(r.body.machines.map((m) => m.name)).toEqual(["Juki SM-9"]);
    expect(r.body.items.map((i) => i.name)).toEqual(["Juki spare motor"]);
  });

  test("switching a type off keeps every order made under it", async () => {
    const owner = await person({ grant: "owner", name: "Owner" });
    await call("/settings/visible-item-types", { token: owner.token, method: "PUT", body: { visibleItemTypes: ["Spare Part"] } });
    const part = await storeItem("Hook assembly", "Spare Part");
    const o = (await create(owner.token, { orderType: "product", subject: { kind: "item", id: part }, problem: "Worn" })).body.order;
    await call("/settings/visible-item-types", { token: owner.token, method: "PUT", body: { visibleItemTypes: [] } });
    expect((await call(`/orders/${o.id}`, { token: owner.token })).body.order.orderNumber).toBe(o.orderNumber);
    expect((await call("/orders?type=product", { token: owner.token })).body.orders.map((x) => x.id)).toEqual([o.id]);
    expect((await call("/history", { token: owner.token })).body.entries.map((x) => x.id)).toEqual([o.id]);
  });
});

describe("History, overview and the guards", () => {
  test("a machine's history holds its service and product orders together, newest first", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-001");
    const s = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Needle" })).body.order;
    await new Promise((r) => setTimeout(r, 15));
    const p = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Motor", putIntoMaintenance: true })).body.order;
    const page = await call(`/subjects/machine/${m._id}`, { token: tech.token });
    expect(page.body.history.map((h) => [h.orderNumber, h.orderType])).toEqual([[p.orderNumber, "product"], [s.orderNumber, "service"]]);
    expect(page.body.stats.open).toBe(2);
    const all = await call("/history?subject=machine", { token: tech.token });
    expect(all.body.entries).toHaveLength(2);
    const ov = await call("/overview", { token: tech.token });
    expect(ov.body).toMatchObject({ service: { OPEN: 1 }, product: { OPEN: 1 }, machines: { sewing: 1 } });
    expect(ov.body.inMaintenance.map((o) => o.orderNumber)).toEqual([p.orderNumber]);
    const list = await call("/orders?type=service&status=open", { token: tech.token });
    expect(list.body.orders.map((o) => o.orderNumber)).toEqual([s.orderNumber]);
    expect(list.body.counts).toEqual({ OPEN: 1 });
  });

  test("what was raised can never be rewritten, replaced or deleted", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-005");
    const { id } = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Original problem" })).body.order;
    await expect(MaintenanceOrder.updateOne({ _id: id }, { $set: { problem: "Rewritten" } })).rejects.toThrow(/never replaced or deleted/);
    await expect(MaintenanceOrder.updateOne({ _id: id }, { $set: { orderNumber: "MSO-9999" } })).rejects.toThrow(/never replaced or deleted/);
    await expect(MaintenanceOrder.updateOne({ _id: id }, { $pull: { events: {} } })).rejects.toThrow(/never replaced or deleted/);
    await expect(MaintenanceOrder.replaceOne({ _id: id }, { problem: "x" })).rejects.toThrow(/never replaced or deleted/);
    await expect(MaintenanceOrder.deleteOne({ _id: id })).rejects.toThrow(/never replaced or deleted/);
    await expect((await MaintenanceOrder.findById(id)).deleteOne()).rejects.toThrow(/never replaced or deleted/);
    expect((await MaintenanceOrder.findById(id).lean()).problem).toBe("Original problem");
  });

  test("who may: a viewer reads and cannot raise or step; another department cannot read", async () => {
    await person({ grant: "owner", name: "Owner" });
    const editor = await person({ grant: "editor" });
    const viewer = await person({ grant: "viewer", name: "Vi" });
    const outsider = await person({ dept: "store", department: "Store", name: "Out" });
    const m = await machine("SM-006");
    const o = (await create(editor.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Squeak" })).body.order;
    expect((await call(`/orders/${o.id}`, { token: viewer.token })).status).toBe(200);
    expect((await create(viewer.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Squeak" })).status).toBe(403);
    expect((await step(viewer.token, o.id, "start")).status).toBe(403);
    expect((await call("/orders?type=service", { token: outsider.token })).status).toBe(403);
  });
});

/* ── MAINTENANCE REPORTS (owner, 4 Oct 2026) ─────────────────────────────────
   One completed job = one report, numbered MR-…, written once, never changed;
   a machine can have any number; the overview lists them across machines. */
describe("Maintenance Reports", () => {
  test("the report form is checked whole, in words; a refused form changes nothing and uses no number", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Compressor" }, problem: "No pressure" })).body.order;
    await step(tech.token, o.id, "start");
    expect((await report(tech.token, o.id)).status).toBe(409); // not before the repair is completed
    await step(tech.token, o.id, "done");
    const cases = [
      [{ maintenanceType: "" }, "Choose the maintenance type."],
      [{ maintenanceType: "magic" }, "Choose the maintenance type."],
      [{ rootCause: "" }, "Write the diagnosis / root cause."],
      [{ workPerformed: "x" }, "Write what work was performed."],
      [{ finalStatus: "fine" }, "Choose the machine's final status."],
      [{ resolution: "" }, "Write the solution / resolution."],
      [{ assetRef: "" }, "Write the asset / equipment ID (for example, the unit's tag or serial number)."],
      [{ nextMaintenanceDate: "soon" }, "The next maintenance date is not a date."],
      [{ nextMaintenanceDate: "2000-01-01" }, "The next maintenance date cannot be before the repair was completed."],
    ];
    for (const [extra, message] of cases) {
      const r = await report(tech.token, o.id, extra);
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(message);
    }
    expect((await MaintenanceOrder.findById(o.id).lean()).status).toBe("DONE");
    expect((await report(tech.token, o.id)).body.order.reportNumber).toBe("MR-0001");
  });

  test("the maintenance type defaults to the job's own; the technician to whoever it is assigned to, or a chosen person by id", async () => {
    const tech = await person({ grant: "editor", name: "Ravi" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Fan" }, problem: "Noisy", details: { maintenanceType: "preventive" } })).body.order;
    await step(tech.token, o.id, "start");
    await step(tech.token, o.id, "done");
    const r = await report(tech.token, o.id, { maintenanceType: "" });
    expect(r.body.order.finalReport).toMatchObject({ maintenanceType: "preventive", maintenanceTypeLabel: "Preventive", technician: { name: tech.fullName } });
    expect(r.body.order.finalReport.technician.id).toBeTruthy();
  });

  test("two jobs on one machine: two reports, the first never changed; both in the machine's history and the report list; times right", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-001 Juki");
    const other = await machine("SM-002 Brother");
    const first = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Needle mechanism jammed" })).body.order;
    await step(tech.token, first.id, "start");
    await startedMinutesAgo(first.id, 85);
    const r1 = await finish(tech.token, first.id, { rootCause: "Worn internal component", workPerformed: "Component replaced and timing adjusted" });
    expect(r1.body.order).toMatchObject({ reportNumber: "MR-0001", repairDuration: "1 hr 25 min" });
    const frozen = await MaintenanceOrder.findById(first.id).lean();

    const second = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Motor noise" })).body.order;
    await step(tech.token, second.id, "start");
    await startedMinutesAgo(second.id, 130);
    expect((await finish(tech.token, second.id, { maintenanceType: "preventive", workPerformed: "Motor bearings replaced" })).body.order.reportNumber).toBe("MR-0002");
    const third = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(other._id) }, problem: "Thread breaking" })).body.order;
    await step(tech.token, third.id, "start");
    await finish(tech.token, third.id, { finalStatus: "monitor" });

    expect(await MaintenanceOrder.findById(first.id).lean()).toEqual(frozen);

    const page = await call(`/subjects/machine/${m._id}`, { token: tech.token });
    expect(page.body.history.map((h) => [h.orderNumber, h.reportNumber, h.repairDuration, h.status])).toEqual([
      [second.orderNumber, "MR-0002", "2 hr 10 min", "CLOSED"], [first.orderNumber, "MR-0001", "1 hr 25 min", "CLOSED"],
    ]);

    const all = await call("/reports", { token: tech.token });
    expect(all.body.reports.map((r) => [r.reportNumber, r.subject.name, r.orderNumber])).toEqual([
      ["MR-0003", "SM-002 Brother", third.orderNumber], ["MR-0002", "SM-001 Juki", second.orderNumber], ["MR-0001", "SM-001 Juki", first.orderNumber],
    ]);
    expect(all.body.subjects.map((x) => [x.name, x.reports])).toEqual([["SM-001 Juki", 2], ["SM-002 Brother", 1]]);
    const byMachine = await call(`/reports?subject=machine:${m._id}`, { token: tech.token });
    expect(byMachine.body.reports.map((r) => r.reportNumber)).toEqual(["MR-0002", "MR-0001"]);
    expect((await call("/reports?maintenanceType=preventive", { token: tech.token })).body.reports.map((r) => r.reportNumber)).toEqual(["MR-0002"]);
    expect((await call("/reports?finalStatus=monitor", { token: tech.token })).body.reports.map((r) => r.reportNumber)).toEqual(["MR-0003"]);
    expect((await call("/reports?search=worn%20internal", { token: tech.token })).body.reports.map((r) => r.reportNumber)).toEqual(["MR-0001"]);
    expect((await call("/reports?type=product", { token: tech.token })).body.reports.map((r) => r.reportNumber)).toEqual(["MR-0002"]);
    const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    expect((await call(`/reports?from=${istToday}&to=${istToday}`, { token: tech.token })).body.pagination.total).toBe(3);
    expect((await call("/reports?to=2020-01-01", { token: tech.token })).body.pagination.total).toBe(0);

    /* One report, by the job's id or by its number — with stable ids. */
    const one = await call(`/reports/${first.id}`, { token: tech.token });
    expect(one.body.report).toMatchObject({ reportNumber: "MR-0001", orderId: first.id, orderNumber: first.orderNumber, orderType: "service",
      subject: { kind: "machine", id: String(m._id), name: "SM-001 Juki" }, problem: "Needle mechanism jammed", rootCause: "Worn internal component",
      workPerformed: "Component replaced and timing adjusted", repairMinutes: 85, repairDuration: "1 hr 25 min", finalStatus: "operational", finalStatusLabel: "Operational" });
    expect(one.body.report.technician.id).toBeTruthy();
    expect(one.body.subjectReports.map((x) => x.reportNumber)).toEqual(["MR-0002", "MR-0001"]);
    expect((await call("/reports/mr-0002", { token: tech.token })).body.report.orderId).toBe(second.id);
    expect((await call("/reports/MR-9999", { token: tech.token })).status).toBe(404);
    expect((await call(`/reports/${new mongoose.Types.ObjectId()}`, { token: tech.token })).status).toBe(404);

    /* The overview: totals, today, machines repaired more than once, the latest. */
    const ov = (await call("/overview", { token: tech.token })).body;
    expect(ov.reports).toMatchObject({ total: 3, today: 3, repeatMachines: 1 });
    expect(ov.reports.recent.map((r) => r.reportNumber)).toEqual(["MR-0003", "MR-0002", "MR-0001"]);
  });

  test("a report is written once: no step, no direct write, can change it", async () => {
    const tech = await person({ grant: "editor" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Fan" }, problem: "Noisy" })).body.order;
    await step(tech.token, o.id, "start");
    await finish(tech.token, o.id);
    const before = await MaintenanceOrder.findById(o.id).lean();
    expect((await report(tech.token, o.id, { workPerformed: "Something else entirely" })).status).toBe(409);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $set: { "finalReport.finalStatus": "out-of-service" } })).rejects.toThrow(/written once/);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $set: { report: { workPerformed: "rewritten" } } })).rejects.toThrow(/written once/);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $set: { partsUsed: [] } })).rejects.toThrow(/written once/);
    await expect(MaintenanceOrder.updateOne({ _id: o.id }, { $unset: { finalReport: 1 } })).rejects.toThrow(/never replaced or deleted/);
    expect(await MaintenanceOrder.findById(o.id).lean()).toEqual(before);
  });

  /* 4 Oct 2026: the report people keep is a PDF, one per job. */
  test("each report downloads as its own PDF, the same document every time; no report, no PDF", async () => {
    const tech = await person({ grant: "editor" });
    const viewer = await person({ grant: "viewer" });
    const m = await machine("SM-001 Juki");
    const o = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(m._id) }, problem: "Needle mechanism jammed" })).body.order;
    const pdf = (token, id) => fetch(`${base}/reports/${id}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
    await step(tech.token, o.id, "start");
    expect((await pdf(tech.token, o.id)).status).toBe(404); // no report yet
    await finish(tech.token, o.id, { rootCause: "Worn internal component", partsUsed: [{ name: "Needle bar", quantity: 1, unit: "Pcs" }] });
    const r = await pdf(viewer.token, o.id);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="MR-0001_MSO-0001_SM-001-Juki.pdf"');
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
    expect((await pdf(tech.token, "MR-0001")).status).toBe(200);
    expect((await pdf(tech.token, "MR-0404")).status).toBe(404);
    expect((await fetch(`${base}/reports/${o.id}/pdf`)).status).toBe(401);
  });

  test("creating a job, scanning a barcode or cancelling never makes a report; a viewer reads reports and cannot submit one", async () => {
    const tech = await person({ grant: "editor" });
    const viewer = await person({ grant: "viewer" });
    const m = await machine("SM-RPT");
    const code = await tagOf(tech.token, m);
    await call(`/subjects/resolve?code=${encodeURIComponent(code)}`, { token: tech.token });
    const o = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Check" })).body.order;
    const c = (await create(tech.token, { orderType: "service", service: { title: "Raised by mistake" }, problem: "x x x" })).body.order;
    await step(tech.token, c.id, "cancel", { reason: "Raised by mistake" });
    expect(await MaintenanceOrder.countDocuments({ "finalReport.reportNumber": { $exists: true } })).toBe(0);
    expect((await call("/reports", { token: viewer.token })).body.reports).toEqual([]);
    await step(tech.token, o.id, "start");
    await step(tech.token, o.id, "done");
    expect((await report(viewer.token, o.id)).status).toBe(403);
    expect((await report(tech.token, o.id)).status).toBe(200);
    expect((await call(`/reports/${o.id}`, { token: viewer.token })).status).toBe(200);
  });
});

/* ── THE REPORT'S REQUIRED FACTS, THE PDF'S SECTIONS, THE APPROVAL (owner, 4 Oct 2026) ── */
describe("Maintenance Reports — required facts, asset details, approval", () => {
  test("a report cannot be finalised without the machine's ID; a free-form job names its own equipment", async () => {
    const tech = await person({ grant: "editor" });
    const noId = await machine("Unnumbered", { serialNumber: "" }).catch(() => null);
    if (noId) {
      const o = (await create(tech.token, { orderType: "service", subject: { kind: "machine", id: String(noId._id) }, problem: "Noisy" })).body.order;
      await step(tech.token, o.id, "start");
      await step(tech.token, o.id, "done");
      const r = await report(tech.token, o.id);
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("This machine / asset has no ID in the register. Add its ID there, then submit the report.");
      expect((await MaintenanceOrder.findById(o.id).lean()).status).toBe("DONE");
    }
    const f = (await create(tech.token, { orderType: "service", service: { title: "AC unit – office" }, problem: "Not cooling" })).body.order;
    await step(tech.token, f.id, "start");
    const r2 = await finish(tech.token, f.id, { assetRef: "AC-OFF-02", assetMakeModel: "Daikin FTKF50" });
    expect(r2.body.order.finalReport.asset).toMatchObject({ name: "AC unit – office", code: "AC-OFF-02", makeModel: "Daikin FTKF50" });
  });

  test("the asset as it stood when the report was written: ID, barcode, make/model, serial, the job's department", async () => {
    const tech = await person({ grant: "editor" });
    const m = await machine("SM-ASSET", { model: "Juki DDL-8700" });
    const code = await tagOf(tech.token, m);
    const o = (await create(tech.token, { orderType: "product", subject: { kind: "machine", id: String(m._id) }, problem: "Oil leak", details: { department: "Sewing" } })).body.order;
    await step(tech.token, o.id, "start");
    await startedMinutesAgo(o.id, 50);
    const r = await finish(tech.token, o.id, { testResult: "Ran 10 minutes, no leak" });
    expect(r.body.order.finalReport).toMatchObject({ testResult: "Ran 10 minutes, no leak",
      asset: { name: "SM-ASSET", code: m.serialNumber, barcode: code, makeModel: "Juki DDL-8700", serialNumber: m.serialNumber, department: "Sewing", location: "Sewing Section A" } });
    /* Renaming the machine later does not change the report. */
    await Machine.updateOne({ _id: m._id }, { $set: { name: "Renamed", model: "Other" } });
    const view = (await call(`/reports/${o.id}`, { token: tech.token })).body.report;
    expect(view.asset).toMatchObject({ name: "SM-ASSET", makeModel: "Juki DDL-8700" });
    expect(view.repairMinutes).toBe(50);
    /* Downtime is reported → repair completed (here the test moved only the start back). */
    expect(view.downtimeMinutes).toBe(Math.round((new Date(view.completedAt) - new Date(view.reportedAt)) / 60000));
    expect(view.reportedBy.name).toBe(tech.fullName);
    expect(view.revision).toBe("Original — never revised · awaiting approval");
  });

  test("checked / approved: once, by an owner; it changes nothing the report says", async () => {
    const tech = await person({ grant: "editor" });
    const owner = await person({ grant: "owner", name: "Head" });
    const o = (await create(tech.token, { orderType: "service", service: { title: "Boiler" }, problem: "Pressure low" })).body.order;
    await step(tech.token, o.id, "start");
    await finish(tech.token, o.id);
    const before = await MaintenanceOrder.findById(o.id).lean();
    expect((await call(`/reports/${o.id}/approve`, { token: tech.token, method: "POST", body: {} })).status).toBe(403);
    const ok = await call(`/reports/${o.id}/approve`, { token: owner.token, method: "POST", body: { note: "Checked on site" } });
    expect(ok.status).toBe(200);
    expect(ok.body.report).toMatchObject({ approvedBy: { name: owner.fullName }, approvalNote: "Checked on site", revision: "Original — never revised · approved" });
    const again = await call(`/reports/${o.id}/approve`, { token: owner.token, method: "POST", body: {} });
    expect(again.status).toBe(409);
    const after = await MaintenanceOrder.findById(o.id).lean();
    const { approvedAt, approvedBy, approvalNote, ...rest } = after.finalReport;
    expect(rest).toEqual(before.finalReport);
    expect(after.report).toEqual(before.report);
    expect(after.events.at(-1)).toMatchObject({ action: "report-approved", note: "MR-0001 — Checked on site" });
    /* An approval-shaped write cannot smuggle in a change to the report. */
    await expect(MaintenanceOrder.updateOne({ _id: o.id, "finalReport.approvedAt": { $exists: false } }, { $set: { "finalReport.finalStatus": "out-of-service" } })).rejects.toThrow(/written once/);
    const pdf = await fetch(`${base}/reports/${o.id}/pdf`, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(pdf.status).toBe(200);
  });
});
