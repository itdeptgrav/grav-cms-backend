// routes/Admin/publicDepartments.js
//
// The only unauthenticated route in this feature. Mounted at /api/public.
//
// It backs the /onboarding tile grid, so it is reachable by anyone on the
// internet. It therefore returns the absolute minimum: what a department is
// called, what it looks like, and where its login form lives. No emails, no
// user counts, no employee names, no dashboard internals — a public page must
// not double as a directory of who works here or how many people to phish.

"use strict";

const express = require("express");
const router = express.Router();

const AccessDepartment = require("../../models/Access/AccessDepartment");

/** GET /api/public/departments — tiles for the onboarding page. */
router.get("/departments", async (req, res) => {
  try {
    const departments = await AccessDepartment.find({
      isActive: true,
      showOnOnboarding: true,
    })
      // dashboardPath and loginRedirect are needed so a signed-in user
      // clicking a tile goes to the real dashboard. Without them the portal
      // fell back to "/d/<slug>" — the generic shell, which does not exist —
      // and every tile led to a 404.
      .select("slug name description iconUrl iconAlt accentColor sortOrder dashboardPath loginRedirect")
      .sort({ sortOrder: 1, name: 1 })
      .lean();

    // Short cache: the list changes only when an admin edits it, and the page
    // is hit by everyone at the start of every shift.
    res.setHeader("Cache-Control", "public, max-age=60");

    res.json({
      success: true,
      departments: departments.map((d) => ({
        slug: d.slug,
        name: d.name,
        description: d.description || "",
        iconUrl: d.iconUrl || "",
        iconAlt: d.iconAlt || d.name,
        accentColor: d.accentColor || "#4F46E5",
        // Not sensitive — it is a route anyone can already type. Omitting it
        // was what sent every tile to a 404.
        dashboardPath: d.loginRedirect || d.dashboardPath || `/d/${d.slug}`,
      })),
    });
  } catch (error) {
    console.error("[public] departments:", error);
    res.status(500).json({ success: false, message: "Could not load departments" });
  }
});

/**
 * GET /api/public/departments/:slug — branding for one department's login form.
 *
 * Returns 404 for an unknown slug rather than an empty success, so the login
 * page can show "no such department" instead of an unbranded form that will
 * reject every attempt.
 */
router.get("/departments/:slug", async (req, res) => {
  try {
    const dept = await AccessDepartment.findOne({
      slug: String(req.params.slug).toLowerCase(),
      isActive: true,
      showOnOnboarding: true,
    })
      .select("slug name description iconUrl iconAlt accentColor")
      .lean();

    if (!dept) return res.status(404).json({ success: false, message: "Department not found" });

    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ success: true, department: dept });
  } catch (error) {
    res.status(500).json({ success: false, message: "Could not load department" });
  }
});

module.exports = router;
