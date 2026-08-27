// routes/Accountant_Routes/Acc_costCentres.js
//
// The cost-centre master — projects, branches, and anything else spend gets
// sliced by.
//
// `Acc_CostCentre` has existed since the Tally import was written and has
// never had an API: nothing could list one, create one, or pick one, which is
// why zero exist and why zero of ~1,700 vouchers tag one. A project budget is
// only a control if spend is attributed to the project, and nothing could be
// attributed to a master nobody could reach.
//
// Deliberately small. This is the picker's backing store, not a cost-centre
// management module — the model is Tally-shaped and stays that way.

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_CostCentre } = require("../../models/Accountant_model/Acc_MasterModels");
const actuals = require("../../services/budgetActuals.service");

router.use(AccountantAuthMiddleware.accountantAuth);

function companyOf(req) {
  return (
    req.headers["x-company-id"] ||
    req.query.companyId ||
    req.body?.companyId ||
    (req.user && req.user.companyId) ||
    null
  );
}

/** Same wording as the budget routers', so a read-only user gets one message
 *  however they reach a write. */
function requireEdit(req, res) {
  if (req.user?.permissions?.canEdit) return false;
  res.status(403).json({
    success: false,
    message: "Your accounting role is read-only, so this change was not saved.",
  });
  return true;
}

const shape = (c) => ({
  _id: c._id,
  name: c.name,
  parent: c.parent || null,
  parentName: c.parentName || null,
  category: c.category || null,
  isActive: c.isActive !== false,
  notes: c.notes || null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/**
 * GET / — what a picker offers.
 *
 * `?includeInactive=true` for a maintenance screen. A retired cost centre
 * leaves the picker but never stops reporting: a project closed in March still
 * has to explain what it spent in January, and its budget lines still resolve.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const filter = { companyId };
    if (String(req.query.includeInactive) !== "true") filter.isActive = { $ne: false };
    if (req.query.category) filter.category = req.query.category;

    const rows = await Acc_CostCentre.find(filter).sort({ name: 1 }).lean();
    res.json({ success: true, costCentres: rows.map(shape) });
  } catch (error) {
    console.error("[cost-centres] list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST / — create one.
 *
 * `category` defaults to "Projects" because that is what this endpoint exists
 * to serve; the field is free text on the model and any Tally category is
 * still accepted.
 */
router.post("/", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;

    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const name = String(req.body?.name ?? "").trim().replace(/\s+/g, " ");
    if (!name) {
      return res.status(400).json({ success: false, message: "A cost centre needs a name." });
    }

    /* The model's unique index is on (companyId, name) exactly, so a
     * differently-cased duplicate would be accepted by Mongo and then read as
     * two projects. Checked case-insensitively here to match how a person
     * would read the list. */
    const existing = await Acc_CostCentre.findOne({
      companyId,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    }).lean();
    if (existing) {
      return res.status(200).json({ success: true, costCentre: shape(existing), alreadyExisted: true });
    }

    const parent = actuals.oid(req.body?.parent);
    const created = await Acc_CostCentre.create({
      companyId,
      name,
      category: String(req.body?.category ?? "Projects").trim() || "Projects",
      parent: parent || null,
      parentName: req.body?.parentName ? String(req.body.parentName).trim() : undefined,
      notes: req.body?.notes ? String(req.body.notes).trim() : undefined,
    });

    res.status(201).json({ success: true, costCentre: shape(created.toObject()) });
  } catch (error) {
    /* The unique index is the real guard against two people adding the same
     * project at once; both pass the findOne above. */
    if (error?.code === 11000) {
      const dup = await Acc_CostCentre.findOne({
        companyId: actuals.oid(companyOf(req)),
        name: String(req.body?.name ?? "").trim().replace(/\s+/g, " "),
      }).lean();
      if (dup) {
        return res.status(200).json({ success: true, costCentre: shape(dup), alreadyExisted: true });
      }
    }
    console.error("[cost-centres] create error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PATCH /:id — rename or retire. The id never moves, so budget lines and
 *  voucher allocations pointing at it keep resolving. */
router.patch("/:id", async (req, res) => {
  try {
    if (requireEdit(req, res)) return;
    const companyId = actuals.oid(companyOf(req));
    if (!companyId) {
      return res.status(400).json({ success: false, message: "A company is required." });
    }

    const patch = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().replace(/\s+/g, " ");
      if (!name) {
        return res.status(400).json({ success: false, message: "A cost centre needs a name." });
      }
      patch.name = name;
    }
    if (req.body?.category !== undefined) patch.category = String(req.body.category).trim();
    if (req.body?.notes !== undefined) patch.notes = String(req.body.notes).trim();
    if (req.body?.isActive !== undefined) patch.isActive = !!req.body.isActive;

    const updated = await Acc_CostCentre.findOneAndUpdate(
      { _id: req.params.id, companyId },
      patch,
      { new: true, runValidators: true },
    ).lean();
    if (!updated) {
      return res.status(404).json({ success: false, message: "Cost centre not found." });
    }
    res.json({ success: true, costCentre: shape(updated) });
  } catch (error) {
    console.error("[cost-centres] update error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
