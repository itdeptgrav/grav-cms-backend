#!/usr/bin/env node
// scripts/reporting/chart-cleanup.js
//
// Archive the hidden chart questions nobody is using any more.
//
// Every time somebody opens Chart view on a layout they are still building,
// GRAV makes a question for it. That is what makes the chart appear without a
// round trip through "save your report first" — and it is also rubbish the
// moment they change a field. This collects it.
//
//   npm run reporting:chart-cleanup             # says what it WOULD archive
//   npm run reporting:chart-cleanup -- --apply  # archives it
//   npm run reporting:chart-cleanup -- --hours 2 --apply
//
// ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
// A saved report's question. Not because it is old — because `kind: "saved"`
// is in the filter and `reportId: null` is in it too. A saved report's chart
// belongs to the report and goes when the report goes; nothing on a clock may
// take it away underneath somebody.
//
// Archived, never deleted: Metabase keeps an archived question in its trash,
// so a question that turns out to have mattered is recoverable by a person
// rather than gone because a job ran at 3am.

"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const { createChartBridge, DRAFT_TTL_MS } = require("../../services/reporting/metabaseCharts.service");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};

const apply = flag("apply");
const hours = Number(value("hours", DRAFT_TTL_MS / 3_600_000));
const limit = Number(value("limit", 200));

(async () => {
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error("--hours must be a positive number of hours.");
    process.exit(2);
  }

  console.log("Reporting charts — draft cleanup");
  console.log(`  mode:   ${apply ? "APPLY" : "DRY RUN (nothing is archived)"}`);
  console.log(`  older:  ${hours} hour(s) since last use`);
  console.log(`  limit:  ${limit} question(s) per run\n`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

  const bridge = createChartBridge({
    siteUrl: process.env.METABASE_SITE_URL,
    apiKey: process.env.METABASE_REPORTING_API_KEY,
    adminApiKey: process.env.METABASE_EMBED_ADMIN_API_KEY,
    embeddingSecret: process.env.METABASE_EMBEDDING_SECRET,
  });

  if (!bridge.isConfigured()) {
    console.error("Charts are not configured: METABASE_SITE_URL, METABASE_REPORTING_API_KEY " +
                  "and METABASE_EMBEDDING_SECRET are all required.");
    await mongoose.disconnect();
    process.exit(2);
  }

  const result = await bridge.cleanupDrafts({
    olderThanMs: hours * 3_600_000,
    apply,
    limit,
  });

  console.log(`  considered: ${result.considered}`);
  if (apply) {
    console.log(`  archived:   ${result.archived}`);
    for (const f of result.failed) console.log(`  FAILED      question ${f.cardId}: ${f.error}`);
  } else if (result.considered) {
    console.log("\n  Re-run with --apply to archive them.");
  }

  /* A saved report's question is never in that list, and the count is printed
     so that "it left mine alone" is something the operator can see rather than
     something they have to trust. */
  const { Acc_ReportChart } = require("../../models/Accountant_model/Acc_ReportChart");
  const saved = await Acc_ReportChart.countDocuments({ kind: "saved", archivedAt: null });
  console.log(`  untouched:  ${saved} saved-report question(s)`);

  await mongoose.disconnect();
  process.exit(result.failed && result.failed.length ? 1 : 0);
})().catch(async (err) => {
  console.error("chart cleanup failed:", err && err.message ? err.message : err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
