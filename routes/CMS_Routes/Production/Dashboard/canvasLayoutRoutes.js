// routes/CMS_Routes/Production/Dashboard/canvasLayoutRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CanvasLayout = require("../../../../models/CMS_Models/Manufacturing/Production/CanvasLayout");
const CanvasLayoutSnapshot = require("../../../../models/CMS_Models/Manufacturing/Production/CanvasLayoutSnapshot");

// The same omission as productionDashboardRoutes.js next door, and worse: this
// router has a POST and a DELETE. The productionSupervisorWrites guard on the
// mount passes an anonymous caller straight through on purpose — its comment
// says "let the router's own auth middleware refuse it" — and this router had
// none, so the factory's machine layout could be rewritten or deleted with no
// session.
//
// Authentication only. The layout belongs to the Production Supervisor's floor
// and the department guard on the mount already decides who may write it.
router.use(EmployeeAuthMiddleware);

/* ─── Why every write is archived ─────────────────────────────────────────────
 * On 11 Sep 2026 the Reset button ran the hard `deleteOne` that used to live at
 * the bottom of this file, and version 31 of the floor plan — 78 machine
 * positions placed by hand — was gone. No Atlas backup on this tier, no
 * soft-delete, nothing in the browser to recover. The plan had to be rebuilt.
 *
 * So: the previous state is snapshotted before every save and before every
 * reset, Reset no longer deletes anything, and there is an endpoint to put a
 * revision back. The cost is one extra insert on a save that happens a few
 * times a day.
 */
const KEEP_SNAPSHOTS = 40;

async function archive(layout, reason, takenBy) {
  if (!layout) return null;
  const plain = layout.toObject ? layout.toObject() : layout;
  const { _id, ...payload } = plain;

  const snap = await CanvasLayoutSnapshot.create({
    organizationId: plain.organizationId || "default",
    version: plain.version || 0,
    reason,
    takenBy: takenBy || "",
    payload,
    counts: {
      machinePositions: (plain.machinePositions || []).length,
      separators: (plain.separators || []).length,
      chamberTemplates: (plain.chamberTemplates || []).length,
      walls: (plain.walls || []).length,
      aisles: (plain.aisles || []).length,
      fixtures: (plain.fixtures || []).length,
    },
  });

  /* Trim the tail, but never the 10 newest and never a `reset` snapshot — a
     reset is the one a supervisor comes looking for, and it is also the one
     that a flurry of ordinary saves afterwards would otherwise push out. */
  const stale = await CanvasLayoutSnapshot.find({
    organizationId: plain.organizationId || "default",
    reason: { $ne: "reset" },
  })
    .sort({ createdAt: -1 })
    .skip(KEEP_SNAPSHOTS)
    .select("_id")
    .lean();
  if (stale.length) {
    await CanvasLayoutSnapshot.deleteMany({ _id: { $in: stale.map((s) => s._id) } });
  }
  return snap;
}

const actorOf = (req) =>
  req.user?.name ||
  req.user?.email ||
  req.employee?.identityId ||
  req.employee?._id?.toString() ||
  "unknown";

/**
 * GET /api/cms/production/canvas-layout
 * Fetch saved canvas layout
 */
router.get("/", async (req, res) => {
  try {
    const { orgId = "default" } = req.query;

    const layout = await CanvasLayout.findOne({ organizationId: orgId }).lean();

    if (!layout) {
      return res.json({
        success: true,
        layout: null,
        message: "No saved layout found — use defaults",
      });
    }

    res.json({ success: true, layout });
  } catch (error) {
    console.error("Error fetching canvas layout:", error);
    res.status(500).json({
      success: false,
      message: "Server error fetching layout",
      error: error.message,
    });
  }
});

/**
 * GET /api/cms/production/canvas-layout/history
 * The revisions available to restore, newest first. Payloads are omitted —
 * the list renders from `counts`, and a payload is only read when one is
 * actually restored.
 */
