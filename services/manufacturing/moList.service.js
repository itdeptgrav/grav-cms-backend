// services/manufacturing/moList.service.js
//
// The persistence seam for the manufacturing-order register: the one place that
// knows a database is involved.
//
// Query policy is moListQuery.js and the projection is moListProjection.js,
// both pure. This file exists so the route is wiring and nothing else, and so
// anything else that needs the canonical list — a future detail projection, an
// export, a report — reaches it here rather than re-deriving it.
//
// The model is injected with a default rather than hard-required, so the
// projection can be exercised against a stub without a connection. In every
// real caller it is the same CustomerRequest model the route used before.

"use strict";

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const { normaliseListQuery } = require("./moListQuery");
const { buildListPipeline, projectRow } = require("./moListProjection");

/**
 * One page of the manufacturing-order register.
 *
 * @param {object} query               raw `req.query` — nothing is trusted
 * @param {object} [deps]
 * @param {object} [deps.model]        CustomerRequest, or a stub with .aggregate
 * @param {Date}   [deps.now]          reference instant for deadline risk
 * @returns {{ manufacturingOrders: object[], pagination: object }}
 *
 * Returns a valid empty page rather than throwing when nothing matches: an
 * empty register is a normal state, and the caller cannot tell an empty result
 * from a failed one if both arrive as an error.
 */
async function listManufacturingOrders(query = {}, { model = CustomerRequest, now = new Date() } = {}) {
  const normalised = normaliseListQuery(query, now);
  const pipeline = buildListPipeline(normalised);

  const [result] = await model.aggregate(pipeline);
  const rows = result?.paginated || [];
  const total = result?.totalCount?.[0]?.count || 0;

  return {
    manufacturingOrders: rows.map(projectRow),
    pagination: {
      page: normalised.page,
      // What was actually applied, which is not always what was asked for —
      // see MAX_LIMIT in moListQuery.js.
      limit: normalised.limit,
      total,
      pages: Math.ceil(total / normalised.limit),
    },
  };
}

module.exports = { listManufacturingOrders };
