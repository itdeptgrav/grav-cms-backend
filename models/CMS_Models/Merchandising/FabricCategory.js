// models/CMS_Models/Merchandising/FabricCategory.js
//
// A fabric category (a "quality" in Merchandising's words — TRENT, HUMBER…)
// that a merchandiser imported from the Excel template, shared with every
// merchandiser: the shade-card page plans leaves from it and the fabric
// library lists its shades.
//
// The built-in catalogue in the frontend (generated from the feed workbook)
// is not here; this collection holds what was imported AFTER that. A
// category with a built-in's name overrides it on the shade-card page. One
// document per name — the unique index makes a duplicate impossible at the
// database level, and an import of the same name is an update.

const mongoose = require("mongoose");

const shadeSchema = new mongoose.Schema(
  {
    no: { type: Number, min: 1, max: 150, required: true }, // 1.. in Ray&Co order
    code: { type: String, trim: true, required: true }, // TRENT-001
    vendorCode: { type: String, trim: true, default: "" }, // the vendor's own number
    colour: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const fabricCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, uppercase: true },
    vendor: { type: String, trim: true, default: "" },
    vendorSeries: { type: String, trim: true, default: "" }, // the vendor's name for it
    type: { type: String, enum: ["standard", "premium"], default: "standard" },
    hero: { type: String, enum: ["right", "bottom", "none"], default: "right" },
    composition: { type: String, trim: true, default: "" },
    width: { type: String, trim: true, default: "" },
    spec: { type: String, trim: true, default: "" }, // "67/33 PV 142 CM", as printed on the leaf
    category: { type: String, trim: true, default: "other" }, // plain-shirting, uniform, …
    notes: { type: String, trim: true, default: "" },
    count: { type: Number, min: 1, max: 150, required: true }, // how many colours
    shades: { type: [shadeSchema], default: [] }, // empty when only the count is known
    source: {
      file: { type: String, trim: true, default: "" },
      importedAt: { type: Date, default: null },
      importedByRef: { type: mongoose.Schema.Types.ObjectId, default: null },
      importedByName: { type: String, trim: true, default: "" },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.models.FabricCategory || mongoose.model("FabricCategory", fabricCategorySchema);
