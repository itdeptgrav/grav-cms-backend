// models/CMS_Models/Manufacturing/QC/QCOperationDefectMap.js
//
// WHICH DEFECTS ARE PLAUSIBLE AT WHICH OPERATION — a suggestion, never a limit.
//
// WHY THIS IS EMPTY ON DAY ONE AND THAT IS FINE. There are 500+ products and a
// few hundred operations between them; nobody is going to sit down and decide,
// for every one, which of forty-odd defect types can occur there. So the
// catalogue is offered WHOLE at every operation and the inspector picks.
//
// But "show all forty" is a slow pick, and it gets slower as the catalogue
// grows. The obvious defects at a button-attach operation are a handful, and
// once somebody has said so the picker can put those three at the top and keep
// the other thirty-seven one keystroke away. That is what this collection is:
// a per-operation shortlist that REORDERS the picker and never restricts it.
//
// NEVER RESTRICTS IT — the rule this file exists to state. A mapping is a guess
// about what usually goes wrong, and the one time it matters is the day
// something unusual does. A picker that hid the other thirty-seven would force
// the inspector to file the finding under a wrong-but-offered code, and a
// wrong code is worse than a slow pick. Suggestions float to the top under a
// "Likely here" heading; everything else stays below it.
//
// KEYED BY OPERATION CODE, NOT BY PRODUCT. The same S008 Sew Btn Placket runs
// on eighty styles and fails the same ways on all of them. Mapping per product
// would multiply the work that is already too big by 500 and produce eighty
// copies of the same answer.

"use strict";

const mongoose = require("mongoose");

const qcOperationDefectMapSchema = new mongoose.Schema(
  {
    operationCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      index: true,
    },

    // Denormalised for the management screen, which would otherwise look up
    // every operation name across two collections to render a list.
    operationName: { type: String, default: "", trim: true },

    /**
     * Defect type codes, in the order they should be offered.
     *
     * Stored as codes rather than ObjectIds so that a mapping survives a defect
     * type being retired and re-created — and because the picker matches on
     * code anyway. A code here that no longer exists in the catalogue is
     * skipped silently at read time; it is a stale suggestion, not an error.
     */
    defectCodes: { type: [String], default: [] },

    updatedByEmail: { type: String, default: "", lowercase: true, trim: true },
    updatedByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "qc_operation_defect_map" },
);

module.exports =
  mongoose.models.QCOperationDefectMap ||
  mongoose.model("QCOperationDefectMap", qcOperationDefectMapSchema, "qc_operation_defect_map");
