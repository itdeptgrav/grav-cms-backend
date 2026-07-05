// routes/CMS_Routes/Store/workerWorkOrderRoutes.js
//
// Mount in server.js:
//   const workerWorkOrderRoutes = require("./routes/CMS_Routes/Store/workerWorkOrderRoutes");
//   app.use("/api/cms/store/work-orders-worker", workerWorkOrderRoutes);
//
// Endpoints (all under /api/cms/store/work-orders-worker):
//   GET    /                      — list all WOs (+ stats)
//   GET    /next-number           — peek the next auto WO number (no consume)
//   GET    /settings              — get global prefix/suffix/padding
//   PUT    /settings              — update global prefix/suffix/padding
//   GET    /worker-suggestions    — distinct worker names (for autocomplete)
//   GET    /:id                   — single WO
//   POST   /                      — create WO (consumes counter if no number)
//   PUT    /:id                   — update WO
//   PATCH  /:id/status            — change status (Draft → Issued → Completed)
//   DELETE /:id                   — delete WO

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const WorkerWorkOrder = require("../../../models/CMS_Models/Store/WorkerWorkOrder");
const WorkOrderSettings = require("../../../models/CMS_Models/Store/WorkOrderSettings");

router.use(EmployeeAuthMiddleware);

const ALLOWED_STATUSES = ["Draft", "Issued", "Completed"];

