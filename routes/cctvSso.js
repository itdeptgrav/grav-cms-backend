// routes/cctvSso.js
//
// Redirect endpoint for the externally-hosted CCTV site (cctv.grav.in).
//
// Mounted at /api/cctv BEHIND Middlewear/cctvAuth — the existing gate that
// reuses the CMS session + the per-department `cctvEnabled` rule and sets
// req.cctvUser ONLY for users it allows (platform admin, or a held department
// with cctvEnabled === true). Reaching this handler already means the caller
// passed that gate, so this router does no access check of its own.
//
// It simply 302-redirects the (already-authorised) browser to the hosted CCTV
// app using its existing access key. The CMS is the gate for WHO is ever sent
// here; the resulting URL carries the key, so treat it as sensitive.

const express = require("express");

const router = express.Router();

// GET /api/cctv/sso  ->  302 to  <CCTV_APP_URL>/?key=<CCTV_KEY>
router.get("/sso", (req, res) => {
  const appUrl = (process.env.CCTV_APP_URL || "https://cctv.grav.in").replace(/\/+$/, "");
  const key = process.env.CCTV_KEY || "grav-cctv-4821";
  res.redirect(302, `${appUrl}/?key=${encodeURIComponent(key)}`);
});

module.exports = router;
