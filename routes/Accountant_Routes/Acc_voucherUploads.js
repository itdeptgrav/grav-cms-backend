/**
 * Voucher Attachment Routes
 * Mounted at: /api/accountant/voucher-files
 *
 * Two endpoints, both accountant-authenticated:
 *   POST /upload        — multipart file → uploads to Drive (PRIVATE folder),
 *                         returns metadata to store on the voucher.
 *   GET  /:fileId       — streams the private file back to the authenticated
 *                         user as a download (service account fetches the
 *                         bytes; the Drive file is never made public).
 *
 * Multipart (multer) is used for upload so it bypasses the express.json body
 * size limit. Download is a stream, so large files don't sit in memory.
 *
 * Mount in your main app file (e.g. app.js / server.js / index.js):
 *   app.use(
 *     "/api/accountant/voucher-files",
 *     require("./routes/Accountant_Routes/Acc_voucherUploads"),
 *   );
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");

const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const {
  uploadVoucherAttachment,
  streamVoucherAttachment,
} = require("../../services/voucherDriveUpload.service");

// In-memory storage — nothing touches disk. 50 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Block obvious executables. Everything else (images, pdf, docs) is allowed.
const BLOCKED_MIME = [
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
  "application/x-msdos-program",
];

/* ------------------------------------------------------------------ */
/* POST /upload — store a voucher attachment in Drive (private)        */
/* ------------------------------------------------------------------ */
router.post(
  "/upload",
  accountantAuth,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file provided" });

      if (BLOCKED_MIME.includes(req.file.mimetype)) {
        return res
          .status(400)
          .json({ error: "Executable files are not allowed." });
      }

      const result = await uploadVoucherAttachment(req.file.buffer, {
        fileName: req.file.originalname || "attachment",
        mimeType: req.file.mimetype || "application/octet-stream",
      });

      // result: { fileId, fileName, fileType, mimeType, size, fileUrl }
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("[voucher-files/upload]", e.message);
      res.status(500).json({
        error: e.message,
        code: "VOUCHER_UPLOAD_FAILED",
        message:
          "Upload to Google Drive failed. Check Google Drive credentials / folder access.",
      });
    }
  },
);

/* ------------------------------------------------------------------ */
/* GET /:fileId — stream the private file back as a download           */
/* ------------------------------------------------------------------ */
router.get("/:fileId", accountantAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ error: "fileId required" });

    const { stream, meta } = await streamVoucherAttachment(fileId);

    const safeName = String(meta.name || "attachment").replace(/["\r\n]/g, "");
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    if (meta.size) res.setHeader("Content-Length", meta.size);

    stream.on("error", (err) => {
      console.error("[voucher-files/:fileId] stream error:", err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    });

    stream.pipe(res);
  } catch (e) {
    console.error("[voucher-files/:fileId]", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
