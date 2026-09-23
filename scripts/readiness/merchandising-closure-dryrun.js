// scripts/readiness/merchandising-closure-dryrun.js
//
// WHAT DEPLOYING THE MERCHANDISING CLOSURE WOULD FIND, WITHOUT CHANGING ANY
// OF IT.
//
// Six questions, answered by counting. There is not one write in this file —
// no create, no update, no delete, no index build — and running it twice
// changes nothing, because it changes nothing once.
//
//   1  Journey product lines that have no permanent reference yet
//   2  Development requests whose line reference no longer resolves
//   3  Execution files that could adopt a development selection but have no
//      recorded link, and whether the link is resolvable
//   4  Whether any published T&A template and working calendar exist at all
//   5  Execution files that predate the development flow
//   6  Audit events lost to the `fileId` schema defect, and whether the
//      history can be reconstructed
//
//   node -r dotenv/config scripts/readiness/merchandising-closure-dryrun.js
//
// Nothing here fabricates a historical event. Where a record cannot be
// reconstructed the report says so and stops; inventing an audit trail is
// worse than admitting a gap, because a reconstructed event is indistinguishable
// from one that actually happened.
"use strict";

const mongoose = require("mongoose");

const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  SalesDevelopmentRequest,
} = require("../../models/CMS_Models/Sales/DevelopmentRequest");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const { WorkingCalendarVersion } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");

