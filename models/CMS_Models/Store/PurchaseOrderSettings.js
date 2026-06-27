// models/CMS_Models/Store/PurchaseOrderSettings.js
//
// Global settings doc for Purchase Order numbering — SEPARATE counter from WO.
//   number = `${prefix}${paddedCounter}${suffix}`   e.g. "PO-0001"

const mongoose = require("mongoose");

const purchaseOrderSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true, index: true },
    prefix: { type: String, trim: true, default: "PO-" },
    suffix: { type: String, trim: true, default: "" },
    padding: { type: Number, default: 4 },
    counter: { type: Number, default: 0 },
  },
  { timestamps: true },
);

purchaseOrderSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne({ key: "global" });
  if (!doc) doc = await this.create({ key: "global" });
  return doc;
};

purchaseOrderSettingsSchema.statics.peekNextNumber = async function () {
  const s = await this.getSettings();
  const next = s.counter + 1;
  const padded = String(next).padStart(s.padding || 0, "0");
  return `${s.prefix}${padded}${s.suffix}`;
};

module.exports = mongoose.model(
  "PurchaseOrderSettings",
  purchaseOrderSettingsSchema,
);
