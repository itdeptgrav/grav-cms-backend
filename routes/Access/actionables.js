// routes/Access/actionables.js
//
// GET /api/me/actionables — the /onboarding dashboard's to-do counts across
// every application the caller holds. Mounted at /api/me.
//
// Cross-department, so it reads the session itself (services/cmsSession), like
// the approval queue and the team router, instead of borrowing one
// department's guard. Which applications are counted, and what each role is
// shown, is decided in services/actionables — see its header.

"use strict";

const express = require("express");
const router = express.Router();

const { authenticateCmsSession } = require("../../services/cmsSession");
const { actionablesFor } = require("../../services/actionables/actionables.service");

router.get("/actionables", authenticateCmsSession, async (req, res) => {
  try {
    const out = await actionablesFor(req.user, { fresh: req.query.fresh === "1" });
    if (!out.ok) {
      const status = out.code === "ACCESS_CHECK_UNAVAILABLE" ? 503 : 401;
      return res.status(status).json({ success: false, code: out.code, message: "Your applications could not be read." });
    }
    // Per person, and a figure that moves: never shared, never stored.
    res.setHeader("Cache-Control", "private, no-store");
    const { ok, ...body } = out;
    return res.json({ success: true, ...body });
  } catch (err) {
    console.error("[actionables]", err);
    return res.status(500).json({ success: false, message: "Could not load your to-do counts." });
  }
});

module.exports = router;
