// services/merchandising/archive.service.js
//
// ARCHIVING HIDES. IT NEVER DELETES.
//
// A company that has run for three years has thousands of finished execution
// files, and a register that lists all of them is a register nobody can use.
// Archiving takes them out of the DEFAULT view and does nothing else: the
// record is untouched, every audit event stays, every version stays, the file
// opens by direct reference, and it still exports.
//
// ── WHY THERE IS NO DELETE, AT ALL ──────────────────────────────────────────
// Not a soft delete, not a purge, not a retention job that removes rows. An
// execution file is the record of a commercial commitment and everything the
// company did about it; a deleted one takes an audit trail with it, and audit
// trails are the thing you need precisely when somebody is asking what
// happened. `archived: true` is a filter flag and that is the whole mechanism.
//
// ── AND WHY RESTORING IS ORDINARY ───────────────────────────────────────────
// Because nothing was destroyed, un-archiving is just clearing the flag. That
// is what makes archiving safe to do in bulk: the worst outcome of archiving
// the wrong file is that somebody has to tick a box to bring it back.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  MerchandisingAuditEvent,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/** Only finished work is archivable — see `eligible` for why. */
const ARCHIVABLE_LIFECYCLE = Object.freeze(["CLOSED", "HANDED_OVER", "CANCELLED"]);

/** The default, and it is configuration rather than a constant in a query. */
const DEFAULT_RETENTION_DAYS = 180;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * Which files could be archived, and why each one qualifies.
 *
 * A preview, deliberately: bulk archival goes through the same preview-first
 * contract as every other bulk command, so nobody hides two hundred files
 * without seeing which two hundred.
 */
async function eligible(ctx, { olderThanDays, limit = 100 } = {}) {
  assertContext(ctx);
  const days = Number.isFinite(Number(olderThanDays))
    ? Number(olderThanDays) : DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86400000);

  const rows = await ExecutionFile.find({
    companyId: ctx.companyId,
    archived: { $ne: true },
    /* Finished work only. A live file removed from the register is a file
       somebody is looking for and cannot find. */
    lifecycleStatus: { $in: ARCHIVABLE_LIFECYCLE },
    updatedAt: { $lt: cutoff },
  }).sort({ updatedAt: 1 }).limit(Math.min(Number(limit) || 100, 500))
    .select("fileNumber lifecycleStatus updatedAt handoverRef currentExecutionProjection").lean();

  return {
    olderThanDays: days,
    cutoff,
    rows: rows.map((f) => ({
      fileId: str(f._id),
      fileNumber: str(f.fileNumber),
      lifecycleStatus: str(f.lifecycleStatus),
      orderRef: str(f.currentExecutionProjection?.orderRef) || str(f.handoverRef),
      buyerDisplayLabel: str(f.currentExecutionProjection?.buyerDisplayLabel),
      lastActivity: f.updatedAt || null,
    })),
    note: "Archiving removes these from the default register. Nothing is deleted, every audit "
      + "event stays, and each file still opens by reference and still exports.",
  };
}

/** Hide one file. Everything about it survives. */
async function archiveFile(ctx, { fileId, reason = "", actor = null } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");

  if (!ARCHIVABLE_LIFECYCLE.includes(str(file.lifecycleStatus))) {
    throw fail("VALIDATION",
      `A ${str(file.lifecycleStatus).toLowerCase()} file is still live work and cannot be archived.`,
      { lifecycleStatus: file.lifecycleStatus, archivable: ARCHIVABLE_LIFECYCLE });
  }
  if (file.archived) {
    return { fileId: str(file._id), fileNumber: str(file.fileNumber), archived: true, alreadyArchived: true };
  }

  const at = new Date();
  file.archived = true;
  file.archivedAt = at;
  file.archivedReason = str(reason).slice(0, 500);
  file.revision += 1;
  await file.save();

  await MerchandisingAuditEvent.create([{
    companyId: ctx.companyId,
    recordType: "EXECUTION_FILE",
    recordId: file._id,
    recordRevision: file.revision,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    action: "RECORD_ARCHIVED",
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId: crypto.randomUUID(),
    reason: str(reason),
    details: { lifecycleStatus: str(file.lifecycleStatus), archived: true },
  }]);

  return { fileId: str(file._id), fileNumber: str(file.fileNumber), archived: true };
}

/** Bring one back. Nothing was destroyed, so this is just the flag. */
async function restoreFile(ctx, { fileId, reason = "", actor = null } = {}) {
  assertContext(ctx);
  if (!isId(fileId)) throw fail("NOT_FOUND", "Execution file not found.");
  const file = await ExecutionFile.findOne({ _id: fileId, companyId: ctx.companyId });
  if (!file) throw fail("NOT_FOUND", "Execution file not found.");
  if (!file.archived) {
    return { fileId: str(file._id), fileNumber: str(file.fileNumber), archived: false };
  }

  const at = new Date();
  file.archived = false;
  file.archivedAt = null;
  file.archivedReason = "";
  file.revision += 1;
  await file.save();

  await MerchandisingAuditEvent.create([{
    companyId: ctx.companyId,
    recordType: "EXECUTION_FILE",
    recordId: file._id,
    recordRevision: file.revision,
    fileId: file._id,
    fileNumber: str(file.fileNumber),
    action: "RECORD_ARCHIVED",
    actor: actor || undefined,
    source: "merchandising",
    at,
    correlationId: crypto.randomUUID(),
    reason: str(reason),
    details: { archived: false, restored: true },
  }]);

  return { fileId: str(file._id), fileNumber: str(file.fileNumber), archived: false };
}

module.exports = {
  ARCHIVABLE_LIFECYCLE, DEFAULT_RETENTION_DAYS,
  eligible, archiveFile, restoreFile,
};
