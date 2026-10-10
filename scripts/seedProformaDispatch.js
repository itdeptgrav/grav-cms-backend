// scripts/seedProformaDispatch.js
//
// A PROFORMA WITH AN ORDER AND REAL DISPATCHES BEHIND IT — for verifying the
// "Dispatched against this PI" panel and "Create invoice from dispatched
// items" end to end.
//
//   node -r dotenv/config scripts/seedProformaDispatch.js
//   node -r dotenv/config scripts/seedProformaDispatch.js --company "GRAV CLOTHING"
//   node -r dotenv/config scripts/seedProformaDispatch.js --undo
//   node -r dotenv/config scripts/seedProformaDispatch.js --orders   (reads only)
//
// DEV/DEMO ONLY — refuses to run with NODE_ENV=production. Idempotent: every
// document it writes is keyed on a DEMO reference, so re-running updates
// rather than duplicating, and --undo removes exactly what it made and
// nothing else.
//
// WHAT IT BUILDS, AND WHY EACH PIECE IS THERE
//   • one customer and one order (CustomerRequest) — the thing dispatches
//     hang off, and what the PI's order link points at;
//   • TWO challans, one bulk with cartons and one person-wise, because the
//     roll-up has to prove it folds both shapes into the same billable line
//     and that the same product across two challans is ONE row;
//   • TWO proformas: one `sent`, one `accepted`. The accepted one is the
//     point — PUT /:id refuses it, so it proves the separate order-link
//     route works on exactly the document a dispatch gets billed against;
//   • a SHIRT that is dispatched and deliberately NOT priced on the
//     proforma, so the "No rate" row, the unpriced count and the
//     value-excludes-it rule are all visible rather than theoretical.
//
// It then VERIFIES itself: it re-reads what it wrote and runs the real
// services/accounting/proformaDispatch.js over it, printing the table the
// screen will show. If that print is right, the panel is right — the page
// renders this and computes nothing.
"use strict";

const mongoose = require("mongoose");

