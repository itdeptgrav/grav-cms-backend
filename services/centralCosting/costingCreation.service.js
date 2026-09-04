// services/centralCosting/costingCreation.service.js
//
// Central Costing — Chunk 1. A COSTING AND ITS FIRST VERSION, OR NEITHER.
//
// ── THE FAILURE THIS EXISTS FOR ─────────────────────────────────────────────
// A costing without a version 1 is a record that looks like a costing, opens
// like a costing and has nothing in it. A version 1 without its parent is
// unreachable — every read path resolves the parent first — and so is
// invisible history that a version-number index will nonetheless defend.
// Either half alone is worse than the create having failed outright.
//
// ── TWO MODES, AND THE CALLER IS TOLD WHICH ONE RAN ─────────────────────────
// The same honest split `services/storePurchase/unitOfWork.service.js`
// documents, and it reuses that file's transaction PROBE rather than
// re-deciding whether this deployment supports transactions:
//
//   TRANSACTIONAL (replica set) — both inserts commit together or neither
//     does. Nothing to compensate.
//
//   COMPENSATED (standalone Mongo, including the test harness) — no
//     transaction is available. The VERSION is written first and the parent
//     second, so the only order in which a crash can leave one behind leaves
//     the UNREACHABLE one: no read path can reach a version whose parent does
//     not exist. If the parent insert fails, the version is deleted; if that
//     delete also fails, the orphan is logged loudly and remains
//     unreachable — never a half-open costing.
//
// The mode is returned so the response can state it rather than imply an
// atomicity the deployment does not provide.
"use strict";

const mongoose = require("mongoose");

const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const { transactionsAvailable } = require("../storePurchase/unitOfWork.service");
const { fail } = require("../storePurchase/errors");

/**
 * Create a costing and its version 1.
 *
 * @param {object} ctx   the resolved costing context — the ONLY source of
 *                       company and actor. Nothing here reads a request body.
 * @param {object} input `parseCreateRequest`'s output
 * @param {object} [meta] `{ requestId, idempotencyKey }`
 * @param {function} [meta.onCommitted] async (session|null, {costing, version})
 *   — run at the instant both documents are durable and BEFORE anything that
 *   could still fail. It is where the idempotency effect marker is written, so
 *   an interrupted response can never become a second costing. In
 *   transactional mode it runs inside the transaction and rolls back with it.
 * @returns {Promise<{costing, version, mode}>}
 */
async function createCostingWithFirstVersion(ctx, input, meta = {}) {
  if (!ctx?.companyId) {
    /* Defence in depth: the route resolves context before this is reachable,
       and an unscoped write would be the one bug this whole chunk is about. */
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A costing cannot be created without a proven company.");
  }

  /* Ids and the event time are fixed BEFORE either write, so the parent can
     point at its version in the same insert rather than being updated
     afterwards — an update that could itself fail and leave the pointer
     empty. */
  const costingId = new mongoose.Types.ObjectId();
  const versionId = new mongoose.Types.ObjectId();
  const now = new Date();

  const versionDoc = {
    _id: versionId,
    companyId: ctx.companyId,
    costingId,
    versionNumber: 1,
    status: "DRAFT",
    baseCurrency: input.baseCurrency,
    /* Zero: no calculator has run. Chunk 2 sets this when one has. */
    calculationSchemaVersion: 0,
    provenance: {
      origin: "MANUAL",
      createdByActorId: ctx.actorId,
      createdByActorName: ctx.actorName || "",
      createdAt: now,
      requestId: meta.requestId || "",
      idempotencyKey: meta.idempotencyKey || "",
      supersedesVersionNumber: null,
      note: input.note || "",
    },
    sourceReferences: input.sourceReferences,
    /* Reserved for Chunk 2. Empty is the truth; a default scenario would be a
       quantity nobody asked for. */
    scenarios: [],
  };

  const costingDoc = {
    _id: costingId,
    companyId: ctx.companyId,
    context: input.context,
    contextSnapshot: input.contextSnapshot,
    status: "DRAFT",
    currentVersionId: versionId,
    currentVersionNumber: 1,
    createdByActorId: ctx.actorId,
    createdByActorName: ctx.actorName || "",
  };

  if (await transactionsAvailable()) {
    const session = await mongoose.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        const [version] = await CostingVersion.create([versionDoc], { session });
        const [costing] = await Costing.create([costingDoc], { session });
        if (meta.onCommitted) await meta.onCommitted(session, { costing, version });
        out = { costing, version };
      });
      return { ...out, mode: "TRANSACTIONAL" };
    } finally {
      await session.endSession().catch(() => {});
    }
  }

  /* ── COMPENSATED mode ─────────────────────────────────────────────────
     Version first, deliberately. See the header: the reachable half is never
     the one that can be left behind. */
  const [version] = await CostingVersion.create([versionDoc]);

  let costing;
  try {
    [costing] = await Costing.create([costingDoc]);
  } catch (err) {
    try {
      await CostingVersion.deleteOne({ _id: versionId, companyId: ctx.companyId });
    } catch (cleanupErr) {
      /* Loud, because it is the one case that leaves a row behind — and
         quiet in effect, because nothing can read it. */
      console.error(
        `[centralCosting] orphaned costing version ${versionId} after a failed parent insert; ` +
        "it is unreachable but should be cleaned up:",
        cleanupErr?.message || cleanupErr,
      );
    }
    throw err;
  }

  /* IMMEDIATELY after both documents are durable and before anything that
     could still fail — the same ordering unitOfWork's MARKED mode uses, and
     the whole reason a lost response cannot become a second costing. */
  if (meta.onCommitted) await meta.onCommitted(null, { costing, version });

  return { costing, version, mode: "COMPENSATED" };
}

module.exports = { createCostingWithFirstVersion };
