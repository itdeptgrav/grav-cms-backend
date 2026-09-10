// services/merchandising/departmentStatus.service.js
//
// READING WHAT THE EIGHT DEPARTMENTS HAVE SAID — AND SAYING SO WHEN THEY
// HAVE NOT.
//
// Reads only. There is no export here that writes a projection, and there is
// no route that could reach one if there were: the single writer is
// `departmentStatusIntake.service.js`, applying an event the owning
// application published.
//
// ── ALL EIGHT DEPARTMENTS ALWAYS RENDER ─────────────────────────────────────
// The register returns a row for every department whether or not it has said
// anything, because the answer to "what does Store say" is never nothing. A
// missing row would leave a gap on the screen, and a gap reads as fine. A
// department with no statement comes back `UNKNOWN`, carrying the sentence
// *"Not yet reported by Store"* — which is a fact somebody can act on.
//
// ── AND FRESHNESS IS DERIVED, NEVER STORED ──────────────────────────────────
// A stored freshness would be wrong the day after it was written. `STALE` is
// displayed and never acted on: a stale status is still the source's status,
// and Merchandising does not expire another department's fact.
"use strict";

const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const contract = require("./departmentStatus.contract");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

async function loadFile(ctx, fileId) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId }).lean();
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  return file;
}

/** One projection, as a screen reads it. */
function rowView(department, projection, now) {
  const words = contract.DEPARTMENT_WORDS[department] || department;

  if (!projection) {
    /* ── THE HONEST DEFAULT ──────────────────────────────────────────────
       Silence from an app that could report is UNKNOWN — somebody is late.
       Silence from an app with no integration at all is UNAVAILABLE — nobody
       is late. Both are stated; neither is a blank, a zero or a tick. */
    const availability = contract.isIntegrated(department)
      ? contract.AVAILABILITY.UNKNOWN
      : contract.AVAILABILITY.UNAVAILABLE;
    return {
      department,
      departmentLabel: words,
      availability,
      sentence: contract.availabilitySentence(department, availability),
      statusCode: null,
      statusLabel: "",
      sourceApp: "",
      sourceRecordType: "",
      sourceRecordRef: "",
      sourceRecordVersion: null,
      unitDiscriminator: "",
      sourceObservedAt: null,
      receivedAt: null,
      freshness: null,
      /* Said on every row, so nothing here can read as a Merchandising
         statement about another department. */
      attribution: `as reported by ${words}`,
    };
  }

  const availability = str(projection.availability) || contract.AVAILABILITY.AVAILABLE;
  return {
    department,
    departmentLabel: words,
    availability,
    sentence: contract.availabilitySentence(department, availability),
    statusCode: str(projection.statusCode) || null,
    statusLabel: str(projection.statusLabel),
    sourceApp: str(projection.sourceApp),
    sourceRecordType: str(projection.sourceRecordType),
    sourceRecordRef: str(projection.sourceRecordRef),
    sourceRecordVersion: projection.sourceRecordVersion ?? null,
    unitDiscriminator: str(projection.unitDiscriminator),
    sourceObservedAt: projection.sourceObservedAt || null,
    receivedAt: projection.receivedAt || null,
    freshness: contract.freshnessOf(projection.sourceObservedAt, now),
    attribution: `as reported by ${words}`,
  };
}

/**
 * Every department's current position on one file.
 *
 * Always eight rows. A department may hold several current projections when
 * different source records speak about different units; the register shows the
 * most recently observed as the department's line and says how many others
 * there are, rather than silently choosing one.
 */
async function register(ctx, { fileId } = {}) {
  const file = await loadFile(ctx, fileId);
  const now = new Date();

  const current = await DepartmentStatusProjection.find({
    companyId: ctx.companyId, fileId: file._id, isCurrent: true,
  }).sort({ sourceObservedAt: -1 }).lean();

  const byDepartment = new Map();
  const extras = new Map();
  for (const p of current) {
    if (!byDepartment.has(p.department)) byDepartment.set(p.department, p);
    else extras.set(p.department, (extras.get(p.department) || 0) + 1);
  }

  const rows = contract.DEPARTMENTS.map((d) => ({
    ...rowView(d, byDepartment.get(d) || null, now),
    otherCurrentRecords: extras.get(d) || 0,
  }));

  const counted = (a) => rows.filter((r) => r.availability === a).length;

  return {
    rows,
    counts: {
      available: counted(contract.AVAILABILITY.AVAILABLE),
      unknown: counted(contract.AVAILABILITY.UNKNOWN),
      unavailable: counted(contract.AVAILABILITY.UNAVAILABLE),
      notApplicable: counted(contract.AVAILABILITY.NOT_APPLICABLE),
      total: rows.length,
    },
    /* Carried in the payload, not only in the UI, so a second client cannot
       render this register as a completion checklist. */
    disclaimer: "Source department status is context, not a Merchandising submission gate. "
      + "Each department owns and states its own position.",
    generatedAt: now,
  };
}

/** One department's history on one file, newest first. */
async function history(ctx, { fileId, department, cursor, limit } = {}) {
  const file = await loadFile(ctx, fileId);
  const dept = str(department).toUpperCase();
  if (!contract.isDepartment(dept)) {
    throw fail("NOT_FOUND", `"${department}" is not a department this register holds.`,
      { departments: contract.DEPARTMENTS });
  }
  const size = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_LIMIT, MAX_LIMIT);

  const query = { companyId: ctx.companyId, fileId: file._id, department: dept };
  if (str(cursor)) {
    const at = new Date(Number(cursor));
    if (Number.isNaN(at.getTime())) {
      throw fail("VALIDATION", "That page marker is not one this list issued.", { field: "cursor" });
    }
    query.sourceObservedAt = { $lt: at };
  }

  const rows = await DepartmentStatusProjection.find(query)
    .sort({ sourceObservedAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);
  const now = new Date();

  return {
    department: dept,
    departmentLabel: contract.DEPARTMENT_WORDS[dept],
    rows: page.map((p) => ({
      ...rowView(dept, p, now),
      isCurrent: p.isCurrent === true,
      projectionRef: str(p.projectionRef),
    })),
    nextCursor: rows.length > size
      ? String(new Date(page[page.length - 1].sourceObservedAt).getTime())
      : null,
    hasMore: rows.length > size,
  };
}

/** The one-line summary the file Summary shows beside the pack. */
async function summary(ctx, { fileId } = {}) {
  const { counts } = await register(ctx, { fileId });
  return { counts };
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, rowView, register, history, summary };
