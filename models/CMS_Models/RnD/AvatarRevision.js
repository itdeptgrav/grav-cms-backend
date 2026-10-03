// models/CMS_Models/RnD/AvatarRevision.js
//
// ONE REVISION OF ONE GENERATED AVATAR. NEVER EDITED, ONLY SUCCEEDED.
//
// ── WHY THIS IS AN EMBEDDED SCHEMA AND NOT A COLLECTION ─────────────────────
// The cluster is at its 500-collection cap (`CLAUDE.md`; `cutting_seasons` had
// to be created by renaming an orphan). A collection declared here would pass
// every test — tests run on an in-memory server — and fail on its first write
// in production. So avatar revisions are embedded, and the question was only
// WHERE:
//
//   · on the pattern revision — refused: an approved pattern revision is never
//     written to (`patternRevision.service.js`, rule 1), and a body is not part
//     of a pattern; saving an avatar while looking at an approved revision
//     would have to break that rule or be impossible;
//   · on a garment publication — refused for the same reason, and because a
//     publication allows one asset per kind;
//   · on the SampleStyle — chosen. The R&D workspace is per style, a style is
//     the record R&D and Sales already share, and an avatar library is a set
//     of bodies R&D fits that style's garments on. The path is `select: false`,
//     so no existing read of a style — lists, journeys, the kanban — loads or
//     sends it; only the avatar service asks for it.
//
// ── WHAT A REVISION HOLDS ───────────────────────────────────────────────────
// The full contract content (about 8 KB): the request, the pinned engine, the
// parameters, the verified and derived measurements, the rig, both poses' hashed
// geometry references and both collision bodies. Not the mesh — the mesh is
// regenerated from the pinned engine and parameters and checked against the
// stored hashes (see `grav-cms/components/rnd/avatar/generate.js`).
//
// Every field is immutable. A change is a new revision with the same
// `avatarId`; a drape that points at revision 2 keeps pointing at revision 2.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
});

const AVATAR_VERDICT = Object.freeze({
  FIT_VERIFIED: "fit-verified",
  REVIEW: "review",
  FAILED: "failed",
});

const AVATAR_LIMITS = Object.freeze({
  /* Per style, across all avatars. Each revision is ~8 KB, so this keeps the
     embedded array under a megabyte on a document that is otherwise small. */
  REVISIONS_PER_STYLE: 120,
});

const measurementRowSchema = new mongoose.Schema({
  key: { type: String, enum: ["height", "chest", "waist", "hip"], required: true },
  requestedMm: { type: Number, required: true },
  generatedMm: { type: Number, required: true },
  differenceMm: { type: Number, required: true },
  status: { type: String, enum: ["pass", "review", "fail"], required: true },
}, { _id: false });

const avatarRevisionSchema = new mongoose.Schema({
  avatarId: { type: String, trim: true, required: true, immutable: true },
  revision: { type: Number, required: true, min: 1, immutable: true },
  name: { type: String, trim: true, default: "", maxlength: 120, immutable: true },

  schema: { type: String, trim: true, required: true, immutable: true },
  contentSha256: { type: String, trim: true, required: true, immutable: true },

  engine: {
    name: { type: String, trim: true, required: true, immutable: true },
    version: { type: String, trim: true, required: true, immutable: true },
    packId: { type: String, trim: true, default: "", immutable: true },
    packSha256: { type: String, trim: true, required: true, immutable: true },
    wasmSha256: { type: String, trim: true, required: true, immutable: true },
  },
  profile: { type: String, enum: ["masculine", "feminine"], required: true, immutable: true },
  presetId: { type: String, trim: true, default: null, immutable: true },

  /* Stored in millimetres, always. */
  requestedMm: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  generatedMm: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  tolerance: {
    passMm: { type: Number, required: true, immutable: true },
    reviewMm: { type: Number, required: true, immutable: true },
  },
  verification: {
    verdict: { type: String, enum: Object.values(AVATAR_VERDICT), required: true, immutable: true },
    rows: { type: [measurementRowSchema], required: true, immutable: true },
  },
  defaultPose: { type: String, enum: ["a-pose", "standing-neutral"], required: true, immutable: true },
  renderMesh: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
  collisionBody: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

  /* The whole contract content, verbatim, so the browser can regenerate the
     body and Lane A can build collision bodies at any angle. */
  content: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

  author: actorRef(),
  createdAt: { type: Date, required: true, immutable: true },
}, { _id: true, minimize: false });

module.exports = { avatarRevisionSchema, AVATAR_VERDICT, AVATAR_LIMITS };
