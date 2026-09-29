#!/usr/bin/env node
/**
 * scripts/migrations/tna-milestone-library-report.js
 *
 * WHAT EVERY COMPANY'S TEMPLATES SAY, AGAINST THE MILESTONE LIST.
 *
 * ── THIS SCRIPT DOES NOT WRITE ────────────────────────────────────────────
 * There is no `--apply`, deliberately. Every question it raises is a question
 * about somebody's process:
 *
 *   • a template step naming a milestone the list does not hold — is that a
 *     milestone the company still wants, or one they abandoned?
 *   • two codes whose words mean the same thing — which of the two did each
 *     template author actually mean?
 *   • a step whose owning department or completion rule differs from the
 *     list's — which is right?
 *
 * A script that answered those by picking would silently merge two different
 * control points into one, and the reports built on them would then be wrong
 * in a way nobody could see. So it reports, and a person decides. Adding a
 * missing milestone to the list is `POST /api/cms/merchandising/tna/milestones`;
 * seeding the shipped ones is `scripts/readiness/seed-tna-starter.js --apply`.
 *
 *   node -r dotenv/config scripts/migrations/tna-milestone-library-report.js
 *   node -r dotenv/config scripts/migrations/tna-milestone-library-report.js --company-id=<id>
 */
"use strict";

const mongoose = require("mongoose");

const { TnaTemplate, TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const { TnaPlan } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  TnaMilestoneDefinition, MILESTONE_STAGE,
} = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const library = require("../../services/merchandising/tnaMilestoneLibrary.service");
const { nameIdentity } = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");
const sourceEvents = require("../../services/merchandising/tnaSourceEvents");

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};
const line = (s = "") => process.stdout.write(`${s}\n`);
const say = (k, v) => line(`   ${String(k).padEnd(50)} ${v}`);

/**
 * Two names mean the same thing when their identities match.
 *
 * `nameIdentity` is the model's own derivation — the same rules the unique index
 * enforces — so a collision this report prints is exactly a collision the
 * database would refuse. A second, looser copy of these rules here would let
 * the report disagree with the index it is reporting on.
 *
 * `loosely` goes further, dropping filler words, to catch pairs the index would
 * NOT refuse but a person probably should: "Fabric in house" against "Fabric is
 * in the house". Those are reported separately, as a question rather than a
 * finding.
 */
const normalise = nameIdentity;
const loosely = (s) => nameIdentity(s)
  .replace(/\b(the|a|an|is|are|has|been|by|of|to|for|in|on)\b/g, " ")
  .trim().replace(/\s+/g, " ");

