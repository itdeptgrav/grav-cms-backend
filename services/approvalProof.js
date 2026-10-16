"use strict";

/**
 * CCTV proof on the LAST manager's approval (13 Oct 2026, owner).
 *
 * "Only the final approver … uploads the proof of CCTV when they came … the
 * employee also uploads the proof to show some works as its optional but the
 * CCTV isn't, it's a required field … the final always needs to be HR."
 *
 * So on overtime and on regularization, the manager whose approval hands the
 * request to HR (the only manager on an overtime report; the secondary on a
 * regularization, or the primary when there is no secondary) must attach a
 * CCTV still, clip or PDF. HR then decides with it in front of them. The
 * employee's own proof (overtime `document*`) stays optional and separate.
 *
 * The file goes to Google Drive through the same uploader the employee's
 * overtime proof has always used; only the reference is kept on the request.
 */

const multer = require("multer");
const { uploadToGoogleDrive } = require("./mediaUpload.service");

const ALLOWED = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "video/mp4",
  "video/quicktime",
  "video/3gpp",
  "video/webm",
];
const MAX_BYTES = 25 * 1024 * 1024;

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(String(file.mimetype).toLowerCase())) cb(null, true);
    else cb(new Error("CCTV proof must be a photo, a short video or a PDF."));
  },
}).single("cctv");

/** Express middleware: reads an optional multipart `cctv` file (and fields). */
function cctvProofUpload(req, res, next) {
  parser(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      success: false,
      code: "CCTV_PROOF_INVALID",
      message: tooBig ? "The CCTV proof is larger than 25 MB. Send a shorter clip or a screenshot." : err.message,
    });
  });
}

const CCTV_REQUIRED = {
  success: false,
  code: "CCTV_PROOF_REQUIRED",
  message:
    "Attach the CCTV proof before approving — you are the last manager, and HR decides with it. " +
    "If you don't see that option, update the app.",
};

/** Upload the request's `cctv` file and return what is stored on the request. */
async function storeCctvProof(file, { prefix, who, dateStr, approverId, approverName }) {
  const ext = file.originalname && file.originalname.includes(".")
    ? file.originalname.slice(file.originalname.lastIndexOf("."))
    : "";
  const safe = String(who || "employee").replace(/[^\w-]+/g, "_").slice(0, 40);
  const fileName = `${prefix}_CCTV_${safe}_${dateStr || ""}_${Date.now()}${ext}`;
  const up = await uploadToGoogleDrive(file.buffer, { fileName, mimeType: file.mimetype });
  return {
    url: up.viewUrl || up.url,
    fileId: up.fileId,
    fileName,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date(),
    uploadedBy: approverId,
    uploadedByName: approverName || "",
  };
}

/** The schema fragment both models carry. */
const cctvProofSchema = {
  url: { type: String, default: null },
  fileId: { type: String, default: null },
  fileName: { type: String, default: null },
  mimeType: { type: String, default: null },
  size: { type: Number, default: null },
  uploadedAt: { type: Date, default: null },
  uploadedBy: { type: require("mongoose").Schema.Types.ObjectId, default: null },
  uploadedByName: { type: String, default: "" },
};

module.exports = { cctvProofUpload, storeCctvProof, cctvProofSchema, CCTV_REQUIRED };
