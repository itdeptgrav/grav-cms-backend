// routes/Accountant_Routes/cashflowAdjustmentsRoutes.js
//
// Manually-entered "Particulars" rows on the Cash Flow report.
//
// Endpoints (all org-scoped via orgAuth):
//
//   GET    /api/accountant/cashflow-adjustments?periodStart=...&periodEnd=...
//          → list adjustments overlapping the period
//
//   POST   /api/accountant/cashflow-adjustments
//          → create. Body: { section, label, amount, periodStart, periodEnd, fyTag?, notes? }
//          - owner/approver  → status = "posted" immediately
//          - editor          → status = "pending_approval", invisible to others until approved
//          - viewer          → 403
//
//   PUT    /api/accountant/cashflow-adjustments/:id
//          → edit. Same role rules: editors' edits go to pending_approval.
//
//   DELETE /api/accountant/cashflow-adjustments/:id
//          → soft-delete (sets status="void"). Same role rules.
//
//   POST   /api/accountant/cashflow-adjustments/:id/approve
//          → approve a pending row. Approver/owner only. Sets status="posted".
//
//   POST   /api/accountant/cashflow-adjustments/:id/reject
//          → reject. Approver/owner only. Sets status="rejected" + reviewNote.
//
//   GET    /api/accountant/cashflow-adjustments/pending
//          → list everything awaiting approval in this org (for approval queue).
//
// IMPORTANT: All routes scope by req.user.organizationId. Cross-org reads
// are impossible by design. Tested manually: a sub-account user from
// Org X cannot list/edit/delete Org Y adjustments.

const express = require("express");
const router = express.Router();
const CashFlowAdjustment = require("../../models/Accountant_model/CashFlowAdjustment");
const { orgAuth } = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function requireOrg(req, res) {
  if (req.user?.isDev || req.user?.isLegacy) {
    res
      .status(400)
      .json({ success: false, message: "Sub-account session required." });
    return false;
  }
  if (!req.user?.organizationId) {
    res
      .status(401)
      .json({ success: false, message: "No organization context." });
    return false;
  }
  return true;
}

function requireCanEdit(req, res) {
  if (!req.user?.permissions?.canEdit) {
    res.status(403).json({
      success: false,
      message:
        "Your role doesn't allow editing. Ask an owner to upgrade your permissions.",
    });
    return false;
  }
  return true;
}

function requireCanApprove(req, res) {
  if (!req.user?.permissions?.canApprove) {
    res.status(403).json({
      success: false,
      message: "Your role doesn't allow approving entries.",
    });
    return false;
  }
  return true;
}

// Compute initial status: posted if user can post directly; else pending_approval
function initialStatus(req) {
  return req.user?.permissions?.canPostDirectly ? "posted" : "pending_approval";
}

