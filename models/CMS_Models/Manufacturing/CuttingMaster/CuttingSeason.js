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
  /* "all": the whole sticker went to the season (quantityAtScan = what it held).
     "part": a cut piece of the roll was taken (14 Oct 2026, owner) —
     quantityAtScan is that piece, stickerQty what the roll held, and at Close
     only what was used of the piece comes off the sticker. */
  portion: { type: String, enum: ["all", "part"], default: "all" },
  stickerQty: { type: Number, default: null },
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

/* ONE LAY OF THE DAILY FABRIC CUTTING LOGBOOK (14 Oct 2026, owner): the
   season is filled in like the floor's register instead of being scanned.
   Only the typed columns are stored; every worked-out column (pcs cut,
   consumed, wastage, consumption variance, status) is computed on read by
   services/manufacturing/cuttingLogBook.js, so it can never disagree with
   the inputs it came from. */
const sizeRatio = { XS: Number, S: Number, M: Number, L: Number, XL: Number, XXL: Number, "3XL": Number };
const laySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  tableNo: { type: String, default: "" },
  cuttingMaster: { type: String, default: "" },
  styleNo: { type: String, required: true },
  colour: { type: String, default: "" },
  layNo: { type: String, default: "" },
  fabricLot: { type: String, default: "" },
  markerLength: { type: Number, required: true },
  markerWidth: { type: Number, default: null },
  /* "ft" since 15 Oct 2026; absent on an older lay = metres (length) and inches (width) */
  markerUnit: { type: String, enum: ["m", "ft"] },
  /* a fraction, as the workbook stores it: 0.84 is 84% */
  markerEff: { type: Number, default: null },
  ratio: { type: sizeRatio, default: () => ({}) },
  plies: { type: Number, required: true },
  fabricIssued: { type: Number, default: null },
  fabricReturned: { type: Number, default: null },
  bomCons: { type: Number, default: null },
  remarks: { type: String, default: "" },
  createdBy: who,
  updatedBy: who,
}, { timestamps: true });

/* THE PPC LAY IT WAS STARTED FOR (16 Oct 2026). A season started from PPC's
   Cutting plan keeps the lay(s) and what they asked of each work order, as
   they were then — PPC may re-plan later and the season still says what it
   was handed. `suggestion` is the lay row it was handed to start from (the
   log book's own cell values); the comparison with what was cut is made on
   read (services/manufacturing/cuttingSeasonPlan.js), never stored. Null on
   a season started without a plan, which stays allowed. */
const planSchema = new mongoose.Schema({
  lays: { type: [new mongoose.Schema({ layKey: String, date: String, time: String, start: String, label: String, pieces: Number }, { _id: false })], default: [] },
  lines: { type: [new mongoose.Schema({ workOrderId: String, workOrderNumber: String, moId: String, moNumber: String, customerName: String, targetId: String, productName: String, styleNo: String, size: String, colour: String, photo: String, bomCons: Number, pieces: Number, fabricKey: String, fabricName: String, fabricShade: String }, { _id: false })], default: [] },
  fabrics: { type: [new mongoose.Schema({ key: String, rawItemId: String, variant: String, name: String, pieces: Number }, { _id: false })], default: [] },
  pieces: { type: Number, default: 0 },
  cutPlan: { type: mongoose.Schema.Types.Mixed, default: null },
  suggestion: { type: mongoose.Schema.Types.Mixed, default: null },
  takenAt: { type: Date, default: null },
  takenBy: who,
}, { _id: false });

const cuttingSeasonSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  /* Nobody types a name any more (14 Oct 2026): it is made from the report
     details and the lay on every save. A season named by hand before keeps it. */
  nameAuto: { type: Boolean, default: false },
  status: { type: String, enum: ["draft", "active", "closed"], default: "draft", index: true },
  createdBy: who,
  startedAt: { type: Date, default: null },
  startedBy: who,
  closedAt: { type: Date, default: null },
  closedBy: who,
  /* Removed from the list (15 Oct 2026, owner: "a delete button in each
     season"). Kept, not erased: every read leaves out a season with
     `deletedAt` set, and a removed season can be found again by id. */
  deletedAt: { type: Date, default: null },
  deletedBy: who,
  note: { type: String, default: "", maxlength: 1000 },
  /* The daily report's header line — Buyer Name, PO No, Style No, Colour, Date. */
  header: {
    buyerName: { type: String, default: "" },
    poNo: { type: String, default: "" },
    styleNo: { type: String, default: "" },
    colour: { type: String, default: "" },
    date: { type: Date, default: null },
  },
  /* The cutting log book, one row per lay (since 14 Oct 2026). */
  lays: { type: [laySchema], default: [] },
  /* Before 14 Oct 2026 a season was scanned: fabric stickers in, cut pieces
     out. Kept so those seasons still open with their record. */
  rawItems: { type: [rawItemSchema], default: [] },
  pieces: { type: [pieceSchema], default: [] },
  /* filled at Close; a live tally is computed on read while active */
  products: { type: [productSchema], default: [] },
  piecesCount: { type: Number, default: 0 },
  plan: { type: planSchema, default: null },
}, { timestamps: true, collection: "cutting_seasons" });

/* An auto-named season takes its name from what was typed into it, on every
   save. Validation runs before timestamps, so a new season counts as today. */
cuttingSeasonSchema.pre("validate", function nameFromLogBook() {
  if (!this.nameAuto) return;
  const { seasonName } = require("../../../../services/manufacturing/cuttingLogBook");
  this.name = seasonName({ header: this.header, lays: this.lays, createdAt: this.createdAt || new Date() });
});

cuttingSeasonSchema.index({ companyId: 1, status: 1, createdAt: -1 });
cuttingSeasonSchema.index({ companyId: 1, "rawItems.barcodeId": 1 });
cuttingSeasonSchema.index({ companyId: 1, "pieces.workOrderId": 1, "pieces.unitNumber": 1 });
cuttingSeasonSchema.index({ companyId: 1, "plan.lays.layKey": 1 });

module.exports = mongoose.models.CuttingSeason || mongoose.model("CuttingSeason", cuttingSeasonSchema);
