// scripts/migrations/maintenance-order-statuses.js
//
// Rewrites Maintenance jobs stored under the first version's statuses to the
// simplified ones (owner, 3 Oct 2026):
//
//   Draft · Created · In maintenance   → Open
//   Work in progress                   → In progress
//   Repair completed · Solved          → Done
//   Completed                          → Closed
//   (Open, In progress, Done, Closed, Cancelled stay as they are)
//
// Each converted job gets a "status-renamed" event, so its timeline says what
// happened and when; nothing else on the job changes (the model's step guard
// allows exactly `$set status` and `$push events`). Every reader already turns
// an old word into its new one, so running this is tidy-up, not a fix.
//
//   node -r dotenv/config scripts/migrations/maintenance-order-statuses.js           # dry run
//   node -r dotenv/config scripts/migrations/maintenance-order-statuses.js --apply   # write
"use strict";

const mongoose = require("mongoose");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const flow = require("../../services/maintenance/maintenanceOrderFlow");

const APPLY = process.argv.includes("--apply");
const NOTE = "Statuses simplified to Open, In progress, Done, Closed and Cancelled (3 Oct 2026).";

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const host = (() => { try { return new URL(process.env.MONGODB_URI).host; } catch { return "?"; } })();
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · database ${db.databaseName} on ${host}`);

  if (!(await db.listCollections({ name: MaintenanceOrder.COLLECTION }, { nameOnly: true }).toArray()).length) {
    console.log("No maintenance_orders collection here — nothing to convert.");
    await mongoose.disconnect();
    return;
  }

  const legacy = Object.keys(flow.LEGACY_STATUS);
  const jobs = await MaintenanceOrder.find({ status: { $in: legacy } }).select("orderNumber status").sort({ orderNumber: 1 }).lean();
  if (!jobs.length) console.log("Every job already uses the new statuses.");
  let changed = 0;
  for (const j of jobs) {
    const to = flow.normalizeStatus(j.status);
    console.log(`  ${j.orderNumber}: ${flow.STATUS_LABEL[to] ? `${j.status} → ${to}` : j.status}`);
    if (!APPLY) continue;
    const r = await MaintenanceOrder.updateOne(
      { _id: j._id, status: j.status },
      { $set: { status: to }, $push: { events: { at: new Date(), by: { id: null, name: "Status simplification", email: "" }, action: "status-renamed", from: j.status, to, note: NOTE } } },
    );
    changed += r.modifiedCount;
  }
  const byStatus = await MaintenanceOrder.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  console.log(`${APPLY ? `converted ${changed} of ${jobs.length}` : `${jobs.length} would be converted`} · now: ${byStatus.map((b) => `${b._id} ${b.n}`).join(", ")}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
