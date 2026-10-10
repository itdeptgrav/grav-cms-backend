#!/usr/bin/env node
// scripts/migrations/mrf-item-approval-backfill.js
//
// WRITE DOWN THE MANAGER'S DECISION ON EVERY LINE OF EVERY EXISTING REQUEST.
//
// Item-wise approval records a decision on each line (`items[].approval`) and
// rolls them up into `approvalStatus`. Requests decided before it was built
// carry neither — their manager decided the whole request at once, and what
// they decided is in the request-level fields (`tlApproved`, `tlRejected`, the
// TL_APPROVED event's "Approved with N item(s) rejected").
//
// Nothing is broken without this script: every reader derives the same answer
// through `lineApproval` (services/mrfItemApproval.service.js). This makes the
// data say it, so a query that reads `approvalStatus` directly — a report, a
// count — is not quietly wrong about old requests.
//
// ── WHAT IT WRITES, AND WHAT IT NEVER TOUCHES ───────────────────────────────
//   • `items[i].approval` ONLY on a line that has none, filled from the SAME
//     derivation the screens use — so the screens read the same before and
//     after. A line that already carries a decision is never rewritten.
//   • `approvalStatus` ONLY on a request that has none.
//   • Never `status`, `itemStatus`, quantities, history or anything the Store
//     reads. Additive, and safe to run twice (the second run finds nothing).
//
//   node -r dotenv/config scripts/migrations/mrf-item-approval-backfill.js
//   …--apply   write it
"use strict";

const mongoose = require("mongoose");
const itemApproval = require("../../services/mrfItemApproval.service");

/* From the model, not typed: mongoose pluralises "MRF" to "mrves", and a
   guessed "mrfs" reads an empty collection and reports nothing to do. */
const COLLECTION = require("../../models/CMS_Models/Inventory/Operations/MRF").collection.collectionName;

/** A request needs work when a line has no decision or it has no roll-up. */
const NEEDS_WORK = {
  $or: [
    { approvalStatus: { $exists: false } },
    { approvalStatus: null },
    { items: { $elemMatch: { "approval.decision": { $exists: false } } } },
  ],
};

/** The line record the screens already derive, as it will be stored. */
function recordFor(line, mrf) {
  const a = itemApproval.lineApproval(line, mrf);
  const by = a.decision === "REJECTED" && mrf.tlRejected ? mrf.tlRejectedBy
    : a.decision === "PENDING" || a.automatic ? null
      : mrf.tlApprovedBy || null;
  return {
    decision: a.decision,
    requestedQty: a.requestedQty,
    ...(a.decision === "PENDING" ? {} : { approvedQty: a.approvedQty, rejectedQty: a.rejectedQty }),
    reason: a.reason || "",
    decidedBy: by,
    decidedByName: a.decidedByName || "",
    decidedById: "",
    decidedAt: a.decidedAt || null,
  };
}

/** The writes for one request — nothing for a request already complete. */
function plan(mrf) {
  const set = {};
  const arrayFilters = [];
  (mrf.items || []).forEach((line, i) => {
    if (line.approval && line.approval.decision) return;
    const key = `l${i}`;
    set[`items.$[${key}].approval`] = recordFor(line, mrf);
    /* Bound to the line's id AND to its still having no decision, so a line
       decided between the read and the write is left alone. */
    arrayFilters.push({ [`${key}._id`]: line._id, [`${key}.approval.decision`]: { $exists: false } });
  });
  if (!mrf.approvalStatus) set.approvalStatus = itemApproval.approvalStatusOf(mrf);
  if (!Object.keys(set).length) return null;
  return {
    updateOne: {
      filter: { _id: mrf._id },
      update: { $set: set },
      ...(arrayFilters.length ? { arrayFilters } : {}),
    },
  };
}

async function run({ apply = false, batchSize = 200 } = {}) {
  const col = mongoose.connection.db.collection(COLLECTION);
  const counts = {
    total: await col.countDocuments({}),
    needing: 0, lines: 0, written: 0,
    byStatus: {}, byDecision: { PENDING: 0, APPROVED: 0, REJECTED: 0 },
  };

  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    if (apply) {
      const r = await col.bulkWrite(batch, { ordered: false });
      counts.written += r.modifiedCount || 0;
    }
    batch = [];
  };

  const cursor = col.find(NEEDS_WORK);
  for await (const mrf of cursor) {
    const op = plan(mrf);
    if (!op) continue;
    counts.needing += 1;
    const s = op.updateOne.update.$set;
    const status = s.approvalStatus || mrf.approvalStatus;
    counts.byStatus[status] = (counts.byStatus[status] || 0) + 1;
    for (const [k, v] of Object.entries(s)) {
      if (!k.endsWith(".approval")) continue;
      counts.lines += 1;
      counts.byDecision[v.decision] = (counts.byDecision[v.decision] || 0) + 1;
    }
    batch.push(op);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return { ok: true, applied: apply, ...counts, text: render(counts, apply) };
}

function render(c, applied) {
  const L = [""];
  L.push("MRF ITEM-WISE APPROVAL — BACKFILL");
  L.push(`  Mode              ${applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push(`  Requests          ${c.total}`);
  L.push(`  Needing a record  ${c.needing}`);
  for (const [k, v] of Object.entries(c.byStatus).sort()) L.push(`    ${k.padEnd(20)} ${v}`);
  L.push(`  Lines to record   ${c.lines}`);
  for (const [k, v] of Object.entries(c.byDecision)) L.push(`    ${k.padEnd(20)} ${v}`);
  L.push("");
  L.push(applied
    ? `  WROTE ${c.written} request(s). No status, quantity or history was changed.`
    : `  ${c.needing} request(s) to record. Re-run with --apply.`);
  L.push("");
  return L.join("\n");
}

async function main() {
  require("dotenv").config({ quiet: true });
  mongoose.set("autoIndex", false);
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database          ${mongoose.connection.name}`);
  try {
    const out = await run({ apply: process.argv.includes("--apply") });
    console.log(out.text);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, plan, recordFor, render, NEEDS_WORK };
