"use strict";
/**
 * services/requests/costingDemand.service.js
 *
 * THE REQUESTS DOMAIN'S DOOR FOR DEMAND RAISED FROM AN APPROVED COSTING.
 *
 * ── WHY THIS EXISTS RATHER THAN CENTRAL COSTING OWNING THE MODEL ────────────
 * `SpendRequest` is a Requests record. Central Costing was requiring the model
 * directly — reading it to find what had already been asked for, and writing
 * `costingSource` onto it after creation. That is Central Costing owning a
 * record it does not own, and the source-boundary guard is right to refuse it:
 * a costing that can write a request can, one refactor later, read one as a
 * costing source, which is exactly the loop the guard exists to prevent.
 *
 * So the model lives here, behind the two operations Central Costing actually
 * needs and nothing else. There is no update, no submit, no approve, no
 * delete, and no general query.
 *
 * ── AND THE FACTS COME FROM THE CALLER'S FROZEN VERSION ─────────────────────
 * This service builds nothing commercial of its own. It takes lines that
 * Central Costing regenerated from the approved version and hands them to the
 * one canonical creation service; it never accepts, and never asks for, a
 * quantity or a rate from a browser.
 */

const mongoose = require("mongoose");

const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const spendCreate = require("../spendRequestCreate.service");
const unitOfWork = require("../storePurchase/unitOfWork.service");

/**
 * Which statuses mean the demand is still live.
 *
 * A cancelled or rejected request is history: it stays visible, and it does
 * not block a fresh ask. Anything else does.
 */
const ACTIVE_STATUSES = Object.freeze([
  "draft", "submitted", "pending_tl", "pending_finance",
  "awaiting_requester_confirmation", "requester_revision_requested",
  "requester_confirmed", "approved", "ordered", "budget_exception",
]);

/**
 * Every request already raised from one approved version and scenario.
 *
 * ── FOUND BY STORED IDENTITY, NEVER BY NAME ─────────────────────────────────
 * Read from the `costingSource` this service itself wrote. Matching on a title
 * or an item name would find unrelated requests and miss renamed ones, which
 * is the same failure in both directions.
 *
 * ── AND SCOPED TO ONE COMPANY, IN THE QUERY ─────────────────────────────────
 * Another company's request must be indistinguishable from one that does not
 * exist, which is only true if it never comes back.
 */
async function demandForCostingVersion({ companyId, costingVersionId, scenarioKey } = {}) {
  if (!companyId || !costingVersionId) return [];
  return SpendRequest.find({
    companyId,
    "costingSource.costingVersionId": costingVersionId,
    "costingSource.scenarioKey": scenarioKey,
  })
    /* `items` is what the model calls the line array — `lines` is only the
       creation service's parameter name. Reading the wrong one would find no
       provenance and report every requirement as never requested. */
    .select("_id requestNumber requestType status items.costingDemandSource createdAt")
    .lean()
    .catch(() => []);
}

/**
 * Create the drafts for one handoff — all of them, or none.
 *
 * ── WHY THE TRANSACTION IS HERE AND NOT AT THE CALLER ───────────────────────
 * Two drafts are one decision. Central Costing used to check that transactions
 * were AVAILABLE and then write the two sequentially outside any session, so a
 * failure on the second left the first written while the screen said both had
 * been raised. The writes now happen inside one unit of work, and the
 * `costingSource` stamp goes on inside it too — a request carrying no
 * provenance would be invisible to the duplicate check that stops it being
 * raised twice.
 *
 * @param {{companyId, actorId}} ctx
 * @param {object[]} parts  `[{ requestType, title, lines, totalAmount }]`
 * @param {object}   costingSource  the frozen provenance stamp
 * @returns {Promise<object[]>} one summary per created draft
 */
