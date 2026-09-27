"use strict";
/**
 * scripts/jev-routing/reportGenerate.js — Custom Report Builder scenarios for the
 * v2 dataset. Pure; called by generate.js.
 *
 * A report row's model input is { question, report_draft }. The draft carries
 * catalogue field ids and the period only — never an amount, a ledger value, a
 * company id or a company name — so Jev can tell "export this" with a draft
 * from "export this" with nothing to export, and nothing more.
 */

const schema = require("./schema/grav-acc-tools.v2.json");
const L = require("./lexicon");
const R = require("./reportLexicon");
const { proposeSpans } = require("./argumentCandidates");

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const FIELD_OPS = new Set(["add_rows", "add_columns", "add_value", "remove_field", "add_filter", "remove_filter", "set_sort", "set_calculation"]);
const phraseFor = (id, i) => R.FIELD_PHRASES[id][i % R.FIELD_PHRASES[id].length];

// ── cores ────────────────────────────────────────────────────────────────────
function expandReportCores() {
  const cores = [];
  const add = (family, frameId, text, gold, fr = {}) =>
    cores.push({ family, frameId, text, gold, tags: [...(fr.tags || [])], ood: Boolean(fr.ood), extra: { ...fr, report: true } });
  const fid = (fam, i, fr, k = "") => `${fam}:${i}${k}${fr.ood ? ":ood" : ""}`;

  R.DESCRIBE.forEach((fr, i) => add("report_describe", fid("rd", i, fr), fr.text, { route: "describe_report_capabilities" }, { ...fr, draft: "any" }));

  // new drafts: every combination of groupable fields and a money field, per frame
  R.DRAFT.forEach((fr, i) => {
    let k = 0;
    for (const a of R.GROUPABLE) for (const b of R.GROUPABLE) for (const m of R.MONEY_IDS) {
      if (a === b && (fr.text.includes("{F2}") || fr.text.includes("{F3}"))) continue;
      const needsB = fr.text.includes("{F2}");
      if (!needsB && b !== R.GROUPABLE[0]) continue;
      const u = fr.unavailable ? R.UNAVAILABLE[k % R.UNAVAILABLE.length] : null;
      const text = fr.text.replace("{F}", phraseFor(a, k)).replace("{F2}", phraseFor(b, k + 1)).replace("{M}", phraseFor(m, k)).replace("{U}", u || "");
      const includes = [a, m, ...(needsB ? [b] : [])];
      add("report_draft", fid("rdr", i, fr, `.${k}`), text, { route: "draft_custom_report", includes, unavailable: Boolean(fr.unavailable), period: fr.text.includes("{D}") ? "RENDER_REPORT" : "all_time" }, { ...fr, draft: "none" });
      k += 1;
    }
  });
  R.DRAFT_FIXED.forEach((fr, i) =>
    add("report_draft", fid("rdf", i, fr), fr.text, { route: "draft_custom_report", includes: fr.includes, unavailable: Boolean(fr.unavailable), period: "all_time" }, { ...fr, draft: "none" }));

  // modifications
  for (const [op, frames] of Object.entries(R.MODIFY).concat(Object.entries(R.MODIFY_OOD).map(([o, fs]) => [o, fs]))) {
    frames.forEach((fr, i) => {
      const base = { route: "modify_report_draft", report_operation: op };
      const idp = `rm.${op}`;
      if (fr.text.includes("{F}")) {
        const pool = op === "add_columns" ? R.COLUMNABLE.filter((x) => !R.MONEY_IDS.includes(x)) : [...R.IDS].filter((x) => !R.MONEY_IDS.includes(x));
        pool.forEach((id, k) => add(`report_modify`, fid(idp, i, fr, `.${k}`), fr.text.replace("{F}", phraseFor(id, k)), { ...base, report_field: id, ...opArgs(op, fr) }, { ...fr, draft: needsDraftShape(op, id) }));
      } else if (fr.text.includes("{M}")) {
        R.MONEY_IDS.forEach((id, k) => {
          if (fr.text.includes("{CALC}")) {
            R.CALC_WORDS.forEach(([word, calc], c) => {
              if (op === "set_calculation" && calc === "total") return;
              add(`report_modify`, fid(idp, i, fr, `.${k}.${c}`), fr.text.replace("{M}", phraseFor(id, k + c)).replace("{CALC}", word), { ...base, report_field: id, report_calculation: calc, ...opArgs(op, fr) }, { ...fr, draft: needsDraftShape(op, id) });
            });
          } else {
            add(`report_modify`, fid(idp, i, fr, `.${k}`), fr.text.replace("{M}", phraseFor(id, k)), { ...base, report_field: id, ...opArgs(op, fr) }, { ...fr, draft: needsDraftShape(op, id) });
          }
        });
      } else if (fr.text.includes("{U}")) {
        R.UNAVAILABLE.forEach((u, k) => add(`report_modify`, fid(idp, i, fr, `.${k}`), fr.text.replace("{U}", u), { ...base, report_field: "unavailable_field" }, { ...fr, draft: "some" }));
      } else {
        const field = op === "unavailable_capability" ? fr.field : fr.field || null;
        add(`report_modify`, fid(idp, i, fr), fr.text, { ...base, ...(field ? { report_field: field } : {}), ...opArgs(op, fr) }, { ...fr, draft: fr.field && op === "add_filter" ? { notFilter: fr.field } : "some" });
      }
    });
  }

  const simple = (list, family, prefix, route, extraGold = () => ({})) =>
    list.forEach((fr, i) => add(family, fid(prefix, i, fr), fr.text, { route, ...extraGold(fr) }, { ...fr, draft: "some" }));
  simple(R.VALIDATE, "report_validate", "rv", "validate_report_draft");
  simple(R.PREVIEW, "report_preview", "rp", "preview_custom_report", (fr) => ({ period: fr.period || "as_in_draft" }));
  simple(R.SAVE, "report_save", "rs", "save_custom_report", (fr) => ({ report_name: fr.name || "NAME" }));
  simple(R.EXPORT, "report_export", "rx", "export_report");

  // commands that need a draft, with none → clarify
  R.NO_DRAFT_COMMANDS.forEach((text, i) => {
    const ids = text.includes("{F}") ? [...R.IDS].filter((x) => !R.MONEY_IDS.includes(x)).slice(0, 6) : text.includes("{M}") ? R.MONEY_IDS : [null];
    ids.forEach((id, k) => add("report_clarify", `rcn:${i}.${k}`, text.replace("{F}", id ? phraseFor(id, k) : "").replace("{M}", id ? phraseFor(id, k) : ""), { route: "clarify", reason: "no_current_draft" }, { draft: "none", tags: ["grav_expected:ask_for_report_first"] }));
  });
  R.REPORT_VAGUE.forEach((fr, i) => add("report_clarify", fid("rcv", i, fr), fr.text, { route: "clarify", reason: fr.needsDraft ? "unclear_period" : "vague_report" }, { ...fr, draft: fr.needsDraft ? "some" : "none" }));
  R.REPORT_ANALYTICAL.forEach((fr, i) => add("report_analytical", fid("ra", i, fr), fr.text, { route: "unsupported", reason: "analytical_out_of_lane" }, { ...fr, draft: fr.needsDraft ? "some" : "any", tags: [...(fr.tags || []), "escalate_to_reasoning_model"] }));
  for (const [reason, frames] of Object.entries(R.REPORT_REFUSE)) {
    frames.forEach((fr, i) => add(`report_refuse_${reason}`, fid(`rr_${reason}`, i, fr), fr.text, { route: "unsupported", reason }, { ...fr, draft: fr.needsDraft ? "some" : "any" }));
  }
  return cores;
}