// ── helper: consume the next number atomically ────────────────────────────
async function consumeNextNumber() {
  const s = await WorkOrderSettings.getSettings();
  s.counter = (s.counter || 0) + 1;
  await s.save();
  const padded = String(s.counter).padStart(s.padding || 0, "0");
  return `${s.prefix}${padded}${s.suffix}`;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST + stats
// ═══════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { status, search } = req.query;
    const filter = {};
    if (status && ALLOWED_STATUSES.includes(status)) filter.status = status;
    if (search) {
      filter.$or = [
        { workOrderNumber: { $regex: search, $options: "i" } },
        { workerName: { $regex: search, $options: "i" } },
      ];
    }

    const workOrders = await WorkerWorkOrder.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const stats = {
      total: workOrders.length,
      draft: workOrders.filter((w) => w.status === "Draft").length,
      issued: workOrders.filter((w) => w.status === "Issued").length,
      completed: workOrders.filter((w) => w.status === "Completed").length,
    };

    return res.json({ success: true, workOrders, stats });
  } catch (err) {
    console.error("WorkerWO list error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PEEK next number (does NOT consume)
// ═══════════════════════════════════════════════════════════════════════
router.get("/next-number", async (req, res) => {
  try {
    const nextNumber = await WorkOrderSettings.peekNextNumber();
    return res.json({ success: true, nextNumber });
  } catch (err) {
    console.error("WorkerWO next-number error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS — global prefix / suffix / padding
// ═══════════════════════════════════════════════════════════════════════
router.get("/settings", async (req, res) => {
  try {
    const s = await WorkOrderSettings.getSettings();
    return res.json({
      success: true,
      settings: {
        prefix: s.prefix,
        suffix: s.suffix,
        padding: s.padding,
        counter: s.counter,
      },
    });
  } catch (err) {
    console.error("WorkerWO get-settings error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const { prefix, suffix, padding } = req.body || {};
    const s = await WorkOrderSettings.getSettings();
    if (prefix !== undefined) s.prefix = String(prefix);
    if (suffix !== undefined) s.suffix = String(suffix);
    if (padding !== undefined) s.padding = Number(padding) || 0;
    await s.save();
    return res.json({
      success: true,
      message: "Work order numbering settings updated",
      settings: {
        prefix: s.prefix,
        suffix: s.suffix,
        padding: s.padding,
        counter: s.counter,
      },
    });
  } catch (err) {
    console.error("WorkerWO put-settings error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// WORKER NAME SUGGESTIONS (distinct names, optionally filtered by query)
// ═══════════════════════════════════════════════════════════════════════
router.get("/worker-suggestions", async (req, res) => {
  try {
    const { q } = req.query;
    const match = { workerName: { $nin: [null, ""] } };
    if (q) match.workerName = { $regex: q, $options: "i" };

    // distinct names with their last-known phone/address for convenience
    const docs = await WorkerWorkOrder.find(match)
      .select("workerName workerPhone workerAddress workerGstin")
      .sort({ updatedAt: -1 })
      .lean();

    const seen = new Set();
    const suggestions = [];
    for (const d of docs) {
      const key = d.workerName.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        name: d.workerName,
        phone: d.workerPhone || "",
        address: d.workerAddress || "",
        gstin: d.workerGstin || "",
      });
    }

    return res.json({ success: true, suggestions });
  } catch (err) {
    console.error("WorkerWO suggestions error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SINGLE WO
// ═══════════════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    const wo = await WorkerWorkOrder.findById(req.params.id).lean();
    if (!wo)
      return res
        .status(404)
        .json({ success: false, message: "Work order not found" });
    return res.json({ success: true, workOrder: wo });
  } catch (err) {
    console.error("WorkerWO get error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    // If the client didn't supply a number, auto-generate + consume counter.
    let workOrderNumber = (body.workOrderNumber || "").trim();
    if (!workOrderNumber) {
      workOrderNumber = await consumeNextNumber();
    } else {
      // user supplied/edited a number — make sure it's unique
      const clash = await WorkerWorkOrder.findOne({ workOrderNumber });
      if (clash) {
        return res.status(409).json({
          success: false,
          message: `Work order number "${workOrderNumber}" already exists`,
        });
      }
    }

    const wo = new WorkerWorkOrder({
      workOrderNumber,
      workerName: body.workerName || "",
      workerPhone: body.workerPhone || "",
      workerAddress: body.workerAddress || "",
      workerGstin: body.workerGstin || "",
      workerNotes: body.workerNotes || "",
      lineSectionLabel: body.lineSectionLabel || "Items",
      workArea: body.workArea || "",
      workAreaSize: Number(body.workAreaSize) || 0,
      workAreaUnit: body.workAreaUnit || "sq ft",
      items: Array.isArray(body.items) ? body.items : [],
      customHeaderFields: Array.isArray(body.customHeaderFields)
        ? body.customHeaderFields
        : [],
      status: ALLOWED_STATUSES.includes(body.status) ? body.status : "Draft",
      priority: ["Emergency", "Urgent", "Neutral"].includes(body.priority)
        ? body.priority
        : "Neutral",
      issueDate: body.issueDate || null,
      dueDate: body.dueDate || null,
      createdBy: req.user?.id || null,
    });

    await wo.save();
    return res.status(201).json({
      success: true,
      message: "Work order created",
      workOrder: wo,
    });
  } catch (err) {
    console.error("WorkerWO create error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════
router.put("/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const wo = await WorkerWorkOrder.findById(req.params.id);
    if (!wo)
      return res
        .status(404)
        .json({ success: false, message: "Work order not found" });

    if (body.workOrderNumber !== undefined) {
      const newNum = String(body.workOrderNumber).trim();
      if (newNum && newNum !== wo.workOrderNumber) {
        const clash = await WorkerWorkOrder.findOne({
          workOrderNumber: newNum,
          _id: { $ne: wo._id },
        });
        if (clash) {
          return res.status(409).json({
            success: false,
            message: `Work order number "${newNum}" already exists`,
          });
        }
        wo.workOrderNumber = newNum;
      }
    }

    if (body.workerName !== undefined) wo.workerName = body.workerName;
    if (body.workerPhone !== undefined) wo.workerPhone = body.workerPhone;
    if (body.workerAddress !== undefined) wo.workerAddress = body.workerAddress;
    if (body.workerGstin !== undefined) wo.workerGstin = body.workerGstin;
    if (body.workerNotes !== undefined) wo.workerNotes = body.workerNotes;
    if (body.lineSectionLabel !== undefined)
      wo.lineSectionLabel = body.lineSectionLabel || "Items";
    if (body.workArea !== undefined) wo.workArea = body.workArea;
    if (body.workAreaSize !== undefined)
      wo.workAreaSize = Number(body.workAreaSize) || 0;
    if (body.workAreaUnit !== undefined) wo.workAreaUnit = body.workAreaUnit;
    if (body.items !== undefined)
      wo.items = Array.isArray(body.items) ? body.items : [];
    if (body.customHeaderFields !== undefined)
      wo.customHeaderFields = Array.isArray(body.customHeaderFields)
        ? body.customHeaderFields
        : [];
    if (body.status && ALLOWED_STATUSES.includes(body.status))
      wo.status = body.status;
    if (
      body.priority &&
      ["Emergency", "Urgent", "Neutral"].includes(body.priority)
    )
      wo.priority = body.priority;
    if (body.issueDate !== undefined) wo.issueDate = body.issueDate || null;
    if (body.dueDate !== undefined) wo.dueDate = body.dueDate || null;
    wo.updatedBy = req.user?.id || null;

    await wo.save();
    return res.json({
      success: true,
      message: "Work order updated",
      workOrder: wo,
    });
  } catch (err) {
    console.error("WorkerWO update error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CHANGE STATUS  (Draft → Issued → Completed)
// ═══════════════════════════════════════════════════════════════════════
router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}`,
      });
    }

    const wo = await WorkerWorkOrder.findById(req.params.id);
    if (!wo)
      return res
        .status(404)
        .json({ success: false, message: "Work order not found" });

    wo.status = status;
    if (status === "Issued" && !wo.issueDate) wo.issueDate = new Date();
    wo.updatedBy = req.user?.id || null;
    await wo.save();

    return res.json({
      success: true,
      message: `Status updated to ${status}`,
      workOrder: wo,
    });
  } catch (err) {
    console.error("WorkerWO status error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  try {
    const wo = await WorkerWorkOrder.findByIdAndDelete(req.params.id);
    if (!wo)
      return res
        .status(404)
        .json({ success: false, message: "Work order not found" });
    return res.json({ success: true, message: "Work order deleted" });
  } catch (err) {
    console.error("WorkerWO delete error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
