/**
 * SEED EMPLOYEES WITH MEASUREMENTS, SO THE CUTTING MASTER HAS SOMETHING TO CUT
 * ============================================================================
 * The cutting master's CAD screen lists one employee per row and grades the
 * pattern to that person. It reads them from the Measurement document attached
 * to the work order's customer request, and it needs a measurement per person
 * or there is nothing to grade to.
 *
 * On the Guwahati order every employee's product measurements were empty, so
 * the screen had rows and no numbers. This fills a testable population in.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Not invented. Each person gets a chest, and every other measurement is read
 * off THE DESIGNER'S OWN SIZE CHART for this product - the `baseMeasurements`
 * saved on each uploaded size pattern - interpolated at that chest. So the
 * relationship between chest, length, shoulder, sleeve and cuff is the one the
 * designer drew, not a ratio this script made up.
 *
 * Chests are drawn across the whole uploaded range and quantised to an eighth
 * of an inch, so most people land BETWEEN two uploaded sizes. That is the case
 * worth testing: it is the one a recorded keyframe could never answer.
 *
 * EVERYTHING IT CREATES IS TAGGED AND REMOVABLE
 * ---------------------------------------------
 * Seeded people carry `seedTag` and a `SEED-` UIN prefix, and `--remove` takes
 * every one of them back out. Employees that were already in the order are
 * never touched: real people's measurements are not this script's business.
 *
 *   node scripts/seedCuttingMasterEmployees.js --count 200
 *   node scripts/seedCuttingMasterEmployees.js --count 200 --fresh
 *   node scripts/seedCuttingMasterEmployees.js --remove
 *   node scripts/seedCuttingMasterEmployees.js --count 50 --wo <workOrderId>
 */

require("dotenv").config();
const mongoose = require("mongoose");

const SEED_TAG = "cutting-master-test-population";
const DEFAULT_WORK_ORDER = "6a51cfe50dfbd953a9ecb43f"; // Executive to Managers Shirt

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = { count: 200, remove: false, fresh: false, wo: DEFAULT_WORK_ORDER, seed: 20260917 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--remove") args.remove = true;
    else if (a === "--fresh") args.fresh = true;
    else if (a === "--count") args.count = parseInt(argv[++i], 10);
    else if (a === "--wo") args.wo = argv[++i];
    else if (a === "--seed") args.seed = parseInt(argv[++i], 10);
  }
  return args;
}

/**
 * A repeatable pseudo-random stream.
 *
 * Seeded on purpose: re-running gives the same people with the same numbers, so
 * a bug found on "SEED-0143" is still on SEED-0143 tomorrow.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Roughly normal, from two uniforms. Real bodies cluster; they do not spread flat. */
