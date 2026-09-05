// services/storePurchase/actionHistory.service.js
//
// Store & Purchase — Chunk 1. THE RECORD OF WHAT WAS DONE.
//
// ── WHY A SERVICE AND NOT A MODEL CALL ──────────────────────────────────────
// If routes create history documents directly, the shape drifts: one route
// records a reason, another does not; one stores the whole request body,
// another a summary. Every entry here goes through one function that decides
// what is safe to keep.
//
// ── ATOMICITY, HONESTLY ─────────────────────────────────────────────────────
// A state change and its history entry should commit together. Mongo can do
// that with a transaction — on a replica set. The test harness
// (mongodb-memory-server) is a standalone and cannot, and this chunk has no
// way to assert what the live deployment is. So `recordWithState` TRIES a
// transaction and, where the deployment does not support one, falls back to
// writing the state change first and the history immediately after, marking
// the entry `atomicityDegraded` so the gap is visible and reconcilable rather
// than claimed away.
"use strict";

const mongoose = require("mongoose");

const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const { fail } = require("./errors");

/** Actions whose whole point is the explanation. */
const REASON_REQUIRED = new Set(["CANCELLED", "ADJUSTED", "OVERRIDDEN", "DELETED", "REVERSED"]);

/** Metadata is context, not a copy of the document. Bounded on the way in. */
const SAFE_METADATA_KEYS = 20;
const SAFE_STRING_LENGTH = 500;

function sanitiseMetadata(metadata = {}) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(metadata || {})) {
    if (n >= SAFE_METADATA_KEYS) break;
    if (v === null || v === undefined) continue;
    /* Scalars and short arrays of scalars only. An object here would be a
       payload creeping in through the one field that does not look like one. */
    if (typeof v === "string") out[k] = v.slice(0, SAFE_STRING_LENGTH);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x))) {
      out[k] = v.slice(0, 25);
    } else continue;
    n += 1;
  }
  return out;
}

function sanitiseChanges(changes = []) {
  return (Array.isArray(changes) ? changes : [])
    .slice(0, 50)
    .filter((c) => c && c.field)
    .map((c) => ({
      field: String(c.field).slice(0, 100),
      from: typeof c.from === "string" ? c.from.slice(0, SAFE_STRING_LENGTH) : c.from ?? null,
      to: typeof c.to === "string" ? c.to.slice(0, SAFE_STRING_LENGTH) : c.to ?? null,
    }));
}

/**
 * Append one entry.
 *
 * @param {object} ctx  tenant context — the company and actor come from here,
 *                      never from the caller's arguments, so a route cannot
 *                      write history against another company.
 */
async function record(ctx, entry, { session = null } = {}) {
  if (!ctx?.companyId) throw fail("VALIDATION", "History needs a tenant context.");
  if (!entry?.action) throw fail("VALIDATION", "History needs an action.");
  if (!entry?.entityType || !entry?.entityId) {
    throw fail("VALIDATION", "History needs the record it describes.");
  }
  if (REASON_REQUIRED.has(entry.action) && !String(entry.reason || "").trim()) {
    throw fail("VALIDATION", `A ${entry.action.toLowerCase()} action must record a reason.`);
  }

  const doc = {
    companyId: ctx.companyId,
    siteId: ctx.siteId || null,
    entityType: entry.entityType,
    entityId: entry.entityId,
    documentNumber: entry.documentNumber || "",
    action: entry.action,
    actorId: ctx.actorId,
    actorType: ctx.actorType || "employee",
    actorName: ctx.actorName || "",
    at: entry.at || new Date(),
    previousState: entry.previousState ?? null,
    resultingState: entry.resultingState ?? null,
    reason: String(entry.reason || "").slice(0, SAFE_STRING_LENGTH),
    requestId: entry.requestId || "",
    idempotencyKey: entry.idempotencyKey || "",
    changes: sanitiseChanges(entry.changes),
    metadata: sanitiseMetadata(entry.metadata),
    atomicityDegraded: Boolean(entry.atomicityDegraded),
  };

  const [written] = await SpActionHistory.create([doc], session ? { session } : {});
  return written;
}

/**
 * Perform a state change and record it, together where the deployment allows.
 *
 * @param {function} mutate  async (session|null) => {entry fields, result}
 */
async function recordWithState(ctx, mutate) {
  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
  } catch {
    session = null; // standalone deployment — no transactions
  }

  if (session) {
    try {
      const { entry, result } = await mutate(session);
      await record(ctx, entry, { session });
      await session.commitTransaction();
      await session.endSession();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch { /* already aborted */ }
      await session.endSession();
      /* A deployment without transaction support reports it here rather than
         at startSession. Fall through to the degraded path instead of failing
         a legitimate write. */
      const unsupported = /Transaction numbers are only allowed|replica set|not supported/i.test(
        err?.message || "",
      );
      if (!unsupported) throw err;
    }
  }

  /* Degraded path: state first, history immediately after. The order matters
     — a history entry for a change that did not happen is worse than a change
     whose entry is a moment late, and the flag makes the latter findable. */
  const { entry, result } = await mutate(null);
  await record(ctx, { ...entry, atomicityDegraded: true });
  return result;
}

/** Tenant-scoped read. Never returns another company's history. */
async function listFor(ctx, { entityType, entityId, limit = 100 } = {}) {
  const filter = { companyId: ctx.companyId };
  if (entityType) filter.entityType = entityType;
  if (entityId) filter.entityId = entityId;
  return SpActionHistory.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();
}

module.exports = { record, recordWithState, listFor, sanitiseMetadata, sanitiseChanges, REASON_REQUIRED };
