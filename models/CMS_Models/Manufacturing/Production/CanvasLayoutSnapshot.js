// models/CMS_Models/Manufacturing/Production/CanvasLayoutSnapshot.js
//
// VERSION HISTORY FOR THE FACTORY FLOOR PLAN.
//
// Added 12 Sep 2026, the day after the live layout was lost: the designer's
// Reset ran a hard `deleteOne` on the canvaslayouts document and took version
// 31 — 78 machine positions placed by hand — with it. There was no backup on
// this Atlas tier, the browser had evicted the response bodies, and the only
// local copy was a February one at version 7. The positions were simply gone.
//
// A floor plan is hours of somebody's work and it lives in exactly one
// document. That is a bad combination for a screen with a Reset button on it,
// so every write now leaves the previous state here first.
//
// Deliberately a separate collection rather than an array on the layout itself:
// a layout with 78 machines is already a large document, and thirty revisions
// of it inline would be a megabyte read on every page load of the tracker.

const mongoose = require("mongoose");

const canvasLayoutSnapshotSchema = new mongoose.Schema(
  {
    organizationId: { type: String, default: "default", index: true },

    // The version the layout was AT when this snapshot was taken — i.e. the
    // state you get back by restoring it.
    version: { type: Number, required: true },

    /** save | reset | restore — what was about to happen when this was kept. */
    reason: { type: String, default: "save" },

    takenBy: { type: String, default: "" },

    // The whole document, minus its _id. Mixed because this is a verbatim
    // archive: it must keep loading even after the live schema gains a field,
    // and a snapshot that silently drops what it does not recognise is not an
    // archive.
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    // Counts, denormalised so the history list can be rendered without pulling
    // every payload. "31 machines, 25 separators, 6 zones" is what tells a
    // supervisor which revision they want.
    counts: {
      machinePositions: { type: Number, default: 0 },
      separators: { type: Number, default: 0 },
      chamberTemplates: { type: Number, default: 0 },
      walls: { type: Number, default: 0 },
      aisles: { type: Number, default: 0 },
      fixtures: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

canvasLayoutSnapshotSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model("CanvasLayoutSnapshot", canvasLayoutSnapshotSchema);
