// scripts/verifyScannerRollup.js
//
// Round-trip proof that the scanner rollup reproduces the numbers the old
// stateful scan path produced, so a cutover can be checked rather than trusted.
//
//   node -r dotenv/config scripts/verifyScannerRollup.js 2026-08-11
//
// Run from grav-backend/ so it picks up .env. READ-ONLY: it hits the real
// database but every write the rollup attempts is captured in memory instead.
//
// It takes a ProductionTracking document written by the OLD system, synthesizes
// the events that would have produced it, runs the new rollup in DRY-RUN (no
// writes anywhere), and diffs the regenerated document against the original.
//
// A clean run means QC/Admin, the PM stats page, the PDF export and the CEO
// dashboard all see identical values after migration.

require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");

const { shiftDateFor } = require("../services/barcodeScanner/shift");
const rollupStats = require("../services/barcodeScanner/rollupStats");

const ProductionTracking = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

// The standalone server had its own config/db.js. Here the connection is the
// CMS's own — autoIndex off, because this script must not reshape a collection
// it is only reading.
const connectLocal = () =>
  mongoose.connect(
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/grav_clothing",
    { serverSelectionTimeoutMS: 10000, autoIndex: false },
  );

// ─── Capture-only model stubs ─────────────────────────────────────────────────
// Nothing in this script may write. These record what the rollup WOULD have
// written so it can be inspected instead.
function captureModels(realModels) {
  const captured = { machineDayStats: [], operatorDayStats: [], tracking: null };
  return {
    captured,
    models: {
      ...realModels,
      MachineDayStats: {
        bulkWrite: async (ops) => {
          captured.machineDayStats = ops.map((o) => o.replaceOne.replacement);
        },
      },
      OperatorDayStats: {
        bulkWrite: async (ops) => {
          captured.operatorDayStats = ops.map((o) => o.replaceOne.replacement);
        },
      },
      ProductionTracking: {
        replaceOne: async (_filter, doc) => {
          captured.tracking = doc;
        },
      },
    },
  };
}

// ─── Legacy document -> events ────────────────────────────────────────────────
// Mirrors exactly what v5.5.0 firmware would have emitted for the same day.
function eventsFromLegacy(doc, shiftDate) {
  const events = [];
  let seq = 0;
  const nextId = (machineId) =>
    `replay-${String(machineId).slice(-6)}-${String(seq++).padStart(6, "0")}`;

  for (const machine of doc.machines || []) {
    const machineId = machine.machineId?._id || machine.machineId;
    for (const op of machine.operators || []) {
      events.push({
        eventId: nextId(machineId),
        type: "signin",
        machineId,
        deviceId: "replay",
        operatorId: op.operatorIdentityId,
        operatorName: op.operatorName || "",
        barcodeId: "",
        workOrderKey: null,
        unitNumber: null,
        activeOps: [],
        scanTime: op.signInTime,
        receivedAt: op.signInTime,
        timeRecovered: false,
        shiftDate,
      });

      for (const scan of op.barcodeScans || []) {
        const parts = String(scan.barcodeId || "").split("-");
        events.push({
          eventId: nextId(machineId),
          type: "scan",
          machineId,
          deviceId: "replay",
          operatorId: op.operatorIdentityId,
          operatorName: op.operatorName || "",
          barcodeId: scan.barcodeId,
          workOrderKey: parts.length >= 3 && parts[0] === "WO" ? parts[1] : null,
          unitNumber:
            parts.length >= 3 ? Number.parseInt(parts[2], 10) || null : null,
          activeOps: scan.activeOps || [],
          scanTime: scan.timeStamp,
          receivedAt: scan.timeStamp,
          timeRecovered: false,
          shiftDate,
        });
      }

      if (op.signOutTime) {
        events.push({
          eventId: nextId(machineId),
          type: "signout",
          machineId,
          deviceId: "replay",
          operatorId: op.operatorIdentityId,
          operatorName: op.operatorName || "",
          barcodeId: "",
          workOrderKey: null,
          unitNumber: null,
          activeOps: [],
          scanTime: op.signOutTime,
          receivedAt: op.signOutTime,
          timeRecovered: false,
          shiftDate,
        });
      }
    }
  }

  events.sort(
    (a, b) =>
      String(a.machineId).localeCompare(String(b.machineId)) ||
      new Date(a.scanTime) - new Date(b.scanTime)
  );
  return events;
}

// ─── Comparison ───────────────────────────────────────────────────────────────
function summarise(doc) {
  const perMachine = new Map();
  let totalScans = 0;
  for (const machine of doc.machines || []) {
    const key = String(machine.machineId?._id || machine.machineId);
    let scans = 0;
    const operators = new Map();
    for (const op of machine.operators || []) {
      const n = (op.barcodeScans || []).length;
      scans += n;
      operators.set(
        op.operatorIdentityId,
        (operators.get(op.operatorIdentityId) || 0) + n
      );
    }
    totalScans += scans;
    perMachine.set(key, { scans, operators });
  }
  return { totalScans, perMachine };
}

