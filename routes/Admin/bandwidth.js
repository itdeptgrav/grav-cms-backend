// routes/Admin/bandwidth.js
//
// The read side of the bandwidth meter. Mounted behind requirePlatformAdmin.
//
// Every number here is measured, not modelled, with two exceptions that are
// labelled as such wherever they surface:
//
//   mongoBytesEst  - sampled, because the Mongo driver does not speak HTTP.
//   p50/p95/p99    - read off log2 histograms, so accurate to a factor of two.
//
// That distinction matters. The point of this dashboard is to stop guessing
// about the bill, so a guess dressed as a measurement would make it worse than
// nothing.
//
// -- On merging the histogram bags ------------------------------------------
// `buckets`, `statuses` and `types` are Maps with open-ended keys, so summing
// them across a window is a group-by over their entries rather than a plain
// $sum. Doing that for every route in the collection would be wasteful, so it
// runs as a SECOND pass over only the keys that made the top-N of the first,
// cheap, scalar pass. Percentiles are only ever needed for rows someone is
// actually looking at.

const express = require("express");
const router = express.Router();
const Sample = require("../../models/BandwidthSample");
const bw = require("../../middleware/bandwidthTracker");

const HOUR = 3600_000;
const TZ = process.env.BANDWIDTH_TZ || "Asia/Kolkata";

function windowStart(req) {
  const hours = Math.min(Math.max(Number(req.query.hours) || 168, 1), 24 * 92);
  const d = new Date(Date.now() - hours * HOUR);
  d.setMinutes(0, 0, 0);
  return { since: d, hours };
}

const NUMERIC = [
  "calls", "bytesOut", "bytesRaw", "bytesIn", "outBytesDown", "outBytesUp",
  "outCalls", "totalMs", "errors", "dupCalls", "dupBytes",
  "fsReads", "fsDocsRead", "fsWrites", "mongoOps", "mongoDocs", "mongoBytesEst",
];
const PEAK = ["maxMs", "maxBytes"];

function groupStage(idExpr = "$key") {
  const g = { _id: idExpr };
  for (const f of NUMERIC) g[f] = { $sum: `$${f}` };
  for (const f of PEAK) g[f] = { $max: `$${f}` };
  return g;
}

/** Second pass: fold the three open-keyed Maps for a set of keys. Prefixing
 *  each entry with its bag name lets all three be merged in one group-by
 *  instead of three separate pipelines. */
async function foldBags(scope, since, keys) {
  if (!keys.length) return {};
  const rows = await Sample.aggregate([
    { $match: { scope, hour: { $gte: since }, key: { $in: keys } } },
    {
      $project: {
        key: 1,
        kv: {
          $concatArrays: [
            { $map: { input: { $objectToArray: { $ifNull: ["$buckets", {}] } }, in: { k: { $concat: ["buckets|", "$$this.k"] }, v: "$$this.v" } } },
            { $map: { input: { $objectToArray: { $ifNull: ["$statuses", {}] } }, in: { k: { $concat: ["statuses|", "$$this.k"] }, v: "$$this.v" } } },
            { $map: { input: { $objectToArray: { $ifNull: ["$types", {}] } }, in: { k: { $concat: ["types|", "$$this.k"] }, v: "$$this.v" } } },
          ],
        },
      },
    },
    { $unwind: "$kv" },
    { $group: { _id: { key: "$key", k: "$kv.k" }, v: { $sum: "$kv.v" } } },
    { $group: { _id: "$_id.key", kv: { $push: { k: "$_id.k", v: "$v" } } } },
  ]);

  const out = {};
  for (const r of rows) {
    const bags = { buckets: {}, statuses: {}, types: {} };
    for (const { k, v } of r.kv) {
      const i = k.indexOf("|");
      const name = k.slice(0, i);
      if (bags[name]) bags[name][k.slice(i + 1)] = v;
    }
    out[r._id] = bags;
  }
  return out;
}

