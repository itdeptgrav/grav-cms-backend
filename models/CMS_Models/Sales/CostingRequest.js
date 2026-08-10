// models/CMS_Models/Sales/CostingRequest.js
//
// COSTING REQUEST — the cross-department costing/RFQ that backs one Cowork
// costing sheet, raised from an Enquiry (and reused later at Cost & Quote).
//
// WHY ITS OWN COLLECTION (not a field on Enquiry):
//   It is a hand-off with its own lifecycle (requested → in_progress → returned)
//   and its own participants (a merchandiser + an industrial engineer, identified
//   by their COWORK identity, not GRAV-CMS users). An enquiry can have more than
//   one over time (a re-cost after a spec change; the formal quote at stage 4),
//   so it links back by `enquiryId` rather than embedding.
//
// WHAT LIVES ELSEWHERE:
//   • The actual numbers live in the Cowork sheet (`coworkDocumentId`), never
//     copied here — grav-cms provisions that sheet directly (see
//     lib/costingSheet/*). This record is the LINK + the STATUS, not the costing.
//   • The customer/opportunity is `enquiryId`/`journeyId`/`accountId` (refs).
//   • The indicative price Sales derives is keyed onto the Enquiry, not here.

const mongoose = require("mongoose");
const {
  COSTING_REQUEST_STATUS_CODES,
  COSTING_REQUEST_PURPOSE_CODES,
} = require("../../../constants/crm");

// GRAV-CMS actor (the salesperson raising/updating the request).
const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

// A costing participant, identified by their COWORK EmployeeId (the
// `cowork_employees` doc id, e.g. "E001") — the same id-space the Cowork sheet's
// membership uses. Name is a convenience label resolved at pick time.
const coworkPersonRef = () => ({
  employeeId: { type: String, trim: true },
  name: { type: String, trim: true },
});

const costingRequestSchema = new mongoose.Schema(
  {
    // The opportunity this costs. Indexed — "this enquiry's costing requests".
    enquiryId: { type: mongoose.Schema.Types.ObjectId, ref: "Enquiry", required: true, index: true },
    journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesJourney", index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", index: true },

    // Indicative (raised at Enquiry) vs the formal quote (reused at Cost & Quote).
    purpose: { type: String, enum: COSTING_REQUEST_PURPOSE_CODES, default: "enquiry_indicative", index: true },

    // The Cowork sheet (workbook) that carries the costing. Provisioned by
    // grav-cms writing Cowork's Firestore (P1); its id lands here.
    coworkDocumentId: { type: String, trim: true },

    // Who fills the sheet — Cowork identities, not GRAV-CMS users.
    merchandiser: coworkPersonRef(),
    industrialEngineer: coworkPersonRef(),

    status: { type: String, enum: COSTING_REQUEST_STATUS_CODES, default: "requested", index: true },

    // A snapshot of the enquiry's product lines at request time, so the sheet's
    // provenance is legible even if the enquiry changes later.
    lines: [
      new mongoose.Schema(
        {
          product: { type: String, trim: true, required: true },
          quantity: { type: Number, min: 0 },
        },
        { _id: false },
      ),
    ],

    // Sales' manual summary after reading the Master tab (the estimate return is
    // manual by design — no auto cell-scraping). The number itself is keyed onto
    // the Enquiry's indicative pricing.
    resultNote: { type: String, trim: true },

    requestedBy: actorRef(),
    createdBy: actorRef(),
    updatedBy: actorRef(),

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// "This enquiry's requests, newest first" and the remembered-team lookup.
costingRequestSchema.index({ enquiryId: 1, createdAt: -1 });
costingRequestSchema.index({ "requestedBy.id": 1, createdAt: -1 });

module.exports = mongoose.models.CostingRequest || mongoose.model("CostingRequest", costingRequestSchema);