function opArgs(op, fr) {
  const a = {};
  if (op === "add_filter") a.filter_operator = fr.operator;
  if (op === "set_period") a.period = fr.period;
  if (op === "set_sort") a.sort_direction = fr.direction;
  if (op === "add_comparison") a.comparison_mode = fr.mode;
  if (op === "add_filter" && fr.field) a.report_field = fr.field;
  return a;
}
/** What the draft must look like for the command to make sense. */
function needsDraftShape(op, id) {
  if (["remove_field", "set_sort"].includes(op)) return { has: id };
  if (op === "set_calculation") return { hasValue: id };
  if (op === "remove_filter") return { hasFilter: id };
  if (["add_rows", "add_columns", "add_value"].includes(op)) return { lacks: id };
  if (op === "add_filter") return { notFilter: id };
  return "some";
}

// ── drafts in state ──────────────────────────────────────────────────────────
function randomDraft(rng, shape) {
  const groupable = R.GROUPABLE;
  const rows = [pick(rng, groupable)];
  if (rng() < 0.4) {
    const b = pick(rng, groupable);
    if (!rows.includes(b)) rows.push(b);
  }
  const columns = rng() < 0.35 ? [pick(rng, R.COLUMNABLE.filter((x) => !R.MONEY_IDS.includes(x) && !rows.includes(x)))] : [];
  const values = [{ field: pick(rng, R.MONEY_IDS), calculation: "total" }];
  const filters = rng() < 0.4 ? [{ field: "voucher.type", operation: "is" }] : [];
  const draft = { rows, columns, values, filters, period: pick(rng, ["all_time", "this_financial_year", "last_month", "named_month", "this_calendar_year"]), name: null };
  if (shape && typeof shape === "object") {
    const id = shape.has || shape.hasValue || shape.hasFilter || shape.lacks || shape.notFilter;
    const strip = (d) => {
      d.rows = d.rows.filter((x) => x !== id);
      d.columns = d.columns.filter((x) => x !== id);
      d.values = d.values.filter((v) => v.field !== id);
      d.filters = d.filters.filter((x) => x.field !== id);
    };
    if (shape.has) {
      if (R.MONEY_IDS.includes(id)) { if (!draft.values.some((v) => v.field === id)) draft.values.push({ field: id, calculation: "total" }); }
      else if (!draft.rows.includes(id) && !draft.columns.includes(id)) draft.rows.push(id);
    }
    if (shape.hasValue && !draft.values.some((v) => v.field === id)) draft.values.push({ field: id, calculation: "total" });
    if (shape.hasFilter && !draft.filters.some((x) => x.field === id)) draft.filters.push({ field: id, operation: R.TYPE_OF[id] === "date" ? "between" : R.TYPE_OF[id] === "choice" ? "is" : "contains" });
    if (shape.lacks) strip(draft);
    if (shape.notFilter) draft.filters = draft.filters.filter((x) => x.field !== id);
    if (!draft.rows.length) draft.rows.push(groupable.find((x) => x !== id));
    if (!draft.values.length) draft.values.push({ field: R.MONEY_IDS.find((x) => x !== id), calculation: "total" });
  }
  // A third of drafts are the result of an earlier edit in the same conversation.
  if (rng() < 0.33) draft.name = null;
  return draft;
}

