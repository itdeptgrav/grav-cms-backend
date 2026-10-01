"use strict";
/**
 * scripts/jev-routing/generate.js — build the GRAV accounting-routing dataset.
 *
 *   node scripts/jev-routing/generate.js [--out=tmp/jev-routing/data/grav-acc-routing-v1] [--seed=20260925]
 *
 * Deterministic: the same seed and the same source files produce byte-identical
 * output. No database is opened and nothing is read from GRAV's records — the
 * only GRAV code loaded is the tool registry, so the candidate descriptions in
 * every row are the exact strings the runtime sends to Jev.
 *
 * HOW NEAR-DUPLICATES ARE KEPT OUT OF THE LOCKED SETS
 *   1. A scenario ("core") is one sentence frame with its scenario slots filled
 *      (voucher type, account group, party side). Entities, dates and periods
 *      are filled later, per rendering, so every paraphrase and every name
 *      variant of one scenario shares one core.
 *   2. Cores whose entity-masked text is ≥ CLUSTER_JACCARD similar (character
 *      trigrams) are unioned into one group. A group is assigned to exactly one
 *      split by a hash of its key — never row by row.
 *   3. OOD frames and OOD rendering styles appear only in locked_ood; party
 *      names are drawn from per-split pools that never overlap.
 *   4. audit.js re-checks all of this on the written rows and fails the build.
 *
 * OUTPUT LAYOUT (Open-Jev row schema, jev/data.py REQUIRED fields)
 *   <out>/train-view/{train,calibration,validation}.jsonl + manifest.json   ← the ONLY directory training may read
 *   <out>/locked/{test,ood}.jsonl + manifest.json                          ← evaluation only
 *   <out>/manifest.json, stats.json, audit.json
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("./schema/grav-acc-tools.v2.json");
const L = require("./lexicon");
const { proposeSpans, argumentOptions, renderOption, tokens } = require("./argumentCandidates");
const RG = require("./reportGenerate");
const RL = require("./reportLexicon");

const GENERATOR_VERSION = "grav-acc-routing-v2";
const DEFAULT_SEED = 20260925;
const CLUSTER_JACCARD = 0.8;
/** A scenario this close to a user example or a frozen pilot question is never trained on. */
const PROTECT_JACCARD = 0.8;
const USER_EXAMPLE_FRAMES = [
  "ledger balance of {P}", "{P} ka balance?", "what does {P} owe us?",
  // the Custom Report Builder examples, verbatim from the request
  "Create an overdue receivables report grouped by salesperson.", "Show invoice value, receipts, balance and overdue days.",
  "Only include balances over ₹{AMT}.", "Use this financial year, not calendar year.", "Add gross margin percentage.",
  "Remove cancelled invoices.", "Turn this into a monthly chart.", "Save it as Monthly Collection Review.",
  "Run the report for April.", "Export this report.", "Why is cash tight despite higher sales?",
];

