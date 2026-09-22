/**
 * CUTTING SYNC — what the offline cutting desktop pulls, and what it pushes back
 * ============================================================================
 * The desktop (grav-cad-desktop) runs the CAD pages unchanged, against a local
 * copy of the answers this server would have given. So the bundle for a work
 * order is not a new data shape: it is the EXACT responses of the endpoints the
 * pages call, captured here by calling them, keyed by their path. The desktop
 * replays them by path. Any future change to those endpoints is carried
 * automatically; nothing here has to be kept in step by hand.
 *
 *   POST /work-orders/:woId/send-to-cutting   the web marks a WO for the desktop
 *   GET  /cutting-sync/outbox?since=<iso>      bundles for every WO sent since then
 *   POST /cutting-sync/inbox                   { items: [{ woId, employeeId, cutDoneAt }] }
 *
 * The only thing that flows back is "this employee's cutting is done" (decided
 * 2026-09-19). It is written once per employee and counted once into the work
 * order's cutting progress, so a desktop that re-sends after a lost reply
 * cannot double-count.
 *
 * Every route here sits behind the same employee session as the rest of the
 * cutting-master API; the desktop signs in once and reuses the token. The
 * capture calls below forward that same token, so the bundle holds exactly
 * what this signed-in cutting master would have been shown.
 */
const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
/* The desk's handshake (shared key -> desk token) lives in
   routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingDeskHandshake.js,
   mounted at /api/cutting-desk ABOVE the /api/cms auth gate in server.js. */

/* Same gate as every other cutting-master route; the desk's handshake token
   passes it like a login token would. */
router.use(EmployeeAuthMiddleware);
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const PatternGradingConfig = require("../../../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");

const BASE = "/api/cms/manufacturing/cutting-master";

function forwardedAuth(req) {
  const h = {};
  if (req.get("authorization")) h.authorization = req.get("authorization");
  if (req.get("cookie")) h.cookie = req.get("cookie");
  return h;
}

/** This server's own address, for capturing its own responses. */
function selfOrigin(req) {
  const port = process.env.PORT || 5000;
  return process.env.CUTTING_SYNC_SELF_ORIGIN || `http://127.0.0.1:${port}`;
}

/** GET one of our own endpoints exactly as a page would; returns { status, body, contentType }. */
async function capture(origin, path, headers) {
  try {
    const r = await fetch(origin + path, { headers });
    const contentType = r.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await r.json() : await r.text();
    return { status: r.status, contentType, body };
  } catch (e) {
    return { status: 0, contentType: "", body: null, error: e.message };
  }
}

// ── mark a work order for the desktop ────────────────────────────────────────
router.post("/work-orders/:woId/send-to-cutting", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.woId);
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    wo.sentToCutting = true;
    wo.sentToCuttingAt = new Date();
    await wo.save();
    res.json({ success: true, sentToCuttingAt: wo.sentToCuttingAt });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/work-orders/:woId/recall-from-cutting", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.woId);
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });
    wo.sentToCutting = false;
    await wo.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── outbox: bundles for the desktop ──────────────────────────────────────────
