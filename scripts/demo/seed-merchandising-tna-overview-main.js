// Populate the main demo company's existing execution files with believable
// Time & Action plans so the Merchandising Overview can be judged with data.
//
// Dry-run by default:
//   node -r dotenv/config scripts/demo/seed-merchandising-tna-overview-main.js \
//     --company=6a08040a1fecacc9bb7149c2
//
// Apply explicitly:
//   node -r dotenv/config scripts/demo/seed-merchandising-tna-overview-main.js \
//     --company=6a08040a1fecacc9bb7149c2 --apply
//
// Existing non-demo plans are never changed. The stable template/calendar
// references and one-plan-per-file index make the script safe to rerun.
"use strict";

const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  TnaTemplate, TnaTemplateVersion,
} = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const {
  WorkingCalendar, WorkingCalendarVersion,
} = require("../../models/CMS_Models/Merchandising/WorkingCalendar");
const {
  TnaPlan, TnaMilestone, TnaBaseline, TnaReasonCode,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

const COMPANY_ARG = (process.argv.find((a) => a.startsWith("--company=")) || "").slice(10);
const APPLY = process.argv.includes("--apply");
const TEMPLATE_REF = "DEMO-MERCH-OVERVIEW-TNA";
const CALENDAR_REF = "DEMO-MERCH-OVERVIEW-WEEK";
const ACTOR = { name: "Merchandising demo data", email: "demo@grav.local" };

const STEPS = Object.freeze([
  ["ORDER_CONFIRMED", "Order confirmed", "SALES", "SOURCE_EVENT"],
  ["MATERIAL_SELECTION", "Materials and trims approved", "MERCHANDISING", "MERCHANDISING"],
  ["PP_SAMPLE_APPROVAL", "PP sample approved", "PRODUCT_DEVELOPMENT", "SOURCE_EVENT"],
  ["FABRIC_IN_HOUSE", "Fabric in house", "STORE_SUPPLY_CHAIN", "SOURCE_EVENT"],
  ["PPC_HANDOVER", "Execution pack handed to PPC", "MERCHANDISING", "MERCHANDISING"],
  ["PRODUCTION_START", "Production starts", "IE_PPC_PRODUCTION", "SOURCE_EVENT"],
  ["FINAL_INSPECTION", "Final inspection passed", "QUALITY", "SOURCE_EVENT"],
  ["EX_FACTORY", "Ex-factory", "LOGISTICS", "SOURCE_EVENT"],
]);

const PROFILES = Object.freeze([
  [
    ["COMPLETED", -22], ["COMPLETED", -14], ["OVERDUE", -5], ["BLOCKED", 2],
    ["DUE_SOON", 0], ["DUE_SOON", 4], ["PENDING", 10], ["PENDING", 15],
  ],
  [
    ["COMPLETED", -24], ["COMPLETED", -16], ["COMPLETED", -9], ["OVERDUE", -2],
    ["FORECAST_LATE", 3], ["DUE_SOON", 5], ["PENDING", 12], ["PENDING", 16],
  ],
  [
    ["COMPLETED", -18], ["COMPLETED", -10], ["DUE_SOON", 0], ["DUE_SOON", 2],
    ["DUE_SOON", 4], ["PENDING", 8], ["PENDING", 14], ["PENDING", 18],
  ],
  [
    ["COMPLETED", -25], ["COMPLETED", -17], ["COMPLETED", -11], ["COMPLETED", -5],
    ["COMPLETED", -2], ["BLOCKED", 1], ["DUE_SOON", 6], ["PENDING", 11],
  ],
]);

const line = (value = "") => process.stdout.write(`${value}\n`);

function todayInIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function plusDays(iso, n) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function milestoneDocument({ companyId, fileId, planId, step, state, today, rank }) {
  const [milestoneCode, name, ownerDepartment, completionAuthority] = step;
  const [status, offset] = state;
  const forecastDate = plusDays(today, offset);
  const completed = status === "COMPLETED";
  const baselineDate = status === "FORECAST_LATE" ? plusDays(today, -1) : forecastDate;
  return {
    companyId, fileId, planId,
    milestoneRef: milestoneCode, milestoneCode, name, ownerDepartment, completionAuthority,
    sourceEventKinds: [], scopeKind: "FILE", sequenceRank: rank,
    baselineDate, forecastDate,
    actualDate: completed ? forecastDate : null,
    status,
    blocked: status === "BLOCKED" ? {
      reasonCode: rank === 3 ? "AWAITING_MATERIAL" : "CAPACITY",
      note: rank === 3
        ? "Supplier confirmation is pending for the balance fabric quantity."
        : "Production capacity is awaiting confirmation from PPC.",
      by: ACTOR, at: new Date(),
    } : null,
    completion: completed ? {
      recordedVia: completionAuthority === "MERCHANDISING"
        ? "MERCHANDISING_ENTRY" : "SOURCE_EVENT",
      sourceApp: completionAuthority === "MERCHANDISING" ? "" : ownerDepartment.toLowerCase(),
      sourceRecordType: "DEMO", sourceRecordRef: `DEMO-${milestoneCode}`,
      observedAt: new Date(`${forecastDate}T06:00:00.000Z`), actor: ACTOR,
    } : null,
    revision: 0,
  };
}

async function ensureConfiguration(companyId, today) {
  let calendar = await WorkingCalendar.findOne({ companyId, calendarRef: CALENDAR_REF });
  if (!calendar) {
    calendar = await WorkingCalendar.create({
      companyId, calendarRef: CALENDAR_REF, name: "Demo factory working week",
      timezone: "Asia/Kolkata", createdBy: ACTOR,
    });
  }
  let calendarVersion = await WorkingCalendarVersion.findOne({
    companyId, calendarId: calendar._id, versionNo: 1,
  });
  if (!calendarVersion) {
    calendarVersion = await WorkingCalendarVersion.create({
      companyId, calendarId: calendar._id, versionNo: 1, state: "PUBLISHED",
      effectiveFrom: plusDays(today, -365), horizonTo: plusDays(today, 730),
      weekPattern: [true, true, true, true, true, true, false], exceptions: [],
      publishedBy: ACTOR, publishedAt: new Date(), createdBy: ACTOR,
    });
  }

  let template = await TnaTemplate.findOne({ companyId, templateRef: TEMPLATE_REF });
  if (!template) {
    template = await TnaTemplate.create({
      companyId, templateRef: TEMPLATE_REF, name: "Demo standard garment order",
      description: "Demo process used to visualise the Merchandising Overview and order T&A.",
      createdBy: ACTOR,
    });
  }
  let templateVersion = await TnaTemplateVersion.findOne({
    companyId, templateId: template._id, versionNo: 1,
  });
  if (!templateVersion) {
    templateVersion = await TnaTemplateVersion.create({
      companyId, templateId: template._id, versionNo: 1, state: "PUBLISHED",
      effectiveFrom: plusDays(today, -365), defaultCalendarId: calendar._id,
      milestones: STEPS.map(([milestoneCode, name, ownerDepartment, completionAuthority], i) => ({
        milestoneCode, name, ownerDepartment, completionAuthority, sourceEventKinds: [],
        anchor: "PLAN_START", offsetWorkingDays: i * 4, scope: "FILE",
        criticalPathCandidate: i >= 5, sortOrder: i,
      })),
      dependencies: STEPS.slice(1).map(([milestoneCode], i) => ({
        dependencyRef: `DEMO-DEP-${i + 1}`, predecessorCode: STEPS[i][0],
        successorCode: milestoneCode, type: "FINISH_TO_START", lagWorkingDays: 0,
      })),
      publishedBy: ACTOR, publishedAt: new Date(), createdBy: ACTOR,
    });
  }
  return { calendar, calendarVersion, template, templateVersion };
}

async function seedFile({ companyId, file, profile, config, today }) {
  let plan = await TnaPlan.findOne({ companyId, fileId: file._id });
  if (plan && plan.templateName !== "Demo standard garment order") {
    return { fileNumber: file.fileNumber, outcome: "skipped-existing-plan", milestones: 0 };
  }
  if (!plan) {
    plan = await TnaPlan.create({
      companyId, fileId: file._id,
      templateId: config.template._id, templateVersionId: config.templateVersion._id,
      templateVersionNo: 1, templateName: config.template.name,
      calendarId: config.calendar._id, calendarVersionId: config.calendarVersion._id,
      calendarVersionNo: 1, calendarName: config.calendar.name, timezone: "Asia/Kolkata",
      state: "ACTIVE", planStartDate: plusDays(today, -25), currentBaselineNo: 1,
      revision: 0, createdBy: ACTOR, updatedBy: ACTOR,
    });
  }

  const docs = STEPS.map((step, rank) => milestoneDocument({
    companyId, fileId: file._id, planId: plan._id,
    step, state: profile[rank], today, rank,
  }));
  for (const doc of docs) {
    // Repair a partially interrupted demo run, but never rewrite a milestone
    // somebody has subsequently acted on.
    // eslint-disable-next-line no-await-in-loop
    await TnaMilestone.updateOne(
      { companyId, planId: plan._id, milestoneRef: doc.milestoneRef },
      { $setOnInsert: doc },
      { upsert: true },
    );
  }
  await TnaBaseline.updateOne(
    { companyId, planId: plan._id, baselineNo: 1 },
    {
      $setOnInsert: {
        companyId, planId: plan._id, fileId: file._id, baselineNo: 1, state: "ACTIVE",
        templateVersionId: config.templateVersion._id,
        calendarVersionId: config.calendarVersion._id,
        planStartDate: plusDays(today, -25),
        entries: docs.map((d) => ({
          milestoneRef: d.milestoneRef, milestoneCode: d.milestoneCode,
          baselineDate: d.baselineDate,
        })),
        approvedBy: ACTOR, approvedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return { fileNumber: file.fileNumber, outcome: "seeded", milestones: docs.length };
}

async function main() {
  if (!mongoose.Types.ObjectId.isValid(COMPANY_ARG)) {
    throw new Error("Use --company=<company ObjectId>.");
  }
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const companyId = new mongoose.Types.ObjectId(COMPANY_ARG);
  const company = await Acc_Company.findById(companyId).select("companyName").lean();
  if (!company) throw new Error("That company does not exist.");

  const files = await ExecutionFile.find({
    companyId, lifecycleStatus: { $in: ["OPEN", "ON_HOLD", "HANDED_OVER"] }, archived: { $ne: true },
  }).sort({ createdAt: 1, _id: 1 }).limit(PROFILES.length).lean();
  const existingPlans = await TnaPlan.countDocuments({ companyId });
  const existingMilestones = await TnaMilestone.countDocuments({ companyId });

  line("");
  line("MERCHANDISING T&A OVERVIEW DEMO");
  line(`  Company                 ${company.companyName}`);
  line(`  Mode                    ${APPLY ? "APPLY" : "DRY RUN"}`);
  line(`  Execution files chosen  ${files.length}`);
  line(`  Existing plans          ${existingPlans}`);
  line(`  Existing milestones     ${existingMilestones}`);
  files.forEach((f) => line(`    ${f.fileNumber} · ${f.currentExecutionProjection?.productName || "Order"}`));

  if (!files.length) throw new Error("No active execution files are available to populate.");
  if (!APPLY) {
    line(`  Would create up to      ${files.length} plans / ${files.length * STEPS.length} milestones`);
    line("  Nothing written. Re-run with --apply.");
    return;
  }

  const today = todayInIndia();
  const config = await ensureConfiguration(companyId, today);
  await Promise.all([
    TnaReasonCode.updateOne(
      { companyId, code: "AWAITING_MATERIAL", kind: "BLOCK" },
      { $setOnInsert: { companyId, code: "AWAITING_MATERIAL", label: "Waiting on material", kind: "BLOCK" } },
      { upsert: true },
    ),
    TnaReasonCode.updateOne(
      { companyId, code: "CAPACITY", kind: "BLOCK" },
      { $setOnInsert: { companyId, code: "CAPACITY", label: "Factory capacity", kind: "BLOCK" } },
      { upsert: true },
    ),
  ]);

  const outcomes = [];
  for (let i = 0; i < files.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    outcomes.push(await seedFile({
      companyId, file: files[i], profile: PROFILES[i], config, today,
    }));
  }
  const [plansAfter, milestonesAfter] = await Promise.all([
    TnaPlan.countDocuments({ companyId }), TnaMilestone.countDocuments({ companyId }),
  ]);
  outcomes.forEach((o) => line(`  ${o.fileNumber.padEnd(28)} ${o.outcome} (${o.milestones})`));
  line(`  Plans now               ${plansAfter}`);
  line(`  Milestones now          ${milestonesAfter}`);
  line("  Refresh Merchandising Overview to inspect the populated T&A.");
}

main()
  .catch((error) => {
    console.error(`FAILED: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