// ── deterministic helpers ────────────────────────────────────────────────────
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
function rngFor(...key) {
  let s = parseInt(sha(key).slice(0, 8), 16) >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function shuffled(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
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
/** Replace entity/date/number placeholders with one neutral token each. */
const maskSlots = (text) =>
  text
    .replace(/\{Ps2?\}|\{P\}/g, "ENT")
    .replace(/\{X\}/g, "ORG")
    .replace(/\{D\}/g, "PER")
    .replace(/\{(DATE1|DATE2|BADDATE|MONTH|YEAR|N|AMT)\}/g, "NUM")
    .replace(/\{(NAME|W|VT)\}/g, "ENT")
    .replace(/\s+/g, " ")
    .trim();

// ── splits ───────────────────────────────────────────────────────────────────
const SPLIT_BOUNDS = [
  [0.7, "train"],
  [0.79, "calibration"],
  [0.88, "validation"],
  [1.0, "test"],
];
function hashSplit(seed, key) {
  const u = parseInt(sha([seed, "split", key]).slice(0, 12), 16) / 2 ** 48;
  return SPLIT_BOUNDS.find(([b]) => u < b)[1];
}
const SPLIT_FILE = { train: "train-view", calibration: "train-view", validation: "train-view", test: "locked", ood: "locked" };

// ── names: disjoint pools per split ──────────────────────────────────────────
function buildNamePools(seed) {
  const stems = [];
  for (const a of L.SYL_A) for (const b of L.SYL_B) stems.push(a + b);
  const pools = { train: [], calibration: [], validation: [], test: [...L.RESERVED_LOCKED_STEMS], ood: [] };
  const bounds = [[0.62, "train"], [0.7, "calibration"], [0.78, "validation"], [0.9, "test"], [1.0, "ood"]];
  for (const stem of stems) {
    const u = parseInt(sha([seed, "stem", stem]).slice(0, 12), 16) / 2 ** 48;
    pools[bounds.find(([b]) => u < b)[1]].push(stem);
  }
  return pools;
}

function partyFor(rng, stem, split) {
  const biz = pick(rng, L.BUSINESS);
  const shapes = [
    () => `${stem} ${biz}`,
    () => `${stem} ${biz}`,
    () => stem,
    () => `${stem} & Sons`,
    () => `M/s ${stem} ${biz}`,
    () => `${stem} ${biz} Pvt Ltd`,
  ];
  // OOD names use shapes the other splits rarely see.
  const oodShapes = [() => `${stem} ${biz} LLP`, () => `${stem} Bros`, () => `${stem}-${pick(rng, L.SYL_B)} ${biz}`];
  const full = split === "ood" && rng() < 0.5 ? pick(rng, oodShapes)() : pick(rng, shapes)();
  return { full, short: stem };
}
function misspell(rng, word) {
  if (word.length < 5) return word + word.slice(-1);
  const i = 1 + Math.floor(rng() * (word.length - 2));
  return rng() < 0.5 ? word.slice(0, i) + word[i] + word.slice(i) : word.slice(0, i) + word.slice(i + 1);
}

// ── dates ────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateText(rng, y, m, d) {
  const style = Math.floor(rng() * 3);
  if (style === 0) return `${y}-${pad(m)}-${pad(d)}`;
  if (style === 1) return `${d} ${MON3[m - 1]} ${y}`;
  return `${pad(d)}/${pad(m)}/${y}`;
}
function datePair(rng) {
  const y = 2025 + Math.floor(rng() * 2);
  const m = 1 + Math.floor(rng() * 12);
  const d1 = 1 + Math.floor(rng() * 14);
  const d2 = d1 + 1 + Math.floor(rng() * 13);
  return [dateText(rng, y, m, d1), dateText(rng, y, m, d2)];
}
function badDate(rng) {
  const y = 2025 + Math.floor(rng() * 2);
  return pick(rng, [`${y}-02-30`, `${y}-13-01`, `${y}-04-31`, `31/02/${y}`, `${y}-00-10`]);
}

// ── candidate descriptions: the runtime's exact strings ──────────────────────
function runtimeRouteDescriptions() {
  require("../../services/ai/tools/accountingTools");
  const { accountsCandidates } = require("../../services/ai/openJev/accountsCandidates");
  const { candidates } = accountsCandidates({ id: "dataset-generator", accountingAccess: { allowed: true } });
  const proposed = schema.tools.filter((t) => t.status === "proposed");
  const all = { ...candidates };
  for (const t of proposed) all[t.name] = t.description;
  for (const t of schema.report_tools) all[t.name] = t.description;
  return all;
}

// ── core expansion ───────────────────────────────────────────────────────────
function expandCores() {
  const cores = [];
  const add = (family, frameId, text, gold, extra = {}) =>
    cores.push({ family, frameId, text, gold, tags: extra.tags || [], ood: Boolean(extra.ood), extra });
  const fid = (fam, i, fr) => `${fam}:${i}${fr.ood ? ":ood" : ""}`;

  L.LEDGER_PARTY.forEach((fr, i) =>
    add("ledger_party", fid("lp", i, fr), fr.text, { route: "acc_ledger_balance", account: fr.text.includes("{Ps}") ? "Ps" : "P" }, fr));
  L.LEDGER_GROUP.forEach((fr, i) =>
    L.GROUPS.forEach(([phrase, group]) =>
      add("ledger_group", fid("lg", i, fr), fr.text.replace("{G}", phrase), { route: "acc_ledger_balance", account: `group: ${group}` }, fr)));
  L.LEDGER_GROUP_FIXED.forEach((fr, i) =>
    add("ledger_group", fid("lgf", i, fr), fr.text, { route: "acc_ledger_balance", account: fr.account }, fr));

  L.VOUCHERS.forEach((fr, i) =>
    L.VOUCHER_TYPES.forEach(([phrase, type]) =>
      add("vouchers", fid("v", i, fr), fr.text.replace("{T}", phrase),
        { route: "acc_vouchers", voucher_type: type, period: fr.period || "RENDER" }, fr)));

  L.FINANCIALS.forEach((fr, i) => add("financials", fid("fin", i, fr), fr.text, { route: "acc_financials" }, fr));
  L.COMPANY.forEach((fr, i) => add("company", fid("co", i, fr), fr.text, { route: "acc_company" }, fr));

  L.OVERDUE.forEach((fr, i) =>
    L.SIDES.forEach(([phrase, side]) =>
      add("overdue", fid("od", i, fr), fr.text.replace("{S}", phrase), { route: "acc_overdue_bills", party_side: side, account: "none" }, fr)));
  L.OVERDUE_FIXED.forEach((fr, i) =>
    add("overdue", fid("odf", i, fr), fr.text, { route: "acc_overdue_bills", party_side: fr.side, account: fr.account || "none" }, fr));

  L.CLARIFY_NOENTITY.forEach((fr, i) => add("clarify_missing", fid("cm", i, fr), fr.text, { route: "clarify", reason: "missing_account" }, fr));
  L.CLARIFY_MULTITYPE.forEach((fr, i) =>
    L.MULTI_TYPES.forEach((m) =>
      add("clarify_multitype", fid("cmt", i, fr), fr.text.replace("{M}", m), { route: "clarify", reason: "multiple_voucher_types", period: "RENDER" }, fr)));
  L.CLARIFY_UNCLEAR_FRAMES.forEach((text, i) =>
    L.VOUCHER_TYPES.forEach(([phrase]) =>
      add("clarify_period", `cup:${i}`, text.replace("{T}", phrase), { route: "clarify", reason: "unclear_period", period: "UNCLEAR" }, {})));

  for (const [reason, frames] of Object.entries(L.UNSUPPORTED)) {
    frames.forEach((fr, i) => add(`unsupported_${reason}`, fid(`u_${reason}`, i, fr), fr.text, { route: "unsupported", reason }, fr));
  }
  return cores.concat(RG.expandReportCores());
}

/** Compositions that need supported cores first: multi-intent and injection. */
function composeCores(base, seed) {
  const supported = base.filter((c) => !c.ood && ["ledger_party", "ledger_group", "financials", "company", "vouchers"].includes(c.family) && c.gold.period !== "RENDER");
  const rng = rngFor(seed, "compose");
  const out = [];
  const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  let guard = 0;
  while (out.filter((c) => c.family === "clarify_multi_intent").length < 100 && guard < 5000) {
    guard += 1;
    const a = pick(rng, supported);
    const b = pick(rng, supported);
    if (a.gold.route === b.gold.route) continue;
    const j = pick(rng, L.MULTI_INTENT_JOINERS);
    const text = j.replace("{A}", a.text).replace("{B}", lower(b.text));
    if (text.split("{P}").length > 2 || (a.text.includes("{P") && b.text.includes("{P"))) continue; // one party slot per sentence
    out.push({ family: "clarify_multi_intent", frameId: `mi:${a.frameId}+${b.frameId}`, text, gold: { route: "clarify", reason: "multi_intent" }, tags: ["multi_intent"], ood: false, extra: {} });
  }
  guard = 0;
  while (out.filter((c) => c.family === "unsupported_injection_combo").length < 90 && guard < 5000) {
    guard += 1;
    const a = pick(rng, supported);
    const j = pick(rng, L.INJECTION_JOINERS);
    const payload = pick(rng, L.INJECTION_PAYLOADS);
    const text = j.replace("{A}", a.text).replace("{J}", payload);
    out.push({ family: "unsupported_injection_combo", frameId: `inj:${L.INJECTION_JOINERS.indexOf(j)}:${a.frameId}`, text, gold: { route: "unsupported", reason: "prompt_injection" }, tags: ["prompt_injection", "legit_core_attached"], ood: false, extra: {} });
  }
  // de-duplicate identical compositions
  const seen = new Set();
  return out.filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)));
}