router.get("/cutting-sync/outbox", async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : null;
    const filter = { sentToCutting: true };
    if (since && !Number.isNaN(since.getTime())) {
      filter.$or = [{ sentToCuttingAt: { $gt: since } }, { updatedAt: { $gt: since } }];
    }
    const wos = await WorkOrder.find(filter)
      .select("workOrderNumber stockItemName stockItemReference stockItemId quantity customerRequestId variantAttributes cuttingStatus cuttingProgress sentToCuttingAt updatedAt")
      .sort({ sentToCuttingAt: -1 })
      .lean();

    const origin = selfOrigin(req);
    const headers = forwardedAuth(req);
    const bundles = [];

    for (const wo of wos) {
      const woId = String(wo._id);
      const stockItemId = String(wo.stockItemId || "");
      const responses = {};
      const grab = async (path) => { responses[path] = await capture(origin, path, headers); return responses[path]; };

      /* What the cutting-master CAD page reads. */
      const em = await grab(`${BASE}/work-orders/${woId}/employee-measurements`);
      await grab(`${BASE}/pattern-grading/work-order/${woId}/employee-sizes`);
      const employees = (em?.body?.employeeMeasurements || []);
      for (const emp of employees) {
        await grab(`${BASE}/pattern-grading/employee/${emp.employeeId}/cad-data?woId=${woId}`);
      }

      /* What the designer page reads for this product. */
      if (stockItemId) {
        await grab(`${BASE}/pattern-grading/stock-items?limit=30`);
        await grab(`${BASE}/pattern-grading/stock-items/${stockItemId}`);
        await grab(`${BASE}/pattern-grading/stock-item/${stockItemId}/setup-status`);
        await grab(`${BASE}/pattern-grading/stock-item/${stockItemId}/size-patterns`);
        await grab(`${BASE}/pattern-grading/stock-item/${stockItemId}/size-patterns-with-groups`);
        await grab(`${BASE}/pattern-grading/stock-item/${stockItemId}/settings`);
      }

      /* The pattern SVGs, in case a size has no stored geometry yet. */
      const config = stockItemId
        ? await PatternGradingConfig.findOne({ stockItemId, isActive: true }).select("sizePatterns.sizeName sizePatterns.svgPublicId sizePatterns.svgFileUrl").lean()
        : null;
      for (const sp of config?.sizePatterns || []) {
        /* the designer opens a size with its full record (paths, groups, connectors) */
        if (sp.sizeName) await grab(`${BASE}/pattern-grading/stock-item/${stockItemId}/size-pattern/${encodeURIComponent(sp.sizeName)}`);
        const fileId = sp.svgPublicId || (sp.svgFileUrl || "").match(/[-\w]{25,}/)?.[0];
        if (fileId) await grab(`${BASE}/pattern-grading/svg-content/${fileId}`);
      }

      /* Which employees are already done, so a fresh desktop does not show them as pending. */
      const done = await EmployeeProductionProgress.find({ workOrderId: wo._id, cutDone: true })
        .select("employeeId cutDoneAt").lean();

      bundles.push({
        workOrder: { ...wo, _id: woId, stockItemId, moId: String(wo.customerRequestId || "") },
        employees: employees.map((e) => ({ employeeId: e.employeeId, employeeName: e.employeeName, employeeUIN: e.employeeUIN, gender: e.gender, quantity: e.quantity })),
        cutDone: done.map((d) => ({ employeeId: String(d.employeeId), cutDoneAt: d.cutDoneAt })),
        responses,
        capturedAt: new Date().toISOString(),
      });
    }

    res.json({ success: true, serverTime: new Date().toISOString(), bundles });
  } catch (error) {
    console.error("cutting-sync outbox:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── inbox: "cutting done" per employee ───────────────────────────────────────
router.post("/cutting-sync/inbox", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const acks = [];
    for (const it of items) {
      const { woId, employeeId, cutDoneAt, deviceId } = it || {};
      if (!woId || !employeeId) { acks.push({ woId, employeeId, ok: false, reason: "woId and employeeId required" }); continue; }
      const progress = await EmployeeProductionProgress.findOne({ workOrderId: woId, employeeId });
      if (!progress) { acks.push({ woId, employeeId, ok: false, reason: "no production progress row" }); continue; }
      if (progress.cutDone) { acks.push({ woId, employeeId, ok: true, already: true }); continue; }

      progress.cutDone = true;
      progress.cutDoneAt = cutDoneAt ? new Date(cutDoneAt) : new Date();
      progress.cutDoneBy = deviceId || "cutting-desktop";
      await progress.save();

      /* Count this employee's units into the work order's cutting progress, once. */
      const wo = await WorkOrder.findById(woId);
      if (wo) {
        if (!wo.cuttingProgress) wo.cuttingProgress = { completed: 0, remaining: wo.quantity || 0 };
        const units = Number(progress.totalUnits) || 0;
        const completed = Math.min((wo.cuttingProgress.completed || 0) + units, wo.quantity || 0);
        wo.cuttingProgress.completed = completed;
        wo.cuttingProgress.remaining = Math.max((wo.quantity || 0) - completed, 0);
        wo.cuttingStatus = completed >= (wo.quantity || 0) ? "completed" : completed > 0 ? "in_progress" : "pending";
        await wo.save();
      }
      acks.push({ woId, employeeId, ok: true });
    }
    res.json({ success: true, acks, serverTime: new Date().toISOString() });
  } catch (error) {
    console.error("cutting-sync inbox:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
