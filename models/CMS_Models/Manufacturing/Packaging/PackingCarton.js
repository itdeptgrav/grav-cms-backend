// models/CMS_Models/Manufacturing/Packaging/PackingCarton.js
//
// ONE PHYSICAL BOX, AND EXACTLY WHAT WENT INTO IT.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Packing used to be recorded as a quantity against a work order:
// `WorkOrder.packagingRecords[]` says "24 units of this order were packed at
// 14:02 by Priya", and the unit numbers are listed. What it cannot say is which
// BOX those units are in. Two cartons packed a minute apart against the same
// order are indistinguishable, so when a customer opens carton 3 and finds
// carton 5's contents, nothing in the system can confirm or deny it.
//
// This is the industry-standard answer: a carton is a record, it has a number
// printed on its label, and the record lists every piece inside it — by work
// order (so product and variant are known), by unit number (so each garment
// is individually accounted for), and by the person it was made for when the
// order is a measurement order. The legacy quantity fields on the work order
// are still updated so every screen that reads them keeps working, and each of
// those records now carries the carton it belongs to.
//
// ── A CARTON CAN BE FILLED OVER SEVERAL SESSIONS ────────────────────────────
// Five pieces today, three more tomorrow, into the same box. `lines` is always
// the box's CURRENT contents (merged, one line per work order — or per person
// on a measurement order); `additions` is the history of how it got there: one
// entry per packing session, with who, when, how many and exactly which units.
// "Who packed this piece" is answered from `additions`, never from the carton's
// first packer, because they are different people as soon as a second session
// happens. The hourly report counts `additions` for the same reason: a carton
// opened yesterday and topped up today has pieces in both days.
//
// ── ONE CARTON, ONE ORDER ───────────────────────────────────────────────────
// A carton belongs to exactly one manufacturing order. The route refuses to
// seal — or top up — a carton with pieces from another order, because the
// label names ONE PO and the receiving bay checks the box against that PO.
//
// ── WHO PACKED IT IS A PERSON, NOT A STRING ─────────────────────────────────
// `packedBy` carries the signed-in user's id, name, employee id and email,
// taken from the session — never from the request body.

const mongoose = require("mongoose");

const variantAttributeSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    value: { type: String, trim: true },
  },
  { _id: false },
);

/** One work order's contribution to the carton — or, on a measurement order,
 *  one PERSON's garments from that work order. */
const cartonLineSchema = new mongoose.Schema(
  {
    workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true },
    workOrderNumber: { type: String, trim: true, default: "" },
    /* The last 8 characters of the work order id — what the piece barcodes
       carry, kept here so a scan can be matched without re-deriving it. */
    workOrderShortId: { type: String, trim: true, default: "" },

    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem" },
    productName: { type: String, trim: true, default: "" },
    productReference: { type: String, trim: true, default: "" },
    variantId: { type: String, trim: true, default: "" },
    variantAttributes: [variantAttributeSchema],

    packagingType: { type: String, enum: ["person_wise", "bulk"], default: "bulk" },
    /* Present only on person-wise (measurement) orders. */
    employee: {
      progressDocId: { type: mongoose.Schema.Types.ObjectId, default: null },
      employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc", default: null },
      employeeName: { type: String, trim: true, default: "" },
      employeeUIN: { type: String, trim: true, default: "" },
    },

    /* The individual garments. `quantity` is always `unitNumbers.length`;
       stored separately so a list view never has to load the array. */
    unitNumbers: { type: [Number], default: [] },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: true },
);

const packedBySchema = new mongoose.Schema(
  {
    userId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    employeeId: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    role: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/** One packing session: the pieces put into this box in one go. */
const additionSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    packedBy: { type: packedBySchema, default: () => ({}) },
    quantity: { type: Number, required: true, min: 1 },
    notes: { type: String, trim: true, default: "" },
    items: [
      new mongoose.Schema(
        {
          workOrderId: { type: mongoose.Schema.Types.ObjectId, required: true },
          progressDocId: { type: mongoose.Schema.Types.ObjectId, default: null },
          unitNumbers: { type: [Number], default: [] },
        },
        { _id: false },
      ),
    ],
  },
  { _id: true },
);

const packingCartonSchema = new mongoose.Schema(
  {
    cartonNumber: { type: String, required: true, unique: true, trim: true, uppercase: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* Null only for a work order that predates the Sales-line link and names
       no order at all. The route still refuses to MIX orders in one carton;
       it does not refuse to pack legacy work that has none. */
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    moNumber: { type: String, trim: true, default: "" },
    /* What the customer calls this order on their side (CustomerRequest.poProof.poNumber).
       Blank when Sales never recorded one — the label then shows the MO number alone. */
    poNumber: { type: String, trim: true, default: "" },
    customerName: { type: String, trim: true, default: "" },
    requestType: { type: String, trim: true, default: "" },

    lines: { type: [cartonLineSchema], default: [] },
    totalQuantity: { type: Number, default: 0, min: 0 },
    workOrderCount: { type: Number, default: 0, min: 0 },

    /* Who OPENED the carton, and when. Later sessions are in `additions`. */
    packedBy: { type: packedBySchema, default: () => ({}) },
    packedAt: { type: Date, default: Date.now },
    lastPackedAt: { type: Date, default: null },
    notes: { type: String, trim: true, default: "" },

    additions: { type: [additionSchema], default: [] },

    status: { type: String, enum: ["packed", "dispatched"], default: "packed" },
    dispatchedAt: { type: Date, default: null },
    dispatchChallanId: { type: mongoose.Schema.Types.ObjectId, ref: "DispatchChallan", default: null },
  },
  { timestamps: true },
);

packingCartonSchema.index({ companyId: 1, packedAt: -1 });
packingCartonSchema.index({ companyId: 1, manufacturingOrderId: 1, packedAt: -1 });
/* "Which carton holds unit 37 of this work order?" — the Find Piece question.
   Indexed on the work order only: `lines` and `lines.unitNumbers` are both
   arrays, and a compound index over two array paths is exactly the
   "parallel arrays" shape MongoDB refuses. The unit is matched in $elemMatch
   against the handful of lines the work-order key narrows to. */
packingCartonSchema.index({ companyId: 1, "lines.workOrderId": 1 });
/* The hourly report reads sessions by time. */
packingCartonSchema.index({ companyId: 1, "additions.at": -1 });

module.exports =
  mongoose.models.PackingCarton || mongoose.model("PackingCarton", packingCartonSchema);