/** Deterministic down-sampling so no family swamps the others. */
const FAMILY_CAPS = {
  vouchers: 400, ledger_group: 200, overdue: 90, clarify_period: 36, clarify_multitype: 30,
  report_draft: 110, report_modify_per_operation: 5, report_clarify: 45,
};
function capFamilies(cores, seed) {
  const byFam = new Map();
  for (const c of cores) {
    // modify frames expand over many fields; cap each FRAME so single-variant
    // frames (an exclusion, a chart) are never sampled away by the expansive ones
    const k = `${c.family === "report_modify" ? `report_modify.${c.frameId.replace(/\.\d+(\.\d+)?(:ood)?$/, "")}` : c.family}|${c.ood}`;
    if (!byFam.has(k)) byFam.set(k, []);
    byFam.get(k).push(c);
  }
  const out = [];
  for (const [k, list] of byFam) {
    const [fam, ood] = k.split("|");
    const cap = fam.startsWith("report_modify.") ? FAMILY_CAPS.report_modify_per_operation : FAMILY_CAPS[fam];
    const limit = cap ? (ood === "true" ? Math.ceil(cap / 4) : cap) : Infinity;
    const sorted = list.slice().sort((a, b) => (sha([seed, a.text]) < sha([seed, b.text]) ? -1 : 1));
    out.push(...sorted.slice(0, limit), ...sorted.slice(limit).filter((c) => c.extra && c.extra.user_example));
  }
  return out;
}

