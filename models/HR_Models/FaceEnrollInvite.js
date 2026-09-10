"use strict";
/**
 * models/HR_Models/FaceEnrollInvite.js
 * ───────────────────────────────────────────────────────────────────────────
 * ONE INVITE = ONE EMPLOYEE'S PERMISSION TO REGISTER THEIR OWN FACE.
 *
 * Registering a face used to require HR to sit with the employee and upload
 * photos from the HR page. This row is what lets the employee do it from
 * their own phone instead: HR mints one, the employee opens the link, the
 * camera on the device they already own sends photos to the same engine.
 *
 * THE RAW TOKEN IS NEVER STORED. Only `tokenHash` (sha256 hex) is, so a dump
 * of this collection hands the reader nothing they can open. That is also why
 * HR cannot re-display a link it issued five minutes ago — there is nothing
 * left to display. Re-issuing is one click and revokes the old one, which is
 * the safer default anyway: a link that can be recovered forever is a
 * credential nobody ever retires.
 *
 * WHY NOT A STATELESS HMAC (like utils/letterDownloadToken.js): a letter
 * token authorises a read that is idempotent and re-gated on every request.
 * This authorises a WRITE into the biometric gallery, and it must be
 * revocable the instant HR realises the link went to the wrong person or
 * into a WhatsApp group. Revocation needs a row.
 *
 * NOT SINGLE-USE, DELIBERATELY. Enrolment is several photos over a couple of
 * minutes, sometimes retried when the light is bad, so the link stays usable
 * for its whole window. What is bounded instead is: a short expiry, a cap on
 * uploads, and `completedAt` — once the employee says they are done, the
 * link stops working.
 *
 * Collection: face_enroll_invites
 */

const mongoose = require("mongoose");
const crypto = require("crypto");

/** The only place a raw token becomes a stored value. */
function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

/** 32 random bytes. Not derived from the employee, so one link tells you
    nothing about any other. */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

const faceEnrollInviteSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    /* Snapshotted at issue time so an invite records the gallery it was
       meant to fill. If HR later changes the employee's biometricId, this
       invite is for the old one and the upload route refuses it rather than
       quietly filing photos under a different person. */
    biometricId: { type: String, required: true },

    tokenHash: { type: String, required: true, unique: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId },
    createdByName: { type: String, default: "" },

    expiresAt: { type: Date, required: true },

    /* First successful upload. Distinct from completedAt: an invite that was
       opened and abandoned looks different from one nobody ever touched, and
       HR chasing a missing registration needs to tell those apart. */
    usedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedByName: { type: String, default: "" },

    /* The engine's folder for this gallery, learned from the first upload.
       Kept so `complete` can ask the engine to finalise THIS folder without
       re-deriving it — the derivation lives in the engine, and a second copy
       of that rule here is a second thing to get wrong. */
    folder: { type: String, default: "" },

    uploadCount: { type: Number, default: 0 },
    photosAccepted: { type: Number, default: 0 },
    photosRejected: { type: Number, default: 0 },

    /* Recorded for the audit trail only. Never shown to the employee, and
       never used to gate anything — phones roam between networks mid-session
       and an IP check would fail honest people. */
    lastUsedIp: { type: String, default: "" },
    lastUserAgent: { type: String, default: "" },
  },
  { timestamps: true, collection: "face_enroll_invites" },
);

/* Expired invites are worthless, and keeping them means keeping a growing
   list of hashes tied to employee ids for no benefit. Mongo drops each row
   once it passes expiresAt. The grace period keeps a just-expired invite
   readable long enough for HR's screen to explain why it stopped working. */
faceEnrollInviteSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 24 * 60 * 60 },
);

/* The lookup HR's status panel does on every render. */
faceEnrollInviteSchema.index({ employee: 1, createdAt: -1 });

/**
 * The one definition of "this link still works". Every route asks this
 * rather than re-deriving the condition, because three of those conditions
 * were added after the first one and a second copy would have missed them.
 */
faceEnrollInviteSchema.methods.isActive = function isActive(now = new Date()) {
  return (
    !this.revokedAt &&
    !this.completedAt &&
    this.expiresAt instanceof Date &&
    this.expiresAt.getTime() > now.getTime()
  );
};

/** Why it is not active — the employee sees this, so it has to be a reason
    a person can act on, not a boolean. */
faceEnrollInviteSchema.methods.inactiveReason = function inactiveReason(
  now = new Date(),
) {
  if (this.revokedAt) return "revoked";
  if (this.completedAt) return "completed";
  if (!(this.expiresAt instanceof Date)) return "malformed";
  if (this.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
};

/** What HR's panel shows. Never includes the token — there isn't one to
    include — and never the hash, which would be the token for anyone who
    can compute sha256 backwards over a 32-byte space (nobody), but is still
    not something a browser needs. */
faceEnrollInviteSchema.methods.toStatus = function toStatus(now = new Date()) {
  return {
    id: String(this._id),
    active: this.isActive(now),
    reason: this.inactiveReason(now),
    createdAt: this.createdAt || null,
    createdByName: this.createdByName || "",
    expiresAt: this.expiresAt || null,
    usedAt: this.usedAt || null,
    completedAt: this.completedAt || null,
    revokedAt: this.revokedAt || null,
    revokedByName: this.revokedByName || "",
    uploadCount: this.uploadCount || 0,
    photosAccepted: this.photosAccepted || 0,
    photosRejected: this.photosRejected || 0,
  };
};

const FaceEnrollInvite =
  mongoose.models.FaceEnrollInvite ||
  mongoose.model("FaceEnrollInvite", faceEnrollInviteSchema);

module.exports = FaceEnrollInvite;
module.exports.hashToken = hashToken;
module.exports.generateToken = generateToken;
