// seed_cad_test_orders.js
//
// Seeds a full, self-contained "MF order" (measurement / made-to-fit order)
// for one product, all the way from employee registration through sales
// approval, so the cutting master's pattern-grading CAD viewer has real
// per-employee measurement records to test against — with a RELIABLE number
// of employees in every size bucket, not a lucky/unlucky roll of the dice.
//
// WHY DIRECT-MONGO INSTEAD OF HITTING THE RUNNING SERVER:
// This repeats the CLAUDE.md convention for this repo (root-level seed*.js /
// backfill_*.js scripts that connect straight to MONGODB_URI). It also means
// this script does not need a sales-department password — it re-implements
// the exact same steps the real routes take (see routes/CMS_Routes/
// Measurement/measurementRoutes.js `convert-to-po`, routes/CMS_Routes/Sales/
// quotationRoutes.js `mark-internal-order` + `createWorkOrdersAndProgress`,
// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js
// `allocate-raw-materials`) so the resulting documents are indistinguishable
// from ones created by a sales person clicking through the real UI.
//
// SAFETY: this is a shared LIVE dev database with real client data (MAYFAIR
// hotels and ~2900 real employees already in it). Every document this script
// creates is scoped under ONE dedicated test Customer org (marked by email,
// see TEST_ORG_EMAIL below) and every EmployeeMpc UIN is prefixed "CADTEST-".
// Nothing outside that org is ever touched. Use --cleanup to remove it all.
//
// USAGE
//   node -r dotenv/config seed_cad_test_orders.js                  # 100 per size bucket (900 total)
//   node -r dotenv/config seed_cad_test_orders.js --per-size=50   # 50 per bucket (450 total)
//   node -r dotenv/config seed_cad_test_orders.js --dry-run       # compute + print, no writes
//   node -r dotenv/config seed_cad_test_orders.js --reset         # wipe test org's data first, then reseed
//   node -r dotenv/config seed_cad_test_orders.js --cleanup       # wipe test org's data and exit
//   node -r dotenv/config seed_cad_test_orders.js --product=PROD-SHI-EXETOMANSHI-8517

const mongoose = require("mongoose");

