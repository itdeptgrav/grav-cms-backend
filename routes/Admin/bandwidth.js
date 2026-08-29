// routes/Admin/bandwidth.js
//
// The read side of the bandwidth meter. Mounted behind requirePlatformAdmin.
//
// Every number here is measured, not modelled, with exactly one exception:
// `mongoBytesEst`, which is sampled and is labelled "estimated" everywhere it
// surfaces. That distinction matters - the point of this dashboard is to stop
// guessing about the bill, so a guess that looks like a measurement would make
// it worse than nothing.

const express = require("express");
const router = express.Router();
const Sample = require("../../models/BandwidthSample");
const bw = require("../../middleware/bandwidthTracker");

const HOUR = 3600_000;

function windowStart(req) {
  const hours = Math.min(Number(req.query.hours) || 168, 24 * 92);
  const d = new Date(Date.now() - hours * HOUR);
  d.setMinutes(0, 0, 0);
  return { since: d, hours };
}

const NUMERIC = [
  "calls", "bytesOut", "bytesRaw", "bytesIn", "outBytesDown", "outBytesUp",
  "outCalls", "totalMs", "errors", "fsReads", "fsDocsRead", "fsWrites",
  "mongoOps", "mongoDocs", "mongoBytesEst",
];

function sumStage() {
  const g = { _id: "$key" };
  for (const f of NUMERIC) g[f] = { $sum: `$${f}` };
  return g;
}

function shape(row) {
  const r = { key: row._id };
  for (const f of NUMERIC) r[f] = row[f] || 0;
  r.avgMs = r.calls ? Math.round(r.totalMs / r.calls) : 0;
  r.bytesPerCall = r.calls ? Math.round(r.bytesOut / r.calls) : 0;
  // How much gzip is actually saving on this route. Null where we never saw a
  // JSON body (streamed downloads, redirects), because 0% and "not applicable"
  // are different answers and only one of them means "go fix this".
  r.compressionRatio = r.bytesRaw > 0 ? +(1 - r.bytesOut / r.bytesRaw).toFixed(3) : null;
  return r;
}

async function aggregate(scope, since, { sort = "bytesOut", limit = 100 } = {}) {
  const rows = await Sample.aggregate([
    { $match: { scope, hour: { $gte: since } } },
    { $group: sumStage() },
    { $sort: { [sort]: -1 } },
    { $limit: Math.min(Number(limit) || 100, 500) },
  ]);
  return rows.map(shape);
}

