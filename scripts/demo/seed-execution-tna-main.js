#!/usr/bin/env node
// scripts/demo/seed-execution-tna-main.js
//
// GIVE THE DEMO ORDERS A TIME & ACTION PLAN — through the real one.
//
// The Order Execution file now opens Time & Action as a tab of its own, and a
// demo order with no plan shows that tab's empty state for ever. Somebody
// reviewing the work sees "No Time & Action plan has been prepared for this
// order" and cannot tell whether that is the feature working or the feature
// missing.
//
// ── IT BUILDS NOTHING BY HAND ───────────────────────────────────────────────
// Every milestone here is created by `tnaPlan.service.createPlan` from a
// PUBLISHED template, and every state it then reaches is reached by the
// service's own commands — complete, block, move a forecast. Writing
// milestone documents directly would produce a plan that looked right and had
// never been through the rules: no audit trail, no dependency propagation, no
// working-calendar arithmetic, and statuses that stop agreeing with the dates
// the moment anything re-reads them.
//
// So a plan this script makes is indistinguishable from one a merchandiser
// made, because it was made the same way.
//
// ── IDEMPOTENT BECAUSE THE SERVICE ALREADY IS ───────────────────────────────
// `createPlan` refuses a file that has one (`TNA_PLAN_EXISTS`), so a second
// run skips rather than duplicating. The script never deletes a plan and
// never touches a file that already has one — including the four that already
// carry a full demo plan, which it reports and leaves alone.
//
// ── AND IT NAMES THE COMPANY OUT LOUD ───────────────────────────────────────
// Same guard as the raw-item ownership migration: an id AND the company's own
// name, checked against the company master, so a typo in a 24-character hex
// string is a refusal rather than a plan written into somebody else's books.
//
//   node -r dotenv/config scripts/demo/seed-execution-tna-main.js \
//     --company-id=<id> --company-name="<exact name>"
//   …--apply   actually create the plans
//   …--only=MEF-2026-0002,PPC-DEMO-2026-EF-HOLD   just these files
"use strict";

const mongoose = require("mongoose");

const str = (v) => String(v ?? "").trim();
const canon = (v) => str(v).replace(/\s+/g, " ");

/**
 * THE SHAPE A DEMO PLAN IS PUT INTO, as offsets from the plan's own dates.
 *
 * Expressed as intentions — "complete this one", "block that one", "move this
 * one past its baseline" — against the milestone CODES the published template
 * uses. Nothing here assumes a position in a list: a template that gains a
 * milestone next month still produces a coherent demo, and a code this
 * template does not carry is skipped and reported rather than failing the run.
 *
 * The result is the spread a reviewer needs to see the screen work: several
 * recorded, one overdue, one blocked, and things still to come.
 */
const STORY = Object.freeze([
  { code: "ORDER_CONFIRMED", act: "complete", daysAgo: 22 },
  { code: "MATERIAL_SELECTION", act: "complete", daysAgo: 14 },
  {
    code: "PP_SAMPLE_APPROVAL",
    act: "late",
    /* Moved past the approved date and left there: this is the one that
       reads OVERDUE once the date passes, which is what the Overview's
       cross-order exception view is for. */
    daysAgo: 5,
  },
  {
    code: "FABRIC_IN_HOUSE",
    act: "block",
    note: "Mill has not confirmed the dye lot for the main body fabric.",
  },
]);

async function confirmCompany(Company, { companyId, companyName }) {
  if (!mongoose.Types.ObjectId.isValid(str(companyId))) {
    return { ok: false, reason: `"${str(companyId)}" is not a company id.` };
  }
  const company = await Company.findById(str(companyId)).select("companyName").lean();
  if (!company) return { ok: false, reason: `No company has the id ${str(companyId)}.` };
  const held = canon(company.companyName);
  if (!canon(companyName)) {
    return { ok: false, reason: `Name the company as well as its id. That id holds "${held}".` };
  }
  if (held !== canon(companyName)) {
    return { ok: false, reason: `That id is "${held}", not "${canon(companyName)}". Nothing was changed.` };
  }
  return { ok: true, companyId: company._id, companyName: held };
}

