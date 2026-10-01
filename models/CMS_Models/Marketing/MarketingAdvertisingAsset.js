// models/CMS_Models/Marketing/MarketingAdvertisingAsset.js
//
// ONE VERSION OF ONE ADVERTISING IMAGE, AND WHAT A PERSON DECIDED ABOUT IT.
//
// ── A VERSION IS THE UNIT, NOT A FILE ──────────────────────────────────────
// An approval is a decision about a specific set of bytes. If the bytes behind
// an approved row could change, every approval in the collection would become a
// claim about something nobody looked at — and the campaign already running
// would be showing a picture that was swapped after review.
//
// So a row IS a version. Uploading a replacement creates another row with
// another public identifier and its own review; the old row is marked
// superseded and kept, because campaigns reference it and an audit needs it.
// `assetGroupId` ties the versions of one logical image together.
//
// ── AND THE DRIVE IDENTIFIER IS NOT THE IDENTITY ───────────────────────────
// `storageRef` is where the bytes happen to live today. It is never published,
// never accepted from a caller, and never used as the public identifier: a
// storage id is a key into a shared Drive, it is guessable-adjacent, and
// publishing it would let a caller name a file GRAV never inspected. The public
// identity is a signed token minted from this row's `_id` and company.
"use strict";

const mongoose = require("mongoose");

const {
  ASSET_STATE_CODES,
  APPROVAL_ASSERTION_CODES,
  ASSET_LIMITS,
} = require("../../../constants/marketingAdvertisingAssets");

const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const assetSchema = new mongoose.Schema(
  {
    /* ── EVERY SELECTOR CARRIES THIS ─────────────────────────────────────── */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* The logical image. Versions of one image share it; the row is still the
       unit of approval. */
    assetGroupId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },

    /* ── READ FROM THE BYTES, NOT FROM THE REQUEST ───────────────────────────
       A filename is a string somebody typed and a request MIME type is a string
       a browser guessed. These four come from the file's own header and hash,
       which is what makes them evidence. */
    mimeType: { type: String, required: true, trim: true, enum: ["image/jpeg", "image/png"] },
    byteSize: { type: Number, required: true, min: 1 },
    width: { type: Number, required: true, min: 1 },
    height: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, trim: true, lowercase: true, match: /^[0-9a-f]{64}$/ },

    /* Kept for a person reading a list. Sanitised: it is display text, never a
       path, and never used to decide anything. */
    originalFileName: { type: String, required: true, trim: true, maxlength: ASSET_LIMITS.FILE_NAME_MAX },
    /* Whether the name agreed with what the bytes turned out to be. Recorded
       rather than enforced — it is usually somebody's export settings, and
       occasionally it is somebody testing a check that reads names. */
    extensionAgreedWithBytes: { type: Boolean, default: true },

    /* ── WHERE THE BYTES LIVE, AND NOTHING PUBLISHES IT ─────────────────── */
    storageRef: { type: String, required: true, trim: true, select: false },
    storageOrigin: { type: String, required: true, trim: true, default: "company_drive" },

    uploadedBy: { type: actorSchema, required: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
    note: { type: String, trim: true, default: "", maxlength: ASSET_LIMITS.NOTE_MAX },

    state: { type: String, enum: ASSET_STATE_CODES, required: true, default: "awaiting_review" },

    /* ── THE DECISION, WITH WHAT WAS ASSERTED ───────────────────────────────
       Not just "approved by Ada at 4pm". The three statements a reviewer had to
       make, stored, so an audit shows what was claimed rather than that a
       button was pressed. */
    approvedBy: { type: actorSchema, default: null },
    approvedAt: { type: Date, default: null },
    approvalAssertions: {
      type: new mongoose.Schema(
        Object.fromEntries(APPROVAL_ASSERTION_CODES.map((c) => [c, { type: Boolean, default: false }])),
        { _id: false },
      ),
      default: null,
    },
    /* The hash the reviewer was shown. An approval carrying a different one
       than the row's is an approval of something else. */
    approvedSha256: { type: String, trim: true, default: "" },

    revokedBy: { type: actorSchema, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, trim: true, default: "", maxlength: ASSET_LIMITS.REASON_MAX },

    supersededBy: { type: mongoose.Schema.Types.ObjectId, default: null },

    revision: { type: Number, required: true, default: 1, min: 1 },
  },
  { timestamps: true, collection: "marketing_advertising_assets", strict: "throw" },
);

