// routes/Studio/studioApi.js — mounted at /api/studio/v1
//
// GRAV STUDIO'S OWN API (14 Oct 2026). The desktop app calls these with the
// key an administrator issued to the designer (`Authorization: Bearer gsk_…`,
// services/studio/studioKeys.service.js) — never a CMS password, never the
// database. Everything is inside the company the key was issued in.
//
//   GET  /me                          who the key belongs to
//   GET  /samples                     the styles with Design (R&D): the start screen's cards
//   GET  /samples/:id                 one style: brief, specs, images, every version and its answer
//   POST /samples/:id/open            the app made (or reopened) the style's file
//   GET  /samples/:id/files/:fileId   a brief image or a sent file
//   POST /samples/:id/versions        File › Send for review (multipart: project, renders, flats, artwork, manifest, note)
//
// A desktop request carries no Origin header, which the CORS gate admits.

"use strict";

const express = require("express");
const multer = require("multer");
const keys = require("../../services/studio/studioKeys.service");
const studio = require("../../services/studio/sampleStudio.service");
const { loadStyle, listStyles, customerNames } = require("../../services/studio/sampleStudioQueries");
const storage = require("../../services/studio/studioStorage.service");

const router = express.Router();

const MB = 1024 * 1024;
// Flats: the front and back line flats, coloured flats and marked flats (points
// of measurement, callouts, construction pointers), each as SVG and PNG.
// Artwork: the print and logo pictures the garment carries.
const LIMITS = { project: 150 * MB, image: 20 * MB, renders: 12, flats: 24, artwork: 16 };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITS.project, files: 1 + LIMITS.renders + LIMITS.flats + LIMITS.artwork, fields: 10, fieldSize: 2 * MB },
}).fields([
  { name: "project", maxCount: 1 },
  { name: "renders", maxCount: LIMITS.renders },
  { name: "flats", maxCount: LIMITS.flats },
  { name: "artwork", maxCount: LIMITS.artwork },
]);

function sendError(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error("[studio-api]", e);
  res.status(status).json({ success: false, error: status >= 500 ? "Something went wrong. Try again." : e.message });
}

/** The key, checked on every request. */
async function keyAuth(req, res, next) {
  try {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) return res.status(401).json({ success: false, error: "Sign in to GRAV Studio with your key." });
    const who = await keys.authenticate(h.slice(7));
    req.studioKey = who;
    req.user = {
      id: who.holder.employeeId || who.holder.email,
      name: who.holder.name || who.holder.email,
      email: who.holder.email,
      employeeId: who.holder.employeeId,
      role: keys.DEPARTMENT,
    };
    next();
  } catch (e) {
    sendError(res, e);
  }
}

router.use(keyAuth);

const designer = (req) => ({ id: req.user.id, name: req.user.name, email: req.user.email });

router.get("/me", (req, res) => {
  res.json({ success: true, name: req.user.name, email: req.user.email, department: "Design (R&D)" });
});

