// services/merchandising/export.service.js
//
// A CSV OF EXACTLY WHAT THE CALLER CAN ALREADY SEE.
//
// ── AN EXPORT IS NOT A WIDER READ ───────────────────────────────────────────
// Every export runs the same company-scoped query the register runs, with the
// same filters, and returns the same columns. It is a different FORMAT of a
// view somebody already has, not a back door to fields their screen does not
// show. Nothing here contains a rate, a cost, a margin, a supplier or a buyer
// contact — the same allowlist the registers have carried since M1 — and a
// test scans every column set for them.
//
// ── FORMULA INJECTION ───────────────────────────────────────────────────────
// A cell beginning `=`, `+`, `-` or `@` is executable in Excel and Sheets.
// These files carry reasons, notes and names that came from people, so a
// crafted note could otherwise run when a colleague opens the download. Every
// cell is neutralised with a leading apostrophe before quoting.
//
// ── AND IT IS BOUNDED ───────────────────────────────────────────────────────
// A hard row cap, and past it an explicit refusal with the number in it rather
// than a truncated file that looks complete. There is no background job: an
// export is generated in the request that asked for it, which is only honest
// while the cap keeps that fast.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const {
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const { ApprovalRegister } = require("../../models/CMS_Models/Merchandising/ApprovalRegister");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const { ChangeImpact } = require("../../models/CMS_Models/Merchandising/ChangeControl");
const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** Past this, a request is refused rather than quietly truncated. */
const MAX_EXPORT_ROWS = 10000;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * Neutralise a cell so a spreadsheet cannot execute it, then quote it.
 *
 * The leading-apostrophe prefix is the standard defence; the quoting handles
 * commas, quotes and newlines. Both matter — a reason containing a comma
 * would otherwise shift every column after it.
 */
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRow = (cells) => cells.map(csvCell).join(",");

/* ── THE EXPORTS ──────────────────────────────────────────────────────────
   Each is `{columns, load}`. Not one column below is a rate, a cost, a
   margin, a supplier or a buyer contact. */