// ── rendering helpers used by generate.js ────────────────────────────────────
function fillReportSlots(rng, text) {
  const vt = pick(rng, L.VOUCHER_TYPES.filter(([, t]) => t !== "all_types"))[0];
  return text
    .replace(/\{AMT\}/g, pick(rng, R.AMOUNTS))
    .replace(/\{NAME\}/g, pick(rng, R.REPORT_NAMES))
    .replace(/\{W\}/g, pick(rng, R.WORDS))
    .replace(/\{VT\}/g, vt)
    .replace(/\{D\}/g, "RPERIOD");
}

function reportPeriod(rng) {
  return pick(rng, R.REPORT_PERIODS);
}

function applyReportTypos(rng, text) {
  const words = text.split(" ");
  const idx = words.map((w, i) => [w, i]).filter(([w]) => R.REPORT_TYPOS[w.toLowerCase()]);
  if (!idx.length) return { text, typo: false };
  const [w, i] = pick(rng, idx);
  words[i] = pick(rng, R.REPORT_TYPOS[w.toLowerCase()]);
  return { text: words.join(" "), typo: true };
}

/** The gold name span for a save command, or "none". */
function nameGold(text, name) {
  if (name === "none") return "none";
  const spans = proposeSpans(text);
  const hit = spans.find((s) => s.toLowerCase() === name.toLowerCase());
  return hit ? `text: ${hit}` : "UNREACHABLE";
}

