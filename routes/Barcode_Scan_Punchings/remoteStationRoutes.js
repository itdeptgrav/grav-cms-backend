// routes/Barcode_Scan_Punchings/remoteStationRoutes.js
//
// WHAT A HAND-SCANNER DEVICE PAIRED TO A FINISHING DASHBOARD POSTS TO.
//
// Mounted at /api/cms/production/barcode_punchings/station — under the same
// base the scanner firmware builds from the server address in its NVS, so
// the one SRV: card that points a device at this server points it here too.
//
// MOUNTED EARLY IN server.js, before the /api/cms auth router, for the same
// reason scannerIngestRoutes.js is: a device has no session. What it has is a
// STATION KEY (services/manufacturing/finishingStation.js), presented on every
// call after pairing as `X-Station-Key`.
//
//   GET  /ping              reachability, no key (the device's REFRESH check)
//   POST /pair              { deviceId, pairToken, … } → a station key
//   POST /events            { events: [ signin | scan | signout ] }   ← the hot path
//   POST /heartbeat         liveness; answers whether the pairing still stands
//   GET  /operator-count    today's pieces at this stage by one badge
//   POST /unpair            the device lets itself go
//
// ── EVENTS ARE AT-LEAST-ONCE, SO EVERY ANSWER IS IDEMPOTENT ─────────────────
// The device cannot tell "the server never got it" from "the server got it
// and the reply was lost", so it re-sends. A `scan` re-sent lands on the
// piece index and is answered "saved" when the earlier write was this very
// event (priorDevice.eventId), "already" when somebody else did the piece.
// A `signin` for the operator already on the device is a no-op; a `signout`
// for nobody is a no-op. Nothing here can double-count a garment.
//
// ── THE DEVICE CLEARS ITS QUEUE ON ANY 2xx ───────────────────────────────────
// An invalid barcode is answered `invalid`, inside a 200. It is a fact that
// happened — the device shows the reason for two seconds and moves on. A 4xx
// is reserved for "this device is no longer paired" (401 UNPAIRED), on which
// the device drops its key and goes back to showing "scan the QR".

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const B = "../../models/CMS_Models/Manufacturing/Production/Barcode";
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);
const FinishingScan = require("../../models/CMS_Models/Manufacturing/Finishing/FinishingScan");
const Employee = require("../../models/Employee");
const station = require("../../services/manufacturing/finishingStation");
const { recordDone } = require("../../services/manufacturing/finishingPieces");
const shift = require("../../services/manufacturing/shiftHours");
const realtime = require("../../services/barcodeScanner/realtime");

const { str } = station;
const isValidDeviceId = (id) => /^[0-9a-fA-F]{8}$|^[0-9a-fA-F]{12}$/.test(id);

const stageView = (stage) => ({ slug: stage.slug, name: stage.name, doneLabel: stage.doneLabel, action: stage.action });

// A device clock that never synced produces 1970; the firmware reconstructs
// the true time where it can and otherwise sends nothing. Server time then.
const resolveScanTime = (raw) => {
  if (!raw) return { at: new Date(), recovered: true };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2024) return { at: new Date(), recovered: true };
  return { at: d, recovered: false };
};

const emit = (payload) => { try { realtime.emitStation(payload); } catch (err) { console.error("[station] emit failed (ignored):", err.message); } };

// ─── GET /ping ────────────────────────────────────────────────────────────────
router.get("/ping", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, serverTime: new Date().toISOString(), dbOk: mongoose.connection.readyState === 1 });
});

