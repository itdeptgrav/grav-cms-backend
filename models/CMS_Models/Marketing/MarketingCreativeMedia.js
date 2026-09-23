// models/CMS_Models/Marketing/MarketingCreativeMedia.js
//
// ONE EXACT VERSION OF ONE CREATIVE FILE, AND WHAT HAPPENED TO IT.
//
// ── A VERSION IS ITS BYTES ─────────────────────────────────────────────────
// Every row is one immutable set of bytes: its hash, size, dimensions and the
// place they are stored never change after the row is written. A changed file
// is a NEW version — a new row, a new reference — in the same media group. So
// a creative draft that names a version names those bytes for ever, and its
// approval fingerprint can rely on that.
//
// ── TWO PUBLIC NAMES, BOTH RANDOM ──────────────────────────────────────────
// `mediaRef` names one version; `groupRef` names the file across versions.
// Both are random, carry no database id and no time, and are only ever looked
// up together with the caller's company — so a reference from another company
// finds nothing, exactly like one that never existed.
//
// ── WHAT IS NOT PUBLISHED ──────────────────────────────────────────────────
// `storageRef` (the company Drive file id) is `select: false` and never leaves
// the service. There is no public URL: the file is shown only through GRAV's
// own authenticated preview route.
"use strict";

const mongoose = require("mongoose");

const M = require("../../../constants/marketingCreativeMedia");

const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const mediaSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    mediaRef: { type: String, required: true, trim: true },
    groupRef: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 1 },

    kind: { type: String, enum: ["image"], required: true },
    mimeType: { type: String, enum: M.IMAGE_FORMATS.map((f) => f.mimeType), required: true },
    byteSize: { type: Number, required: true, min: 1 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, lowercase: true, match: /^[0-9a-f]{64}$/ },

    originalFileName: { type: String, required: true, trim: true, maxlength: M.LIMITS.FILE_NAME_MAX },
    extensionAgreedWithBytes: { type: Boolean, default: true },
    note: { type: String, trim: true, default: "", maxlength: M.LIMITS.NOTE_MAX },

    storageRef: { type: String, required: true, trim: true, select: false },
    storageOrigin: { type: String, required: true, default: "company_drive" },

    uploadedBy: { type: actorSchema, required: true },
    uploadedAt: { type: Date, required: true },

    state: { type: String, enum: M.STATE_CODES, required: true, default: "available" },
    withdrawnBy: { type: actorSchema, default: null },
    withdrawnAt: { type: Date, default: null },
    withdrawnReason: { type: String, trim: true, default: "", maxlength: M.LIMITS.REASON_MAX },

    /* ── THE STORED COPY STOPPED MATCHING ────────────────────────────────
       Set when a preview finds the bytes in storage no longer hash to this
       version, cleared if a later read finds them matching again. The bytes
       fields above never change; this records what storage was found to
       hold, so every read (list, calendar, detail) can say so without
       downloading the file. */
    integrityFailedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "marketing_creative_media", strict: "throw" },
);

mediaSchema.index({ companyId: 1, mediaRef: 1 }, { unique: true });
mediaSchema.index({ companyId: 1, groupRef: 1, version: 1 }, { unique: true });
/* The same bytes are one version per company. Company first, so two companies
   holding the same stock photo never collide or learn of each other. */
mediaSchema.index({ companyId: 1, sha256: 1 }, { unique: true });
mediaSchema.index({ companyId: 1, createdAt: -1 });

/* ── THE BYTES OF A VERSION CANNOT MOVE ─────────────────────────────────────
   Withdrawal is the only change a version may undergo. Every other field is
   fixed at creation, on every update path. */
const MUTABLE = new Set(["state", "withdrawnBy", "withdrawnAt", "withdrawnReason", "integrityFailedAt", "updatedAt"]);
const IMMUTABLE = "A creative media version is immutable: upload a new version instead of changing this one.";

function touchesImmutable(update) {
  if (!update || typeof update !== "object") return false;
  for (const [op, body] of Object.entries(update)) {
    if (!op.startsWith("$")) {
      if (!MUTABLE.has(op)) return true;
      continue;
    }
    if (op === "$setOnInsert") continue;
    if (body && typeof body === "object" && Object.keys(body).some((k) => !MUTABLE.has(k))) return true;
  }
  return false;
}

for (const op of ["updateOne", "updateMany", "findOneAndUpdate"]) {
  mediaSchema.pre(op, function guardBytes(next) {
    if (touchesImmutable(this.getUpdate())) return next(new Error(IMMUTABLE));
    return next();
  });
}
for (const op of ["replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  mediaSchema.pre(op, function refuse(next) { next(new Error(IMMUTABLE)); });
}
mediaSchema.pre("save", function refuseResave(next) {
  if (!this.isNew) return next(new Error(IMMUTABLE));
  return next();
});

/* ── WHAT HAPPENED, APPEND-ONLY ─────────────────────────────────────────── */
const eventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    groupRef: { type: String, required: true },
    mediaRef: { type: String, required: true },
    action: { type: String, enum: ["uploaded", "version_added", "withdrawn"], required: true },
    reason: { type: String, trim: true, default: "" },
    sha256: { type: String, default: "" },
    actor: { type: actorSchema, required: true },
    at: { type: Date, required: true },
  },
  { collection: "marketing_creative_media_events", strict: "throw" },
);
eventSchema.index({ companyId: 1, groupRef: 1, at: 1 });
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  eventSchema.pre(op, function refuse(next) { next(new Error("marketing_creative_media_events is append-only.")); });
}

const MarketingCreativeMedia = mongoose.models.MarketingCreativeMedia
  || mongoose.model("MarketingCreativeMedia", mediaSchema);
const MarketingCreativeMediaEvent = mongoose.models.MarketingCreativeMediaEvent
  || mongoose.model("MarketingCreativeMediaEvent", eventSchema);

module.exports = { MarketingCreativeMedia, MarketingCreativeMediaEvent, IMMUTABLE };
