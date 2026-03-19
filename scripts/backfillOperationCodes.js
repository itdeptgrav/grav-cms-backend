// scripts/backfillOperationCodes.js
//
// Run once to backfill operationCode on all existing WorkOrder operations
// that are missing it.
//
// Also cleans up old machine-assignment fields that no longer exist in the
// updated schema (assignedMachine, assignedMachineName, assignedMachineSerial,
// estimatedTimeSeconds, maxAllowedSeconds, machineType) so documents align
// with the new operationAssignmentSchema.
//
// Usage:
//   node scripts/backfillOperationCodes.js
//
// Safe to run multiple times — skips operations that already have operationCode.

require("dotenv").config();
const mongoose = require("mongoose");

const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const Operation = require("../models/CMS_Models/Inventory/Configurations/Operation");

async function run() {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing"
  );
  console.log("✅ MongoDB connected");

  // ── 1. Load entire Operation registry into a lookup map ──────────────────
  // Key: lowercased name → { operationCode }
  const allOps = await Operation.find({}).select("name operationCode").lean();

  const opCodeByName = new Map();
  for (const op of allOps) {
    const key = (op.name || "").trim().toLowerCase();
    if (key) opCodeByName.set(key, op.operationCode || "");
  }

  console.log(`📋 Loaded ${opCodeByName.size} operations from registry`);

  // ── 2. Find all WOs that have at least one operation missing operationCode ─
  const workOrders = await WorkOrder.find({
    "operations.0": { $exists: true }, // has at least one operation
  }).select("workOrderNumber operations").lean();

  console.log(`📦 Found ${workOrders.length} work orders with operations`);

  let totalWOsUpdated  = 0;
  let totalOpsPatched  = 0;
  let totalOpsSkipped  = 0;
  let totalOpsNoMatch  = 0;

  for (const wo of workOrders) {
    let needsUpdate = false;
    const patchedOps = [];

    for (const op of wo.operations) {
      const alreadyHasCode = op.operationCode && op.operationCode.trim() !== "";

      if (alreadyHasCode) {
        totalOpsSkipped++;
        patchedOps.push(null); // no patch needed
        continue;
      }

      // Try to match by operationType name
      const lookupKey = (op.operationType || "").trim().toLowerCase();
      const matchedCode = lookupKey ? opCodeByName.get(lookupKey) : undefined;

      if (matchedCode !== undefined) {
        patchedOps.push({ _id: op._id, operationCode: matchedCode });
        needsUpdate = true;
        totalOpsPatched++;
      } else {
        // No match found in registry — leave operationCode as ""
        patchedOps.push({ _id: op._id, operationCode: "" });
        needsUpdate = true; // still update to ensure field exists
        totalOpsNoMatch++;
        console.warn(
          `  ⚠️  WO ${wo.workOrderNumber}: no registry match for operationType "${op.operationType}"`
        );
      }
    }

    if (!needsUpdate) continue;

    // Build an arrayFilters update — one $set per op that needs patching
    // Use MongoDB's positional filtered update to update individual subdocs by _id
    try {
      const bulkOps = [];

      for (let i = 0; i < patchedOps.length; i++) {
        const patch = patchedOps[i];
        if (!patch) continue; // already had code, skip

        bulkOps.push({
          updateOne: {
            filter: { _id: wo._id, "operations._id": patch._id },
            update: {
              $set: {
                "operations.$.operationCode": patch.operationCode,
              },
              // Also unset old machine-assignment fields that no longer exist
              // in the schema — $unset on non-existent fields is a no-op.
              $unset: {
                "operations.$.assignedMachine":      "",
                "operations.$.assignedMachineName":  "",
                "operations.$.assignedMachineSerial":"",
                "operations.$.estimatedTimeSeconds": "",
                "operations.$.maxAllowedSeconds":    "",
                "operations.$.machineType":          "",
                "operations.$.additionalMachines":   "",
              },
            },
          },
        });
      }

      if (bulkOps.length > 0) {
        await WorkOrder.bulkWrite(bulkOps, { ordered: false });
        totalWOsUpdated++;
        console.log(
          `  ✅ WO ${wo.workOrderNumber}: patched ${bulkOps.length} operation(s)`
        );
      }
    } catch (err) {
      console.error(`  ❌ WO ${wo.workOrderNumber}: update failed — ${err.message}`);
    }
  }

  // ── 3. Summary ─────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────");
  console.log("✅ Backfill complete");
  console.log(`   Work orders updated : ${totalWOsUpdated}`);
  console.log(`   Operations patched  : ${totalOpsPatched}`);
  console.log(`   Operations skipped  : ${totalOpsSkipped} (already had code)`);
  console.log(`   Operations no-match : ${totalOpsNoMatch} (set to "")`);
  console.log("─────────────────────────────────────────\n");

  await mongoose.disconnect();
  console.log("👋 Done");
}

run().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});

