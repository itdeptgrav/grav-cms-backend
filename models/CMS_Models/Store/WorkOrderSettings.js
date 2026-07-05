// models/CMS_Models/Store/WorkOrderSettings.js
//
// Single global settings doc for Worker Work Order numbering.
// There is only ever ONE document (a singleton). Prefix/suffix are editable
// globally and apply to every auto-generated WO number.
//
//   number = `${prefix}${paddedCounter}${suffix}`   e.g. "WO-0001-A"

const mongoose = require("mongoose");

const workOrderSettingsSchema = new mongoose.Schema(
  {
    // a fixed key so we always upsert the same single document
    key: { type: String, default: "global", unique: true, index: true },

    prefix: { type: String, trim: true, default: "WO-" },
    suffix: { type: String, trim: true, default: "" },
    padding: { type: Number, default: 4 }, // zero-pad width for the counter
    counter: { type: Number, default: 0 }, // last-used sequence number
  },
  { timestamps: true },
);

// Helper: atomically get the settings doc (create with defaults if missing).
workOrderSettingsSchema.statics.getSettings = async function () {
  let doc = await this.findOne({ key: "global" });
  if (!doc) doc = await this.create({ key: "global" });
  return doc;
};

// Helper: peek at the NEXT number WITHOUT consuming the counter.
// Used to pre-fill the create form so the user sees the suggested number.
workOrderSettingsSchema.statics.peekNextNumber = async function () {
  const s = await this.getSettings();
  const next = s.counter + 1;
  const padded = String(next).padStart(s.padding || 0, "0");
  return `${s.prefix}${padded}${s.suffix}`;
};

module.exports = mongoose.model("WorkOrderSettings", workOrderSettingsSchema);
