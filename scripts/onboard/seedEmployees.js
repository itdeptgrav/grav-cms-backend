/**
 * REGISTER TEST EMPLOYEES FOR ANY PRODUCT, MEASURED AGAINST ITS OWN CHART, AND SEND THEIR WORK TO CUTTING.
 *
 *     node scripts/onboard/seedEmployees.js <prepared.json> [--per-size=10] [--dry-run]
 *     node scripts/onboard/seedEmployees.js <prepared.json> --cleanup
 *
 * The same documents, in the same order, that seed_cad_test_orders.js creates for the shirt — employees, their
 * measurement record, the customer request, the internal order, the work orders and every employee's production
 * progress — but driven by whatever fields the product's chart has rather than the shirt's eight. The real routes it
 * mirrors are listed in that script's header and are not repeated here.
 *
 * SAFETY, unchanged from that script: everything lives under ONE test customer per product, marked by the email
 * `cadtest.<product>@internal.gravtest.com`, every UIN starts "CADTEST-", and `--cleanup` removes all of it. No real
 * employee and no real order is read or written. A manifest of every id created is written next to this script.
 *
 * Each employee is generated inside one chart size: the size's key field (chest for a blazer, waist for a trouser)
 * is drawn between that size and the next, every other field follows the chart at that point, and then each field
 * is moved by its own random amount — so two people in the same size still differ part by part, which is what
 * grading has to cope with.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Customer = require("../../models/Customer_Models/Customer");
const EmployeeMpc = require("../../models/Customer_Models/Employee_Mpc");
const Measurement = require("../../models/Customer_Models/Measurement");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const SalesDepartment = require("../../models/SalesDepartment");

const argv = process.argv.slice(2);
const flag = (k) => argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const val = (k, d) => { const f = flag(k); return f && f.includes("=") ? f.split("=")[1] : d; };
const DRY = !!flag("dry-run");
const CLEANUP = !!flag("cleanup");
const rec = JSON.parse(fs.readFileSync(argv[0], "utf8"));
const PER_SIZE = parseInt(val("per-size", rec.employees?.perSize || 10), 10);
const REF = rec.productRef;
const TEST_ORG_EMAIL = `cadtest.${REF.toLowerCase().replace(/[^a-z0-9]/g, "")}@internal.gravtest.com`;
const UIN_PREFIX = "CADTEST-";
const MANIFESTS = path.join(__dirname, "manifests");
fs.mkdirSync(MANIFESTS, { recursive: true });

/* a seeded random, so a re-run makes the same people and a bug can be reproduced */
let seed = Array.from(REF).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const uniform = (lo, hi) => lo + rand() * (hi - lo);
const q = (v) => Math.round(v * 4) / 4;
const fmt = (n) => Number(n.toFixed(2)).toString();

const MALE = ["Amit", "Rohit", "Suresh", "Rajesh", "Vikram", "Anil", "Sanjay", "Manoj", "Deepak", "Ravi", "Ajay", "Vijay", "Arun", "Ashok", "Naveen",
  "Pramod", "Sandeep", "Rakesh", "Gopal", "Prakash", "Sunil", "Vinod", "Alok", "Bikash", "Debashish", "Subrat", "Bijay", "Nirmal", "Santosh", "Kishore"];
const FEMALE = ["Priya", "Anita", "Sunita", "Kavita", "Neha", "Pooja", "Swati", "Rekha", "Meena", "Sarita", "Anjali", "Divya", "Shweta", "Nisha", "Ritu",
  "Manisha", "Suman", "Vandana", "Geeta", "Lata", "Sushmita", "Ipsita", "Rashmi", "Sabita", "Namrata", "Pallavi", "Jyotsna", "Alka", "Deepika", "Kiran"];
const SURNAMES = ["Sharma", "Verma", "Patel", "Nayak", "Mohanty", "Das", "Sahoo", "Pradhan", "Behera", "Rout", "Panda", "Mishra", "Tripathy", "Sethi",
  "Choudhury", "Reddy", "Naidu", "Iyer", "Menon", "Pillai", "Gupta", "Singh", "Kumar", "Yadav", "Chauhan", "Rana", "Thapa", "Rai", "Gurung", "Tamang"];
const DEPARTMENTS = ["Front Office", "Guest Relations", "Concierge", "Operations", "Administration", "Food & Beverage"];
const DESIGNATIONS = ["Executive", "Senior Executive", "Assistant Manager", "Manager", "Team Lead"];

