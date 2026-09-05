// models/CMS_Models/Inventory/Configurations/Unit.js

const mongoose = require("mongoose");

const conversionSchema = new mongoose.Schema({
  toUnit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Unit",
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0.001
  }
}, { _id: true });

const unitSchema = new mongoose.Schema({
  /* ── TENANT OWNERSHIP ─────────────────────────────────────────────────────
     A unit of measure is company data: one company's "roll" is 40 metres and
     another's is 25, and a conversion factor retroactively changes what every
     stored quantity in that unit MEANS. Sharing them across companies would
     make one company's configuration silently revalue another's stock.

     Optional, like every other Store & Purchase model's: units created before
     the boundary carry none and are legacy-global — readable only under the
     explicit legacy rules, never silently adopted. */
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Acc_Company",
    default: null,
    index: true
  },
  siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

  /* Not `unique` here any more — uniqueness is company-scoped, declared below.
     The legacy global `name_1` index survives on running deployments and is
     retired by a reviewable migration, not by this declaration. */
  name: {
    type: String,
    required: true,
    trim: true
  },
  conversions: [conversionSchema],
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });

/* One unit name per company. Two companies may both define "roll"; within a
   company the name is how every item and PO line refers to it. */
unitSchema.index({ companyId: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.Unit || mongoose.model("Unit", unitSchema);