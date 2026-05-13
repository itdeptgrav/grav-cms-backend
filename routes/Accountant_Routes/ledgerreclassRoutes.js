// routes/Accountant_Routes/ledgerReclassRoutes.js
//
// Propose, approve, reject reclassification of ledgers between groups.
// Also handles within-group reordering (newOrder only, no group change).
//
// Endpoints
// ─────────
//   GET    /api/accountant/ledger-reclass/pending?companyId=...
//          → list pending requests for an approver. canApprove only.
//
//   GET    /api/accountant/ledger-reclass/mine?companyId=...
//          → list the requesting user's OWN pending requests. Used by
//            the Balance Sheet page to overlay pending moves so the
//            editor sees the ledger in its proposed new location.
//
//   POST   /api/accountant/ledger-reclass/propose
//          body: { companyId, ledgerId, toGroupId, newOrder?, notes? }
//          - owner/approver  → applies immediately; status=approved
//          - editor          → status=pending_approval
//          - viewer          → 403
//
//   POST   /api/accountant/ledger-reclass/:id/approve
//          → approve a pending request. canApprove + 4-eyes.
//            Applies the change to TallyLedger.
//
//   POST   /api/accountant/ledger-reclass/:id/reject
//          → reject pending. canApprove. Just marks rejected.
//
// Race conditions
// ───────────────
// If two reclassification requests target the same ledger and both get
// approved in quick succession, the LAST approval wins (the toGroupId
// from whichever was applied second). We log this case but don't try to
// merge — these are manual user-driven actions, the user can re-propose
// if they don't like the result.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const LedgerReclassificationRequest = require("../../models/Accountant_model/LedgerReclassificationRequest");
const {
  TallyLedger,
  TallyGroup,
} = require("../../models/Accountant_model/TallyMasterModels");
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
      message: "Your role doesn't allow reclassifying ledgers.",
    });
    return false;
  }
  return true;
}

function requireCanApprove(req, res) {
  if (!req.user?.permissions?.canApprove) {
    res.status(403).json({
      success: false,
      message: "Your role doesn't allow approving reclassifications.",
    });
    return false;
  }
  return true;
}

