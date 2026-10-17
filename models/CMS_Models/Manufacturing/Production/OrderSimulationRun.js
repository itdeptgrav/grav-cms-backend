// models/CMS_Models/Manufacturing/Production/OrderSimulationRun.js
//
// THE ORDER SIMULATION'S HISTORY (3 Oct 2026: "there is no history of the
// simulations we have run, or anything to compare any two").
//
// One document per finished run of the Production Supervisor's Order
// simulation page. The simulation itself runs in the browser; this only keeps
// what it produced, so a run can be opened again exactly as it was — every
// chart, every day — and set beside another:
//
//   · `summary`  the headline figures, small, for the history list and the
//                comparison (written by the page, never recomputed here);
//   · `inputs`   what the run was given (product with its operations,
//                quantity, working day, settings, lines), so it can be run
//                again or watched on the floor;
//   · `report`   the whole report, gzip — 1.7 MB of JSON is ~230 KB here.
//
// A run also records the floor it ran on (`layoutVersion`, `machines` in the
// register): the same inputs on a changed floor are a different question.
// Deleting is soft (`deletedAt`), like the floor plan's own history.

const mongoose = require("mongoose");

const orderSimulationRunSchema = new mongoose.Schema(
  {
    organizationId: { type: String, default: "default", index: true },
    name: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },

    product: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
    },
    quantity: { type: Number, default: 0 },
    // the sewing lines the order ran on: [{ id, name, day, operators }]
    lines: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // the floor it ran on
    layoutVersion: { type: Number, default: null },
    machines: { type: Number, default: null },

    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    inputs: { type: mongoose.Schema.Types.Mixed, default: {} },

    report: { type: Buffer, select: false },
    reportBytes: { type: Number, default: 0 },

    createdBy: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

orderSimulationRunSchema.index({ organizationId: 1, deletedAt: 1, createdAt: -1 });

module.exports = mongoose.model("OrderSimulationRun", orderSimulationRunSchema);
