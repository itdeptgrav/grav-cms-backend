"use strict";
/**
 * scripts/jev-routing/audit.js — checks that fail the dataset build.
 *
 * Every check runs over the rows actually written, not over the generator's
 * intentions. A failure makes generate.js exit non-zero and marks the
 * manifest `audit_passed: false`; the trainer refuses such a manifest.
 *
 *   isolation     a group, a question text, a party stem or an OOD frame never
 *                 appears in two splits
 *   near-dup      no locked row is ≥ NEAR_DUP_FAIL similar (entity/date masked,
 *                 character trigrams) to any row a trainer can read
 *   frozen        no training-view row repeats or near-repeats the existing
 *                 Accounts/HR pilot evaluation questions or names their fixtures
 *   allowlist     every route option is a schema tool or control; every gold is
 *                 an offered option; every argument gold is a GRAV-proposed option
 *   privacy       no e-mail, phone, GSTIN, PAN, Aadhaar-like number, ObjectId,
 *                 URL or figure of five or more digits in any row
 *   balance       every route label is present in every split and no label
 *                 dominates training
 *   coverage      every required family and tag is present
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const schema = require("./schema/grav-acc-tools.v2.json");

const NEAR_DUP_FAIL = 0.9;
const TRAINABLE = new Set(["train", "calibration", "validation"]);
const LOCKED = new Set(["test", "ood"]);
const REQUIRED_FIELDS = ["id", "group_id", "split", "source", "state", "question", "kind", "options", "target", "metadata"].sort();

const ALLOWED_ROUTE = new Set([...schema.tools.map((t) => t.name), ...schema.report_tools.map((t) => t.name), "clarify", "unsupported"]);
const catalogue = require("../../services/reporting/fieldCatalogue");
const REPORT_FIELD_OPTIONS = new Set([...catalogue.fieldIds(), "unavailable_field"]);
const ROUTE_LABELS = [...ALLOWED_ROUTE];

const REQUIRED_FAMILIES = [
  "ledger_party", "ledger_group", "vouchers", "financials", "company", "overdue",
  "clarify_missing", "clarify_multitype", "clarify_period", "clarify_multi_intent",
  "unsupported_write_request", "unsupported_non_accounting", "unsupported_cross_company",
  "unsupported_prompt_injection", "unsupported_injection_combo", "unsupported_unsupported_report",
  "unsupported_unsupported_period", "unsupported_analytical_out_of_lane", "user_examples",
  "report_describe", "report_draft", "report_modify", "report_validate", "report_preview", "report_save", "report_export",
  "report_clarify", "report_analytical", "report_refuse_prompt_injection", "report_refuse_cross_company",
  "report_refuse_write_request", "report_refuse_report_operation_unavailable",
];
const REQUIRED_TAGS = ["malformed_argument", "misspelled_name", "typo", "multi_intent", "missing_date", "short_name", "style", "prompt_injection", "multi_turn", "report", "user_example", "duplicate_ledger_name", "no_exclusion_operator", "shorthand", "grav_expected"];

const PRIVACY = [
  ["email", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["url", /\bhttps?:\/\/|\bwww\./i],
  ["gstin", /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/],
  ["pan", /\b[A-Z]{5}\d{4}[A-Z]\b/],
  ["phone", /(?<![\d-])(?:\+91[\s-]?)?[6-9]\d{9}(?!\d)/],
  ["aadhaar_like", /\b\d{4}\s?\d{4}\s?\d{4}\b/],
  ["object_id", /\b[0-9a-f]{24}\b/i],
  // five or more consecutive digits that are not part of a date (dates are ≤4-digit runs)
  ["large_figure", /(?<![\d/-])\d{5,}(?![\d/-])|\b\d{1,3}(?:,\d{2,3}){2,}\b/],
];

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}&]+/gu, " ").trim();
function trigrams(s) {
  const t = ` ${norm(s)} `;
  const out = new Set();
  for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
  return out;
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}
function maskRow(row, stems) {
  let s = row.state.question;
  for (const st of stems) s = s.replace(new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "ENT");
  return s.replace(/\d+/g, "NUM");
}

function frozen() {
  const root = path.join(__dirname, "..", "open-jev-pilot");
  const cases = JSON.parse(fs.readFileSync(path.join(root, "accounts-cases.json"), "utf8")).cases.map((c) => c.question);
  const held = JSON.parse(fs.readFileSync(path.join(root, "heldout-cases.json"), "utf8")).cases.map((c) => c.message);
  const src = fs.readFileSync(path.join(root, "accounts-fixtures.js"), "utf8");
  const names = [...src.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]).concat(["Thornfield Mills"]);
  let q = [...cases, ...held];
  for (const n of names.slice().sort((a, b) => b.length - a.length)) q = q.map((x) => x.split(n).join("ENT"));
  return { questions: q, names };
}

/**
 * Stems that also occur in a tracked file of this repository outside the
 * dataset package — a cheap guard against an invented name colliding with one
 * that already exists in seeds, fixtures or docs. It cannot see production
 * data, which is deliberately never read.
 */
