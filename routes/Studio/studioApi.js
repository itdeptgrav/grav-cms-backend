"use strict";

/*
 * Private bridge used by the native GRAV Studio application.
 *
 * The Studio bearer key authenticates the designer to this API only. It is
 * deliberately unrelated to GRAV_STORAGE_API_KEY: storage remains a backend
 * capability and is never sent to a workstation.
 */

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const gravStorage = require("../../services/gravStorage.service");

const router = express.Router();
const MAX_FILE_BYTES = 75 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_MANIFEST_CHARS = 100_000;
const MAX_SUBMISSIONS = 50;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 20, fileSize: MAX_FILE_BYTES, fields: 8, fieldSize: MAX_MANIFEST_CHARS },
});

function expectedStudioKey() {
  return String(process.env.GRAV_STUDIO_API_KEY || "").trim();
}

function studioEmail() {
  return String(process.env.GRAV_STUDIO_DESIGNER_EMAIL || "").trim().toLowerCase();
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function requireStudioKey(req, res, next) {
  const configuredKey = expectedStudioKey();
  const configuredEmail = studioEmail();
  const header = String(req.get("authorization") || "");
  const suppliedKey = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";

  // Fail closed until a separate, revocable Studio key and the designer's
  // email are configured. The object-storage key is never accepted here.
  if (!configuredKey || !configuredEmail || !sameSecret(suppliedKey, configuredKey)) {
    return res.status(401).json({ error: "Studio access is not configured or this key is not valid." });
  }
  req.studioDesigner = { email: configuredEmail, name: String(process.env.GRAV_STUDIO_DESIGNER_NAME || "").trim() };
  return next();
}

function styleSelector(id) {
  const clauses = [{ sampleStyleId: id }];
  if (mongoose.isObjectIdOrHexString(id)) clauses.push({ _id: id });
  return { $or: clauses, "studio.designer.email": studioEmail() };
}

function safePurpose(prefix, name) {
  const suffix = String(name || "asset")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 70) || "ASSET";
  return `${prefix}_${suffix}`;
}

function safeFileName(file) {
  return String(file?.originalname || "asset").replace(/[\\/\0]/g, "-").slice(0, 240) || "asset";
}

function summary(style) {
  const submissions = Array.isArray(style.studio?.submissions) ? style.studio.submissions : [];
  const latest = submissions[submissions.length - 1];
  return {
    id: String(style._id),
    sampleStyleId: style.sampleStyleId || "",
    styleCode: style.styleCode || "",
    productName: style.productName || "",
    customerName: style.sampleType === "house" ? "In-house sample" : "",
    note: "",
    specs: [],
    dueDate: style.techSheet?.dueDate || null,
    studio: {
      status: latest ? "in_review" : "none",
      fileId: latest?.project?.storageFileId || "",
      designer: style.studio?.designer?.name || style.studio?.designer?.email || "",
      latest: latest ? {
        version: latest.number,
        sentAt: latest.submittedAt,
        sentBy: latest.submittedBy?.name || latest.submittedBy?.email || "",
        note: latest.note || "",
        outcome: "submitted",
        feedback: "",
        decidedBy: "",
        renders: (latest.assets || [])
          .filter((asset) => asset.purpose.startsWith("RENDER_"))
          .map((asset) => ({ fileId: asset.storageFileId, name: asset.fileName, kind: asset.purpose.slice(7).toLowerCase() })),
      } : null,
    },
  };
}