/* ── IDENTICAL BYTES ARE ONE ASSET, WITHIN ONE COMPANY ──────────────────────
   Uploading the same picture twice should find the first rather than making a
   second row with a second review.

   The company leads the index and is part of the uniqueness, deliberately. Two
   companies uploading the same stock photograph is ordinary, and a global hash
   index would make the second company's upload collide with a row it cannot
   see, cannot read and never approved — and would leak the fact that somebody
   else has that file. */
assetSchema.index({ companyId: 1, sha256: 1 }, { unique: true });
assetSchema.index({ companyId: 1, assetGroupId: 1, version: 1 }, { unique: true });
assetSchema.index({ companyId: 1, state: 1, createdAt: -1 });

/* ── AN APPROVED VERSION'S BYTES CANNOT MOVE ────────────────────────────────
   The fields that identify the bytes are frozen once a version is approved.
   Changing any of them would silently redirect an approval — and an approval
   that can be redirected is not an approval.

   Enforced on the document path and on every query path, because a `pre("save")`
   hook alone leaves `updateOne`, `findOneAndUpdate` and `bulkWrite` wide open. */
const FROZEN_ONCE_APPROVED = ["sha256", "storageRef", "mimeType", "byteSize", "width", "height", "assetGroupId", "companyId"];

assetSchema.pre("save", function refuseByteChange(next) {
  if (this.isNew) return next();
  if (this.state !== "approved" && this.$__.priorDoc?.state !== "approved") {
    /* Not yet approved: the identifying fields still must not change, but the
       message differs and the check below covers it anyway. */
  }
  const moved = FROZEN_ONCE_APPROVED.filter((f) => this.isModified(f));
  if (moved.length) {
    return next(new Error(
      `An advertising image version is immutable: ${moved.join(", ")} cannot change. Upload a new version instead.`,
    ));
  }
  return next();
});

const MUTATING_QUERY_OPS = [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
];

for (const op of MUTATING_QUERY_OPS) {
  assetSchema.pre(op, function refuseByteChangeByQuery(next) {
    const update = this.getUpdate() || {};
    const touched = new Set();
    for (const [key, value] of Object.entries(update)) {
      if (key.startsWith("$")) {
        if (value && typeof value === "object") {
          for (const field of Object.keys(value)) touched.add(field.split(".")[0]);
        }
      } else {
        touched.add(key.split(".")[0]);
      }
    }
    const moved = FROZEN_ONCE_APPROVED.filter((f) => touched.has(f));
    if (moved.length) {
      return next(new Error(
        `An advertising image version is immutable: ${moved.join(", ")} cannot change. Upload a new version instead.`,
      ));
    }
    return next();
  });
}

const MarketingAdvertisingAsset = mongoose.models.MarketingAdvertisingAsset
  || mongoose.model("MarketingAdvertisingAsset", assetSchema);

/* ── THE APPROVAL TRAIL, APPEND-ONLY ────────────────────────────────────────
   One row per decision. A history somebody can edit is a history, not an audit
   trail — so the same protection the deployment attempt records use. */
const historySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true, default: Date.now },
    action: { type: String, required: true, trim: true },
    fromState: { type: String, trim: true, default: "" },
    toState: { type: String, trim: true, default: "" },
    actor: { type: actorSchema, required: true },
    reason: { type: String, trim: true, default: "", maxlength: ASSET_LIMITS.REASON_MAX },
    assertions: { type: mongoose.Schema.Types.Mixed, default: null },
    /* The bytes the decision was about. */
    sha256: { type: String, trim: true, default: "" },
  },
  { timestamps: false, collection: "marketing_advertising_asset_history", strict: "throw" },
);

historySchema.index({ companyId: 1, assetId: 1, at: 1 });

const refuse = function refuseMutation(next) {
  next(new Error("marketing_advertising_asset_history is append-only: a recorded decision cannot be updated or deleted."));
};
for (const op of [...MUTATING_QUERY_OPS, "deleteOne", "deleteMany", "findOneAndDelete"]) {
  historySchema.pre(op, refuse);
}
historySchema.pre("save", function refuseRewrite(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

const MarketingAdvertisingAssetHistory = mongoose.models.MarketingAdvertisingAssetHistory
  || mongoose.model("MarketingAdvertisingAssetHistory", historySchema);

module.exports = {
  MarketingAdvertisingAsset,
  MarketingAdvertisingAssetHistory,
  FROZEN_ONCE_APPROVED,
};
