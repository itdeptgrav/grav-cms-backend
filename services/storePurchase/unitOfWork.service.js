// services/storePurchase/unitOfWork.service.js
//
// Store & Purchase — Chunk 1. ONE ACTION, ONE OUTCOME, EVEN WHEN IT BREAKS.
//
// ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
// A purchase-order receipt moves stock, updates the order, writes an action
// history entry and completes an idempotency record. Those were four separate
// writes, and a crash between any two of them left the system in a state a
// retry made worse:
//
//     stock moves → history write fails → HTTP 500
//     → idempotency record marked FAILED → retry re-runs the receipt
//     → stock moves a SECOND time for one delivery
//
// Marking the history row `atomicityDegraded` did not help: the row is a
// note about a problem, not a defence against it.
//
// ── WHAT THIS GUARANTEES, HONESTLY ──────────────────────────────────────────
// Two modes, and the caller is told which one ran:
//
//   TRANSACTIONAL (replica set) — the domain mutation, the history entry and
//     the idempotency completion commit together or not at all. A failure
//     anywhere rolls the whole thing back, and a retry is a clean first
//     attempt.
//
//   MARKED (standalone Mongo, including the test harness) — no transaction is
//     available, so instead the idempotency record is stamped EFFECT_APPLIED
//     the moment the domain mutation commits. A later failure cannot cause a
//     repeat, because `begin()` sees the marker and routes the retry into
//     recovery rather than re-execution. The window that remains is a missing
//     HISTORY entry, never a duplicated business effect — and recovery writes
//     the history the first attempt did not.
//
// The mode is recorded on the history entry so a reader knows which guarantee
// they are looking at, rather than being told "atomic" and having to hope.
"use strict";

const mongoose = require("mongoose");

const actionHistory = require("./actionHistory.service");
const idempotency = require("./idempotency.service");
const { buildRecoveryReceipt } = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

/** Does this deployment support transactions? Learned once, then remembered. */
let transactionsSupported = null;

/**
 * Standalone mongod ACCEPTS `startSession()` and `startTransaction()`, and
 * mongoose will happily pass an unusable session to a write that then
 * succeeds OUTSIDE any transaction. So "try it and see" is not safe: by the
 * time the deployment's answer surfaces, the business mutation may already
 * have committed unprotected.
 *
 * Support is therefore settled BEFORE any domain work, with a real write
 * inside a real transaction against a scratch collection, aborted afterwards.
 * The probe runs once per process.
 */
const UNSUPPORTED = /Transaction numbers are only allowed|replica set|Transactions are not supported|IllegalOperation/i;
const isUnsupported = (err) => UNSUPPORTED.test(err?.message || "");

async function transactionsAvailable() {
  if (transactionsSupported !== null) return transactionsSupported;

  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    /* A real write. Opening a transaction proves nothing; writing inside one
       is what a standalone refuses. */
    await mongoose.connection
      .collection("sp_transaction_probe")
      .insertOne({ probedAt: new Date() }, { session });
    await session.abortTransaction();
    transactionsSupported = true;
  } catch (err) {
    if (!isUnsupported(err)) {
      /* Something else is wrong (permissions, connectivity). Assume the
         weaker mode rather than risking an unprotected transactional path. */
      console.warn("[storePurchase] transaction probe failed:", err?.message);
    }
    transactionsSupported = false;
    try { await session?.abortTransaction(); } catch { /* already aborted */ }
  } finally {
    await session?.endSession().catch(() => {});
  }
  return transactionsSupported;
}

/**
 * Run one Store/Purchase action as a single unit.
 *
 * @param {object}   ctx        tenant context
 * @param {object}   options
 * @param {object}   options.idempotencyRecord  the claim from `begin()`, if any
 * @param {object}   [options.recoveryReceipt]  OPTIONAL, and prepared by the
 *                   CALLER before this runs — never returned from `mutate`. It
 *                   is validated HERE, before the transaction probe and before
 *                   `mutate`, so a malformed receipt stops the operation before
 *                   anything is written rather than after (which would leave a
 *                   mutation with no marker). Omitted by every existing caller.
 * @param {string}   [options.entityType]  WHAT is being written, known up front.
 * @param {ObjectId} [options.entityId]    WHICH document, known up front.
 *                   Together these move the whole marker-ordering decision in
 *                   here, so a caller whose `mutate` does several writes need not
 *                   know the deployment mode. When both are given:
 *                     · MARKED (standalone) — the marker is stamped BEFORE the
 *                       mutation, so a mutation that fails part-way routes the
 *                       retry into recovery rather than repeating (at-most-once).
 *                     · TRANSACTIONAL — NOTHING is marked before the transaction;
 *                       the marker commits INSIDE it. A rollback therefore rolls
 *                       the marker back too, and a retry is a clean first attempt.
 *                   Omit them and the legacy ordering (mark AFTER the mutation,
 *                   using the entity `mutate` returns) is used — safe only when
 *                   `mutate` is a single logical commit.
 * @param {function} options.mutate   async (session|null) => ({ entry, result, entityId, entityType })
 *                   `entry` is the history entry; `result` is returned to the
 *                   caller; `entityId`/`entityType` identify what was written.
 *                   Any `receipt` it returns is IGNORED — retaining a
 *                   post-mutation receipt is the unsafe ordering this removes,
 *                   and both current consumers (warehouses, suppliers) pass the
 *                   validated-before-mutation `recoveryReceipt` above instead.
 * @returns {Promise<{result, mode: "TRANSACTIONAL"|"MARKED"}>}
 */
