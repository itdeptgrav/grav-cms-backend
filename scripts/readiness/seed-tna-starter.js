// scripts/readiness/seed-tna-starter.js
//
// ONE WORKING CALENDAR AND ONE GARMENT-ORDER TEMPLATE, PER COMPANY.
//
// A Time & Action plan is instantiated from a PUBLISHED template against a
// PUBLISHED calendar. A company with neither cannot create a plan at all, so
// the register that exists to control order dates has nothing in it and the
// screen — correctly — refuses. This seeds the minimum that makes it usable.
//
//   node -r dotenv/config scripts/readiness/seed-tna-starter.js
//   node -r dotenv/config scripts/readiness/seed-tna-starter.js --apply
//
// Dry run by default. `--apply` writes.
//
// ── IT IS A STARTER, NOT A STANDARD ─────────────────────────────────────────
// The milestones below are the shape a garment order actually has, and the
// offsets are round numbers somebody is expected to change. What must NOT be
// changed casually is who owns each milestone and what closes it, which is why
// those are the two things this file explains rather than the dates.
//
// ── MERCHANDISING NEVER COMPLETES ANOTHER DEPARTMENT'S MILESTONE ────────────
// `completionAuthority: MERCHANDISING` appears only where `ownerDepartment` is
// also MERCHANDISING. Everywhere else it is SOURCE_EVENT, and the milestone
// waits for the owning application to publish a fact. The publish guard refuses
// the other pairing by name rather than trusting whoever configures it to
// remember — this seed simply never asks it to.
//
// Where an owning application does not yet publish an event this product can
// consume, `sourceEventKinds` is DELIBERATELY EMPTY. Such a milestone stays
// visibly awaiting one. That is the honest state: a tick box Merchandising
// fills in on Production's behalf is a lie about who did the work.
//
// ── IDEMPOTENT AND COMPANY-SCOPED ───────────────────────────────────────────
// Every read and write is filtered by companyId. A company that already has a
// published template or calendar is SKIPPED — not merged, not versioned, not
// overwritten. A published version is what live plans were scheduled against.
"use strict";

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const {
  TnaTemplate, TnaTemplateVersion,
} = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const { OUTBOX_KIND } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");

const config = require("../../services/merchandising/tnaConfig.service");

const CLI_APPLY = process.argv.includes("--apply");
const line = (s = "") => process.stdout.write(`${s}\n`);
const say = (k, v) => line(`   ${String(k).padEnd(46)} ${v}`);

const STARTER_CALENDAR = "Standard factory week";
const STARTER_TEMPLATE = "Standard garment order";

/** Monday to Saturday worked, Sunday not. Change it; that is the point. */
const WEEK_PATTERN = [true, true, true, true, true, true, false];

/**
 * The cross-department shape of a garment order.
 *
 * Read the third and fourth columns rather than the dates. Every milestone
 * owned outside Merchandising completes on its owner's event, and the two that
 * have no event to wait for yet say so by carrying none.
 */
const MILESTONES = [
  {
    milestoneCode: "TRIM_CARD_APPROVED", name: "Trim card approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.MATERIAL_TRIM_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 5, scope: "FILE",
    criticalPathCandidate: true, sortOrder: 0,
  },
  {
    milestoneCode: "PACKAGING_APPROVED", name: "Packaging specification approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.PACKAGING_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 7, scope: "FILE",
    sortOrder: 1,
  },
  {
    milestoneCode: "DEVELOPMENT_APPROVED", name: "Development requirements approved",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.DEVELOPMENT_APPROVED],
    anchor: "PLAN_START", offsetWorkingDays: 7, scope: "FILE",
    sortOrder: 2,
  },
  {
    /* Product Development's own record closes this. Merchandising coordinates
       it and cannot declare it done. */
    milestoneCode: "SAMPLE_APPROVED", name: "Buyer approves the sample",
    ownerDepartment: "PRODUCT_DEVELOPMENT", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 10, scope: "FILE",
    criticalPathCandidate: true, sortOrder: 3,
  },
  {
    milestoneCode: "FABRIC_IN_HOUSE", name: "Fabric in house",
    ownerDepartment: "STORE_SUPPLY_CHAIN", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 15, scope: "FILE",
    criticalPathCandidate: true, sortOrder: 4,
  },
  {
    milestoneCode: "TRIMS_IN_HOUSE", name: "Trims in house",
    ownerDepartment: "STORE_SUPPLY_CHAIN", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 12, scope: "FILE",
    sortOrder: 5,
  },
  {
    /* Merchandising's OWN act — handing its completed pack downstream — so
       Merchandising may record it, and the pack's own submission publishes the
       event that closes it. */
    milestoneCode: "PPC_HANDOVER", name: "Execution pack handed to PPC",
    ownerDepartment: "MERCHANDISING", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [OUTBOX_KIND.PACK_SUBMITTED],
    anchor: "PREDECESSOR", offsetWorkingDays: 2, scope: "FILE",
    criticalPathCandidate: true, sortOrder: 6,
  },
  {
    milestoneCode: "PRODUCTION_START", name: "Production starts",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "PREDECESSOR", offsetWorkingDays: 3, scope: "FILE",
    sortOrder: 7,
  },
  {
    milestoneCode: "FINAL_INSPECTION", name: "Final inspection passed",
    ownerDepartment: "QUALITY", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "EX_FACTORY", offsetWorkingDays: -3, scope: "FILE",
    criticalPathCandidate: true, sortOrder: 8,
  },
  {
    milestoneCode: "EX_FACTORY", name: "Ex-factory",
    ownerDepartment: "IE_PPC_PRODUCTION", completionAuthority: "SOURCE_EVENT",
    sourceEventKinds: [],
    anchor: "DELIVERY", offsetWorkingDays: -7, scope: "PER_DELIVERY",
    criticalPathCandidate: true, sortOrder: 9,
  },
];

