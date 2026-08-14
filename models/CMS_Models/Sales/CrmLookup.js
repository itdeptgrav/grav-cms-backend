// models/CMS_Models/Sales/CrmLookup.js
//
// CRMLookup — the persisted, controlled reference values (account roles,
// relationship types + inverse labels, statuses, tiers, site/address/contact
// types, activity enums…). The source of truth is constants/crm.js; this
// collection is an idempotent projection of it (seeded by
// scripts/seedCrmLookups.js) so the frontend can fetch controlled options
// through GET /api/cms/crm/lookups without importing backend code.
const mongoose = require("mongoose");

const lookupSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    meta: { type: mongoose.Schema.Types.Mixed }, // e.g. relationship inverse code/label
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

lookupSchema.index({ category: 1, code: 1 }, { unique: true });

module.exports = mongoose.model("CRMLookup", lookupSchema);
