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
    warmLater(String(wo._id), req);
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
/*
 * A BUNDLE IS EXPENSIVE, AND THE DESK WILL NOT WAIT FOR EVER.
 *
 * Capturing a work order means calling this server's own endpoints once per employee and once per size, and the
 * size files come from Google Drive. Done one after another that is minutes for a work order of forty people, and
 * the desk gives every request twenty seconds — so a big order could never arrive: each pull timed out, the work done
 * for it was thrown away, and the next pull started again from nothing.
 *
 * So the captures run several at a time, a size file is fetched once and reused (a Drive file id never changes its
 * content), and every finished bundle is kept until something it was built from changes — the work order, the
 * product, its pattern config or the employees' measurements. A pull that times out still finishes its work here,
 * and the desk's next pull a minute later is answered from that.
 */
const BUNDLES = new Map();     /* woId -> { key, bundle } */
const BUILDING = new Map();    /* woId -> Promise<bundle>, so two pulls never build the same order twice */
const FILES = new Map();       /* svg-content path -> capture; immutable per Drive file id */
const Measurement = require("../../../../models/Customer_Models/Measurement");
const fsLog = require("fs");
const pathLog = require("path");
/* how long each bundle took and what failed in it, for whoever has to find out why a desk is not receiving one */
function outboxLog(line) {
  try { fsLog.appendFileSync(pathLog.join(__dirname, "../../../../cutting-sync-outbox.log"), `${new Date().toISOString()} ${line}
`); } catch { /* logging must never break a sync */ }
}
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");

/** Run `fn` over `items`, at most `n` at a time, keeping order. */
async function inPool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/** What a bundle was built from. Any of these changing makes the kept bundle stale. */
async function bundleKey(wo) {
  const stockItemId = wo.stockItemId || null;
  const [cfg, item, meas] = await Promise.all([
    stockItemId ? PatternGradingConfig.findOne({ stockItemId, isActive: true }).select("updatedAt").lean() : null,
    stockItemId ? StockItem.findById(stockItemId).select("updatedAt").lean() : null,
    wo.customerRequestId ? Measurement.findOne({ poRequestId: wo.customerRequestId }).select("updatedAt").lean() : null,
  ]);
  const t = (d) => (d ? new Date(d).toISOString() : "-");
  return [t(wo.updatedAt), t(wo.sentToCuttingAt), t(cfg?.updatedAt), t(item?.updatedAt), t(meas?.updatedAt)].join("|");
}

async function buildBundle(wo, origin, headers) {
  const woId = String(wo._id);
  const stockItemId = String(wo.stockItemId || "");
  const responses = {};
  let failed = 0;
  const failedPaths = [];
  const grab = async (path) => {
    const r = await capture(origin, path, headers);
    if (!r.status || r.status >= 500) { failed += 1; failedPaths.push(`${path.replace(BASE, "")} -> ${r.status}`); }
    responses[path] = r;
    return r;
  };

  /* What the cutting-master CAD page reads. */
  const em = await grab(`${BASE}/work-orders/${woId}/employee-measurements`);
  await grab(`${BASE}/pattern-grading/work-order/${woId}/employee-sizes`);
  const employees = (em?.body?.employeeMeasurements || []);
  await inPool(employees, 6, (emp) => grab(`${BASE}/pattern-grading/employee/${emp.employeeId}/cad-data?woId=${woId}`));

  /* What the designer page reads for this product. */
  if (stockItemId) {
    await inPool([
      `${BASE}/pattern-grading/stock-items?limit=30`,
      `${BASE}/pattern-grading/stock-items/${stockItemId}`,
      `${BASE}/pattern-grading/stock-item/${stockItemId}/setup-status`,
      `${BASE}/pattern-grading/stock-item/${stockItemId}/size-patterns`,
      `${BASE}/pattern-grading/stock-item/${stockItemId}/size-patterns-with-groups`,
      `${BASE}/pattern-grading/stock-item/${stockItemId}/settings`,
    ], 6, grab);
  }

  /* The pattern SVGs, in case a size has no stored geometry yet; and each size's full record for the designer. */
  const config = stockItemId
    ? await PatternGradingConfig.findOne({ stockItemId, isActive: true }).select("sizePatterns.sizeName sizePatterns.svgPublicId sizePatterns.svgFileUrl").lean()
    : null;
  const sizeJobs = [];
  for (const sp of config?.sizePatterns || []) {
    if (sp.sizeName) sizeJobs.push({ path: `${BASE}/pattern-grading/stock-item/${stockItemId}/size-pattern/${encodeURIComponent(sp.sizeName)}` });
    const fileId = sp.svgPublicId || (sp.svgFileUrl || "").match(/[-\w]{25,}/)?.[0];
    if (fileId) sizeJobs.push({ path: `${BASE}/pattern-grading/svg-content/${fileId}`, file: true });
  }
  await inPool(sizeJobs, 4, async (job) => {
    if (!job.file) return grab(job.path);
    const kept = FILES.get(job.path);
    if (kept && kept.status === 200) { responses[job.path] = kept; return kept; }
    const r = await grab(job.path);
    if (r.status === 200) FILES.set(job.path, r);
    return r;
  });

  /* Which employees are already done, so a fresh desktop does not show them as pending. */
  const done = await EmployeeProductionProgress.find({ workOrderId: wo._id, cutDone: true })
    .select("employeeId cutDoneAt").lean();

  return {
    bundle: {
      workOrder: { ...wo, _id: woId, stockItemId, moId: String(wo.customerRequestId || "") },
      employees: employees.map((e) => ({ employeeId: e.employeeId, employeeName: e.employeeName, employeeUIN: e.employeeUIN, gender: e.gender, quantity: e.quantity })),
      cutDone: done.map((d) => ({ employeeId: String(d.employeeId), cutDoneAt: d.cutDoneAt })),
      responses,
      capturedAt: new Date().toISOString(),
    },
    complete: failed === 0,
    failedPaths,
  };
}