const DEPENDENCIES = [
  { predecessorCode: "TRIM_CARD_APPROVED", successorCode: "SAMPLE_APPROVED", lagWorkingDays: 0 },
  { predecessorCode: "PACKAGING_APPROVED", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "DEVELOPMENT_APPROVED", successorCode: "SAMPLE_APPROVED", lagWorkingDays: 0 },
  { predecessorCode: "SAMPLE_APPROVED", successorCode: "FABRIC_IN_HOUSE", lagWorkingDays: 0 },
  { predecessorCode: "SAMPLE_APPROVED", successorCode: "TRIMS_IN_HOUSE", lagWorkingDays: 0 },
  { predecessorCode: "FABRIC_IN_HOUSE", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "TRIMS_IN_HOUSE", successorCode: "PPC_HANDOVER", lagWorkingDays: 0 },
  { predecessorCode: "PPC_HANDOVER", successorCode: "PRODUCTION_START", lagWorkingDays: 0 },
];

/** What a person may give as a reason. A closed list, so delays are countable. */
const REASON_CODES = [
  { code: "SUPPLIER_LATE", label: "Supplier delivered late", kind: "RESCHEDULE" },
  { code: "BUYER_CHANGE", label: "Buyer changed the requirement", kind: "RESCHEDULE" },
  { code: "SAMPLE_REJECTED", label: "Sample was rejected", kind: "RESCHEDULE" },
  { code: "CAPACITY", label: "Factory capacity", kind: "RESCHEDULE" },
  { code: "AWAITING_APPROVAL", label: "Waiting on an approval", kind: "BLOCK" },
  { code: "MATERIAL_SHORT", label: "Material short", kind: "BLOCK" },
];

/** Companies where somebody actually holds a Merchandising grant. */
async function merchandisingCompanies() {
  const grants = await DepartmentRole
    .find({ departmentSlug: "merchandiser", isActive: true }).select("email").lean();
  const emails = [...new Set(grants.map((g) => String(g.email || "").toLowerCase()))]
    .filter(Boolean);
  if (!emails.length) return [];

  const memberships = await SpCompanyMembership
    .find({ isActive: true, email: { $in: emails } }).select("companyId").lean();
  const ids = [...new Set(memberships.map((m) => String(m.companyId)))];
  if (!ids.length) return [];

  return Acc_Company.find({ _id: { $in: ids } }).select("companyName").lean();
}

/**
 * Seed one company.
 *
 * Exported and taking `apply` as an argument rather than reading a module-level
 * flag, so the closure harness can drive it IN-PROCESS. Spawning this file as a
 * child four times meant four connections to the same server in as many
 * seconds, and the failures that produced were the harness's, not the seed's.
 */
