// services/merchandising/bulk.service.js
//
// FORTY THINGS AT ONCE, PREVIEWED FIRST, WITH FORTY ANSWERS BACK.
//
// ── THE TWO LIES THIS SERVICE EXISTS TO PREVENT ─────────────────────────────
//
// The first is the all-or-nothing lie. A bulk operation that reports success
// or failure for the whole batch tells somebody nothing about the eleven rows
// that were refused, and tells them wrongly about the twenty-nine that
// worked. Every row here carries its own outcome and its own reason, a refused
// row never discards an applied one, and the summary counts all three states
// separately.
//
// The second is the moved-underneath lie. If apply recomputed the rows, a
// person could read forty outcomes, click apply, and have forty different
// things happen because a file changed in between. So the preview is a RECORD
// with a checksum of the state it was computed against, and apply against a
// moved source is refused with `BULK_PREVIEW_STALE` rather than silently
// applying to something else. It is M5's `TNA_IMPACT_STALE` rule, at scale.
//
// ── EVERY COMMAND DELEGATES ─────────────────────────────────────────────────
// Not one row is applied by logic written here. Each command calls the service
// that owns the record — `execution.assignFile`, `tnaPlan.updateForecast`,
// `executionPack.submitPack` — so every guard, every capability check, every
// audit row and every immutability rule those services enforce applies to the
// four-hundredth row exactly as it does to a single one. A bulk path that
// reimplemented them would be a second, unreviewed way to change the same
// records.
//
// ── AND IT IS NOT A QUEUE ───────────────────────────────────────────────────
// Apply runs the rows in the request that asked for it. Nothing is enqueued,
// nothing is drained, and there is no worker. A 500-row cap is what keeps that
// honest: past that, a request is refused with the number in it rather than
// quietly becoming a background job nobody can see.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  BulkOperation, BULK_COMMAND, BULK_COMMANDS, ROW_OUTCOME, MAX_ROWS, PREVIEW_TTL_MINUTES,
} = require("../../models/CMS_Models/Merchandising/BulkOperation");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

const isCommand = (c) => BULK_COMMANDS.includes(str(c));

/**
 * Which capability each command needs.
 *
 * Doing forty at once is not a larger authority than doing one — it is the
 * same authority applied more times. So each command asks for exactly what its
 * single-record equivalent asks for, and the route reads this map rather than
 * inventing a "bulk" capability that would be a way around the real ones.
 */
const COMMAND_CAPABILITY = Object.freeze({
  [BULK_COMMAND.ASSIGNMENT]: "merchandising.file.assign",
  [BULK_COMMAND.FORECAST]: "merchandising.tna.execute",
  [BULK_COMMAND.RESCHEDULE]: "merchandising.tna.manage",
  [BULK_COMMAND.CHANGE_COORDINATION]: "merchandising.change.coordinate",
  [BULK_COMMAND.DOWNSTREAM_SUBMIT]: "merchandising.handover.submit",
  [BULK_COMMAND.IMPORT]: "merchandising.configuration.manage",
  [BULK_COMMAND.ARCHIVE]: "merchandising.configuration.manage",
});

const capabilityFor = (command) => COMMAND_CAPABILITY[str(command)] || null;

/* ── THE CHECKSUM ─────────────────────────────────────────────────────────
   What the preview was computed against. Apply recomputes it; a mismatch
   means the world moved and the person would be approving rows they never
   saw. Deliberately the RECORD's own revision, not a timestamp: a revision
   changes when the record changes, which is exactly the question. */
async function sourceChecksum(ctx, rows) {
  const ids = [...new Set(rows.map((r) => str(r?.fileId)).filter(isId))];
  if (!ids.length) return "no-source";
  const files = await ExecutionFile.find({ _id: { $in: ids }, companyId: ctx.companyId })
    .select("revision").sort({ _id: 1 }).lean();
  return crypto.createHash("sha256")
    .update(files.map((f) => `${f._id}:${f.revision ?? 0}`).join("|"))
    .digest("hex");
}

