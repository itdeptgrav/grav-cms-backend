// routes/Accountant_Routes/Acc_priorities.js
//
// API for per-user row priorities (manual sort within a bucket).
//
// Endpoints (all per-user via orgAuth):
//
//   GET  /api/accountant/priorities?entityType=payable
//        → list this user's priorities for one entity type, sorted by
//          rank ASC. UI applies them per-bucket.
//
//   PUT  /api/accountant/priorities
//        body: { entityType, items: [ { entityId, rank, bucket? }, ... ] }
//        → bulk upsert. Replaces ranks for the listed entityIds atomically
//          (within best-effort bulkWrite). Use this when reordering.
//
//   DELETE /api/accountant/priorities/:entityType/:entityId
//        → clear one row's priority (row falls back to natural bucket order)
//
//   DELETE /api/accountant/priorities/:entityType
//        → clear ALL priorities for this entityType (reset to defaults)
//
// Why bulk PUT? Because dragging a row in a list often needs to:
//   - give the dragged row a new rank
//   - sometimes also shift one neighbor (when ranks collide / are full)
// A single round trip keeps the UI snappy.

const express = require("express");
const router = express.Router();
const Acc_RowPriority = require("../../models/Accountant_model/Acc_RowPriority");
const { orgAuth } = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

function userId(req) {
  return req.user?.id;
}

function requireRealUser(req, res) {
  if (req.user?.isDev || req.user?.isLegacy) {
    res.status(400).json({
      success: false,
      message: "Priorities require a full sub-account session.",
    });
    return false;
  }
  if (!userId(req)) {
    res.status(401).json({ success: false, message: "No user context" });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /?entityType=payable — list priorities for one entity type
// ─────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, limit = 1000 } = req.query;
    if (!entityType) {
      return res
        .status(400)
        .json({ success: false, message: "entityType is required" });
    }
    const items = await Acc_RowPriority.find({ userId: userId(req), entityType })
      .sort({ rank: 1 })
      .limit(Math.min(Number(limit) || 1000, 5000))
      .lean();
    res.json({ success: true, items });
  } catch (e) {
    console.error("[priorities/list]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT / — bulk upsert priorities
// ─────────────────────────────────────────────────────────────────────────
router.put("/", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, items } = req.body || {};
    if (!entityType || !Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: "entityType and items[] are required",
      });
    }
    // Defensive cleaning + dedupe by entityId (last write wins).
    const seen = new Map();
    for (const it of items) {
      if (!it || typeof it.entityId !== "string") continue;
      const eid = it.entityId.trim();
      if (!eid) continue;
      seen.set(eid, {
        entityId: eid,
        rank: Number.isFinite(Number(it.rank)) ? Number(it.rank) : 0,
        bucket: typeof it.bucket === "string" ? it.bucket.trim() : "",
      });
    }
    const cleaned = Array.from(seen.values());
    if (cleaned.length === 0) {
      return res.json({ success: true, modified: 0 });
    }

    const ops = cleaned.map((it) => ({
      updateOne: {
        filter: {
          userId: userId(req),
          entityType,
          entityId: it.entityId,
        },
        update: {
          $set: {
            rank: it.rank,
            bucket: it.bucket,
            ...(req.user.organizationId
              ? { organizationId: req.user.organizationId }
              : {}),
          },
        },
        upsert: true,
      },
    }));

    const result = await Acc_RowPriority.bulkWrite(ops, { ordered: false });
    res.json({
      success: true,
      upserted: result.upsertedCount || 0,
      modified: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
    });
  } catch (e) {
    console.error("[priorities/upsert]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:entityType/:entityId — clear one row's priority
// ─────────────────────────────────────────────────────────────────────────
router.delete("/:entityType/:entityId", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const { entityType, entityId } = req.params;
    const out = await Acc_RowPriority.deleteOne({
      userId: userId(req),
      entityType,
      entityId,
    });
    res.json({ success: true, deleted: out.deletedCount > 0 });
  } catch (e) {
    console.error("[priorities/delete]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:entityType — clear ALL priorities for an entity type
// ─────────────────────────────────────────────────────────────────────────
router.delete("/:entityType", async (req, res) => {
  try {
    if (!requireRealUser(req, res)) return;
    const out = await Acc_RowPriority.deleteMany({
      userId: userId(req),
      entityType: req.params.entityType,
    });
    res.json({ success: true, deleted: out.deletedCount });
  } catch (e) {
    console.error("[priorities/clear]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