router.get("/samples", async (req, res) => {
  try {
    const companyId = req.studioKey.companyId;
    const styles = await listStyles("design", companyId);
    const nameOf = await customerNames(styles, companyId);
    res.json({ success: true, samples: styles.map((s) => studio.sampleCard(s, { customerName: nameOf(s) })) });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/samples/:id", async (req, res) => {
  try {
    const companyId = req.studioKey.companyId;
    const style = await loadStyle(req.params.id, companyId, { lean: true });
    const nameOf = await customerNames([style], companyId);
    res.json({ success: true, sample: studio.sampleCard(style, { customerName: nameOf(style) }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/samples/:id/open", async (req, res) => {
  try {
    const companyId = req.studioKey.companyId;
    const style = await loadStyle(req.params.id, companyId);
    const { first } = studio.markOpened(style, designer(req));
    if (first || style.isModified()) await style.save();
    const nameOf = await customerNames([style], companyId);
    res.json({ success: true, sample: studio.sampleCard(style.toObject(), { customerName: nameOf(style) }) });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/samples/:id/files/:fileId", async (req, res) => {
  try {
    const style = await loadStyle(req.params.id, req.studioKey.companyId, { lean: true });
    if (!studio.knownFileIds(style).has(req.params.fileId)) return res.status(404).json({ success: false, error: "File not found." });
    const { stream, meta } = await storage.stream(req.params.fileId);
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    if (meta.size) res.setHeader("Content-Length", String(meta.size));
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    sendError(res, e);
  }
});

const isPng = (f) => f.mimetype === "image/png" || /\.png$/i.test(f.originalname || "");
const isSvg = (f) => f.mimetype === "image/svg+xml" || /\.svg$/i.test(f.originalname || "");
const isJpeg = (f) => f.mimetype === "image/jpeg" || /\.jpe?g$/i.test(f.originalname || "");
const stem = (name) => String(name || "").replace(/\.[^.]+$/, "");
/** A flat's kind by its name: "<name> - back colour.svg" is the back's coloured flat. */
const flatKind = (name) => {
  // the view and its layer after the last " - ": "<name> - back pom.svg",
  // "<name> - front callouts.png" (so a style named "Back…" stays itself)
  const n = stem(name).split(" - ").pop();
  const layer = /\bpom\b/i.test(n) ? "Pom" : /callout/i.test(n) ? "Callouts" : /construction/i.test(n) ? "Construction" : /colou?r/i.test(n) ? "Colour" : "";
  return `${/\bback\b/i.test(n) ? "back" : "front"}${layer}`;
};

function parseManifest(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    const e = new Error("The manifest is not valid JSON.");
    e.status = 400;
    throw e;
  }
}

router.post(
  "/samples/:id/versions",
  (req, res, next) =>
    upload(req, res, (err) => {
      if (!err) return next();
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      const error = err.code === "LIMIT_FILE_SIZE" ? "A file is too large to send." : `The upload was refused: ${err.message}`;
      res.status(status).json({ success: false, error });
    }),
  async (req, res) => {
    const stored = [];
    try {
      const companyId = req.studioKey.companyId;
      const style = await loadStyle(req.params.id, companyId);
      studio.assertWithDesign(style);
      const project = req.files?.project?.[0];
      const renders = req.files?.renders || [];
      const flats = req.files?.flats || [];
      const artwork = req.files?.artwork || [];
      if (!project) return res.status(400).json({ success: false, error: "The project file is missing." });
      if (!renders.length) return res.status(400).json({ success: false, error: "Send at least one render." });
      if (renders.some((f) => !isPng(f) || f.size > LIMITS.image)) {
        return res.status(400).json({ success: false, error: "Renders must be PNG pictures under 20 MB." });
      }
      if (flats.some((f) => !(isPng(f) || isSvg(f)) || f.size > LIMITS.image)) {
        return res.status(400).json({ success: false, error: "Flats must be PNG or SVG files under 20 MB." });
      }
      if (artwork.some((f) => !(isPng(f) || isJpeg(f)) || f.size > LIMITS.image)) {
        return res.status(400).json({ success: false, error: "Artwork must be PNG or JPEG pictures under 20 MB." });
      }
      const manifest = parseManifest(req.body?.manifest);
      const next = (style.studio?.versions || []).reduce((m, v) => Math.max(m, v.version || 0), 0) + 1;
      const folderPath = ["GRAV Studio", style.styleCode || style.sampleStyleId || String(style._id), `v${next}`];
      const put = async (f, kind, mimeType) => {
        const r = await storage.put(f.buffer, { fileName: f.originalname || `${kind}`, mimeType: mimeType || f.mimetype, folderPath });
        stored.push(r.fileId);
        return { fileId: r.fileId, name: f.originalname || kind, mimeType: r.mimeType || mimeType || f.mimetype, size: f.size, kind };
      };
      const files = {
        project: await put(project, "project", "application/octet-stream"),
        renders: [],
        flats: [],
        artwork: [],
      };
      for (const f of renders) files.renders.push(await put(f, stem(f.originalname), "image/png"));
      for (const f of flats) files.flats.push(await put(f, flatKind(f.originalname), isSvg(f) ? "image/svg+xml" : "image/png"));
      for (const f of artwork) files.artwork.push(await put(f, "artwork", isJpeg(f) ? "image/jpeg" : "image/png"));

      const { version } = studio.addVersion(
        style,
        { files, note: req.body?.note, manifest, appVersion: req.body?.appVersion },
        designer(req),
      );
      await style.save();
      stored.length = 0;
      /* Who is told a version is waiting is Sales' (its pipeline page), and
         is added with it; nobody is emailed until then. */

      res.status(201).json({ success: true, version, sample: studio.sampleCard(style.toObject()) });
    } catch (e) {
      // Nothing half-sent stays behind.
      for (const id of stored) Promise.resolve(storage.remove(id)).catch(() => {});
      sendError(res, e);
    }
  },
);

module.exports = router;
