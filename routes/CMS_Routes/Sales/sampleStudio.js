// routes/CMS_Routes/Sales/sampleStudio.js — mounted at /api/cms/studio-link
//
// THE CMS SIDE OF GRAV STUDIO (14 Oct 2026). The designer's card on the R&D
// Styles board, the review of what the designer sent, and the administrator's
// keys for the desktop app. GRAV Studio itself calls
// routes/Studio/studioApi.js with its key; both work on the same `studio`
// block of a SampleStyle (models/CMS_Models/Sales/sampleStudioSchema.js)
// through services/studio/sampleStudio.service.js.
//
//   GET  /styles?view=design|review        cards (design) / the review list
//   GET  /styles/:id                       one style's card and every version
//   POST /styles/:id/link                  "Create": link a Studio file (Design)
//   POST /styles/:id/versions/:v/decide    approve / ask for changes (see REVIEWERS)
//   GET  /styles/:id/files/:fileId         a render, flat or project file
//   GET  /keys · GET /keys/people · POST /keys · POST /keys/:keyId/revoke   (administrators)
//
// Every style is looked up inside the actor's company (salesScope.scopeFor).

"use strict";

const express = require("express");
const salesAuthBase = require("../../../Middlewear/SalesAuthMiddlewear");
const { scopeFor } = require("../../../services/companyContext/salesScope.service");
const { listRoles } = require("../../../services/departmentRoles");
const { notifyEvent, APP_URL } = require("../../../services/departmentNotify.service");
const studio = require("../../../services/studio/sampleStudio.service");
const { loadStyle, listStyles, customerNames } = require("../../../services/studio/sampleStudioQueries");
const storage = require("../../../services/studio/studioStorage.service");
const keys = require("../../../services/studio/studioKeys.service");
const { openUrlFor } = require("../../../services/studio/openUrl");

const router = express.Router();
const auth = salesAuthBase.withRoles(salesAuthBase.RND_ROLES);

const DESIGN_ROLES = salesAuthBase.RND_ROLES;
const isDesign = (u) => DESIGN_ROLES.includes(u?.role);
/* REVIEWERS. The review is Sales' (owner, 14 Oct 2026: "it is not
   merchandiser, it is from sales"), and Sales' side starts from its pipeline
   page — not built yet. Until it is, only an administrator or the CEO can
   answer a version; Merchandising cannot. */
const canReview = (u) => Boolean(u?.isAdmin) || u?.role === "ceo";
const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "", email: req.user?.email || "" });

function sendError(res, e) {
  const status = e.status || (e.code === "UNAUTHENTICATED" ? 401 : 500);
  if (status >= 500) console.error("[studio-link]", e);
  res.status(status).json({ success: false, message: status >= 500 ? "Something went wrong. Try again." : e.message });
}

async function companyOf(req) {
  const scope = await scopeFor(req, { domainLabel: "GRAV Studio" });
  return scope.companyId;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

router.get("/styles", auth, async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const view = req.query.view === "review" ? "review" : "design";
    const styles = await listStyles(view, companyId);
    const nameOf = await customerNames(styles, companyId);
    res.json({ success: true, styles: styles.map((s) => ({ ...studio.sampleCard(s, { customerName: nameOf(s) }), openUrl: openUrlFor(s) })) });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/styles/:id", auth, async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const style = await loadStyle(req.params.id, companyId, { lean: true });
    const nameOf = await customerNames([style], companyId);
    res.json({ success: true, style: { ...studio.sampleCard(style, { customerName: nameOf(style) }), openUrl: openUrlFor(style) } });
  } catch (e) {
    sendError(res, e);
  }
});

/* "Create": the designer links a Studio file to the style. The page then
   opens GRAV Studio on it (openUrl) when the app is installed; either way the
   file waits on Studio's start screen. */