// ── argument questions for report tools ──────────────────────────────────────
const RA = schema.report_arguments;
const fieldOptions = () => [
  ...[...R.IDS].map((id) => ({ name: id, description: `${R.LABEL_OF[id]} (${R.TYPE_OF[id]})` })),
  { name: "unavailable_field", description: "a column the report builder does not have" },
];
const enumOptions = (spec) => Object.entries(spec.options).map(([name, description]) => ({ name, description }));
function periodOptions(withDraftOption) {
  return Object.entries(schema.arguments.period.options)
    .filter(([k]) => withDraftOption || k !== "as_in_draft")
    .map(([name, description]) => ({ name, description }));
}

/**
 * Argument questions for one rendered report command. Each entry:
 *   { id, kind: "choice"|"noul", instructions, options?, gold }
 */
function reportArgumentQuestions(gold, text) {
  const q = [];
  if (gold.route === "draft_custom_report") {
    for (const id of R.IDS) {
      q.push({ id: `report_includes:${id}`, kind: "noul", instructions: RA.report_includes.instructions.replace("{label}", R.LABEL_OF[id]).replace("{id}", id), gold: gold.includes.includes(id) ? "yes" : "no" });
    }
    q.push({ id: "report_includes:unavailable", kind: "noul", instructions: RA.report_includes.unavailable_instructions, gold: gold.unavailable ? "yes" : "no" });
    q.push({ id: "period", kind: "choice", instructions: schema.arguments.period.instructions, options: periodOptions(false), gold: gold.period });
  }
  if (gold.route === "modify_report_draft") {
    q.push({ id: "report_operation", kind: "choice", instructions: RA.report_operation.instructions, options: enumOptions(RA.report_operation), gold: gold.report_operation });
    if (gold.report_field) q.push({ id: "report_field", kind: "choice", instructions: RA.report_field.instructions, options: fieldOptions(), gold: gold.report_field });
    if (gold.report_calculation) q.push({ id: "report_calculation", kind: "choice", instructions: RA.report_calculation.instructions, options: enumOptions(RA.report_calculation), gold: gold.report_calculation });
    if (gold.filter_operator) q.push({ id: "filter_operator", kind: "choice", instructions: RA.filter_operator.instructions, options: enumOptions(RA.filter_operator), gold: gold.filter_operator });
    if (gold.report_operation === "set_period") q.push({ id: "period", kind: "choice", instructions: schema.arguments.period.instructions, options: periodOptions(false), gold: gold.period });
    if (gold.sort_direction) q.push({ id: "sort_direction", kind: "choice", instructions: RA.sort_direction.instructions, options: enumOptions(RA.sort_direction), gold: gold.sort_direction });
    if (gold.comparison_mode) q.push({ id: "comparison_mode", kind: "choice", instructions: RA.comparison_mode.instructions, options: enumOptions(RA.comparison_mode), gold: gold.comparison_mode });
  }
  if (gold.route === "preview_custom_report") {
    q.push({ id: "period", kind: "choice", instructions: schema.arguments.period.instructions, options: periodOptions(true), gold: gold.period });
  }
  if (gold.route === "save_custom_report") {
    const spans = proposeSpans(text).map((s) => ({ name: `text: ${s}`, description: null }));
    q.push({ id: "report_name", kind: "choice", instructions: RA.report_name.instructions, options: [...spans, { name: "none", description: "no name is given" }], gold: gold.report_name });
  }
  return q;
}

module.exports = { expandReportCores, randomDraft, fillReportSlots, reportPeriod, applyReportTypos, nameGold, reportArgumentQuestions, FIELD_OPS };
