// models/CMS_Models/Sales/sampleStudioSchema.js
//
// GRAV STUDIO ON A SAMPLE — the designer's 3D file for this style, and every
// version of it they sent for review by Sales (14 Oct 2026).
//
// The flow it records:
//   1. A style reaches R&D (Sales routes it, as today). The designer's Styles
//      board shows a GRAV Studio card for it; "Create" links a Studio file to
//      the style (`fileId`, status "linked").
//   2. GRAV Studio (the desktop app, signed in with the designer's own key —
//      services/studio/studioKeys.service.js) lists the linked styles on its
//      start screen and makes the .grav file; the first time it does, the
//      status becomes "in_progress" and the designer is recorded.
//   3. File › Send for review uploads the project, the renders and the flats
//      as a new VERSION ("in_review"). A send never overwrites: version N stays
//      as it was sent.
//   4. Sales approves the version or asks for changes with a note
//      ("approved" / "changes"); the designer sees the answer on the card and
//      in Studio, and the next send is version N + 1.
//
// WHY EMBEDDED: the Atlas cluster is at its 500-collection cap (CLAUDE.md,
// docs/decisions/tna-milestone-library-storage.md), and this is the style's
// own record anyway — the same reasoning as `production.developmentOrder`.
// Files are never stored here: each is a private Drive object
// (services/companyDrive.service.js), named by its id, streamed back only
// through an authenticated route that checks the id belongs to this style.

const mongoose = require("mongoose");

const STUDIO_STATUS_CODES = ["linked", "in_progress", "in_review", "changes", "approved"];
const STUDIO_OUTCOME_CODES = ["pending", "approved", "changes", "superseded"];
const STUDIO_RENDER_KINDS = ["front", "back", "left", "right", "threeQuarter", "detail", "other"];
// The line flats; the coloured flats (the garment in its colours, prints and
// logos) the tech pack's Colorways and Artwork pages show; the marked flats its
// Callouts, Construction and Points of measurement pages show.
const STUDIO_FLAT_KINDS = [
  "front", "back",
  "frontColour", "backColour",
  // marked flats: points of measurement, feature callouts, construction pointers
  "frontPom", "backPom", "frontCallouts", "backCallouts", "frontConstruction", "backConstruction",
];

const person = () => ({
  id: { type: String, trim: true },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

// One stored file: a private Drive object, and what it is.
const studioFileSchema = new mongoose.Schema(
  {
    fileId: { type: String, trim: true, required: true },
    name: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number, min: 0 },
    kind: { type: String, trim: true },
  },
  { _id: false },
);

const studioVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, min: 1, required: true },
    sentAt: { type: Date, default: Date.now },
    sentBy: person(),
    note: { type: String, trim: true, default: "" },
    appVersion: { type: String, trim: true, default: "" },
    // The whole .grav project (re-opens in GRAV Studio).
    project: studioFileSchema,
    renders: [studioFileSchema],
    flats: [studioFileSchema],
    // The pictures the garment is printed with and the logos on it, each named
    // by its SHA-256 as the manifest's `prints` and `artwork` name them.
    artwork: [studioFileSchema],
    // What the app says it sent (pieces, stitches, construction summary) —
    // small JSON, kept as sent, for the tech pack to read later.
    manifest: { type: mongoose.Schema.Types.Mixed, default: {} },
    outcome: { type: String, enum: STUDIO_OUTCOME_CODES, default: "pending" },
    feedback: { type: String, trim: true, default: "" },
    decidedAt: { type: Date, default: null },
    decidedBy: person(),
  },
  { _id: false },
);

/** The `studio` block of a SampleStyle. */
const sampleStudioFields = () => ({
  status: { type: String, enum: STUDIO_STATUS_CODES },
  // The Studio file's own identity: a .grav carries it, so a file reopened
  // from anywhere still knows which style it belongs to.
  fileId: { type: String, trim: true },
  linkedAt: { type: Date },
  linkedBy: person(),
  openedAt: { type: Date },
  designer: person(),
  versions: { type: [studioVersionSchema], default: undefined },
});

module.exports = {
  sampleStudioFields,
  STUDIO_STATUS_CODES,
  STUDIO_OUTCOME_CODES,
  STUDIO_RENDER_KINDS,
  STUDIO_FLAT_KINDS,
};
