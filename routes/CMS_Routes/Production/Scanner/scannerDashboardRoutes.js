// routes/CMS_Routes/Production/Scanner/scannerDashboardRoutes.js
//
// Mounted at /api/cms/production/dashboard, ALONGSIDE productionDashboardRoutes
// and after it. These are the two endpoints the CMS's own dashboard router
// never had — they were written for the standalone barcode server and read the
// scan event stream, which the CMS did not hold until that server was merged in
// (11 Sep 2026).
//
//   GET /work-orders            what is being made today, per work order,
//                               with units completed against order quantity
//   GET /operator/:operatorId   one operator's shift: pieces per hour, pace
//                               against standard time, and a scan timeline
//
// Deliberately a separate file rather than 200 more lines in
// productionDashboardRoutes.js: everything here derives from productionevents,
// everything there walks ProductionTracking subdocuments, and the two answer
// different questions from different collections.
//
// Express matches mounts in registration order and this is mounted second, so
// nothing here can shadow an endpoint of the same name over there. That is why
// the barcode server's /dashboard/machine-status did NOT come across to this
// file — the CMS already has one at that path with an entirely different
// response shape (machine scheduling, not live rollup). Its rollup version
// lives at /api/cms/production/supervisor/machine-status instead.

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);

const S = "../../../../services/barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const masterData = require(`${S}/masterData`);

// Same reasoning as productionDashboardRoutes: authentication, not a
// department gate. Both the supervisor and the project manager read these and
// hold different roles.
router.use(EmployeeAuthMiddleware);

// The dashboard sends ?date=YYYY-MM-DD in IST. Route it through the same shift
// bucketing the rollup uses, so a query and the documents it should find can
// never disagree about which day a scan belongs to.
const resolveDate = (raw) => {
  if (!raw) return currentShiftDate();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return shiftDateFor(parsed);
};

// ─── GET /work-orders ─────────────────────────────────────────────────────────
// Everything scanned today, grouped by work order. Product names and order
// quantities come from the WorkOrder collection; pieces, operators, machines
// and timings are all derived from the scans.