function assertRows(rows, command) {
  if (!Array.isArray(rows) || !rows.length) {
    throw fail("VALIDATION", "Send the rows this command applies to.", { field: "rows" });
  }
  if (rows.length > MAX_ROWS) {
    /* Refused with the number in it. A silent truncation would report success
       for a batch that was mostly ignored. */
    throw fail("BULK_LIMIT_EXCEEDED",
      `A bulk ${command} takes at most ${MAX_ROWS} rows at a time; this one has ${rows.length}. `
      + "Split it rather than having part of it silently ignored.",
      { maximum: MAX_ROWS, received: rows.length });
  }
}

const summarise = (rows) => ({
  total: rows.length,
  applied: rows.filter((r) => r.outcome === ROW_OUTCOME.APPLIED).length,
  skipped: rows.filter((r) => r.outcome === ROW_OUTCOME.SKIPPED).length,
  refused: rows.filter((r) => r.outcome === ROW_OUTCOME.REFUSED).length,
});

/* ═══ PREVIEW ══════════════════════════════════════════════════════════════ */

/**
 * Work out what each row WOULD do, and store it.
 *
 * Writes nothing except the preview record itself — a claim the tests check by
 * counting every other collection before and after.
 */
async function preview(ctx, { command, rows, actor = null } = {}) {
  assertContext(ctx);
  if (!isCommand(command)) {
    throw fail("BULK_COMMAND_UNKNOWN", `"${command}" is not a bulk command.`,
      { allowed: BULK_COMMANDS });
  }
  assertRows(rows, command);

  const handler = HANDLERS[str(command)];
  const previewRows = [];
  for (let i = 0; i < rows.length; i += 1) {
    /* Each row is evaluated on its own. One malformed row must not stop the
       thirty-nine beside it from being previewed. */
    try {
      previewRows.push({ rowIndex: i, ...(await handler.check(ctx, rows[i])) });
    } catch (err) {
      previewRows.push({
        rowIndex: i,
        fileId: isId(rows[i]?.fileId) ? rows[i].fileId : null,
        ref: str(rows[i]?.ref),
        outcome: ROW_OUTCOME.REFUSED,
        reason: str(err?.message) || "That row could not be read.",
        detail: "",
      });
    }
  }

  const at = new Date();
  const [record] = await BulkOperation.create([{
    companyId: ctx.companyId,
    previewId: `BLK-${crypto.randomBytes(8).toString("hex")}`,
    command: str(command),
    state: "PREVIEWED",
    requestRows: rows,
    sourceChecksum: await sourceChecksum(ctx, rows),
    previewRows,
    summary: summarise(previewRows),
    previewedBy: actor || undefined,
    previewedAt: at,
    expiresAt: new Date(at.getTime() + PREVIEW_TTL_MINUTES * 60000),
  }]);

  return {
    previewId: record.previewId,
    command: record.command,
    expiresAt: record.expiresAt,
    summary: record.summary,
    rows: previewRows,
    /* `APPLIED` in a preview means "would apply". Said in the response so
       nobody reads a preview as a receipt. */
    note: "Nothing has been changed. These are the outcomes an apply would produce.",
  };
}

/* ═══ APPLY ════════════════════════════════════════════════════════════════ */

/**
 * Apply a preview, row by row, against the state it was computed from.
 *
 * Each row is its own operation with its own outcome. A partial failure is
 * REPORTED, not rolled back: thirty-nine successful assignments are not worth
 * discarding because the fortieth named a file somebody had closed.
 */
