const express = require("express");
const router = express.Router();
const multer = require("multer");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const {
    uploadToCloudinary,
    uploadToGoogleDrive,
    createResumableSession,
    finalizeDriveFile,
    getDriveFileStream,
} = require("../../services/mediaUpload.service");

// ── TEMP DEBUG: remove after verifying backend load stays flat ──
function logBackendLoad(label, req) {
    const mem = process.memoryUsage();
    console.log(
        `[LOAD-CHECK] ${label} | incoming body: ${req.headers["content-length"] || 0} bytes | ` +
        `RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB | Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`
    );
}

// Use memory storage — no disk writes
const upload = multer({
    storage: multer.memoryStorage(),
    // No size limit — removed on request.
});

// ══════════════════════════════════════════════════════════
// NEW — Image/large-file upload → Google Drive (DIRECT, resumable)
// Backend never touches file bytes. Browser uploads straight to
// Google's servers. Fixes: (1) 500MB files hammering backend RAM/
// bandwidth, (2) Drive normally blocking inline image rendering
// — fixed here via lh3.googleusercontent.com in finalizeDriveFile.
// ══════════════════════════════════════════════════════════

// Step 1: create resumable session (no file bytes involved)
// POST /cowork/upload/drive-session
router.post(
    "/upload/drive-session",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            logBackendLoad("drive-session START", req);
            const { fileName, mimeType, fileSize } = req.body;
            console.log(`[LOAD-CHECK] Requested upload size: ${(fileSize / 1024 / 1024).toFixed(1)} MB (this is just a number in JSON, not actual file data)`);
            if (!fileName || !fileSize) {
                return res.status(400).json({ error: "fileName and fileSize are required" });
            }
            const sessionUrl = await createResumableSession({
                fileName,
                mimeType,
                fileSize,
                origin: req.headers.origin,
            });
            res.json({ success: true, sessionUrl });
        } catch (e) {
            console.error("[drive-session]", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// Step 3: finalize — make public, return renderable URLs (no file bytes)
// POST /cowork/upload/drive-finalize
router.post(
    "/upload/drive-finalize",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            logBackendLoad("drive-finalize START", req);
            const { fileId } = req.body;
            if (!fileId) return res.status(400).json({ error: "fileId required" });
            const result = await finalizeDriveFile(fileId);
            logBackendLoad("drive-finalize END", req);
            res.json({ success: true, ...result });
        } catch (e) {
            console.error("[drive-finalize]", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// ── Guaranteed-render fallback: proxy-stream the file ────
// GET /cowork/media/view/:fileId
// Used as onError fallback in <img> when the thumbnail URL fails.
// NOTE: intentionally left WITHOUT verifyCoworkToken — <img src>
// cannot carry an Authorization header. Anyone with a fileId can
// hit this. Acceptable for now since files are already public-reader
// on Drive; revisit if abuse becomes a concern (e.g. rate-limit by IP).
router.get("/media/view/:fileId", async (req, res) => {
    try {
        const { fileId } = req.params;
        const stream = await getDriveFileStream(fileId);
        res.setHeader("Content-Type", stream.mimeType || "application/octet-stream");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        stream.data.pipe(res);
    } catch (e) {
        console.error("[media/view]", e.message);
        res.status(404).json({ error: "File not found or not accessible" });
    }
});

// ══════════════════════════════════════════════════════════
// LEGACY — kept as fallback only.

// ── Upload image (to Cloudinary) — LEGACY ─────────────────
// POST /cowork/upload/image
router.post(
    "/upload/image",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const folder = req.body.folder || "cowork-messages";
            const result = await uploadToCloudinary(req.file.buffer, {
                folder,
                resourceType: "image",
                originalName: req.file.originalname,
            });

            res.json({ success: true, ...result });
        } catch (e) {
            console.error("Image upload error:", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// ── Upload PDF (to Google Drive, old multer route) — LEGACY ──
// POST /cowork/upload/pdf
router.post(
    "/upload/pdf",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const result = await uploadToGoogleDrive(req.file.buffer, {
                fileName: req.file.originalname || "document",
                mimeType: req.file.mimetype || "application/octet-stream",
            });

            res.json({ success: true, ...result });
        } catch (e) {
            console.error("PDF upload error:", e.message);
            res.status(500).json({
                error: e.message,
                code: "PDF_UPLOAD_FAILED",
                message: "PDF upload to Google Drive failed. Check Google Drive credentials.",
            });
        }
    }
);

// ── Upload voice note (to Cloudinary) — stays as-is, untouched ──
// POST /cowork/upload/voice
router.post(
    "/upload/voice",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const result = await uploadToCloudinary(req.file.buffer, {
                folder: "cowork-voice-notes",
                resourceType: "video",
                originalName: req.file.originalname,
            });

            res.json({ success: true, ...result });
        } catch (e) {
            console.error("Voice upload error:", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

module.exports = router;