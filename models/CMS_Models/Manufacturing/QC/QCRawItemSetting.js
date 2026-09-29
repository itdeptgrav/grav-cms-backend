// models/CMS_Models/Manufacturing/QC/QCRawItemSetting.js
//
// THE RAW ITEM CHECKING SETUP (28 Sep 2026): what the QC owner defines on
// QC › Raw item setup, in one collection, two kinds of row:
//
//   kind: "defect"   a rejection reason a checker can pick when a sticker
//                    fails — code, name, category. Separate from the product
//                    defect types (`qc_defect_types`) on purpose: "shade
//                    variation" and "short length" are reasons for a roll of
//                    fabric, not for a stitched garment, and the product
//                    picker must never offer them.
//   kind: "checker"  a QC person allowed to check raw items — by email, the
//                    same identity every QC grant uses. The owner always may.
//
// Collection: `qc_raw_item_settings` — the empty, unreferenced orphan
// `helpers` renamed (Atlas cluster at its collection cap).
"use strict";

const mongoose = require("mongoose");

const KINDS = Object.freeze(["defect", "checker"]);

const schema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },

    /* kind: "defect" */
    code:        { type: String, trim: true, uppercase: true, default: "" },
    name:        { type: String, trim: true, default: "" },
    category:    { type: String, trim: true, default: "OTHER" },
    description: { type: String, trim: true, default: "" },
    sortOrder:   { type: Number, default: 0 },

    /* kind: "checker" */
    email:       { type: String, trim: true, lowercase: true, default: "" },
    biometricId: { type: String, trim: true, default: "" },
    validFrom:   { type: Date, default: null },
    validTo:     { type: Date, default: null },
    note:        { type: String, trim: true, default: "" },
    /* may this checker ALSO inspect product pieces (the Inspect piece
       station)? On by default (29 Sep 2026); off keeps them to raw items. */
    productCheck: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true, index: true },

    createdByEmail: { type: String, default: "", lowercase: true, trim: true },
    createdByName:  { type: String, default: "" },
    updatedByEmail: { type: String, default: "", lowercase: true, trim: true },
    updatedByName:  { type: String, default: "" },
  },
  { timestamps: true, collection: "qc_raw_item_settings" },
);

/* one active code per defect; one active row per checker */
schema.index({ kind: 1, code: 1 }, { unique: true, partialFilterExpression: { kind: "defect", isActive: true } });
schema.index({ kind: 1, email: 1 }, { unique: true, partialFilterExpression: { kind: "checker", isActive: true } });
schema.index({ kind: 1, isActive: 1, sortOrder: 1 });

/** The reasons a factory usually starts with; loaded on request, never forced. */
const STANDARD_DEFECTS = Object.freeze([
  { code: "SHADE",   name: "Shade variation",        category: "FABRIC" },
  { code: "SHORT",   name: "Short quantity / length", category: "QUANTITY" },
  { code: "HOLE",    name: "Hole / cut",              category: "FABRIC" },
  { code: "STAIN",   name: "Stain / dirt",            category: "FABRIC" },
  { code: "WEAVE",   name: "Weaving fault",           category: "FABRIC" },
  { code: "WIDTH",   name: "Wrong width",             category: "SPEC" },
  { code: "GSM",     name: "Wrong GSM / weight",      category: "SPEC" },
  { code: "COLOUR",  name: "Wrong colour",            category: "SPEC" },
  { code: "DAMAGE",  name: "Damaged in transit",      category: "PACKING" },
  { code: "LABEL",   name: "Label / roll mismatch",   category: "PACKING" },
  { code: "TRIM",    name: "Wrong trim / accessory",  category: "TRIMS" },
  { code: "OTHER",   name: "Other (write a note)",    category: "OTHER" },
]);

module.exports = mongoose.models.QCRawItemSetting || mongoose.model("QCRawItemSetting", schema);
module.exports.KINDS = KINDS;
module.exports.STANDARD_DEFECTS = STANDARD_DEFECTS;