function gaussian(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/* ------------------------------------------------------------------ *
 * The designer's own size chart, read off the uploaded patterns
 * ------------------------------------------------------------------ */

/**
 * Build a chart keyed by chest, from every size pattern's baseMeasurements.
 *
 * Returns the measurement field names in the stock item's own spelling, because
 * that spelling is what the grading routes look the values up by.
 */
function readSizeChart(patternConfig, fieldNames) {
  const rows = [];
  for (const sp of patternConfig.sizePatterns || []) {
    const bm = sp.baseMeasurements || {};
    const chest = Number(
      bm.chest ?? bm.Chest ?? sp.sizeValue,
    );
    if (!Number.isFinite(chest)) continue;
    const values = {};
    for (const field of fieldNames) {
      const v = bm[field] ?? bm[field.toLowerCase()]
        ?? bm[field.charAt(0).toUpperCase() + field.slice(1).toLowerCase()];
      const n = Number(v);
      if (Number.isFinite(n)) values[field] = n;
    }
    rows.push({ sizeName: sp.sizeName, chest, values });
  }
  rows.sort((a, b) => a.chest - b.chest);
  return rows;
}

/**
 * Every measurement at a chest that is not on the chart.
 *
 * Linear between the two neighbouring sizes, held at the ends. Holding rather
 * than extrapolating is the same choice the grading engine makes: past the
 * largest size the designer drew, there is nothing to know.
 */
function chartAt(rows, chest, fieldNames) {
  if (!rows.length) return {};
  const out = {};
  for (const field of fieldNames) {
    const usable = rows.filter((r) => Number.isFinite(r.values[field]));
    if (!usable.length) continue;
    if (chest <= usable[0].chest) { out[field] = usable[0].values[field]; continue; }
    const last = usable[usable.length - 1];
    if (chest >= last.chest) { out[field] = last.values[field]; continue; }
    for (let i = 0; i + 1 < usable.length; i += 1) {
      const a = usable[i];
      const b = usable[i + 1];
      if (chest >= a.chest && chest <= b.chest) {
        const t = b.chest === a.chest ? 0 : (chest - a.chest) / (b.chest - a.chest);
        out[field] = a.values[field] + t * (b.values[field] - a.values[field]);
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * BODY SHAPES
 *
 * A population where everybody is exactly their size chart tests nothing: every
 * measurement moves together, so a grade that only ever scaled uniformly would
 * still look right. Real people are not proportional, and the fault worth
 * catching is the one where a big stomach on an ordinary chest puts a spike in
 * the side seam.
 *
 * Each shape shifts the groups INDEPENDENTLY, in inches off the charted value
 * for that person's chest. They are ordinary bodies, not extremes.
 * ------------------------------------------------------------------ */
const BODY_SHAPES = [
  { name: "Proportional", weight: 22, shift: {} },
  { name: "Athletic", weight: 12, shift: { Stomach: -2.5, Shoulder: +0.6, Chest: +0.5 } },
  { name: "Full figure", weight: 14, shift: { Stomach: +3.5, "Bottom hem": +2.0 } },
  { name: "Broad shoulders", weight: 10, shift: { Shoulder: +1.2, "Sleeve Length": +0.5 } },
  { name: "Narrow shoulders", weight: 8, shift: { Shoulder: -1.0 } },
  { name: "Long torso", weight: 10, shift: { Length: +2.0, "Sleeve Length": +0.75 } },
  { name: "Short torso", weight: 8, shift: { Length: -1.75, "Sleeve Length": -0.5 } },
  { name: "Straight build", weight: 8, shift: { Stomach: +1.5, "Bottom hem": +1.0, Shoulder: -0.4 } },
  { name: "Tapered", weight: 8, shift: { Stomach: -1.5, "Bottom hem": -2.0 } },
  { name: "Thick neck", weight: 6, shift: { Coller: +1.5, Cuff: +0.5 } },
  { name: "Slim wrists", weight: 6, shift: { Cuff: -0.75, Coller: -0.5 } },
  { name: "Long arms", weight: 8, shift: { "Sleeve Length": +1.5 } },
  { name: "Short arms", weight: 6, shift: { "Sleeve Length": -1.25 } },
];

function pickShape(rand) {
  const total = BODY_SHAPES.reduce((t, s) => t + s.weight, 0);
  let r = rand() * total;
  for (const s of BODY_SHAPES) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return BODY_SHAPES[0];
}

const FIRST = [
  "Rahul", "Amit", "Suresh", "Vikram", "Deepak", "Manoj", "Sanjay", "Arun",
  "Prakash", "Rajesh", "Nitin", "Ganesh", "Ravi", "Ashok", "Pankaj", "Kiran",
  "Bikash", "Dipankar", "Hiren", "Jayanta", "Pranab", "Nabin", "Tarun", "Dhiraj",
  "Anita", "Sunita", "Priya", "Kavita", "Meera", "Rekha", "Jyoti", "Nandini",
  "Bhaskar", "Utpal", "Rupam", "Samir", "Debojit", "Ankur", "Partha", "Subir",
];
const LAST = [
  "Sharma", "Das", "Bora", "Kalita", "Saikia", "Gogoi", "Barman", "Nath",
  "Deka", "Hazarika", "Choudhury", "Baruah", "Medhi", "Rajkhowa", "Phukan",
  "Sen", "Roy", "Ghosh", "Dutta", "Mahanta", "Talukdar", "Pathak",
];
const DEPARTMENTS = [
  "Front Office", "Housekeeping", "Food & Beverage", "Kitchen", "Laundry",
  "Security", "Maintenance", "Banquets", "Spa", "Administration",
];
const DESIGNATIONS = ["Executive", "Senior Executive", "AM", "Manager", "Supervisor", "Associate"];

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  const args = parseArgs(process.argv);
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const workOrder = await db.collection("workorders")
    .findOne({ _id: new mongoose.Types.ObjectId(args.wo) });
  if (!workOrder) throw new Error(`No work order ${args.wo}`);

  const measurementDoc = await db.collection("measurements")
    .findOne({ poRequestId: workOrder.customerRequestId });
  if (!measurementDoc) {
    throw new Error(
      `No Measurement document for this work order's customer request `
      + `(${workOrder.customerRequestId}). The cutting master reads its employee `
      + `list from there, so there is nowhere to put them.`,
    );
  }

  console.log(`Work order  : ${workOrder.workOrderNumber || args.wo}`);
  console.log(`Product     : ${workOrder.stockItemName}`);
  console.log(`Order       : ${measurementDoc.name} — ${measurementDoc.organizationName}`);

  /* ---- removal ---- */
  const existingSeeded = (measurementDoc.employeeMeasurements || [])
    .filter((e) => String(e.employeeUIN || "").startsWith("SEED-"));

  if (args.remove || args.fresh) {
    const seededIds = (await db.collection("employeempcs")
      .find({ seedTag: SEED_TAG }, { projection: { _id: 1 } }).toArray()).map((e) => e._id);
    const delProgress = await db.collection("employeeproductionprogresses")
      .deleteMany({ employeeId: { $in: seededIds } });
    const del = await db.collection("employeempcs").deleteMany({ seedTag: SEED_TAG });
    const kept = (measurementDoc.employeeMeasurements || [])
      .filter((e) => !String(e.employeeUIN || "").startsWith("SEED-"));
    const keptIds = kept.map((e) => e.employeeId);
    await db.collection("measurements").updateOne(
      { _id: measurementDoc._id },
      {
        $set: {
          employeeMeasurements: kept,
          registeredEmployeeIds: keptIds,
          totalRegisteredEmployees: kept.length,
        },
      },
    );
    console.log(
      `Removed     : ${del.deletedCount} seeded employee records, `
      + `${existingSeeded.length} rows off the order, `
      + `${delProgress.deletedCount} production-progress records`,
    );
    if (args.remove) {
      await mongoose.disconnect();
      return;
    }
    measurementDoc.employeeMeasurements = kept;
    measurementDoc.registeredEmployeeIds = keptIds;
  }

  /* ---- the chart to draw from ---- */
  const stockItem = await db.collection("stockitems")
    .findOne({ _id: workOrder.stockItemId });
  const fieldNames = (stockItem?.measurements || []).filter(Boolean);
  if (!fieldNames.length) {
    throw new Error(
      `Stock item "${workOrder.stockItemName}" declares no measurement fields, so `
      + `there is nothing to fill in.`,
    );
  }

  const patternConfig = await db.collection("patterngradingconfigs")
    .findOne({ stockItemId: workOrder.stockItemId, isActive: true }, { sort: { updatedAt: -1 } });
  const chart = patternConfig ? readSizeChart(patternConfig, fieldNames) : [];
  if (!chart.length) {
    throw new Error(
      `No uploaded size pattern for this product carries baseMeasurements, so there `
      + `is no size chart to draw realistic people from.`,
    );
  }

  console.log(`Fields      : ${fieldNames.join(", ")}`);
  console.log(
    `Size chart  : ${chart.map((r) => `${r.sizeName}=${r.chest}"`).join("  ")}`,
  );

  const minChest = chart[0].chest;
  const maxChest = chart[chart.length - 1].chest;
  const midChest = (minChest + maxChest) / 2;

  /* ---- build the population ---- */
  const rand = rng(args.seed);
  const existingUins = new Set(
    (await db.collection("employeempcs").find({}, { projection: { uin: 1 } }).toArray())
      .map((e) => e.uin),
  );

  const mpcDocs = [];
  const rows = [];
  const now = new Date();
  const productId = workOrder.stockItemId;
  const variantId = (workOrder.variantAttributes && workOrder.variantAttributes.variantId) || null;

  /*
   * EVERY SIZE GETS A REAL POPULATION.
   *
   * Drawing chests from a bell curve buried the ends - the last run put 3 people
   * on 3XL and 7 on 3XS, which is not enough of either to trust. The run is
   * dealt round the size bands instead, so every uploaded size gets tested, and
   * within a band the chest is spread across the gap to the next size so most
   * people still fall between two uploaded patterns.
   */
  const plan = [];
  for (let i = 0; i < args.count; i += 1) {
    const band = chart[i % chart.length];
    const next = chart[Math.min(chart.length - 1, (i % chart.length) + 1)];
    const gap = Math.max(1, next.chest - band.chest);
    /* One in eight sits exactly on the uploaded size; the rest sit above it. */
    const onSize = (i % 8) === 0 && i % chart.length !== chart.length - 1;
    plan.push({ band, gap, onSize });
  }
  /* Shuffle, so the list is not nine tidy blocks in size order. */
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }

  const shapeTally = new Map();

  for (let i = 0; i < args.count; i += 1) {
    const { band, gap, onSize } = plan[i];
    let chest = onSize
      ? band.chest
      : band.chest + rand() * gap * 0.92;
    /* Half the run sits on a whole inch, half on a half — as a tape is read. */
    /*
     * HALF INCHES. THAT IS HOW A TAPE IS ACTUALLY READ.
     *
     * A tailor calls a chest 41 or 41 1/2 — never 41 3/8. Seeding eighths made
     * a population no measuring room would ever produce, which is a bad test:
     * the interesting case is not an impossible fraction, it is an ordinary
     * half inch that still falls between two uploaded sizes.
     */
    chest = Math.round(chest * 2) / 2;

    const shape = pickShape(rand);
    shapeTally.set(shape.name, (shapeTally.get(shape.name) || 0) + 1);

    const base = chartAt(chart, chest, fieldNames);
    const values = {};
    for (const field of fieldNames) {
      if (!Number.isFinite(base[field])) continue;
      /*
       * The shape moves this measurement off the chart, and a small wobble on
       * top keeps two people of the same size and shape from being identical.
       */
      const shift = shape.shift[field] || 0;
      const wobble = gaussian(rand) * Math.max(0.3, base[field] * 0.018);
      let v = base[field] + shift + wobble;
      if (field.toLowerCase() === "chest") v = chest + (shape.shift.Chest || 0);
      /* Read off a tape: half inches, never eighths. */
      values[field] = Math.round(v * 2) / 2;
    }

    let uin = `SEED-${String(i + 1).padStart(4, "0")}`;
    while (existingUins.has(uin)) uin = `SEED-${String(i + 1).padStart(4, "0")}-${Math.floor(rand() * 900 + 100)}`;
    existingUins.add(uin);

    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const lastName = LAST[Math.floor(rand() * LAST.length)];
    const name = `${first} ${lastName}`;
    const gender = ["Anita", "Sunita", "Priya", "Kavita", "Meera", "Rekha", "Jyoti", "Nandini"]
      .includes(first) ? "Female" : "Male";
    const quantity = 1 + Math.floor(rand() * 3);
    const employeeId = new mongoose.Types.ObjectId();

    mpcDocs.push({
      _id: employeeId,
      customerId: measurementDoc.organizationId,
      name,
      uin,
      gender,
      department: DEPARTMENTS[Math.floor(rand() * DEPARTMENTS.length)],
      designation: DESIGNATIONS[Math.floor(rand() * DESIGNATIONS.length)],
      seedShape: shape.name,
      products: [{ productId, variantId, quantity, productName: workOrder.stockItemName }],
      status: "active",
      seedTag: SEED_TAG,
      createdBy: measurementDoc.createdBy,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });

    rows.push({
      employeeId,
      employeeName: name,
      employeeUIN: uin,
      gender,
      products: [{
        productId,
        productName: workOrder.stockItemName,
        variantId,
        variantName: "Default",
        quantity,
        measurements: fieldNames
          .filter((f) => Number.isFinite(values[f]))
          .map((f) => ({ measurementName: f, value: String(values[f]), unit: "inches" })),
        measuredAt: now,
        qrGenerated: false,
        qrGeneratedAt: null,
        templateId: null,
        templateName: "",
      }],
      noProductAssigned: false,
      categoryMeasurements: [],
      isCompleted: true,
      completedAt: now,
      remarks: `Seeded test population — ${shape.name}`,
    });
  }

  await db.collection("employeempcs").insertMany(mpcDocs);

  /* ---------------------------------------------------------------- *
   * THE RECORD THAT MAKES SOMEBODY VISIBLE
   *
   * The cutting master's screen does not list the order's employees. It lists
   * the work order's PRODUCTION PROGRESS records and looks each person's
   * measurements up from there:
   *
   *     const progress = progressByEmployee.get(empIdStr);
   *     if (!progress) continue;
   *
   * So measurements alone put nobody on the screen. Without this block the
   * first run of this script added 220 people the cutting master could not see
   * - the screen showed the single employee who already had one.
   *
   * Units are handed out in consecutive ranges the way the real allocation does
   * it, and the work order's quantity is raised to match, because a work order
   * for 3 units cannot have 100 people cutting against it.
   * ---------------------------------------------------------------- */
  const existingProgress = await db.collection("employeeproductionprogresses")
    .find({ workOrderId: workOrder._id }).project({ unitEnd: 1 }).toArray();
  let nextUnit = existingProgress.reduce((t, d) => Math.max(t, d.unitEnd || 0), 0) + 1;

  const progressDocs = rows.map((r) => {
    const units = r.products[0].quantity || 1;
    const unitStart = nextUnit;
    const unitEnd = nextUnit + units - 1;
    nextUnit = unitEnd + 1;
    return {
      workOrderId: workOrder._id,
      manufacturingOrderId: workOrder.customerRequestId,
      measurementId: measurementDoc._id,
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      employeeUIN: r.employeeUIN,
      gender: r.gender,
      unitStart,
      unitEnd,
      totalUnits: units,
      completedUnits: 0,
      completedUnitNumbers: [],
      completionPercentage: 0,
      packagedUnits: 0,
      isFullyPackaged: false,
      lastPackagedAt: null,
      packagingHistory: [],
      isDispatched: false,
      dispatchNotes: null,
      dispatchHistory: [],
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    };
  });
  await db.collection("employeeproductionprogresses").insertMany(progressDocs);

  const totalUnits = nextUnit - 1;
  await db.collection("workorders").updateOne(
    { _id: workOrder._id },
    { $set: { quantity: totalUnits, updatedAt: now } },
  );


  const allRows = [...(measurementDoc.employeeMeasurements || []), ...rows];
  const measured = allRows.filter((e) => (e.products || [])
    .some((p) => (p.measurements || []).length)).length;

  await db.collection("measurements").updateOne(
    { _id: measurementDoc._id },
    {
      $set: {
        employeeMeasurements: allRows,
        registeredEmployeeIds: allRows.map((e) => e.employeeId),
        totalRegisteredEmployees: allRows.length,
        measuredEmployees: measured,
        pendingEmployees: allRows.length - measured,
        completionRate: allRows.length ? Math.round((measured / allRows.length) * 100) : 0,
        totalMeasurements: allRows.length,
        completedMeasurements: measured,
        pendingMeasurements: allRows.length - measured,
        updatedAt: now,
      },
    },
  );

  /* ---- what the cutting master will now see ---- */
  const buckets = new Map();
  for (const r of rows) {
    const chest = Number(
      r.products[0].measurements.find((m) => m.measurementName.toLowerCase() === "chest")?.value,
    );
    let picked = chart[0];
    for (const row of chart) if (row.chest <= chest) picked = row;
    const exact = chart.some((row) => Math.abs(row.chest - chest) < 0.001);
    const key = `${picked.sizeName}${exact ? "" : " +grade"}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  console.log(`\nAdded       : ${rows.length} employees (${measured} of ${allRows.length} now measured)`);
  console.log(
    `Visible     : ${progressDocs.length} production-progress records written; `
    + `work order quantity is now ${totalUnits} units`,
  );
  console.log("\nBody shapes, so the measurement groups move independently:");
  for (const [k, v] of [...shapeTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}`);
  }
  console.log("Which uploaded size each one rounds down to, and whether it has to be graded:");
  for (const [k, v] of [...buckets.entries()].sort()) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}`);
  }
  const needsGrade = rows.length - (buckets.get(
    [...buckets.keys()].find((k) => !k.includes("+grade")) || "",
  ) || 0);
  console.log(
    `\n${needsGrade} of ${rows.length} fall between uploaded sizes and can only be `
    + `served by grading.`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
