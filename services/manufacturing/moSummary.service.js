// services/manufacturing/moSummary.service.js
//
// The canonical summary of one manufacturing order.
//
// Chunk 3A gave the register a tested projection. The three detail reads —
// `/:id`, `/:id/detailed` and the misspelled `/emplloyeeTracking/:id` — each
// derived their own totals, their own completion figure and their own notion of
// status, so the same order could read one way on the register and another way
// on the page you opened from it. That was 3A's recorded unresolved conflict.
//
// This is the seam that closes it. It reuses `derivationStages()` and
// `deadlineStages()` from the list projection rather than reimplementing them:
// one status formula, one completion formula, one deadline vocabulary, one
// bound, one injected clock. If the register's rules change, these move with
// them, because they are the same code.
//
// It creates no model — a manufacturing order is still a `CustomerRequest` —
// and it deliberately does not filter on `quotation_sales_approved`. The detail
// endpoints never did, and adding that filter would 404 orders their pages can
// open today.

"use strict";

const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const { deadlineBoundaries } = require("./moListQuery");
const { buildSummaryPipeline, projectSummary } = require("./moListProjection");

/**
 * The eight canonical fields for one order, or `null` when there is no such
 * order — including when the id is not an ObjectId at all, so a caller that has
 * already validated and one that has not both get the same answer rather than
 * an exception.
 *
 * ONE aggregation, fixed cost, no N+1: the work orders arrive through the
 * `$lookup` inside `derivationStages()`, which is the same join the register
 * makes for a whole page of orders. `$match: { _id }` is the primary key, and
 * the lookup's correlated `$match` on `customerRequestId` is served by the
 * existing `workOrderSchema.index({ customerRequestId: 1, status: 1 })` on its
 * leading field. No new index is proposed; see the handoff for the evidence.
 *
 * @param {string|ObjectId} id
 * @param {object} [deps]
 * @param {object} [deps.model]  CustomerRequest, or a stub with .aggregate
 * @param {Date}   [deps.now]    reference instant for deadline risk
 * @returns {Promise<object|null>}
 */
async function summariseManufacturingOrder(id, { model = CustomerRequest, now = new Date() } = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const [row] = await model.aggregate(
    buildSummaryPipeline(new mongoose.Types.ObjectId(String(id)), deadlineBoundaries(now)),
  );

  return row ? projectSummary(row) : null;
}

module.exports = { summariseManufacturingOrder };