async function apply(ctx, { command, previewId, actor = null } = {}) {
  assertContext(ctx);
  if (!isCommand(command)) {
    throw fail("BULK_COMMAND_UNKNOWN", `"${command}" is not a bulk command.`, { allowed: BULK_COMMANDS });
  }
  if (!str(previewId)) {
    throw fail("VALIDATION",
      "Apply needs the previewId of the preview these rows came from. "
      + "Nothing is applied that nobody has looked at.",
      { field: "previewId" });
  }

  const record = await BulkOperation.findOne({
    companyId: ctx.companyId, previewId: str(previewId), command: str(command),
  });
  if (!record) throw fail("BULK_PREVIEW_NOT_FOUND", "That preview does not exist.");
  if (record.state === "APPLIED") {
    /* Not an error to retry — the answer already exists, so return it. */
    return {
      previewId: record.previewId, command: record.command,
      summary: record.summary, rows: record.resultRows,
      replayed: true, note: "This preview was already applied.",
    };
  }
  if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
    throw fail("BULK_PREVIEW_EXPIRED",
      "That preview has expired. Preview again so the outcomes are the ones you decide on.",
      { expiresAt: record.expiresAt });
  }

  /* ── HAS THE SOURCE MOVED? ────────────────────────────────────────────── */
  const now = await sourceChecksum(ctx, record.requestRows);
  if (now !== record.sourceChecksum) {
    throw fail("BULK_PREVIEW_STALE",
      "Something changed on these records after the preview was taken. Preview again, so what "
      + "you apply is what you were shown.",
      { previewId: record.previewId });
  }

  const handler = HANDLERS[str(command)];
  const resultRows = [];
  for (let i = 0; i < record.requestRows.length; i += 1) {
    const previewed = record.previewRows.find((r) => r.rowIndex === i);
    if (previewed && previewed.outcome !== ROW_OUTCOME.APPLIED) {
      /* A row the preview refused is not attempted. The person decided on
         these outcomes; silently retrying one is not applying what they saw. */
      resultRows.push({ ...previewed.toObject?.() ?? previewed });
      continue;
    }
    try {
      resultRows.push({ rowIndex: i, ...(await handler.run(ctx, record.requestRows[i], actor)) });
    } catch (err) {
      resultRows.push({
        rowIndex: i,
        fileId: isId(record.requestRows[i]?.fileId) ? record.requestRows[i].fileId : null,
        ref: str(record.requestRows[i]?.ref),
        outcome: ROW_OUTCOME.REFUSED,
        reason: str(err?.message) || "That row could not be applied.",
        detail: "",
      });
    }
  }

  const at = new Date();
  record.resultRows = resultRows;
  record.summary = summarise(resultRows);
  record.state = "APPLIED";
  record.appliedBy = actor || undefined;
  record.appliedAt = at;
  await record.save();

  /* ── ONE SUMMARY EVENT FOR THE COMMAND ────────────────────────────────
     Each applied row already produced its own audit row inside the service
     that applied it — this is the record that a BULK command happened, so
     "forty files were reassigned at once, by whom" is answerable without
     reading forty rows. */
  await MerchandisingAuditEvent.create([{
    companyId: ctx.companyId,
    recordType: "BULK_OPERATION",
    recordId: record._id,
    action: "BULK_APPLIED",
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId: crypto.randomUUID(),
    details: {
      command: record.command,
      previewId: record.previewId,
      ...record.summary,
    },
  }]);

  return {
    previewId: record.previewId, command: record.command,
    summary: record.summary, rows: resultRows,
    replayed: false,
    resultFileId: record.previewId,
  };
}

/* ═══ THE RESULT, AS CSV ═══════════════════════════════════════════════════ */

/**
 * Escape a CSV cell so a spreadsheet cannot execute it.
 *
 * A value starting `=`, `+`, `-` or `@` is a formula to Excel and Sheets, and
 * these cells carry REASONS written by services and, indirectly, by user
 * input. Prefixing a single quote is the standard neutralisation; the quoting
 * below handles commas, quotes and newlines.
 */
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const csvRow = (cells) => cells.map(csvCell).join(",");

async function resultCsv(ctx, { previewId } = {}) {
  assertContext(ctx);
  const record = await BulkOperation.findOne({
    companyId: ctx.companyId, previewId: str(previewId),
  }).lean();
  if (!record) throw fail("BULK_PREVIEW_NOT_FOUND", "That result does not exist.");

  const rows = record.state === "APPLIED" ? record.resultRows : record.previewRows;
  const lines = [csvRow(["row", "reference", "fileId", "outcome", "reason", "detail"])];
  for (const r of rows) {
    lines.push(csvRow([
      r.rowIndex + 1, r.ref || "", r.fileId ? String(r.fileId) : "",
      r.outcome, r.reason || "", r.detail || "",
    ]));
  }
  return {
    filename: `${record.command}-${record.previewId}.csv`,
    csv: lines.join("\r\n"),
    summary: record.summary,
    state: record.state,
  };
}