const day = (base, offset) => {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function run({ companyId, companyName, apply = false, only = "" } = {}) {
  const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
  const { TnaPlan, TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const plans = require("../../services/merchandising/tnaPlan.service");
  const cal = require("../../services/merchandising/tnaCalendar");

  const confirmed = await confirmCompany(Acc_Company, { companyId, companyName });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };

  const ctx = { companyId: confirmed.companyId, actorEmail: "" };
  const actor = { name: "Demo seeder", email: "demo.seeder@grav.local" };
  const today = cal.todayInZone();

  const wanted = str(only) ? str(only).split(",").map(str).filter(Boolean) : null;
  const files = await ExecutionFile.find({
    companyId: confirmed.companyId,
    ...(wanted ? { fileNumber: { $in: wanted } } : {}),
  }).select("fileNumber currentExecutionProjection").sort({ fileNumber: 1 }).lean();

  const held = await TnaPlan.find({ companyId: confirmed.companyId })
    .select("fileId").lean();
  const hasPlan = new Set(held.map((p) => str(p.fileId)));

  const report = {
    at: new Date().toISOString(),
    companyId: str(confirmed.companyId),
    companyName: confirmed.companyName,
    today,
    applied: false,
    files: files.length,
    alreadyPlanned: [],
    wouldPlan: [],
    planned: [],
    failed: [],
  };

  for (const f of files) {
    const label = {
      fileNumber: str(f.fileNumber),
      buyer: str(f.currentExecutionProjection?.buyerDisplayLabel),
      product: str(f.currentExecutionProjection?.productName),
    };
    if (hasPlan.has(str(f._id))) report.alreadyPlanned.push(label);
    else report.wouldPlan.push(label);
  }

  if (!apply) return { ok: true, report, text: render(report) };

  for (const f of files) {
    if (hasPlan.has(str(f._id))) continue;
    const fileId = str(f._id);
    const name = str(f.fileNumber);
    try {
      /* Started three weeks back, so a plan built today already has
         milestones behind it as well as in front — a demo whose every date
         is in the future shows none of the states worth reviewing. */
      // eslint-disable-next-line no-await-in-loop
      await plans.createPlan(ctx, {
        fileId, actor, idempotencyKey: `demo-tna-${fileId}`,
        body: { planStartDate: day(today, -21) },
      });

      /* A baseline, so the dates mean something: until one is approved every
         date is a forecast and nothing can be late, which is exactly the
         state a reviewer must not be shown by accident. */
      // eslint-disable-next-line no-await-in-loop
      await plans.approveBaseline(ctx, {
        fileId, actor, idempotencyKey: `demo-tna-baseline-${fileId}`,
        body: { note: "Demo baseline, approved so the plan's dates are commitments." },
      });

      // eslint-disable-next-line no-await-in-loop
      const rows = await TnaMilestone.find({ companyId: ctx.companyId, fileId: f._id })
        .select("milestoneRef milestoneCode revision").lean();
      const byCode = new Map(rows.map((m) => [str(m.milestoneCode), m]));
      const done = [];
      const skipped = [];

      for (const step of STORY) {
        const m = byCode.get(step.code);
        if (!m) { skipped.push(step.code); continue; }
        /* Re-read each time: every command bumps the milestone's revision,
           and the next command names the revision it is changing. */
        // eslint-disable-next-line no-await-in-loop
        const live = await TnaMilestone.findById(m._id).select("revision").lean();
        const body = { expectedRevision: live.revision };
        try {
          if (step.act === "complete") {
            // eslint-disable-next-line no-await-in-loop
            await plans.completeMilestone(ctx, {
              fileId, milestoneRef: str(m.milestoneRef), actor,
              body: { ...body, actualDate: day(today, -step.daysAgo), note: "Recorded for the demo." },
            });
          } else if (step.act === "block") {
            // eslint-disable-next-line no-await-in-loop
            await plans.blockMilestone(ctx, {
              fileId, milestoneRef: str(m.milestoneRef), actor,
              body: { ...body, note: step.note },
            });
          } else if (step.act === "late") {
            // eslint-disable-next-line no-await-in-loop
            await plans.updateForecast(ctx, {
              fileId, milestoneRef: str(m.milestoneRef), actor,
              body: {
                ...body,
                forecastDate: day(today, -step.daysAgo),
                note: "Moved for the demo, so one milestone reads overdue.",
              },
            });
          }
          done.push(step.code);
        } catch (e) {
          skipped.push(`${step.code} (${e?.code || e?.message || "refused"})`);
        }
      }

      report.planned.push({ fileNumber: name, applied: done, skipped });
    } catch (e) {
      report.failed.push({ fileNumber: name, reason: e?.message || String(e), code: e?.code || "" });
    }
  }

  report.applied = true;
  return { ok: true, report, text: render(report) };
}

function render(r) {
  const L = [""];
  L.push("DEMO TIME & ACTION PLANS");
  L.push(`  Company        ${r.companyName}`);
  L.push(`  Company id     ${r.companyId}`);
  L.push(`  Today          ${r.today}`);
  L.push(`  Mode           ${r.applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  L.push(`  Execution files                        ${r.files}`);
  L.push(`  Already have a plan (left alone)       ${r.alreadyPlanned.length}`);
  for (const f of r.alreadyPlanned) L.push(`      · ${f.fileNumber} — ${f.buyer || "?"} · ${f.product || "?"}`);
  L.push(`  Would be given one                     ${r.wouldPlan.length}`);
  for (const f of r.wouldPlan) L.push(`      · ${f.fileNumber} — ${f.buyer || "?"} · ${f.product || "?"}`);
  if (r.applied) {
    L.push("");
    L.push(`  PLANNED ${r.planned.length}`);
    for (const p of r.planned) {
      L.push(`      · ${p.fileNumber} — ${p.applied.join(", ") || "plan only"}`);
      if (p.skipped.length) L.push(`          skipped: ${p.skipped.join(", ")}`);
    }
    if (r.failed.length) {
      L.push(`  FAILED ${r.failed.length}`);
      for (const f of r.failed) L.push(`      · ${f.fileNumber} — ${f.code} ${f.reason}`);
    }
  } else {
    L.push("");
    L.push("  Re-run with --apply to create them. Existing plans are never touched.");
  }
  L.push("");
  return L.join("\n");
}

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

async function main() {
  require("dotenv").config({ quiet: true });
  const companyId = arg("company-id");
  const companyName = arg("company-name");
  if (!companyId || !companyName) {
    console.error("Both --company-id and --company-name are required.");
    process.exitCode = 2;
    return;
  }
  /* A dry run must be a read: mongoose builds a required model's indexes on
     connect, and an index build is a write. */
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
    { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({
      companyId, companyName, apply: process.argv.includes("--apply"), only: arg("only"),
    });
    if (!out.ok) { console.error(`REFUSED: ${out.reason}`); process.exitCode = 1; return; }
    console.log(out.text);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, render, STORY, confirmCompany };
