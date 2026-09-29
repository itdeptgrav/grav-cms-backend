// models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason.js
//
// A CUTTING SEASON (25 Sep 2026): the fabric a cutting master was given and
// the pieces they cut from it, as one record.
//
//   draft   the season exists; fabric stickers are being scanned in
//   active  Start was pressed: the fabric list is frozen, pieces are scanned
//   closed  Close was pressed: fabric consumption is settled on each sticker's
//           cutting session and the pieces are summarised product by product
//
// The season is the SERVER's memory of where the cutting master is — a
// browser reload, a new device or a new day resumes the open season from
// here, never from localStorage. Fabric consumption is still recorded on the
// Product Marking sticker's own `cuttingSessions` (Barcode model), exactly as
// the raw-item tracker did; the season only names which session it opened
// and closed, so nothing about stock is recorded twice.
"use strict";
const mongoose = require("mongoose");

const who = { id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, default: "" }, employeeId: { type: String, default: "" } };

const rawItemSchema = new mongoose.Schema({
  barcodeId: { type: mongoose.Schema.Types.ObjectId, ref: "Barcode", required: true },
  rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
  rawItemName: { type: String, default: "" },
  rawItemSku: { type: String, default: "" },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  variantText: { type: String, default: "" },
  unit: { type: String, default: "" },
  /* the sticker's quantity when it was scanned into the season — "how much fabric was given" */
  quantityAtScan: { type: Number, default: 0 },
  scannedAt: { type: Date, default: Date.now },
  scannedBy: who,
  /* the sticker's cutting session this season opened at Start and closed at Close */
  sessionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  startQty: { type: Number, default: null },
  endQty: { type: Number, default: null },
  usedQty: { type: Number, default: null },
}, { _id: false });

const pieceSchema = new mongoose.Schema({
  barcode: { type: String, required: true },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true },
  unitNumber: { type: Number, required: true },
  scannedAt: { type: Date, default: Date.now },
  scannedBy: who,
}, { _id: false });

const productSchema = new mongoose.Schema({
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },
  workOrderNumber: { type: String, default: "" },
  moNumber: { type: String, default: "" },
  customerName: { type: String, default: "" },
  productName: { type: String, default: "" },
  productReference: { type: String, default: "" },
  variantText: { type: String, default: "" },
  photo: { type: String, default: null },
  quantity: { type: Number, default: 0 },
  count: { type: Number, default: 0 },
}, { _id: false });

const cuttingSeasonSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  status: { type: String, enum: ["draft", "active", "closed"], default: "draft", index: true },
  createdBy: who,
  startedAt: { type: Date, default: null },
  startedBy: who,
  closedAt: { type: Date, default: null },
  closedBy: who,
  note: { type: String, default: "", maxlength: 1000 },
  rawItems: { type: [rawItemSchema], default: [] },
  pieces: { type: [pieceSchema], default: [] },
  /* filled at Close; a live tally is computed on read while active */
  products: { type: [productSchema], default: [] },
  piecesCount: { type: Number, default: 0 },
}, { timestamps: true, collection: "cutting_seasons" });

cuttingSeasonSchema.index({ companyId: 1, status: 1, createdAt: -1 });
cuttingSeasonSchema.index({ companyId: 1, "rawItems.barcodeId": 1 });
cuttingSeasonSchema.index({ companyId: 1, "pieces.workOrderId": 1, "pieces.unitNumber": 1 });

module.exports = mongoose.models.CuttingSeason || mongoose.model("CuttingSeason", cuttingSeasonSchema);