// Apply a request: mutate the underlying TallyLedger. Idempotent — if
// the ledger has already moved to the destination group, we still write
// the newOrder if supplied. Returns the updated ledger doc.
async function applyRequest(req, reqDoc) {
  const ledger = await TallyLedger.findOne({
    _id: reqDoc.ledgerId,
    companyId: reqDoc.companyId,
    isActive: true,
  });
  if (!ledger) {
    const e = new Error("Ledger not found or has been deleted.");
    e.status = 404;
    throw e;
  }
  const destGroup = await TallyGroup.findOne({
    _id: reqDoc.toGroupId,
    companyId: reqDoc.companyId,
    isActive: true,
  });
  if (!destGroup) {
    const e = new Error("Destination group not found or has been deleted.");
    e.status = 404;
    throw e;
  }

  const groupChanged = String(ledger.groupId) !== String(destGroup._id);

  if (groupChanged) {
    ledger.groupId = destGroup._id;
    ledger.groupName = destGroup.name;
    ledger.nature = destGroup.nature; // nature follows the destination
    ledger.reclassifiedAt = new Date();
    ledger.reclassifiedBy = req.user.id;
    ledger.reclassifiedByName = req.user.name || "";
    ledger.reclassificationCount = (ledger.reclassificationCount || 0) + 1;
  }

  if (reqDoc.newOrder !== null && reqDoc.newOrder !== undefined) {
    ledger.groupOrder = Number(reqDoc.newOrder);
  }

  await ledger.save();
  return ledger;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /pending — approver queue
// ─────────────────────────────────────────────────────────────────────────
router.get("/pending", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanApprove(req, res)) return;
    const q = {
      organizationId: req.user.organizationId,
      status: "pending_approval",
    };
    if (req.query.companyId) q.companyId = req.query.companyId;
    const rows = await LedgerReclassificationRequest.find(q)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error("[ledger-reclass/pending]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /mine — caller's own pending requests
// ─────────────────────────────────────────────────────────────────────────
// Used by the Balance Sheet to overlay pending moves: the editor sees
// the ledger in its proposed location with a "pending" badge.
router.get("/mine", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    const q = {
      organizationId: req.user.organizationId,
      createdBy: req.user.id,
      status: "pending_approval",
    };
    if (req.query.companyId) q.companyId = req.query.companyId;
    const rows = await LedgerReclassificationRequest.find(q)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error("[ledger-reclass/mine]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /propose
// ─────────────────────────────────────────────────────────────────────────
router.post("/propose", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanEdit(req, res)) return;

    const {
      companyId,
      ledgerId,
      toGroupId,
      newOrder,
      notes,
      ackCrossCategory,
    } = req.body || {};
    if (!companyId || !ledgerId || !toGroupId) {
      return res.status(400).json({
        success: false,
        message: "companyId, ledgerId, and toGroupId are required.",
      });
    }
    if (
      !mongoose.Types.ObjectId.isValid(companyId) ||
      !mongoose.Types.ObjectId.isValid(ledgerId) ||
      !mongoose.Types.ObjectId.isValid(toGroupId)
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid id format." });
    }

    const ledger = await TallyLedger.findOne({
      _id: ledgerId,
      companyId,
      isActive: true,
    });
    if (!ledger)
      return res
        .status(404)
        .json({ success: false, message: "Ledger not found." });
    const fromGroup = await TallyGroup.findById(ledger.groupId).lean();
    const toGroup = await TallyGroup.findOne({
      _id: toGroupId,
      companyId,
      isActive: true,
    }).lean();
    if (!toGroup)
      return res
        .status(404)
        .json({ success: false, message: "Destination group not found." });

    const isCrossCategory = !!fromGroup && fromGroup.nature !== toGroup.nature;
    // The frontend's confirmation modal must POST ackCrossCategory: true
    // when this is a cross-category move. If missing, we reject with a
    // structured error so the frontend can show its modal.
    if (isCrossCategory && !ackCrossCategory) {
      return res.status(409).json({
        success: false,
        code: "CROSS_CATEGORY_CONFIRM_REQUIRED",
        message: `This moves "${ledger.name}" from ${fromGroup?.nature || "?"} to ${toGroup.nature}. The ledger's accounting nature will change. Confirm to proceed.`,
        from: { groupName: fromGroup?.name, nature: fromGroup?.nature },
        to: { groupName: toGroup.name, nature: toGroup.nature },
      });
    }

    // Same-group, same-order is a no-op
    const sameGroup = String(ledger.groupId) === String(toGroupId);
    const sameOrder =
      newOrder == null || Number(newOrder) === ledger.groupOrder;
    if (sameGroup && sameOrder) {
      return res.json({ success: true, noop: true, message: "No change." });
    }

    const reqDoc = new LedgerReclassificationRequest({
      organizationId: req.user.organizationId,
      companyId,
      ledgerId,
      ledgerName: ledger.name,
      fromGroupId: fromGroup?._id,
      fromGroupName: fromGroup?.name || "",
      fromNature: fromGroup?.nature,
      toGroupId: toGroup._id,
      toGroupName: toGroup.name,
      toNature: toGroup.nature,
      newOrder: newOrder == null ? null : Number(newOrder),
      isCrossCategory,
      status: req.user.permissions.canPostDirectly
        ? "approved"
        : "pending_approval",
      createdBy: req.user.id,
      createdByName: req.user.name || "",
      createdByRole: req.user.role || "",
      notes: notes || "",
    });

    // If the user can post directly, apply now.
    if (req.user.permissions.canPostDirectly) {
      await applyRequest(req, reqDoc);
      reqDoc.appliedAt = new Date();
      reqDoc.reviewedBy = req.user.id;
      reqDoc.reviewedByName = req.user.name || "";
      reqDoc.reviewedAt = new Date();
    }

    await reqDoc.save();
    res.status(201).json({
      success: true,
      request: reqDoc.toObject(),
      applied: !!reqDoc.appliedAt,
    });
  } catch (e) {
    console.error("[ledger-reclass/propose]", e);
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/approve
// ─────────────────────────────────────────────────────────────────────────
router.post("/:id/approve", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    if (!requireCanApprove(req, res)) return;

    const reqDoc = await LedgerReclassificationRequest.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
      status: "pending_approval",
    });
    if (!reqDoc)
      return res
        .status(404)
        .json({ success: false, message: "Pending request not found." });

    // 4-eyes
    if (String(reqDoc.createdBy) === String(req.user.id)) {
      return res.status(403).json({
        success: false,
        message:
          "You can't approve your own reclassification. Ask another approver.",
      });
    }

    try {
      await applyRequest(req, reqDoc);
    } catch (e) {
      console.error("[ledger-reclass/approve→apply]", e);
      return res
        .status(e.status || 500)
        .json({ success: false, message: e.message });
    }

    reqDoc.status = "approved";
    reqDoc.appliedAt = new Date();
    reqDoc.reviewedBy = req.user.id;
    reqDoc.reviewedByName = req.user.name || "";
    reqDoc.reviewedAt = new Date();
    reqDoc.reviewNote = req.body?.note || "";
    await reqDoc.save();
    res.json({ success: true, request: reqDoc.toObject() });
  } catch (e) {
    console.error("[ledger-reclass/approve]", e);
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
    const reqDoc = await LedgerReclassificationRequest.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
      status: "pending_approval",
    });
    if (!reqDoc)
      return res
        .status(404)
        .json({ success: false, message: "Pending request not found." });
    reqDoc.status = "rejected";
    reqDoc.reviewedBy = req.user.id;
    reqDoc.reviewedByName = req.user.name || "";
    reqDoc.reviewedAt = new Date();
    reqDoc.reviewNote = req.body?.note || "";
    await reqDoc.save();
    res.json({ success: true, request: reqDoc.toObject() });
  } catch (e) {
    console.error("[ledger-reclass/reject]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — creator cancels their own pending request
// ─────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    if (!requireOrg(req, res)) return;
    const reqDoc = await LedgerReclassificationRequest.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    });
    if (!reqDoc)
      return res
        .status(404)
        .json({ success: false, message: "Request not found." });
    if (
      String(reqDoc.createdBy) !== String(req.user.id) &&
      !req.user.permissions.canApprove
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only cancel your own requests.",
      });
    }
    if (reqDoc.status !== "pending_approval") {
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be cancelled.",
      });
    }
    reqDoc.status = "void";
    await reqDoc.save();
    res.json({ success: true });
  } catch (e) {
    console.error("[ledger-reclass/cancel]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