async function run(ctx, { idempotencyRecord = null, entityType = null, entityId = null, recoveryReceipt = undefined, mutate }) {
  /* ── VALIDATE THE RECEIPT FIRST, BEFORE ANYTHING ELSE ──────────────────────
   * Before the probe, before a session, before `mutate`. If the receipt is
   * malformed the operation stops here with nothing written — there is no
   * mutation left un-marked for a retry to repeat. The EXACT validated object
   * is what later reaches `markEffectApplied`. */
  const receipt = (recoveryReceipt === undefined || recoveryReceipt === null)
    ? undefined
    : buildRecoveryReceipt(recoveryReceipt);

  /* Settled before any domain work, so the transactional path is never taken
     on a deployment that would silently drop the session. */
  if (await transactionsAvailable()) {
    const session = await mongoose.startSession();
    try {
      let outcome;
      /* NOTHING is marked before the transaction: the marker is written INSIDE
         it, so an abort rolls it back with the stock and the document. A retry
         after a rollback then finds no marker and runs as a clean first attempt
         — never a false "effect already applied" that would refuse it. */
      await session.withTransaction(async () => {
        const r = await mutate(session);
        await actionHistory.record(ctx, { ...r.entry, atomicityDegraded: false }, { session });
        if (idempotencyRecord) {
          await idempotency.markEffectApplied({
            record: idempotencyRecord, entityType: r.entityType, entityId: r.entityId, session, receipt,
          });
        }
        outcome = r.result;
      });
      return { result: outcome, mode: "TRANSACTIONAL" };
    } finally {
      await session.endSession().catch(() => {});
    }
  }

  /* ── MARKED mode (no transaction available) ──────────────────────────────
   * The marker is the whole defence, so its ordering matters. When the caller
   * named the entity up front, stamp the marker BEFORE the mutation: a
   * multi-write `mutate` that fails half-way then routes the retry into
   * recovery rather than repeating the part that landed. Otherwise fall back to
   * marking immediately AFTER the mutation (safe when `mutate` is one commit). */
  if (idempotencyRecord && entityType && entityId) {
    await idempotency.markEffectApplied({ record: idempotencyRecord, entityType, entityId, receipt });
  }

  const r = await mutate(null);

  if (idempotencyRecord && !(entityType && entityId)) {
    await idempotency.markEffectApplied({ record: idempotencyRecord, entityType: r.entityType, entityId: r.entityId, receipt });
  }

  await actionHistory.record(ctx, {
    ...r.entry,
    /* True in the accurate sense: this entry was not written inside a
       transaction with the change it describes. It does NOT mean the business
       effect can repeat — the marker above prevents that. */
    atomicityDegraded: true,
  });

  return { result: r.result, mode: "MARKED" };
}

/**
 * Finish an action whose effect already landed but whose request did not.
 *
 * Writes the history entry the first attempt never got to — but only if one
 * is not already there, so a recovery cannot duplicate the record of an
 * action that happened once.
 */
async function recover(ctx, { entityType, entityId, idempotencyKey, entry }) {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
  const already = await SpActionHistory.exists({
    companyId: ctx.companyId,
    entityId,
    action: entry.action,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  if (already) return { wroteHistory: false };

  await actionHistory.record(ctx, { ...entry, entityType, entityId, atomicityDegraded: true });
  return { wroteHistory: true };
}

/** Exposed for diagnostics and for tests that assert which mode ran. */
const transactionMode = () =>
  transactionsSupported === null ? "UNKNOWN" : transactionsSupported ? "TRANSACTIONAL" : "MARKED";

/** Test seam: force a mode, or clear what was learned. */
function __setTransactionSupport(value) {
  transactionsSupported = value;
}

module.exports = { run, recover, transactionsAvailable, transactionMode, __setTransactionSupport };