function parseManifest(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_MANIFEST_CHARS) {
    const error = new Error("A valid Studio manifest is required.");
    error.status = 400;
    throw error;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value;
  } catch (_) {
    const error = new Error("The Studio manifest is not valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validateFiles(files) {
  const project = files.project?.[0];
  const renders = files.renders || [];
  const flats = files.flats || [];
  const attachments = files.attachments || [];
  if (!project || !/\.grav$/i.test(project.originalname || "")) {
    const error = new Error("A .grav project file is required.");
    error.status = 400;
    throw error;
  }
  if (renders.length > 5 || flats.length > 4 || !renders.every((file) => /^image\/png$/i.test(file.mimetype || ""))) {
    const error = new Error("Studio renders must be PNG files (maximum five), with up to four flat files.");
    error.status = 400;
    throw error;
  }
  if (!flats.every((file) => /^(image\/png|image\/svg\+xml)$/i.test(file.mimetype || ""))) {
    const error = new Error("Studio flats must be PNG or SVG files.");
    error.status = 400;
    throw error;
  }
  const all = [project, ...renders, ...flats, ...attachments];
  if (all.reduce((total, file) => total + Number(file.size || 0), 0) > MAX_TOTAL_BYTES) {
    const error = new Error("This Studio submission is larger than 150 MB.");
    error.status = 413;
    throw error;
  }
  return { project, renders, flats, attachments };
}

async function store(file, purpose) {
  return {
    purpose,
    ...(await gravStorage.uploadBuffer(file.buffer, { fileName: safeFileName(file), mimeType: file.mimetype })),
  };
}

router.use(requireStudioKey);

router.get("/me", (req, res) => res.json({ name: req.studioDesigner.name, email: req.studioDesigner.email }));

router.get("/samples", async (req, res, next) => {
  try {
    const styles = await SampleStyle.find({ "studio.designer.email": req.studioDesigner.email, isActive: true })
      .select("sampleStyleId styleCode productName sampleType techSheet.dueDate studio")
      .sort({ updatedAt: -1 })
      .limit(250)
      .lean();
    res.json({ samples: styles.map(summary) });
  } catch (error) { next(error); }
});

router.post("/samples/:id/open", async (req, res, next) => {
  try {
    const style = await SampleStyle.findOne(styleSelector(req.params.id)).select("sampleStyleId styleCode productName sampleType techSheet.dueDate studio").lean();
    if (!style) return res.status(404).json({ error: "The CMS has no such style." });
    return res.json({ sample: summary(style) });
  } catch (error) { return next(error); }
});

router.post(
  "/samples/:id/versions",
  upload.fields([
    { name: "project", maxCount: 1 },
    { name: "renders", maxCount: 5 },
    { name: "flats", maxCount: 4 },
    // A forward-compatible lane for GLB, DXF, PDF, WAV/MP3 and video. The
    // present Studio client does not emit it yet, but its records and object
    // storage contract are ready without changing the Mongo shape.
    { name: "attachments", maxCount: 10 },
  ]),
  async (req, res, next) => {
    try {
      if (!gravStorage.configured()) return res.status(503).json({ error: "Studio storage is not configured." });
      const style = await SampleStyle.findOne(styleSelector(req.params.id));
      if (!style) return res.status(404).json({ error: "The CMS has no such style." });
      if ((style.studio?.submissions || []).length >= MAX_SUBMISSIONS) {
        return res.status(409).json({ error: "This design has reached its 50 stored submissions; archive it before adding another." });
      }

      const manifest = parseManifest(req.body.manifest);
      const { project, renders, flats, attachments } = validateFiles(req.files || {});
      const storedProject = await store(project, "STUDIO_PROJECT");
      const storedAssets = [];
      for (const file of renders) storedAssets.push(await store(file, safePurpose("RENDER", file.originalname)));
      for (const file of flats) storedAssets.push(await store(file, safePurpose("FLAT", file.originalname)));
      for (const file of attachments) storedAssets.push(await store(file, safePurpose("ATTACHMENT", file.originalname)));

      const number = (style.studio?.submissions?.[style.studio.submissions.length - 1]?.number || 0) + 1;
      style.studio = style.studio || {};
      style.studio.submissions.push({
        number,
        project: storedProject,
        assets: storedAssets,
        manifest,
        note: String(req.body.note || "").slice(0, 4000),
        appVersion: String(req.body.appVersion || "").slice(0, 100),
        submittedBy: req.studioDesigner,
        sourceTechnicalRevision: Number.isInteger(style.techSheet?.technical?.revision) ? style.techSheet.technical.revision : undefined,
      });
      await style.save();
      return res.status(201).json({ version: number });
    } catch (error) { return next(error); }
  },
);

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: error.code === "LIMIT_FILE_SIZE" ? "A Studio file exceeds the 75 MB limit." : "The Studio upload is not valid." });
  }
  if (error?.status) return res.status(error.status).json({ error: error.message });
  return next(error);
});

module.exports = router;