router.get("/work-orders", async (req, res) => {
  try {
    const shiftDate = resolveDate(req.query.date);
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }

    const events = await ProductionEvent.find(
      { shiftDate, type: "scan" },
      { workOrderKey: 1, unitNumber: 1, operatorId: 1, machineId: 1, activeOps: 1, scanTime: 1 }
    ).lean();

    if (events.length === 0) {
      return res.json({ success: true, date: shiftDate, workOrders: [] });
    }

    // Product names, order quantities, operator names and machine names all
    // come from the master-data cache; the pieces are the scans themselves.
    const master = await masterData.getMasterData();
    const woMap = masterData.workOrderMap(master);
    const nameFor = masterData.operatorNameResolver(master);
    const machineNames = new Map(
      (master.machines || []).map((m) => [String(m._id), m.name])
    );

    const groups = new Map();
    for (const ev of events) {
      const key = ev.workOrderKey;
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          units: new Set(),
          operators: new Map(),   // operatorId -> distinct units
          machines: new Map(),    // machineId  -> scan count
          byOperation: new Map(), // opCode     -> distinct units
          scans: 0,
          firstScanAt: ev.scanTime,
          lastScanAt: ev.scanTime,
        });
      }
      const g = groups.get(key);
      g.scans++;
      if (ev.unitNumber != null) g.units.add(ev.unitNumber);
      if (new Date(ev.scanTime) < new Date(g.firstScanAt)) g.firstScanAt = ev.scanTime;
      if (new Date(ev.scanTime) > new Date(g.lastScanAt)) g.lastScanAt = ev.scanTime;

      if (ev.operatorId) {
        if (!g.operators.has(ev.operatorId)) g.operators.set(ev.operatorId, new Set());
        if (ev.unitNumber != null) g.operators.get(ev.operatorId).add(ev.unitNumber);
      }
      const mid = String(ev.machineId);
      g.machines.set(mid, (g.machines.get(mid) || 0) + 1);

      for (const code of ev.activeOps || []) {
        if (!g.byOperation.has(code)) g.byOperation.set(code, new Set());
        if (ev.unitNumber != null) g.byOperation.get(code).add(ev.unitNumber);
      }
    }

    const workOrders = [...groups.entries()]
      .map(([shortId, g]) => {
        const wo = woMap.get(shortId);
        const qty = wo?.quantity || 0;
        const done = g.units.size;
        return {
          workOrderShortId: shortId,
          workOrderNumber: wo?.workOrderNumber || null,
          productName: wo?.stockItemName || null,
          customerName: wo?.customerName || null,
          orderQuantity: qty,
          unitsCompleted: done,
          // Only meaningful when the order quantity is known; an unmatched
          // barcode must not render as 0% of nothing.
          completionPercent: qty > 0 ? Math.round((done / qty) * 1000) / 10 : null,
          totalScans: g.scans,
          firstScanAt: g.firstScanAt,
          lastScanAt: g.lastScanAt,
          operators: [...g.operators.entries()]
            .map(([id, units]) => ({ operatorId: id, operatorName: nameFor(id), units: units.size }))
            .sort((a, b) => b.units - a.units),
          machines: [...g.machines.entries()]
            .map(([id, scans]) => ({ machineId: id, machineName: machineNames.get(id) || "Unknown", scans }))
            .sort((a, b) => b.scans - a.scans),
          byOperation: [...g.byOperation.entries()]
            .map(([code, units]) => ({ operationCode: code, units: units.size }))
            .sort((a, b) => b.units - a.units),
        };
      })
      .sort((a, b) => new Date(b.lastScanAt) - new Date(a.lastScanAt));

    res.json({ success: true, date: shiftDate, workOrders });
  } catch (error) {
    console.error("[scanner/work-orders]", error.message);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /operator/:operatorId ────────────────────────────────────────────────
// One operator's shift: pieces per hour, what they worked on, per-operation
// pace against standard time, and a scan timeline.
//
// ?from= / ?to= (ISO or HH:MM) narrow it to an interval — "how many pieces
// between 10:00 and 12:00" is the question supervisors actually ask.
router.get("/operator/:operatorId", async (req, res) => {
  try {
    const shiftDate = resolveDate(req.query.date);
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }
    const operatorId = String(req.params.operatorId || "").trim();
    if (!operatorId) {
      return res.status(400).json({ success: false, message: "operatorId is required" });
    }

    // HH:MM is interpreted against the shift day, so "10:00" means 10am on the
    // day being viewed rather than today.
    const parseBound = (raw) => {
      if (!raw) return null;
      if (/^\d{1,2}:\d{2}$/.test(raw)) {
        const [h, m] = raw.split(":").map(Number);
        return new Date(shiftDate.getTime() + (h * 60 + m) * 60000);
      }
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = parseBound(req.query.from);
    const to = parseBound(req.query.to);

    const filter = { shiftDate, operatorId };
    if (from || to) {
      filter.scanTime = {};
      if (from) filter.scanTime.$gte = from;
      if (to) filter.scanTime.$lte = to;
    }

    const events = await ProductionEvent.find(filter).sort({ scanTime: 1 }).lean();
    const scans = events.filter((e) => e.type === "scan");

    // Master data supplies product names, the operator's name and the SMV
    // targets efficiency is measured against. The rollup supplies the session
    // totals (productive / idle / break minutes) that need the whole shift.
    const [master, dayStats] = await Promise.all([
      masterData.getMasterData(),
      OperatorDayStats.findOne({ shiftDate, operatorId }).lean(),
    ]);
    const woMap = masterData.workOrderMap(master);
    const nameFor = masterData.operatorNameResolver(master);
    const targets = masterData.operationTargets(master);
    const machineNames = new Map(
      (master.machines || []).map((m) => [String(m._id), m.name])
    );

    // Pieces per hour of the day, so a supervisor can see when someone slowed.
    const hourly = {};
    const perOperation = new Map();
    const perProduct = new Map();
    let lastByOp = new Map();

    for (const ev of scans) {
      const at = new Date(ev.scanTime);
      const hr = at.getHours();
      hourly[hr] = (hourly[hr] || 0) + 1;

      const wo = ev.workOrderKey ? woMap.get(ev.workOrderKey) : null;
      const pName = wo?.stockItemName || (ev.workOrderKey ? "WO-" + ev.workOrderKey : "Unknown");
      if (!perProduct.has(pName)) perProduct.set(pName, new Set());
      if (ev.unitNumber != null) perProduct.get(pName).add(ev.unitNumber);

      for (const code of ev.activeOps || []) {
        if (!perOperation.has(code)) {
          perOperation.set(code, { pieces: 0, gapMs: 0, gaps: 0 });
        }
        const st = perOperation.get(code);
        st.pieces++;
        const prev = lastByOp.get(code);
        // Gaps beyond 3 minutes are a stopped machine, not slow work — the
        // same threshold the rollup uses, so the two agree.
        if (prev) {
          const gap = at - prev;
          if (gap > 0 && gap <= 180000) { st.gapMs += gap; st.gaps++; }
        }
        lastByOp.set(code, at);
      }
    }

    const byOperation = [...perOperation.entries()].map(([code, st]) => {
      const avg = st.gaps > 0 ? st.gapMs / st.gaps / 1000 : null;
      const target = targets.get(code) ?? null;
      return {
        operationCode: code,
        pieces: st.pieces,
        avgSecondsPerPiece: avg == null ? null : Math.round(avg * 10) / 10,
        standardSeconds: target,
        efficiencyPercent:
          target && avg ? Math.round((target / avg) * 1000) / 10 : null,
      };
    }).sort((a, b) => b.pieces - a.pieces);

    res.json({
      success: true,
      date: shiftDate,
      operatorId,
      operatorName: nameFor(operatorId),
      interval: { from: from || null, to: to || null },
      totals: {
        scans: scans.length,
        distinctPieces: new Set(scans.map((s) => s.barcodeId).filter(Boolean)).size,
        // From the rollup — these need the whole shift's session data, so they
        // are not recomputed for a narrowed interval.
        minutesLoggedIn: dayStats?.minutesLoggedIn ?? null,
        productiveMinutes: dayStats?.productiveMinutes ?? null,
        idleMinutes: dayStats?.idleMinutes ?? null,
        breakMinutes: dayStats?.breakMinutes ?? null,
        overallEfficiencyPercent: dayStats?.overallEfficiencyPercent ?? null,
      },
      hourly: Object.keys(hourly).map(Number).sort((a, b) => a - b)
        .map((h) => ({ hour: h, pieces: hourly[h] })),
      byOperation,
      byProduct: [...perProduct.entries()]
        .map(([name, units]) => ({ productName: name, units: units.size }))
        .sort((a, b) => b.units - a.units),
      timeline: events.map((ev) => ({
        type: ev.type,
        barcodeId: ev.barcodeId || null,
        productName: ev.workOrderKey ? (woMap.get(ev.workOrderKey)?.stockItemName || null) : null,
        unitNumber: ev.unitNumber,
        machineName: machineNames.get(String(ev.machineId)) || "Unknown",
        activeOps: ev.activeOps || [],
        scanTime: ev.scanTime,
        timeRecovered: ev.timeRecovered,
      })),
    });
  } catch (error) {
    console.error("[scanner/operator]", error.message);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
