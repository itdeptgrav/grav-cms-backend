#!/usr/bin/env node
// scripts/migrations/pause-mrf-budget.js
//
// TURN MRF BUDGET / FINANCE REVIEW OFF — OR BACK ON.
//
// ── WHAT THIS CHANGES ───────────────────────────────────────────────────────
// One boolean on one document: `mrfBudgetEnabled` on the singleton
// `RequestsSettings` record (`key: "requests"`, collection `requestssettings`).
// That is the whole change. No code is disabled, nothing is deleted, and no
// existing request is touched.
//
// ── WHAT THE BOOLEAN DOES ───────────────────────────────────────────────────
// It is read per request, with no cache, in exactly two places
// (`routes/CMS_Routes/Inventory/Operations/mrfRoutes.js`), so a flip takes
// effect on the next request. When it is false and an MRF decision needs a
// purchase:
//   · the budget-head precondition is skipped;
//   · the spun-off SpendRequest is created at `approved` instead of
//     `pending_finance`;
//   · it is stamped `budgetApprovalMode: "BUDGET_PAUSED"`, which is what lets
//     `governedPurchaseOrder.service.js` waive the commitment check for it.
// Everything else — manager/TL approval, the Store's issue/buy decision,
// supplier, rate, tax, quantities, tenancy, provenance — is unchanged.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It does not touch requests that already exist. `budgetApprovalMode` is
// stamped at creation from the setting as it stood THEN, so flipping this
// cannot rewrite what an earlier request was approved under, and a request
// sitting at `pending_finance` stays there waiting on Finance. This script
// reports how many of those there are and changes none of them.
//
// ── RESTORING ───────────────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/pause-mrf-budget.js --restore --apply
// That sets `mrfBudgetEnabled` back to true and nothing else. No deleted code
// has to be recovered, because none was deleted.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node scripts/migrations/pause-mrf-budget.js                    # dry run, pause
//   node scripts/migrations/pause-mrf-budget.js --apply            # pause
//   node scripts/migrations/pause-mrf-budget.js --restore          # dry run, restore
//   node scripts/migrations/pause-mrf-budget.js --restore --apply  # restore
//   node scripts/migrations/pause-mrf-budget.js --note "…"         # override the note

"use strict";

require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const RESTORE = process.argv.includes("--restore");

const noteFlag = process.argv.indexOf("--note");
const NOTE = noteFlag !== -1 && process.argv[noteFlag + 1]
  ? String(process.argv[noteFlag + 1])
  : (RESTORE
    ? "Restored MRF budget and Finance review."
    : "Temporarily paused MRF budget and Finance review by product decision. Restore by setting mrfBudgetEnabled to true.");

/* Who the audit trail should name.
   The HTTP route (`PUT /api/cms/requests/settings`) takes the actor from a
   CEO/admin JWT. A script has no such session, and minting one would put a
   person's name on a change they did not make — so `updatedByRef` stays null
   and `updatedByName` says plainly what did it. The note carries the reason. */
const ACTOR_NAME = process.env.MRF_BUDGET_ACTOR || "Operations script (pause-mrf-budget.js)";

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Refusing to guess a connection.");
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const RequestsSettings = require("../../models/CMS_Models/Configurations/RequestsSettings");
  const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

  const want = RESTORE ? true : false;
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${RESTORE ? "restore" : "pause"} MRF budget & Finance review`);
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Host:     ${mongoose.connection.host}`);

  /* ── READ WITHOUT CREATING ────────────────────────────────────────────────
     `RequestsSettings.get()` CREATES the singleton when it is absent, so a
     dry run that used it would write to the database it claims only to read.
     `findOne` cannot. */
  const before = await RequestsSettings.findOne({ key: "requests" }).lean();

  if (!before) {
    console.log("\nCurrent: no RequestsSettings record exists.");
    console.log("         Absent reads as ENABLED — every consumer tests `mrfBudgetEnabled !== false`.");
  } else {
    console.log("\nCurrent:");
    console.log(`  mrfBudgetEnabled : ${before.mrfBudgetEnabled}`);
    console.log(`  updatedByName    : ${before.updatedByName || "(none)"}`);
    console.log(`  updatedByRef     : ${before.updatedByRef || "(none)"}`);
    console.log(`  note             : ${before.note || "(none)"}`);
    console.log(`  updatedAt        : ${before.updatedAt || "(none)"}`);
  }

  /* ── WHAT IS LEFT WAITING ON FINANCE ──────────────────────────────────────
     Reported, never touched. A request at `pending_finance` was raised under
     COMMITMENT_REQUIRED and is still owed Finance's decision; moving it would
     be retroactively approving spend nobody approved. */
  const pendingFinance = await SpendRequest.countDocuments({ status: "pending_finance" });
  const pendingFinanceFromMrf = await SpendRequest.countDocuments({
    status: "pending_finance", sourceMrfId: { $ne: null },
  });
  console.log("\nExisting requests at pending_finance (NOT touched by this script):");
  console.log(`  total          : ${pendingFinance}`);
  console.log(`  MRF-originated : ${pendingFinanceFromMrf}`);

  const currently = before ? before.mrfBudgetEnabled !== false : true;
  if (currently === want) {
    console.log(`\nAlready ${want ? "enabled" : "paused"}. Nothing to change.`);
    return;
  }

  console.log(`\nWould set mrfBudgetEnabled: ${currently} → ${want}`);
  console.log(`Would set note: ${NOTE}`);
  console.log(`Would set updatedByName: ${ACTOR_NAME}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  /* The model's own `get()` static is the only abstraction this collection has
     — there is no service layer — so the write goes through it and through
     `save()`, which keeps `{ timestamps: true }` maintaining `updatedAt`. */
  const doc = await RequestsSettings.get();
  doc.mrfBudgetEnabled = want;
  doc.note = NOTE;
  doc.updatedByName = ACTOR_NAME;
  /* Deliberately NOT set to a person: no employee performed this. Left as it
     stands rather than blanked, so an earlier human attribution survives. */
  await doc.save();

  const after = await RequestsSettings.findOne({ key: "requests" }).lean();
  console.log("\nWritten. Read back from the database:");
  console.log(`  mrfBudgetEnabled : ${after.mrfBudgetEnabled}`);
  console.log(`  note             : ${after.note}`);
  console.log(`  updatedByName    : ${after.updatedByName}`);
  console.log(`  updatedAt        : ${after.updatedAt}`);

  if (after.mrfBudgetEnabled !== want) {
    throw new Error(`Read-back disagrees: expected ${want}, got ${after.mrfBudgetEnabled}`);
  }
  console.log(`\nVerified: mrfBudgetEnabled is ${after.mrfBudgetEnabled}.`);
}

main()
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch { /* already closed */ }
  });