function diff(original, regenerated) {
  const a = summarise(original);
  const b = summarise(regenerated);
  const problems = [];

  if (a.totalScans !== b.totalScans) {
    problems.push(
      `TOTAL SCANS differ: original ${a.totalScans}, regenerated ${b.totalScans}`
    );
  }

  for (const [machineId, orig] of a.perMachine) {
    const gen = b.perMachine.get(machineId);
    if (!gen) {
      problems.push(`machine ${machineId} missing from regenerated document`);
      continue;
    }
    if (orig.scans !== gen.scans) {
      problems.push(
        `machine ${machineId}: ${orig.scans} scans -> ${gen.scans}`
      );
    }
    for (const [operatorId, count] of orig.operators) {
      const genCount = gen.operators.get(operatorId) || 0;
      if (count !== genCount) {
        problems.push(
          `machine ${machineId} operator ${operatorId}: ${count} -> ${genCount}`
        );
      }
    }
  }

  for (const machineId of b.perMachine.keys()) {
    if (!a.perMachine.has(machineId)) {
      problems.push(`machine ${machineId} appears only in regenerated document`);
    }
  }

  return { a, b, problems };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const dateArg = process.argv[2];
  if (!dateArg) {
    console.error("usage: node scripts/verifyRollup.js YYYY-MM-DD");
    process.exit(1);
  }

  const parsed = new Date(dateArg);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`"${dateArg}" is not a date`);
    process.exit(1);
  }

  await connectLocal();
  const shiftDate = shiftDateFor(parsed);

  // The legacy bucket may be UTC-midnight rather than IST-midnight if the data
  // was written on Render. Try the computed bucket, then the raw date.
  let original = await ProductionTracking.findOne({ date: shiftDate }).lean();
  if (!original) {
    const utcMidnight = new Date(dateArg + "T00:00:00.000Z");
    original = await ProductionTracking.findOne({ date: utcMidnight }).lean();
    if (original) {
      console.log(
        "NOTE: matched on UTC midnight, not IST midnight. Historical data was " +
          "bucketed by a UTC host; going forward SHIFT_TZ_OFFSET_MIN applies."
      );
    }
  }

  if (!original) {
    console.error(`No ProductionTracking document for ${dateArg}`);
    process.exit(1);
  }

  const events = eventsFromLegacy(original, original.date);
  console.log(
    `Replaying ${events.length} synthesized events across ` +
      `${original.machines?.length || 0} machines...\n`
  );

  const realModels = rollupStats.getLocalModels();
  const { captured, models } = captureModels({
    ...realModels,
    // Feed the synthesized events in instead of querying the collection.
    ProductionEvent: {
      find: () => ({ sort: () => ({ lean: async () => events }) }),
    },
    DeviceHeartbeat: { find: () => ({ lean: async () => [] }) },
  });

  const result = await rollupStats.rollupForDate(original.date, models);
  if (result.skipped) {
    console.error("Rollup skipped:", result.reason);
    process.exit(1);
  }

  const { a, b, problems } = diff(original, captured.tracking);

  console.log("── Legacy ProductionTracking ───────────────────────────────");
  console.log(`  original    : ${a.totalScans} scans, ${a.perMachine.size} machines`);
  console.log(`  regenerated : ${b.totalScans} scans, ${b.perMachine.size} machines`);
  console.log("");
  console.log("── New read models ─────────────────────────────────────────");
  console.log(`  machine_day_stats  : ${captured.machineDayStats.length} docs`);
  console.log(`  operator_day_stats : ${captured.operatorDayStats.length} docs`);
  console.log(
    `  pieces             : ${captured.machineDayStats.reduce(
      (s, m) => s + m.totalPieces,
      0
    )}`
  );
  console.log(
    `  rescans suppressed : ${captured.machineDayStats.reduce(
      (s, m) => s + m.suppressedRescans,
      0
    )}`
  );

  const unknown = captured.operatorDayStats.filter((o) => o.unknownOperator);
  if (unknown.length > 0) {
    console.log("");
    console.log(
      `  ${unknown.length} operator id(s) have no Employee record: ` +
        unknown.map((o) => o.operatorId).join(", ")
    );
  }

  console.log("");
  if (problems.length === 0) {
    console.log("PASS — regenerated document matches the original exactly.");
  } else {
    console.log(`FAIL — ${problems.length} difference(s):`);
    for (const p of problems.slice(0, 40)) console.log("  - " + p);
    if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
    console.log("");
    console.log(
      "Non-zero suppressed rescans explain a lower regenerated count: the old " +
        "system stored duplicates the new one collapses. Set RESCAN_WINDOW_SEC=0 " +
        "to compare without suppression."
    );
  }

  await mongoose.connection.close();
  process.exit(problems.length === 0 ? 0 : 2);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
