// models/CMS_Models/Sales/sampleTechPackSchema.js
//
// THE TECH PACK'S OWN FIELDS ON A STYLE (15 Oct 2026) — what the printed pack
// needs that no other record holds (docs/techpack-layout.md in grav-cms):
//
//   • header values the brief does not carry: the season, the sample size,
//     and — when the printed brand or description should differ from what the
//     style would show — an override for each;
//   • per material, the specification its page prints: a label's size and
//     construction, a hang tag's stock and logo size, a polybag's dimensions.
//     Keyed by the material's identity in the approved BOM (`rowKey`: the
//     development row ref, else the raw item id), so a re-approved BOM keeps
//     its specs for the materials that stayed.
//
// Everything else on the pack is READ from its owner at print time — the
// brief (Sales), the approved BOM (Merchandising), consumption (R&D), the
// flats and the construction (GRAV Studio) — and never copied here.
// Embedded: the cluster is at its collection cap.

const mongoose = require("mongoose");

const specSchema = new mongoose.Schema(
  {
    rowKey: { type: String, trim: true, required: true },
    // "3\" W x 3\" H", "10mm W x 40mm H [before fold]"
    dimensions: { type: String, trim: true, default: "" },
    // "Woven damask, hot cut", "17pt card stock, gloss print with punch hole"
    construction: { type: String, trim: true, default: "" },
    // "Front black with white text, back white with black text"
    colour: { type: String, trim: true, default: "" },
    logoDimensions: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const sampleTechPackFields = () => ({
  season: { type: String, trim: true, default: "" },
  sampleSize: { type: String, trim: true, default: "" },
  brand: { type: String, trim: true, default: "" },
  description: { type: String, trim: true, default: "" },
  specs: { type: [specSchema], default: undefined },
  /* SAMPLE VALUES (15 Oct 2026, owner: "fill the missing data on the test
     style"). Values another department owns, or that no record holds yet,
     shown on the pack where the real one is empty — always MARKED on the
     printed page (yellow: the CMS has the field, red: it has none), never
     read by anything but the pack, and never mistaken for the real value:
     a real value always wins. Shape: services/techpack/techPack.service.js. */
  preview: { type: mongoose.Schema.Types.Mixed, default: undefined },
  updatedAt: { type: Date },
  updatedBy: {
    id: { type: String, trim: true },
    name: { type: String, trim: true },
  },
});

const SPEC_FIELDS = ["dimensions", "construction", "colour", "logoDimensions", "notes"];

module.exports = { sampleTechPackFields, SPEC_FIELDS };
