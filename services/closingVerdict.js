// services/closingVerdict.js
//
// The server-side answer to "may this order be closed?".
//
// The closing checks were computed properly (services/closingReport.js) and
// shown properly (the Order Closing screen disables its button on unmet checks)
// — but the CLOSE ITSELF never consulted them. A disabled button is not a
// control: anything calling POST /sales-journeys/:id/stage directly closed the
// order with money outstanding and pieces undelivered. This is what the stage
// route hands the planner so the refusal happens where it cannot be bypassed.
//
// WHY NOT REUSE THE ENQUIRY ROUTE'S VERSION
//
// routes/.../enquiries.js has GET /:id/closing-report, which assembles the same
// data — but it also resolves the CustomerRequest by fuzzy customer-name match
// and WRITES the result back onto the enquiry when it finds one. A permission
// gate must not mutate anything, so this reads the stored link only. An enquiry
// that has never had its request linked yields no verdict rather than a match
// this function guessed at.
//
// RETURNS
//   { canClose, blockers, checklistCount }  — a real verdict, trust it
//   null                                    — no verdict could be computed
//
// A null is not permission; it is the absence of an answer. The planner treats
// it as "no financial objection known", which is deliberate: refusing on null
// would make orders that legitimately have no work order impossible to close.
// The reason is always logged so a silent null is never mistaken for a pass.

const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const DispatchChallan = require("../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const { buildClosingReport } = require("./closingReport");

/**
 * @param {ObjectId|string} journeyId  the SalesJourney _id
 * @returns {Promise<{canClose:boolean, blockers:number, checklistCount:number}|null>}
 */
async function closingVerdictForJourney(journeyId) {
  const why = (reason) => {
    console.log(`[closingVerdict] no verdict for journey ${journeyId}: ${reason}`);
    return null;
  };

  try {
    const enquiry = await Enquiry.findOne({ journeyId, isActive: true });
    if (!enquiry) return why("no active enquiry on this journey");

    // Stored link only — no fuzzy matching, no writes.
    const requestId = enquiry.customerRequestId;
    if (!requestId) return why("enquiry is not linked to a customer request");

    const [workOrders, challans, request] = await Promise.all([
      WorkOrder.find({ customerRequestId: requestId })
        .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity assignedDeadline "
              + "dispatchedQuantity estimatedCost actualCost rawMaterials.quantityIssued rawMaterials.unitCost "
              + "productionCompletion.operationCompletion productionCompletion.timeMetrics "
              + "productionCompletion.invalidScansCount")
        .lean(),
      DispatchChallan.find({ manufacturingOrderId: requestId })
        .select("challanNumber dispatchType totalUnits totalPersons createdAt "
              + "persons.employeeName persons.department persons.totalUnits")
        .lean(),
      CustomerRequest.findById(requestId)
        .select("requestId grandTotal paymentSchedule quotations.grandTotal").lean(),
    ]);

    if (!workOrders.length) return why("no work order was raised against this order");

    const report = buildClosingReport({
      workOrders, challans, request, enquiry: enquiry.toObject(),
    });

    if (!report || typeof report.canClose !== "boolean") {
      return why("closing report returned no canClose verdict");
    }

    return {
      canClose: report.canClose,
      blockers: Number(report.blockers) || 0,
      checklistCount: Array.isArray(report.checklist) ? report.checklist.length : 0,
    };
  } catch (err) {
    // A gate that throws would block closing on an unrelated fault. Log loudly,
    // return no verdict, and let the planner's other guards still apply.
    console.error(`[closingVerdict] failed for journey ${journeyId}:`, err.message);
    return null;
  }
}

module.exports = { closingVerdictForJourney };
