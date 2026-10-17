// services/production/orderSimulationRuns.js
//
// The rules for the Order simulation's history (3 Oct 2026), kept apart from
// the router so they can be tested without a database: what a saved run must
// carry, how its report is packed, and who may rename or delete it.

const zlib = require("zlib");

/** A report over this, as JSON, is refused: a very long order on a big floor is ~6 MB. */
const MAX_REPORT_BYTES = 25 * 1024 * 1024;
/** The summary and the inputs are small; anything bigger is not what the page sends. */
const MAX_SMALL_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_NOTE = 2000;

const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** The report as stored: gzip of its JSON, and the raw size. */
function packReport(report) {
  const json = JSON.stringify(report);
  const bytes = Buffer.byteLength(json, "utf8");
  return { buffer: zlib.gzipSync(json), bytes };
}

/** The stored report back as an object (null when there is none). */
function unpackReport(buffer) {
  if (!buffer || !buffer.length) return null;
  return JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
}

/**
 * A run to save, from the page's request body — or { error } in words.
 * The report must look like an order simulation report (meta, A, B); the
 * summary and inputs are kept as given, bounded in size.
 */
function runFromBody(body = {}) {
  const report = body.report;
  if (!report || typeof report !== "object" || !report.meta || !report.A || !report.B) {
    return { error: "There is no simulation report to save." };
  }
  const reportBytes = bytesOf(report);
  if (reportBytes > MAX_REPORT_BYTES) return { error: `The report is ${Math.round(reportBytes / 1048576)} MB — too big to keep (the limit is ${MAX_REPORT_BYTES / 1048576} MB).` };
  const summary = body.summary && typeof body.summary === "object" ? body.summary : {};
  const inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : {};
  if (bytesOf(summary) > MAX_SMALL_BYTES || bytesOf(inputs) > MAX_SMALL_BYTES) return { error: "The run's summary or inputs are too big to keep." };
  const product = body.product && typeof body.product === "object" ? body.product : {};
  return {
    run: {
      name: text(body.name, MAX_NAME),
      note: text(body.note, MAX_NOTE),
      product: { id: text(product.id, 64), name: text(product.name || report.meta.product, 200) },
      quantity: num(body.quantity) ?? num(report.meta.quantity) ?? 0,
      lines: Array.isArray(body.lines) ? body.lines.slice(0, 12).map((l) => ({ id: text(l?.id, 64), name: text(l?.name, 80), day: num(l?.day) ?? 1, operators: num(l?.operators) ?? 0 })) : [],
      layoutVersion: num(body.layoutVersion),
      machines: num(body.machines),
      summary,
      inputs,
    },
    report,
  };
}

/** May this person rename or delete this run? Whoever ran it, or an administrator. */
function canChange(run, user) {
  if (!run || !user) return false;
  if (user.isAdmin) return true;
  const by = run.createdBy || {};
  return Boolean((by.id && String(by.id) === String(user.id)) || (by.email && user.email && by.email.toLowerCase() === String(user.email).toLowerCase()));
}

/** The changes a PATCH may make: a name and a note, nothing else. */
function editsFromBody(body = {}) {
  const out = {};
  if (body.name !== undefined) out.name = text(body.name, MAX_NAME);
  if (body.note !== undefined) out.note = text(body.note, MAX_NOTE);
  return out;
}

module.exports = { MAX_REPORT_BYTES, packReport, unpackReport, runFromBody, canChange, editsFromBody };
