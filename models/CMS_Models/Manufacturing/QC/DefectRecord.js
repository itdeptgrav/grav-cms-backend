// models/CMS_Models/Manufacturing/QC/DefectRecord.js

const mongoose = require("mongoose");

const defectOperatorSchema = new mongoose.Schema(
  {
    operatorId:   { type: String, default: "" },
    operatorName: { type: String, default: "" },
  },
  { _id: false }
);

/**
 * WHAT was wrong — the defect type, from the catalogue the owner maintains.
 *
 * `note` carries the inspector's own words and is only ever set for OTHER, the
 * catch-all that exists so a real defect with no code is still recorded rather
 * than rounded to the nearest wrong one.
 */
const defectTypeEntrySchema = new mongoose.Schema(
  {
    code:     { type: String, required: true, trim: true, uppercase: true },
    // Snapshots, so renaming or retiring a type never rewrites history.
    name:     { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    note:     { type: String, default: "", trim: true },
  },
  { _id: false }
);

/**
 * WHERE it went wrong — and, nested inside it, WHAT was wrong there.
 *
 * THE NESTING IS THE POINT, AND IT REPLACED TWO PARALLEL LISTS. Defect types
 * started life as a second top-level array beside this one, so an inspection
 * could say "the fault is at S008 Sew Btn Placket" and "there is puckering"
 * without ever saying that the puckering IS at the placket. Two independent
 * lists, and the reader had to guess the pairing — which is impossible the
 * moment a garment has two faults.
 *
 * A defect is now one statement: this operation, these defect types. The
 * operator attribution comes from the operation, the report's CODE / DEFECT
 * columns come from the types, and they are joined by construction rather than
 * by hope.
 *
 * `types` may be empty — an inspector who can see the placket is wrong but not
 * which catalogue entry describes it should still be able to say so.
 */
const defectEntrySchema = new mongoose.Schema(
  {
    operationCode: { type: String, required: true, trim: true },
    operationName: { type: String, default: "",   trim: true },
    operators:     { type: [defectOperatorSchema], default: [] },
    types:         { type: [defectTypeEntrySchema], default: [] },
  },
  { _id: false }
);

const defectRecordSchema = new mongoose.Schema(
  {
    // ── Piece identification ────────────────────────────────────────────────
    date:             { type: String, index: true },          // "YYYY-MM-DD" IST
    barcodeId:        { type: String, index: true },          // full barcode e.g. WO-abc123-005
    workOrderShortId: { type: String },                       // abc123
    workOrderId:      { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder",       default: null },
    moRequestId:      { type: String },
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },

    // ── Inspection result ───────────────────────────────────────────────────
    /**
     * THE VERDICT. Three, not two, and the third is terminal.
     *
     *   passed     good; the piece moves on.
     *   defective  send to rework — fixable, comes back, gets re-inspected.
     *   rejected   SCRAP. The fabric is bad, the fault cannot be sewn out, the
     *              piece is finished.
     *
     * "defective" used to carry both meanings, which made the two numbers a
     * factory is actually judged on — how much we fixed, how much we threw away
     * — impossible to separate, and left a scrapped garment sitting in the
     * rework queue forever waiting to come back.
     *
     * A rejected piece is TERMINAL: the scan guard refuses every later scan on
     * it, of any verdict, so nothing can overwrite the reject. See
     * services/qcStages.js.
     */
    status:  { type: String, enum: ["passed", "defective", "rejected"], required: true },
    defects: { type: [defectEntrySchema], default: [] },
    /**
     * Defects that belong to NO operation.
     *
     * Kept, and deliberately, even though the main path is now
     * `defects[].types`: a stain, a shade variation or a missing label is a
     * real fault of the garment that no single operation caused, and forcing
     * the inspector to pin it on one would invent an attribution — which then
     * shows up as a real operator's name in a rework report.
     *
     * Also where every inspection recorded before the nesting lives.
     */
    defectTypes: { type: [defectTypeEntrySchema], default: [] },

    // ── The checkpoint this scan happened at ────────────────────────────────
    //
    // A piece is inspected several times over — in-line, end-line, finishing —
    // and until now every one of those scans was recorded as the same
    // undifferentiated event, so "this piece passed" could mean it cleared one
    // checkpoint or all of them. The stage is what separates them.
    //
    // NULLABLE, AND THAT IS A REAL STATE, not a gap to be backfilled. Every
    // inspection recorded before stages existed has none, and a factory that
    // has not configured stages yet keeps working exactly as it did — the scan
    // rules only switch on once stages exist. Code, name and serial are
    // SNAPSHOTS: renaming or reordering a stage must not rewrite what a scan
    // meant on the day it was taken.
    stageId:     { type: mongoose.Schema.Types.ObjectId, ref: "QCStage", default: null },
    stageCode:   { type: String, default: "" },
    stageName:   { type: String, default: "" },
    stageSerial: { type: Number, default: null },

    // ── Rework ──────────────────────────────────────────────────────────────
    //
    // How many times this piece had already been failed AT THIS STAGE when the
    // scan was taken. 0 is a first look; anything above is a re-inspection of
    // work sent back. Denormalised at write time rather than counted on read,
    // because the per-product rework figure on the overview is a rollup over a
    // whole day of pieces and counting it per row costs a query per piece.
    reworkRound: { type: Number, default: 0 },
    isRework:    { type: Boolean, default: false },

    // ── QC person who performed the inspection ──────────────────────────────
    inspectedByQCName:        { type: String, default: "QC" },
    inspectedByBiometricId:   { type: String, default: "" },  // from employee ID card scan
    inspectedByQCId:          { type: String, default: "" },  // legacy / session id fallback
    // The CMS identity behind the station session, where one is known. The
    // biometric id is what the station scan carries; this is what joins a scan
    // back to the team roster, which is keyed by email like every other grant.
    inspectedByEmail:         { type: String, default: "", lowercase: true, trim: true },

    inspectedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// ── Indexes ──────────────────────────────────────────────────────────────────
defectRecordSchema.index({ barcodeId: 1, inspectedAt: -1 });
defectRecordSchema.index({ date: 1, status: 1 });
defectRecordSchema.index({ workOrderId: 1 });
defectRecordSchema.index({ manufacturingOrderId: 1 });
defectRecordSchema.index({ inspectedByBiometricId: 1 });   // query by QC person
// The scan guard's one hot query: "what is the latest verdict for this piece at
// this checkpoint" — asked before every save, and again for every stage when a
// piece is looked up.
defectRecordSchema.index({ barcodeId: 1, stageId: 1, inspectedAt: -1 });
// The export's defect matrix groups by type; the delete guard asks whether a
// type has ever been used.
defectRecordSchema.index({ "defectTypes.code": 1 });
defectRecordSchema.index({ "defects.types.code": 1 });

module.exports = mongoose.model("QCInspection", defectRecordSchema);