const EXPORTS = Object.freeze({
  "execution-files": {
    title: "Order Execution register",
    columns: ["File", "Order", "Buyer", "Product", "Style", "Lifecycle", "Phase",
      "Responsible", "Pack version", "PPC state", "Archived", "Updated"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (!filters.includeArchived) q.archived = { $ne: true };
      if (str(filters.lifecycleStatus)) q.lifecycleStatus = str(filters.lifecycleStatus);
      if (str(filters.buyerRef)) q.buyerRef = str(filters.buyerRef);
      const rows = await ExecutionFile.find(q).sort({ updatedAt: -1 }).limit(MAX_EXPORT_ROWS + 1).lean();
      return { rows, cells: (f) => {
        const p = f.currentExecutionProjection || {};
        return [
          f.fileNumber, str(p.orderRef) || f.handoverRef, str(p.buyerDisplayLabel),
          str(p.productName), str(p.styleRef), f.lifecycleStatus, f.executionPhase,
          str(f.responsibleMerchandiser?.name), f.currentPackVersionNo ?? "",
          str(f.downstreamReceiptState), f.archived ? "yes" : "no", day(f.updatedAt),
        ];
      } };
    },
  },

  "tna-portfolio": {
    title: "Time & Action portfolio",
    columns: ["Milestone", "Code", "Owner", "Baseline", "Forecast", "Actual", "Status", "File"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (str(filters.status)) q.status = str(filters.status);
      if (str(filters.owner)) q.ownerDepartment = str(filters.owner);
      const rows = await TnaMilestone.find(q).sort({ forecastDate: 1 })
        .limit(MAX_EXPORT_ROWS + 1).lean();
      const files = await ExecutionFile.find({
        _id: { $in: [...new Set(rows.map((r) => str(r.fileId)))] }, companyId: ctx.companyId,
      }).select("fileNumber").lean();
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      return { rows, cells: (m) => [
        m.name, m.milestoneCode, m.ownerDepartment,
        m.baselineDate || "", m.forecastDate || "", m.actualDate || "",
        m.status, byFile.get(str(m.fileId)) || "",
      ] };
    },
  },

  "selection-revisions": {
    title: "Approved selection revisions",
    columns: ["Family", "File", "Revision", "State", "Approved", "Approved by", "Rows"],
    async load(ctx, filters) {
      const family = str(filters.family).toUpperCase();
      const models = { MATERIAL_TRIM: MaterialTrimRevision, PACKAGING: PackagingRevision, DEVELOPMENT: DevelopmentRevision };
      const chosen = family && models[family] ? [[family, models[family]]] : Object.entries(models);
      const out = [];
      for (const [name, Model] of chosen) {
        const q = { companyId: ctx.companyId };
        if (str(filters.state)) q.state = str(filters.state).toUpperCase();
        const rows = await Model.find(q).sort({ updatedAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
        out.push(...rows.map((r) => ({ ...r, __family: name })));
      }
      const files = await ExecutionFile.find({
        _id: { $in: [...new Set(out.map((r) => str(r.fileId)))] }, companyId: ctx.companyId,
      }).select("fileNumber").lean();
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      return { rows: out, cells: (r) => [
        r.__family, byFile.get(str(r.fileId)) || "", r.revisionNo, r.state,
        day(r.approvedAt), str(r.approvedBy?.name), (r.rows || []).length,
      ] };
    },
  },

  "approval-register": {
    title: "Approval register",
    columns: ["File", "Approval", "Category", "Owner", "Status", "Decided", "Required by"],
    async load(ctx) {
      const registers = await ApprovalRegister.find({ companyId: ctx.companyId }).lean();
      const files = await ExecutionFile.find({
        _id: { $in: registers.map((r) => r.fileId) }, companyId: ctx.companyId,
      }).select("fileNumber").lean();
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      const rows = [];
      for (const reg of registers) {
        for (const r of reg.rows || []) rows.push({ ...r, __file: byFile.get(str(reg.fileId)) || "" });
      }
      return { rows, cells: (r) => [
        r.__file, str(r.approvalRequirementRef), str(r.category), str(r.owningApplication),
        str(r.observation?.status), day(r.observation?.decidedAt), r.requiredByDate || "",
      ] };
    },
  },

  "department-status": {
    title: "Source department status",
    columns: ["File", "Department", "Status", "Source record", "Version", "Reported", "Current"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (filters.currentOnly !== false) q.isCurrent = true;
      if (str(filters.department)) q.department = str(filters.department).toUpperCase();
      const rows = await DepartmentStatusProjection.find(q)
        .sort({ sourceObservedAt: -1 }).limit(MAX_EXPORT_ROWS + 1).lean();
      const files = await ExecutionFile.find({
        _id: { $in: [...new Set(rows.map((r) => str(r.fileId)))] }, companyId: ctx.companyId,
      }).select("fileNumber").lean();
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      return { rows, cells: (r) => [
        byFile.get(str(r.fileId)) || "", r.department, r.statusCode,
        [str(r.sourceRecordType), str(r.sourceRecordRef)].filter(Boolean).join(" "),
        r.sourceRecordVersion ?? "", day(r.sourceObservedAt), r.isCurrent ? "yes" : "no",
      ] };
    },
  },

  "execution-packs": {
    title: "Execution packs",
    columns: ["File", "Version", "State", "Submitted", "Submitted by", "Declared", "Supersedes"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (str(filters.state)) q.state = str(filters.state).toUpperCase();
      const rows = await ExecutionPack.find(q).sort({ submittedAt: -1 })
        .limit(MAX_EXPORT_ROWS + 1).lean();
      const files = await ExecutionFile.find({
        _id: { $in: [...new Set(rows.map((r) => str(r.fileId)))] }, companyId: ctx.companyId,
      }).select("fileNumber").lean();
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      return { rows, cells: (p) => [
        byFile.get(str(p.fileId)) || "", p.packVersionNo, p.state,
        day(p.submittedAt), str(p.submittedBy?.name),
        p.declaration?.at ? "yes" : "no", p.supersedesPackVersionNo ?? "",
      ] };
    },
  },

  "change-cases": {
    title: "Change cases",
    columns: ["Change", "Version", "Kind", "File", "Impact state", "Decision",
      "Applications", "Assessed", "Coordinated"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (str(filters.state)) q.state = str(filters.state).toUpperCase();
      const impacts = await ChangeImpact.find(q).sort({ updatedAt: -1 })
        .limit(MAX_EXPORT_ROWS + 1).lean();
      const [files, notices] = await Promise.all([
        ExecutionFile.find({
          _id: { $in: [...new Set(impacts.map((i) => str(i.fileId)))] }, companyId: ctx.companyId,
        }).select("fileNumber").lean(),
        SalesChangeNotice.find({
          companyId: ctx.companyId, changeRef: { $in: impacts.map((i) => i.changeRef) },
        }).select("changeRef versionNo changeKind").lean(),
      ]);
      const byFile = new Map(files.map((f) => [str(f._id), f.fileNumber]));
      const byChange = new Map(notices.map((n) => [`${n.changeRef}:${n.versionNo}`, n]));
      return { rows: impacts, cells: (i) => [
        i.changeRef, i.changeVersionNo,
        str(byChange.get(`${i.changeRef}:${i.changeVersionNo}`)?.changeKind),
        byFile.get(str(i.fileId)) || "", i.state, str(i.decision),
        (i.affectedApplications || []).join(" "),
        day(i.assessedAt), day(i.coordinatedAt),
      ] };
    },
  },

  "audit-history": {
    title: "Audit history",
    columns: ["When", "File", "Record", "Action", "Actor", "Source", "Reason"],
    async load(ctx, filters) {
      const q = { companyId: ctx.companyId };
      if (str(filters.from)) q.at = { ...(q.at || {}), $gte: new Date(str(filters.from)) };
      if (str(filters.to)) q.at = { ...(q.at || {}), $lte: new Date(str(filters.to)) };
      if (str(filters.recordType)) q.recordType = str(filters.recordType).toUpperCase();
      const rows = await MerchandisingAuditEvent.find(q).sort({ at: -1 })
        .limit(MAX_EXPORT_ROWS + 1).lean();
      return { rows, cells: (e) => [
        e.at ? new Date(e.at).toISOString() : "", str(e.fileNumber), str(e.recordType),
        str(e.action), str(e.actor?.name), str(e.source), str(e.reason),
      ] };
    },
  },
});

const EXPORT_KEYS = Object.freeze(Object.keys(EXPORTS));

/**
 * Generate one export, and record that it happened.
 *
 * The audit row carries the FILTER that produced the file, so "who took what
 * out of the system, and what exactly did it contain" is answerable later.
 */
async function generate(ctx, { dataset, filters = {}, actor = null } = {}) {
  assertContext(ctx);
  const spec = EXPORTS[str(dataset)];
  if (!spec) {
    throw fail("REPORT_UNKNOWN", `"${dataset}" is not an export this app produces.`,
      { allowed: EXPORT_KEYS });
  }

  const { rows, cells } = await spec.load(ctx, filters);
  if (rows.length > MAX_EXPORT_ROWS) {
    /* Refused with the number in it. A truncated file that looks complete is
       worse than no file. */
    throw fail("EXPORT_TOO_LARGE",
      `That export would be over ${MAX_EXPORT_ROWS} rows. Narrow the filters — a truncated file `
      + "that looks complete is worse than none.",
      { maximum: MAX_EXPORT_ROWS, matched: rows.length });
  }

  const at = new Date();
  const lines = [csvRow(spec.columns)];
  for (const r of rows) lines.push(csvRow(cells(r)));

  await MerchandisingAuditEvent.create([{
    companyId: ctx.companyId,
    recordType: "EXECUTION_FILE",
    recordId: new mongoose.Types.ObjectId(),
    action: "EXPORT_GENERATED",
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId: crypto.randomUUID(),
    details: { dataset: str(dataset), rowCount: rows.length, filters },
  }]);

  return {
    dataset: str(dataset),
    title: spec.title,
    filename: `${str(dataset)}-${at.toISOString().slice(0, 10)}.csv`,
    csv: lines.join("\r\n"),
    rowCount: rows.length,
    generatedAt: at,
    generatedByName: str(actor?.name),
    filters,
  };
}

module.exports = { EXPORTS, EXPORT_KEYS, MAX_EXPORT_ROWS, csvCell, csvRow, generate };