/** The bundle for one work order: kept if nothing it was built from has changed, otherwise built (once). */
async function bundleFor(wo, origin, headers) {
  const woId = String(wo._id);
  const key = await bundleKey(wo);
  const kept = BUNDLES.get(woId);
  /* a bundle with a failed capture in it is kept for ten minutes only, then built again in case it was transient */
  if (kept && kept.key === key && (kept.complete || Date.now() - kept.at < 10 * 60 * 1000)) return kept.bundle;
  if (BUILDING.has(woId)) return BUILDING.get(woId);
  const work = (async () => {
    try {
      const t0 = Date.now();
      const { bundle, complete, failedPaths } = await buildBundle(wo, origin, headers);
      BUNDLES.set(woId, { key, bundle, complete, at: Date.now() });
      while (BUNDLES.size > 60) BUNDLES.delete(BUNDLES.keys().next().value);
      outboxLog(`built ${wo.workOrderNumber || woId} (${bundle.employees.length} employees, ${Object.keys(bundle.responses).length} responses) in ${((Date.now() - t0) / 1000).toFixed(1)}s${complete ? "" : `; failed: ${failedPaths.slice(0, 8).join(", ")}`}`);
      return bundle;
    } finally {
      BUILDING.delete(woId);
    }
  })();
  BUILDING.set(woId, work);
  return work;
}

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
    /* the time is taken BEFORE the bundles are built, so nothing that changes while they build can fall between pulls */
    const serverTime = new Date().toISOString();
    const t0 = Date.now();
    const bundles = await inPool(wos, 2, (wo) => bundleFor(wo, origin, headers));
    outboxLog(`outbox since=${req.query.since || "-"}: ${bundles.length} bundle(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    res.json({ success: true, serverTime, bundles });
  } catch (error) {
    console.error("cutting-sync outbox:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/* Warm the bundles of a work order the moment it is sent, so the desk's first pull finds them ready. */
function warmLater(woId, req) {
  const origin = selfOrigin(req);
  const headers = forwardedAuth(req);
  setTimeout(async () => {
    try {
      const wo = await WorkOrder.findById(woId)
        .select("workOrderNumber stockItemName stockItemReference stockItemId quantity customerRequestId variantAttributes cuttingStatus cuttingProgress sentToCuttingAt updatedAt")
        .lean();
      if (wo?.sentToCutting !== false) await bundleFor(wo, origin, headers);
    } catch (e) { console.warn("cutting-sync warm:", e.message); }
  }, 50);
}

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
