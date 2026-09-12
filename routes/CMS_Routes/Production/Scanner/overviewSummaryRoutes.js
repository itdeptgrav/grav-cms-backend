// routes/CMS_Routes/Production/Scanner/overviewSummaryRoutes.js
//
// Mounted at /api/cms/production/dashboard — serves GET /overview-summary.
//
// One request that answers "what happened on this floor today": every operator,
// every machine, and every manufacturing order, with SAM-based efficiency.
//
// Built from productionevents DIRECTLY, not from the rollup read models. The
// rollup runs every 60s, so a summary read from it would lag a scan by up to a
// minute — and this page is the one a supervisor refreshes to see whether the
// last piece landed.

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);

const S = "../../../../services/barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const masterData = require(`${S}/masterData`);
const productLookup = require(`${S}/productLookup`);

// Same reasoning as supervisorFloorRoutes: authentication, no department gate.
router.use(EmployeeAuthMiddleware);

const resolveDate = (raw) => {
  if (!raw) return currentShiftDate();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return shiftDateFor(parsed);
};

router.get("/overview-summary", async (req, res) => {
  try {
    const shiftDate = resolveDate(req.query.date);
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: "Invalid date" });
    }

    const [events, master, heartbeats] = await Promise.all([
      ProductionEvent.find({ shiftDate }).sort({ scanTime: 1 }).lean(),
      // localOnly: this page is a summary of what is already known. It must not
      // be the thing that wakes up the hosted connection on every page load —
      // that is what the Live toggle on the tracker is for.
      masterData.getMasterData(),
      DeviceHeartbeat.find({}).lean(),
    ]);

    const machineById = masterData.machineMap(master);
    const operatorName = masterData.operatorNameResolver(master);

    // ─── SAM ──────────────────────────────────────────────────────────────
    // SAM = Standard Allowed Minutes: the standard time to complete ONE piece
    // of an operation. It is the benchmark the whole efficiency figure rests on
    //
    //   SAM produced   = pieces x SAM per piece   ("standard minutes earned")
    //   efficiency %   = SAM produced / minutes actually worked x 100
    //
    // An operator who earns 60 standard minutes in 60 clock minutes is at 100%.
    //
    // Attribution matches jobs/rollupStats.js line 277 exactly: a scan counts
    // toward EVERY operation active on that machine, because the piece passed
    // through all of them. Using a different rule here would make this page
    // disagree with the efficiency shown everywhere else.
    const samByCode = new Map();
    for (const op of master.operations || []) {
      const code = String(op.operationCode || "").trim();
      if (!code) continue;
      // durationSeconds is authoritative where present; totalSam is the same
      // number expressed in minutes.
      const mins =
        Number(op.durationSeconds) > 0
          ? Number(op.durationSeconds) / 60
          : Number(op.totalSam) > 0
          ? Number(op.totalSam)
          : null;
      if (mins) samByCode.set(code, mins);
    }
    const samForScan = (ops) =>
      (ops || []).reduce((sum, c) => sum + (samByCode.get(String(c).trim()) || 0), 0);

    const STALE_SEC = Number(process.env.HEARTBEAT_STALE_SEC || 180);
    const liveMachines = new Map();
    for (const hb of heartbeats) {
      if (!hb.machineId) continue;
      const age = (Date.now() - new Date(hb.lastHeartbeatAt).getTime()) / 1000;
      liveMachines.set(String(hb.machineId), {
        online: age < STALE_SEC,
        lastSeenAt: hb.lastHeartbeatAt,
        queueDepth: hb.queueDepth || 0,
        currentOperatorId: hb.currentOperatorId || null,
        onBreak: !!hb.onBreak,
      });
    }

    // ── One pass over the day ────────────────────────────────────────────────
    const operators = new Map();
    const machines = new Map();
    const orders = new Map();

    const opRec = (id) => {
      if (!operators.has(id))
        operators.set(id, {
          operatorId: id, signInAt: null, signOutAt: null, signedIn: false,
          pieces: 0, samMinutes: 0, piecesWithSam: 0,
          machines: new Set(), operations: new Set(),
          onBreak: false, breaks: 0, breakSeconds: 0, openBreakAt: null,
          firstScanAt: null, lastScanAt: null,
        });
      return operators.get(id);
    };
    const mcRec = (id) => {
      if (!machines.has(id)) {
        const m = machineById.get(id);
        machines.set(id, {
          machineId: id,
          machineName: (m && m.name) || "Unknown machine",
          machineType: (m && m.type) || "",
          pieces: 0, samMinutes: 0, piecesWithSam: 0,
          operators: new Set(), operations: new Set(),
          workOrderKeys: new Set(), breakSeconds: 0, openBreakAt: null,
          firstScanAt: null, lastScanAt: null,
        });
      }
      return machines.get(id);
    };
    const woRec = (key) => {
      if (!orders.has(key))
        orders.set(key, {
          workOrderKey: key, pieces: 0, samMinutes: 0,
          operators: new Set(), machines: new Set(), units: new Set(),
          firstScanAt: null, lastScanAt: null,
        });
      return orders.get(key);
    };

    for (const e of events) {
      const mid = String(e.machineId);
      const oid = e.operatorId || "";

      if (e.type === "signin" && oid) {
        const r = opRec(oid);
        if (!r.signInAt) r.signInAt = e.scanTime;
        r.signedIn = true;
        r.signOutAt = null;
        r.machines.add(mid);
      } else if (e.type === "signout" && oid) {
        const r = opRec(oid);
        r.signOutAt = e.scanTime;
        r.signedIn = false;
      } else if (e.type === "break_start") {
        // Breaks come off the denominator. They are off-standard time: the
        // operator is not expected to be producing, so counting those minutes
        // against them is what made a real 80% operator look like 1%.
        if (oid) {
          const r = opRec(oid);
          r.onBreak = true;
          r.breaks++;
          r.openBreakAt = e.scanTime;
        }
        mcRec(mid).openBreakAt = e.scanTime;
      } else if (e.type === "break_end") {
        // The device sends the measured duration; falling back to the elapsed
        // time from break_start covers an event pair split across a reboot.
        const secs = Number(e.breakDurationSec) > 0 ? Number(e.breakDurationSec) : null;
        if (oid) {
          const r = opRec(oid);
          r.onBreak = false;
          r.breakSeconds += secs != null ? secs
            : r.openBreakAt ? Math.max(0, (new Date(e.scanTime) - new Date(r.openBreakAt)) / 1000) : 0;
          r.openBreakAt = null;
        }
        const mr = mcRec(mid);
        mr.breakSeconds += secs != null ? secs
          : mr.openBreakAt ? Math.max(0, (new Date(e.scanTime) - new Date(mr.openBreakAt)) / 1000) : 0;
        mr.openBreakAt = null;
      } else if (e.type === "scan") {
        const sam = samForScan(e.activeOps);
        const mr = mcRec(mid);
        mr.pieces++;
        mr.samMinutes += sam;
        if (sam > 0) mr.piecesWithSam++;
        if (oid) mr.operators.add(oid);
        (e.activeOps || []).forEach((c) => mr.operations.add(c));
        if (!mr.firstScanAt) mr.firstScanAt = e.scanTime;
        mr.lastScanAt = e.scanTime;

        if (oid) {
          const r = opRec(oid);
          r.pieces++;
          r.samMinutes += sam;
          if (sam > 0) r.piecesWithSam++;
          r.machines.add(mid);
          (e.activeOps || []).forEach((c) => r.operations.add(c));
          if (!r.firstScanAt) r.firstScanAt = e.scanTime;
          r.lastScanAt = e.scanTime;
        }
        if (e.workOrderKey) {
          mr.workOrderKeys.add(e.workOrderKey);
          const wr = woRec(e.workOrderKey);
          wr.pieces++;
          wr.samMinutes += sam;
          if (oid) wr.operators.add(oid);
          wr.machines.add(mid);
          if (e.unitNumber != null) wr.units.add(e.unitNumber);
          if (!wr.firstScanAt) wr.firstScanAt = e.scanTime;
          wr.lastScanAt = e.scanTime;
        }
      }
    }

    const products = await productLookup.resolve([...orders.keys()]);

    // Clock minutes between the first and last scan. A rough denominator on
    // purpose: it is what this page can see without modelling breaks, so it is
    // labelled "span" rather than presented as paid working time.
    const now = Date.now();

    // ─── The efficiency denominator ──────────────────────────────────────────
    // ON-STANDARD minutes: attendance minus break time. This is the number a
    // production manager uses, and it is not the same as elapsed time.
    //
    // The first version of this page divided by first-scan-to-last-scan, which
    // silently counted every break, breakdown and idle gap against the
    // operator. On this floor's real data that turned a normal shift into "1%",
    // which is not a slow operator — it is a wrong denominator.
    //
    //   attendance = sign-in -> sign-out   (or "now" while still signed in)
    //   worked     = attendance - breaks
    //   efficiency = SAM produced / worked x 100
    //
    // Falls back to the scan span only when there is no sign-in event to
    // measure from, and the response says which basis was used so the number is
    // never read as more authoritative than it is.
    const workedMinutes = (rec) => {
      const start = rec.signInAt || rec.firstScanAt;
      if (!start) return { minutes: null, basis: "none" };

      const end = rec.signOutAt
        ? new Date(rec.signOutAt)
        : rec.signedIn
        ? new Date(now)          // still on the clock
        : rec.lastScanAt
        ? new Date(rec.lastScanAt)
        : null;
      if (!end) return { minutes: null, basis: "none" };

      const gross = (end - new Date(start)) / 60000;
      // An unclosed break still counts up to now — an operator who walked away
      // and never scanned back must not accrue productive minutes.
      const openBreak = rec.openBreakAt ? (now - new Date(rec.openBreakAt)) / 60000 : 0;
      const net = gross - rec.breakSeconds / 60 - openBreak;

      return {
        minutes: net > 0 ? Math.round(net) : null,
        grossMinutes: Math.round(gross),
        breakMinutes: Math.round(rec.breakSeconds / 60 + openBreak),
        basis: rec.signInAt ? "attendance-less-breaks" : "scan-span",
      };
    };

    // Efficiency needs at least two scans to mean anything. With one scan the
    // first and last timestamps are the same instant, the window collapses, and
    // a single piece reads as 260% — a number that looks like a triumph and is
    // really a division by nothing.
    // Efficiency is only reported when MOST pieces actually carry a standard.
    // SNLS-01 has no SAM on file, so 17 of this machine's 18 pieces contribute
    // zero standard minutes and the honest arithmetic returns 1%. That is not a
    // slow machine, it is an unmeasured operation - and publishing 1% would send
    // someone to fix a line that is running fine.
    const MIN_SAM_COVERAGE = 0.8;
    const effPct = (sam, mins, pieces, withSam) =>
      pieces >= 2 && sam > 0 && mins > 0 && withSam / pieces >= MIN_SAM_COVERAGE
        ? Math.round((sam / mins) * 1000) / 10
        : null;

    const machineOut = [...machines.values()]
      .map((m) => {
        const live = liveMachines.get(m.machineId) || null;
        const mWork = workedMinutes(m);
        return {
          machineId: m.machineId,
          machineName: m.machineName,
          machineType: m.machineType,
          online: live ? live.online : false,
          lastSeenAt: live ? live.lastSeenAt : null,
          queueDepth: live ? live.queueDepth : 0,
          onBreak: live ? live.onBreak : false,
          currentOperatorName:
            live && live.currentOperatorId ? operatorName(live.currentOperatorId) : "",
          pieces: m.pieces,
          samMinutes: Math.round(m.samMinutes * 10) / 10,
          workedMinutes: mWork.minutes,
          grossMinutes: mWork.grossMinutes,
          breakMinutes: mWork.breakMinutes,
          efficiencyBasis: mWork.basis,
          samCoveragePercent: m.pieces ? Math.round((m.piecesWithSam / m.pieces) * 100) : null,
          efficiencyPercent: effPct(m.samMinutes, mWork.minutes, m.pieces, m.piecesWithSam),
          operators: [...m.operators].map((id) => ({
            operatorId: id, operatorName: operatorName(id),
          })),
          operations: [...m.operations],
          // Codes carrying no standard time. Without this a machine running an
          // unregistered code shows "SAM 0", which reads as "produced nothing"
          // rather than "nobody has set a standard for this operation yet".
          opsWithoutSam: [...m.operations].filter((c) => !samByCode.has(String(c).trim())),
          products: [...m.workOrderKeys].map((k) => {
            const p = products.get(k);
            return {
              workOrderKey: k,
              productName: (p && p.productName) || "Unknown",
              productImage: (p && p.productImage) || null,
              moNumber: (p && p.moNumber) || null,
            };
          }),
          firstScanAt: m.firstScanAt,
          lastScanAt: m.lastScanAt,
        };
      })
      .sort((a, b) => b.pieces - a.pieces);

    const operatorOut = [...operators.values()]
      .map((o) => {
        const oWork = workedMinutes(o);
        return ({
        operatorId: o.operatorId,
        operatorName: operatorName(o.operatorId),
        // "Online" means the DEVICE currently reports this operator signed in —
        // not merely that a signin event exists. A device that died mid-shift
        // would otherwise show its operator as still working hours later.
        online: [...o.machines].some((mid) => {
          const live = liveMachines.get(mid);
          return live && live.online && live.currentOperatorId === o.operatorId;
        }),
        signInAt: o.signInAt,
        signOutAt: o.signOutAt,
        stillSignedIn: o.signedIn,
        onBreak: o.onBreak,
        breaks: o.breaks,
        pieces: o.pieces,
        samMinutes: Math.round(o.samMinutes * 10) / 10,
        workedMinutes: oWork.minutes,
        grossMinutes: oWork.grossMinutes,
        breakMinutes: oWork.breakMinutes,
        efficiencyBasis: oWork.basis,
        samCoveragePercent: o.pieces ? Math.round((o.piecesWithSam / o.pieces) * 100) : null,
        efficiencyPercent: effPct(o.samMinutes, oWork.minutes, o.pieces, o.piecesWithSam),
        machines: [...o.machines].map((id) => {
          const m = machineById.get(id);
          return { machineId: id, machineName: (m && m.name) || "Unknown machine" };
        }),
        operations: [...o.operations],
        opsWithoutSam: [...o.operations].filter((c) => !samByCode.has(String(c).trim())),
        firstScanAt: o.firstScanAt,
        lastScanAt: o.lastScanAt,
        });
      })
      .sort((a, b) => b.pieces - a.pieces);

    // Grouped by manufacturing order — the level a supervisor thinks in.
    // Work orders with no MO on file go under a null group rather than being
    // dropped: unattributed work still happened and still has to sync.
    const moMap = new Map();
    for (const w of orders.values()) {
      const p = products.get(w.workOrderKey);
      const mo = (p && p.moNumber) || null;
      const key = mo || "__none__";
      if (!moMap.has(key))
        moMap.set(key, {
          moNumber: mo,
          moStatus: (p && p.moStatus) || null,
          customerName: (p && p.customerName) || "",
          pieces: 0, workOrders: [],
        });
      const g = moMap.get(key);
      g.pieces += w.pieces;
      g.workOrders.push({
        workOrderKey: w.workOrderKey,
        productName: (p && p.productName) || "Unknown product",
        productImage: (p && p.productImage) || null,
        productCategory: (p && p.productCategory) || "",
        variant: (p && p.variant) || "",
        customerName: (p && p.customerName) || "",
        orderQuantity: (p && p.orderQuantity) != null ? p.orderQuantity : null,
        workOrderStatus: (p && p.workOrderStatus) || "",
        resolvedFrom: (p && p.source) || "unresolved",
        pieces: w.pieces,
        samMinutes: Math.round(w.samMinutes * 10) / 10,
        unitsScanned: w.units.size,
        operators: [...w.operators].map((id) => ({
          operatorId: id, operatorName: operatorName(id),
        })),
        machines: [...w.machines].map((id) => {
          const m = machineById.get(id);
          return { machineId: id, machineName: (m && m.name) || "Unknown machine" };
        }),
        firstScanAt: w.firstScanAt,
        lastScanAt: w.lastScanAt,
      });
    }
    const moOut = [...moMap.values()]
      .sort((a, b) => b.pieces - a.pieces);

    const scans = events.filter((e) => e.type === "scan");

    res.json({
      success: true,
      shiftDate,
      totals: {
        pieces: scans.length,
        events: events.length,
        operators: operatorOut.length,
        operatorsOnline: operatorOut.filter((o) => o.online).length,
        machines: machineOut.length,
        machinesOnline: machineOut.filter((m) => m.online).length,
        manufacturingOrders: moOut.filter((m) => m.moNumber).length,
      },
      manufacturingOrders: moOut,
      operators: operatorOut,
      machines: machineOut,
      masterSource: master.source,
    });
  } catch (error) {
    console.error("[overview-summary]", error.message);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
