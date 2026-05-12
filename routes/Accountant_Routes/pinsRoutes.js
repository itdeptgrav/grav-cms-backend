// routes/Accountant_Routes/pinsRoutes.js
//
// PIN-TO-TOP API.
//
// One generic route file that every list page uses to read/write pins.
// Pins are PER-USER — my pins follow me to every device. The same data
// model handles every entity type ("payable", "ledger", "vendor", ...).
//
// Endpoints:
//   GET    /api/accountant/pins?entityType=payable
//          → list this user's pins for one entity type, sorted by
//            pinnedAt DESC (most recently pinned first).
//
//   POST   /api/accountant/pins
//          body: { entityType, entityId, label? }
//          → idempotent upsert. If the user already pinned this
//            entity, refresh pinnedAt + label (bumping it to the top).
//
//   DELETE /api/accountant/pins/:entityType/:entityId
//          → unpin.
//
//   POST   /api/accountant/pins/reorder
//          body: { entityType, orderedIds: [entityId, entityId, ...] }
//          → re-order pins (optional power feature; pinnedAt is
//            rewritten so orderedIds[0] is freshest)
//
// Read paths return the raw pin documents — the calling page is
// expected to splice them on top of its own data (since the page knows
// how to render its rows).

const express = require("express");
const router = express.Router();
const PinnedItem = require("../../models/Accountant_model/PinnedItem");
const { orgAuth } = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

function currentUserId(req) {
  // Both new-system and legacy users have a stable id we can pin against.
  return req.user?.id;
}

// Reject pin/unpin attempts for legacy/dev sessions — pins are per-user
// and require a real AccountantUser._id to belong to.
function requireRealUser(req, res) {
  if (req.user?.isDev || req.user?.isLegacy) {
    res.status(400).json({
      success: false,
      message:
        "Pins require a full sub-account session. Sign in via main CMS to auto-promote, or use /accountant/login.",
    });
    return false;
  }
  if (!currentUserId(req)) {
    res.status(401).json({ success: false, message: "No user context" });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// GET / — list pins for one entity type
// ─────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, limit = 200 } = req.query;
    if (!entityType) {
      return res
        .status(400)
        .json({ success: false, message: "entityType is required" });
    }
    const pins = await PinnedItem.find({
      userId: currentUserId(req),
      entityType,
    })
      .sort({ pinnedAt: -1 })
      .limit(Math.min(Number(limit) || 200, 500))
      .lean();
    res.json({ success: true, pins });
  } catch (e) {
    console.error("[pins/list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — pin (idempotent upsert)
// ─────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, entityId, label } = req.body || {};
    if (!entityType || !entityId) {
      return res.status(400).json({
        success: false,
        message: "entityType and entityId are required",
      });
    }
    const trimmedId = String(entityId).trim();
    if (!trimmedId) {
      return res
        .status(400)
        .json({ success: false, message: "entityId cannot be empty" });
    }

    // Upsert — refresh pinnedAt to bump to top, update label if provided
    const update = {
      $set: {
        pinnedAt: new Date(),
        ...(label !== undefined ? { label: String(label).slice(0, 200) } : {}),
        ...(req.user.organizationId
          ? { organizationId: req.user.organizationId }
          : {}),
      },
    };
    const pin = await PinnedItem.findOneAndUpdate(
      {
        userId: currentUserId(req),
        entityType: String(entityType),
        entityId: trimmedId,
      },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.status(201).json({ success: true, pin });
  } catch (e) {
    // Duplicate-key race condition fallback: another concurrent pin
    // attempt created the row first. Re-read and return it.
    if (e?.code === 11000) {
      try {
        const existing = await PinnedItem.findOne({
          userId: currentUserId(req),
          entityType: req.body?.entityType,
          entityId: String(req.body?.entityId).trim(),
        });
        return res.status(200).json({ success: true, pin: existing });
      } catch (e2) {
        console.error("[pins/upsert] race-recovery failed:", e2);
      }
    }
    console.error("[pins/upsert]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:entityType/:entityId — unpin
// ─────────────────────────────────────────────────────────────────────────
router.delete("/:entityType/:entityId", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, entityId } = req.params;
    const out = await PinnedItem.deleteOne({
      userId: currentUserId(req),
      entityType,
      entityId,
    });
    res.json({ success: true, deleted: out.deletedCount > 0 });
  } catch (e) {
    console.error("[pins/delete]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /reorder — rewrite pinnedAt across multiple pins
// ─────────────────────────────────────────────────────────────────────────
// Useful when the user drags pinned rows ABOUT each other (not the
// initial pin action — that's POST /). orderedIds[0] becomes freshest.
router.post("/reorder", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, orderedIds } = req.body || {};
    if (!entityType || !Array.isArray(orderedIds)) {
      return res.status(400).json({
        success: false,
        message: "entityType and orderedIds[] are required",
      });
    }
    // Stamp descending timestamps a few ms apart so DESC sort matches the
    // intended order. Done as a bulkWrite for atomic/fast updates.
    const now = Date.now();
    const ops = orderedIds.map((entityId, i) => ({
      updateOne: {
        filter: {
          userId: currentUserId(req),
          entityType,
          entityId: String(entityId),
        },
        update: { $set: { pinnedAt: new Date(now - i) } },
      },
    }));
    if (ops.length === 0) return res.json({ success: true, modified: 0 });
    const result = await PinnedItem.bulkWrite(ops);
    res.json({ success: true, modified: result.modifiedCount });
  } catch (e) {
    console.error("[pins/reorder]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
