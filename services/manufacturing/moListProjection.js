// services/manufacturing/moListProjection.js
//
// The canonical read projection for the manufacturing-order register.
//
// A manufacturing order is not a record. It is a `CustomerRequest` that Sales
// approved, joined to its work orders and reduced to the shape the register
// reads. That reduction — work-order count, quantities, completion percentage,
// the detailed derived status and the four-value PM `displayStatus` — used to
// live inline in the route handler, which meant the only way to test it was to
// stand up an HTTP server, and the only way to reuse it was to copy it.
//
// Pure: builds a plain aggregation array and maps plain rows. It opens no
// connection and imports no model. The persistence seam is
// moList.service.js; the query policy is moListQuery.js.
//
// WHAT MUST NOT DRIFT
// -------------------
// The derivation stages below are lifted verbatim from the route they replace,
// deliberately including their original comments. Their outputs are a published
// contract: Chunk 1's route tests read them, and so do the two call sites the
// Chunk 3A consumer audit found — app/project-manager/dashboard/page.js:178 and
// app/project-manager/dashboard/production/manufacturing-orders/page.js:98.
// (An earlier note here claimed six frontend surfaces. That was inherited from
// the Chunk 2 audit's consumer row, which the 3A audit checked exhaustively and
// corrected: the other departments reach manufacturing orders through their own
// routers, and the CEO reads only /stats/overview.)
//
// So this file is a relocation, not a rewrite — with one deliberate exception,
// marked where it happens: `completionPercentage` is bounded to 0-100.
// `displayStatus` keeps exactly its four values, and no stored WorkOrder status
// is reinterpreted here.

"use strict";

const {
  DISPLAY_STATUSES,
  deadlineBoundaries,
} = require("./moListQuery");

/** Sales-approved is what a manufacturing order IS. Never relaxed. */
const MO_BASE_STATUS = "quotation_sales_approved";

/**
 * The stages that turn sales-approved requests into register rows.
 *
 * Lifted unchanged from the route; see the note at the top of this file.
 */
