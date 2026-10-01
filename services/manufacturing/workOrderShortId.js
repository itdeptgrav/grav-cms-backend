// services/manufacturing/workOrderShortId.js
//
// THE ONE RULE FOR TURNING `WO-359e7172-009` INTO A WORK ORDER.
//
// ── THERE IS NO `workOrderShortId` FIELD, AND THERE NEVER WAS ──────────────
// A piece label carries the LAST EIGHT CHARACTERS OF THE WORK ORDER'S
// ObjectId. Nothing stores that substring: it is derived, every time, from
// `_id`. `models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js` has no such
// path, so `WorkOrder.findOne({ workOrderShortId })` matches nothing — not "no
// results for this label", but no results for ANY label, because the field
// does not exist on a single document in the collection.
//
// That is exactly what `POST /qc/identify-barcode` was doing (29 Sep 2026).
// Every garment scanned at the unified Inspect station came back "No work
// order … is on record", for every work order, including ones the older
// `/lookup-piece` opened correctly a second later from the same string. Two
// lookups, two rules, one of them impossible.
//
// ── WHY AN AGGREGATE AND NOT AN INDEXED QUERY ──────────────────────────────
// A suffix of `_id` cannot be indexed, so this is a collection scan with a
// `$expr` and a `$limit: 1`. That is the cost of the label format and it is
// paid once per scan. The alternative — persisting the substring and indexing
// it — is a migration over every existing work order plus a write path that
// can drift from `_id`, and it would not help the labels already printed.
//
// If this ever becomes the bottleneck, the fix is a stored field written from
// `_id` at creation AND a backfill, not a second lookup rule alongside this
// one.
//
// ── THE SUBSTRING BOUNDS ARE NOT ARBITRARY ─────────────────────────────────
// An ObjectId is 24 hex characters. `[16, 8]` is the last eight of them, which
// is what `lib/barcodeSticker` prints and what the piece tracker, the operator
// attribution and `qcStages.pieceProgress` all key on.

const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

/** An ObjectId is 24 hex chars; the label carries the last 8. */
const OBJECT_ID_LEN = 24;
const SHORT_ID_LEN = 8;

/**
 * A work order's short id, derived from its `_id`.
 *
 * The inverse of what the scanner reads, and the only definition of it. Used by
 * the tests, and by anything that needs to print a label.
 */
function shortIdOf(id) {
  const s = String(id ?? "");
  return s.length === OBJECT_ID_LEN ? s.slice(OBJECT_ID_LEN - SHORT_ID_LEN) : "";
}

/**
 * Could this string be a short id at all?
 *
 * ObjectId hex is LOWER CASE, always, so a short id is lower-case hex by
 * construction — an upper-cased one cannot match any document and never could.
 * Rejecting it here answers identically to the query that would have run, for
 * the price of not running it. This deliberately does NOT lower-case the input:
 * doing so would make labels start resolving that have never resolved, which is
 * a behaviour change dressed up as a refactor.
 */
const SHORT_ID = /^[0-9a-f]{8}$/;
const isShortId = (v) => SHORT_ID.test(String(v ?? ""));

/**
 * The `$match` stage, on its own, so a test can assert the rule without a
 * database and without this module reaching for one.
 */
function shortIdMatchStage(shortId) {
  return {
    $match: {
      $expr: {
        $eq: [
          { $substrCP: [{ $toString: "$_id" }, OBJECT_ID_LEN - SHORT_ID_LEN, SHORT_ID_LEN] },
          shortId,
        ],
      },
    },
  };
}

/**
 * The whole pipeline, including the caller's projection.
 *
 * `project` is the caller's, because the two call sites legitimately want
 * different fields: `/lookup-piece` needs the routing and the customer request,
 * `/identify-barcode` needs four facts and nothing that would leak a product it
 * has not yet decided the caller may see.
 */
function shortIdPipeline(shortId, project) {
  const stages = [shortIdMatchStage(shortId), { $limit: 1 }];
  if (project) stages.push({ $project: project });
  return stages;
}

/**
 * Resolve one work order from the short id on a piece label.
 *
 * @param {string} shortId  the eight characters between the two dashes
 * @param {object} [opts]
 * @param {object} [opts.project]  a `$project` stage's body
 * @param {object} [opts.model]    the model to query — for tests only; the live
 *                                 model is the default and nothing passes one
 * @returns the work order, or `null`. Never throws for a malformed short id.
 */
async function findWorkOrderByShortId(shortId, { project, model = WorkOrder } = {}) {
  const id = String(shortId ?? "");
  if (!isShortId(id)) return null;
  const matches = await model.aggregate(shortIdPipeline(id, project));
  return matches?.[0] || null;
}

module.exports = {
  findWorkOrderByShortId,
  shortIdOf,
  isShortId,
  shortIdPipeline,
  shortIdMatchStage,
  OBJECT_ID_LEN,
  SHORT_ID_LEN,
};
