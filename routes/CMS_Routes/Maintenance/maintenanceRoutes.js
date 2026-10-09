// routes/CMS_Routes/Maintenance/maintenanceRoutes.js
//
// /api/cms/maintenance — the Maintenance app.
//
//   GET  /overview                          the dashboard's figures
//
//   GET  /sewing-machines                   the register's sewing machines
//   POST /sewing-machines/:id/tag           issue a machine's barcode (idempotent)
//   GET  /resolve?code=MCH-XXXXXXXX         which machine a machine barcode names
//
//   GET  /subjects/resolve?code=            what ANY scanned barcode identifies:
//                                           a machine (MCH-…) or an allowed item
//                                           (a Store sticker) — read only
//   GET  /subjects/search?q=                machines and allowed items
//   GET  /subjects/:kind/:id                one machine or item, its combined
//                                           history and repair figures
//
//   GET  /orders?type=service|product       the register of one order type
//   POST /orders                            raise a Service or Product Order
//   GET  /orders/:id                        one order
//   POST /orders/:id/steps/:action          start / complete-repair / close /
//                                           put-into-maintenance / start-work /
//                                           solve / complete / cancel
//   POST /orders/:id/assign                 re-assign an open order
//   GET  /history                           every order and V1 report, newest first
//   GET  /staff                             who an order can be assigned to
//
//   GET  /settings                          Maintenance settings
//   PUT  /settings/visible-item-types       Allowed Product Types (Asset always in)
//
// Readers need viewer; raising and working orders and issuing a barcode need
// editor; settings need owner (maintenanceAccess.js). The rules live in
// services/maintenance/ — this file only translates.
//
// Nothing here writes to a Store document. It READS the Machine register, the
// Store's Item Master and its stickers, and writes only a machine's barcode,
// Maintenance's own orders and the one settings row.
"use strict";

const express = require("express");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const machines = require("../../../services/maintenance/maintenance.service");
const orders = require("../../../services/maintenance/maintenanceOrders.service");
const settings = require("../../../services/maintenance/maintenanceSettings");
const serviceTerms = require("../../../services/maintenance/maintenanceServiceTerms");
const driveFiles = require("../../../services/maintenance/maintenanceDrive");
const reportPdf = require("../../../services/maintenance/maintenanceReportPdf");
const MaintenanceOrder = require("../../../models/CMS_Models/Maintenance/MaintenanceOrder");
const multer = require("multer");
const RawItem = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const { requireMaintenance, accessOf } = require("./maintenanceAccess");

const router = express.Router();

/* Stated here, not inherited from the /api/cms mount, so moving this mount
   cannot quietly open it. */
router.use(EmployeeAuthMiddleware);

function fail(res, err, what) {
  if (err instanceof machines.MaintenanceError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.details || {}) });
  }
  console.error(`[maintenance] ${what} failed:`, err);
  return res.status(500).json({ success: false, message: `Could not ${what}.` });
}

const reply = (what, fn, { status = () => 200, viewer = true } = {}) => async (req, res) => {
  try {
    const out = await fn(req);
    res.status(status(out)).json({ success: true, ...out, ...(viewer ? { access: accessOf(req) } : {}) });
  } catch (err) { fail(res, err, what); }
};

/* ─── Overview ───────────────────────────────────────────────────────── */

router.get("/overview", requireMaintenance("viewer"), reply("read the overview", () => orders.overview()));

/* ─── Machines and their barcodes ────────────────────────────────────── */

router.get("/sewing-machines", requireMaintenance("viewer"),
  reply("list the sewing machines", (req) => machines.listSewingMachines({ search: req.query.search })));

router.post("/sewing-machines/:id/tag", requireMaintenance("editor"),
  reply("issue the barcode", (req) => machines.issueTag(req.params.id, req.user), { status: (o) => (o.created ? 201 : 200), viewer: false }));

router.get("/resolve", requireMaintenance("viewer"),
  reply("read the scan", (req) => machines.resolveTag(req.query.code), { viewer: false }));

/* ─── Subjects: an existing machine or item ──────────────────────────── */

router.get("/subjects/resolve", requireMaintenance("viewer"),
  reply("read the scan", (req) => orders.resolveCode(req.query.code), { viewer: false }));

router.get("/subjects/search", requireMaintenance("viewer"),
  reply("search", (req) => orders.searchSubjects(req.query.q)));

