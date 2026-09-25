// models/CMS_Models/Manufacturing/Finishing/FinishingScan.js
//
// ONE GARMENT, DONE AT ONE FINISHING STAGE, BY ONE PERSON, AT ONE MOMENT.
//
// Trimming and Ironing both record the same fact, so they share this
// collection under a `stage` key — one collection, not two, on a cluster that
// is nine collections from its cap (see the atlas-cluster-collection-cap note).
//
// ── WHAT IS RECORDED ────────────────────────────────────────────────────────
// The piece (work order + unit number, exactly what its barcode says), the
// order it belongs to and the product it is (denormalised, so a day's report
// never has to load work orders), WHEN it was done — `doneAt` is the scan
// moment on the device, which can be hours before `recordedAt` when the
// device was offline — and WHO: the signed-in person, from the session.
//
// ── A PIECE IS DONE ONCE PER STAGE ──────────────────────────────────────────
// The unique index on {stage, workOrderId, unitNumber} is the rule. A second
// scan of the same piece is a duplicate key, reported as "already done by X at
// T" rather than counted twice — which is also what makes the offline queue
// safe to re-send: a batch that half-arrived is sent again and the half that
// arrived is refused, piece by piece.

const mongoose = require("mongoose");
const { STAGE_KEYS } = require("../../../../services/manufacturing/finishingStages");

const doneBySchema = new mongoose.Schema(
  {
    userId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    employeeId: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    role: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const finishingScanSchema = new mongoose.Schema(
  {
    stage: { type: String, enum: STAGE_KEYS, required: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true },
    workOrderShortId: { type: String, trim: true, default: "" },
    workOrderNumber: { type: String, trim: true, default: "" },
    unitNumber: { type: Number, required: true, min: 1 },
    barcode: { type: String, trim: true, default: "" },

    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    moNumber: { type: String, trim: true, default: "" },
    customerName: { type: String, trim: true, default: "" },
    stockItemId: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", default: null },
    productName: { type: String, trim: true, default: "" },
    variantId: { type: String, trim: true, default: "" },
    variantAttributes: [new mongoose.Schema({ name: String, value: String }, { _id: false })],

    doneAt: { type: Date, required: true },
    recordedAt: { type: Date, default: Date.now },
    doneBy: { type: doneBySchema, default: () => ({}) },
    /* scanner = hand scanner into the field, camera = phone camera, manual =
       typed, sync = arrived from the device's offline queue. */
    source: { type: String, enum: ["scanner", "camera", "manual", "sync"], default: "scanner" },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: false },
);

finishingScanSchema.index({ stage: 1, workOrderId: 1, unitNumber: 1 }, { unique: true });
finishingScanSchema.index({ companyId: 1, stage: 1, doneAt: -1 });
finishingScanSchema.index({ companyId: 1, stage: 1, manufacturingOrderId: 1 });
finishingScanSchema.index({ companyId: 1, stage: 1, "doneBy.userId": 1, doneAt: -1 });

module.exports =
  mongoose.models.FinishingScan || mongoose.model("FinishingScan", finishingScanSchema);