router.get("/history", async (req, res) => {
  try {
    const { orgId = "default" } = req.query;
    const snapshots = await CanvasLayoutSnapshot.find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .limit(60)
      .select("-payload")
      .lean();
    res.json({ success: true, snapshots });
  } catch (error) {
    console.error("Error fetching layout history:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/cms/production/canvas-layout/restore/:snapshotId
 * Put a revision back. The CURRENT state is archived first, so restoring is
 * itself undoable — otherwise the fix for a mistake is another mistake.
 */
router.post("/restore/:snapshotId", async (req, res) => {
  try {
    const snap = await CanvasLayoutSnapshot.findById(req.params.snapshotId).lean();
    if (!snap) {
      return res.status(404).json({ success: false, message: "That revision no longer exists." });
    }

    const orgId = snap.organizationId || "default";
    const current = await CanvasLayout.findOne({ organizationId: orgId });
    await archive(current, "restore", actorOf(req));

    const nextVersion = (current?.version || 0) + 1;
    const { version, _id, createdAt, updatedAt, __v, ...body } = snap.payload || {};

    const layout = await CanvasLayout.findOneAndUpdate(
      { organizationId: orgId },
      {
        $set: {
          ...body,
          organizationId: orgId,
          version: nextVersion,
          lastUpdatedBy: actorOf(req),
        },
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      layout,
      message: `Restored the revision saved ${new Date(snap.createdAt).toLocaleString()}.`,
    });
  } catch (error) {
    console.error("Error restoring canvas layout:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/cms/production/canvas-layout
 * Save / update canvas layout
 */
router.post("/", async (req, res) => {
  try {
    const {
      machinePositions,
      separators,
      chamberTemplates,
      canvasState,
      // ── Added 11 Sep 2026 with the CAD floor designer ────────────────────
      // The room itself: walls, walkways, fixtures and the grid settings.
      walls,
      aisles,
      fixtures,
      floor,
      orgId = "default",
    } = req.body;

    const employeeId = actorOf(req);

    const existing = await CanvasLayout.findOne({ organizationId: orgId });

    if (existing) {
      // Keep what is about to be overwritten.
      await archive(existing, "save", employeeId);

      /* `undefined` means "leave it alone", and that is load-bearing rather
         than merely convenient: the tracker's Assign-Operations panel saves a
         layout without ever touching walls or fixtures, and a plain assignment
         must not wipe the room a supervisor drew. An EMPTY ARRAY is still a
         real instruction ("I deleted every wall"), which is why the test is
         against undefined and not against falsiness. */
      const keep = (next, current) => (next === undefined ? current : next);

      existing.machinePositions = keep(machinePositions, existing.machinePositions);
      existing.separators = keep(separators, existing.separators);
      existing.chamberTemplates = keep(chamberTemplates, existing.chamberTemplates);
      existing.canvasState = keep(canvasState, existing.canvasState);
      existing.walls = keep(walls, existing.walls);
      existing.aisles = keep(aisles, existing.aisles);
      existing.fixtures = keep(fixtures, existing.fixtures);
      if (floor !== undefined) {
        // Merged, not replaced — the client may send only the grid size.
        existing.floor = { ...(existing.floor?.toObject?.() ?? existing.floor ?? {}), ...floor };
      }
      existing.lastUpdatedBy = employeeId;
      existing.version = (existing.version || 1) + 1;
      await existing.save();

      return res.json({ success: true, layout: existing, message: "Layout saved successfully" });
    }

    const newLayout = new CanvasLayout({
      organizationId: orgId,
      machinePositions: machinePositions || [],
      separators: separators || [],
      chamberTemplates: chamberTemplates || [],
      canvasState: canvasState || { zoom: 1, panX: 0, panY: 0 },
      walls: walls || [],
      aisles: aisles || [],
      fixtures: fixtures || [],
      ...(floor ? { floor } : {}),
      lastUpdatedBy: employeeId,
    });

    await newLayout.save();

    res.json({ success: true, layout: newLayout, message: "Layout created successfully" });
  } catch (error) {
    console.error("Error saving canvas layout:", error);
    res.status(500).json({
      success: false,
      message: "Server error saving layout",
      error: error.message,
    });
  }
});

/**
 * DELETE /api/cms/production/canvas-layout
 * Clear the layout — ARCHIVED, not destroyed.
 *
 * This used to be `deleteOne`, and on 11 Sep 2026 it took a floor plan of 78
 * hand-placed machines with it. It now snapshots first and empties the document
 * in place, so the response can tell the caller exactly how to undo it.
 */
router.delete("/", async (req, res) => {
  try {
    const { orgId = "default" } = req.query;
    const existing = await CanvasLayout.findOne({ organizationId: orgId });

    if (!existing) {
      return res.json({ success: true, message: "There was no layout to clear.", snapshotId: null });
    }

    const snap = await archive(existing, "reset", actorOf(req));

    existing.machinePositions = [];
    existing.separators = [];
    existing.chamberTemplates = [];
    existing.walls = [];
    existing.aisles = [];
    existing.fixtures = [];
    existing.lastUpdatedBy = actorOf(req);
    existing.version = (existing.version || 1) + 1;
    await existing.save();

    res.json({
      success: true,
      message: "Layout cleared. The previous version was kept and can be restored.",
      snapshotId: snap?._id || null,
      restoredFromVersion: snap?.version ?? null,
    });
  } catch (error) {
    console.error("Error clearing canvas layout:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
