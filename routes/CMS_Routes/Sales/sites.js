// routes/CMS_Routes/Sales/sites.js  →  /api/cms/crm/sites
//
// Operational locations for an account. Enforces: siteCode unique within the
// account (DB partial index), one primary site per account (crmPrimary), and an
// acyclic parent/child tree (crmHierarchy). All writes are audited.
const express = require("express");
const router = express.Router();
const Site = require("../../../models/CMS_Models/Sales/Site");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { makeSolePrimary, ensureGroupHasPrimary } = require("../../../services/crmPrimary");
const { assertNoSiteCycle, HierarchyError } = require("../../../services/crmHierarchy");

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const dupMessage = (err) => (err?.code === 11000 ? "A site with that code already exists on this account." : err.message);

// GET /api/cms/crm/sites?accountId=&search=
router.get("/", salesAuth, async (req, res) => {
  try {
    const { accountId, search, includeArchived } = req.query;
    const filter = {};
    if (accountId) filter.accountId = accountId;
    if (includeArchived !== "true") filter.isActive = true;
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ name: re }, { siteCode: re }, { city: re }, { siteId: re }];
    }
    const sites = await Site.find(filter).sort({ isPrimary: -1, createdAt: -1 }).lean();
    res.json({ success: true, sites });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/sites
router.post("/", salesAuth, async (req, res) => {
  try {
    if (!req.body.accountId) return res.status(400).json({ success: false, message: "accountId is required." });
    const data = { ...req.body, createdBy: actor(req), updatedBy: actor(req) };
    const site = await Site.create(data);

    // First site of the account becomes primary automatically; an explicit
    // isPrimary demotes any previous primary.
    if (site.isPrimary) {
      await makeSolePrimary(Site, { accountId: site.accountId, isActive: true }, site._id);
    } else {
      await ensureGroupHasPrimary(Site, { accountId: site.accountId, isActive: true }, site._id);
    }

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-site",
      entityId: site._id,
      entityLabel: site.name,
      action: "create",
      summary: `Added site "${site.name}"`,
      after: site.toObject(),
    });
    res.status(201).json({ success: true, site });
  } catch (err) {
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// PATCH /api/cms/crm/sites/:id
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Site.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ success: false, message: "Site not found" });

    if ("parentSiteId" in req.body) {
      await assertNoSiteCycle(Site, req.params.id, req.body.parentSiteId || null);
    }

    const site = await Site.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedBy: actor(req) },
      { new: true, runValidators: true },
    );

    if (req.body.isPrimary === true) {
      await makeSolePrimary(Site, { accountId: site.accountId, isActive: true }, site._id);
    }

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-site",
      entityId: site._id,
      entityLabel: site.name,
      action: "update",
      before,
      after: site.toObject(),
    });
    res.json({ success: true, site });
  } catch (err) {
    if (err instanceof HierarchyError) return res.status(err.status).json({ success: false, message: err.message });
    res.status(400).json({ success: false, message: dupMessage(err) });
  }
});

// DELETE /api/cms/crm/sites/:id — soft archive
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const site = await Site.findByIdAndUpdate(
      req.params.id,
      { isActive: false, status: "archived", archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },
    );
    if (!site) return res.status(404).json({ success: false, message: "Site not found" });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-site",
      entityId: site._id,
      entityLabel: site.name,
      action: "archive",
      summary: `Archived site "${site.name}"`,
    });
    res.json({ success: true, message: "Site archived" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
