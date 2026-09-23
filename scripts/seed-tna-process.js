// scripts/seed-tna-process.js
//
// A STARTER TIME & ACTION PROCESS FOR A COMPANY THAT HAS NONE.
//
// A T&A plan is instantiated from a PUBLISHED template against a PUBLISHED
// working calendar. Until both exist, `POST /files/:id/tna` can only refuse —
// so the very first thing anybody does with this module is configure it, and
// a company with no starting point has to invent a garment process from a
// blank form before it can schedule anything.
//
// This writes one honest starting point: a Monday–Friday calendar, and a
// fourteen-milestone template for a standard cut-and-sew order. It is a
// STARTING POINT, not a standard. Every company's process differs, and the
// template is versioned precisely so this one can be superseded the moment
// somebody who knows the factory looks at it.
//
// ── DRY RUN BY DEFAULT, AND APPLY MEANS APPLY ───────────────────────────────
//   node -r dotenv/config scripts/seed-tna-process.js --company=<id>
//       reports exactly what it would write, and writes nothing.
//
//   node -r dotenv/config scripts/seed-tna-process.js --company=<id> --apply \
//        --authorized-by="<who authorised this>"
//       creates and publishes the calendar and the template.
//
// `--apply` without `--authorized-by` is refused. The name is recorded as the
// publisher of both versions, so the run can be attributed afterwards. Do not
// run `--apply` against user data without that authorization actually
// existing.
//
// ── IT REFUSES RATHER THAN REPAIRS ──────────────────────────────────────────
// If the company already has a published template or a published calendar,
// this stops and says so. It does not add a second one, does not supersede
// what is there, and does not merge. A company that has configured its own
// process has made decisions this script knows nothing about, and quietly
// publishing a competing version would make `resolveTemplateVersion`
// ambiguous — which the service correctly refuses, on every plan creation,
// until a person untangles it.
//
// ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
// No execution file, no plan, no milestone, no baseline. It writes
// configuration and nothing else. Creating plans for existing files is a
// separate decision, made per file by somebody who knows whether that order's
// dates are still worth scheduling.
"use strict";

const mongoose = require("mongoose");

const {
  TnaTemplate, TnaTemplateVersion,
} = require("../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../models/CMS_Models/Merchandising/WorkingCalendar");
const { TnaReasonCode } = require("../models/CMS_Models/Merchandising/TnaPlan");
const { OUTBOX_KIND } = require("../models/CMS_Models/Merchandising/MerchandisingEvent");
const graph = require("../services/merchandising/tnaGraph");

/* ── THE PROCESS ──────────────────────────────────────────────────────────
   Read as a sentence: the order is confirmed, the trims and packing are
   settled, fabric and trims arrive, the factory cuts, sews, finishes and
   packs, quality passes it, and it leaves.

   OWNERSHIP is the part worth reading carefully. A milestone owned by another
   department is `SOURCE_EVENT`: Merchandising coordinates the date and cannot
   mark that department's work done. Three of them name the M4 approval events
   that genuinely close them today; the rest name no event yet and will read
   as `Awaiting their record` until the owning module publishes one. That is
   the honest state, and it is deliberately visible rather than papered over
   with a tick box a merchandiser fills in on Production's behalf.

   OFFSETS are working days. The pre-shipment ones count BACK from the
   committed delivery, which is how every date in a garment order is actually
   expressed. */
const MILESTONES = [
  {
    milestoneCode: "ORDER_CONFIRMED", name: "Order confirmed",
    ownerDepartment: "SALES", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    anchor: "PLAN_START", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "TRIM_CARD_APPROVED", name: "Trim card approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
  },
  {
    milestoneCode: "PACKAGING_APPROVED", name: "Packaging specification approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.PACKAGING_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
  },
  {
    milestoneCode: "DEVELOPMENT_APPROVED", name: "Development requirements approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.DEVELOPMENT_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
  },
  {
    milestoneCode: "FABRIC_ORDERED", name: "Fabric ordered",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "TRIMS_ORDERED", name: "Trims ordered",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "FABRIC_IN_HOUSE", name: "Fabric in house",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "TRIMS_IN_HOUSE", name: "Trims in house",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    /* Merchandising's OWN act — handing the file to the floor. */
    milestoneCode: "PPC_HANDOVER", name: "File handed to PPC",
    ownerDepartment: "MERCHANDISING", completionAuthority: "MERCHANDISING",
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "CUTTING_START", name: "Cutting starts",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "SEWING_START", name: "Sewing starts",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 0, scope: "FILE",
  },
  {
    milestoneCode: "FINAL_INSPECTION", name: "Final inspection passed",
    ownerDepartment: "QUALITY", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    /* Counted back from the committed delivery: inspection is scheduled by
       when the goods must leave, not by when sewing happened to finish. */
    anchor: "DELIVERY", offsetWorkingDays: -8, scope: "PER_DELIVERY",
  },
  {
    milestoneCode: "PACKING_COMPLETE", name: "Packing complete",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    anchor: "DELIVERY", offsetWorkingDays: -5, scope: "PER_DELIVERY",
  },
  {
    milestoneCode: "EX_FACTORY", name: "Ex-factory",
    ownerDepartment: "LOGISTICS", completionAuthority: "SOURCE_EVENT", sourceEventKinds: [],
    anchor: "DELIVERY", offsetWorkingDays: -3, scope: "PER_DELIVERY",
  },
];