// --- GET /summary ----------------------------------------------------------
// The three Render buckets, side by side with what we believe caused them.
router.get("/summary", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);

    const [totals] = await Sample.aggregate([
      { $match: { hour: { $gte: since } } },
      {
        $group: {
          _id: "$scope",
          calls: { $sum: "$calls" },
          bytesOut: { $sum: "$bytesOut" },
          bytesRaw: { $sum: "$bytesRaw" },
          bytesIn: { $sum: "$bytesIn" },
          outBytesDown: { $sum: "$outBytesDown" },
          outBytesUp: { $sum: "$outBytesUp" },
        },
      },
      { $group: { _id: null, byScope: { $push: "$$ROOT" } } },
    ]);

    const byScope = Object.fromEntries((totals?.byScope || []).map((s) => [s._id, s]));
    const http = byScope.route || {};
    const socket = byScope.socket || {};
    const outbound = byScope.outbound || {};

    const httpBytes = http.bytesOut || 0;
    const rawBytes = http.bytesRaw || 0;

    res.json({
      windowHours: hours,
      since,
      measuredSinceBoot: bw.snapshot().bootedAt,
      billed: {
        // Names match Render's own bandwidth page so the two can be compared
        // line for line without anyone having to translate.
        httpResponses: httpBytes,
        websocketResponses: socket.bytesOut || 0,
        serviceInitiated: outbound.outBytesDown || 0,
      },
      requests: http.calls || 0,
      uploadsReceived: http.bytesIn || 0,
      compression: {
        rawJsonBytes: rawBytes,
        sentBytes: httpBytes,
        // Negative would mean gzip made things bigger; possible on tiny bodies,
        // so it is reported rather than clamped.
        savedBytes: rawBytes ? rawBytes - httpBytes : 0,
        ratio: rawBytes ? +(1 - httpBytes / rawBytes).toFixed(3) : null,
      },
    });
  } catch (e) {
    console.error("[bandwidth/summary]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /routes -----------------------------------------------------------
router.get("/routes", async (req, res) => {
  try {
    const { since } = windowStart(req);
    const allowed = new Set(["bytesOut", "calls", "outBytesDown", "mongoBytesEst", "totalMs", "errors", "bytesIn"]);
    const sort = allowed.has(req.query.sort) ? req.query.sort : "bytesOut";
    res.json({ rows: await aggregate("route", since, { sort, limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /outbound ---------------------------------------------------------
// The Service-Initiated bill, by host. This is the view that says whether the
// 4 GB is Google Drive, Firestore, the biometric devices or something nobody
// remembered we still call.
router.get("/outbound", async (req, res) => {
  try {
    const { since } = windowStart(req);
    res.json({ rows: await aggregate("outbound", since, { sort: "outBytesDown", limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /consumers --------------------------------------------------------
router.get("/consumers", async (req, res) => {
  try {
    const { since } = windowStart(req);
    res.json({ rows: await aggregate("consumer", since, { sort: "bytesOut", limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /timeline ---------------------------------------------------------
// Hour-by-hour. A flat line across nights and Sundays is the signature of a
// poller; a line that tracks office hours is real users.
router.get("/timeline", async (req, res) => {
  try {
    const { since } = windowStart(req);
    const rows = await Sample.aggregate([
      { $match: { hour: { $gte: since } } },
      {
        $group: {
          _id: "$hour",
          httpBytes: { $sum: { $cond: [{ $eq: ["$scope", "route"] }, "$bytesOut", 0] } },
          socketBytes: { $sum: { $cond: [{ $eq: ["$scope", "socket"] }, "$bytesOut", 0] } },
          outboundBytes: { $sum: { $cond: [{ $eq: ["$scope", "outbound"] }, "$outBytesDown", 0] } },
          calls: { $sum: { $cond: [{ $eq: ["$scope", "route"] }, "$calls", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json({ rows: rows.map((r) => ({ hour: r._id, ...r, _id: undefined })) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /live -------------------------------------------------------------
// Counters that have not been flushed yet. Useful when testing a fix: hit the
// endpoint, refresh this, see the number move without waiting a minute.
router.get("/live", (req, res) => {
  res.json(bw.snapshot());
});

// --- GET /insights ---------------------------------------------------------
// Turns the table into a short list of things worth doing, ranked by the bytes
// each one would save. Every finding carries the evidence it was derived from,
// so it can be argued with rather than believed.
router.get("/insights", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);
    const routes = await aggregate("route", since, { sort: "bytesOut", limit: 400 });
    const outbound = await aggregate("outbound", since, { sort: "outBytesDown", limit: 100 });
    const totalOut = routes.reduce((a, r) => a + r.bytesOut, 0);
    const findings = [];

    for (const r of routes) {
      if (!r.calls) continue;

      // Uncompressed JSON. bytesRaw is only set when res.json ran, so this is
      // specifically "we serialised a JSON body and sent it at full size".
      if (r.bytesRaw > 0 && r.compressionRatio !== null && r.compressionRatio < 0.1 && r.bytesOut > 20 * 1024 * 1024) {
        findings.push({
          kind: "uncompressed",
          route: r.key,
          severity: "high",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.8),
          detail: `${bw.fmt(r.bytesOut)} of JSON sent with no meaningful compression (ratio ${(r.compressionRatio * 100).toFixed(0)}%). gzip typically removes 75-90% of JSON.`,
        });
      }

      // Chatty: many calls, small responses. This is the polling signature.
      // The floor of 5000 calls keeps normal interactive endpoints out of it.
      if (r.calls > 5000 && r.bytesPerCall < 8 * 1024 && r.bytesOut > 50 * 1024 * 1024) {
        const perHour = Math.round(r.calls / hours);
        findings.push({
          kind: "chatty",
          route: r.key,
          severity: "high",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.6),
          detail: `${r.calls.toLocaleString()} calls (~${perHour}/hour) averaging only ${bw.fmt(r.bytesPerCall)} each. Small responses at high frequency - a polling loop. Cut the interval, add ETag/304, or move it to the existing socket.`,
        });
      }

      // Fat: few calls, enormous responses. Missing pagination or projection.
      if (r.bytesPerCall > 2 * 1024 * 1024 && r.calls > 20) {
        findings.push({
          kind: "fat-payload",
          route: r.key,
          severity: r.bytesOut > 200 * 1024 * 1024 ? "high" : "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.7),
          detail: `Every call returns ${bw.fmt(r.bytesPerCall)}. Usually an unpaginated .find() or a missing .select() pulling fields the screen never renders.`,
        });
      }

      // Proxy: the route fetches nearly as much as it sends. Each byte is
      // billed twice - once inbound from Drive, once outbound to the browser.
      if (r.outBytesDown > 20 * 1024 * 1024 && r.bytesOut > 0 && r.outBytesDown > r.bytesOut * 0.7) {
        findings.push({
          kind: "double-billed-proxy",
          route: r.key,
          severity: "high",
          bytes: r.outBytesDown + r.bytesOut,
          estimatedSaving: r.outBytesDown + r.bytesOut,
          detail: `Streams ${bw.fmt(r.outBytesDown)} in and ${bw.fmt(r.bytesOut)} back out - the same file billed on both legs. A signed/direct URL would move this traffic off the service entirely.`,
        });
      }

      // Errors that still cost bytes.
      if (r.errors > 500 && r.errors / r.calls > 0.25) {
        findings.push({
          kind: "failing",
          route: r.key,
          severity: "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * (r.errors / r.calls)),
          detail: `${r.errors.toLocaleString()} of ${r.calls.toLocaleString()} calls returned 4xx/5xx. A client is retrying something that will not start working.`,
        });
      }
    }

    for (const h of outbound) {
      if (h.outBytesDown > 200 * 1024 * 1024) {
        findings.push({
          kind: "outbound-host",
          route: h.key,
          severity: h.outBytesDown > 1024 ** 3 ? "high" : "medium",
          bytes: h.outBytesDown,
          estimatedSaving: 0,
          detail: `${bw.fmt(h.outBytesDown)} pulled from ${h.key} over ${h.outCalls.toLocaleString()} calls. Counted as Service-Initiated on the bill.`,
        });
      }
    }

    findings.sort((a, b) => (b.estimatedSaving || b.bytes) - (a.estimatedSaving || a.bytes));

    res.json({
      windowHours: hours,
      totalHttpBytes: totalOut,
      findings,
      note:
        "estimatedSaving is an upper bound based on typical gzip ratios and on removing redundant polling; treat it as a ranking, not a forecast.",
    });
  } catch (e) {
    console.error("[bandwidth/insights]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