function derivationStages() {
  return [
    // Compute totalQuantity in-DB from items[].totalQuantity (no need to ship items)
    {
      $addFields: {
        totalQuantity: {
          $sum: {
            $map: {
              input: { $ifNull: ["$items", []] },
              as: "it",
              in: { $ifNull: ["$$it.totalQuantity", 0] }
            }
          }
        }
      }
    },

    // Join WO stats per MO in ONE query (replaces the per-MO countDocuments + aggregate)
    {
      $lookup: {
        from: "workorders",
        let: { reqId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$customerRequestId", "$$reqId"] } } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalWoQty: { $sum: { $ifNull: ["$quantity", 0] } },
              totalCompleted: {
                $sum: { $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }
              },
              cancelledCount: {
                $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] }
              },
              anyInProgress: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$status", "in_progress"] },
                        { $gt: [{ $ifNull: ["$productionCompletion.overallCompletedQuantity", 0] }, 0] }
                      ]
                    },
                    1, 0
                  ]
                }
              },
              scheduledCount: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["scheduled", "planned", "ready_to_start"]] },
                    1, 0
                  ]
                }
              }
            }
          }
        ],
        as: "_woStats"
      }
    },
    { $addFields: { _stats: { $arrayElemAt: ["$_woStats", 0] } } },

    // Flatten + compute completion % at the MO level
    {
      $addFields: {
        workOrdersCount: { $ifNull: ["$_stats.count", 0] },
        _totalWoQty: { $ifNull: ["$_stats.totalWoQty", 0] },
        _totalCompleted: { $ifNull: ["$_stats.totalCompleted", 0] },
        _cancelledCount: { $ifNull: ["$_stats.cancelledCount", 0] },
        _anyInProgress:  { $ifNull: ["$_stats.anyInProgress",  0] },
        _scheduledCount: { $ifNull: ["$_stats.scheduledCount", 0] }
      }
    },
    {
      $addFields: {
        completionPercentage: {
          /* Bounded to 0-100 at the point it is computed, so the published
             figure, the status derivation below and any caller filtering on it
             all read the same number.

             The one deliberate change to the stages lifted from the route. It
             used to publish the raw ratio, so a work order re-issued after a
             short delivery — 25 units completed against a quantity of 10 —
             reported "250% complete". A percentage above 100 is not extra
             information, it is a broken gauge and an unusable progress bar.

             It cannot move a status. `derivedStatus` and `displayStatus` test
             `>= 100` and `>= 70`: anything clamped down to 100 satisfied
             `>= 100` before the clamp and satisfies it after, and anything
             clamped up to 0 failed every branch before and fails them after.
             Pinned by tests rather than left as an argument. */
          $max: [
            0,
            {
              $min: [
                100,
                {
                  $cond: [
                    { $gt: ["$_totalWoQty", 0] },
                    {
                      $round: [
                        { $multiply: [{ $divide: ["$_totalCompleted", "$_totalWoQty"] }, 100] },
                        0
                      ]
                    },
                    0
                  ]
                }
              ]
            }
          ]
        }
      }
    },

    // Derive the MO status from WO progress
    {
      $addFields: {
        derivedStatus: {
          $switch: {
            branches: [
              { case: { $eq: ["$workOrdersCount", 0] }, then: "pending" },
              {
                case: {
                  $and: [
                    { $gt: ["$workOrdersCount", 0] },
                    { $eq: ["$_cancelledCount", "$workOrdersCount"] }
                  ]
                },
                then: "cancelled"
              },
              { case: { $gte: ["$completionPercentage", 100] }, then: "completed" },
              { case: { $gte: ["$completionPercentage", 70] },  then: "about_to_finish" },
              {
                case: {
                  $or: [
                    { $gt: ["$completionPercentage", 0] },
                    { $gt: ["$_anyInProgress", 0] }
                  ]
                },
                then: "in_progress"
              },
              {
                case: { $gt: ["$_scheduledCount", 0] },
                then: "on_production"
              }
            ],
            default: "pending"
          }
        }
      }
    },

    // PM-facing simplified status — collapse everything down to just
    // pending / in_progress / completed (+ cancelled when it genuinely happened).
    // Rule: any work order scheduled/planned/in-progress/etc. => "in_progress".
    {
      $addFields: {
        displayStatus: {
          $switch: {
            branches: [
              { case: { $eq: ["$workOrdersCount", 0] }, then: "pending" },
              {
                case: {
                  $and: [
                    { $gt: ["$workOrdersCount", 0] },
                    { $eq: ["$_cancelledCount", "$workOrdersCount"] }
                  ]
                },
                then: "cancelled"
              },
              { case: { $gte: ["$completionPercentage", 100] }, then: "completed" },
              {
                case: {
                  $or: [
                    { $gt: ["$_scheduledCount", 0] },
                    { $gt: ["$_anyInProgress", 0] },
                    { $gt: ["$completionPercentage", 0] }
                  ]
                },
                then: "in_progress"
              }
            ],
            default: "pending"
          }
        }
      }
    }
  ];
}

/**
 * The effective deadline, and the risk band it falls in.
 *
 * The deadline choice — delivery deadline, falling back to the estimate — is
 * the one the register already made on the client; it is computed here so the
 * server can filter and sort on the same date the screen shows, rather than the
 * two disagreeing about which date an order is judged by.
 *
 * `now` and `dueSoonUntil` arrive as literals so every row in one response is
 * classified against one instant, and so a test can name that instant.
 */
function deadlineStages({ now, dueSoonUntil }) {
  return [
    {
      $addFields: {
        deadline: { $ifNull: ["$customerInfo.deliveryDeadline", "$estimatedCompletion"] },
      },
    },
    {
      $addFields: {
        deadlineRisk: {
          $switch: {
            branches: [
              // A finished or abandoned order has nothing left to be late for.
              { case: { $in: ["$displayStatus", ["completed", "cancelled"]] }, then: "closed" },
              { case: { $eq: [{ $ifNull: ["$deadline", null] }, null] }, then: "none" },
              { case: { $lt: ["$deadline", now] }, then: "overdue" },
              { case: { $lt: ["$deadline", dueSoonUntil] }, then: "due_soon" },
            ],
            default: "on_track",
          },
        },
      },
    },
  ];
}

