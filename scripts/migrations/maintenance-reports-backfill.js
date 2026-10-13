// scripts/migrations/maintenance-reports-backfill.js
//
// Every closed Maintenance job has exactly one Maintenance Report (owner,
// 4 Oct 2026). Jobs closed BEFORE reports existed were closed with the work
// report written at "Mark done" — diagnosis, work performed, parts, notes —
// but no report number. This gives each of them its MR- number and a report
// built from what was recorded then, and nothing more:
//
//   · maintenance type  — the job's own, else blank (never guessed)
//   · final status      — "unrecorded" ("Not recorded"), never assumed
//   · technician        — who completed the repair, else who it was assigned to
//   · submitted at / by — when and by whom the job was closed
//   · source            — "backfill", which every screen says in words
//
// Reports are numbered in the order the jobs were closed. A job that already
// has a report is never touched (the write is addressed to `finalReport`
// absent), so running this twice changes nothing the second time. The
// diagnosis, work performed and parts already on the job ARE its report's
// content — they are not copied or rewritten.
//
//   node -r dotenv/config scripts/migrations/maintenance-reports-backfill.js           # dry run
//   node -r dotenv/config scripts/migrations/maintenance-reports-backfill.js --apply   # write
"use strict";

const mongoose = require("mongoose");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const flow = require("../../services/maintenance/maintenanceOrderFlow");
const storage = require("../../services/maintenance/maintenanceStorage");

const APPLY = process.argv.includes("--apply");

const counterSchema = new mongoose.Schema(
  { key: { type: String, required: true, unique: true, index: true }, seq: { type: Number, default: 0 } },
  { timestamps: true, collection: "crm_sequences" },
);
const Counter = mongoose.models.CRMSequence || mongoose.model("CRMSequence", counterSchema);
const nextReportNumber = async () => flow.formatReportNumber((await Counter.findOneAndUpdate(
  { key: `maintenance:${flow.REPORT_PREFIX}` }, { $inc: { seq: 1 } }, { new: true, upsert: true },
).lean()).seq);

const actor = (a) => (a && (a.name || a.email) ? { id: a.id || null, name: a.name || a.email || "", email: a.email || "" } : null);

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const host = (() => { try { return new URL(process.env.MONGODB_URI).host; } catch { return "?"; } })();
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} · database ${db.databaseName} on ${host}`);
  if (!(await db.listCollections({ name: MaintenanceOrder.COLLECTION }, { nameOnly: true }).toArray()).length) {
    console.log("No maintenance_orders collection here — nothing to do.");
    await mongoose.disconnect();
    return;
  }
  /* The report indexes first, so two reports can never share a number. */
  if (APPLY) {
    const made = await storage.ensureOrderStorage();
    console.log(`indexes: ${JSON.stringify(made.createdIndexes || made)}`);
  }

  const jobs = await MaintenanceOrder.find({ status: { $in: flow.storedAs("CLOSED") }, "finalReport.reportNumber": { $exists: false } })
    .sort({ closedAt: 1, _id: 1 }).lean();
  if (!jobs.length) console.log("Every closed job already has its report.");
  let written = 0;
  for (const j of jobs) {
    const technician = actor(j.workDoneBy) || actor(j.assignedTo) || actor(j.closedBy) || actor(j.openedBy);
    const by = actor(j.closedBy) || technician;
    const at = j.closedAt || j.workDoneAt || j.updatedAt || new Date();
    const line = `${j.orderNumber} (closed ${new Date(at).toISOString().slice(0, 16)}) · ${j.subjectAtOpen?.name || ""} · work: ${(j.report?.workPerformed || "not recorded").slice(0, 60)}`;
    if (!APPLY) { console.log(`  would report ${line}`); continue; }
    const reportNumber = await nextReportNumber();
    const r = await MaintenanceOrder.updateOne(
      { _id: j._id, "finalReport.reportNumber": { $exists: false } },
      {
        $set: { finalReport: {
          reportNumber, maintenanceType: j.details?.maintenanceType || "", resolution: "", finalStatus: "unrecorded",
          recommendations: "", technician, submittedAt: at, submittedBy: by, source: "backfill",
        } },
        $push: { events: { at: new Date(), by: { id: null, name: "Maintenance reports", email: "" }, action: "report-backfilled", from: j.status, to: j.status,
          note: `${reportNumber} — built from the work report recorded when the repair was done (closed before reports existed).` } },
      },
    );
    written += r.modifiedCount;
    console.log(`  ${reportNumber} ← ${line}`);
  }
  const total = await MaintenanceOrder.countDocuments({ "finalReport.reportNumber": { $exists: true } });
  console.log(`${APPLY ? `wrote ${written} of ${jobs.length}` : `${jobs.length} would get a report`} · reports now: ${total}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error("FAILED:", e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
