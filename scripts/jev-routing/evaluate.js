"use strict";
/**
 * scripts/jev-routing/evaluate.js — score an Open-Jev endpoint on the LOCKED set.
 *
 *   node scripts/jev-routing/evaluate.js \
 *     --locked=tmp/jev-routing/data/grav-acc-routing-v1/locked \
 *     --endpoint=http://127.0.0.1:8791/v1/systemone \
 *     --label=released-2b --device=cpu --subset=full|core \
 *     --out=tmp/jev-routing/reports/<label> \
 *     [--memory-probe=docker:<container>|nvidia-smi] [--rotations=40] [--timeout-ms=300000]
 *
 *   node scripts/jev-routing/evaluate.js --locked=… --predictions=<rows.jsonl> …   (re-score saved results)
 *
 * Self-contained on purpose: Node ≥ 18 standard library only, no GRAV modules,
 * so the identical file runs on a rented GPU host against the adapter being
 * judged. Each locked row becomes one request carrying exactly what the GRAV
 * client sends — `state: {question}` and one choice question whose criteria are
 * the row's candidates — so the model is judged on the runtime's own input.
 *
 * Requests are sequential. Open-Jev does not cancel work when a client aborts,
 * so parallel or retried requests on a slow host pile up behind each other and
 * measure the queue, not the model (docs/audits/open-jev-accounts-cpu-evaluation.md).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { summarise, topAndMargin } = require("./metrics");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fileSha = (p) => sha(fs.readFileSync(p));

function loadLocked(dir) {
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rows = [];
  for (const [file, expected] of Object.entries(manifest.files_sha256)) {
    const p = path.join(dir, file);
    if (fileSha(p) !== expected) throw new Error(`${file} does not match its locked manifest`);
    for (const l of fs.readFileSync(p, "utf8").split("\n")) if (l.trim()) rows.push(JSON.parse(l));
  }
  return { rows, manifest, manifestSha: fileSha(manifestPath) };
}

/**
 * The CPU baseline subset: a fixed, stratified choice made from row ids alone,
 * never from any model output. Up to `perCell` rows per (split, question, gold),
 * plus every user example.
 */
