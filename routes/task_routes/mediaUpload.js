const express = require("express");
const router = express.Router();
const multer = require("multer");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { uploadToCloudinary, uploadToGoogleDrive } = require("../../services/mediaUpload.service");

// Use memory storage — no disk writes
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// ── Upload image (to Cloudinary) ──────────────────────────
// POST /cowork/upload/image
router.post(
    "/upload/image",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/jpg"];
            if (!allowed.includes(req.file.mimetype)) {
                return res.status(400).json({ error: "Only image files allowed (jpg, png, webp, gif)" });
            }

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

// ── Upload PDF (to Google Drive) ──────────────────────────
// POST /cowork/upload/pdf
router.post(
    "/upload/pdf",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            // Accept all document/file types — images are handled separately via /upload/image
            // Blocked only: executable files (.exe, .bat, .sh, .cmd)
            const blocked = ["application/x-msdownload", "application/x-executable", "application/x-sh", "application/x-bat"];
            if (blocked.includes(req.file.mimetype)) {
                return res.status(400).json({ error: "Executable files are not allowed." });
            }

            const result = await uploadToGoogleDrive(req.file.buffer, {
                fileName: req.file.originalname || "document",
                mimeType: req.file.mimetype || "application/octet-stream",
            });

            res.json({ success: true, ...result });
        } catch (e) {
            console.error("PDF upload error:", e.message);
            // Return structured error so frontend can show "PDF feature not available"
            res.status(500).json({
                error: e.message,
                code: "PDF_UPLOAD_FAILED",
                message: "PDF upload to Google Drive failed. Check Google Drive credentials.",
            });
        }
    }
);

// ── Upload voice note (to Cloudinary) ────────────────────
// POST /cowork/upload/voice
router.post(
    "/upload/voice",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const allowed = ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg", "audio/wav", "audio/x-m4a"];
            if (!allowed.includes(req.file.mimetype)) {
                return res.status(400).json({ error: "Only audio files allowed" });
            }

            const result = await uploadToCloudinary(req.file.buffer, {
                folder: "cowork-voice-notes",
                resourceType: "video", // Cloudinary uses "video" for audio
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