async function seedCompany(company, { apply = false } = {}) {
  const APPLY = apply;
  const ctx = { companyId: company._id };
  const actor = { name: "Starter configuration" };
  const out = { calendar: null, template: null, skipped: [] };

  /* ── The calendar ──────────────────────────────────────────────────── */
  const publishedCal = await WorkingCalendarVersion
    .findOne({ companyId: company._id, state: "PUBLISHED" }).select("_id").lean();
  if (publishedCal) {
    out.skipped.push("a published calendar already exists");
  } else if (APPLY) {
    const existing = await WorkingCalendar
      .findOne({ companyId: company._id, name: STARTER_CALENDAR }).lean();
    const cal = existing
      ? { calendar: { id: String(existing._id) } }
      : await config.createCalendar(ctx, {
        body: { name: STARTER_CALENDAR, timezone: "Asia/Kolkata" }, actor,
      });
    const calId = cal.calendar.id;

    const draft = await WorkingCalendarVersion
      .findOne({ companyId: company._id, calendarId: calId, state: "DRAFT" }).lean();
    const versionNo = draft
      ? draft.versionNo
      : (await config.createCalendarVersion(ctx, {
        calendarId: calId, actor,
        body: {
          weekPattern: WEEK_PATTERN,
          effectiveFrom: "2026-01-01",
          horizonTo: "2032-12-31",
          exceptions: [],
        },
      })).version.versionNo;

    await config.publishCalendarVersion(ctx, { calendarId: calId, versionNo, actor });
    out.calendar = { id: calId, name: STARTER_CALENDAR, versionNo };
  }

  /* ── The template ──────────────────────────────────────────────────── */
  const publishedTpl = await TnaTemplateVersion
    .findOne({ companyId: company._id, state: "PUBLISHED" }).select("_id").lean();
  if (publishedTpl) {
    out.skipped.push("a published template already exists");
  } else if (APPLY) {
    const existing = await TnaTemplate
      .findOne({ companyId: company._id, name: STARTER_TEMPLATE }).lean();
    const tpl = existing
      ? { template: { id: String(existing._id) } }
      : await config.createTemplate(ctx, { body: { name: STARTER_TEMPLATE }, actor });
    const tplId = tpl.template.id;

    /* The calendar this template plans against — the one just published, or
       whatever the company already had. */
    const calVersion = await WorkingCalendarVersion
      .findOne({ companyId: company._id, state: "PUBLISHED" }).select("calendarId").lean();

    const draft = await TnaTemplateVersion
      .findOne({ companyId: company._id, templateId: tplId, state: "DRAFT" }).lean();
    const versionNo = draft
      ? draft.versionNo
      : (await config.createVersion(ctx, {
        templateId: tplId, actor,
        body: {
          milestones: MILESTONES,
          dependencies: DEPENDENCIES,
          effectiveFrom: "2026-01-01",
          ...(calVersion ? { defaultCalendarId: String(calVersion.calendarId) } : {}),
        },
      })).version.versionNo;

    await config.publishVersion(ctx, { templateId: tplId, versionNo, actor });
    out.template = { id: tplId, name: STARTER_TEMPLATE, versionNo };
  }

  /* ── Reason codes ──────────────────────────────────────────────────── */
  if (APPLY) {
    for (const rc of REASON_CODES) {
      /* Upsert by (company, code, kind) — safe to repeat. */
      await config.upsertReasonCode(ctx, { body: rc });
    }
  }

  return out;
}

async function main() {
  const APPLY = CLI_APPLY;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  line(APPLY
    ? "T&A STARTER SEED — APPLYING."
    : "T&A STARTER SEED — DRY RUN. Nothing will be written. Pass --apply to write.");
  line(`database: ${mongoose.connection.name}`);
  line("");

  const companies = await merchandisingCompanies();
  say("companies with a Merchandising grant", companies.length);
  line("");

  let seeded = 0, skipped = 0;
  for (const company of companies) {
    const res = await seedCompany(company, { apply: APPLY });
    const label = `${company.companyName || company._id}`;
    if (res.skipped.length) {
      skipped += 1;
      line(`SKIP  ${label} — ${res.skipped.join("; ")}`);
      continue;
    }
    if (!APPLY) { line(`WOULD SEED  ${label}`); continue; }
    seeded += 1;
    line(`SEEDED  ${label}`);
    if (res.calendar) say("  calendar", `${res.calendar.name} v${res.calendar.versionNo}  ${res.calendar.id}`);
    if (res.template) say("  template", `${res.template.name} v${res.template.versionNo}  ${res.template.id}`);
  }

  line("");
  say("companies seeded", APPLY ? seeded : "(dry run)");
  say("companies skipped (already configured)", skipped);
  line("");
  line(APPLY ? "Done." : "Nothing was written. Re-run with --apply to seed.");
  await mongoose.disconnect();
}

module.exports = {
  seedCompany, merchandisingCompanies,
  MILESTONES, DEPENDENCIES, REASON_CODES, WEEK_PATTERN,
  STARTER_CALENDAR, STARTER_TEMPLATE,
};

/* Required by the closure harness, run by a person. Only the second connects. */
if (require.main === module) {
  main().catch(async (e) => {
    line(`\nSEED COULD NOT COMPLETE: ${e.stack || e.message}`);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
