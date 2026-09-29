// routes/cctvSso.js
//
// The CMS side of CCTV (the camera site itself is grav-cctv at cctv.grav.in).
// Mounted at /api/cctv.
//
//   POST /api/cctv/sso              the CMS /cctv page asks for a sign-in URL
//   GET  /api/cctv/sso              the same for a plain link (302 to it)
//   GET  /api/cctv/internal/access  the CCTV site asks what a person may do
//
// BEFORE (until 28 Sep 2026) /sso 302-redirected every CCTV-enabled user to
// cctv.grav.in/?key=<one shared key>: no identity crossed over, so every one
// of them saw every camera, and the key sat in their browser history. Now the
// browser carries a 90-second token naming WHO the person is, and the CCTV
// site asks /internal/access WHAT they may do — per camera: live video, sound,
// recorded playback (services/cctv/cctvAccess.service.js) — and keeps asking
// while they watch.
"use strict";

const express = require("express");
const { authenticateCmsSession } = require("../services/cmsSession");
const { resolveCctvAccess } = require("../services/cctv/cctvAccess.service");
const { mintSsoUrl, requireCctvService, CctvLinkError } = require("../services/cctv/cctvLink");

const router = express.Router();

/** Decide, and mint the hand-off URL for somebody allowed. */
async function signIn(req) {
  const who = { id: req.user.id, subject: req.user.subject, tv: req.user.tv, email: req.user.email, name: req.user.name };
  const access = await resolveCctvAccess(who);
  if (!access.allowed) {
    const status = access.denialCode === "ACCESS_CHECK_UNAVAILABLE" ? 503 : 403;
    return { status, body: { success: false, code: access.denialCode, message: access.message } };
  }
  try {
    const url = mintSsoUrl({ ...who, email: access.person?.email || who.email, name: access.person?.name || who.name });
    return { status: 200, body: { success: true, url, admin: access.admin, cameras: access.admin ? null : access.cameras.length } };
  } catch (err) {
    if (err instanceof CctvLinkError) return { status: err.status, body: { success: false, code: err.code, message: err.message } };
    throw err;
  }
}

// POST /api/cctv/sso → { url } (the page then navigates there)
router.post("/sso", authenticateCmsSession, async (req, res) => {
  try {
    const out = await signIn(req);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error("[cctv] sign-in failed:", err?.message || err);
    res.status(503).json({ success: false, code: "ACCESS_CHECK_UNAVAILABLE", message: "CCTV sign-in failed. Try again in a moment." });
  }
});

// GET /api/cctv/sso → 302 to the CCTV site (older links; top-level navigation carries the cookie)
router.get("/sso", authenticateCmsSession, async (req, res) => {
  try {
    const out = await signIn(req);
    if (out.status === 200) return res.redirect(302, out.body.url);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error("[cctv] sign-in failed:", err?.message || err);
    res.status(503).json({ success: false, code: "ACCESS_CHECK_UNAVAILABLE", message: "CCTV sign-in failed. Try again in a moment." });
  }
});

/**
 * GET /api/cctv/internal/access?id=&subject=&tv=&email=
 * Only the CCTV site (X-CCTV-Service-Key). The identifiers come from the
 * CCTV session it created from a sign-in token; the answer is re-read here.
 * Always 200 with the decision, 503 only when it could not be made.
 */
router.get("/internal/access", requireCctvService, async (req, res) => {
  const q = req.query || {};
  const access = await resolveCctvAccess({
    id: String(q.id || ""), subject: String(q.subject || ""), tv: Number(q.tv || 0), email: String(q.email || ""),
  });
  if (access.denialCode === "ACCESS_CHECK_UNAVAILABLE") return res.status(503).json({ success: false, ...access });
  res.set("Cache-Control", "no-store");
  res.json({ success: true, ...access, checkedAt: new Date().toISOString() });
});

module.exports = router;