async function cleanup() {
  const org = await Customer.findOne({ email: TEST_ORG_EMAIL });
  if (!org) { console.log(`no test org ${TEST_ORG_EMAIL} — nothing to remove`); return; }
  const requests = await CustomerRequest.find({ customerId: org._id }).select("_id").lean();
  const ids = requests.map((r) => r._id);
  const p = await EmployeeProductionProgress.deleteMany({ manufacturingOrderId: { $in: ids } });
  const w = await WorkOrder.deleteMany({ customerRequestId: { $in: ids } });
  const r = await CustomerRequest.deleteMany({ customerId: org._id });
  const m = await Measurement.deleteMany({ organizationId: org._id });
  const e = await EmployeeMpc.deleteMany({ customerId: org._id });
  await Customer.deleteOne({ _id: org._id });
  console.log(`removed: ${p.deletedCount} progress, ${w.deletedCount} work orders, ${r.deletedCount} requests, ${m.deletedCount} measurement docs, ${e.deletedCount} employees, the org`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (CLEANUP) { await cleanup(); await mongoose.disconnect(); return; }

  const item = await StockItem.findOne({ reference: REF });
  if (!item) throw new Error(`no product ${REF}`);
  const fields = (item.measurements || []).length ? item.measurements : rec.chartFields;
  const keyField = fields.find((f) => f.toLowerCase() === String(rec.designatedGroup).toLowerCase()) || rec.employees.keyField;
  const jitter = rec.employees?.jitter || {};
  const ladder = Object.entries(rec.chart)
    .map(([size, row]) => ({ size, row: Object.fromEntries(fields.map((f) => [f, Number(row[f] ?? row[f.toLowerCase()])])) }))
    .filter((r) => Number.isFinite(r.row[keyField]))
    .sort((a, b) => a.row[keyField] - b.row[keyField]);
  const at = (key, f) => {
    /* the chart at an arbitrary key value: linear between rows, carried on past the ends */
    const n = ladder.length;
    let i = ladder.findIndex((r, k) => k < n - 1 && key <= ladder[k + 1].row[keyField]);
    if (i < 0) i = n - 2;
    const a = ladder[i], b = ladder[i + 1];
    const t = (key - a.row[keyField]) / (b.row[keyField] - a.row[keyField]);
    return a.row[f] + t * (b.row[f] - a.row[f]);
  };
  const resolved = (key) => { let s = ladder[0].size; for (const r of ladder) if (key >= r.row[keyField]) s = r.size; return s; };
  const variantFor = (size, key) => {
    const vs = item.variants || [];
    const exact = vs.find((v) => (v.attributes || []).some((a) => a.name === "Size" && String(a.value) === size));
    if (exact) return exact;
    const numeric = vs.map((v) => ({ v, n: parseFloat((v.attributes || []).find((a) => a.name === "Size")?.value) })).filter((x) => Number.isFinite(x.n));
    if (numeric.length) return numeric.reduce((m, x) => (Math.abs(x.n - key) < Math.abs(m.n - key) ? x : m)).v;
    /* letter sizes the product does not stock: the nearest stocked size in chart order */
    const order = ladder.map((r) => r.size);
    const stocked = vs.map((v) => ({ v, i: order.indexOf((v.attributes || []).find((a) => a.name === "Size")?.value) })).filter((x) => x.i >= 0);
    const want = order.indexOf(size);
    return stocked.length ? stocked.reduce((m, x) => (Math.abs(x.i - want) < Math.abs(m.i - want) ? x : m)).v : vs[0];
  };

  /*
   * WHO THE TEST ORDER IS FROM.
   *
   * The shirt seeder attributed its orders to the first sales-department user. There is none any more, and the only
   * sales person in the database is a real person whose dashboard these orders must not appear on. So the order is
   * attributed to a fixed placeholder id that belongs to nobody and is easy to find: ...cad7e5.
   */
  const salesUser = (await SalesDepartment.findOne({})) || { _id: new mongoose.Types.ObjectId("000000000000000000cad7e5"), name: "CAD test seeder" };
  let org = await Customer.findOne({ email: TEST_ORG_EMAIL });
  if (org) { console.log(`test org already exists (${org._id}) — run --cleanup first to reseed`); await mongoose.disconnect(); return; }

  const batch = Date.now().toString(36);
  const employees = [], entries = [], hist = {};
  let seq = 0;
  for (let bi = 0; bi < ladder.length; bi++) {
    const lo = ladder[bi].row[keyField];
    const hi = bi + 1 < ladder.length ? ladder[bi + 1].row[keyField] - 0.25 : lo + (lo - ladder[bi - 1].row[keyField]) * 0.75;
    for (let i = 0; i < PER_SIZE; i++) {
      const gender = i % 2 === 0 ? "Male" : "Female";
      const key = q(uniform(lo, hi));
      const m = {};
      for (const f of fields) {
        if (f === keyField) { m[f] = key; continue; }
        const base = at(key, f);
        m[f] = q(base + uniform(-(jitter[f] || 0), jitter[f] || 0));
      }
      const size = resolved(key);
      hist[size] = (hist[size] || 0) + 1;
      const variant = variantFor(size, key);
      const name = `${pick(gender === "Male" ? MALE : FEMALE)} ${pick(SURNAMES)}`;
      const uin = `${UIN_PREFIX}${gender[0]}-${batch}-${String(++seq).padStart(4, "0")}`;
      const _id = new mongoose.Types.ObjectId();
      employees.push({
        _id, customerId: null, name, uin, gender, department: pick(DEPARTMENTS), designation: pick(DESIGNATIONS),
        products: [{ productId: item._id, variantId: variant?._id || null, quantity: 1, productName: item.name }], status: "active",
      });
      entries.push({
        employeeId: _id, employeeName: name, employeeUIN: uin, gender, noProductAssigned: false, isCompleted: true, completedAt: new Date(),
        products: [{
          productId: item._id, productName: item.name, variantId: variant?._id || null,
          variantName: variant ? (variant.attributes || []).map((a) => a.value).join(" • ") || "Default" : "Default",
          quantity: 1, measuredAt: new Date(),
          measurements: fields.map((f) => ({ measurementName: f, value: fmt(m[f]), unit: "inches" })),
        }],
        categoryMeasurements: [], _size: size, _m: m,
      });
    }
  }
  console.log(`${REF}: ${employees.length} employees over ${ladder.length} sizes by ${keyField}; resolved sizes ${JSON.stringify(hist)}`);
  console.log("sample:", entries.slice(0, 3).map((e) => `${e.employeeName} ${e._size} ${JSON.stringify(e._m)}`).join("\n        "));
  if (DRY) { console.log("[dry run] nothing written"); await mongoose.disconnect(); return; }

  org = await Customer.create({
    name: `CAD TEST ORG — ${item.name} — DO NOT USE FOR REAL ORDERS`, email: TEST_ORG_EMAIL, phone: "0000000000",
    password: `cadtest-${Date.now()}`, isActive: true, isEmailVerified: true, createdBySales: true,
    salesAssignedBy: salesUser._id, salesAssignedByName: salesUser.name,
  });
  for (const e of employees) { e.customerId = org._id; e.createdBy = org._id; }
  await EmployeeMpc.insertMany(employees, { ordered: false });
  const clean = entries.map(({ _size, _m, ...e }) => e);
  const totalFields = clean.reduce((a, e) => a + e.products[0].measurements.length, 0);
  const mdoc = await Measurement.create({
    organizationId: org._id, organizationName: org.name, name: `CAD Test — ${item.name} — batch ${batch}`,
    description: `Generated test data for pattern grading QA: ${employees.length} employees, ${PER_SIZE} per chart size.`,
    registeredEmployeeIds: employees.map((e) => e._id), employeeMeasurements: clean,
    totalRegisteredEmployees: employees.length, measuredEmployees: employees.length, pendingEmployees: 0, completionRate: 100,
    totalMeasurements: totalFields, completedMeasurements: totalFields, pendingMeasurements: 0, createdBy: salesUser._id,
  });

  /* convert-to-po */
  const lines = new Map();
  for (const e of clean) {
    const p = e.products[0], k = String(p.variantId || "default");
    if (!lines.has(k)) {
      const v = item.variants.find((x) => String(x._id) === k);
      lines.set(k, { variantId: p.variantId, attrs: (v?.attributes || []).map((a) => ({ name: a.name, value: a.value })), qty: 0 });
    }
    lines.get(k).qty += 1;
  }
  const count = await CustomerRequest.countDocuments();
  const request = new CustomerRequest({
    requestId: `REQ-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`,
    customerId: org._id,
    customerInfo: { name: org.name, email: org.email, phone: org.phone, address: "", city: "", postalCode: "",
      description: `PO from measurement: ${mdoc.name}`, deliveryDeadline: new Date(Date.now() + 30 * 864e5), preferredContactMethod: "phone" },
    items: [{
      stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference,
      variants: [...lines.values()].map((l) => ({ variantId: String(l.variantId), attributes: l.attrs, quantity: l.qty, specialInstructions: [], estimatedPrice: l.qty * (item.baseSalesPrice || 0) })),
      totalQuantity: employees.length, totalEstimatedPrice: employees.length * (item.baseSalesPrice || 0),
    }],
    status: "pending", priority: "high", measurementId: mdoc._id, measurementName: mdoc.name, requestType: "measurement_conversion",
  });
  await request.save();
  await Measurement.findByIdAndUpdate(mdoc._id, { convertedToPO: true, poRequestId: request._id, poConversionDate: new Date(), convertedBy: salesUser._id });

  /* mark-internal-order + one work order per gender, as the shirt seeder groups them */
  request.isInternalOrder = true;
  request.internalOrderMarkedAt = new Date();
  request.quotations = [{
    date: new Date(), validUntil: new Date(Date.now() + 365 * 864e5), items: [], subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0,
    shippingCharges: 0, grandTotal: 0, status: "sales_approved", notes: "Internal / Company Order — CAD pattern-grading QA test data.",
    customerApproval: { approved: true, approvedAt: new Date() }, salesApproval: { approved: true, approvedAt: new Date(), approvedBy: salesUser._id },
  }];
  request.status = "quotation_sales_approved";
  request.finalOrderPrice = 0;
  request.salesPersonAssigned = salesUser._id;

  const workOrders = [];
  for (const gender of ["Male", "Female"]) {
    const people = clean.filter((e) => e.gender === gender);
    if (!people.length) continue;
    const mid = people[Math.floor(people.length / 2)];
    const variant = item.variants.find((v) => String(v._id) === String(mid.products[0].variantId)) || item.variants[0];
    const _id = new mongoose.Types.ObjectId();
    const wo = new WorkOrder({
      _id, workOrderNumber: `WO-${String(_id).slice(-8)}`, customerRequestId: request._id, stockItemId: item._id,
      stockItemName: item.name, stockItemReference: item.reference, variantId: String(variant._id),
      variantAttributes: (variant.attributes || []).map((a) => ({ name: a.name, value: a.value })),
      quantity: people.length, originalQuantity: people.length, customerId: org._id, customerName: org.name, priority: "high",
      status: "planned",
      operations: (item.operations || []).map((op) => ({ operationType: op.type || op.name || op.operationType, operationCode: op.operationCode || op.code || "", plannedTimeSeconds: op.totalSeconds || op.durationSeconds || 0, status: "pending" })),
      rawMaterials: (variant.rawItems || []).map((ri) => ({
        rawItemId: ri.rawItemId, name: ri.rawItemName, sku: ri.rawItemSku, rawItemVariantId: ri.variantId || null,
        rawItemVariantCombination: ri.variantCombination || [], requiredQuantity: (ri.requiredQuantity ?? ri.quantity ?? 0) * people.length,
        allowancePercent: ri.allowancePercent || 0, quantityRequired: (ri.quantity || 0) * people.length,
        quantityAllocated: (ri.quantity || 0) * people.length, quantityIssued: 0, unit: ri.unit, unitCost: ri.unitCost,
        totalCost: (ri.totalCost || 0) * people.length, allocationStatus: "fully_allocated",
      })),
      estimatedCost: 0, actualCost: 0, createdBy: salesUser._id,
      /* send-to-cutting, as the web button does */
      sentToCutting: true, sentToCuttingAt: new Date(),
    });
    await wo.save();
    workOrders.push(wo);
    let unit = 1;
    for (const e of people) {
      await EmployeeProductionProgress.findOneAndUpdate(
        { workOrderId: wo._id, employeeId: e.employeeId },
        { $set: {
          measurementId: mdoc._id, manufacturingOrderId: request._id, orderType: "measurement_conversion",
          employeeName: e.employeeName, employeeUIN: e.employeeUIN, gender: e.gender, unitStart: unit, unitEnd: unit, totalUnits: 1,
          assignedBarcodeIds: [`${wo.workOrderNumber}-${String(unit).padStart(3, "0")}`], completedUnits: 0, completedUnitNumbers: [],
          completionPercentage: 0, lastSyncedAt: new Date(),
        } },
        { upsert: true, new: true },
      );
      unit += 1;
    }
  }
  request.notes = request.notes || [];
  request.notes.push({ text: `Internal order; ${workOrders.length} work order(s) created and sent to cutting. [seeded by scripts/onboard/seedEmployees.js]`, addedBy: salesUser._id, addedByModel: "SalesDepartment", createdAt: new Date() });
  await request.save();

  const manifest = {
    productRef: REF, createdAt: new Date().toISOString(), testOrg: { id: org._id, email: TEST_ORG_EMAIL },
    measurementId: mdoc._id, requestId: request.requestId, requestObjectId: request._id,
    workOrders: workOrders.map((w) => ({ id: w._id, number: w.workOrderNumber, quantity: w.quantity, variant: w.variantAttributes })),
    employees: clean.map((e, i) => ({ id: e.employeeId, uin: e.employeeUIN, name: e.employeeName, gender: e.gender, size: entries[i]._size, measurements: entries[i]._m })),
    cleanup: `node scripts/onboard/seedEmployees.js ${path.relative(process.cwd(), argv[0])} --cleanup`,
  };
  const mf = path.join(MANIFESTS, `${REF}.json`);
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
  console.log(`created org ${org._id}, ${employees.length} employees, request ${request.requestId}, work orders ${workOrders.map((w) => `${w.workOrderNumber}(${w.quantity})`).join(", ")} — sent to cutting`);
  console.log(`manifest -> ${mf}`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