/** Report one company. Returns a plain object; prints nothing. */
async function inspectCompany(companyId) {
  const [definitions, templates, plans] = await Promise.all([
    TnaMilestoneDefinition.find({ companyId }).lean(),
    TnaTemplate.find({ companyId }).select("_id name").lean(),
    TnaPlan.countDocuments({ companyId }),
  ]);
  /* `code` is the shared collection's identity field; every line this report
     prints says `milestoneCode`, which is what a reader of a template calls it. */
  const byCode = new Map(definitions.map((d) => [d.code, d]));
  const byName = new Map();
  for (const d of definitions) {
    const key = normalise(d.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(d);
  }

  const versions = templates.length
    ? await TnaTemplateVersion.find({
      companyId, templateId: { $in: templates.map((t) => t._id) },
    }).select("templateId versionNo state milestones").lean()
    : [];
  const templateName = new Map(templates.map((t) => [String(t._id), t.name]));

  const out = {
    companyId: String(companyId),
    library: { held: definitions.length, active: definitions.filter((d) => d.isActive !== false).length },
    plans,
    /* A step naming something the list does not hold. */
    notOnList: [],
    /* A step whose facts disagree with the list's. */
    disagrees: [],
    /* A step selecting work the list says happens before an order exists. */
    wrongStage: [],
    /* Two list entries whose words mean one thing. The index cannot hold these
       retrospectively: definitions created before it existed may collide, and
       nothing here merges them — a person decides which one each template meant. */
    duplicateMeaning: [],
    /* Pairs the index would allow but a person should probably look at. */
    nearlyTheSame: [],
    /* On the list, waiting for an action no application publishes yet. */
    notIntegrated: [],
    /* On the list and never selected by any template. */
    unused: [],
  };

  for (const [key, group] of byName) {
    if (group.length > 1) {
      out.duplicateMeaning.push({
        meaning: key,
        codes: group.map((d) => d.code),
        names: group.map((d) => d.name),
        /* What a person has to answer before anything can be merged. */
        question: "Which of these did each template that uses it actually mean? "
          + "Nothing is merged automatically: merging two control points makes "
          + "every report over them wrong in a way nobody can see.",
      });
    }
  }
  /* And the looser pass, which the index does not enforce. */
  const byLoose = new Map();
  for (const d of definitions) {
    const key = loosely(d.name);
    if (!key) continue;
    if (!byLoose.has(key)) byLoose.set(key, []);
    byLoose.get(key).push(d);
  }
  for (const [key, group] of byLoose) {
    if (group.length > 1 && new Set(group.map((d) => normalise(d.name))).size > 1) {
      out.nearlyTheSame.push({
        meaning: key,
        codes: group.map((d) => d.code),
        names: group.map((d) => d.name),
      });
    }
  }
  for (const d of definitions) {
    if (d.systemEventKey && !sourceEvents.isSupported(d.systemEventKey)) {
      const state = sourceEvents.stateOf(d.systemEventKey);
      out.notIntegrated.push({
        milestoneCode: d.code, name: d.name,
        waitingFor: state.label, owedBy: state.owner || "unknown",
      });
    }
  }

  const selected = new Set();
  for (const v of versions) {
    const where = `${templateName.get(String(v.templateId)) || v.templateId} v${v.versionNo} (${v.state})`;
    for (const m of v.milestones || []) {
      selected.add(m.milestoneCode);
      const def = byCode.get(m.milestoneCode);
      if (!def) {
        out.notOnList.push({ where, milestoneCode: m.milestoneCode, name: m.name || "" });
        continue;
      }
      if (def.stage === MILESTONE_STAGE.DEVELOPMENT) {
        out.wrongStage.push({
          where, milestoneCode: m.milestoneCode, name: def.name,
          note: "the list says this happens before an order is confirmed",
        });
      }
      const facts = library.milestoneFacts(def);
      const differs = [];
      if (m.name && normalise(m.name) !== normalise(def.name)) {
        differs.push(`name "${m.name}" vs "${def.name}"`);
      }
      if (m.ownerDepartment && m.ownerDepartment !== facts.ownerDepartment) {
        differs.push(`owner ${m.ownerDepartment} vs ${facts.ownerDepartment}`);
      }
      if (m.completionAuthority && m.completionAuthority !== facts.completionAuthority) {
        differs.push(`completed by ${m.completionAuthority} vs ${facts.completionAuthority}`);
      }
      const had = [...(m.sourceEventKinds || [])].sort().join(",");
      const want = [...facts.sourceEventKinds].sort().join(",");
      if (had !== want) differs.push(`system action "${had || "none"}" vs "${want || "none"}"`);
      if (differs.length) out.disagrees.push({ where, milestoneCode: m.milestoneCode, differs });
    }
  }
  out.unused = definitions
    .filter((d) => d.isActive !== false && !selected.has(d.code))
    .map((d) => ({ milestoneCode: d.code, name: d.name, stage: d.stage }));

  return out;
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  line();
  line("T&A milestone list — reconciliation report (reads only, never writes)");
  say("database", mongoose.connection.name);
  line();

  const only = argOf("company-id");
  const companyIds = only
    ? [new mongoose.Types.ObjectId(only)]
    : await TnaTemplate.distinct("companyId");

  if (!companyIds.length) line("   No company holds a T&A template.");

  let clean = 0;
  for (const companyId of companyIds) {
    const r = await inspectCompany(companyId);
    const issues = r.notOnList.length + r.disagrees.length
      + r.wrongStage.length + r.duplicateMeaning.length + r.nearlyTheSame.length;

    line(`── company ${r.companyId}`);
    say("milestones on the list", `${r.library.active} active of ${r.library.held}`);
    say("plans already running", r.plans);

    if (!r.library.held) {
      say("", "The list is empty, so template steps are still shaped the old way.");
      say("", "Seed it: node scripts/readiness/seed-tna-starter.js --apply");
    }
    const block = (label, rows, fmt) => {
      if (!rows.length) return;
      line(`   ${label} (${rows.length})`);
      for (const row of rows) line(`      • ${fmt(row)}`);
    };
    block("NOT ON THE LIST — a person must decide whether to add it", r.notOnList,
      (x) => `${x.milestoneCode}${x.name ? ` "${x.name}"` : ""} — ${x.where}`);
    block("DISAGREES WITH THE LIST", r.disagrees,
      (x) => `${x.milestoneCode} — ${x.where}: ${x.differs.join("; ")}`);
    block("BEFORE THE ORDER EXISTS — asks for finished work again", r.wrongStage,
      (x) => `${x.milestoneCode} "${x.name}" — ${x.where}: ${x.note}`);
    block("TWO CODES, ONE NAME — ambiguous, nothing merged", r.duplicateMeaning,
      (x) => `${x.codes.join(" / ")} — ${x.names.map((n) => `"${n}"`).join(" and ")} `
        + `are one name ("${x.meaning}")`);
    block("NEARLY THE SAME — worth a person's eye, not refused", r.nearlyTheSame,
      (x) => `${x.codes.join(" / ")} — ${x.names.map((n) => `"${n}"`).join(" and ")}`);
    block("NOT CONNECTED YET", r.notIntegrated,
      (x) => `${x.milestoneCode} waits on ${x.owedBy}: ${x.waitingFor}`);
    block("ON THE LIST, NEVER SELECTED", r.unused,
      (x) => `${x.milestoneCode} "${x.name}" (${x.stage})`);

    if (!issues) { clean += 1; say("", "Every template step matches the list."); }
    line();
  }

  say("companies inspected", companyIds.length);
  say("companies needing no decision", clean);
  line();
  line("   Nothing was written. Every line above is a decision for a person.");
  line();
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { inspectCompany, normalise, loosely };
