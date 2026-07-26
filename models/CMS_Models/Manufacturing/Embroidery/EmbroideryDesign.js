// models/CMS_Models/Manufacturing/Embroidery/EmbroideryDesign.js
//
// Master catalogue of embroidery designs.
//
// This is the embroidery analogue of the `Operation` master that QC reads to
// build its defect grid. QC gets its operation list for free because Operations
// already exist in Inventory/Configurations. Embroidery has no such master, so
// this model supplies it — without it the scan screen would need free-text
// design entry, which destroys every per-design report you'd ever want.
//
// designCode convention: LETTERS + digits, e.g. "LC-001", "BK-014".
// The leading letter-group is treated as the CATEGORY (same trick qcRoutes.js
// uses via extractCategory) so the scan screen can chip-filter a long list.

const mongoose = require("mongoose");

const threadColorSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" }, // "Navy"
    code: { type: String, default: "" }, // "Madeira 1743"
    hex: { type: String, default: "" }, // "#1e3a8a" — for UI swatches
  },
  { _id: false },
);

const embroideryDesignSchema = new mongoose.Schema(
  {
    designCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    // Where on the garment it goes
    placement: { type: String, default: "" }, // "Left Chest"

    // Production characteristics
    stitchCount: { type: Number, default: 0 },
    estimatedMinutes: { type: Number, default: 0 },
    machineType: { type: String, default: "" }, // "Multi-head", "Single-head"
    heads: { type: Number, default: null },

    threadColors: { type: [threadColorSchema], default: [] },

    // Optional artwork preview shown on the scan screen
    imageUrl: { type: String, default: "" },

    isActive: { type: Boolean, default: true, index: true },

    createdByName: { type: String, default: "" },
  },
  { timestamps: true },
);

embroideryDesignSchema.index({ name: 1 });
embroideryDesignSchema.index({ isActive: 1, designCode: 1 });

module.exports = mongoose.model("EmbroideryDesign", embroideryDesignSchema);
