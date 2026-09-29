// services/production/executionBasis/executionBasis.service.js
//
// The ONE writer of `WorkOrder.productionExecutionBases[]`.
//
//   receive    Production receives an accepted, current SEWING publication for
//              an existing WorkOrder that has no active basis. Idempotent.
//   supersede  the explicit successor command: a later version of the SAME
//              PPC stage publication replaces the active basis. Idempotent only
//              for an EQUIVALENT replay.
//   list       the narrow version history (never the frozen routes).
//
// ── ONE TRANSACTION, EVERY SOURCE FENCED ────────────────────────────────────
// A basis is only as good as the source state it copied. Checking eligibility
// in memory and then writing the WorkOrder would leave a window in which the
// publication is superseded, the booking released, the line revised or the IE
// release withdrawn — and the basis committed anyway (write skew: a
// transaction that only READS those documents does not conflict with a writer
// that changes them).
//
// So each attempt is one snapshot transaction that:
//   1. reads the WorkOrder and all four sources with the session;
//   2. runs the eligibility rules on exactly those reads;
//   3. FENCES every source: a conditional `$inc` of RECEIPT_FENCE_FIELD whose
//      predicate re-states the exact eligible state and version copied
//      (see `fenceSources`). A concurrent change committed after this
//      transaction's snapshot makes that write a WriteConflict; a change
//      committed before it makes the predicate match nothing. Either way the
//      attempt aborts and nothing is written;
//   4. writes the WorkOrder with its own conditional predicate (receipt key
//      absent, no ACTIVE basis — or the named predecessor still ACTIVE — the
//      same Sales line, quantity and not cancelled);
//   5. commits the fences and the basis together.
//
// A fence is a coordination counter written through the raw collection: it is
// not declared in, read by, or meaningful to any PPC/IE rule, it bypasses no
// business field and changes no `updatedAt` (mongoose timestamps are not
// involved), so source immutability and PPC/IE behaviour are untouched.
//
// ── BOUNDED RETRY ───────────────────────────────────────────────────────────
// The IE release command's pattern (ieRelease.service.js `isRaceLoss`), with an
// explicit bound: a TransientTransactionError, a WorkOrder predicate that lost
// to a concurrent commit, or a fence that matched nothing is retried — at most
// MAX_ATTEMPTS times in total. A retry re-reads everything, so it answers with
// the most accurate outcome: the winner's basis for an equivalent replay, the
// specific eligibility code for a source that stopped being eligible, or the
// stable conflict. An exhausted retry budget is EXECUTION_BASIS_SOURCE_CHANGED.
//
// ── AN UNCERTAIN COMMIT IS RESOLVED, NEVER GUESSED ──────────────────────────
// `UnknownTransactionCommitResult` means the commit may or may not have been
// applied (a lost acknowledgement, a failover). The commit is re-sent up to
// COMMIT_ATTEMPTS times — MongoDB makes a re-sent commit idempotent. If the
// outcome is still unknown, the command is NOT rerun: the session is left, and
// the WorkOrder is re-read outside it, by the acting company and WorkOrder,
// for the deterministic receipt key:
//   · found and equivalent (sameCommand)  → the committed basis, as an
//     idempotent success (`commitOutcome: "confirmed_by_receipt_key"`);
//   · found but a different command       → IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST;
//   · not found                           → EXECUTION_BASIS_COMMIT_OUTCOME_UNKNOWN
//     (503). That answer never says "nothing changed": it says the outcome
//     could not be established and that repeating the SAME request is safe —
//     a committed receipt is returned by key, never appended twice.
"use strict";

const mongoose = require("mongoose");

