// models/CMS_Models/Manufacturing/QC/QCDefectType.js
//
// WHAT IS WRONG WITH THE GARMENT — as opposed to WHERE it went wrong.
//
// QC has only ever been able to flag an OPERATION: "the defect is at S008, Sew
// Btn Placket". That is the more useful half when you want to know who to talk
// to, because an operation has an operator behind it. It is the less useful
// half for everything else: it cannot say whether the placket is puckered,
// stained, or attached upside down, and those are three different problems with
// three different fixes.
//
// So a defect now has two independent axes, and an inspector may use either or
// both:
//
//   OPERATION  where it happened   → S008 Sew Btn Placket   → names the operator
//   TYPE       what is wrong       → S4 PUCKERING           → names the failure
//
// This collection is the second axis. It is also, not incidentally, the
// vocabulary the factory's printed QUALCOM form has always used — its CODE and
// DEFECT columns are exactly this list — so an export can finally fill that
// form in the factory's own words instead of in operation codes.
//
// EDITABLE, BECAUSE NO LIST OF DEFECTS IS EVER FINISHED
// -----------------------------------------------------
// Every factory has its own additions and every season brings a new one. The
// owner can add rows one at a time, import a sheet of them, or load the
// standard list this form ships with. What must never happen is an inspector
// standing at a scanner with a real defect and no way to record it — which is
// why OTHER exists (see below) and why it is not deletable.

"use strict";

const mongoose = require("mongoose");

/**
 * The catch-all, and the reason the whole feature is safe to ship half-configured.
 *
 * An inspector who cannot express what they are looking at will either pick the
 * nearest wrong code — which silently corrupts every figure built on this — or
 * give up and pass the piece. OTHER takes a free-text note instead, so the
 * finding survives with its own words attached, and the owner can see what
 * keeps coming up and promote it to a real code.
 *
 * Seeded on first read and refused by the delete route.
 */
const OTHER_CODE = "OTHER";

const qcDefectTypeSchema = new mongoose.Schema(
  {
    // Short, uppercase, unique. The printed form's own codes are Y1, K3, S4,
    // P12 — this is deliberately the same shape so an imported sheet needs no
    // translation.
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      index: true,
    },

    name: { type: String, required: true, trim: true },

    // The form's heading this row sits under: YARN, CONSTRUCTION, STITCHING…
    // Free text rather than an enum: a factory that invents a category should
    // not need a code change, and the export groups by whatever is here.
    category: { type: String, default: "OTHER", trim: true, index: true },

    description: { type: String, default: "", trim: true },

    // Position within its category on the picker and in the export.
    sortOrder: { type: Number, default: 0 },

    // Retiring rather than deleting keeps the inspections that reference it
    // readable. The picker hides inactive rows; history still resolves them.
    isActive: { type: Boolean, default: true, index: true },

    /**
     * True for OTHER alone. The inspection screen shows it last, always, and
     * demands a note; the delete route refuses it. A flag rather than a check
     * on the code string, so the two places that care cannot drift.
     */
    isOther: { type: Boolean, default: false },

    createdByEmail: { type: String, default: "", lowercase: true, trim: true },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true, collection: "qc_defect_types" },
);

qcDefectTypeSchema.index({ isActive: 1, category: 1, sortOrder: 1, code: 1 });

/**
 * The list the factory's own printed form carries, verbatim.
 *
 * Offered as a one-click starting point rather than seeded automatically: a
 * factory that uses a different vocabulary should not have to delete forty rows
 * before it can add its own. Taken from the MIDDLE / AUDIT / STITCHING sheets
 * of the QUALCOM workbook, which all three share.
 */
const STANDARD_DEFECT_TYPES = [
  ["YARN", "Y1", "SLUB / KNOT"],
  ["YARN", "Y2", "CONTAMINATION"],
  ["YARN", "Y3", "THICK / THIN YARN"],
  ["YARN", "Y4", "PULLED THREAD"],

  ["CONSTRUCTION", "K1", "WEAVING DEFECT"],
  ["CONSTRUCTION", "K2", "HOLE"],
  ["CONSTRUCTION", "K3", "DAMAGED FABRIC / ABRASION"],

  ["DYEING / PRINTING", "D1", "DYEING SPOTS"],
  ["DYEING / PRINTING", "D2", "PRINTING DEFECTS"],
  ["DYEING / PRINTING", "D3", "SHADE VARIATIONS"],

  ["ASPECT", "A1", "BOWING / SKEWING"],
  ["ASPECT", "A2", "WRINKLES"],
  ["ASPECT", "A3", "FOLDMARKS"],

  ["CLEANLINESS", "C1", "STAINS"],
  ["CLEANLINESS", "C2", "WATERMARKS"],
  ["CLEANLINESS", "C3", "BURNED MARKS"],
  ["CLEANLINESS", "C4", "STICKER / PENCIL MARKS"],

  ["STITCHING", "S1", "STITCH DEFECT"],
  ["STITCHING", "S2", "SEAM SLIPPAGE"],
  ["STITCHING", "S3", "OPEN SEAM"],
  ["STITCHING", "S4", "PUCKERING"],
  ["STITCHING", "S5", "ROPING"],
  ["STITCHING", "S6", "BARTACK DEFECT"],
  ["STITCHING", "S7", "LOSENESS"],

  ["PRESENTATION", "P1", "UNEVEN / MEASURMENT DEFECT"],
  ["PRESENTATION", "P2", "PIPING"],
  ["PRESENTATION", "P3", "NEEDLES HOLES"],
  ["PRESENTATION", "P4", "ASYMETRIC SHAPE"],
  ["PRESENTATION", "P5", "MISSING OPERATION"],
  ["PRESENTATION", "P6", "MISMATCH LINES"],
  ["PRESENTATION", "P7", "UNCUT THREADS"],
  ["PRESENTATION", "P8", "RAW EDGE"],
  ["PRESENTATION", "P9", "HI AND LOW"],
  ["PRESENTATION", "P10", "PLEATS"],
  ["PRESENTATION", "P11", "LOOPS"],
  ["PRESENTATION", "P12", "INNER VISIBLE"],
  ["PRESENTATION", "P13", "EMBROIDERY DEFECT"],
  ["PRESENTATION", "P14", "ACCESSORIES"],
  ["PRESENTATION", "P15", "FUSING"],

  ["LABEL", "L1", "SIZE"],
  ["LABEL", "L2", "MISSING"],
  ["LABEL", "L3", "REVERSE ATTACHED"],

  ["SECURITY", "Z1", "SHARP EDGE"],
  ["SECURITY", "Z2", "INSECURE TRIMS"],
  ["SECURITY", "Z3", "INSECURE SNAP"],
  ["SECURITY", "Z4", "BUTON DEFECT"],
].map(([category, code, name], i) => ({ category, code, name, sortOrder: i }));

module.exports =
  mongoose.models.QCDefectType ||
  mongoose.model("QCDefectType", qcDefectTypeSchema, "qc_defect_types");

module.exports.OTHER_CODE = OTHER_CODE;
module.exports.STANDARD_DEFECT_TYPES = STANDARD_DEFECT_TYPES;