async function createDraftsFromCosting(ctx, {
  parts = [], costingSource, emp, actorName, company, purpose, neededBy, historyNote,
} = {}) {
  if (!parts.length) return [];

  const write = async (session) => {
    const created = [];
    for (const part of parts) {
      const { request } = await spendCreate.createSpendRequest({
        emp, actorName, company,
        title: part.title,
        purpose,
        requestType: part.requestType,
        neededBy,
        lines: part.lines,
        totalAmount: part.totalAmount,
        /* ── IT STARTS AS A DRAFT ──────────────────────────────────────
           Not submitted, not pending anybody. Creating drafts starts the
           workflow; it does not enter it. */
        startAt: "draft",
        historyNote,
        session,
      });
      /* Written after creation so the canonical creation service stays the one
         place a request is built — and inside the same session, so a rolled
         back draft takes its provenance with it. */
      await SpendRequest.updateOne(
        { _id: request._id },
        { $set: { costingSource } },
        session ? { session } : {},
      );
      created.push({
        requestId: String(request._id),
        requestNumber: request.requestNumber || "",
        requestType: part.requestType,
        lineCount: part.lines.length,
        status: "draft",
      });
    }
    return created;
  };

  /* One draft is atomic by itself; two need the session. Where a deployment
     cannot give one, the caller has already refused rather than half-writing
     — this keeps the same guarantee without depending on that check. */
  if (parts.length === 1 || !(await unitOfWork.transactionsAvailable())) {
    return write(undefined);
  }

  const session = await mongoose.startSession();
  try {
    let out = [];
    await session.withTransaction(async () => { out = await write(session); });
    return out;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/**
 * The same requests, whole, for the reconciliation read.
 *
 * ── WHY A SECOND READ RATHER THAN ONE WITH A FLAG ───────────────────────────
 * `demandForCostingVersion` returns the four fields the review screen needs to
 * say "already requested". Reconciliation needs the request LINES — their
 * quantities, units and rates — to set beside what was estimated. Two callers
 * wanting different projections of one query is two functions, not one with a
 * parameter deciding how much of a record to disclose.
 *
 * Still company-scoped in the query, and still read-only.
 */
async function requestsRaisedFromCosting({ companyId, costingVersionId, scenarioKey } = {}) {
  if (!companyId || !costingVersionId) return [];
  return SpendRequest.find({
    companyId,
    "costingSource.costingVersionId": costingVersionId,
    "costingSource.scenarioKey": scenarioKey,
  }).lean().catch(() => []);
}

/** Whether this deployment can create two drafts as one act. */
const canCreateTogether = () => unitOfWork.transactionsAvailable();

/**
 * THE STATE OF SPECIFIC SPEND REQUESTS, BY ID.
 *
 * ── WHY THE REQUESTS DOMAIN ANSWERS THIS ────────────────────────────────────
 * Merchandising needs to know whether demand it released earlier is still
 * operational before it supersedes it — buying twice against one order line is
 * the failure. What "operational" means is the Requests domain's rule, not
 * Merchandising's, and it changes when a status is added to the workflow.
 *
 * So the question is asked here and answered from `ACTIVE_STATUSES`, the same
 * list every other caller uses. Merchandising gets a verdict and a short
 * summary, and never a copy of the rule.
 *
 * ── READ-ONLY, DELIBERATELY ─────────────────────────────────────────────────
 * It cancels nothing and edits nothing. A request is closed through its own
 * workflow, by whoever owns it — a department reaching into another's records
 * to tidy them is how an approval trail stops meaning anything.
 *
 * @returns {Promise<{requests: object[], active: object[], anyActive: boolean}>}
 */
async function stateOfRequests(ctx, requestIds = []) {
  const ids = [...new Set((requestIds || []).map(String).filter(Boolean))];
  /* No references to account for is fully accounted for. */
  if (!ids.length) {
    return { requests: [], active: [], missing: [], anyActive: false, accounted: true, unreadable: false };
  }

  let rows;
  try {
    rows = await SpendRequest.find({
      _id: { $in: ids },
      companyId: ctx.companyId,
    }).select("_id requestNumber requestType status").lean();
  } catch (err) {
    /* ── A READ THAT FAILED IS NOT "NOTHING IS ACTIVE" ─────────────────
       The caller uses this to decide whether earlier demand is still live.
       Answering "not active" because the database was unreachable would let
       a successor be raised over demand that may well still be open, and
       Store would buy the order line twice. */
    return {
      requests: [], active: [], missing: ids, anyActive: false,
      accounted: false, unreadable: true, error: err.message,
    };
  }

  const requests = rows.map((r) => ({
    requestId: String(r._id),
    requestNumber: r.requestNumber || "",
    requestType: r.requestType || "",
    status: r.status,
    active: ACTIVE_STATUSES.includes(r.status),
  }));

  /* ── AND A REFERENCE WITH NO RECORD IS NOT A CLOSED ONE ───────────────
     A release names the requests it raised. If one of them cannot be found
     — deleted, in another company, never written — its state is UNKNOWN,
     not closed. Reporting it as closed would be the same failure as the
     read error above, arrived at more quietly. */
  const found = new Set(requests.map((r) => r.requestId));
  const missing = ids.filter((id) => !found.has(id));

  const active = requests.filter((r) => r.active);
  return {
    requests,
    active,
    missing,
    anyActive: active.length > 0,
    /* Every reference resolved AND every one of them closed. Only this
       state is safe to supersede over. */
    accounted: missing.length === 0,
    unreadable: false,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  stateOfRequests,
  demandForCostingVersion,
  requestsRaisedFromCosting,
  createDraftsFromCosting,
  canCreateTogether,
};