// ─── POST /pair ───────────────────────────────────────────────────────────────
router.post("/pair", async (req, res) => {
  try {
    const deviceId = str(req.body?.deviceId).toUpperCase();
    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({ success: false, code: "DEVICE_ID_INVALID", message: "deviceId must be the device's 12-hex MAC id." });
    }
    const pair = station.readPairToken(req.body?.pairToken);
    if (!pair) {
      return res.status(400).json({ success: false, code: "PAIR_TOKEN_INVALID", message: "That QR is not a dashboard pairing code, or it has expired. Open the dashboard and show a fresh one." });
    }
    const minted = station.mintStationKey({ deviceId, stage: pair.stage, companyId: pair.companyId });
    const now = new Date();

    const prev = await DeviceHeartbeat.findOne({ deviceId }).select("station").lean();
    const keepName = prev?.station?.stage === pair.stage.slug ? str(prev.station.name) : "";

    await DeviceHeartbeat.updateOne(
      { deviceId },
      {
        $set: {
          /* A device paired to a dashboard is not fitted to a machine. */
          machineId: null, machineName: "",
          firmwareVersion: str(req.body?.firmwareVersion),
          ipAddress: str(req.body?.ipAddress),
          wifiSSID: str(req.body?.wifiSSID),
          lastHeartbeatAt: now,
          station: {
            stage: pair.stage.slug,
            companyId: new mongoose.Types.ObjectId(pair.companyId),
            name: keepName,
            pairedAt: now,
            pairedBy: { userId: pair.issuedBy.userId, name: pair.issuedBy.name },
            keyExpiresAt: minted.expiresAt,
            operator: null,
            /* A re-pair keeps the log: it is the device's history, not the pairing's. */
            sessionLog: prev?.station?.stage === pair.stage.slug ? (prev.station.sessionLog || []) : [],
            lastScanAt: null, lastScanBarcode: "", lastEventAt: now,
          },
        },
        $inc: { evidenceRevision: 1 },
      },
      { upsert: true },
    );

    emit({ stage: pair.stage.slug, deviceId, type: "paired" });
    return res.json({
      success: true,
      deviceId,
      stationKey: minted.key,
      keyExpiresAt: minted.expiresAt,
      stage: stageView(pair.stage),
      stationName: keepName || deviceId,
      serverTime: now.toISOString(),
    });
  } catch (err) {
    console.error("[station/pair] error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─── The station key, on everything below ─────────────────────────────────────
async function requireStation(req, res, next) {
  try {
    const key = station.readStationKey(req.get("x-station-key") || req.body?.stationKey);
    if (!key) return res.status(401).json({ success: false, code: "UNPAIRED", message: "No valid station key. Scan the dashboard's QR to pair." });
    const doc = await DeviceHeartbeat.findOne({ deviceId: key.deviceId }).select("station lastHeartbeatAt");
    if (!doc || !doc.station || doc.station.stage !== key.stage.slug || String(doc.station.companyId) !== key.companyId) {
      return res.status(401).json({ success: false, code: "UNPAIRED", message: "This device is no longer paired to that dashboard. Scan the dashboard's QR to pair again." });
    }
    req.station = { ...key, doc };
    next();
  } catch (err) {
    console.error("[station] key check failed:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
}

/** Today's pieces at this stage by one person — by Employee id when known, else by badge. */
async function piecesToday({ stage, companyId, person, badge }) {
  const { start, end } = shift.istDayWindow();
  const who = person?.userId ? { "doneBy.userId": person.userId } : { "doneBy.employeeId": str(badge).toUpperCase() };
  return FinishingScan.countDocuments({ companyId: new mongoose.Types.ObjectId(companyId), stage, doneAt: { $gte: start, $lt: end }, ...who });
}

// ─── POST /events ─────────────────────────────────────────────────────────────
router.post("/events", requireStation, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!incoming || !incoming.length) return res.status(400).json({ success: false, message: "events array is required" });

    const { companyId, deviceId, doc } = req.station;
    const stage = req.station.stage.slug;
    const events = incoming.slice(0, 100).map((e) => ({
      eventId: str(e?.eventId),
      type: str(e?.type).toLowerCase(),
      barcode: str(e?.barcodeId || e?.barcode),
      badge: str(e?.operatorId).toUpperCase(),
      ...resolveScanTime(e?.scanTime),
    }));

    const people = await station.resolveOperators(Employee, events.map((e) => e.badge));
    const results = new Map();
    const say = (e, r) => results.set(e.eventId || `${e.type}:${e.barcode}:${e.at.getTime()}`, { eventId: e.eventId, type: e.type, ...r });

    /* Sign-ins and sign-outs, in order, on the station record. */
    const st = doc.station;
    let stationChanged = false;
    const opChanges = [];
    for (const e of events) {
      if (e.type !== "signin" && e.type !== "signout") continue;
      if (!station.isBadge(e.badge)) { say(e, { status: "invalid", reason: "Not an ID card." }); continue; }
      const person = people.get(e.badge);
      const { changed } = station.applyOperatorEvent(st, { type: e.type, badge: e.badge, person, at: e.at });
      if (changed) { stationChanged = true; opChanges.push({ type: e.type, badge: e.badge, name: person?.name || e.badge }); }
      say(e, { status: "accepted", operator: { badge: e.badge, name: person?.name || e.badge, known: Boolean(person?.known) }, noop: !changed });
    }

    /* Pieces: each attributed to the operator the DEVICE says scanned it —
       captured per event at scan time, not whoever is signed in now. */
    const scans = events.filter((e) => e.type === "scan");
    const toRecord = [];
    for (const e of scans) {
      if (!e.eventId) { say(e, { status: "invalid", reason: "Event has no id." }); continue; }
      if (!station.isBadge(e.badge)) { say(e, { status: "invalid", reason: "Nobody was signed in. Scan your ID card first." }); continue; }
      if (!station.isPieceBarcode(e.barcode)) { say(e, { status: "invalid", reason: "Not a piece barcode — expected WO-<id>-<unit>." }); continue; }
      toRecord.push(e);
    }
    let saved = 0;
    if (toRecord.length) {
      const { results: rows, saved: n } = await recordDone({
        stage, companyId,
        scans: toRecord.map((e) => ({
          barcode: e.barcode, at: e.at.toISOString(), source: "device",
          doneBy: station.doneByFor(people.get(e.badge), e.badge),
          device: { deviceId, eventId: e.eventId },
        })),
        who: station.doneByFor(null, ""),
      });
      saved = n;
      /* recordDone answers in input order, one row per scan, barcode on each. */
      rows.forEach((r, i) => {
        const e = toRecord[i];
        let status = r.status;
        /* A retry of a write this device already made is a success. */
        if (status === "already" && r.priorDevice?.eventId && r.priorDevice.eventId === e.eventId) status = "saved";
        say(e, {
          status,
          reason: r.reason || null,
          barcode: r.barcode,
          product: r.workOrder?.productName || "",
          workOrderNumber: r.workOrder?.workOrderNumber || "",
          unit: r.unit ?? null,
          doneAt: r.doneAt || null,
          doneBy: r.doneBy ? { name: r.doneBy.name, employeeId: r.doneBy.employeeId } : null,
        });
      });
      const last = toRecord[toRecord.length - 1];
      st.lastScanAt = last.at;
      st.lastScanBarcode = last.barcode;
      stationChanged = true;
    }

    if (stationChanged) {
      st.lastEventAt = new Date();
      doc.markModified("station");
      await doc.save();
    }

    /* The on-screen tally for whoever is on the device now. */
    let operator = null;
    if (st.operator?.badge) {
      const person = people.get(st.operator.badge) || (st.operator.userId ? { userId: st.operator.userId, known: true } : null);
      operator = { badge: st.operator.badge, name: st.operator.name, known: Boolean(st.operator.known), piecesToday: await piecesToday({ stage, companyId, person, badge: st.operator.badge }) };
    }

    if (saved || opChanges.length) emit({ stage, deviceId, type: saved ? "scan" : opChanges[opChanges.length - 1].type, saved, operator: operator ? { badge: operator.badge, name: operator.name } : null });

    return res.status(200).json({
      success: true,
      accepted: events.length,
      saved,
      results: events.map((e) => results.get(e.eventId || `${e.type}:${e.barcode}:${e.at.getTime()}`) || { eventId: e.eventId, type: e.type, status: "ignored", reason: `Unknown event type "${e.type}".` }),
      operator,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[station/events] error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─── POST /heartbeat ──────────────────────────────────────────────────────────
router.post("/heartbeat", requireStation, async (req, res) => {
  try {
    const { stage, deviceId, doc } = req.station;
    const b = req.body || {};
    await DeviceHeartbeat.updateOne(
      { deviceId },
      {
        $set: {
          firmwareVersion: str(b.firmwareVersion), ipAddress: str(b.ipAddress), wifiSSID: str(b.wifiSSID),
          rssi: b.rssi ?? null, wifiChannel: b.wifiChannel ?? null,
          queueDepth: Number(b.queueDepth || 0), queueHighWater: Number(b.queueHighWater || 0),
          currentOperatorId: doc.station.operator?.badge || null,
          bootCount: b.bootCount ?? null, uptimeSec: b.uptimeSec ?? null, resetReason: str(b.resetReason),
          lastHeartbeatAt: new Date(),
        },
        $inc: { evidenceRevision: 1 },
      },
    );
    const op = doc.station.operator?.badge ? doc.station.operator : null;
    return res.json({
      success: true,
      serverTime: new Date().toISOString(),
      dbOk: mongoose.connection.readyState === 1,
      cloudSyncOk: true,
      paired: true,
      stage: stageView(req.station.stage),
      stationName: doc.station.name || deviceId,
      operator: op ? { badge: op.badge, name: op.name, known: op.known } : null,
    });
  } catch (err) {
    console.error("[station/heartbeat] error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─── GET /operator-count?operatorId= ──────────────────────────────────────────
router.get("/operator-count", requireStation, async (req, res) => {
  try {
    const badge = str(req.query.operatorId).toUpperCase();
    if (!station.isBadge(badge)) return res.status(400).json({ success: false, message: "operatorId is required" });
    const people = await station.resolveOperators(Employee, [badge]);
    const person = people.get(badge);
    const count = await piecesToday({ stage: req.station.stage.slug, companyId: req.station.companyId, person, badge });
    return res.json({ success: true, operatorId: badge, name: person?.name || badge, known: Boolean(person?.known), count, date: shift.istDayWindow().label });
  } catch (err) {
    console.error("[station/operator-count] error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─── POST /unpair ─────────────────────────────────────────────────────────────
router.post("/unpair", requireStation, async (req, res) => {
  try {
    const { stage, deviceId } = req.station;
    await DeviceHeartbeat.updateOne({ deviceId }, { $set: { station: null } });
    emit({ stage: stage.slug, deviceId, type: "unpaired" });
    return res.json({ success: true, deviceId });
  } catch (err) {
    console.error("[station/unpair] error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;