const DEPENDENCIES = [
  { predecessorCode: "ORDER_CONFIRMED", successorCode: "TRIM_CARD_APPROVED", lagWorkingDays: 0 },
  { predecessorCode: "ORDER_CONFIRMED", successorCode: "PACKAGING_APPROVED", lagWorkingDays: 0 },
  { predecessorCode: "ORDER_CONFIRMED", successorCode: "DEVELOPMENT_APPROVED", lagWorkingDays: 0 },
  { predecessorCode: "TRIM_CARD_APPROVED", successorCode: "FABRIC_ORDERED", lagWorkingDays: 0 },
  { predecessorCode: "TRIM_CARD_APPROVED", successorCode: "TRIMS_ORDERED", lagWorkingDays: 0 },
  /* The long poles: cloth is milled to order, trims are usually stocked. */
  { predecessorCode: "FABRIC_ORDERED", successorCode: "FABRIC_IN_HOUSE", lagWorkingDays: 20 },
  { predecessorCode: "TRIMS_ORDERED", successorCode: "TRIMS_IN_HOUSE", lagWorkingDays: 12 },
  { predecessorCode: "FABRIC_IN_HOUSE", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "TRIMS_IN_HOUSE", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "PACKAGING_APPROVED", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "PPC_HANDOVER", successorCode: "CUTTING_START", lagWorkingDays: 1 },
  { predecessorCode: "CUTTING_START", successorCode: "SEWING_START", lagWorkingDays: 2 },
  { predecessorCode: "SEWING_START", successorCode: "FINAL_INSPECTION", lagWorkingDays: 10 },
  { predecessorCode: "FINAL_INSPECTION", successorCode: "PACKING_COMPLETE", lagWorkingDays: 0 },
  { predecessorCode: "PACKING_COMPLETE", successorCode: "EX_FACTORY", lagWorkingDays: 0 },
];