router.post("/styles/:id/link", auth, async (req, res) => {
  try {
    if (!isDesign(req.user) && !req.user?.isAdmin) {
      return res.status(403).json({ success: false, message: "Only Design (R&D) creates a GRAV Studio file." });
    }
    const companyId = await companyOf(req);
    const style = await loadStyle(req.params.id, companyId);
    const { created } = studio.linkFile(style, actor(req));
    if (created) await style.save();
    const nameOf = await customerNames([style], companyId);
    res.status(created ? 201 : 200).json({
      success: true,
      created,
      style: { ...studio.sampleCard(style.toObject(), { customerName: nameOf(style) }), openUrl: openUrlFor(style) },
    });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/styles/:id/versions/:version/decide", auth, async (req, res) => {
  try {
    if (!canReview(req.user)) {
      return res.status(403).json({ success: false, message: "You cannot answer GRAV Studio renders." });
    }
    const companyId = await companyOf(req);
    const style = await loadStyle(req.params.id, companyId);
    const result = studio.decide(style, req.params.version, req.body || {}, actor(req));
    await style.save();
    const view = studio.studioView(style.toObject());
    const v = view.versions.find((x) => x.version === result.version);
    Promise.resolve(notifyEvent("studio_review_decided", {
      heading: `${result.outcome === "approved" ? "Approved" : "Changes asked"}: ${style.productName || style.styleCode || ""}`,
      bodyHtml: `<p><strong>${escapeHtml(actor(req).name || "The reviewer")}</strong> ${result.outcome === "approved" ? "approved" : "asked for changes on"} GRAV Studio version ${result.version}.</p>${v?.feedback ? `<p>${escapeHtml(v.feedback)}</p>` : ""}`,
      details: [["Style", style.styleCode || style.sampleStyleId], ["Product", style.productName], ["Version", String(result.version)]],
      bodyText: `${actor(req).name || "The reviewer"} ${result.outcome === "approved" ? "approved" : "asked for changes on"} version ${result.version} of "${style.productName || "a style"}".${v?.feedback ? ` ${v.feedback}` : ""}`,
      ctaLabel: "Open the style",
      ctaUrl: `${APP_URL}/research-development/styles/${style._id}`,
    })).catch(() => {});
    res.json({ success: true, outcome: result.outcome, version: result.version, studio: view });
  } catch (e) {
    sendError(res, e);
  }
});

router.get("/styles/:id/files/:fileId", auth, async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const style = await loadStyle(req.params.id, companyId, { lean: true });
    if (!studio.knownFileIds(style).has(req.params.fileId)) return res.status(404).json({ success: false, message: "File not found." });
    const { stream, meta } = await storage.stream(req.params.fileId);
    res.setHeader("Content-Type", meta.mimeType || "application/octet-stream");
    if (meta.size) res.setHeader("Content-Length", String(meta.size));
    const name = String(meta.name || "file").split(" / ").pop().replace(/["\r\n]/g, "");
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    sendError(res, e);
  }
});

/* ── KEYS: ADMINISTRATORS ONLY ─────────────────────────────────────────── */

/* The same gate as the rest of Access Control (/api/admin): the signed-in
   department login re-read from the database — active, an administrator, and
   the session's token version current. (Checking the Sales guard's `req.user`
   instead refused real administrators: that object carries no token version,
   so every session whose account had ever been re-issued read as revoked.) */
const adminOnly = require("../../../Middlewear/requirePlatformAdmin");

router.get("/keys", adminOnly, async (req, res) => {
  try {
    res.json({ success: true, keys: await keys.listKeys() });
  } catch (e) {
    sendError(res, e);
  }
});

// The people a key can be issued to: Design (R&D)'s granted roles.
router.get("/keys/people", adminOnly, async (req, res) => {
  try {
    const people = (await listRoles(keys.DEPARTMENT)).filter((p) => p.isActive).map((p) => ({ email: p.email, name: p.name || "", role: p.role }));
    res.json({ success: true, people });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/keys", adminOnly, async (req, res) => {
  try {
    const companyId = await companyOf(req);
    const { email, name, employeeId, label } = req.body || {};
    const issued = await keys.issueKey({ email, name, employeeId, label, companyId, actor: actor(req) });
    res.status(201).json({ success: true, key: issued.key, record: issued.record });
  } catch (e) {
    sendError(res, e);
  }
});

router.post("/keys/:keyId/revoke", adminOnly, async (req, res) => {
  try {
    res.json({ success: true, record: await keys.revokeKey(req.params.keyId, actor(req)) });
  } catch (e) {
    sendError(res, e);
  }
});

module.exports = router;