/**
 * The `$match` for a search term.
 *
 * `requestId` is compared against the term with any leading `MO-` removed,
 * because the register displays `MO-<requestId>` and the stored field is the
 * bare id. Both forms are tried when they differ, so pasting either the
 * displayed number or the stored one finds the order. Every pattern is escaped
 * — see moListQuery.escapeRegex.
 */
function searchMatch(search) {
  if (!search) return null;
  const term = new RegExp(search.escapedTerm, "i");
  const clauses = [
    { "customerInfo.name": term },
    { "customerInfo.email": term },
    { requestId: term },
  ];
  if (search.escapedReference !== search.escapedTerm) {
    clauses.push({ requestId: new RegExp(search.escapedReference, "i") });
  }
  return { $or: clauses };
}

/**
 * The whole pipeline, for one normalised query.
 *
 * Filter order matters: `priority` is a stored field and joins the base match,
 * where it narrows the set before the work-order lookup runs. `status` and
 * `deadlineRisk` are derived, so they can only be matched after the stages that
 * compute them — but still before `$facet`, which is what makes
 * `pagination.total` a count of the FILTERED set rather than of everything.
 */
function buildListPipeline(q) {
  const baseMatch = { status: MO_BASE_STATUS };

  const search = searchMatch(q.search);
  if (search) Object.assign(baseMatch, search);

  // An unrecognised value is passed through rather than dropped, so it matches
  // nothing. Dropping it would turn a typo into "show me everything".
  if (q.priority) baseMatch.priority = q.priority.value;

  const derivedMatch = {};
  if (q.status) derivedMatch.displayStatus = q.status.value;
  if (q.deadlineRisk) derivedMatch.deadlineRisk = q.deadlineRisk.value;

  return [
    { $match: baseMatch },
    ...derivationStages(),
    ...deadlineStages(q),
    ...(Object.keys(derivedMatch).length ? [{ $match: derivedMatch }] : []),
    {
      $facet: {
        paginated: [
          // `_id` breaks ties. Two orders saved in the same millisecond used to
          // be returned in whatever order the engine chose, so a row could
          // appear on page one and again on page two, or on neither.
          { $sort: { updatedAt: -1, _id: -1 } },
          { $skip: q.skip },
          { $limit: q.limit },
          {
            $project: {
              _id: 1,
              requestId: 1,
              customerInfo: { name: 1, email: 1, deliveryDeadline: 1 },
              estimatedCompletion: 1,
              finalOrderPrice: 1,
              totalQuantity: 1,
              priority: 1,
              createdAt: 1,
              requestType: 1,
              measurementName: 1,
              workOrdersCount: 1,
              completionPercentage: 1,
              completedQuantity: "$_totalCompleted",
              // Historically aliased onto `status` here, and that alias stays —
              // every existing caller reads it. Also published under its own
              // name so the register and the three detail endpoints can be
              // compared field-for-field; they are the same value.
              status: "$derivedStatus",
              derivedStatus: 1,
              displayStatus: 1,
              // Additive, and never a replacement: deliveryDeadline and
              // estimatedCompletion are both still projected above.
              deadline: 1,
              deadlineRisk: 1,
            },
          },
        ],
        totalCount: [{ $count: "count" }],
      },
    },
  ];
}

/**
 * A percentage that is always publishable: finite, and inside 0-100.
 *
 * The pipeline already bounds this, so in the normal path this changes nothing.
 * It is here because the mapper is the last gate before the API, and a row that
 * reached it another way — a stubbed model, a future caller, a stage edited
 * without this one — must not be able to publish `250`, `-5` or `NaN`. A
 * missing or unreadable value reads as 0, matching the "no work orders yet"
 * answer rather than inventing progress.
 */
function boundedPercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * The pipeline behind the canonical detail summary: one order, same derivation.
 *
 * Deliberately NOT `buildListPipeline` with an id bolted on. That pipeline
 * opens with `{ status: "quotation_sales_approved" }`, which is what a
 * manufacturing order IS on the register — but the detail endpoints never
 * imposed that filter, and adding it would 404 orders their pages can open
 * today. So this matches by `_id` alone and then reuses the same
 * `derivationStages()` and `deadlineStages()` the list uses, which is the whole
 * point: there is one status formula, one completion formula and one deadline
 * vocabulary, and both readers run them.
 */
function buildSummaryPipeline(id, boundaries) {
  return [
    { $match: { _id: id } },
    ...derivationStages(),
    ...deadlineStages(boundaries),
    {
      $project: {
        _id: 1,
        totalQuantity: 1,
        workOrdersCount: 1,
        completedQuantity: "$_totalCompleted",
        completionPercentage: 1,
        // Published under its own name, never as `status`: these endpoints
        // already use `status` for the CustomerRequest's STORED value, and
        // overwriting it would change what an existing caller reads.
        derivedStatus: 1,
        displayStatus: 1,
        deadline: 1,
        deadlineRisk: 1,
      },
    },
  ];
}

/**
 * The eight canonical values, as the detail endpoints publish them.
 *
 * Same bounds and same fallbacks as `projectRow`, so a field cannot mean one
 * thing on the register and another on the page opened from it.
 */
function projectSummary(r) {
  return {
    totalQuantity: r.totalQuantity || 0,
    workOrdersCount: r.workOrdersCount || 0,
    // The real completed-unit count. It may exceed the ordered quantity after a
    // re-issue, and is NOT clamped — only the percentage is.
    completedQuantity: r.completedQuantity || 0,
    completionPercentage: boundedPercentage(r.completionPercentage),
    derivedStatus: r.derivedStatus || "pending",
    displayStatus: r.displayStatus || "pending",
    deadline: r.deadline || null,
    deadlineRisk: r.deadlineRisk || "none",
  };
}

/**
 * One aggregation row as the API publishes it.
 *
 * Every field the register and the Project Manager dashboard already read is
 * produced here with the same name, the same fallback and the same meaning.
 * `deadline` and `deadlineRisk` are the only additions.
 */
function projectRow(r) {
  return {
    _id: r._id,
    moNumber: `MO-${r.requestId}`,
    customerInfo: {
      name: r.customerInfo?.name || "N/A",
      email: r.customerInfo?.email || "N/A",
    },
    finalOrderPrice: r.finalOrderPrice || 0,
    totalQuantity: r.totalQuantity || 0,
    workOrdersCount: r.workOrdersCount || 0,
    completedQuantity: r.completedQuantity || 0,
    completionPercentage: boundedPercentage(r.completionPercentage),
    status: r.status,
    // Additive: the same value `status` carries, under the name the detail
    // endpoints publish it as. `status` is unchanged for existing callers.
    derivedStatus: r.derivedStatus || r.status || "pending",
    // Simplified 3-bucket status for card display (pending/in_progress/completed, +cancelled)
    displayStatus: r.displayStatus || "pending",
    priority: r.priority,
    createdAt: r.createdAt,
    requestType: r.requestType || "customer_request",
    measurementName: r.measurementName || null,
    deliveryDeadline: r.customerInfo?.deliveryDeadline || null,
    estimatedCompletion: r.estimatedCompletion || null,
    // ── additive ───────────────────────────────────────────────────────────
    // The date the two above resolve to, and the band it falls in. Present so
    // a caller does not have to re-derive server-side filtering client-side.
    deadline: r.deadline || null,
    deadlineRisk: r.deadlineRisk || "none",
  };
}

module.exports = {
  MO_BASE_STATUS,
  buildSummaryPipeline,
  projectSummary,
  DISPLAY_STATUSES,
  derivationStages,
  deadlineStages,
  searchMatch,
  buildListPipeline,
  projectRow,
};