function repoCollisions(stems) {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: __dirname, encoding: "utf8" }).trim();
    const out = execFileSync("git", ["grep", "-I", "-i", "-w", "-o", "-h", ...stems.flatMap((s) => ["-e", s]), "--", ".", ":!scripts/jev-routing", ":!docs/decisions/jev-tool-routing-training.md", ":!docs/audits/jev-routing-*", ":!test/hr-ai/jevRouting*", ":!docs/handoff/latest-implementation.md"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return [...new Set(out.split("\n").filter(Boolean).map((s) => s.toLowerCase()))];
  } catch (err) {
    if (err.status === 1) return []; // git grep: no match
    return null; // git unavailable — reported, not silently passed
  }
}

function runAudit(rows, { pools } = {}) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const report = {};

  // schema
  for (const r of rows) {
    const keys = Object.keys(r).sort();
    if (JSON.stringify(keys) !== JSON.stringify(REQUIRED_FIELDS)) { fail(`${r.id}: fields ${keys}`); break; }
    if (r.kind !== "choice" && r.kind !== "noul") fail(`${r.id}: kind ${r.kind}`);
    if (r.kind === "noul" && JSON.stringify(r.options) !== '["no","yes"]') fail(`${r.id}: noul options must be ["no","yes"]`);
    if (new Set(r.options).size !== r.options.length) fail(`${r.id}: duplicate option`);
    if (r.target.length !== r.options.length || r.target.reduce((a, b) => a + b, 0) !== 1) fail(`${r.id}: target not one-hot`);
  }

  // isolation
  const splitOf = { group: new Map(), text: new Map(), stem: new Map(), template: new Map() };
  const ids = new Set();
  for (const r of rows) {
    if (ids.has(r.id)) fail(`duplicate id ${r.id}`);
    ids.add(r.id);
    const checks = [["group", r.group_id], ["text", norm(r.state.question)], ...r.metadata.entity_ids.map((e) => ["stem", e.toLowerCase()])];
    for (const [k, v] of checks) {
      const seen = splitOf[k].get(v);
      if (seen && seen !== r.split) fail(`${k} "${v.slice(0, 60)}" in ${seen} and ${r.split}`);
      splitOf[k].set(v, r.split);
    }
    const t = r.metadata.template_id;
    const isOodSplit = r.split === "ood";
    const prev = splitOf.template.get(t);
    if (prev !== undefined && prev !== isOodSplit) fail(`template ${t} in both OOD and in-distribution splits`);
    splitOf.template.set(t, isOodSplit);
  }
  if (pools) {
    const owner = new Map();
    for (const [split, list] of Object.entries(pools)) for (const s of list) {
      if (owner.has(s)) fail(`stem ${s} in pools ${owner.get(s)} and ${split}`);
      owner.set(s, split);
    }
  }

  // allowlist and argument golds
  let routeRows = 0;
  for (const r of rows) {
    const g = r.metadata.grav;
    const names = g.candidates.map((c) => c.name);
    if (!names.includes(g.gold)) fail(`${r.id}: gold not offered`);
    if (g.question_id === "route") {
      routeRows += 1;
      for (const n of names) if (!ALLOWED_ROUTE.has(n)) fail(`${r.id}: route option ${n} outside the schema allowlist`);
      if (!names.includes("clarify") || !names.includes("unsupported")) fail(`${r.id}: controls not offered`);
    } else if (r.kind === "noul") {
      if (!g.question_id.startsWith("report_includes:")) fail(`${r.id}: unexpected noul question ${g.question_id}`);
      const id = g.question_id.slice("report_includes:".length);
      if (id !== "unavailable" && !REPORT_FIELD_OPTIONS.has(id)) fail(`${r.id}: noul about a field the catalogue lacks: ${id}`);
    } else if (g.question_id === "account" || g.question_id === "report_name") {
      for (const n of names) {
        if (n.startsWith("text: ")) {
          const span = n.slice(6).toLowerCase();
          if (!r.state.question.toLowerCase().includes(span.split(" ")[0])) fail(`${r.id}: span option not copied from the question: ${n}`);
        }
      }
    } else if (g.question_id === "report_field") {
      for (const n of names) if (!REPORT_FIELD_OPTIONS.has(n)) fail(`${r.id}: report_field option ${n} is not a catalogue field`);
      if (names.length !== REPORT_FIELD_OPTIONS.size) fail(`${r.id}: report_field must offer every catalogue field`);
    } else {
      const spec = schema.arguments[g.question_id] || schema.report_arguments[g.question_id];
      if (!spec) fail(`${r.id}: unknown argument ${g.question_id}`);
      else for (const n of names) if (!(n in spec.options)) fail(`${r.id}: option ${n} outside ${g.question_id} enum`);
    }
    if (r.state.report_draft) {
      const d = r.state.report_draft;
      for (const id of [...d.rows, ...d.columns, ...d.values.map((v) => v.field), ...d.filters.map((x) => x.field)]) {
        if (!REPORT_FIELD_OPTIONS.has(id) || id === "unavailable_field") fail(`${r.id}: draft uses a non-catalogue field ${id}`);
      }
      if (JSON.stringify(d).match(/\d{3,}/)) fail(`${r.id}: a draft in model input carries a figure`);
    }
  }

  // near-duplicates: locked vs anything a trainer can read
  const stems = [...splitOf.stem.keys()];
  const trainTexts = new Map();
  const lockedTexts = new Map();
  for (const r of rows) {
    const m = maskRow(r, r.metadata.entity_ids);
    (TRAINABLE.has(r.split) ? trainTexts : lockedTexts).set(norm(r.state.question), { masked: m, split: r.split });
  }
  const trainGrams = [...trainTexts.values()].map((v) => trigrams(v.masked));
  const maxima = [];
  const worst = [];
  for (const [text, v] of lockedTexts) {
    const g = trigrams(v.masked);
    let best = 0;
    for (const tg of trainGrams) {
      const j = jaccard(g, tg);
      if (j > best) best = j;
      if (best >= 0.999) break;
    }
    maxima.push(best);
    worst.push([best, text, v.split]);
    if (best >= NEAR_DUP_FAIL) fail(`near-duplicate (${best.toFixed(3)}) locked ${v.split} row leaks from training view: "${text.slice(0, 80)}"`);
  }
  maxima.sort((a, b) => a - b);
  const q = (p) => (maxima.length ? maxima[Math.min(maxima.length - 1, Math.floor(p * maxima.length))] : 0);
  report.near_duplicate = {
    metric: "max character-trigram Jaccard of each locked question (entity names and digits masked) against every training-view question",
    fail_threshold: NEAR_DUP_FAIL,
    locked_unique_questions: maxima.length,
    p50: q(0.5), p90: q(0.9), p99: q(0.99), max: maxima[maxima.length - 1] || 0,
    at_or_above_0_8: maxima.filter((x) => x >= 0.8).length,
    closest_examples: worst.sort((a, b) => b[0] - a[0]).slice(0, 8).map(([j, t, s]) => ({ jaccard: Number(j.toFixed(3)), split: s, question: t })),
  };

  // frozen evaluation material
  const fz = frozen();
  const fzGrams = fz.questions.map(trigrams);
  let frozenMax = 0;
  for (const r of rows) {
    if (!TRAINABLE.has(r.split)) continue;
    const q0 = r.state.question;
    for (const n of fz.names) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q0)) fail(`${r.id}: frozen fixture name "${n}" in a trainable row`);
    if (fz.questions.some((fq) => norm(fq) === norm(q0))) fail(`${r.id}: frozen evaluation question in a trainable row`);
  }
  for (const [, v] of trainTexts) {
    const g = trigrams(v.masked);
    for (const fg of fzGrams) frozenMax = Math.max(frozenMax, jaccard(g, fg));
  }
  if (frozenMax >= 0.9) fail(`a trainable row is ${frozenMax.toFixed(3)} similar to a frozen evaluation question`);
  report.frozen_evaluation = { questions_checked: fz.questions.length, fixture_names_checked: fz.names.length, max_similarity_of_trainable_row: Number(frozenMax.toFixed(3)) };

  // privacy
  const privacyHits = [];
  for (const r of rows) {
    const blob = [r.state.question, ...r.options].join(" \n ");
    for (const [name, rx] of PRIVACY) if (rx.test(blob)) privacyHits.push({ id: r.id, rule: name });
  }
  for (const h of privacyHits.slice(0, 20)) fail(`privacy rule ${h.rule} matched in ${h.id}`);
  const collisions = repoCollisions(stems.filter((s) => s !== "ariel"));
  if (collisions === null) report.repo_name_collisions = "not checked: git unavailable";
  else {
    report.repo_name_collisions = collisions;
    for (const c of collisions) fail(`synthetic stem "${c}" also appears in a tracked repository file`);
  }
  report.privacy = { rules: PRIVACY.map(([n]) => n), hits: privacyHits.length, rows_scanned: rows.length };

  // balance and coverage
  const labels = {};
  const fams = new Set();
  const tags = new Set();
  for (const r of rows) {
    const g = r.metadata.grav;
    fams.add(g.family);
    for (const t of g.tags || []) tags.add(t.split(":")[0]);
    if (g.reason === "tool_not_offered") tags.add("tool_not_offered");
    if (g.question_id !== "route") continue;
    const m = (labels[r.split] = labels[r.split] || {});
    m[g.gold] = (m[g.gold] || 0) + 1;
  }
  for (const split of ["train", "calibration", "validation", "test", "ood"]) {
    const m = labels[split] || {};
    const total = Object.values(m).reduce((a, b) => a + b, 0);
    for (const l of ROUTE_LABELS) if (!m[l]) fail(`route label ${l} absent from ${split}`);
    if (split === "train") for (const [l, n] of Object.entries(m)) {
      const share = n / total;
      if (share < 0.01 || share > 0.35) fail(`train route label ${l} share ${share.toFixed(3)} outside [0.01, 0.35]`);
    }
  }
  for (const fam of REQUIRED_FAMILIES) if (!fams.has(fam)) fail(`family ${fam} missing`);
  for (const t of [...REQUIRED_TAGS, "tool_not_offered", "near_boundary"]) if (!tags.has(t)) fail(`tag ${t} missing`);
  report.route_labels_by_split = labels;
  report.route_rows = routeRows;

  return { passed: failures.length === 0, failures: failures.slice(0, 50), failure_count: failures.length, report };
}

module.exports = { runAudit, NEAR_DUP_FAIL, PRIVACY, ALLOWED_ROUTE };