router.get("/subjects/:kind/:id", requireMaintenance("viewer"),
  reply("read the machine or product", (req) => orders.subjectDetail(req.params.kind, req.params.id)));

/* ─── Orders ─────────────────────────────────────────────────────────── */

router.get("/orders", requireMaintenance("viewer"), reply("list the orders", (req) => orders.listOrders({
  type: req.query.type, status: req.query.status, search: req.query.search, due: req.query.due, page: req.query.page, limit: req.query.limit,
})));

router.post("/orders", requireMaintenance("editor"),
  reply("raise the order", (req) => orders.createOrder(req.body?.orderType, req.body, req.user), { status: (o) => (o.created ? 201 : 200), viewer: false }));

router.get("/orders/:id", requireMaintenance("viewer"), reply("read the order", (req) => orders.orderDetail(req.params.id)));

/* ─── Maintenance Reports (4 Oct 2026) ─────────────────────────────────
   Written only by the job's "Submit report" step; read here, never edited. */
router.get("/reports", requireMaintenance("viewer"), reply("list the maintenance reports", (req) => orders.listReports({
  search: req.query.search, from: req.query.from, to: req.query.to, subject: req.query.subject,
  maintenanceType: req.query.maintenanceType, finalStatus: req.query.finalStatus, type: req.query.type,
  page: req.query.page, limit: req.query.limit,
})));
router.get("/reports/:id", requireMaintenance("viewer"), reply("read the maintenance report", (req) => orders.reportDetail(req.params.id)));
/* Checked / approved — once, by a Maintenance owner; it changes nothing in the report. */
router.post("/reports/:id/approve", requireMaintenance("owner"),
  reply("approve the maintenance report", (req) => orders.approveReport(req.params.id, req.body, req.user)));

/* The report as a PDF — the document people keep (owner, 4 Oct 2026). Drawn
   from the stored, write-once report, so it is the same every time. */
router.get("/reports/:id/pdf", requireMaintenance("viewer"), async (req, res) => {
  try {
    const { report } = await orders.reportDetail(req.params.id);
    /* Before / after photos drawn into the PDF; one that Drive cannot give in
       time is only listed. Drive not configured: the PDF lists them all. */
    const images = await reportPdf.evidenceImages(report, driveFiles.streamFile).catch(() => ({ before: [], after: [] }));
    const pdf = await reportPdf.buildReportPdf(report, { images });
    const name = reportPdf.pdfFileName(report);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    /* The CMS reads the file name across origins (localhost:3001 → :5000). */
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Content-Length", pdf.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.end(pdf);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) console.error("[maintenance] report pdf failed:", err?.message);
    return res.status(status).json({ success: false, code: err?.code || "REPORT_PDF_FAILED", message: status >= 500 ? "The report PDF could not be made. Try again." : err.message });
  }
});

router.post("/orders/:id/steps/:action", requireMaintenance("editor"),
  reply("record the step", (req) => orders.stepOrder(req.params.id, req.params.action, req.body, req.user)));

router.post("/orders/:id/assign", requireMaintenance("editor"),
  reply("assign the order", (req) => orders.assignOrder(req.params.id, req.body?.assignedToId, req.user)));

/* Photos and documents, already on Google Drive; only their references come here. */
router.post("/orders/:id/attachments", requireMaintenance("editor"),
  reply("attach the files", (req) => orders.addAttachments(req.params.id, req.body, req.user)));

/* ─── Files on Google Drive (private) ────────────────────────────────── */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: driveFiles.MAX_BYTES, files: 1 } });

/* busboy hands a non-ASCII name over as latin-1; read it back as UTF-8. */
const fileNameOf = (raw) => {
  const name = String(raw || "file");
  return /[\u0080-ÿ]/.test(name) ? Buffer.from(name, "latin1").toString("utf8") : name;
};

/** One photo or document → Drive, privately. Answers its reference, which the job then keeps. */
router.post("/files", requireMaintenance("editor"), (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({ success: false, code: tooBig ? "FILE_TOO_LARGE" : "UPLOAD_UNREADABLE",
        message: tooBig ? "That file is over 25 MB. Attach a smaller copy." : "The file could not be read. Choose it again." });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ success: false, code: "NO_FILE", message: "Choose a file." });
    const name = fileNameOf(f.originalname).slice(0, 200);
    const problem = driveFiles.fileProblem({ name, size: f.size });
    if (problem) return res.status(400).json({ success: false, code: "FILE_REFUSED", message: problem });
    try {
      const file = await driveFiles.uploadFile(f.buffer, { name, mimeType: f.mimetype || "application/octet-stream" });
      return res.status(201).json({ success: true, file });
    } catch (e) {
      if (e instanceof driveFiles.DriveNotConfigured) return res.status(503).json({ success: false, code: "DRIVE_NOT_CONFIGURED", message: e.message });
      console.error("[maintenance] Drive upload failed:", e?.message);
      return res.status(502).json({ success: false, code: "DRIVE_UPLOAD_FAILED", message: "Google Drive did not accept the file. Try again." });
    }
  });
});

