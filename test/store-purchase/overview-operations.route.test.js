// test/store-purchase/overview-operations.route.test.js
//
// CHUNK 10A — the operational home read model. Proves the honesty contract:
//   · company-scoped DB counts (another company's work is not counted);
//   · zero is "available, count 0" — never omitted, never "unavailable";
//   · a section whose query fails becomes { available:false, reason } WITHOUT
//     turning into a silent zero and without failing the whole overview;
//   · top rows are bounded and hasMore is set (no full-collection paging);
//   · counts are counts — no quantity is summed across unlike units;
//   · service work is a separate section from the stock queues;
//   · reservation shortage / ready-to-pick / partly-issued stay distinct;
//   · receipts-to-inspect and put-away-pending are distinct sections;
//   · rows carry a real date but the server never labels anything "overdue";
//   · exceptions is a link, not a fabricated number.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const oid = () => new mongoose.Types.ObjectId();

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/overview/operations", require("../../routes/CMS_Routes/Inventory/overview/operations"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/overview/operations`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (emp) => fetch(base, {
  headers: { Authorization: `Bearer ${jwt.sign({ id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: `${emp.firstName} ${emp.lastName}`, email: emp.email }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" })}` },
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Store", ...o });

async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Ov Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Other Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, biometricId: `ST${n}` });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });
  return { company, other, store };
}

const makePO = (companyId, status, i) => PurchaseOrder.create({ companyId, poNumber: `PO/${companyId}/${status}/${i}`, status, vendorName: `V${i}`, totalAmount: 100, createdBy: oid() });

test("company-scoped counts, bounded rows + hasMore, and zero ≠ unavailable", async () => {
  const s = await seed();
  for (let i = 0; i < 7; i++) await makePO(s.company._id, "DRAFT", i);   // 7 to issue
  await makePO(s.company._id, "ISSUED", 0);                              // 1 to receive
  await makePO(s.other._id, "DRAFT", 99);                               // another company — not counted

  const r = await call(s.store);
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  const sec = r.body.sections;

  // Company-scoped count, bounded top rows, hasMore.
  expect(sec.posToIssue.available).toBe(true);
  expect(sec.posToIssue.count).toBe(7);                 // NOT 8 — other company excluded
  expect(sec.posToIssue.rows.length).toBe(5);           // bounded
  expect(sec.posToIssue.hasMore).toBe(true);
  expect(sec.posToIssue.href).toMatch(/status=DRAFT/);  // a filter the PO page understands

  expect(sec.posToReceive.count).toBe(1);

  // Zero is available with count 0 — never omitted, never "unavailable".
  expect(sec.openStockCounts.available).toBe(true);
  expect(sec.openStockCounts.count).toBe(0);
  expect(sec.serviceAcceptance.available).toBe(true);
  expect(sec.serviceAcceptance.count).toBe(0);

  // exceptions is an honest link, not a number.
  expect(sec.exceptions.linkOnly).toBe(true);
  expect(sec.exceptions.href).toMatch(/purchase-exceptions/);
});

test("a failing section becomes unavailable-with-reason, not a silent zero, and the rest still load", async () => {
  const s = await seed();
  await makePO(s.company._id, "ISSUED", 0);
  // Break ONLY the purchase-order reads.
  jest.spyOn(PurchaseOrder, "countDocuments").mockRejectedValue(new Error("db down"));

  const r = await call(s.store);
  expect(r.status).toBe(200);                            // the whole home still loads
  const sec = r.body.sections;
  expect(sec.posToIssue.available).toBe(false);          // NOT count 0
  expect(sec.posToIssue.count).toBeUndefined();
  expect(sec.posToIssue.unavailableReason).toMatch(/purchase orders/i);
  // A different section that does not depend on POs is unaffected.
  expect(sec.openStockCounts.available).toBe(true);
  expect(sec.openStockCounts.count).toBe(0);
});

test("service work is a separate section from the stock queues, and stock sections stay distinct", async () => {
  const s = await seed();
  await ServiceOrder.create({ companyId: s.company._id, serviceOrderNumber: `SO-${Date.now()}`, status: "COMPLETION_REPORTED", vendorName: "Fixit", title: "Repair", spendRequestId: oid() });
  const r = await call(s.store);
  const sec = r.body.sections;
  // Services are their own queue, never folded into reservations/receiving.
  expect(sec.serviceAcceptance.count).toBe(1);
  expect(sec).toHaveProperty("reservationShortages");
  expect(sec).toHaveProperty("readyToPick");
  expect(sec).toHaveProperty("partlyIssued");
  expect(sec).toHaveProperty("receiptsToInspect");
  expect(sec).toHaveProperty("putawayPending");
  // Distinct keys — accepted-not-put-away is not the same queue as inspect.
  expect(sec.receiptsToInspect).not.toBe(sec.putawayPending);
});

test("reservation shortage / ready-to-pick / partly-issued are counted distinctly, in counts not summed quantities", async () => {
  const s = await seed();
  const base = { companyId: s.company._id, mrfId: s.company._id, mrfLineId: s.company._id, rawItemId: s.company._id, unit: "m", requestedQty: 10, mrfNumber: "MRF/x", itemName: "Cotton" };
  // A backordered (shortage) reservation, in metres.
  await StockReservation.create({ ...base, status: "PARTIALLY_RESERVED", active: true, reservedQty: 6, backorderedQty: 4 });
  // A fully-reserved (ready to pick) reservation, in a DIFFERENT unit — must never be summed with the metres above.
  await StockReservation.create({ ...base, unit: "kg", status: "RESERVED", active: true, reservedQty: 10, backorderedQty: 0 });
  // A partly-issued reservation.
  await StockReservation.create({ ...base, status: "PARTIALLY_ISSUED", active: true, reservedQty: 10, issuedQty: 4, backorderedQty: 0 });

  const r = await call(s.store);
  const sec = r.body.sections;
  expect(sec.reservationShortages.count).toBe(1);
  expect(sec.readyToPick.count).toBe(1);
  expect(sec.partlyIssued.count).toBe(1);
  // Each count is an integer count of documents — no summed quantity field that
  // would mix metres and kilograms.
  expect(Number.isInteger(sec.reservationShortages.count)).toBe(true);
  expect(sec.readyToPick.href).toMatch(/group=READY_TO_PICK/);
  expect(sec.reservationShortages.href).toMatch(/group=BACKORDERED/);
});

test("rows carry a real date but the server never labels work 'overdue'", async () => {
  const s = await seed();
  await makePO(s.company._id, "DRAFT", 0);
  const r = await call(s.store);
  const raw = JSON.stringify(r.body.sections);
  expect(raw).not.toMatch(/overdue/i);   // no invented lateness
  expect(r.body.sections.posToIssue.rows[0]).toHaveProperty("createdAt");
});
