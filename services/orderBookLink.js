// services/orderBookLink.js
//
// The durable Opportunity → Order Book link, written when a PO is recorded.
//
// WHY THIS EXISTS
//
// The journey's post-PO screens (Production, Shipment, Order Closing) all read
// the same underlying order record — a CustomerRequest, with its WorkOrders and
// DispatchChallans hanging off it. They reach it through the enquiry, and when
// `enquiry.customerRequestId` is unset they fall back to `resolveRequestId()` in
// routes/CMS_Routes/Sales/enquiries.js, which finds the customer by a
// case-insensitive regex on their NAME and gives up as "ambiguous" whenever two
// accounts are named similarly. A rename breaks it; a near-duplicate defeats it.
//
// Recording the PO is the natural moment to stop guessing: it is the point at
// which an opportunity becomes an order, so it is the point at which the order
// record should be nailed down by id.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never CREATES a CustomerRequest. Creating one needs `customerId`, a
// reference to a portal Customer, and the only route from a journey to one is
// CRMAccount.linkedCustomer — which is set on 3 of 6 accounts in this database.
// For the rest there is no honest value to write, and inventing a customer to
// satisfy a schema would put a fictional party on a real order. Those journeys
// keep the existing name-match fallback until an account is linked.
//
// It is also NON-FATAL by construction. A PO is a real commercial fact; failing
// to record one because a convenience link could not be resolved would be a far
// worse bug than the missing link. Every failure path returns a reason and the
// caller ignores it.

const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const Account = require("../models/CMS_Models/Sales/Account");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");

/**
 * Ensure the journey's enquiry stores the id of its order record.
 *
 * @param {object} journey  a SalesJourney document (needs _id, accountId)
 * @param {object} [deps]    model overrides, for tests. Defaults are the real
 *                           models; nothing in production passes this.
 * @returns {Promise<{linked: boolean, reason: string, customerRequestId?: any, requestId?: string}>}
 */
async function ensureOrderLink(journey, deps = {}) {
  const {
    Enquiry: EnquiryModel = Enquiry,
    Account: AccountModel = Account,
    CustomerRequest: CustomerRequestModel = CustomerRequest,
  } = deps;
  try {
    if (!journey?._id) return { linked: false, reason: "no-journey" };

    const enquiry = await EnquiryModel.findOne({ journeyId: journey._id, isActive: true });
    if (!enquiry) return { linked: false, reason: "no-enquiry-on-journey" };

    // Already pinned — by this function on an earlier PO edit, by the quotation
    // screen, or by the production route back-filling it. Nothing to do.
    if (enquiry.customerRequestId) {
      return { linked: true, reason: "already-linked", customerRequestId: enquiry.customerRequestId };
    }

    if (!journey.accountId) return { linked: false, reason: "journey-has-no-account" };

    // The one honest hop: CRMAccount -> portal Customer, by stored id.
    const account = await AccountModel.findById(journey.accountId).select("linkedCustomer").lean();
    if (!account?.linkedCustomer) return { linked: false, reason: "account-not-linked-to-portal-customer" };

    // Newest open order for that customer. Newest rather than any, because a
    // customer accumulates requests over time and the one being PO'd is the one
    // most recently raised.
    const request = await CustomerRequestModel.findOne({ customerId: account.linkedCustomer })
      .sort({ createdAt: -1 })
      .select("_id requestId")
      .lean();
    if (!request) return { linked: false, reason: "no-order-record-for-this-customer" };

    enquiry.customerRequestId = request._id;
    await enquiry.save();

    return { linked: true, reason: "linked", customerRequestId: request._id, requestId: request.requestId };
  } catch (err) {
    // Logged, never thrown — see the non-fatal note above.
    console.error("[orderBookLink] ensureOrderLink failed:", err.message);
    return { linked: false, reason: "error" };
  }
}

module.exports = { ensureOrderLink };