/**
 * A job's photo or document, streamed back through this signed-in route.
 * Only a file some maintenance job holds — never anything else the service
 * account can read. Images and PDFs show inline; anything else downloads, so
 * an uploaded page or script can never run on this origin.
 */
router.get("/files/:fileId", requireMaintenance("viewer"), async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "");
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) return res.status(404).end();
    const held = await MaintenanceOrder.findOne({ "attachments.fileId": fileId }).select({ "attachments.$": 1 }).lean();
    if (!held) return res.status(404).end();
    const a = held.attachments[0];
    const { stream, meta } = await driveFiles.streamFile(fileId);
    const mime = String(meta.mimeType || a.mimeType || "application/octet-stream").toLowerCase();
    const inlineSafe = (mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf";
    res.setHeader("Content-Type", mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${req.query.dl === "1" || !inlineSafe ? "attachment" : "inline"}; filename="${encodeURIComponent(a.name || meta.name || "file")}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    if (meta.size) res.setHeader("Content-Length", meta.size);
    stream.on("error", (e) => {
      console.error("[maintenance] Drive stream error:", e?.message);
      if (!res.headersSent) res.status(502).end(); else res.end();
    });
    return stream.pipe(res);
  } catch (e) {
    if (e instanceof driveFiles.DriveNotConfigured) return res.status(503).json({ success: false, message: e.message });
    console.error("[maintenance] Drive read failed:", e?.message);
    if (!res.headersSent) return res.status(502).end();
    return res.end();
  }
});

router.get("/history", requireMaintenance("viewer"), reply("read the history", (req) => orders.history({
  type: req.query.type, status: req.query.status, search: req.query.search, subjectKind: req.query.subject,
})));

/* The Store service form's lists — suppliers, budget heads, billing units —
   built by the Store's own rules, READ-ONLY (services/maintenance/maintenanceServiceTerms.js). */
router.get("/service-options", requireMaintenance("viewer"),
  reply("load the service form's lists", () => serviceTerms.serviceOptions()));

router.get("/staff", requireMaintenance("viewer"), reply("list the team", async (req) => ({ staff: await orders.maintenanceStaff(req.user) })));

/* ─── Settings ───────────────────────────────────────────────────────── */

/* Every type the Item Master holds now, with its count, and how many items
   have none — the screen joins these to the Store's own list of types. */
async function typesInUse() {
  const rows = await RawItem.aggregate([{ $group: { _id: "$productType", n: { $sum: 1 } } }]);
  const inUse = [];
  let unclassified = 0;
  for (const r of rows) {
    const t = String(r._id ?? "").trim();
    if (!t) unclassified += r.n;
    else inUse.push({ type: t, count: r.n });
  }
  return { inUse: inUse.sort((a, b) => b.count - a.count), unclassified };
}

async function settingsBody() {
  const [meta, types] = await Promise.all([settings.settingsMeta(), typesInUse()]);
  return {
    ...meta,
    requiredType: settings.REQUIRED_TYPE,
    notClassified: settings.NOT_CLASSIFIED,
    itemTypesInUse: types.inUse,
    unclassifiedItems: types.unclassified,
  };
}

router.get("/settings", requireMaintenance("viewer"), reply("read the settings", () => settingsBody()));

router.put("/settings/visible-item-types", requireMaintenance("owner"), async (req, res) => {
  try {
    const types = req.body?.visibleItemTypes;
    if (!Array.isArray(types)) {
      return res.status(400).json({ success: false, code: "INVALID_SETTINGS", message: "Send the list of product types to allow." });
    }
    await settings.setVisibleItemTypes(types, req.user);
    res.json({ success: true, ...(await settingsBody()), access: accessOf(req) });
  } catch (err) { fail(res, err, "save the settings"); }
});

module.exports = router;
