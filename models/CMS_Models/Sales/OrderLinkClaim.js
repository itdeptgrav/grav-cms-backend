// models/CMS_Models/Sales/OrderLinkClaim.js
//
// ONE ORDER, ONE ENQUIRY — enforced by the database, not by a check.
//
// `Enquiry.customerRequestId` is not unique, and cannot simply be made unique:
//   • production runs with `autoIndex` off (server.js), so a new schema index
//     does not exist in production until someone builds it by hand — and until
//     then nothing is enforced at all;
//   • building a unique index fails outright if any duplicate already exists,
//     and legacy links (written by the name/recency guesses) were never
//     checked for duplicates;
//   • a plain unique index would also count inactive enquiries and legacy
//     unverified links, blocking corrections for reasons nobody can see.
//
// So a PROVED link is claimed here instead. The claim's `_id` IS the order's
// id, and `_id` is unique on every MongoDB collection from the moment the
// collection exists — no index to build, no deploy step, nothing to migrate.
// Two enquiries racing for one order both try to insert the same `_id`; one of
// them gets E11000.
//
// A claim is written BEFORE the enquiry link and released after a link moves
// off the order. A crash between the two leaves a claim whose enquiry does not
// link the order; services/orderBookLink.js treats such a claim as stale (after
// a grace period that covers a write in flight) and takes it over
// conditionally, so a lost process can never lock an order away forever.
//
// Only links written through services/orderBookLink.js are claimed. Links
// written before G02 carry no claim; they are UNVERIFIED and are never
// trusted, and the chooser still refuses an order another active enquiry holds.

const mongoose = require("mongoose");

const orderLinkClaimSchema = new mongoose.Schema(
  {
    // The CustomerRequest _id. Its uniqueness is the whole point.
    _id: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", required: true },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry", required: true },
    // For audit only. Ownership is proved through the enquiry, never from here.
    companyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    method: { type: String, enum: ["sales_origin", "manual"], required: true },
    claimedAt: { type: Date, required: true },
  },
  { collection: "order_link_claims", versionKey: false },
);

module.exports = mongoose.models.OrderLinkClaim
  || mongoose.model("OrderLinkClaim", orderLinkClaimSchema);
