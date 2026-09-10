"use strict";
/**
 * models/HR_Models/FacePhoto.js
 * ───────────────────────────────────────────────────────────────────────────
 * ONE ROW = ONE REGISTRATION PHOTO'S BACKUP, not the photo itself.
 *
 * The photo that matters lives on the punch-in machine, because the
 * recognition engine reads it off local disk to build its gallery. This row
 * records that a copy also reached private Google Drive, and under which file
 * id — see services/faceGalleryDrive.service.js for why it is a mirror rather
 * than a move.
 *
 * SO THIS COLLECTION IS NOT THE SOURCE OF TRUTH FOR ANYTHING. It cannot be
 * used to answer "is this employee registered?" — the engine answers that, and
 * a row here can exist for a photo somebody has since archived. It exists for
 * exactly one question: if the machine dies, what were the photos and where
 * are the copies.
 *
 * NO IMAGE BYTES ARE STORED HERE. A face in a database row outlives every
 * decision anyone makes about it; the bytes stay in Drive, private, and this
 * holds the pointer.
 *
 * Collection: face_photos
 */

const mongoose = require("mongoose");

const facePhotoSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },

    /* The key everything face-related is filed under, and the one that
       survives an employee record being re-created. */
    biometricId: { type: String, required: true, index: true },

    /* The engine's folder and its filename — together, the local original
       this row is the backup of. */
    folder: { type: String, default: "" },
    filename: { type: String, required: true },

    driveFileId: { type: String, required: true },
    bytes: { type: Number, default: 0 },

    /* THE FACE ITSELF, AS NUMBERS — 512 of them from InsightFace.
       
       This is what makes the registration usable somewhere other than the
       punch-in machine. Recognition is a distance between two of these; a
       system holding them can match faces without ever downloading a photo or
       running the model. Without it, every consumer has to re-fetch the image
       and re-embed it to arrive at the same numbers.
       
       Treated as biometric data, because it is: it identifies a person as
       surely as the photograph does, and unlike a password it cannot be
       changed. It is not returned by any employee-facing route.
       
       `embeddingModel` is recorded because embeddings are only comparable
       within one model — buffalo_l vectors mean nothing next to another
       model's, and a future model change has to be able to find the rows that
       predate it. */
    embedding: { type: [Number], default: undefined, select: false },
    embeddingModel: { type: String, default: "" },

    /* Which door it came through, so a gallery that went wrong can be traced
       to HR's desk or to somebody's phone. */
    source: {
      type: String,
      enum: ["hr-upload", "self-enrolment"],
      default: "hr-upload",
    },

    /* Set when the local original is archived. The Drive copy is trashed, not
       deleted, so this row stays as the record that it once existed. */
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "face_photos" },
);

/* The lookup every read here does: one employee's backups, newest first. */
facePhotoSchema.index({ biometricId: 1, createdAt: -1 });

module.exports =
  mongoose.models.FacePhoto || mongoose.model("FacePhoto", facePhotoSchema);