const { Acc_ProformaInvoice } = require("../models/Accountant_model/Acc_ProformaInvoice");
const { Acc_Company } = require("../models/Accountant_model/Acc_MasterModels");
const Customer = require("../models/Customer_Models/Customer");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const DispatchChallan = require("../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const { dispatchRollup } = require("../services/accounting/proformaDispatch");

// ── The DEMO keys. Everything is found, updated and removed by these. ───────
const REQUEST_ID = "MO-REQ-DEMO-DISPATCH";
/* A SECOND order, for a DIFFERENT customer. Without it the two proformas
   sat on one order and therefore showed the same dispatches — which is what
   "every PI is showing all the dispatch" was. With it, each proforma shows
   only its own challans, and ticking across the two is the refusal to see. */
const REQUEST_ID_B = "MO-REQ-DEMO-DISPATCH-B";
const CHALLANS = ["DC-DEMO-0001", "DC-DEMO-0002", "DC-DEMO-0003"];
/* The third carries NO stored link — only the order number written in its
   buyer's reference. It exists to prove the matching is automatic: opening
   the list resolves and persists it without anybody choosing an order. */
const PI_NUMBERS = ["PI/DEMO/0001", "PI/DEMO/0002", "PI/DEMO/0003"];
/* Customer has `customerId` (a String), NOT `customerCode` — keying on a
   field the schema does not declare meant strict mode dropped it, so every
   run made another customer and --undo deleted none of them. */
const CUSTOMER_ID = "DEMO-RIVERSIDE";
/* The email is effectively unique and is what a stray earlier row would
   carry, so --undo matches on either. Note the TLD: Customer's validator is
   /(\.\w{2,3})+$/, which refuses a 4-letter TLD like ".test". */
const CUSTOMER_EMAIL = "accounts@riversidedemo.com";
const CUSTOMER_ID_B = "DEMO-HILLVIEW";
const CUSTOMER_EMAIL_B = "accounts@hillviewdemo.com";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(name);

const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

/** "2026-27" from a date, on the Indian financial year. */
function financialYear(d) {
  const y = d.getFullYear();
  const startYear = d.getMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** One proforma line, with its tax worked out. Intra-state → CGST + SGST. */
function piLine({ name, hsn, qty, rate, taxRate = 12 }) {
  const taxable = Number((qty * rate).toFixed(2));
  const tax = Number((taxable * (taxRate / 100)).toFixed(2));
  const half = Number((tax / 2).toFixed(2));
  return {
    stockItemName: name,
    hsnCode: hsn,
    quantity: qty,
    unit: "Nos",
    rate,
    discountPercent: 0,
    taxableAmount: taxable,
    taxRate,
    cgst: half,
    sgst: Number((tax - half).toFixed(2)),
    igst: 0,
    lineTotal: Number((taxable + tax).toFixed(2)),
  };
}

function piTotals(items) {
  const subtotal = items.reduce((n, i) => n + i.taxableAmount, 0);
  const totalCgst = items.reduce((n, i) => n + i.cgst, 0);
  const totalSgst = items.reduce((n, i) => n + i.sgst, 0);
  const totalTax = totalCgst + totalSgst;
  const grand = subtotal + totalTax;
  const rounded = Math.round(grand);
  return {
    subtotal: Number(subtotal.toFixed(2)),
    totalDiscount: 0,
    totalCgst: Number(totalCgst.toFixed(2)),
    totalSgst: Number(totalSgst.toFixed(2)),
    totalIgst: 0,
    totalTax: Number(totalTax.toFixed(2)),
    roundOff: Number((rounded - grand).toFixed(2)),
    grandTotal: rounded,
  };
}

const BUYER = {
  name: "Riverside Hotels & Resorts (DEMO)",
  addressLines: ["Plot 44, Hospitality Lane", "Nayapalli"],
  city: "Bhubaneswar",
  state: "Odisha",
  stateCode: "21",
  pincode: "751012",
  country: "India",
  gstin: "21AABCR1234M1Z7",
};

async function undo() {
  const order = await CustomerRequest.findOne({ requestId: { $in: [REQUEST_ID, REQUEST_ID_B] } }).lean();
  const r = {
    challans: (await DispatchChallan.deleteMany({ challanNumber: { $in: CHALLANS } })).deletedCount,
    proformas: (await Acc_ProformaInvoice.deleteMany({ voucherNumber: { $in: PI_NUMBERS } })).deletedCount,
    orders: (await CustomerRequest.deleteMany({ requestId: { $in: [REQUEST_ID, REQUEST_ID_B] } })).deletedCount,
    customers: (await Customer.deleteMany({
      $or: [
        { customerId: { $in: [CUSTOMER_ID, CUSTOMER_ID_B] } },
        { email: { $in: [CUSTOMER_EMAIL, CUSTOMER_EMAIL_B] } },
      ],
    })).deletedCount,
  };
  console.log("\nRemoved:", r, order ? "" : "(no demo order was present)");
}

async function seed() {
  // ── The company the accountant is looking at ────────────────────────────
  const wanted = arg("--company");
  const company = wanted
    ? await Acc_Company.findOne({ companyName: new RegExp(wanted, "i") }).lean()
    : (await Acc_Company.findOne({ companyName: /grav/i }).lean()) ||
      (await Acc_Company.findOne({}).lean());
  if (!company) throw new Error("No Acc_Company found. Pass --company \"<name>\".");
  console.log(`Company: ${company.companyName} (${company._id})`);

  // ── Customer ────────────────────────────────────────────────────────────
  let customer =
    (await Customer.findOne({ customerId: CUSTOMER_ID })) ||
    (await Customer.findOne({ email: CUSTOMER_EMAIL }));
  if (!customer) {
    customer = await Customer.create({
      customerId: CUSTOMER_ID,
      name: BUYER.name,
      companyName: BUYER.name,
      email: CUSTOMER_EMAIL,
      phone: "9000000001",
      gstin: BUYER.gstin,
    });
  }

  // ── The order. Its quotation lines are what the Orders search shows. ────
  const quotationItems = [
    { productName: "Reception Blazer", variant: "Size: M", quantity: 50, rate: 1200, unit: "Nos", hsnCode: "6203", gstRate: 12 },
    { productName: "Reception Blazer", variant: "Size: L", quantity: 30, rate: 1350, unit: "Nos", hsnCode: "6203", gstRate: 12 },
    { productName: "Housekeeping Shirt", variant: "", quantity: 40, rate: 450, unit: "Nos", hsnCode: "6205", gstRate: 5 },
  ];
  let order = await CustomerRequest.findOne({ requestId: REQUEST_ID });
  if (!order) order = new CustomerRequest({ requestId: REQUEST_ID });
  order.customerId = customer._id;
  order.customerName = BUYER.name;
  /* "production" — the enum has no "in_production". */
  order.status = "production";
  order.customerInfo = { name: BUYER.name, gstin: BUYER.gstin, deliveryDeadline: new Date(Date.now() + 20 * 864e5) };
  order.quotations = [{ items: quotationItems, grandTotal: 120900, status: "sales_approved" }];
  await order.save();

  // ── Two challans, two shapes ────────────────────────────────────────────
  const variant = (v) => (v ? [{ name: "Size", value: v.replace(/^Size:\s*/, "") }] : []);
  const challanSpecs = [
    {
      challanNumber: CHALLANS[0],
      dispatchType: "bulk",
      dispatchDate: new Date(Date.now() - 6 * 864e5),
      bulkProducts: [
        { productName: "Reception Blazer", quantity: 40, variantAttributes: variant("Size: M") },
        { productName: "Reception Blazer", quantity: 25, variantAttributes: variant("Size: L") },
      ],
      cartonCount: 3,
      cartons: [
        { cartonNumber: "CTN-DEMO-0001", totalQuantity: 25, lines: [] },
        { cartonNumber: "CTN-DEMO-0002", totalQuantity: 25, lines: [] },
        { cartonNumber: "CTN-DEMO-0003", totalQuantity: 15, lines: [] },
      ],
      transport: { vehicleNumber: "OD02AB1234", driverName: "S. Nayak", transporter: "VRL Logistics", lrNumber: "LR-77421" },
    },
    {
      challanNumber: CHALLANS[1],
      dispatchType: "person_wise",
      dispatchDate: new Date(Date.now() - 2 * 864e5),
      persons: [
        {
          employeeName: "Front Desk — A. Mishra", employeeUIN: "RH-001", totalUnits: 10,
          products: [{ productName: "Reception Blazer", quantity: 10, variantAttributes: variant("Size: M") }],
        },
        {
          /* Dispatched, and NOT priced on the proforma. This is the row that
             must read "No rate" and be counted as unpriced. */
          employeeName: "Housekeeping — B. Das", employeeUIN: "RH-002", totalUnits: 15,
          products: [{ productName: "Housekeeping Shirt", quantity: 15, variantAttributes: [] }],
        },
      ],
      cartonCount: 2,
      cartons: [
        { cartonNumber: "CTN-DEMO-0004", totalQuantity: 10, lines: [] },
        { cartonNumber: "CTN-DEMO-0005", totalQuantity: 15, lines: [] },
      ],
      transport: { transporter: "Blue Dart", lrNumber: "BD-55102" },
    },
  ];

  for (const spec of challanSpecs) {
    const totalUnits =
      (spec.bulkProducts || []).reduce((n, p) => n + p.quantity, 0) +
      (spec.persons || []).reduce((n, p) => n + p.products.reduce((m, q) => m + q.quantity, 0), 0);
    await DispatchChallan.findOneAndUpdate(
      { challanNumber: spec.challanNumber },
      {
        $set: {
          ...spec,
          manufacturingOrderId: order._id,
          requestId: REQUEST_ID,
          customerName: BUYER.name,
          source: "carton",
          totalUnits,
          totalPersons: (spec.persons || []).length,
          totalProducts: (spec.bulkProducts || []).length ||
            (spec.persons || []).reduce((n, p) => n + p.products.length, 0),
          dispatchedBy: "Seed script",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  /* ── A SECOND customer, order and challan ───────────────────────────────
     So each proforma shows only ITS order's dispatches, and so that ticking
     a challan from each is a refusal somebody can actually try. */
  const BUYER_B = {
    name: "Hillview Resorts (DEMO)",
    addressLines: ["NH-16, Chandaka"], city: "Bhubaneswar", state: "Odisha",
    stateCode: "21", pincode: "751024", country: "India", gstin: "21AADCH9876P1Z4",
  };
  let customerB =
    (await Customer.findOne({ customerId: CUSTOMER_ID_B })) ||
    (await Customer.findOne({ email: CUSTOMER_EMAIL_B }));
  if (!customerB) {
    customerB = await Customer.create({
      customerId: CUSTOMER_ID_B, name: BUYER_B.name, companyName: BUYER_B.name,
      email: CUSTOMER_EMAIL_B, phone: "9000000002", gstin: BUYER_B.gstin,
    });
  }
  let orderB = await CustomerRequest.findOne({ requestId: REQUEST_ID_B });
  if (!orderB) orderB = new CustomerRequest({ requestId: REQUEST_ID_B });
  orderB.customerId = customerB._id;
  orderB.customerName = BUYER_B.name;
  orderB.status = "production";
  orderB.customerInfo = { name: BUYER_B.name, gstin: BUYER_B.gstin, deliveryDeadline: new Date(Date.now() + 25 * 864e5) };
  orderB.quotations = [{
    items: [{ productName: "Spa Robe", variant: "Size: Free", quantity: 20, rate: 900, unit: "Nos", hsnCode: "6208", gstRate: 12 }],
    grandTotal: 20160, status: "sales_approved",
  }];
  await orderB.save();

  await DispatchChallan.findOneAndUpdate(
    { challanNumber: CHALLANS[2] },
    { $set: {
        challanNumber: CHALLANS[2], manufacturingOrderId: orderB._id, requestId: REQUEST_ID_B,
        customerName: BUYER_B.name, dispatchType: "bulk", source: "carton",
        dispatchDate: new Date(Date.now() - 3 * 864e5),
        bulkProducts: [{ productName: "Spa Robe", quantity: 20, variantAttributes: [{ name: "Size", value: "Free" }] }],
        cartons: [{ cartonNumber: "CTN-DEMO-0006", totalQuantity: 20, lines: [] }],
        cartonCount: 1, totalUnits: 20, totalPersons: 0, totalProducts: 1,
        transport: { transporter: "Delhivery" }, dispatchedBy: "Seed script",
      } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // ── Two proformas, EACH on its own order ────────────────────────────────
  const voucherDate = new Date();
  const items = [
    piLine({ name: "Reception Blazer — Size: M", hsn: "6203", qty: 50, rate: 1200, taxRate: 12 }),
    piLine({ name: "Reception Blazer — Size: L", hsn: "6203", qty: 30, rate: 1350, taxRate: 12 }),
  ];
  const totals = piTotals(items);

  const itemsB = [piLine({ name: "Spa Robe — Size: Free", hsn: "6208", qty: 20, rate: 900, taxRate: 12 })];
  const totalsB = piTotals(itemsB);

  const made = [];
  for (const [i, voucherNumber] of PI_NUMBERS.entries()) {
    const second = i === 1;
    /* The third is Riverside's again, deliberately UNLINKED. */
    const third = i === 2;
    const buyer = second ? BUYER_B : BUYER;
    const doc = {
      companyId: company._id,
      voucherNumber,
      financialYear: financialYear(voucherDate),
      voucherDate,
      validTill: new Date(Date.now() + 30 * 864e5),
      buyer,
      consignee: { ...buyer, name: `${buyer.name} — Site Store` },
      /* The link this whole feature turns on — a DIFFERENT order each. The
         third is left NULL so the automatic matcher has something to find. */
      customerRequestId: third ? null : second ? orderB._id : order._id,
      requestRef: third ? "" : second ? REQUEST_ID_B : REQUEST_ID,
      /* …and the order's number is written where a person would write it. */
      buyersReference: third ? `Against ${REQUEST_ID}` : "RFQ/RH/2026/118",
      dispatchedThrough: "VRL Logistics",
      destination: "Bhubaneswar",
      termsOfDelivery: "Ex-works, freight prepaid",
      paymentTerms: "50% advance, balance on delivery",
      otherReferences: "Seeded demonstration document",
      isInterState: false,
      items: second ? itemsB : items,
      ...(second ? totalsB : totals),
      narration: "Uniform supply for the Nayapalli property.",
      internalNotes: "[seed:proforma-dispatch] safe to delete",
      /* The second one is ACCEPTED on purpose: PUT /:id refuses it, so it is
         the document that proves PATCH /:id/order-link was needed. */
      status: i === 0 ? "sent" : i === 1 ? "accepted" : "sent",
    };
    const pi = await Acc_ProformaInvoice.findOneAndUpdate(
      { companyId: company._id, financialYear: doc.financialYear, voucherNumber },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    made.push(pi);
  }

  return { company, order, orderB, proformas: made };
}

/* ── Prove it, with the real service the screen reads ────────────────────── */
async function verify({ company, order, orderB, proformas }) {
  const challans = await DispatchChallan.find({ manufacturingOrderId: order._id }).sort({ createdAt: 1 }).lean();
  const pi = proformas[0];
  const r = dispatchRollup(challans, pi.items);

  console.log("\n─────────── what the PI panel will show ───────────");
  console.log(`Order ${REQUEST_ID} · ${r.totals.challanCount} challans · ${r.totals.cartonCount} cartons · ${r.totals.units} units`);
  console.log("");
  for (const l of r.lines) {
    const rate = l.rate === null ? "No rate" : money(l.rate);
    const amt = l.amount === null ? "—" : money(l.amount);
    console.log(
      `  ${l.productName.padEnd(22)} ${String(l.variant || "—").padEnd(10)} ` +
      `${String(l.quantity).padStart(4)}  ${rate.padStart(12)}  ${amt.padStart(14)}   ${l.challanNumbers.join(", ")}`,
    );
  }
  console.log("");
  console.log(`  Priced value: ${money(r.totals.value)}   Unpriced lines: ${r.totals.unpriced}`);

  // The checks that make this a verification rather than a printout.
  const blazerM = r.lines.find((l) => l.variant === "Size: M");
  const shirt = r.lines.find((l) => /Shirt/i.test(l.productName));
  const problems = [];
  if (!blazerM || blazerM.quantity !== 50) problems.push(`Blazer M should total 50 across both challans, got ${blazerM?.quantity}`);
  if (!blazerM || blazerM.challanNumbers.length !== 2) problems.push("Blazer M should name both challans");
  if (!shirt || shirt.rate !== null) problems.push("the Shirt is not priced on the PI, so its rate must be null");
  if (r.totals.unpriced !== 1) problems.push(`exactly one unpriced line expected, got ${r.totals.unpriced}`);
  if (r.totals.units !== 90) problems.push(`90 units dispatched expected, got ${r.totals.units}`);
  if (r.totals.value !== 93750) problems.push(`priced value should be ₹93,750 (50×1200 + 25×1350), got ${r.totals.value}`);

  /* ── Each proforma sees ONLY its own order's dispatches ────────────────
     The whole point of this pass. Order B has one challan of its own; if it
     ever appears under order A, the panel is reading the wrong thing. */
  const challansB = await DispatchChallan.find({ manufacturingOrderId: orderB._id }).lean();
  const aNumbers = challans.map((c) => c.challanNumber).sort();
  const bNumbers = challansB.map((c) => c.challanNumber).sort();
  if (aNumbers.length !== 2) problems.push(`order A should have 2 challans, got ${aNumbers.join(",")}`);
  if (bNumbers.length !== 1) problems.push(`order B should have 1 challan, got ${bNumbers.join(",")}`);
  if (aNumbers.some((n) => bNumbers.includes(n))) problems.push("the two orders share a challan");

  /* ── Two customers never share an invoice ──────────────────────────────── */
  const { selectionGuard } = require("../services/accounting/proformaDispatch");
  const mixed = selectionGuard([challans[0], challansB[0]]);
  if (mixed.ok) problems.push("a selection spanning two customers was allowed");
  const sameCustomer = selectionGuard(challans);
  if (!sameCustomer.ok) problems.push(`one customer's challans were refused: ${sameCustomer.reason}`);

  /* ── The third proforma must match itself ──────────────────────────────
     It is stored with no order; only the order number is written on it. If
     the matcher cannot resolve that, "automatically matched" is not true. */
  const { resolveOrderForProforma, isProvenMatch } = require("../services/accounting/proformaOrderMatch");
  const third = proformas.find((p) => p.voucherNumber === "PI/DEMO/0003");
  const auto = third
    ? resolveOrderForProforma(
        { buyersReference: third.buyersReference, customerRequestId: third.customerRequestId },
        [{ _id: order._id, requestId: REQUEST_ID, customerName: order.customerName }],
      )
    : null;
  if (!auto || auto.how !== "reference" || String(auto.orderId) !== String(order._id)) {
    problems.push(`PI/DEMO/0003 should match ${REQUEST_ID} by its written reference, got ${auto?.how}`);
  }
  if (auto && !isProvenMatch(auto)) problems.push("a reference match must be written back automatically");

  console.log("");
  console.log(`  Order A (${REQUEST_ID}): ${aNumbers.join(", ")}`);
  console.log(`  Order B (${REQUEST_ID_B}): ${bNumbers.join(", ")}`);
  console.log(`  Mixing A + B: ${mixed.ok ? "ALLOWED (wrong)" : "refused — " + mixed.reason}`);

  console.log("");
  if (problems.length) {
    console.log("FAILED:");
    for (const p of problems) console.log(`  ✗ ${p}`);
  } else {
    console.log("  ✓ both challans fold into one line per product and variant");
    console.log("  ✓ rates come from the proforma; the unpriced product reads No rate");
    console.log("  ✓ the value total excludes what the proforma does not price");
    console.log("  ✓ each proforma sees only its own order's challans");
    console.log("  ✓ two customers' challans cannot share one invoice");
    console.log("  ✓ PI/DEMO/0003 carries no link and matches its order by the number on it");
  }

  console.log("\n─────────── open these ───────────");
  for (const p of proformas) {
    console.log(`  ${p.voucherNumber} (${p.status})  →  /accountant/proforma-invoices/${p._id}`);
  }
  console.log(`  Create invoice     →  /accountant/sales-vouchers/new?fromPi=${proformas[0]._id}`);
  console.log(`  The PI list        →  /accountant/sales-vouchers  (Proforma Invoices tab)`);
  console.log("");
  return problems.length === 0;
}

/* ── --orders: which REAL orders already have dispatches ──────────────────
   The two proformas already in the books carry no order link, and linking
   one is only useful if that order has actually dispatched something. This
   lists the orders that have challans, newest first, so a real PI can be
   pointed at a real order from the panel's search box. Reads only. */
async function listOrders() {
  const rows = await DispatchChallan.aggregate([
    { $group: {
        _id: "$manufacturingOrderId",
        challans: { $sum: 1 },
        units: { $sum: "$totalUnits" },
        cartons: { $sum: "$cartonCount" },
        last: { $max: "$createdAt" },
        anyNumber: { $first: "$challanNumber" },
      } },
    { $sort: { last: -1 } },
    { $limit: 25 },
  ]);
  if (!rows.length) {
    console.log("\nNo dispatch challans exist in this database at all — run the seed.");
    return;
  }
  const orders = await CustomerRequest.find({ _id: { $in: rows.map((r) => r._id) } })
    .select("requestId customerName status")
    .lean();
  const byId = new Map(orders.map((o) => [String(o._id), o]));

  console.log("\nOrders with dispatches — link a proforma to one of these:\n");
  console.log("  ORDER                     CUSTOMER                        CHALLANS  CARTONS  UNITS");
  for (const r of rows) {
    const o = byId.get(String(r._id));
    console.log(
      `  ${String(o?.requestId || "(order missing)").padEnd(25)} ` +
      `${String(o?.customerName || "—").slice(0, 30).padEnd(31)} ` +
      `${String(r.challans).padStart(8)} ${String(r.cartons || 0).padStart(8)} ${String(r.units || 0).padStart(6)}`,
    );
  }
  console.log("\nOpen a PI → Dispatched against this PI → Link an order → type the ORDER number.\n");
}

(async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data with NODE_ENV=production.");
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  try {
    if (has("--undo")) {
      await undo();
    } else if (has("--orders")) {
      await listOrders();
    } else {
      const made = await seed();
      const ok = await verify(made);
      if (!ok) process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("\nSeed failed:", e.message);
  process.exit(1);
});