// ── near-duplicate clustering (union-find) ──────────────────────────────────
function clusterCores(cores) {
  const parent = cores.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grams = cores.map((c) => trigrams(maskSlots(c.text)));
  for (let i = 0; i < cores.length; i += 1) {
    for (let j = i + 1; j < cores.length; j += 1) {
      if (jaccard(grams[i], grams[j]) >= CLUSTER_JACCARD) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  cores.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return [...groups.values()].map((members) => {
    const key = members.map((m) => `${m.frameId}|${m.text}`).sort()[0];
    return { key, members, ood: members.some((m) => m.ood) };
  });
}

// ── frozen evaluation material (never trained on) ────────────────────────────
function frozenMaterial() {
  const root = path.join(__dirname, "..", "open-jev-pilot");
  const cases = JSON.parse(fs.readFileSync(path.join(root, "accounts-cases.json"), "utf8")).cases.map((c) => c.question);
  const held = JSON.parse(fs.readFileSync(path.join(root, "heldout-cases.json"), "utf8")).cases.map((c) => c.message);
  const fixtureSrc = fs.readFileSync(path.join(root, "accounts-fixtures.js"), "utf8");
  const names = [...fixtureSrc.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  names.push("Thornfield Mills");
  return { questions: [...cases, ...held], names };
}
function maskFrozen(q, names) {
  let s = q;
  for (const n of names.slice().sort((a, b) => b.length - a.length)) s = s.split(n).join("ENT");
  return s;
}

function maskRendered(text, stems) {
  let s = text;
  for (const st of stems) s = s.replace(new RegExp(st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "ENT");
  return s.replace(/\d+/g, "NUM");
}

// ── rendering ────────────────────────────────────────────────────────────────
function applyTypos(rng, text) {
  // Only scaffolding words; placeholders are protected by their braces.
  const words = text.split(" ");
  const idx = words.map((w, i) => [w, i]).filter(([w]) => L.TYPOS[w.toLowerCase()]);
  if (!idx.length) return { text, typo: false };
  const [w, i] = pick(rng, idx);
  words[i] = pick(rng, L.TYPOS[w.toLowerCase()]);
  return { text: words.join(" "), typo: true };
}

function periodChoices(frameText, allowEmpty) {
  return L.PERIODS.filter(([phrase, , kind]) => kind !== "unclear" && (allowEmpty || phrase !== ""));
}

function renderCore(core, split, rng, pools, seed) {
  const tags = [...core.tags];
  let text = core.text;
  const gold = { ...core.gold };

  // period (render-level)
  if (text.includes("{D}")) {
    let choice;
    if (gold.period === "UNCLEAR") {
      choice = pick(rng, L.PERIODS.filter(([, , k]) => k === "unclear"));
    } else {
      const needs = Boolean(core.extra.needsPeriod);
      const opts = periodChoices(text, !needs);
      // Weight: a third of voucher questions carry no period, as in real use.
      choice = !needs && rng() < 0.3 ? L.PERIODS[0] : pick(rng, opts.filter(([p]) => p !== ""));
    }
    const [phrase, period, kind] = choice;
    text = text.replace("{D}", phrase);
    if (gold.period === "RENDER" || gold.period === "UNCLEAR") gold.period = period;
    if (kind === "invalid") tags.push("malformed_argument", "grav_expected:clarify_invalid_date");
    if (period === "all_time") tags.push("missing_date");
  } else if (gold.period === "RENDER") {
    gold.period = "all_time";
  }

  const pool = pools[split];
  const stem = pick(rng, pool);
  let party = partyFor(rng, stem, split);
  let otherStem = pick(rng, pool);
  if (otherStem === stem) otherStem = pool[(pool.indexOf(stem) + 1) % pool.length];
  const other = `${otherStem} ${pick(rng, L.OTHER_CO)}`;
  const stem2 = pool[(pool.indexOf(stem) + 3) % pool.length];

  if (core.family === "ledger_party" && split !== "ood" && rng() < 0.12) {
    const words = party.full.split(" ");
    words[words[0] === "M/s" ? 1 : 0] = misspell(rng, words[words[0] === "M/s" ? 1 : 0]);
    party = { full: words.join(" "), short: misspell(rng, party.short) };
    tags.push("misspelled_name");
  }

  // typos on scaffolding before entity substitution (entities stay intact)
  if (split !== "ood" && rng() < 0.22) {
    const t = applyTypos(rng, text);
    text = t.text;
    if (t.typo) tags.push("typo");
  }

  const [d1, d2] = datePair(rng);
  text = text
    .replace(/\{P\}/g, party.full)
    .replace(/\{Ps2\}/g, stem2)
    .replace(/\{Ps\}/g, party.short)
    .replace(/\{X\}/g, other)
    .replace(/\{DATE1\}/g, d1)
    .replace(/\{DATE2\}/g, d2)
    .replace(/\{BADDATE\}/g, badDate(rng))
    .replace(/\{MONTH\}/g, pick(rng, L.MONTHS))
    .replace(/\{YEAR\}/g, String(2025 + Math.floor(rng() * 2)))
    .replace(/\{N\}/g, String(pick(rng, [7, 15, 30, 45, 60, 90, 120])))
    .replace(/\s+/g, " ")
    .trim();

  // style
  if (split === "ood") {
    const r = rng();
    if (r < 0.35) {
      text = pick(rng, L.VOICE_FILLERS) + text.toLowerCase().replace(/[?.,!;:]/g, "");
      tags.push("style:voice");
    } else if (r < 0.7) {
      text = pick(rng, L.OOD_PREFIXES) + text;
      tags.push("style:irrelevant_context");
    }
  } else {
    if (rng() < 0.25) text = pick(rng, L.PREFIXES) + text;
    if (rng() < 0.35) text = text + pick(rng, L.SUFFIXES);
    const c = rng();
    if (c < 0.4) {
      text = text.toLowerCase();
      tags.push("style:lowercase");
    } else if (c < 0.7) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }
  }
  text = text.replace(/\s+/g, " ").trim();

  // account gold → an option name
  if (gold.account === "P" || gold.account === "Ps") {
    const entity = gold.account === "P" ? party.full : party.short;
    const want = tokens(entity).map((t) => t.toLowerCase());
    const have = tokens(text);
    let span = null;
    for (let i = 0; i + want.length <= have.length && !span; i += 1) {
      if (have.slice(i, i + want.length).every((t, k) => t.toLowerCase() === want[k])) span = have.slice(i, i + want.length).join(" ");
    }
    gold.account = span ? `text: ${span}` : "UNREACHABLE";
    if (gold.account === "UNREACHABLE" || !proposeSpans(text).includes(span)) gold.account = "UNREACHABLE";
    if (gold.account !== "UNREACHABLE" && gold.route === "acc_ledger_balance") tags.push("grav_expected:resolver_decides_match");
  }
  if (["acc_overdue_bills"].includes(gold.route) && gold.account === undefined) gold.account = "none";

  return { text, gold, tags, entities: [stem, otherStem] };
}

/** Render one Custom Report Builder command, including the draft it acts on. */
function renderReport(core, split, rng, pools, verbatim) {
  const tags = [...core.tags, "report"];
  const gold = { ...core.gold, includes: core.gold.includes ? [...core.gold.includes] : undefined };
  let text = RG.fillReportSlots(rng, core.text);
  let name = null;
  const nameMatch = core.text.includes("{NAME}");
  if (nameMatch) {
    // fillReportSlots picked a name; recover it for the gold span
    name = RL.REPORT_NAMES.find((n) => text.includes(n));
  }
  if (text.includes("RPERIOD")) {
    const [phrase, period] = RG.reportPeriod(rng);
    text = text.replace("RPERIOD", phrase);
    if (gold.period === "RENDER_REPORT") gold.period = period;
    if (period === "all_time") tags.push("missing_date");
  }
  if (gold.period === "RENDER_REPORT") gold.period = "all_time";

  const pool = pools[split];
  const stem = pick(rng, pool);
  const party = partyFor(rng, stem, split);
  let otherStem = pick(rng, pool);
  if (otherStem === stem) otherStem = pool[(pool.indexOf(stem) + 1) % pool.length];
  const other = `${otherStem} ${pick(rng, L.OTHER_CO)}`;
  if (!verbatim && split !== "ood" && rng() < 0.2) {
    const t = RG.applyReportTypos(rng, text);
    const t2 = t.typo ? t : applyTypos(rng, text);
    text = t2.text;
    if (t2.typo) tags.push("typo");
  }
  const [d1, d2] = datePair(rng);
  text = text
    .replace(/\{P\}/g, party.full).replace(/\{Ps\}/g, party.short).replace(/\{X\}/g, other)
    .replace(/\{DATE1\}/g, d1).replace(/\{DATE2\}/g, d2)
    .replace(/\{MONTH\}/g, pick(rng, L.MONTHS)).replace(/\{YEAR\}/g, String(2025 + Math.floor(rng() * 2)))
    .replace(/\s+/g, " ").trim();
  if (verbatim) text = text.replace("₹5,000", "₹50,000").replace("₹10,000", "₹50,000").replace("₹25,000", "₹50,000").replace("₹75,000", "₹50,000");
  if (!verbatim) {
    if (split === "ood") {
      const r = rng();
      if (r < 0.35) {
        text = pick(rng, L.VOICE_FILLERS) + text.toLowerCase().replace(/[?.,!;:]/g, "");
        tags.push("style:voice");
      } else if (r < 0.6) {
        text = pick(rng, L.OOD_PREFIXES) + text;
        tags.push("style:irrelevant_context");
      }
    } else {
      if (rng() < 0.2) text = pick(rng, L.PREFIXES) + text;
      const c = rng();
      if (c < 0.4) {
        text = text.toLowerCase();
        tags.push("style:lowercase");
      }
    }
  } else {
    tags.push("user_example");
  }
  text = text.replace(/\s+/g, " ").trim();

  if (gold.report_name === "NAME") gold.report_name = name ? RG.nameGold(text, name) : "UNREACHABLE";
  else if (gold.report_name && gold.report_name !== "none") gold.report_name = RG.nameGold(text, gold.report_name);

  // the draft this command acts on
  const shape = core.extra.draft;
  let draft = null;
  if (shape === "some" || (shape && typeof shape === "object")) draft = RG.randomDraft(rng, shape);
  else if (shape === "any") draft = rng() < 0.5 ? RG.randomDraft(rng, "some") : null;
  if (draft) tags.push("multi_turn");
  if (draft && (gold.route === "clarify" || gold.report_operation === "unavailable_capability")) tags.push("grav_expected:draft_preserved");
  return { text, gold, tags, entities: [stem, otherStem], draft };
}

function reportCandidateSet(rng) {
  const r = rng();
  if (r < 0.6) return ["report_editor", schema.candidate_sets.report_editor];
  if (r < 0.85) return ["report_viewer", schema.candidate_sets.report_viewer];
  return ["registered", schema.candidate_sets.registered];
}

function candidateSetFor(rng) {
  const r = rng();
  if (r < 0.45) return ["with_proposed", schema.candidate_sets.with_proposed];
  if (r < 0.9) return ["registered", schema.candidate_sets.registered];
  const i = Math.floor(rng() * schema.candidate_sets.permission_subsets.length);
  return [`subset${i}`, schema.candidate_sets.permission_subsets[i]];
}

function routeGoldFor(gold, offered) {
  if (gold.route === "clarify" || gold.route === "unsupported") return { label: gold.route, reason: gold.reason || null };
  if (offered.includes(gold.route)) return { label: gold.route, reason: null };
  return { label: "unsupported", reason: "tool_not_offered" };
}

const REPORT_TOOLS = new Set(schema.report_tools.map((t) => t.name));
const REFUSE_REASONS = new Set(["write_request", "cross_company", "prompt_injection", "tool_not_offered", "report_operation_unavailable", "non_accounting", "unsupported_report", "unsupported_period"]);
/** The four intent classes the request asks Jev to tell apart (plus clarify). */
function intentClass(label, reason) {
  if (REPORT_TOOLS.has(label)) return "structured_report";
  if (label === "clarify") return "clarify";
  if (label === "unsupported") return reason === "analytical_out_of_lane" ? "analytical_escalate" : "refuse";
  return "direct_fact";
}

const ARGS_BY_TOOL = {
  acc_ledger_balance: ["account"],
  acc_vouchers: ["voucher_type", "period"],
  acc_overdue_bills: ["party_side", "account"],
};

// ── row construction ─────────────────────────────────────────────────────────
function makeRow({ id, groupId, split, family, templateId, text, questionId, instructions, options, goldName, seed, groupIndex, variant, entities, grav, draft, kind = "choice" }) {
  const rng = rngFor(seed, "options", id);
  // noul (yes/no) rows keep Open-Jev's fixed ["no","yes"] order
  const ordered = kind === "noul" ? [{ name: "no", description: null }, { name: "yes", description: null }] : shuffled(rng, options);
  const rendered = ordered.map(renderOption);
  const target = ordered.map((o) => (o.name === goldName ? 1 : 0));
  if (target.reduce((a, b) => a + b, 0) !== 1) throw new Error(`gold ${goldName} not among options for ${id}`);
  return {
    id,
    group_id: groupId,
    split,
    source: `${GENERATOR_VERSION}/${family}`,
    state: draft === undefined ? { question: text } : { question: text, report_draft: draft },
    question: instructions,
    kind,
    options: rendered,
    target,
    metadata: {
      family: "routing",
      question_id: questionId,
      entity_ids: entities,
      template_id: templateId,
      target_basis: "deterministic_rubric_label",
      provenance: {
        type: "synthetic",
        generator_version: GENERATOR_VERSION,
        seed,
        group_index: groupIndex,
        variant,
        license: "CC0-1.0",
        split_policy: split === "ood" ? "grav_ood_frame_holdout_v1" : "grav_group_sha256_v1",
      },
      grav: { ...grav, candidates: ordered.map((o) => ({ name: o.name, description: o.description })), gold: goldName },
    },
  };
}

const RENDERS = { report_draft: 2, report_modify: 2, report_describe: 3, report_validate: 7, report_preview: 5, report_save: 7, report_export: 7, report_clarify: 2, report_analytical: 3, default: 3, ledger_party: 9, financials: 8, company: 9, clarify_missing: 3, clarify_multi_intent: 2, overdue: 4, vouchers: 2, ledger_group: 3 };

function generate({ seed = DEFAULT_SEED } = {}) {
  const routeDescriptions = runtimeRouteDescriptions();
  const frozen = frozenMaterial();
  const frozenGrams = frozen.questions.map((q) => trigrams(maskFrozen(q, frozen.names)));

  let cores = expandCores();
  cores = cores.concat(composeCores(cores, seed));
  cores = capFamilies(cores, seed);
  const groups = clusterCores(cores).sort((a, b) => (a.key < b.key ? -1 : 1));
  const pools = buildNamePools(seed);

  // Scenario groups that echo the user's own examples or the frozen pilot
  // questions are evaluated, never trained: they are forced into locked_test
  // whole. Anything they would teach, the model has to learn from other wording.
  const protectedGrams = [
    ...USER_EXAMPLE_FRAMES.map((t) => trigrams(maskSlots(t))),
    ...frozen.questions.map((q) => trigrams(maskFrozen(q, frozen.names))),
  ];
  const forced = new Set();
  for (const g of groups) {
    if (g.ood) continue;
    if (g.members.some((m) => {
      const mg = trigrams(maskSlots(m.text));
      return protectedGrams.some((pg) => jaccard(mg, pg) >= PROTECT_JACCARD);
    })) forced.add(g.key);
  }

  // Stratified group split: within each gold route label, groups are ordered by
  // hash and dealt out by the split proportions, so every label reaches every
  // split while a group still lands in exactly one.
  const splitOf = new Map();
  const byLabel = new Map();
  for (const g of groups) {
    if (g.ood || forced.has(g.key)) continue;
    const label = g.members[0].gold.route;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(g);
  }
  for (const list of byLabel.values()) {
    list.sort((a, b) => (sha([seed, "split", a.key]) < sha([seed, "split", b.key]) ? -1 : 1));
    list.forEach((g, i) => {
      const u = (i + 0.5) / list.length;
      // offset the dealing so the first groups of small labels are not all train
      const shifted = (u + parseInt(sha([seed, "offset", g.members[0].gold.route]).slice(0, 6), 16) / 0xffffff) % 1;
      splitOf.set(g.key, SPLIT_BOUNDS.find(([b]) => shifted < b)[1]);
    });
  }

  const rows = [];
  const usedText = new Map(); // normalised text → split
  const dropped = { frozen_near_duplicate: 0, duplicate_text: 0, unreachable_argument: 0 };

  groups.forEach((g, gi) => {
    const split = g.ood ? "ood" : forced.has(g.key) ? "test" : splitOf.get(g.key);
    const groupId = `${GENERATOR_VERSION}:${seed}:g${sha(g.key).slice(0, 16)}`;
    let variant = 0;
    g.members.forEach((core, ci) => {
      const n = RENDERS[core.family] || RENDERS.default;
      for (let r = 0; r < n; r += 1) {
        const rng = rngFor(seed, "render", g.key, ci, r);
        const isReport = Boolean(core.extra.report);
        const verbatim = isReport && Boolean(core.extra.user_example) && r === 0;
        let rendered = null;
        for (let attempt = 0; attempt < 6 && !rendered; attempt += 1) {
          const arng = rngFor(seed, "render", g.key, ci, r, attempt);
          const cand = isReport ? renderReport(core, split, arng, pools, verbatim) : renderCore(core, split, arng, pools, seed);
          const k = norm(cand.text) + "|" + JSON.stringify(cand.draft ?? null);
          if (usedText.has(k)) {
            dropped.duplicate_text += 1;
            continue;
          }
          if (split !== "test" && split !== "ood") {
            const tg = trigrams(maskRendered(cand.text, cand.entities));
            if (frozenGrams.some((fg) => jaccard(tg, fg) >= 0.85)) {
              dropped.frozen_near_duplicate += 1;
              continue;
            }
          }
          rendered = cand;
        }
        if (!rendered) continue;
        usedText.set(norm(rendered.text) + "|" + JSON.stringify(rendered.draft ?? null), split);

        // Accounts questions are also asked inside the report builder, where the
        // report tools sit beside them: that is where "fact or report?" is learned.
        const sets = [];
        // the user's verbatim report examples are judged where they would be asked: the report editor
        if (isReport) sets.push(verbatim ? ["report_editor", schema.candidate_sets.report_editor] : reportCandidateSet(rng));
        else if (rng() < 0.18) sets.push(rng() < 0.7 ? ["report_editor", schema.candidate_sets.report_editor] : ["report_viewer", schema.candidate_sets.report_viewer]);
        else sets.push(candidateSetFor(rng));
        if (!isReport && sets[0][0].startsWith("report") === false && rng() < 0.12) {
          sets.push(sets[0][0] === "registered" ? ["with_proposed", schema.candidate_sets.with_proposed] : ["registered", schema.candidate_sets.registered]);
        }
        const base = `${groupId}:c${ci}:r${r}`;
        for (const [setName, offered] of sets) {
          const inReport = setName.startsWith("report");
          const draft = inReport ? (isReport ? rendered.draft : rng() < 0.3 ? RG.randomDraft(rng, "some") : null) : undefined;
          const rg = routeGoldFor(rendered.gold, offered);
          const options = offered.map((name) => ({ name, description: routeDescriptions[name] }));
          rows.push(makeRow({
            id: `${base}:route:${setName}`, groupId, split, family: core.family, templateId: core.frameId,
            text: rendered.text, questionId: "route", instructions: schema.route.instructions, options, draft,
            goldName: rg.label, seed, groupIndex: gi, variant: variant++, entities: rendered.entities,
            grav: { question_id: "route", candidate_set: setName, family: core.family, reason: rg.reason, tags: rendered.tags, scenario_gold: rendered.gold, intent_class: intentClass(rg.label, rg.reason) },
          }));
        }
        // argument rows, asked only for the gold tool (teacher-forced)
        const tool = rendered.gold.route;
        if (isReport) {
          const draft = rendered.draft;
          for (const q of RG.reportArgumentQuestions(rendered.gold, rendered.text)) {
            if (q.gold === "UNREACHABLE") {
              dropped.unreachable_argument += 1;
              continue;
            }
            rows.push(makeRow({
              id: `${base}:arg:${q.id}`, groupId, split, family: core.family, templateId: core.frameId,
              text: rendered.text, questionId: q.id, instructions: q.instructions, options: q.options || [], kind: q.kind, draft,
              goldName: q.gold, seed, groupIndex: gi, variant: variant++, entities: rendered.entities,
              grav: { question_id: q.id, tool, family: core.family, tags: rendered.tags, scenario_gold: rendered.gold },
            }));
          }
          continue;
        }
        for (const arg of ARGS_BY_TOOL[tool] || []) {
          const goldArg = rendered.gold[arg];
          if (goldArg === "UNREACHABLE") {
            dropped.unreachable_argument += 1;
            continue;
          }
          const options = argumentOptions(arg, rendered.text).filter((o) => arg !== "period" || !["as_in_draft"].includes(o.name));
          rows.push(makeRow({
            id: `${base}:arg:${arg}`, groupId, split, family: core.family, templateId: core.frameId,
            text: rendered.text, questionId: arg, instructions: schema.arguments[arg].instructions, options,
            goldName: goldArg, seed, groupIndex: gi, variant: variant++, entities: rendered.entities,
            grav: { question_id: arg, tool, family: core.family, tags: rendered.tags, scenario_gold: rendered.gold },
          }));
        }
      }
    });
  });

  // The user's own examples, verbatim, locked for evaluation only.
  const userExamples = [
    ["ledger balance of Ariel", "text: Ariel"],
    ["Ariel ka balance?", "text: Ariel"],
    ["what does Ariel owe us?", "text: Ariel"],
  ];
  const ueGroup = `${GENERATOR_VERSION}:${seed}:user-examples`;
  userExamples.forEach(([text, account], i) => {
    for (const [setName, offered] of [["registered", schema.candidate_sets.registered], ["with_proposed", schema.candidate_sets.with_proposed]]) {
      rows.push(makeRow({
        id: `${ueGroup}:${i}:route:${setName}`, groupId: ueGroup, split: "test", family: "user_examples", templateId: `ue:${i}`,
        text, questionId: "route", instructions: schema.route.instructions,
        options: offered.map((name) => ({ name, description: routeDescriptions[name] })), goldName: "acc_ledger_balance",
        seed, groupIndex: -1, variant: i * 3, entities: ["Ariel"],
        grav: { question_id: "route", candidate_set: setName, family: "user_examples", reason: null, tags: ["user_example"], scenario_gold: { route: "acc_ledger_balance", account }, intent_class: "direct_fact" },
      }));
    }
    rows.push(makeRow({
      id: `${ueGroup}:${i}:arg:account`, groupId: ueGroup, split: "test", family: "user_examples", templateId: `ue:${i}`,
      text, questionId: "account", instructions: schema.arguments.account.instructions, options: argumentOptions("account", text),
      goldName: account, seed, groupIndex: -1, variant: i * 3 + 2, entities: ["Ariel"],
      grav: { question_id: "account", tool: "acc_ledger_balance", family: "user_examples", tags: ["user_example"], scenario_gold: { route: "acc_ledger_balance", account } },
    }));
  });

  return { rows, groups: groups.length, forcedToTest: forced.size, dropped, routeDescriptions, pools };
}

// ── statistics ───────────────────────────────────────────────────────────────
function statistics(rows) {
  const s = { rows: rows.length, by_split: {}, route_labels_by_split: {}, arg_rows_by_split: {}, families: {}, groups_by_split: {}, tags: {}, candidate_sets: {}, reasons: {} };
  const groups = {};
  for (const r of rows) {
    const g = r.metadata.grav;
    s.by_split[r.split] = (s.by_split[r.split] || 0) + 1;
    (groups[r.split] = groups[r.split] || new Set()).add(r.group_id);
    s.families[g.family] = (s.families[g.family] || 0) + 1;
    for (const t of g.tags || []) s.tags[t.split(":")[0]] = (s.tags[t.split(":")[0]] || 0) + 1;
    if (g.question_id === "route") {
      const m = (s.route_labels_by_split[r.split] = s.route_labels_by_split[r.split] || {});
      m[g.gold] = (m[g.gold] || 0) + 1;
      s.candidate_sets[g.candidate_set] = (s.candidate_sets[g.candidate_set] || 0) + 1;
      if (g.reason) s.reasons[g.reason] = (s.reasons[g.reason] || 0) + 1;
    } else {
      const m = (s.arg_rows_by_split[r.split] = s.arg_rows_by_split[r.split] || {});
      m[g.question_id] = (m[g.question_id] || 0) + 1;
    }
  }
  for (const [k, v] of Object.entries(groups)) s.groups_by_split[k] = v.size;
  return s;
}

// ── writing ──────────────────────────────────────────────────────────────────
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((o, k) => ((o[k] = canonical(value[k])), o), {});
  }
  return value;
}
const line = (row) => JSON.stringify(canonical(row));
const fileSha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function write(outDir, result, seed, audit) {
  const splits = { "train-view": ["train", "calibration", "validation"], locked: ["test", "ood"] };
  const manifests = {};
  for (const [dir, names] of Object.entries(splits)) {
    const d = path.join(outDir, dir);
    fs.mkdirSync(d, { recursive: true });
    const files = {};
    for (const name of names) {
      const p = path.join(d, `${name}.jsonl`);
      const body = result.rows.filter((r) => r.split === name).map(line).join("\n") + "\n";
      fs.writeFileSync(p, body);
      files[`${name}.jsonl`] = fileSha(p);
    }
    const m = {
      schema_version: 1,
      generator_version: GENERATOR_VERSION,
      seed,
      directory_role: dir === "locked" ? "LOCKED EVALUATION — training code refuses any directory containing these files" : "training view — the only data a trainer may read",
      files_sha256: files,
      model_input_fields: ["state", "question", "kind", "options"],
    };
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    manifests[dir] = { manifest_sha256: fileSha(path.join(d, "manifest.json")), files_sha256: files };
  }
  const stats = statistics(result.rows);
  fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify(stats, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(audit, null, 2) + "\n");
  const top = {
    schema_version: 1,
    generator_version: GENERATOR_VERSION,
    seed,
    tool_schema: { name: schema.schema, version: schema.version, sha256: fileSha(path.join(__dirname, "schema", "grav-acc-tools.v1.json")) },
    route_descriptions_sha256: sha(canonical(result.routeDescriptions)),
    source_sha256: Object.fromEntries(["generate.js", "lexicon.js", "reportLexicon.js", "reportGenerate.js", "argumentCandidates.js", "audit.js"].map((f) => [f, fileSha(path.join(__dirname, f))])),
    groups: result.groups,
    groups_forced_to_locked_test: result.forcedToTest,
    dropped: result.dropped,
    directories: manifests,
    audit_passed: audit.passed,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(top, null, 2) + "\n");
  return { stats, manifest: top };
}

function main() {
  const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
  };
  const seed = Number(arg("seed", DEFAULT_SEED));
  const out = path.resolve(arg("out", path.join(__dirname, "..", "..", "tmp", "jev-routing", "data", GENERATOR_VERSION)));
  const result = generate({ seed });
  const { runAudit } = require("./audit");
  const audit = runAudit(result.rows, { pools: result.pools });
  const { stats, manifest } = write(out, result, seed, audit);
  console.log(JSON.stringify({ out, rows: stats.rows, groups: manifest.groups, by_split: stats.by_split, groups_by_split: stats.groups_by_split, dropped: manifest.dropped, audit_passed: audit.passed, audit_failures: audit.failures }, null, 2));
  if (!audit.passed) process.exitCode = 1;
}

module.exports = { generate, statistics, canonical, line, GENERATOR_VERSION, DEFAULT_SEED, maskSlots, trigrams, jaccard, norm, rngFor, SPLIT_FILE, _internals: { write } };

if (require.main === module) main();