const line = (s = "") => process.stdout.write(`${s}\n`);
const head = (n, t) => { line(""); line(`── ${n}. ${t}`); };
const say = (k, v) => line(`   ${String(k).padEnd(52)} ${v}`);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  line("MERCHANDISING PRODUCTION CLOSURE — DRY RUN (reads only, changes nothing)");
  line(`database: ${mongoose.connection.name}`);

  /* ── 1 ─────────────────────────────────────────────────────────────── */
  head(1, "Journey product lines without a permanent reference");
  const enquiries = await Enquiry.find({}).select("_id journeyId products").lean();
  let lines = 0, unreferenced = 0, enquiriesAffected = 0;
  for (const e of enquiries) {
    let bad = 0;
    for (const p of e.products || []) {
      lines += 1;
      if (!p.productLineRef) { unreferenced += 1; bad += 1; }
    }
    if (bad) enquiriesAffected += 1;
  }
  say("enquiries read", enquiries.length);
  say("product lines", lines);
  say("without a reference", unreferenced);
  say("enquiries affected", enquiriesAffected);
  line(unreferenced
    ? "   → A reference is minted by the pre-validate hook on the NEXT save of each\n"
      + "     enquiry. A backfill would be one no-op save per affected enquiry; it is\n"
      + "     safe because the hook never reissues a reference that already exists.\n"
      + "     Until then those lines cannot be sent for development, and the Sales\n"
      + "     panel says so per line rather than offering a button that would fail."
    : "   → Nothing to backfill.");

  /* ── 2 ─────────────────────────────────────────────────────────────── */
  head(2, "Development requests whose product line no longer resolves");
  const requests = await SalesDevelopmentRequest.find({})
    .select("requestRef journeyId productLineRef companyId").lean();
  let orphaned = 0;
  for (const r of requests) {
    const found = await Enquiry.findOne({
      companyId: r.companyId, journeyId: r.journeyId,
      "products.productLineRef": r.productLineRef,
    }).select("_id").lean();
    if (!found) orphaned += 1;
  }
  say("development requests", requests.length);
  say("whose line no longer resolves", orphaned);
  line(orphaned
    ? "   → These name a line that has been removed from its enquiry. The request is\n"
      + "     immutable and stays readable; nothing should be rewritten."
    : "   → Every request still resolves to its line.");

  /* ── 3 ─────────────────────────────────────────────────────────────── */
  head(3, "Development-to-Execution adoption compatibility");
  const files = await ExecutionFile.find({})
    .select("fileNumber companyId developmentReference currentExecutionProjection").lean();
  let linked = 0, resolvable = 0, noSource = 0, noStyleId = 0;
  for (const f of files) {
    if (f.developmentReference?.developmentFileId) { linked += 1; continue; }
    const proj = f.currentExecutionProjection || {};
    if (!proj.sampleStyleId) noStyleId += 1;
    const query = { companyId: f.companyId };
    if (proj.sampleStyleId) query.sampleStyleId = proj.sampleStyleId;
    else if (proj.styleRef) query.styleRef = proj.styleRef;
    else { noSource += 1; continue; }
    const dev = await DevelopmentFile.findOne(query).select("_id").lean();
    if (!dev) { noSource += 1; continue; }
    const approved = await DevelopmentBomRevision.findOne({
      companyId: f.companyId, developmentFileId: dev._id, state: BOM_STATE.APPROVED,
    }).select("_id").lean();
    if (approved) resolvable += 1; else noSource += 1;
  }
  say("execution files", files.length);
  say("with a recorded development link", linked);
  say("resolvable on first read (self-healing)", resolvable);
  say("with no development source at all", noSource);
  say("projections without a stable style id", noStyleId);
  line("   → No backfill is required. The link is resolved and RECORDED the first time\n"
    + "     the adoption preview is opened on a file, and files with no development\n"
    + "     source answer \"nothing to adopt\", which is the truth for an order that\n"
    + "     never went through development.");

  /* ── 4 ─────────────────────────────────────────────────────────────── */
  head(4, "T&A templates and working calendars");
  const publishedTemplates = await TnaTemplateVersion
    .countDocuments({ state: "PUBLISHED" }).catch(() => -1);
  const publishedCalendars = await WorkingCalendarVersion
    .countDocuments({ state: "PUBLISHED" }).catch(() => -1);
  say("published template versions", publishedTemplates);
  say("published calendar versions", publishedCalendars);
  line(publishedTemplates > 0 && publishedCalendars > 0
    ? "   → A plan can be created. No seed required."
    : "   → NO PLAN CAN BE CREATED until a manager publishes one of each. The screen\n"
      + "     now offers the act and the server refuses it with the reason, which is\n"
      + "     the honest behaviour — but a company with neither cannot use Time &\n"
      + "     Action at all. Seeding is a manager decision, not a migration.");

  /* ── 5 ─────────────────────────────────────────────────────────────── */
  head(5, "Execution files that predate the development flow");
  const firstDev = await DevelopmentFile.findOne({}).sort({ createdAt: 1 })
    .select("createdAt").lean();
  const predating = firstDev
    ? await ExecutionFile.countDocuments({ createdAt: { $lt: firstDev.createdAt } })
    : files.length;
  say("earliest development file", firstDev ? firstDev.createdAt.toISOString() : "(none)");
  say("execution files older than it", predating);
  line("   → They keep working unchanged: every development-aware surface is additive\n"
    + "     and absent-by-default. No migration.");

  /* ── 6 ─────────────────────────────────────────────────────────────── */
  head(6, "Audit events lost to the fileId schema defect");
  const total = await MerchandisingAuditEvent.countDocuments({});
  const withFileId = await MerchandisingAuditEvent.countDocuments({ fileId: { $ne: null } });
  const fileScoped = await MerchandisingAuditEvent.countDocuments({
    recordType: { $in: ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT", "APPROVAL", "TNA_PLAN"] },
  });
  say("audit events", total);
  say("carrying a fileId", withFileId);
  say("file-scoped by record type", fileScoped);
  const lost = Math.max(fileScoped - withFileId, 0);
  say("written before the field existed", lost);
  line("   → The field was absent from a strict schema, so the VALUE was dropped at\n"
    + "     write time. It was never stored and cannot be recovered from these rows.\n"
    + "     Reconstruction is possible ONLY where the event's own recordId still\n"
    + "     resolves to a record that names its file — a join, not an invention.\n"
    + "     Where it does not, the gap stays a gap: a fabricated audit event is\n"
    + "     indistinguishable from one that happened, which is worse than a hole.\n"
    + "     The history query already reads both the lineage ids and fileId, so\n"
    + "     nothing is hidden from the screen that can still be joined.");

  line("");
  line("Dry run complete. Nothing was written.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  line(`\nDRY RUN COULD NOT COMPLETE: ${e.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
