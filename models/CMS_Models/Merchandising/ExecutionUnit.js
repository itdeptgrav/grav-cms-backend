// models/CMS_Models/Merchandising/ExecutionUnit.js
//
// ONE EXECUTION UNIT — a child of exactly one Merchandising Execution File.
//
// ── WHY A COLLECTION AND NOT AN EMBEDDED ARRAY ──────────────────────────────
// The final plan's record grain says colourways, delivery drops, size ranges
// and nominated factories become child execution units when they need distinct
// dates, selections or handoffs. Distinctness needs an identity the DATABASE
// enforces — (fileId, unitDiscriminator) unique — and later milestones will
// filter and count units across files (a factory's units, a drop's units),
// which an embedded array can neither index nor guard. Embedding would have
// been less code today and a migration tomorrow.
//
// ── WHERE A UNIT COMES FROM, AND ONLY WHERE ─────────────────────────────────
// Derived from the immutable handover projection at acceptance, inside the
// same transaction that creates or updates the file. No UI adds one, no public
// endpoint adds one, and a unit never outlives its file conceptually — it has
// no independent existence, only a stable identity within one.
//
// A later accepted version may add units (a new drop, a new colourway) and
// restate quantities; each unit records WHICH version last stated it, so a
// figure on a unit is always attributable to a Sales statement. A tuple a new
// version no longer carries is marked inactive rather than deleted — a split
// that was confirmed and then withdrawn is a decision somebody may need to
// explain, not a row to erase.
"use strict";

const mongoose = require("mongoose");

const executionUnitSchema = new mongoose.Schema(
  {
    fileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile",
      required: true, index: true, immutable: true,
    },
    /* Denormalised for company-bounded unit queries without a join. Stamped
       from the file inside the acceptance transaction. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true,
    },

    /* ── THE IDENTITY ─────────────────────────────────────────────────────
       Built from the SOURCE REFERENCES of the confirmed tuple, never from its
       display text:

         DEFAULT                        no split of any kind
         DROP:<dropRef>                 split only by delivery
         SPLIT:<lineSplitRef>           split only by colourway / size
         UNIT:<lineSplitRef>|<dropRef>  both, per the allocation mapping

       Attributes are deliberately absent from it. A colourway renamed from
       "Navy" to "Midnight Navy" is the same confirmed split, and an identity
       built from that text would silently withdraw the unit and open a
       replacement — taking every selection ever attached to it out of the
       file. The nominated factory is absent for the same reason: it is a
       property OF the drop, so `dropRef` already tells two factories apart,
       and folding it in would make a corrected factory look like a different
       unit. Built by the shared handover contract, never by a caller. */
    unitDiscriminator: { type: String, trim: true, required: true },

    /* The projection rows this unit came from, so a figure on a unit can
       always be traced to the statement that made it. */
    lineSplitRef: { type: String, trim: true, default: "" },
    allocationRef: { type: String, trim: true, default: "" },

    /* The tuple, readable. */
    attributes: [
      new mongoose.Schema(
        { name: { type: String, trim: true }, value: { type: String, trim: true } },
        { _id: false },
      ),
    ],
    sizeRange: { type: String, trim: true, default: "" },
    dropRef: { type: String, trim: true, default: "" },
    committedDeliveryDate: { type: Date, default: null },
    nominatedFactoryRef: { type: String, trim: true, default: "" },

    quantity: { type: Number, min: 0, required: true },

    /* The Sales statement this unit's figures came from. */
    sourceVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sourceVersionNo: { type: Number, required: true },

    /* False when a later accepted version no longer carries this tuple. */
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

/* The invariant: one unit per discriminator per file, database-enforced. */
executionUnitSchema.index({ fileId: 1, unitDiscriminator: 1 }, { unique: true });

module.exports = mongoose.models.MerchandisingExecutionUnit
  || mongoose.model("MerchandisingExecutionUnit", executionUnitSchema);
