// routes/Access/meHome.js
//
// The employee home's own reads, mounted at /api/me beside actionables:
//   GET /api/me/home            the signed-in person's day (services/home)
//   GET /api/me/people?q=       a minimal colleague search — name, role,
//                               department and photo only
//
// Cross-department, so it reads the session itself (services/cmsSession).

"use strict";

const express = require("express");
const router = express.Router();

const { authenticateCmsSession } = require("../../services/cmsSession");
const { homeFor, searchPeople } = require("../../services/home/employeeHome.service");

router.get("/home", authenticateCmsSession, async (req, res) => {
  try {
    const out = await homeFor(req.user, { fresh: req.query.fresh === "1" });
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({ success: true, ...out });
  } catch (err) {
    console.error("[me/home]", err);
    return res.status(500).json({ success: false, message: "Could not load your home page." });
  }
});

router.get("/people", authenticateCmsSession, async (req, res) => {
  try {
    const people = await searchPeople(req.query.q);
    res.setHeader("Cache-Control", "private, no-store");
    return res.json({ success: true, people });
  } catch (err) {
    console.error("[me/people]", err);
    return res.status(500).json({ success: false, message: "Could not search colleagues." });
  }
});

module.exports = router;