const StockItem = require("./models/CMS_Models/Inventory/Products/StockItem");
const Customer = require("./models/Customer_Models/Customer");
const EmployeeMpc = require("./models/Customer_Models/Employee_Mpc");
const Measurement = require("./models/Customer_Models/Measurement");
const CustomerRequest = require("./models/Customer_Models/CustomerRequest");
const WorkOrder = require("./models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("./models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const PatternGradingConfig = require("./models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
const SalesDepartment = require("./models/SalesDepartment");

// ─── CLI args ──────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

const DRY_RUN = !!args["dry-run"];
const DO_CLEANUP = !!args.cleanup;
const DO_RESET = !!args.reset;
const PRODUCT_REF = args.product || "PROD-SHI-EXETOMANSHI-8517";
const PER_SIZE = args["per-size"] ? parseInt(args["per-size"], 10) : 100;

const TEST_ORG_EMAIL = `cadtest.${PRODUCT_REF.toLowerCase().replace(/[^a-z0-9]/g, "")}@internal.gravtest.com`;
const UIN_PREFIX = "CADTEST-";

// ─── name pools (for realistic-looking fake employees) ───────────────────────
const MALE_FIRST_NAMES = [
  "Amit","Rohit","Suresh","Rajesh","Vikram","Anil","Sanjay","Manoj","Deepak","Ravi",
  "Ajay","Vijay","Arun","Ashok","Naveen","Pramod","Sandeep","Rakesh","Gopal","Prakash",
  "Sunil","Vinod","Alok","Bikash","Debashish","Subrat","Bijay","Nirmal","Santosh","Kishore",
  "Abhishek","Saurav","Manas","Chinmay","Pratap","Biswajit","Tapan","Sushant","Kailash","Girish",
];
const FEMALE_FIRST_NAMES = [
  "Priya","Anita","Sunita","Kavita","Neha","Pooja","Swati","Rekha","Meena","Sarita",
  "Anjali","Divya","Shweta","Nisha","Ritu","Manisha","Suman","Vandana","Geeta","Lata",
  "Sushmita","Ipsita","Rashmi","Sabita","Namrata","Pallavi","Jyotsna","Alka","Deepika","Kiran",
  "Snehalata","Madhusmita","Aparajita","Sujata","Barsha","Preeti","Sonal","Archana","Bharati","Usha",
];
const SURNAMES = [
  "Sharma","Verma","Patel","Nayak","Mohanty","Das","Sahoo","Pradhan","Behera","Rout",
  "Panda","Mishra","Tripathy","Sethi","Choudhury","Reddy","Naidu","Iyer","Menon","Pillai",
  "Gupta","Singh","Kumar","Yadav","Chauhan","Rana","Thapa","Rai","Gurung","Tamang",
];
const DEPARTMENTS = ["Corporate Office", "Operations", "Guest Relations", "Finance", "Administration", "Facilities"];
const DESIGNATIONS = ["Executive", "Senior Executive", "Assistant Manager", "Manager", "Team Lead"];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function uniform(lo, hi) { return lo + Math.random() * (hi - lo); }

// ─── measurement-field helpers ────────────────────────────────────────────
const FIELD_KEYS = ["length", "chest", "stomach", "bottomHem", "shoulder", "sleeveLength", "cuff", "coller"];
const FIELD_TO_BASE_KEY = {
  length: "length", chest: "chest", stomach: "stomach", bottomHem: "bottom hem",
  shoulder: "shoulder", sleeveLength: "sleeve length", cuff: "cuff", coller: "coller",
};
// Per-field independent jitter (inches) layered on top of the interpolated
// base curve, so two employees in the same size bucket still differ part by
// part — this is what exercises per-employee grading (not just size lookup).
const FIELD_JITTER = { length: 1.2, stomach: 1.6, bottomHem: 1.6, shoulder: 1.0, sleeveLength: 1.2, cuff: 0.6, coller: 0.9 };

function normalize(s) { return String(s || "").trim().toLowerCase(); }

// Plain number string, no padded trailing zeros ("23.7" not "23.70", "24" not "24.00").
function fmtNum(n) { return Number(n.toFixed(2)).toString(); }

function buildMeasurementLabelMap(stockItemMeasurements) {
  const map = {};
  for (const key of FIELD_KEYS) {
    const wantLabel = { length: "length", chest: "chest", stomach: "stomach", bottomHem: "bottom hem", shoulder: "shoulder", sleeveLength: "sleeve length", cuff: "cuff", coller: "coller" }[key];
    const match = (stockItemMeasurements || []).find((m) => normalize(m) === wantLabel || normalize(m).replace(/^collar$/, "coller") === wantLabel);
    map[key] = match || wantLabel.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return map;
}

const STANDARD_SIZE_ORDER = ["3XS", "2XS", "XS", "S", "M", "L", "XL", "2XL", "3XL"];

function buildLadder(patternGradingConfig) {
  const ladder = (patternGradingConfig?.sizePatterns || [])
    .filter((sp) => sp.baseMeasurements && typeof sp.baseMeasurements.chest === "number")
    .map((sp) => {
      const bm = sp.baseMeasurements;
      const row = { sizeName: sp.sizeName, chest: bm.chest };
      for (const key of FIELD_KEYS) row[key] = bm[FIELD_TO_BASE_KEY[key]];
      return row;
    })
    .sort((a, b) => a.chest - b.chest);

  // Reconstruct any standard size missing real baseMeasurements (uploaded but
  // never configured, or lost) by interpolating from its two neighbors in the
  // sequence — NOT a fix for the real config, just enough to keep this size
  // testable. If a size is missing at one end (no neighbor on one side), it's
  // left out rather than extrapolated blindly.
  const bySizeName = new Map(ladder.map((r) => [r.sizeName, r]));
  const missing = STANDARD_SIZE_ORDER.filter((name) => !bySizeName.has(name));
  for (const name of missing) {
    const idx = STANDARD_SIZE_ORDER.indexOf(name);
    const prevName = STANDARD_SIZE_ORDER[idx - 1];
    const nextName = STANDARD_SIZE_ORDER[idx + 1];
    const prev = bySizeName.get(prevName);
    const next = bySizeName.get(nextName);
    if (!prev || !next) continue; // can't safely interpolate at an end
    const row = { sizeName: name, chest: (prev.chest + next.chest) / 2 };
    for (const key of FIELD_KEYS) row[key] = (prev[key] + next[key]) / 2;
    ladder.push(row);
    console.warn(`Size "${name}" has no real baseMeasurements in the DB — reconstructed by interpolating between ${prevName} and ${nextName} (chest=${row.chest}") for test-seeding purposes only. The real config still needs fixing in the designer.`);
  }
  ladder.sort((a, b) => a.chest - b.chest);
  return ladder;
}

// Fallback ladder (generic Indian ready-made shirt chart) used only if this
// product has no PatternGradingConfig yet — keeps the script usable even
// before a designer has finished grading, though patterns won't render.
const FALLBACK_LADDER = [
  { sizeName: "3XS", chest: 32, length: 23.5, stomach: 30, bottomHem: 32, shoulder: 12.5, sleeveLength: 20, cuff: 7, coller: 11.5 },
  { sizeName: "2XS", chest: 34, length: 24.5, stomach: 32, bottomHem: 34, shoulder: 14, sleeveLength: 21, cuff: 7.5, coller: 12 },
  { sizeName: "XS", chest: 36, length: 25.5, stomach: 34, bottomHem: 36, shoulder: 14.5, sleeveLength: 22, cuff: 8, coller: 13 },
  { sizeName: "S", chest: 38, length: 26.5, stomach: 36, bottomHem: 38, shoulder: 15.5, sleeveLength: 23, cuff: 8.5, coller: 14 },
  { sizeName: "M", chest: 40, length: 27.5, stomach: 38, bottomHem: 40, shoulder: 16.5, sleeveLength: 24, cuff: 9, coller: 15 },
  { sizeName: "L", chest: 42, length: 28, stomach: 40, bottomHem: 42, shoulder: 17.5, sleeveLength: 24.5, cuff: 9.5, coller: 15.5 },
  { sizeName: "XL", chest: 44, length: 28.5, stomach: 42, bottomHem: 44, shoulder: 18, sleeveLength: 25, cuff: 10, coller: 16 },
  { sizeName: "2XL", chest: 46, length: 29, stomach: 44, bottomHem: 46, shoulder: 18.5, sleeveLength: 25.5, cuff: 10.5, coller: 16.5 },
  { sizeName: "3XL", chest: 48, length: 30, stomach: 46, bottomHem: 48, shoulder: 19.5, sleeveLength: 26, cuff: 11, coller: 17 },
];

function interp(ladder, chest, field) {
  if (chest <= ladder[0].chest) {
    const [p0, p1] = [ladder[0], ladder[1]];
    const slope = (p1[field] - p0[field]) / (p1.chest - p0.chest);
    return p0[field] + slope * (chest - p0.chest);
  }
  if (chest >= ladder[ladder.length - 1].chest) {
    const p0 = ladder[ladder.length - 2], p1 = ladder[ladder.length - 1];
    const slope = (p1[field] - p0[field]) / (p1.chest - p0.chest);
    return p1[field] + slope * (chest - p1.chest);
  }
  for (let i = 0; i < ladder.length - 1; i++) {
    const p0 = ladder[i], p1 = ladder[i + 1];
    if (chest >= p0.chest && chest <= p1.chest) {
      const t = (chest - p0.chest) / (p1.chest - p0.chest);
      return p0[field] + t * (p1[field] - p0[field]);
    }
  }
  return ladder[Math.floor(ladder.length / 2)][field];
}

// Picks a chest value that is GUARANTEED to resolve back to `bucket` under the
// real cutting-master round-down rule ("largest size at or below this chest").
// Earlier version applied the gender nudge AFTER sampling within the bucket's
// range, uncapped — for someone sampled near the top of their bucket, a male
// nudge of up to +1.6" could push them past the bucket's ceiling and into the
// NEXT bucket entirely. That's why a supposedly-even round-robin distribution
// came out lopsided in practice (e.g. S overflowing with pushed-up M's while M
// itself ended up nearly empty). The nudge is now clamped back into [lo, hi]
// after being applied, so the resolved size always matches the bucket this
// employee was actually generated for.
function sampleChestForBucket(ladder, bucket, gender) {
  const idx = ladder.findIndex((b) => b.sizeName === bucket.sizeName);
  const nextBucket = ladder[idx + 1] || null;
  let lo = bucket.chest;
  let hi = nextBucket ? nextBucket.chest - 0.25 : bucket.chest + 3; // top bucket: allow extrapolation above range
  if (idx === 0 && Math.random() < 0.05) {
    lo = bucket.chest - 3;
    hi = bucket.chest - 0.25; // occasional below-range outlier, still resolves to the bottom bucket
  }
  let chest = uniform(lo, hi);
  const genderOffset = gender === "Male" ? uniform(0.3, 1.6) : uniform(-1.2, 0.4);
  chest = Math.min(hi, Math.max(lo, chest + genderOffset));
  return Math.round(chest * 4) / 4; // quarter-inch resolution, like a tailor's tape
}

function generateMeasurements(ladder, chest) {
  const out = {};
  for (const key of FIELD_KEYS) {
    if (key === "chest") { out.chest = chest; continue; }
    const base = interp(ladder, chest, key);
    const jittered = base + uniform(-FIELD_JITTER[key], FIELD_JITTER[key]);
    out[key] = Math.round(jittered * 4) / 4;
  }
  return out;
}

function pickVariant(stockItem, chestValue) {
  const target = Math.round(chestValue);
  let best = null, bestDist = Infinity;
  for (const v of stockItem.variants || []) {
    const sizeAttr = (v.attributes || []).find((a) => a.name === "Size");
    if (!sizeAttr) continue;
    const num = parseFloat(sizeAttr.value);
    if (Number.isNaN(num)) continue;
    const dist = Math.abs(num - target);
    if (dist < bestDist) { bestDist = dist; best = v; }
  }
  return best || (stockItem.variants || [])[0] || null;
}

function resolvedSizeName(ladder, chest) {
  // Mirrors the CAD route's own "round down to the largest size at or below
  // this chest value" logic, purely for the summary printout / verification.
  let match = ladder[0];
  for (const row of ladder) if (chest >= row.chest) match = row;
  return match.sizeName;
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to DB: ${mongoose.connection.name}`);

  const testOrg = await Customer.findOne({ email: TEST_ORG_EMAIL });

  if (DO_CLEANUP || DO_RESET) {
    await cleanup(testOrg);
    if (DO_CLEANUP) { await mongoose.disconnect(); return; }
  }

  const stockItem = await StockItem.findOne({ reference: PRODUCT_REF });
  if (!stockItem) throw new Error(`StockItem not found for reference "${PRODUCT_REF}"`);
  console.log(`Product: ${stockItem.name} (${stockItem.reference}), category=${stockItem.category}, variants=${stockItem.variants.length}`);

  const patternGradingConfig = await PatternGradingConfig.findOne({ stockItemId: stockItem._id });
  const ladder = patternGradingConfig ? buildLadder(patternGradingConfig) : FALLBACK_LADDER;
  if (!patternGradingConfig) console.warn("WARNING: no PatternGradingConfig found for this product — using a generic fallback size chart. The cutting master CAD viewer will not have a real pattern to show.");
  else console.log(`PatternGradingConfig: designatedGroup=${patternGradingConfig.designatedGroup}, sizePatterns=${ladder.map((r) => `${r.sizeName}(${r.chest}")`).join(", ")}`);

  const labelMap = buildMeasurementLabelMap(stockItem.measurements);

  const salesUser = await SalesDepartment.findOne({});
  if (!salesUser) throw new Error("No SalesDepartment user found in DB — can't attribute createdBy/approvedBy.");
  console.log(`Acting as sales user: ${salesUser.name} <${salesUser.email}>`);
  console.log(`Target: ${PER_SIZE} employees per size bucket x ${ladder.length} sizes = ${PER_SIZE * ladder.length} total.`);

  // ── org (find-or-create) ──────────────────────────────────────────────
  let org = testOrg;
  if (!org) {
    if (DRY_RUN) {
      console.log(`[dry-run] would create test Customer org "${TEST_ORG_EMAIL}"`);
      org = { _id: new mongoose.Types.ObjectId(), name: "CAD TEST ORG — DO NOT USE FOR REAL ORDERS" };
    } else {
      org = await Customer.create({
        name: "CAD TEST ORG — DO NOT USE FOR REAL ORDERS",
        email: TEST_ORG_EMAIL,
        phone: "0000000000",
        password: `cadtest-${Date.now()}`,
        isActive: true,
        isEmailVerified: true,
        createdBySales: true,
        salesAssignedBy: salesUser._id,
        salesAssignedByName: salesUser.name,
      });
      console.log(`Created test org: ${org._id}`);
    }
  } else {
    console.log(`Reusing existing test org: ${org._id}`);
  }

  // ── generate employees + per-employee measurements ─────────────────────
  // One explicit pass per size bucket, PER_SIZE employees each (half male,
  // half female) — guarantees every bucket actually gets its target count,
  // rather than hoping a flat round-robin index lands evenly.
  const batchTag = Date.now().toString(36);
  const jobs = [];
  for (const bucket of ladder) {
    for (let i = 0; i < PER_SIZE; i++) {
      jobs.push({ gender: i % 2 === 0 ? "Male" : "Female", bucket });
    }
  }

  const employeesToCreate = [];
  const employeeMeasurementEntries = [];
  const sizeHistogram = {};

  jobs.forEach((job, i) => {
    const firstNames = job.gender === "Male" ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES;
    const name = `${pick(firstNames)} ${pick(SURNAMES)}`;
    const genderTag = job.gender === "Male" ? "M" : "F";
    const seq = String(i + 1).padStart(4, "0");
    const uin = `${UIN_PREFIX}${genderTag}-${batchTag}-${seq}`;

    const chest = sampleChestForBucket(ladder, job.bucket, job.gender);
    const m = generateMeasurements(ladder, chest);
    const variant = pickVariant(stockItem, chest);
    const size = resolvedSizeName(ladder, chest);
    sizeHistogram[size] = (sizeHistogram[size] || 0) + 1;

    const employeeId = new mongoose.Types.ObjectId();
    employeesToCreate.push({
      _id: employeeId,
      customerId: org._id,
      name,
      uin,
      gender: job.gender,
      department: pick(DEPARTMENTS),
      designation: pick(DESIGNATIONS),
      products: [{ productId: stockItem._id, variantId: variant?._id || null, quantity: 1, productName: stockItem.name }],
      status: "active",
      createdBy: org._id,
    });

    const measurements = FIELD_KEYS.map((key) => ({
      measurementName: labelMap[key],
      value: fmtNum(m[key]),
      unit: "inches",
    }));

    employeeMeasurementEntries.push({
      employeeId,
      employeeName: name,
      employeeUIN: uin,
      gender: job.gender,
      noProductAssigned: false,
      isCompleted: true,
      completedAt: new Date(),
      products: [{
        productId: stockItem._id,
        productName: stockItem.name,
        variantId: variant?._id || null,
        variantName: variant ? (variant.attributes || []).map((a) => a.value).join(" • ") || "Default" : "Default",
        quantity: 1,
        measuredAt: new Date(),
        measurements,
      }],
      categoryMeasurements: [],
    });
  });

  console.log(`\nGenerated ${employeesToCreate.length} employees.`);
  console.log("Resolved size-bucket coverage (should match target exactly):", JSON.stringify(sizeHistogram, null, 2));
  const offTarget = Object.entries(sizeHistogram).filter(([, n]) => n !== PER_SIZE);
  if (offTarget.length) console.warn("Buckets NOT matching target count:", JSON.stringify(offTarget));
  else console.log(`All ${ladder.length} buckets hit the target of ${PER_SIZE} exactly.`);

  if (DRY_RUN) {
    console.log("\n[dry-run] stopping before any writes.");
    await mongoose.disconnect();
    return;
  }

  await EmployeeMpc.insertMany(employeesToCreate, { ordered: false });
  console.log(`Inserted ${employeesToCreate.length} EmployeeMpc records under org ${org._id}.`);

  // ── Measurement doc ─────────────────────────────────────────────────────
  const measuredCount = employeeMeasurementEntries.filter((e) => e.isCompleted).length;
  const totalMeasurementFields = employeeMeasurementEntries.reduce((s, e) => s + e.products[0].measurements.length, 0);
  const measurementDoc = await Measurement.create({
    organizationId: org._id,
    organizationName: org.name,
    name: `CAD Test — ${stockItem.name} — batch ${batchTag}`,
    description: `Auto-generated test data for cutting-master pattern-grading QA. ${employeesToCreate.length} synthetic employees, ${PER_SIZE} per size bucket.`,
    registeredEmployeeIds: employeesToCreate.map((e) => e._id),
    employeeMeasurements: employeeMeasurementEntries,
    totalRegisteredEmployees: employeesToCreate.length,
    measuredEmployees: measuredCount,
    pendingEmployees: employeesToCreate.length - measuredCount,
    completionRate: 100,
    totalMeasurements: totalMeasurementFields,
    completedMeasurements: totalMeasurementFields,
    pendingMeasurements: 0,
    createdBy: salesUser._id,
  });
  console.log(`Created Measurement doc: ${measurementDoc._id}`);

  // ── convert-to-po (mirrors measurementRoutes.js convert-to-po) ─────────
  const productMap = new Map();
  for (const emp of employeeMeasurementEntries) {
    const p = emp.products[0];
    const key = `${p.productId}_${p.variantId || "default"}`;
    if (!productMap.has(key)) {
      productMap.set(key, {
        stockItemId: p.productId,
        stockItemName: p.productName,
        stockItemReference: stockItem.reference,
        variantId: p.variantId,
        variantAttributes: (stockItem.variants.find((v) => v._id.equals(p.variantId))?.attributes || []).map((a) => ({ name: a.name, value: a.value })),
        unitPrice: stockItem.baseSalesPrice || 0,
        totalQuantity: 0,
        employeeCount: 0,
      });
    }
    const pd = productMap.get(key);
    pd.totalQuantity += p.quantity;
    pd.employeeCount += 1;
  }
  const products = Array.from(productMap.values());

  const requestCount = await CustomerRequest.countDocuments();
  const requestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, "0")}`;

  const validatedItems = products.map((p) => ({
    stockItemId: p.stockItemId,
    stockItemName: p.stockItemName,
    stockItemReference: p.stockItemReference,
    variants: [{
      variantId: p.variantId?.toString() || `VAR-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      attributes: p.variantAttributes,
      quantity: p.totalQuantity,
      specialInstructions: [],
      estimatedPrice: p.totalQuantity * p.unitPrice,
    }],
    totalQuantity: p.totalQuantity,
    totalEstimatedPrice: p.totalQuantity * p.unitPrice,
  }));

  const newRequest = new CustomerRequest({
    requestId,
    customerId: org._id,
    customerInfo: {
      name: org.name,
      email: org.email || "",
      phone: org.phone || "",
      address: "", city: "", postalCode: "",
      description: `PO from measurement: ${measurementDoc.name}`,
      deliveryDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      preferredContactMethod: "phone",
    },
    items: validatedItems,
    status: "pending",
    priority: "high",
    measurementId: measurementDoc._id,
    measurementName: measurementDoc.name,
    requestType: "measurement_conversion",
  });
  await newRequest.save();
  console.log(`Created CustomerRequest ${newRequest.requestId} (${newRequest._id}) with ${validatedItems[0].variants.length} variant line(s) across ${products.length} distinct size(s).`);

  await Measurement.findByIdAndUpdate(measurementDoc._id, {
    convertedToPO: true,
    poRequestId: newRequest._id,
    poConversionDate: new Date(),
    convertedBy: salesUser._id,
  });

  // ── mark-internal-order (mirrors quotationRoutes.js) ────────────────────
  newRequest.isInternalOrder = true;
  newRequest.internalOrderMarkedAt = new Date();
  newRequest.quotations = [{
    date: new Date(),
    validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    items: [], subtotalBeforeGST: 0, totalDiscount: 0, totalGST: 0, shippingCharges: 0, grandTotal: 0,
    status: "sales_approved",
    notes: "Internal / Company Order — CAD pattern-grading QA test data.",
    customerApproval: { approved: true, approvedAt: new Date() },
    salesApproval: { approved: true, approvedAt: new Date(), approvedBy: salesUser._id },
  }];
  newRequest.status = "quotation_sales_approved";
  newRequest.finalOrderPrice = 0;
  newRequest.salesPersonAssigned = salesUser._id;

  // ── createWorkOrdersAndProgress (mirrors quotationRoutes.js) ────────────
  // Group everyone into just TWO work orders (all-female, all-male) — the
  // per-employee pattern still resolves individually off each employee's own
  // measurements regardless of which WO they're grouped under (see
  // patternGradingRoutes.js cad-data), so grouping by exact resolved size
  // just produces dozens of near-empty work orders that are annoying to click
  // through for no benefit.
  const maleChests = employeeMeasurementEntries.filter((e) => e.gender === "Male").map((e) => parseFloat(e.products[0].measurements.find((m) => m.measurementName === labelMap.chest).value));
  const femaleChests = employeeMeasurementEntries.filter((e) => e.gender === "Female").map((e) => parseFloat(e.products[0].measurements.find((m) => m.measurementName === labelMap.chest).value));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const genderVariant = {
    Male: maleChests.length ? pickVariant(stockItem, avg(maleChests)) : null,
    Female: femaleChests.length ? pickVariant(stockItem, avg(femaleChests)) : null,
  };
  console.log(`Grouping variant — Male: size ${genderVariant.Male?.attributes?.[0]?.value}, Female: size ${genderVariant.Female?.attributes?.[0]?.value}`);

  // Re-key items by gender-group variant instead of the per-employee variant
  // picked during measurement (which still drives per-size BOM realism there).
  const genderGroupedItems = new Map();
  for (const emp of employeeMeasurementEntries) {
    const gv = genderVariant[emp.gender];
    if (!gv) continue;
    const key = gv._id.toString();
    if (!genderGroupedItems.has(key)) {
      genderGroupedItems.set(key, {
        stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference,
        variantId: gv._id.toString(),
        variantAttributes: (gv.attributes || []).map((a) => ({ name: a.name, value: a.value })),
        quantity: 0, gender: emp.gender,
      });
    }
    genderGroupedItems.get(key).quantity += 1;
  }

  const createdWorkOrders = [];
  for (const item of genderGroupedItems.values()) {
    const variantData = stockItem.variants.find((v) => v._id.toString() === item.variantId) || stockItem.variants[0];

    const operations = stockItem.operations.map((op) => ({
      operationType: op.type || op.name || op.operationType,
      operationCode: op.operationCode || op.code || "",
      plannedTimeSeconds: op.totalSeconds || op.durationSeconds || 0,
      status: "pending",
    }));

    const rawMaterials = (variantData.rawItems || []).map((rawItem) => ({
      rawItemId: rawItem.rawItemId, name: rawItem.rawItemName, sku: rawItem.rawItemSku,
      rawItemVariantId: rawItem.variantId || null,
      rawItemVariantCombination: rawItem.variantCombination || [],
      requiredQuantity: (rawItem.requiredQuantity ?? rawItem.quantity ?? 0) * item.quantity,
      allowancePercent: rawItem.allowancePercent || 0,
      quantityRequired: rawItem.quantity * item.quantity,
      quantityAllocated: 0, quantityIssued: 0,
      unit: rawItem.unit, unitCost: rawItem.unitCost,
      totalCost: (rawItem.totalCost || 0) * item.quantity,
      allocationStatus: "not_allocated",
    }));

    // workOrderNumber has no schema default/pre-save hook in this codebase —
    // it's normally lazily backfilled as `WO-<last8ofid>` the first time a
    // production-completion sync event touches the WO (see
    // services/productionSyncService.js updateWorkOrder). Assign it eagerly
    // here in the same format so barcodes/labels are sane immediately.
    const workOrderId = new mongoose.Types.ObjectId();
    const workOrder = new WorkOrder({
      _id: workOrderId,
      workOrderNumber: `WO-${workOrderId.toString().slice(-8)}`,
      customerRequestId: newRequest._id, stockItemId: stockItem._id,
      stockItemName: stockItem.name, stockItemReference: stockItem.reference,
      variantId: variantData._id.toString(), variantAttributes: item.variantAttributes,
      quantity: item.quantity, originalQuantity: item.quantity,
      customerId: newRequest.customerId, customerName: newRequest.customerInfo.name,
      priority: newRequest.priority, status: "pending", operations, rawMaterials,
      estimatedCost: rawMaterials.reduce((t, rm) => t + (rm.totalCost || 0), 0),
      actualCost: 0, createdBy: salesUser._id,
    });
    await workOrder.save();
    createdWorkOrders.push(workOrder);

    const employeeEntries = employeeMeasurementEntries
      .filter((emp) => emp.gender === item.gender)
      .map((emp) => ({ employeeId: emp.employeeId, employeeName: emp.employeeName, employeeUIN: emp.employeeUIN, gender: emp.gender, quantity: 1 }));

    let unitCursor = 1;
    for (const emp of employeeEntries) {
      const unitStart = unitCursor;
      const unitEnd = unitCursor + emp.quantity - 1;
      const assignedBarcodeIds = [];
      for (let u = unitStart; u <= unitEnd; u++) assignedBarcodeIds.push(`${workOrder.workOrderNumber}-${u.toString().padStart(3, "0")}`);
      await EmployeeProductionProgress.findOneAndUpdate(
        { workOrderId: workOrder._id, employeeId: emp.employeeId },
        { $set: {
          measurementId: measurementDoc._id, manufacturingOrderId: newRequest._id,
          orderType: "measurement_conversion", employeeName: emp.employeeName, employeeUIN: emp.employeeUIN,
          gender: emp.gender, unitStart, unitEnd, totalUnits: emp.quantity,
          assignedBarcodeIds, completedUnits: 0, completedUnitNumbers: [],
          completionPercentage: 0, lastSyncedAt: new Date(),
        } },
        { upsert: true, new: true }
      );
      unitCursor = unitEnd + 1;
    }
  }

  newRequest.notes = newRequest.notes || [];
  newRequest.notes.push({
    text: `Marked as Internal Order (no PI required). ${createdWorkOrders.length} work order(s) created directly for production. [seeded by seed_cad_test_orders.js]`,
    addedBy: salesUser._id, addedByModel: "SalesDepartment", createdAt: new Date(),
  });
  await newRequest.save();
  console.log(`Created ${createdWorkOrders.length} WorkOrder(s), request status -> quotation_sales_approved.`);

  // ── allocate-raw-materials (simplified: mark fully allocated, mirrors the
  // route's own status-flip logic. Does NOT touch RawItem stock quantities —
  // neither does the real route — so real inventory numbers are untouched.) ──
  for (const wo of createdWorkOrders) {
    for (const rm of wo.rawMaterials) {
      rm.quantityAllocated = rm.quantityRequired;
      rm.allocationStatus = "fully_allocated";
    }
    wo.status = "planned";
    await wo.save();
  }
  console.log(`Allocated raw materials on all ${createdWorkOrders.length} WorkOrder(s) — status -> planned (visible to cutting master now).`);

  // ── summary ──────────────────────────────────────────────────────────────
  console.log("\n========================================================");
  console.log("DONE");
  console.log("========================================================");
  console.log(`Test org:          ${org.name} (${org._id})`);
  console.log(`Manufacturing Order: ${newRequest.requestId} (${newRequest._id})`);
  console.log(`Employees:         ${employeesToCreate.length} (UIN prefix "${UIN_PREFIX}...", batch ${batchTag})`);
  console.log(`Per size bucket:   ${PER_SIZE}`);
  console.log(`Work orders:       ${createdWorkOrders.length}`);
  for (const wo of createdWorkOrders) {
    const sizeLabel = (wo.variantAttributes.find((a) => a.name === "Size") || {}).value;
    console.log(`  - ${wo.workOrderNumber}  size=${sizeLabel}  qty=${wo.quantity}`);
  }
  console.log("\nTo view: log in as cutting master -> Assigned Work -> find this MO ->");
  console.log(`open any work order -> CAD tab -> Employee Switcher -> pick anyone with UIN starting "${UIN_PREFIX}".`);
  console.log(`\nTo remove all of this later: node -r dotenv/config seed_cad_test_orders.js --cleanup`);

  await mongoose.disconnect();
}

async function cleanup(testOrg) {
  if (!testOrg) {
    console.log(`No test org found for ${TEST_ORG_EMAIL} — nothing to clean up.`);
    return;
  }
  console.log(`Cleaning up test org ${testOrg._id} (${TEST_ORG_EMAIL})...`);
  const requests = await CustomerRequest.find({ customerId: testOrg._id }).select("_id").lean();
  const requestIds = requests.map((r) => r._id);

  const progressResult = await EmployeeProductionProgress.deleteMany({ manufacturingOrderId: { $in: requestIds } });
  const woResult = await WorkOrder.deleteMany({ customerRequestId: { $in: requestIds } });
  const reqResult = await CustomerRequest.deleteMany({ customerId: testOrg._id });
  const measResult = await Measurement.deleteMany({ organizationId: testOrg._id });
  const empResult = await EmployeeMpc.deleteMany({ customerId: testOrg._id });
  const orgResult = await Customer.deleteOne({ _id: testOrg._id });

  console.log(`Deleted: ${progressResult.deletedCount} progress docs, ${woResult.deletedCount} work orders, ${reqResult.deletedCount} requests, ${measResult.deletedCount} measurement docs, ${empResult.deletedCount} employees, ${orgResult.deletedCount} org.`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
