"use strict";
const express = require("express");
const router = express.Router();
const multer = require("multer");
const AppVersion = require("../../models/AppVersion");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB max for APK
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.android.package-archive",
      "application/octet-stream",
    ];
    const isApk = file.originalname.endsWith(".apk");
    if (allowed.includes(file.mimetype) || isApk) cb(null, true);
    else cb(new Error("Only .apk files are allowed."));
  },
}).single("apk");

// ── GET /api/hr/app/versions — list all versions (HR only) ──
router.get("/versions", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const versions = await AppVersion.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: versions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/hr/app/latest — get latest version (public, no auth) ──
router.get("/latest", async (req, res) => {
  try {
    const latest = await AppVersion.findOne({ isLatest: true }).lean();
    if (!latest) {
      const fallback = await AppVersion.findOne()
        .sort({ createdAt: -1 })
        .lean();
      if (!fallback) return res.json({ success: true, data: null });
      return res.json({ success: true, data: fallback });
    }
    res.json({ success: true, data: latest });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/hr/app/upload — upload APK (HR only) ──
router.post(
  "/upload",
  EmployeeAuthMiddleware,
  (req, res, next) => {
    upload(req, res, (err) => {
      if (err)
        return res.status(400).json({ success: false, message: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "No APK file uploaded." });

      const { version, releaseNotes } = req.body;
      if (!version)
        return res
          .status(400)
          .json({ success: false, message: "Version is required." });

      const fileName = `GRAV_CRM_v${version}_${Date.now()}.apk`;

      // Upload to Google Drive
      const driveResult = await uploadToGoogleDrive(req.file.buffer, {
        fileName,
        mimeType: "application/vnd.android.package-archive",
      });

      // Unmark previous latest
      await AppVersion.updateMany(
        { isLatest: true },
        { $set: { isLatest: false } },
      );

      // Create new version
      const appVersion = await AppVersion.create({
        version,
        fileName,
        fileSize: req.file.size,
        driveFileId: driveResult.fileId,
        driveViewUrl: driveResult.viewUrl || driveResult.url,
        driveDownloadUrl:
          driveResult.downloadUrl ||
          `https://drive.google.com/uc?export=download&id=${driveResult.fileId}`,
        releaseNotes: releaseNotes || "",
        isLatest: true,
        uploadedBy: req.user?.id,
        uploadedByName: req.user?.name || "HR",
      });

      console.log(
        `[APP-UPLOAD] v${version} uploaded by ${req.user?.name || "HR"} → ${driveResult.fileId}`,
      );
      res.json({
        success: true,
        data: appVersion,
        message: `v${version} uploaded successfully`,
      });
    } catch (err) {
      console.error("[APP-UPLOAD]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ── PATCH /api/hr/app/versions/:id/set-latest ──
router.patch(
  "/versions/:id/set-latest",
  EmployeeAuthMiddleware,
  async (req, res) => {
    try {
      await AppVersion.updateMany(
        { isLatest: true },
        { $set: { isLatest: false } },
      );
      const ver = await AppVersion.findByIdAndUpdate(
        req.params.id,
        { $set: { isLatest: true } },
        { new: true },
      );
      if (!ver)
        return res
          .status(404)
          .json({ success: false, message: "Version not found" });
      res.json({
        success: true,
        data: ver,
        message: `v${ver.version} set as latest`,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ── DELETE /api/hr/app/versions/:id ──
router.delete("/versions/:id", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const ver = await AppVersion.findByIdAndDelete(req.params.id);
    if (!ver)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: `v${ver.version} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/hr/app/download/:id — track download count ──
router.get("/download/:id", async (req, res) => {
  try {
    const ver = await AppVersion.findByIdAndUpdate(
      req.params.id,
      { $inc: { downloadCount: 1 } },
      { new: true },
    );
    if (!ver)
      return res.status(404).json({ success: false, message: "Not found" });
    res.json({
      success: true,
      data: { downloadUrl: ver.driveDownloadUrl || ver.driveViewUrl },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