/* ═══ THE COMMANDS ═════════════════════════════════════════════════════════
   Each is two functions: `check` says what a row would do, `run` does it by
   calling the service that owns the record. Neither contains mutation logic
   of its own — see the header. */

const skip = (fileId, ref, reason) => ({
  fileId: fileId || null, ref: str(ref), outcome: ROW_OUTCOME.SKIPPED, reason, detail: "",
});
const refuse = (fileId, ref, reason) => ({
  fileId: fileId || null, ref: str(ref), outcome: ROW_OUTCOME.REFUSED, reason, detail: "",
});
const ok = (fileId, ref, detail) => ({
  fileId: fileId || null, ref: str(ref), outcome: ROW_OUTCOME.APPLIED, reason: "", detail: str(detail),
});

async function fileFor(ctx, row) {
  if (!isId(row?.fileId)) return null;
  return ExecutionFile.findOne({ _id: row.fileId, companyId: ctx.companyId }).lean();
}

const HANDLERS = Object.freeze({
  /* ── ASSIGNMENT ─────────────────────────────────────────────────────── */
  [BULK_COMMAND.ASSIGNMENT]: {
    async check(ctx, row) {
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      if (["CANCELLED", "CLOSED"].includes(str(file.lifecycleStatus))) {
        return skip(file._id, file.fileNumber,
          `The file is ${str(file.lifecycleStatus).toLowerCase()}.`);
      }
      if (!str(row?.email)) return refuse(file._id, file.fileNumber, "No merchandiser email given.");
      if (str(file.responsibleMerchandiser?.email) === str(row.email).toLowerCase()) {
        return skip(file._id, file.fileNumber, "Already the responsible merchandiser.");
      }
      return ok(file._id, file.fileNumber, `→ ${str(row.email)}`);
    },
    async run(ctx, row, actor) {
      const execution = require("./execution.service");
      const file = await fileFor(ctx, row);
      /* The owning service does the work, with its own live-grant check on
         the assignee and its own audit row. */
      await execution.assignFile(ctx, {
        id: str(row.fileId),
        body: {
          email: str(row.email), name: str(row.name),
          reason: str(row.reason) || "Bulk reassignment",
          expectedRevision: file.revision,
        },
        actor,
      });
      return ok(file._id, file.fileNumber, `→ ${str(row.email)}`);
    },
  },

  /* ── FORECAST ───────────────────────────────────────────────────────── */
  [BULK_COMMAND.FORECAST]: {
    async check(ctx, row) {
      const plans = require("./tnaPlan.service");
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
      const { plan } = await plans.loadPlan(ctx, str(row.fileId));
      const m = await TnaMilestone.findOne({
        companyId: ctx.companyId, planId: plan._id, milestoneRef: str(row.milestoneRef),
      }).lean();
      if (!m) return refuse(file._id, str(row.milestoneRef), "That milestone is not on this plan.");
      if (m.actualDate) {
        return skip(file._id, m.milestoneRef, `Already recorded on ${m.actualDate}.`);
      }
      return ok(file._id, m.milestoneRef, `${m.forecastDate || "—"} → ${str(row.forecastDate)}`);
    },
    async run(ctx, row, actor) {
      const plans = require("./tnaPlan.service");
      const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
      const current = await TnaMilestone.findOne({
        companyId: ctx.companyId, milestoneRef: str(row.milestoneRef),
      }).select("revision").lean();
      const out = await plans.updateForecast(ctx, {
        fileId: str(row.fileId),
        milestoneRef: str(row.milestoneRef),
        body: {
          forecastDate: row.forecastDate,
          expectedRevision: current?.revision ?? 0,
          note: str(row.note) || "Bulk forecast",
        },
        actor,
      });
      return ok(row.fileId, row.milestoneRef,
        `→ ${out.forecastDate}, ${out.cascaded.length} moved with it`);
    },
  },

  /* ── DOWNSTREAM SUBMIT ──────────────────────────────────────────────── */
  [BULK_COMMAND.DOWNSTREAM_SUBMIT]: {
    async check(ctx, row) {
      const pack = require("./executionPack.service");
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      const current = await pack.getPack(ctx, { fileId: str(row.fileId) });
      if (!current.pack || current.pack.state !== "DRAFT") {
        return skip(file._id, file.fileNumber, "There is no draft pack on this file to submit.");
      }
      const gates = current.liveCompleteness || current.pack.completeness;
      if (!gates?.allPassed) {
        /* Named, so a person can see WHICH gate — a bulk refusal that said
           only "not ready" would send them to open forty files. */
        const failed = (gates?.gates || []).filter((g) => !g.passed).map((g) => g.key);
        return refuse(file._id, file.fileNumber,
          `Not complete: ${failed.join(", ") || "gates not evaluated"}.`);
      }
      return ok(file._id, file.fileNumber, `version ${current.pack.packVersionNo}`);
    },
    async run(ctx, row, actor) {
      const pack = require("./executionPack.service");
      const delivery = require("../integration/executionPackDelivery.service");
      const current = await pack.getPack(ctx, { fileId: str(row.fileId) });
      const out = await pack.submitPack(ctx, {
        fileId: str(row.fileId),
        body: { declarationAcknowledged: true, expectedRevision: current.pack.revision },
        actor,
        idempotencyKey: `bulk-${crypto.randomBytes(6).toString("hex")}`,
      });
      await delivery.deliverPending({ companyId: ctx.companyId, limit: 10 });
      return ok(row.fileId, str(row.ref), `submitted version ${out.packVersionNo}`);
    },
  },

  /* ── CHANGE COORDINATION ────────────────────────────────────────────── */
  [BULK_COMMAND.CHANGE_COORDINATION]: {
    async check(ctx, row) {
      const change = require("./changeControl.service");
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      const { ChangeImpact } = require("../../models/CMS_Models/Merchandising/ChangeControl");
      const impact = await ChangeImpact.findOne({
        companyId: ctx.companyId, fileId: file._id, changeRef: str(row.changeRef),
      }).sort({ changeVersionNo: -1 }).lean();
      if (!impact) return refuse(file._id, str(row.changeRef), "That change has no assessed impact.");
      if (impact.state === "COORDINATED") {
        return skip(file._id, impact.impactRef, "Already announced.");
      }
      if (impact.state !== "ASSESSED") {
        return refuse(file._id, impact.impactRef, `The impact is ${impact.state.toLowerCase()}.`);
      }
      return ok(file._id, impact.impactRef,
        `→ ${(impact.affectedApplications || []).length} application(s)`);
    },
    async run(ctx, row, actor) {
      const change = require("./changeControl.service");
      const { ChangeImpact } = require("../../models/CMS_Models/Merchandising/ChangeControl");
      const impact = await ChangeImpact.findOne({
        companyId: ctx.companyId, fileId: row.fileId, changeRef: str(row.changeRef),
      }).sort({ changeVersionNo: -1 }).lean();
      const out = await change.coordinateImpact(ctx, {
        fileId: str(row.fileId), changeRef: str(row.changeRef),
        body: { expectedRevision: impact.revision },
        actor,
        idempotencyKey: `bulk-${crypto.randomBytes(6).toString("hex")}`,
      });
      return ok(row.fileId, out.impactRef, `announced to ${out.announcedTo}`);
    },
  },

  /* ── ARCHIVE ────────────────────────────────────────────────────────── */
  [BULK_COMMAND.ARCHIVE]: {
    async check(ctx, row) {
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      if (file.archived) return skip(file._id, file.fileNumber, "Already archived.");
      /* Only finished work is archivable. Archiving a live file would hide it
         from the register somebody is working from. */
      if (!["CLOSED", "HANDED_OVER", "CANCELLED"].includes(str(file.lifecycleStatus))) {
        return refuse(file._id, file.fileNumber,
          `A ${str(file.lifecycleStatus).toLowerCase()} file is still live work.`);
      }
      return ok(file._id, file.fileNumber, "would be hidden from the default register");
    },
    async run(ctx, row, actor) {
      const archive = require("./archive.service");
      const out = await archive.archiveFile(ctx, {
        fileId: str(row.fileId), reason: str(row.reason) || "Bulk archive", actor,
      });
      return ok(row.fileId, out.fileNumber, "archived; nothing deleted");
    },
  },

  /* ── IMPORT — configuration only ────────────────────────────────────── */
  [BULK_COMMAND.IMPORT]: {
    async check(ctx, row) {
      const kind = str(row?.kind).toUpperCase();
      if (kind !== "REASON_CODE") {
        /* Deliberately narrow. Importing orders or selections would create
           records with no author, no approval and no source — every one of
           which the rest of this module refuses to produce. */
        return refuse(null, str(row?.code),
          "Only reason codes can be imported. Orders and selections are created by the "
          + "applications that own them.");
      }
      if (!str(row?.code) || !str(row?.label)) {
        return refuse(null, str(row?.code), "A reason code needs a code and a label.");
      }
      if (!["BLOCK", "RESCHEDULE"].includes(str(row?.kindOf).toUpperCase())) {
        return refuse(null, str(row.code), "A reason code is for BLOCK or RESCHEDULE.");
      }
      return ok(null, str(row.code), `${str(row.kindOf).toUpperCase()} · ${str(row.label)}`);
    },
    async run(ctx, row) {
      const config = require("./tnaConfig.service");
      await config.upsertReasonCode(ctx, {
        body: { code: row.code, label: row.label, kind: str(row.kindOf).toUpperCase() },
      });
      return ok(null, str(row.code), "imported");
    },
  },

  /* ── RESCHEDULE ─────────────────────────────────────────────────────── */
  [BULK_COMMAND.RESCHEDULE]: {
    async check(ctx, row) {
      const plans = require("./tnaPlan.service");
      const file = await fileFor(ctx, row);
      if (!file) return refuse(row?.fileId, row?.ref, "That execution file is not in this company.");
      try {
        const out = await plans.previewReschedule(ctx, {
          fileId: str(row.fileId),
          body: {
            milestoneRef: str(row.milestoneRef),
            proposedDate: row.proposedDate,
            reasonCode: str(row.reasonCode),
            reasonNote: str(row.reasonNote),
          },
          actor: null,
        });
        const r = out.reschedule;
        return {
          ...ok(file._id, r.rescheduleRef,
            `${r.impact.affected.length} milestone(s) move`),
          /* Flagged, not hidden: a row that would break a commitment needs a
             person to see that before they apply forty of them. */
          reason: r.createsBaselineRevision
            ? "This row would break a committed delivery date and re-commit the plan."
            : "",
        };
      } catch (err) {
        return refuse(file._id, str(row.milestoneRef), str(err?.message));
      }
    },
    async run(ctx, row, actor) {
      const plans = require("./tnaPlan.service");
      const out = await plans.previewReschedule(ctx, {
        fileId: str(row.fileId),
        body: {
          milestoneRef: str(row.milestoneRef), proposedDate: row.proposedDate,
          reasonCode: str(row.reasonCode), reasonNote: str(row.reasonNote),
        },
        actor,
      });
      /* ── A BREACHING ROW IS NOT APPLIED IN BULK ────────────────────────
         M5's rule is that a reschedule which re-commits the plan is approved
         by somebody other than the requester. Forty of them approved by one
         person in one click would be that rule deleted, so those rows stop at
         a request and a human approves each. */
      if (out.reschedule.createsBaselineRevision) {
        return skip(row.fileId, out.reschedule.rescheduleRef,
          "Requested. It breaks a committed date, so it needs a separate approver.");
      }
      const applied = await plans.approveReschedule(ctx, {
        fileId: str(row.fileId), rescheduleRef: out.reschedule.rescheduleRef,
        body: {}, actor,
        idempotencyKey: `bulk-${crypto.randomBytes(6).toString("hex")}`,
      });
      return ok(row.fileId, out.reschedule.rescheduleRef, str(applied.note));
    },
  },
});

module.exports = {
  BULK_COMMAND, BULK_COMMANDS, MAX_ROWS, PREVIEW_TTL_MINUTES, ROW_OUTCOME,
  COMMAND_CAPABILITY, capabilityFor, isCommand,
  csvCell, csvRow, sourceChecksum, summarise,
  preview, apply, resultCsv, HANDLERS,
};