// ─────────────────────────────────────────────────────────────────────────
// GET / — list adjustments for a period
// ─────────────────────────────────────────────────────────────────────────
// Returns posted adjustments for everyone, plus the requesting user's
// OWN pending_approval rows (so editors see their drafts greyed out).
router.get("/", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    const { periodStart, periodEnd, section } = req.query;

    const q = { organizationId: req.user.organizationId };
    if (section) q.section = section;

    // Period overlap: adjustment's [periodStart, periodEnd] intersects
    // [requested.start, requested.end]. We tolerate adjustments with
    // missing dates (treat as "any period").
    if (periodStart && periodEnd) {
      q.$and = [
        {
          $or: [
            { periodStart: { $exists: false } },
            { periodStart: null },
            { periodStart: { $lte: new Date(periodEnd) } },
          ],
        },
        {
          $or: [
            { periodEnd: { $exists: false } },
            { periodEnd: null },
            { periodEnd: { $gte: new Date(periodStart) } },
          ],
        },
      ];
    }

    // Status filter: posted is visible to everyone; pending only to
    // the creator (or to approvers via the /pending endpoint).
    q.$or = [
      { status: "posted" },
      { status: "pending_approval", createdBy: req.user.id },
    ];

    const rows = await CashFlowAdjustment.find(q)
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, adjustments: rows });
  } catch (e) {
    console.error("[cashflow-adj/list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /pending — approver queue: all pending in this org
// ─────────────────────────────────────────────────────────────────────────
router.get("/pending", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanApprove(req, res)) return;
    const rows = await CashFlowAdjustment.find({
      organizationId: req.user.organizationId,
      status: "pending_approval",
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, adjustments: rows });
  } catch (e) {
    console.error("[cashflow-adj/pending]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create new adjustment
// ─────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanEdit(req, res)) return;

    const { section, label, amount, periodStart, periodEnd, fyTag, notes } =
      req.body || {};

    // Validation
    if (!section || !["A", "B", "C", "R"].includes(section)) {
      return res.status(400).json({
        success: false,
        message: "Invalid section. Must be A, B, C, or R.",
      });
    }
    if (typeof label !== "string" || label.trim().length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Label is required." });
    }
    if (label.length > 200) {
      return res.status(400).json({
        success: false,
        message: "Label is too long (max 200 chars).",
      });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt)) {
      return res
        .status(400)
        .json({ success: false, message: "Amount must be a number." });
    }

    const doc = new CashFlowAdjustment({
      organizationId: req.user.organizationId,
      section,
      label: label.trim(),
      amount: amt,
      fyTag: fyTag || "",
      periodStart: periodStart ? new Date(periodStart) : undefined,
      periodEnd: periodEnd ? new Date(periodEnd) : undefined,
      status: initialStatus(req),
      createdBy: req.user.id,
      createdByName: req.user.name || "",
      createdByRole: req.user.role || "",
      notes: notes || "",
    });
    await doc.save();
    res.status(201).json({ success: true, adjustment: doc.toObject() });
  } catch (e) {
    console.error("[cashflow-adj/create]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — edit
// ─────────────────────────────────────────────────────────────────────────
// Editors' edits go to pending_approval (the previous version remains
// "posted" until approved? Or we mutate in place and flag as pending?).
// For simplicity: we mutate in place, and if the user can't post
// directly, we set status to pending_approval — meaning the row
// disappears for non-creators until re-approved.
router.put("/:id", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanEdit(req, res)) return;
    const id = req.params.id;
    const doc = await CashFlowAdjustment.findOne({
      _id: id,
      organizationId: req.user.organizationId,
    });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, message: "Adjustment not found." });

    // Editors can only edit their own pending rows (not posted ones —
    // those require approval to modify). Owners/approvers can edit any.
    if (
      !req.user.permissions.canPostDirectly &&
      String(doc.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Editors can only modify their own pending rows.",
      });
    }

    const { section, label, amount, notes } = req.body || {};
    if (section !== undefined) {
      if (!["A", "B", "C", "R"].includes(section)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid section." });
      }
      doc.section = section;
    }
    if (label !== undefined) {
      if (typeof label !== "string" || !label.trim()) {
        return res
          .status(400)
          .json({ success: false, message: "Label cannot be empty." });
      }
      doc.label = label.trim();
    }
    if (amount !== undefined) {
      const amt = Number(amount);
      if (!Number.isFinite(amt)) {
        return res
          .status(400)
          .json({ success: false, message: "Amount must be a number." });
      }
      doc.amount = amt;
    }
    if (notes !== undefined) doc.notes = String(notes);

    // If editor modified a posted row (this only reaches here if the
    // editor created it themselves), demote back to pending.
    if (!req.user.permissions.canPostDirectly) {
      doc.status = "pending_approval";
      doc.reviewedBy = undefined;
      doc.reviewedByName = "";
      doc.reviewedAt = undefined;
    }

    await doc.save();
    res.json({ success: true, adjustment: doc.toObject() });
  } catch (e) {
    console.error("[cashflow-adj/update]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — soft delete (set status="void")
// ─────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanEdit(req, res)) return;
    const id = req.params.id;
    const doc = await CashFlowAdjustment.findOne({
      _id: id,
      organizationId: req.user.organizationId,
    });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, message: "Adjustment not found." });

    if (
      !req.user.permissions.canPostDirectly &&
      String(doc.createdBy) !== String(req.user.id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Editors can only delete their own pending rows.",
      });
    }

    doc.status = "void";
    await doc.save();
    res.json({ success: true });
  } catch (e) {
    console.error("[cashflow-adj/delete]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/approve
// ─────────────────────────────────────────────────────────────────────────
router.post("/:id/approve", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanApprove(req, res)) return;
    const id = req.params.id;
    const doc = await CashFlowAdjustment.findOne({
      _id: id,
      organizationId: req.user.organizationId,
      status: "pending_approval",
    });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, message: "Pending adjustment not found." });

    // 4-eyes rule: creator can't approve their own
    if (String(doc.createdBy) === String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: "You can't approve your own entry. Ask another approver.",
      });
    }

    doc.status = "posted";
    doc.reviewedBy = req.user.id;
    doc.reviewedByName = req.user.name || "";
    doc.reviewedAt = new Date();
    doc.reviewNote = req.body?.note || "";
    await doc.save();
    res.json({ success: true, adjustment: doc.toObject() });
  } catch (e) {
    console.error("[cashflow-adj/approve]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/reject
// ─────────────────────────────────────────────────────────────────────────
router.post("/:id/reject", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanApprove(req, res)) return;
    const id = req.params.id;
    const doc = await CashFlowAdjustment.findOne({
      _id: id,
      organizationId: req.user.organizationId,
      status: "pending_approval",
    });
    if (!doc)
      return res
        .status(404)
        .json({ success: false, message: "Pending adjustment not found." });

    doc.status = "rejected";
    doc.reviewedBy = req.user.id;
    doc.reviewedByName = req.user.name || "";
    doc.reviewedAt = new Date();
    doc.reviewNote = req.body?.note || "";
    await doc.save();
    res.json({ success: true, adjustment: doc.toObject() });
  } catch (e) {
    console.error("[cashflow-adj/reject]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