function coreSubset(rows, routePerCell = { test: 10, ood: 5 }, argPerCell = { account: { test: 6, ood: 3 }, voucher_type: { test: 2, ood: 1 }, period: { test: 2, ood: 1 }, party_side: { test: 3, ood: 2 } }) {
  const cells = new Map();
  const ordered = rows.slice().sort((a, b) => (sha(`core:${a.id}`) < sha(`core:${b.id}`) ? -1 : 1));
  // An account gold is a unique span, so it is stratified by KIND of answer.
  const goldClass = (g) => (g.question_id === "account" ? g.gold.split(":")[0] : g.gold);
  const out = [];
  for (const r of ordered) {
    const g = r.metadata.grav;
    if (g.family === "user_examples") {
      out.push(r);
      continue;
    }
    const key = `${r.split}|${g.question_id}|${goldClass(g)}`;
    const n = cells.get(key) || 0;
    const cap = g.question_id === "route" ? routePerCell[r.split] : (argPerCell[g.question_id] || { test: 1, ood: 1 })[r.split];
    if (n < cap) {
      cells.set(key, n + 1);
      out.push(r);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function requestFor(row, order) {
  const cands = order || row.metadata.grav.candidates;
  const qid = row.metadata.grav.question_id;
  if (row.kind === "noul") return { model: "open-jev", state: row.state, questions: { [qid]: { type: "noul", instructions: row.question } } };
  return {
    model: "open-jev",
    state: row.state,
    questions: { [qid]: { type: "choice", instructions: row.question, criteria: Object.fromEntries(cands.map((c) => [c.name, c.description])) } },
  };
}

/** Same strictness as services/ai/openJev/openJevClient.js validateChoiceResponse. */
function validate(body, qid, offered, kind = "choice") {
  if (!body || typeof body !== "object") return "body_not_object";
  const a = body.answers && body.answers[qid];
  if (kind === "noul") {
    if (!a || a.type !== "noul") return "not_a_noul_answer";
    return Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1 ? null : "bad_probabilities";
  }
  if (!a || a.type !== "choice") return "not_a_choice_answer";
  if (typeof a.choice !== "string") return "missing_choice";
  const p = a.probabilities || {};
  const keys = Object.keys(p);
  if (keys.length !== offered.length || !offered.every((c) => keys.includes(c))) return "probability_keys_mismatch";
  const sum = offered.reduce((s, c) => s + p[c], 0);
  if (!offered.every((c) => Number.isFinite(p[c]) && p[c] >= 0 && p[c] <= 1) || Math.abs(sum - 1) > 1e-4) return "bad_probabilities";
  return null;
}

async function ask(endpoint, row, timeoutMs, order) {
  const qid = row.metadata.grav.question_id;
  const offered = (order || row.metadata.grav.candidates).map((c) => c.name);
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const ms = () => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestFor(row, order)), signal: controller.signal });
    if (!res.ok) return { status: `http_${res.status}`, latency_ms: ms() };
    const body = await res.json();
    const latency_ms = ms();
    const bad = validate(body, qid, offered, row.kind);
    // An answer naming something that was not offered is recorded as chosen —
    // that is the out-of-allowlist count — but never as a valid decision.
    if (bad) return { status: `invalid:${bad}`, latency_ms, choice: body?.answers?.[qid]?.choice };
    if (row.kind === "noul") {
      const p = body.answers[qid].noul;
      return { status: "ok", latency_ms, choice: p >= 0.5 ? "yes" : "no", probabilities: { no: 1 - p, yes: p }, model: body.model, metadata: body.metadata || null };
    }
    return { status: "ok", latency_ms, choice: body.answers[qid].choice, probabilities: body.answers[qid].probabilities, model: body.model, metadata: body.metadata || null };
  } catch (err) {
    return { status: err && err.name === "AbortError" ? "timeout" : "unavailable", latency_ms: ms() };
  } finally {
    clearTimeout(timer);
  }
}

function resultFor(row, reply) {
  const g = row.metadata.grav;
  const { top, margin } = topAndMargin(reply.probabilities);
  return {
    id: row.id, split: row.split, group_id: row.group_id, question_id: g.question_id, question: row.state.question,
    family: g.family, reason: g.reason || null, tags: g.tags || [], candidate_set: g.candidate_set || null,
    intent_class: g.intent_class || null, has_draft: Boolean(row.state.report_draft), kind: row.kind,
    offered: g.candidates.map((c) => c.name), gold: g.gold,
    ok: reply.status === "ok", status: reply.status, choice: reply.choice ?? null,
    probabilities: reply.probabilities || null, top, margin, latency_ms: reply.latency_ms,
  };
}