/** The vocabulary a block or a reschedule must choose from. */
const REASON_CODES = [
  { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
  { code: "BUYER_CHANGE", label: "Buyer changed the requirement", kind: "RESCHEDULE" },
  { code: "APPROVAL_DELAY", label: "Approval took longer than planned", kind: "RESCHEDULE" },
  { code: "CAPACITY", label: "Factory capacity", kind: "RESCHEDULE" },
  { code: "QUALITY_REWORK", label: "Rework after inspection", kind: "RESCHEDULE" },
  { code: "AWAITING_APPROVAL", label: "Waiting on an approval", kind: "BLOCK" },
  { code: "AWAITING_MATERIAL", label: "Waiting on material", kind: "BLOCK" },
  { code: "AWAITING_BUYER", label: "Waiting on the buyer", kind: "BLOCK" },
  { code: "AWAITING_SAMPLE", label: "Waiting on a sample decision", kind: "BLOCK" },
];

/* ── ARGUMENTS ────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { apply: false, authorizedBy: "", company: "", timezone: "Asia/Kolkata" };
  for (const arg of argv.slice(2)) {
    if (arg === "--apply") out.apply = true;
    else if (arg.startsWith("--authorized-by=")) out.authorizedBy = arg.slice(16).trim();
    else if (arg.startsWith("--company=")) out.company = arg.slice(10).trim();
    else if (arg.startsWith("--timezone=")) out.timezone = arg.slice(11).trim();
  }
  return out;
}

const line = (s = "") => process.stdout.write(`${s}\n`);

async function main() {
  const args = parseArgs(process.argv);

  if (!args.company || !mongoose.Types.ObjectId.isValid(args.company)) {
    line("Say which company: --company=<objectId>");
    process.exitCode = 1;
    return;
  }
  if (args.apply && !args.authorizedBy) {
    /* Refused, not warned. `--apply` writes published configuration that
       every future plan in this company is built from. */
    line("--apply needs --authorized-by=\"<who authorised this>\". Nothing was written.");
    process.exitCode = 1;
    return;
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  const companyId = new mongoose.Types.ObjectId(args.company);

  try {
    /* Validate the process before saying anything about writing it: a
       template with a cycle cannot be published, and finding that out after
       creating the calendar would leave half a configuration behind. */
    graph.rank(MILESTONES.map((m) => m.milestoneCode), DEPENDENCIES);

    const [existingTemplate, existingCalendar] = await Promise.all([
      TnaTemplateVersion.findOne({ companyId, state: "PUBLISHED" }).lean(),
      WorkingCalendarVersion.findOne({ companyId, state: "PUBLISHED" }).lean(),
    ]);

    line("");
    line("  Time & Action starting process");
    line(`  company            ${args.company}`);
    line(`  milestones         ${MILESTONES.length}`);
    line(`  dependencies       ${DEPENDENCIES.length}`);
    line(`  reason codes       ${REASON_CODES.length}`);
    line(`  calendar           Monday–Friday, ${args.timezone}, horizon 2035-12-31`);
    line("");

    if (existingTemplate || existingCalendar) {
      /* Refuse rather than repair — see the header. */
      line("  This company already has published Time & Action configuration:");
      if (existingTemplate) line(`    template version ${existingTemplate.versionNo}`);
      if (existingCalendar) line(`    calendar version ${existingCalendar.versionNo}`);
      line("");
      line("  Nothing was written. Publishing a second one would make template");
      line("  resolution ambiguous, and every plan creation would then be refused");
      line("  until somebody untangled it. Edit the existing version, or publish a");
      line("  successor from the application.");
      return;
    }

    const owned = MILESTONES.filter((m) => m.ownerDepartment !== "MERCHANDISING");
    const wired = MILESTONES.filter((m) => (m.sourceEventKinds || []).length);
    line(`  ${owned.length} of ${MILESTONES.length} milestones belong to another department.`);
    line(`  ${wired.length} of those close automatically today; the rest will read`);
    line("  \"Awaiting their record\" until that module publishes an event.");
    line("");

    if (!args.apply) {
      line("  DRY RUN — nothing was written.");
      line("  Re-run with --apply --authorized-by=\"<name>\" to publish it.");
      return;
    }

    const actor = { name: args.authorizedBy };
    const at = new Date();

    const calendar = await WorkingCalendar.create({
      companyId,
      calendarRef: `CAL-${Date.now().toString(36)}`,
      name: "Factory working calendar",
      timezone: args.timezone,
      isActive: true,
      createdBy: actor,
    });
    await WorkingCalendarVersion.create({
      companyId,
      calendarId: calendar._id,
      versionNo: 1,
      state: "PUBLISHED",
      weekPattern: [true, true, true, true, true, false, false],
      /* Deliberately empty. A holiday nobody declared is worse than none:
         inventing this company's festival calendar would put dates in the
         plan that nobody agreed to. They are added in the application. */
      exceptions: [],
      effectiveFrom: "2020-01-01",
      horizonTo: "2035-12-31",
      publishedBy: actor,
      publishedAt: at,
      createdBy: actor,
    });

    const template = await TnaTemplate.create({
      companyId,
      templateRef: `TPL-${Date.now().toString(36)}`,
      name: "Standard cut and sew",
      description: "A starting point. Supersede it with the process this factory actually runs.",
      isActive: true,
      createdBy: actor,
    });
    await TnaTemplateVersion.create({
      companyId,
      templateId: template._id,
      versionNo: 1,
      state: "PUBLISHED",
      /* No selectors, so it applies to every order. A company with more than
         one process narrows this version and publishes the others beside it. */
      selectors: {},
      milestones: MILESTONES,
      dependencies: DEPENDENCIES,
      defaultCalendarId: calendar._id,
      effectiveFrom: "2020-01-01",
      publishedBy: actor,
      publishedAt: at,
      createdBy: actor,
    });

    for (const r of REASON_CODES) {
      await TnaReasonCode.updateOne(
        { companyId, code: r.code },
        { $set: { label: r.label, kind: r.kind, isActive: true } },
        { upsert: true },
      );
    }

    line(`  WROTE calendar version 1 and template version 1, published by ${args.authorizedBy}.`);
    line(`  WROTE ${REASON_CODES.length} reason codes.`);
    line("  No execution file, plan, milestone or baseline was touched.");
  } catch (err) {
    line(`  REFUSED: ${err?.message || err}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  line(`  FAILED: ${err?.message || err}`);
  process.exitCode = 1;
});