const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { PpcStagePublication } = require("../../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking } = require("../../../models/CMS_Models/PPC/PpcCapacityBooking");
const { PpcCapacityLine } = require("../../../models/CMS_Models/PPC/PpcCapacityLine");
const IeRelease = require("../../../models/CMS_Models/IndustrialEngineering/IeRelease");
const {
  BASIS_STATE, BASIS_LIMITS, EXECUTION_BASIS_WRITE_OPTION, RECEIPT_FENCE_FIELD,
} = require("../../../models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema");
const rules = require("./executionBasis.rules");

const { ExecutionBasisError, isObjectId } = rules;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const idOf = (v) => (v == null ? null : String(v));

const MAX_ATTEMPTS = 4;
const COMMIT_ATTEMPTS = 3;
const TRANSACTION_OPTIONS = Object.freeze({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
const WO_FIELDS = "_id workOrderNumber quantity status customerRequestId salesLineLink +productionExecutionBases";

/** An attempt that must be retried: somebody else committed first. */
class RetryAttempt extends Error {
  constructor(reason) { super(reason); this.retryReason = reason; }
}

/** The commit was sent and its result could not be learned. Never retried blindly. */
class CommitOutcomeUnknown extends Error {
  constructor(cause) { super("commit outcome unknown"); this.cause = cause; }
}

const defaultCommit = (session) => session.commitTransaction();

const isTransient = (err) => err?.hasErrorLabel?.("TransientTransactionError")
  || err?.code === 112 /* WriteConflict */
  || /WriteConflict/i.test(String(err?.message ?? ""));

function requireCompany(companyId) {
  if (!isObjectId(companyId)) {
    throw new ExecutionBasisError(403, "COMPANY_CONTEXT_REQUIRED", "No acting company could be proved for this request.");
  }
  return String(companyId);
}

function requireId(value, name) {
  if (!isObjectId(value)) throw new ExecutionBasisError(400, "INVALID_ID", `${name} must be a 24-character id.`);
  return String(value);
}

const withSession = (q, session) => (session ? q.session(session) : q);

async function loadWorkOrder(companyId, workOrderId, session = null) {
  return withSession(WorkOrder.findOne({ _id: oid(workOrderId), "salesLineLink.companyId": oid(companyId) }).select(WO_FIELDS), session).lean();
}

/** Everything eligibility needs, each read inside the acting company and the session. */
async function loadSources(companyId, workOrderId, publicationId, session) {
  const company = oid(companyId);
  const workOrder = await loadWorkOrder(companyId, workOrderId, session);
  const publication = await withSession(PpcStagePublication.findOne({ _id: oid(publicationId), companyId: company }), session).lean();
  const release = publication?.ieReleaseId
    ? await withSession(IeRelease.findOne({ _id: publication.ieReleaseId, companyId: company }), session).lean()
    : null;
  const booking = publication?.capacityBooking?.bookingId
    ? await withSession(PpcCapacityBooking.findOne({ _id: publication.capacityBooking.bookingId, companyId: company }), session).lean()
    : null;
  const line = booking?.lineId
    ? await withSession(PpcCapacityLine.findOne({ _id: booking.lineId, companyId: company }), session).lean()
    : null;
  return { workOrder, publication, release, booking, line };
}

/**
 * The commit-time proof. Each predicate re-states exactly the eligible state
 * the basis copies; the `$inc` makes the transaction a WRITER of each source,
 * so a concurrent change conflicts instead of slipping past.
 */
function fencePredicates(companyId, { workOrder, publication, release, booking, line }) {
  const company = oid(companyId);
  return [
    [PpcStagePublication, {
      _id: publication._id, companyId: company, process: rules.REQUIRED_PROCESS,
      isCurrent: true, state: "ACCEPTED", "response.state": "ACCEPTED",
      publicationVersionNo: publication.publicationVersionNo, orderLineRef: publication.orderLineRef,
      ieReleaseId: publication.ieReleaseId, ieReleaseVersionNo: publication.ieReleaseVersionNo,
      "capacityBooking.bookingId": publication.capacityBooking.bookingId,
      "capacityBooking.generation": publication.capacityBooking.generation,
      "workOrders.workOrderId": workOrder._id,
    }, "publication"],
    [PpcCapacityBooking, {
      _id: booking._id, companyId: company, state: "ACTIVE", generation: booking.generation, bookingRef: booking.bookingRef,
      lineId: booking.lineId, lineRevision: booking.lineRevision, planningFileId: booking.planningFileId,
    }, "booking"],
    [PpcCapacityLine, {
      _id: line._id, companyId: company, revision: line.revision, lineRef: line.lineRef, status: { $ne: "RETIRED" },
    }, "line"],
    [IeRelease, {
      _id: release._id, companyId: company, versionNo: release.versionNo, releaseRef: release.releaseRef, state: { $ne: "WITHDRAWN" },
    }, "release"],
  ];
}

async function fenceSources(companyId, src, session) {
  for (const [Model, predicate, name] of fencePredicates(companyId, src)) {
    const r = await Model.collection.updateOne(predicate, { $inc: { [RECEIPT_FENCE_FIELD]: 1 } }, { session });
    if (r.matchedCount !== 1) throw new RetryAttempt(`fence_${name}`);
  }
}

/** The WorkOrder's own mutable facts the basis depends on. */
const workOrderPredicate = (companyId, src) => ({
  _id: src.workOrder._id,
  "salesLineLink.companyId": oid(companyId),
  "salesLineLink.lineRef": src.workOrder.salesLineLink.lineRef,
  quantity: src.workOrder.quantity,
  status: { $ne: "cancelled" },
  [`productionExecutionBases.${BASIS_LIMITS.VERSIONS - 1}`]: { $exists: false },
});

const byKey = (workOrder, key) => (workOrder?.productionExecutionBases || []).find((b) => b.receiptKey === key) || null;

function replayOf(existing, cmd) {
  const command = { kind: cmd.kind, supersedesBasisId: cmd.prevId ?? null, reasonNormalized: cmd.reasonNormalized };
  if (!rules.sameCommand(existing, command)) {
    throw new ExecutionBasisError(409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      "This publication was already received for this work order by a different command; this request was not applied.",
      { executionBasisId: idOf(existing.basisId), versionNo: existing.versionNo });
  }
  return { basis: existing, reused: true };
}

function createExecutionBasisService({ now = () => new Date(), hooks = {}, commit = defaultCommit } = {}) {
  /**
   * One attempt, inside `session`'s transaction. Returns { basis, reused } or
   * throws an ExecutionBasisError (final) or RetryAttempt / transient (retry).
   */
  async function attempt(session, cmd, attemptNo) {
    const { company, woId, pubId, key } = cmd;
    const src = await loadSources(company, woId, pubId, session);

    const existing = byKey(src.workOrder, key);
    if (existing) return replayOf(existing, cmd);

    const { published, executionQuantity } = rules.assertEligible({ companyId: company, ...src });
    const bases = src.workOrder.productionExecutionBases || [];
    const active = rules.activeBasisOf(bases);

    if (cmd.kind === "receive" && active) {
      throw new ExecutionBasisError(409, "EXECUTION_BASIS_CONFLICT",
        "This work order already has an active execution basis; a later publication needs the explicit successor command.",
        { activeBasisId: idOf(active.basisId), activeVersionNo: active.versionNo });
    }
    if (cmd.kind === "supersede") {
      if (!active || idOf(active.basisId) !== cmd.prevId) {
        throw new ExecutionBasisError(409, "EXECUTION_BASIS_SUCCESSOR_INVALID", "The basis named is not this work order's active execution basis.",
          active ? { activeBasisId: idOf(active.basisId), activeVersionNo: active.versionNo } : undefined);
      }
      rules.assertSuccessorOf(active, src.publication);
    }
    if (bases.length >= BASIS_LIMITS.VERSIONS) {
      throw new ExecutionBasisError(409, "EXECUTION_BASIS_HISTORY_FULL", "This work order holds the maximum number of execution-basis versions.");
    }

    // Test seam: a concurrent writer may act here, between the reads and the fences.
    if (hooks.beforeFence) await hooks.beforeFence({ attempt: attemptNo, kind: cmd.kind, sources: src });

    await fenceSources(company, src, session);

    const at = now();
    const basis = rules.buildBasis({
      companyId: company, ...src, published, executionQuantity,
      versionNo: bases.length ? Math.max(...bases.map((b) => b.versionNo)) + 1 : 1,
      basisId: new mongoose.Types.ObjectId(), receiptKey: key, actor: cmd.actor, now: at,
      supersedesBasisId: cmd.kind === "supersede" ? cmd.prevId : null,
      reasonNormalized: cmd.reasonNormalized,
    });
    const writeOptions = { session, [EXECUTION_BASIS_WRITE_OPTION]: true };
    const filter = { ...workOrderPredicate(company, src), "productionExecutionBases.receiptKey": { $ne: key } };

    let result;
    if (cmd.kind === "receive") {
      result = await WorkOrder.updateOne(
        { ...filter, "productionExecutionBases.state": { $ne: BASIS_STATE.ACTIVE } },
        { $push: { productionExecutionBases: basis } },
        writeOptions,
      );
    } else {
      const history = { type: "SUPERSEDED", at, actor: basis.receivedBy, note: cmd.reasonNormalized };
      // `$push` and a positional `$set` on the same array conflict inside one
      // update, so one pipeline rewrites the array: close the predecessor,
      // append the successor. $literal keeps frozen text starting with "$"
      // from being read as a field path.
      result = await WorkOrder.updateOne(
        { ...filter, productionExecutionBases: { $elemMatch: { basisId: oid(cmd.prevId), state: BASIS_STATE.ACTIVE } } },
        [{
          $set: {
            productionExecutionBases: {
              $concatArrays: [
                {
                  $map: {
                    input: "$productionExecutionBases",
                    as: "b",
                    in: {
                      $cond: [
                        { $and: [{ $eq: ["$$b.basisId", oid(cmd.prevId)] }, { $eq: ["$$b.state", BASIS_STATE.ACTIVE] }] },
                        {
                          $mergeObjects: ["$$b", {
                            state: BASIS_STATE.SUPERSEDED,
                            effectiveUntil: at,
                            supersededByBasisId: basis.basisId,
                            supersededAt: at,
                            supersededBy: { $literal: basis.receivedBy },
                            supersedeReason: { $literal: cmd.reasonNormalized },
                            history: { $concatArrays: [{ $ifNull: ["$$b.history", []] }, [{ $literal: history }]] },
                          }],
                        },
                        "$$b",
                      ],
                    },
                  },
                },
                [{ $literal: basis }],
              ],
            },
          },
        }],
        writeOptions,
      );
    }
    if (result.modifiedCount !== 1) throw new RetryAttempt("work_order_predicate");
    return { basis, reused: false };
  }

  /** The bounded transactional loop around `attempt`. */
  async function run(cmd) {
    let lastRetry = null;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const session = await mongoose.startSession();
      let uncertain = null;
      try {
        session.startTransaction(TRANSACTION_OPTIONS);
        const out = await attempt(session, cmd, n);
        if (out.reused) {
          await session.abortTransaction();
          return out;
        }
        await commitWithRetry(session);
        return out;
      } catch (err) {
        if (err instanceof CommitOutcomeUnknown) {
          uncertain = err; // resolved below, after the session is left — never aborted or rerun
        } else {
          if (session.inTransaction()) await session.abortTransaction().catch(() => {});
          if (err instanceof ExecutionBasisError) throw err;
          if (err instanceof RetryAttempt || isTransient(err)) { lastRetry = err; continue; }
          throw err;
        }
      } finally {
        await session.endSession().catch(() => {});
      }
      return resolveUncertainCommit(cmd, uncertain);
    }
    throw new ExecutionBasisError(409, "EXECUTION_BASIS_SOURCE_CHANGED",
      "The work order or its PPC/IE sources kept changing while this was being received. Nothing was changed; try again.",
      { lastReason: lastRetry?.retryReason || lastRetry?.codeName || "transient" });
  }

  /**
   * Re-send the commit while its result is unknown; a definite failure
   * (including TransientTransactionError, i.e. aborted) propagates unchanged.
   */
  async function commitWithRetry(session) {
    let lastUnknown = null;
    for (let n = 1; n <= COMMIT_ATTEMPTS; n++) {
      try {
        await commit(session, { attempt: n });
        return;
      } catch (err) {
        if (!err?.hasErrorLabel?.("UnknownTransactionCommitResult")) throw err;
        lastUnknown = err;
      }
    }
    throw new CommitOutcomeUnknown(lastUnknown);
  }

  /** The outcome of an uncertain commit, learned from the receipt key alone. */
  async function resolveUncertainCommit(cmd, uncertain) {
    let fresh;
    try {
      fresh = await WorkOrder.findOne({ _id: oid(cmd.woId), "salesLineLink.companyId": oid(cmd.company) })
        .select(WO_FIELDS).read("primary").lean();
    } catch (readErr) {
      // Unable even to look: still unknown, and never reported as "nothing changed".
      throw unknownOutcome(cmd, uncertain, readErr);
    }
    const stored = byKey(fresh, cmd.key);
    if (stored) {
      const { basis } = replayOf(stored, cmd); // throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST
      return { basis, reused: true, commitOutcome: "confirmed_by_receipt_key" };
    }
    throw unknownOutcome(cmd, uncertain);
  }

  function unknownOutcome(cmd, uncertain, readErr = null) {
    return new ExecutionBasisError(503, "EXECUTION_BASIS_COMMIT_OUTCOME_UNKNOWN",
      "The receipt was sent but its outcome could not be confirmed. "
      + "Repeat the same request: if it was committed it is returned, never recorded twice.",
      {
        receiptKey: cmd.key,
        lastError: uncertain?.cause?.codeName || uncertain?.cause?.message || null,
        ...(readErr ? { verification: "receipt_key_read_failed" } : { verification: "receipt_key_not_found" }),
      });
  }

  /** Receive an eligible publication for a WorkOrder with no active basis. */
  async function receive({ companyId, workOrderId, publicationId, actor } = {}) {
    const company = requireCompany(companyId);
    const woId = requireId(workOrderId, "workOrderId");
    const pubId = requireId(publicationId, "publicationId");
    return run({ kind: "receive", company, woId, pubId, key: rules.receiptKeyOf(company, woId, pubId), actor, reasonNormalized: "" });
  }

  /** The explicit successor command. */
  async function supersede({ companyId, workOrderId, publicationId, supersedesBasisId, reason, actor } = {}) {
    const company = requireCompany(companyId);
    const woId = requireId(workOrderId, "workOrderId");
    const pubId = requireId(publicationId, "publicationId");
    const prevId = requireId(supersedesBasisId, "supersedesBasisId");
    const reasonNormalized = rules.normalizeReason(reason);
    if (reasonNormalized.length < BASIS_LIMITS.REASON_MIN || reasonNormalized.length > BASIS_LIMITS.REASON_MAX) {
      throw new ExecutionBasisError(400, "SUPERSEDE_REASON_REQUIRED",
        `Give a reason of ${BASIS_LIMITS.REASON_MIN}–${BASIS_LIMITS.REASON_MAX} characters for replacing the active basis.`);
    }
    return run({ kind: "supersede", company, woId, pubId, prevId, reasonNormalized, key: rules.receiptKeyOf(company, woId, pubId), actor });
  }

  /** Narrow history: summaries only, never the frozen routes. */
  async function list({ companyId, workOrderId } = {}) {
    const company = requireCompany(companyId);
    const woId = requireId(workOrderId, "workOrderId");
    const wo = await loadWorkOrder(company, woId);
    if (!wo) throw new ExecutionBasisError(404, "WORK_ORDER_NOT_FOUND", "No work order of your company has that id.");
    return (wo.productionExecutionBases || []).map((b) => rules.summarise(b));
  }

  return { receive, supersede, list };
}

let defaultService = null;
function executionBasisService() {
  if (!defaultService) defaultService = createExecutionBasisService();
  return defaultService;
}

module.exports = {
  MAX_ATTEMPTS,
  COMMIT_ATTEMPTS,
  createExecutionBasisService,
  executionBasisService,
  ExecutionBasisError,
  fencePredicates,
};