function startMemoryProbe(spec) {
  if (!spec) return { stop: () => ({ probe: "none" }) };
  const samples = [];
  const sample = () => {
    try {
      if (spec === "nvidia-smi") {
        const out = execFileSync("nvidia-smi", ["--query-gpu=memory.used,memory.total,name", "--format=csv,noheader,nounits"], { encoding: "utf8" });
        const [used, total, name] = out.trim().split("\n")[0].split(",").map((s) => s.trim());
        samples.push({ used_mib: Number(used), total_mib: Number(total), device: name });
      } else if (spec.startsWith("docker:")) {
        const out = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", spec.slice(7)], { encoding: "utf8" });
        const m = out.trim().match(/([\d.]+)\s*([KMG]i?B)\s*\/\s*([\d.]+)\s*([KMG]i?B)/);
        const toMiB = (v, u) => Number(v) * ({ KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[u] || 1);
        if (m) samples.push({ used_mib: toMiB(m[1], m[2]), total_mib: toMiB(m[3], m[4]), device: spec });
      }
    } catch {
      samples.push({ error: true });
    }
  };
  sample();
  const t = setInterval(sample, 5000);
  return {
    stop: () => {
      clearInterval(t);
      sample();
      const ok = samples.filter((s) => !s.error);
      return { probe: spec, samples: samples.length, failed_samples: samples.length - ok.length, peak_used_mib: ok.length ? Math.max(...ok.map((s) => s.used_mib)) : null, total_mib: ok[0]?.total_mib ?? null, device: ok[0]?.device ?? null };
    },
  };
}

async function main() {
  const lockedDir = path.resolve(arg("locked", "tmp/jev-routing/data/grav-acc-routing-v1/locked"));
  const endpoint = arg("endpoint", "http://127.0.0.1:8791/v1/systemone");
  const label = arg("label", "unlabelled");
  const device = arg("device", "device-not-stated");
  const subset = arg("subset", "full");
  const out = path.resolve(arg("out", path.join("tmp/jev-routing/reports", label)));
  const timeoutMs = Number(arg("timeout-ms", "300000"));
  const rotations = Number(arg("rotations", "0"));
  const predictions = arg("predictions", null);

  const { rows: all, manifest, manifestSha } = loadLocked(lockedDir);
  const rows = subset === "core" ? coreSubset(all) : all;
  fs.mkdirSync(out, { recursive: true });

  let results;
  let modelInfo = null;
  const probe = startMemoryProbe(arg("memory-probe", null));
  const startedAt = new Date().toISOString();
  if (predictions) {
    const saved = new Map(fs.readFileSync(predictions, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    results = rows.map((row) => {
      const s = saved.get(row.id);
      return resultFor(row, s ? { status: s.status, choice: s.choice, probabilities: s.probabilities, latency_ms: s.latency_ms } : { status: "missing_prediction", latency_ms: null });
    });
  } else {
    results = [];
    const stream = fs.createWriteStream(path.join(out, "rows.jsonl"));
    for (const [i, row] of rows.entries()) {
      const reply = await ask(endpoint, row, timeoutMs);
      if (!modelInfo && reply.status === "ok") {
        const md = reply.metadata || {};
        modelInfo = { model: reply.model ?? null, method: md.method ?? null, temperature: md.temperature ?? null, provenance: md.provenance ?? null };
      }
      const r = resultFor(row, reply);
      results.push(r);
      stream.write(JSON.stringify(r) + "\n");
      if ((i + 1) % 10 === 0 || i + 1 === rows.length) {
        const okN = results.filter((x) => x.ok).length;
        process.stderr.write(`[${label}] ${i + 1}/${rows.length} ok=${okN} last=${Math.round(r.latency_ms)}ms\n`);
      }
    }
    stream.end();
  }

  // Candidate-order rotations: the same question, criteria reversed. Open-Jev
  // scores candidates independently, so any change is numerical, not positional.
  let rotation = null;
  if (rotations > 0 && !predictions) {
    const sample = rows.filter((r) => r.metadata.grav.question_id === "route").sort((a, b) => (sha(`rot:${a.id}`) < sha(`rot:${b.id}`) ? -1 : 1)).slice(0, rotations);
    let same = 0;
    let maxDelta = 0;
    for (const row of sample) {
      const base = results.find((x) => x.id === row.id);
      const rev = await ask(endpoint, row, timeoutMs, row.metadata.grav.candidates.slice().reverse());
      if (rev.status === "ok" && base.ok) {
        if (rev.choice === base.choice) same += 1;
        for (const k of Object.keys(rev.probabilities)) maxDelta = Math.max(maxDelta, Math.abs(rev.probabilities[k] - base.probabilities[k]));
      }
    }
    rotation = { n: sample.length, same_decision: same, agreement: sample.length ? same / sample.length : null, max_probability_delta: maxDelta };
  }
  const memory = probe.stop();

  const expected = rows.length;
  const report = {
    schema: "grav.jev.routing-eval/1",
    label,
    device,
    endpoint_host: endpoint.replace(/^(https?:\/\/[^/]+).*$/, "$1"),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    locked: { manifest_sha256: manifestSha, generator_version: manifest.generator_version, seed: manifest.seed, rows_in_locked_set: all.length },
    subset,
    completeness: { rows_expected: expected, rows_scored: results.length, rows_failed: results.filter((r) => !r.ok).length, complete: results.length === expected && subset === "full" },
    evaluated_ids_sha256: sha(results.map((r) => r.id).join("\n")),
    model_reported: modelInfo,
    rotation,
    memory,
    ...summarise(results),
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (predictions) fs.writeFileSync(path.join(out, "rows.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(out, "report.md"), renderMarkdown(report));
  console.log(JSON.stringify({ out, label, rows: expected, failed: report.completeness.rows_failed, route_accuracy: report.overall.route.tool_selection_accuracy, argument_accuracy: report.overall.arguments.argument_accuracy }, null, 2));
}

const f3 = (x) => (x === null || x === undefined ? "—" : typeof x === "number" ? (Math.abs(x) <= 1 && !Number.isInteger(x) ? (100 * x).toFixed(1) + "%" : String(Math.round(x))) : String(x));

function renderMarkdown(r) {
  const L = [];
  L.push(`# Jev routing evaluation — ${r.label}`, "");
  L.push(`Device: **${String(r.device).toUpperCase()}** · subset: **${r.subset}** · locked manifest \`${r.locked.manifest_sha256.slice(0, 16)}…\``);
  L.push(`Rows scored ${r.completeness.rows_scored}/${r.completeness.rows_expected}; failed (kept, scored wrong) ${r.completeness.rows_failed}.`, "");
  L.push("| split | route acc | clear-tool acc | clarify recall | refusal recall | arg acc | end-to-end | unsafe (argmax/exec) | out-of-allowlist | halluc. args | coverage@0.80 | acc when executed |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [name, s] of [["all", r.overall], ...Object.entries(r.by_split)]) {
    const ro = s.route;
    L.push(`| ${name} | ${f3(ro.tool_selection_accuracy)} | ${f3(ro.clear_tool_accuracy)} | ${f3(ro.clarify_recall)} | ${f3(ro.refusal_recall)} | ${f3(s.arguments.argument_accuracy)} | ${f3(s.end_to_end.accuracy)} | ${ro.unsafe_routes_argmax}/${ro.unsafe_routes_executable} | ${ro.out_of_allowlist_choices} | ${s.arguments.hallucinated_arguments} | ${f3(ro.execution.coverage)} | ${f3(ro.execution.accuracy_when_executed)} |`);
  }
  L.push("", "## By intent (all splits)", "", "| intent | n | route accuracy |", "|---|---|---|");
  for (const [k, v] of Object.entries(r.overall.route.by_intent_class)) L.push(`| ${k} | ${v.n} | ${f3(v.accuracy)} |`);
  L.push(`| unauthorised requests refused | ${r.overall.route.unauthorised_refusal.n} | ${f3(r.overall.route.unauthorised_refusal.accuracy)} |`);
  L.push("", "## Per route label (precision / recall)", "", "| label | support | precision | recall |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(r.overall.route.per_class)) L.push(`| ${k} | ${v.support} | ${f3(v.precision)} | ${f3(v.recall)} |`);
  const rp = r.overall.report;
  L.push("", "## Custom Report Builder", "", "| metric | n | value |", "|---|---|---|");
  L.push(`| report-intent route accuracy | ${rp.report_intent_n} | ${f3(rp.report_intent_route_accuracy)} |`);
  L.push(`| draft modification exact (route + every argument) | ${rp.draft_modification_exact.n} | ${f3(rp.draft_modification_exact.accuracy)} |`);
  L.push(`| new-draft columns: exact set | ${rp.new_draft_columns.n} | ${f3(rp.new_draft_columns.exact_set)} |`);
  L.push(`| new-draft columns: precision / recall | — | ${f3(rp.new_draft_columns.precision)} / ${f3(rp.new_draft_columns.recall)} |`);
  L.push(`| unavailable capability recognised | ${rp.unavailable_capability_recall.n} | ${f3(rp.unavailable_capability_recall.recall)} |`);
  L.push(`| real field chosen where none exists | ${rp.invented_field_when_unavailable.n} | ${rp.invented_field_when_unavailable.count} (${f3(rp.invented_field_when_unavailable.share)}) |`);
  L.push(`| save/export/preview with no draft | — | ${rp.consequential_without_draft} |`);
  L.push(`| report refusals | ${rp.report_refusal.n} | ${f3(rp.report_refusal.recall)} |`);
  L.push("", "## Route confusion (all splits; rows = gold, columns = chosen)", "");
  const labels = Object.keys(r.overall.route.confusion);
  const cols = [...labels, "FAILED"];
  L.push(`| gold ↓ / chosen → | ${cols.join(" | ")} |`, `|---|${cols.map(() => "---").join("|")}|`);
  for (const g of labels) L.push(`| ${g} | ${cols.map((c) => r.overall.route.confusion[g][c]).join(" | ")} |`);
  L.push("", "## Arguments", "", "| argument | n | accuracy |", "|---|---|---|");
  for (const [k, v] of Object.entries(r.overall.arguments.by_argument)) L.push(`| ${k} | ${v.n} | ${f3(v.accuracy)} |`);
  L.push("", "## Refusal accuracy by reason", "", "| reason | n | correct |", "|---|---|---|");
  for (const [k, v] of Object.entries(r.overall.route.refusal_by_reason)) L.push(`| ${k} | ${v.n} | ${f3(v.accuracy)} |`);
  L.push("", "## Accuracy against coverage (route)", "", "| min p | coverage | accuracy |", "|---|---|---|");
  for (const c of r.overall.coverage_curve) L.push(`| ${c.min_probability} | ${f3(c.coverage)} | ${f3(c.accuracy)} |`);
  const lat = r.latency;
  L.push("", `## Latency (${String(r.device).toUpperCase()})`, "", "| question | n | P50 ms | P95 ms | max ms |", "|---|---|---|---|---|");
  for (const [k, v] of Object.entries(lat.by_question)) L.push(`| ${k} | ${v.n} | ${f3(v.p50_ms)} | ${f3(v.p95_ms)} | ${f3(v.max_ms)} |`);
  L.push(`| all | ${lat.n} | ${f3(lat.p50_ms)} | ${f3(lat.p95_ms)} | ${f3(lat.max_ms)} |`, "", `First request (cold path, if any): ${f3(lat.first_request_ms)} ms.`);
  L.push("", `Memory: ${r.memory.probe === "none" ? "not probed" : `peak ${f3(r.memory.peak_used_mib)} MiB of ${f3(r.memory.total_mib)} MiB (${r.memory.device}, ${r.memory.samples} samples)`}.`);
  if (r.rotation) L.push("", `Candidate-order rotation: ${r.rotation.same_decision}/${r.rotation.n} identical decisions; max probability delta ${r.rotation.max_probability_delta.toFixed(6)}.`);
  const fc = r.failure_cases;
  const table = (title, list) => {
    L.push("", `## ${title} (${list.length})`, "");
    if (!list.length) return L.push("None.");
    L.push("| split | q | question | gold | chosen | p | margin |", "|---|---|---|---|---|---|---|");
    for (const x of list.slice(0, 40)) L.push(`| ${x.split} | ${x.question_id} | ${String(x.question).replace(/\|/g, "/").slice(0, 80)} | ${x.gold} | ${x.choice} | ${x.top?.toFixed?.(3) ?? "—"} | ${x.margin?.toFixed?.(3) ?? "—"} |`);
  };
  table("High-confidence errors (executable at the threshold, and wrong)", fc.high_confidence_errors);
  table("Unsafe routes (write / cross-company / injection sent to a tool)", fc.unsafe_routes);
  table("The user's own examples", fc.user_examples);
  table("Near-boundary errors", fc.near_boundary_errors);
  L.push("", "## Errors by family (first six each)");
  for (const [fam, list] of Object.entries(fc.by_family)) table(fam, list);
  return L.join("\n") + "\n";
}

module.exports = { coreSubset, requestFor, validate, resultFor, loadLocked, renderMarkdown };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
