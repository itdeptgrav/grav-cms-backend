const express = require("express");
const router = express.Router();
const multer = require("multer");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { uploadToCloudinary, uploadToGoogleDrive } = require("../../services/mediaUpload.service");

// Use memory storage — no disk writes
const upload = multer({
    storage: multer.memoryStorage(),
    // No size limit — removed on request.
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