// services/industrialEngineering/departmentStandards.service.js
//
// IE's department standards — read, write, and the arithmetic every reader
// shares (capacity from the standard, minutes and days a quantity needs).
"use strict";

const IeDepartmentStandard = require("../../models/CMS_Models/IndustrialEngineering/IeDepartmentStandard");
const { DEPARTMENTS } = require("../../models/CMS_Models/PPC/PpcOrderTarget");
const { DEPARTMENT_META } = require("../ppc/orderTargets.evaluate");

class StandardError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Pieces a department can do in a day (and an hour) at its standard. Pure. */
function capacityOf(std) {
  if (!std || !std.samMinutesPerPiece || !std.operators || !std.hoursPerDay) return null;
  const availableMinutes = std.operators * std.hoursPerDay * 60;
  const perDay = (availableMinutes * (std.efficiencyPct || 100) / 100) / std.samMinutesPerPiece;
  return {
    availableMinutesPerDay: Math.round(availableMinutes),
    perDay: Math.max(1, Math.round(perDay)),
    perHour: Math.max(1, Math.round(perDay / std.hoursPerDay)),
  };
}

/** How long `pieces` take at this standard: minutes of work, working days, hours. Pure. */
function timeFor(pieces, std) {
  const cap = capacityOf(std);
  if (!cap || !pieces) return null;
  const minutes = pieces * std.samMinutesPerPiece;
  const days = pieces / cap.perDay;
  return {
    workMinutes: Math.round(minutes),
    minDays: Math.max(1, Math.ceil(days - 1e-9)),
    exactDays: Math.round(days * 100) / 100,
    hours: Math.round((days * std.hoursPerDay) * 10) / 10,
  };
}

/* Which batch figures each department's standard carries (the CMS's
   lib/production/stageProfiles.mjs names the same, with its words). */
const BATCH_FIELDS = Object.freeze({
  cutting: ["machines", "perBatch", "minutesPerBatch"],
  washing: ["machines", "perBatch", "minutesPerBatch"],
  embroidery: ["machines", "perBatch", "minutesPerBatch"],
  packaging: ["perBatch"],
});
const FIELD_WORDS = { machines: "Machines (tables)", perBatch: "Pieces per batch", minutesPerBatch: "Minutes per batch" };

/* A department's batch figures, complete or null — PPC fills its plan only
   from a complete set. Cutting's first-version field is read as its batch. */
function batchOf(doc, department = doc?.department) {
  const need = BATCH_FIELDS[department];
  if (!need || !doc) return null;
  let b = doc.batch;
  if (!b && department === "cutting" && doc.cutting) b = { machines: doc.cutting.tables, perBatch: doc.cutting.garmentsPerLay, minutesPerBatch: doc.cutting.minutesPerLay };
  if (!b || !need.every((k) => b[k] > 0)) return null;
  return Object.fromEntries(need.map((k) => [k, b[k]]));
}

const publicRow = (department, doc) => ({
  department,
  ...DEPARTMENT_META[department],
  set: Boolean(doc),
  samMinutesPerPiece: doc?.samMinutesPerPiece ?? null,
  operators: doc?.operators ?? null,
  hoursPerDay: doc?.hoursPerDay ?? null,
  efficiencyPct: doc?.efficiencyPct ?? null,
  notes: doc?.notes || "",
  batch: batchOf(doc, department),
  capacity: doc ? capacityOf(doc) : null,
  updatedBy: doc?.updatedBy?.name || "",
  updatedAt: doc?.updatedAt || null,
  history: (doc?.history || []).slice(-10).reverse(),
});

async function list(companyId) {
  const docs = await IeDepartmentStandard.find({ companyId }).lean();
  const byDept = new Map(docs.map((d) => [d.department, d]));
  return DEPARTMENTS.map((d) => publicRow(d, byDept.get(d) || null));
}

/** The standard for one department, or null. */
async function standardFor(companyId, department) {
  const doc = await IeDepartmentStandard.findOne({ companyId, department }).lean();
  return doc ? { ...doc, capacity: capacityOf(doc) } : null;
}

/** All standards for a company, keyed by department. */
async function standardsFor(companyId) {
  const docs = await IeDepartmentStandard.find({ companyId }).lean();
  return new Map(docs.map((d) => [d.department, { ...d, capacity: capacityOf(d) }]));
}

function validate(body, department) {
  const b = body || {};
  const num = (k, label, min, max, integer = false) => {
    const v = Number(b[k]);
    if (b[k] === "" || b[k] == null || !Number.isFinite(v)) throw new StandardError(400, `${label} is required.`);
    if (v < min || v > max) throw new StandardError(400, `${label} must be between ${min} and ${max}.`);
    if (integer && v !== Math.floor(v)) throw new StandardError(400, `${label} must be a whole number.`);
    return v;
  };
  return {
    samMinutesPerPiece: num("samMinutesPerPiece", "SAM (minutes per piece)", 0.01, 600),
    operators: num("operators", "Operators", 1, 2000, true),
    hoursPerDay: num("hoursPerDay", "Hours per day", 0.5, 24),
    efficiencyPct: num("efficiencyPct", "Efficiency %", 1, 150),
    notes: String(b.notes || "").trim().slice(0, 500),
    ...(BATCH_FIELDS[department] ? { batch: validateBatch(b.batch, BATCH_FIELDS[department]) } : {}),
  };
}

/* All of a department's batch figures or none: half of them cannot be
   planned from. */
function validateBatch(c, need) {
  if (c == null) return null;
  const limits = { machines: [1, 200], perBatch: [1, 20000], minutesPerBatch: [1, 1440] };
  const given = need.filter((k) => c[k] !== "" && c[k] != null);
  if (!given.length) return null;
  if (given.length < need.length) throw new StandardError(400, `${need.map((k) => FIELD_WORDS[k]).join(", ")} are set together. Enter all of them, or leave them all blank.`);
  const out = {};
  for (const k of need) {
    const v = Number(c[k]); const [min, max] = limits[k];
    if (!Number.isFinite(v) || v < min || v > max || v !== Math.floor(v)) throw new StandardError(400, `${FIELD_WORDS[k]} must be a whole number between ${min} and ${max}.`);
    out[k] = v;
  }
  return out;
}

async function upsert(companyId, department, body, actor) {
  if (!DEPARTMENTS.includes(department)) throw new StandardError(404, "No such department.");
  const values = validate(body, department);
  const now = new Date();
  const existing = await IeDepartmentStandard.findOne({ companyId, department });
  if (existing) {
    const changed = ["samMinutesPerPiece", "operators", "hoursPerDay", "efficiencyPct"].some((k) => existing[k] !== values[k]);
    if (changed) existing.history.push({ at: existing.updatedAt || now, by: existing.updatedBy, samMinutesPerPiece: existing.samMinutesPerPiece, operators: existing.operators, hoursPerDay: existing.hoursPerDay, efficiencyPct: existing.efficiencyPct });
    Object.assign(existing, values, { updatedBy: actor });
    await existing.save();
    return publicRow(department, existing.toObject());
  }
  const doc = await IeDepartmentStandard.create({ companyId, department, ...values, updatedBy: actor });
  return publicRow(department, doc.toObject());
}

module.exports = { list, standardFor, standardsFor, upsert, capacityOf, batchOf, BATCH_FIELDS, timeFor, StandardError, _validate: validate };