function shape(row, bags) {
  const r = { key: row._id };
  for (const f of NUMERIC) r[f] = row[f] || 0;
  for (const f of PEAK) r[f] = row[f] || 0;

  r.avgMs = r.calls ? Math.round(r.totalMs / r.calls) : 0;
  r.bytesPerCall = r.calls ? Math.round(r.bytesOut / r.calls) : 0;

  // How much gzip is actually saving on this route. Null where we never saw a
  // JSON body (streamed downloads, redirects), because 0% and "not applicable"
  // are different answers and only one of them means "go fix this".
  r.compressionRatio = r.bytesRaw > 0 ? +(1 - r.bytesOut / r.bytesRaw).toFixed(3) : null;

  // The share of this route's bytes that re-sent something unchanged.
  r.dupRatio = r.bytesOut > 0 ? +(r.dupBytes / r.bytesOut).toFixed(3) : 0;
  r.errorRate = r.calls ? +(r.errors / r.calls).toFixed(3) : 0;

  if (bags) {
    r.buckets = bags.buckets;
    r.statuses = bags.statuses;
    r.types = bags.types;
    r.p50 = bw.percentileFrom(bags.buckets, "b", 0.5);
    r.p95 = bw.percentileFrom(bags.buckets, "b", 0.95);
    r.p99 = bw.percentileFrom(bags.buckets, "b", 0.99);
    r.msP50 = bw.percentileFrom(bags.buckets, "l", 0.5);
    r.msP95 = bw.percentileFrom(bags.buckets, "l", 0.95);
    r.msP99 = bw.percentileFrom(bags.buckets, "l", 0.99);
  }
  return r;
}

const SORTABLE = new Set([
  "bytesOut", "calls", "outBytesDown", "mongoBytesEst", "totalMs", "errors",
  "bytesIn", "dupBytes", "maxBytes", "maxMs", "bytesRaw",
]);

async function topRows(scope, since, { sort = "bytesOut", limit = 100, withBags = true } = {}) {
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await Sample.aggregate([
    { $match: { scope, hour: { $gte: since } } },
    { $group: groupStage() },
    { $sort: { [SORTABLE.has(sort) ? sort : "bytesOut"]: -1 } },
    { $limit: n },
  ]);
  const bags = withBags ? await foldBags(scope, since, rows.map((r) => r._id)) : {};
  return rows.map((r) => shape(r, bags[r._id]));
}

