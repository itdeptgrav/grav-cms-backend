// routes/CMS_Routes/Production/Scanner/scannerAdminRoutes.js
//
// Mounted at /api/cms/production/scanner.
//
// The tooling side of the barcode pipeline: QR generation for the printable
// config sheet, a health probe over the whole ingest → rollup chain, and two
// manual triggers for verifying a fix without waiting for the next cycle.
//
// Ported from the standalone barcode server's server.js (11 Sep 2026). Two of
// its admin endpoints deliberately did NOT come across:
//
//   /admin/firmware*      it relayed multipart uploads to this very backend on
//                         port 5000, so the browser only had to talk to one
//                         origin. The console is now served by the CMS, which
//                         already talks to this origin — the Firmware page
//                         posts straight to /api/barcode-devices/firmware and
//                         the relay is a hop with nothing left to bridge.
//   /admin/sync-hosted    a stub answering an hourly replication job that was
//                         already gone. There has never been a second database
//                         in this deployment for it to be about.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const ProductionEvent = require("../../../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");

const S = "../../../../services/barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const rollupStats = require(`${S}/rollupStats`);
const masterData = require(`${S}/masterData`);
const realtime = require(`${S}/realtime`);
const announce = require(`${S}/announce`);

// Every endpoint here is operated by a person in the supervisor portal, never
// by a device — so unlike the ingest router this one authenticates.
router.use(EmployeeAuthMiddleware);

// ─── POST /qr ─────────────────────────────────────────────────────────────────
// POST, not GET with a query string, because the WiFi password is the main
// thing this encodes: a query string lands in the request logger, in browser
// history, and in any proxy in between. The body does not.
//
// Generated here rather than in the browser because a hand-rolled QR encoder
// that is subtly wrong still renders a plausible-looking square — the failure
// only shows up as a scanner that will not read it, at the machine, later.
router.post("/qr", async (req, res) => {
  try {
    const QRCode = require("qrcode");
    const body = req.body || {};

    // Every code on the config page is drawn in ONE round trip rather than one
    // request per barcode — the page has six of them and the maker box redraws
    // as you type.
    const list = Array.isArray(body.texts)
      ? body.texts.map(String)
      : [String(body.text || "")];

    if (list.length === 0 || list.every((t) => !t)) {
      return res.status(400).json({ success: false, message: "text is required" });
    }
    if (list.length > 32) {
      return res
        .status(400)
        .json({ success: false, message: "too many codes in one request" });
    }

    // Well beyond any config payload, and short of the version-40 ceiling where
    // the modules get too fine for the scanner to resolve on paper.
    if (list.some((t) => t.length > 1000)) {
      return res
        .status(400)
        .json({ success: false, message: "text too long for a scannable code" });
    }

    const size = Math.min(Math.max(Number(body.width) || 200, 100), 600);

    const svgs = await Promise.all(
      list.map((text) =>
        text
          ? QRCode.toString(text, {
              type: "svg",
              errorCorrectionLevel: "M", // survives print smudging without bloating the grid
              margin: 2, // quiet zone; scanners need it
              width: size,
            })
          : Promise.resolve(null)
      )
    );

    res.json({ success: true, svg: svgs[0], svgs });
  } catch (error) {
    console.error("[scanner/qr]", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
// Reports whether the pipeline is actually moving, not just whether Express is
// answering. The Device Health page shows this, so "server up, rollup wedged"
// is visible on the floor instead of looking like a quiet day.
router.get("/health", async (req, res) => {
  let eventsToday = null;
  try {
    eventsToday = await ProductionEvent.countDocuments({
      shiftDate: currentShiftDate(),
    });
  } catch {
    // Health must answer even when Mongo is down — that IS the signal.
  }

  res.json({
    success: true,
    status: "OK",
    db: mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
    database: mongoose.connection.name,
    shiftDate: currentShiftDate(),
    eventsToday,
    rollup: rollupStats.health(),
    masterData: masterData.health(),
    socketClients: realtime.clientCount(),
    // The name scanners can be pointed at instead of a raw IP, plus the address
    // it currently resolves to.
    announce: announce.health(),
  });
});

// ─── POST /rollup ─────────────────────────────────────────────────────────────
// Manual recompute — for verifying a fix without waiting for the next 60s
// cycle. Accepts an optional ?date=YYYY-MM-DD.
//
// Safe to aim at any date: rollupForDate SKIPS a shift day with zero events
// rather than replacing a real ProductionTracking document with an empty one.
router.post("/rollup", async (req, res) => {
  const target = req.query.date
    ? shiftDateFor(new Date(req.query.date))
    : currentShiftDate();
  if (!target) {
    return res.status(400).json({ success: false, message: "Invalid date" });
  }
  const result = await rollupStats.runOnce(undefined, target);
  res.json({ success: !result.error, result });
});

// ─── POST /refresh-master ─────────────────────────────────────────────────────
// Master data changed outside the cache's 10-second window (an import, a manual
// edit). Drops it so the floor screens pick the change up now.
router.post("/refresh-master", (req, res) => {
  masterData.invalidate();
  res.json({ success: true, message: "master-data cache cleared" });
});

module.exports = router;