// --- GET /summary ----------------------------------------------------------
// The three Render buckets side by side with what we believe caused them.
router.get("/summary", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);

    const byScopeRows = await Sample.aggregate([
      { $match: { hour: { $gte: since } } },
      { $group: groupStage("$scope") },
    ]);
    const byScope = Object.fromEntries(byScopeRows.map((s) => [s._id, s]));
    const http = byScope.route || {};
    const socket = byScope.socket || {};
    const outbound = byScope.outbound || {};

    const httpBytes = http.bytesOut || 0;
    const rawBytes = http.bytesRaw || 0;

    // Overall size/latency distribution and type mix, folded over every route
    // row rather than the top-N - this is the headline, so it should not be a
    // sample of itself.
    const [allBags] = await Sample.aggregate([
      { $match: { scope: "route", hour: { $gte: since } } },
      {
        $project: {
          kv: {
            $concatArrays: [
              { $map: { input: { $objectToArray: { $ifNull: ["$buckets", {}] } }, in: { k: { $concat: ["buckets|", "$$this.k"] }, v: "$$this.v" } } },
              { $map: { input: { $objectToArray: { $ifNull: ["$statuses", {}] } }, in: { k: { $concat: ["statuses|", "$$this.k"] }, v: "$$this.v" } } },
              { $map: { input: { $objectToArray: { $ifNull: ["$types", {}] } }, in: { k: { $concat: ["types|", "$$this.k"] }, v: "$$this.v" } } },
            ],
          },
        },
      },
      { $unwind: "$kv" },
      { $group: { _id: "$kv.k", v: { $sum: "$kv.v" } } },
      { $group: { _id: null, kv: { $push: { k: "$_id", v: "$v" } } } },
    ]);

    const bags = { buckets: {}, statuses: {}, types: {} };
    for (const { k, v } of allBags?.kv || []) {
      const i = k.indexOf("|");
      const name = k.slice(0, i);
      if (bags[name]) bags[name][k.slice(i + 1)] = v;
    }

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
      outboundCalls: outbound.outCalls || 0,
      uploadsReceived: http.bytesIn || 0,
      errors: http.errors || 0,
      errorRate: http.calls ? +((http.errors || 0) / http.calls).toFixed(4) : 0,
      slowest: http.maxMs || 0,
      largest: http.maxBytes || 0,
      waste: {
        // Bytes re-sent unchanged. The single most actionable figure here.
        duplicateBytes: http.dupBytes || 0,
        duplicateCalls: http.dupCalls || 0,
        ratio: httpBytes ? +((http.dupBytes || 0) / httpBytes).toFixed(3) : 0,
      },
      compression: {
        rawJsonBytes: rawBytes,
        sentBytes: httpBytes,
        // Negative would mean gzip made things bigger; possible on tiny bodies,
        // so it is reported rather than clamped.
        savedBytes: rawBytes ? rawBytes - httpBytes : 0,
        ratio: rawBytes ? +(1 - httpBytes / rawBytes).toFixed(3) : null,
      },
      distribution: {
        sizeHistogram: bw.histogramOf(bags.buckets, "b", bw.BYTE_BUCKETS),
        latencyHistogram: bw.histogramOf(bags.buckets, "l", bw.MS_BUCKETS),
        p50: bw.percentileFrom(bags.buckets, "b", 0.5),
        p95: bw.percentileFrom(bags.buckets, "b", 0.95),
        p99: bw.percentileFrom(bags.buckets, "b", 0.99),
        msP50: bw.percentileFrom(bags.buckets, "l", 0.5),
        msP95: bw.percentileFrom(bags.buckets, "l", 0.95),
        msP99: bw.percentileFrom(bags.buckets, "l", 0.99),
        approximate: true,
      },
      statuses: bags.statuses,
      types: bags.types,
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
    res.json({
      rows: await topRows("route", since, { sort: req.query.sort, limit: req.query.limit }),
    });
  } catch (e) {
    console.error("[bandwidth/routes]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /route?key=... ----------------------------------------------------
// One endpoint in full: its hour-by-hour shape, its size and latency
// distributions, its status mix, and which callers drove it.
router.get("/route", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);
    const key = String(req.query.key || "");
    if (!key) return res.status(400).json({ success: false, message: "key is required" });

    const [totals] = await Sample.aggregate([
      { $match: { scope: "route", hour: { $gte: since }, key } },
      { $group: groupStage() },
    ]);
    if (!totals) return res.json({ key, found: false });

    const bags = (await foldBags("route", since, [key]))[key];
    const timeline = await Sample.aggregate([
      { $match: { scope: "route", hour: { $gte: since }, key } },
      {
        $group: {
          _id: "$hour",
          bytesOut: { $sum: "$bytesOut" },
          dupBytes: { $sum: "$dupBytes" },
          calls: { $sum: "$calls" },
          errors: { $sum: "$errors" },
          totalMs: { $sum: "$totalMs" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const row = shape(totals, bags);
    res.json({
      key,
      found: true,
      windowHours: hours,
      ...row,
      sizeHistogram: bw.histogramOf(bags?.buckets, "b", bw.BYTE_BUCKETS),
      latencyHistogram: bw.histogramOf(bags?.buckets, "l", bw.MS_BUCKETS),
      timeline: timeline.map((t) => ({
        hour: t._id,
        bytesOut: t.bytesOut,
        dupBytes: t.dupBytes,
        calls: t.calls,
        errors: t.errors,
        avgMs: t.calls ? Math.round(t.totalMs / t.calls) : 0,
      })),
    });
  } catch (e) {
    console.error("[bandwidth/route]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /outbound ---------------------------------------------------------
// The Service-Initiated bill, by host. This is the view that says whether the
// outbound traffic is Google Drive, Firestore, the biometric devices, or
// something nobody remembered we still call.
router.get("/outbound", async (req, res) => {
  try {
    const { since } = windowStart(req);
    res.json({ rows: await topRows("outbound", since, { sort: "outBytesDown", limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /consumers --------------------------------------------------------
router.get("/consumers", async (req, res) => {
  try {
    const { since } = windowStart(req);
    res.json({ rows: await topRows("consumer", since, { sort: "bytesOut", limit: req.query.limit }) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /sockets ----------------------------------------------------------
router.get("/sockets", async (req, res) => {
  try {
    const { since } = windowStart(req);
    res.json({ rows: await topRows("socket", since, { sort: "bytesOut", limit: req.query.limit }) });
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
          dupBytes: { $sum: { $cond: [{ $eq: ["$scope", "route"] }, "$dupBytes", 0] } },
          socketBytes: { $sum: { $cond: [{ $eq: ["$scope", "socket"] }, "$bytesOut", 0] } },
          outboundBytes: { $sum: { $cond: [{ $eq: ["$scope", "outbound"] }, "$outBytesDown", 0] } },
          calls: { $sum: { $cond: [{ $eq: ["$scope", "route"] }, "$calls", 0] } },
          errors: { $sum: { $cond: [{ $eq: ["$scope", "route"] }, "$errors", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json({
      rows: rows.map((r) => ({
        hour: r._id,
        httpBytes: r.httpBytes,
        dupBytes: r.dupBytes,
        socketBytes: r.socketBytes,
        outboundBytes: r.outboundBytes,
        calls: r.calls,
        errors: r.errors,
      })),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- GET /heatmap ----------------------------------------------------------
// Day-of-week x hour-of-day, in local time. This is the chart that settles the
// polling argument: real usage leaves a business-hours block, a timer leaves an
// even wash across all 168 cells including Sunday at 03:00.
router.get("/heatmap", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);
    const rows = await Sample.aggregate([
      { $match: { scope: "route", hour: { $gte: since } } },
      {
        $project: {
          bytesOut: 1, calls: 1,
          parts: { $dateToParts: { date: "$hour", timezone: TZ } },
          dow: { $dayOfWeek: { date: "$hour", timezone: TZ } }, // 1=Sunday
        },
      },
      {
        $group: {
          _id: { dow: "$dow", hour: "$parts.hour" },
          bytesOut: { $sum: "$bytesOut" },
          calls: { $sum: "$calls" },
        },
      },
    ]);

    // Emit all 168 cells so the chart never has to guess at a gap: an hour with
    // no traffic is a real observation, not missing data.
    const grid = [];
    const index = new Map(rows.map((r) => [`${r._id.dow}:${r._id.hour}`, r]));
    for (let dow = 1; dow <= 7; dow++) {
      for (let h = 0; h < 24; h++) {
        const hit = index.get(`${dow}:${h}`);
        grid.push({ dow, hour: h, bytesOut: hit?.bytesOut || 0, calls: hit?.calls || 0 });
      }
    }

    // "Off hours" = outside Mon-Sat 08:00-21:00 local. Traffic there is almost
    // never a person, so its share is a direct read on automated waste.
    const isOff = (c) => c.dow === 1 || c.hour < 8 || c.hour >= 21;
    const total = grid.reduce((a, c) => a + c.bytesOut, 0);
    const off = grid.filter(isOff).reduce((a, c) => a + c.bytesOut, 0);

    res.json({
      windowHours: hours,
      timezone: TZ,
      grid,
      offHoursBytes: off,
      offHoursRatio: total ? +(off / total).toFixed(3) : 0,
      note: "Off hours = outside Mon-Sat 08:00-21:00 " + TZ + ".",
    });
  } catch (e) {
    console.error("[bandwidth/heatmap]", e);
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
// Turns the tables into a ranked list of things worth doing. Every finding
// carries the evidence it was derived from, so it can be argued with rather
// than believed.
router.get("/insights", async (req, res) => {
  try {
    const { since, hours } = windowStart(req);
    const routes = await topRows("route", since, { sort: "bytesOut", limit: 200 });
    const outbound = await topRows("outbound", since, { sort: "outBytesDown", limit: 60, withBags: false });
    const totalOut = routes.reduce((a, r) => a + r.bytesOut, 0);
    const findings = [];

    const MB = 1024 * 1024;
    const GB = 1024 * MB;

    for (const r of routes) {
      if (!r.calls) continue;

      // 1. Re-sending unchanged data. The strongest finding available, because
      //    it is measured rather than inferred from an interval.
      if (r.dupBytes > 20 * MB && r.dupRatio > 0.4) {
        findings.push({
          kind: "repeated-response",
          route: r.key,
          severity: r.dupBytes > 500 * MB ? "high" : "medium",
          bytes: r.bytesOut,
          estimatedSaving: r.dupBytes,
          evidence: {
            "duplicate share": `${Math.round(r.dupRatio * 100)}%`,
            "duplicate calls": r.dupCalls,
            "total calls": r.calls,
          },
          detail: `${bw.fmt(r.dupBytes)} of this endpoint's ${bw.fmt(r.bytesOut)} was byte-identical to the response immediately before it - ${Math.round(r.dupRatio * 100)}% of its traffic re-sent data the client already had. An ETag/304 on this route reclaims nearly all of it without touching the client.`,
        });
      }

      // 2. Uncompressed JSON. bytesRaw is only set when res.json ran, so this
      //    is specifically "we serialised a JSON body and sent it at full size".
      if (r.bytesRaw > 0 && r.compressionRatio !== null && r.compressionRatio < 0.05 && r.bytesOut > 20 * MB) {
        findings.push({
          kind: "uncompressed",
          route: r.key,
          severity: r.bytesOut > 500 * MB ? "high" : "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.85),
          evidence: { "gzip ratio": `${Math.round(r.compressionRatio * 100)}%`, "json bytes": bw.fmt(r.bytesRaw) },
          detail: `${bw.fmt(r.bytesOut)} of JSON sent essentially uncompressed. gzip removes 75-90% of JSON of this shape.`,
        });
      }

      // 3. Chatty: many calls, small responses. The polling signature, kept for
      //    routes where duplicate detection cannot see the body (non-JSON).
      if (r.calls > 5000 && r.bytesPerCall < 8 * 1024 && r.bytesOut > 50 * MB && r.dupRatio < 0.4) {
        findings.push({
          kind: "chatty",
          route: r.key,
          severity: "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.5),
          evidence: { "calls/hour": Math.round(r.calls / hours), "avg size": bw.fmt(r.bytesPerCall) },
          detail: `${r.calls.toLocaleString()} calls (~${Math.round(r.calls / hours)}/hour) averaging ${bw.fmt(r.bytesPerCall)}. Small responses at high frequency. Lengthen the interval, add conditional requests, or move it onto the socket.`,
        });
      }

      // 4. A long tail the average hides. p99 far above p50 means most calls
      //    are cheap and a few are enormous - usually an unbounded `limit`.
      if (r.p99 > 2 * MB && r.p50 > 0 && r.p99 > r.p50 * 20 && r.bytesOut > 50 * MB) {
        findings.push({
          kind: "heavy-tail",
          route: r.key,
          severity: "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.3),
          evidence: { p50: bw.fmt(r.p50), p95: bw.fmt(r.p95), p99: bw.fmt(r.p99), largest: bw.fmt(r.maxBytes) },
          detail: `Half of these calls return ${bw.fmt(r.p50)}, but the worst 1% return ${bw.fmt(r.p99)} and the peak was ${bw.fmt(r.maxBytes)}. The average hides this. Usually an unbounded result set for one heavy record.`,
        });
      }

      // 5. Fat every time: no tail, just consistently enormous.
      if (r.bytesPerCall > 2 * MB && r.calls > 20 && !(r.p99 > r.p50 * 20)) {
        findings.push({
          kind: "fat-payload",
          route: r.key,
          severity: r.bytesOut > 200 * MB ? "high" : "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * 0.6),
          evidence: { "per call": bw.fmt(r.bytesPerCall), calls: r.calls },
          detail: `Every call returns ${bw.fmt(r.bytesPerCall)}. Usually an unpaginated .find() or a missing .select() pulling fields the screen never renders.`,
        });
      }

      // 6. Proxy: fetches nearly as much as it sends. Billed on both legs.
      if (r.outBytesDown > 20 * MB && r.bytesOut > 0 && r.outBytesDown > r.bytesOut * 0.7) {
        findings.push({
          kind: "double-billed-proxy",
          route: r.key,
          severity: "high",
          bytes: r.outBytesDown + r.bytesOut,
          estimatedSaving: r.outBytesDown + r.bytesOut,
          evidence: { fetched: bw.fmt(r.outBytesDown), sent: bw.fmt(r.bytesOut) },
          detail: `Streams ${bw.fmt(r.outBytesDown)} in and ${bw.fmt(r.bytesOut)} back out - the same file billed on both legs. A signed or direct URL moves this traffic off the service entirely.`,
        });
      }

      // 7. Errors that still cost bytes.
      if (r.errors > 500 && r.errorRate > 0.25) {
        const s = r.statuses || {};
        const worst = ["c500", "c404", "c403", "c401", "c429"].find((c) => s[c]);
        findings.push({
          kind: "failing",
          route: r.key,
          severity: "medium",
          bytes: r.bytesOut,
          estimatedSaving: Math.round(r.bytesOut * r.errorRate),
          evidence: { "error rate": `${Math.round(r.errorRate * 100)}%`, errors: r.errors, "most common": worst ? worst.slice(1) : "4xx/5xx" },
          detail: `${r.errors.toLocaleString()} of ${r.calls.toLocaleString()} calls failed. A client is retrying something that will not start working, and each attempt still costs a response body.`,
        });
      }
    }

    for (const h of outbound) {
      if (h.outBytesDown > 200 * MB) {
        findings.push({
          kind: "outbound-host",
          route: h.key,
          severity: h.outBytesDown > GB ? "high" : "medium",
          bytes: h.outBytesDown,
          estimatedSaving: 0,
          evidence: { calls: h.outCalls, "avg per call": bw.fmt(Math.round(h.outBytesDown / Math.max(h.outCalls, 1))) },
          detail: `${bw.fmt(h.outBytesDown)} pulled from ${h.key} over ${h.outCalls.toLocaleString()} calls. Billed as Service-Initiated.`,
        });
      }
    }

    // Highest saving first; ties broken by raw size so the ordering is stable.
    findings.sort((a, b) => (b.estimatedSaving - a.estimatedSaving) || (b.bytes - a.bytes));

    res.json({
      windowHours: hours,
      totalHttpBytes: totalOut,
      totalRecoverable: findings.reduce((a, f) => a + (f.estimatedSaving || 0), 0),
      findings,
      note:
        "estimatedSaving for 'repeated-response' is measured. Every other figure is an upper bound from typical gzip ratios and from removing redundant work - treat those as a ranking, not a forecast.",
    });
  } catch (e) {
    console.error("[bandwidth/insights]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
