/**
 * middleware/bandwidthTracker.js
 *
 * Answers one question: where did the month's bandwidth go?
 *
 * Render bills this service in three buckets, and this file measures all three
 * separately because they have completely different causes and fixes:
 *
 *   HTTP Responses    - bytes we send to browsers/apps.        -> `route` scope
 *   Websocket         - bytes over socket.io.                  -> `socket` scope
 *   Service-Initiated - bytes WE pull from the outside world.  -> `outbound` scope
 *                       (Google Drive, googleapis, Firestore
 *                        REST, biometric devices, webhooks)
 *
 * -- Relationship to firestoreBandwidth.js ---------------------------------
 * That file stays exactly as it is, still mounted, still serving
 * `GET /cowork/admin/bandwidth-stats`. This one runs ALONGSIDE it and does not
 * replace it. Anything already reading that endpoint keeps working unchanged.
 *
 * They answer different questions, which is why both are wanted:
 *
 *   firestoreBandwidth  - how many Firestore DOCUMENTS a route reads/writes.
 *                         That is the Firestore bill.
 *   bandwidthTracker    - how many BYTES cross the wire, in each of the three
 *                         buckets Render bills. That is the Render bill.
 *
 * This file also measures things the older one cannot, which is the reason it
 * exists rather than being folded into it:
 *
 *   1. Bytes written to a STREAM. firestoreBandwidth reads only the final chunk
 *      passed to res.end(); every piped download - Drive files, PDFs, call
 *      recordings, backups - streams through res.write() and ends with no chunk
 *      at all, so those routes score 0 there. Here they score their real size.
 *   2. A BOUNDED set of route keys, from the express route pattern rather than
 *      the raw path, so `/work-orders/<id>` is one row and not ten thousand.
 *   3. History, in hourly Mongo buckets that survive a deploy.
 *   4. DISTRIBUTION and WASTE, not just totals - see the two notes below.
 *
 * -- Why distributions, not averages ---------------------------------------
 * A mean response size is close to useless for finding waste. An endpoint
 * averaging 5 KB across 90,000 calls looks harmless and can still be shipping
 * an 8 MB response every hundredth call. So every request also lands in a log2
 * histogram of size and of latency, which is mergeable across hourly documents
 * by plain addition and yields p50/p95/p99 at query time.
 *
 * -- Why duplicate detection ------------------------------------------------
 * The most expensive thing a CMS does with bandwidth is re-send data that has
 * not changed. A poller asking every 4 seconds for a list that changes twice an
 * hour is ~99% waste, but nothing in a totals table says so: the bytes look
 * like legitimate traffic. So each JSON response is hashed and compared with
 * the previous response on the same route to the same kind of caller. The
 * `dupBytes` column is then a measured, arguable number - "6.2 of this
 * endpoint's 7.1 GB was byte-identical to the response before it" - rather than
 * an inference from a polling interval.
 *
 * -- Where it must be mounted (order is load-bearing) ----------------------
 * Mount this ABOVE `compression`. Both wrap res.write/res.end, and the wrapper
 * installed FIRST ends up closest to the socket. Mounted above compression we
 * count post-gzip bytes - the number Render actually bills. `res.json` is
 * separately wrapped to record the pre-gzip size, so the dashboard can show the
 * compression ratio and prove a gzip rollout worked.
 *
 *   const bw = require("./middleware/bandwidthTracker");
 *   bw.instrumentOutbound();                 // before anything opens a socket
 *   bw.instrumentFirestore(admin, db);       // after db is created
 *   app.use(bw.middleware);                  // <- above compression
 *   if (process.env.BANDWIDTH_ENABLE_GZIP === "1") app.use(compression());
 *   ...
 *   bw.attachSocketMeter(io);
 *   bw.startFlusher(mongoose);               // after mongoose connects
 *
 * gzip itself is OFF unless BANDWIDTH_ENABLE_GZIP=1. While it is off, wire
 * bytes and raw bytes are the same number and the dashboard reports a 0%
 * ratio - which is the honest reading, not a bug.
 *
 * -- What it deliberately does NOT measure ---------------------------------
 * MongoDB. The driver speaks raw TCP, not HTTP, so the https hook below cannot
 * see it - yet on Atlas it is real Service-Initiated egress. `mongoMeter` in
 * this file estimates it from sampled document sizes instead, and the dashboard
 * labels that column "estimated" because it is.
 */

const { AsyncLocalStorage } = require("async_hooks");
const http = require("http");
const https = require("https");

const als = new AsyncLocalStorage();

/** Hard cap on distinct keys per scope. Normalisation should keep us far below
 *  this; the cap exists so a pathological URL pattern degrades the report
 *  instead of the process. */
const MAX_KEYS = 4000;

const scopes = {
  route: new Map(),
  outbound: new Map(),
  consumer: new Map(),
  socket: new Map(),
};

const bootedAt = new Date();

/** Scalar counters. All merge by addition except the two peaks. */
const SCALARS = [
  "calls",
  "bytesOut",       // wire bytes we sent (post-gzip)
  "bytesRaw",       // pre-gzip JSON size, when known
  "bytesIn",        // request body bytes we received
  "outBytesDown",   // service-initiated: bytes we pulled in
  "outBytesUp",     // service-initiated: bytes we pushed out
  "outCalls",
  "totalMs",
  "maxMs",          // merged by max, not sum - see mergeInto
  "maxBytes",       // ditto
  "errors",
  "dupCalls",       // responses byte-identical to the previous one
  "dupBytes",       // ...and what those cost
  "fsReads",
  "fsDocsRead",
  "fsWrites",
  "mongoOps",
  "mongoDocs",
  "mongoBytesEst",
];

const PEAKS = new Set(["maxMs", "maxBytes"]);

/** Sub-counters: string-keyed bags of numbers, merged key by key. Every key is
 *  prefixed with a letter on purpose - a purely numeric field name inside a
 *  `$inc` path can be read as an array index by MongoDB. */
const BAGS = ["buckets", "statuses", "types"];

function blank() {
  const o = {};
  for (const k of SCALARS) o[k] = 0;
  for (const k of BAGS) o[k] = {};
  return o;
}

function cell(scope, key) {
  const m = scopes[scope];
  let c = m.get(key);
  if (!c) {
    if (m.size >= MAX_KEYS) {
      key = "(overflow)";
      c = m.get(key);
      if (c) return c;
    }
    c = blank();
    m.set(key, c);
  }
  return c;
}

function bump(field, n = 1) {
  const ctx = als.getStore();
  if (ctx) ctx[field] += n;
}

function bag(ctx, name, key, n = 1) {
  if (!ctx) return;
  ctx[name][key] = (ctx[name][key] || 0) + n;
}

function mergeInto(dst, src) {
  for (const k of SCALARS) {
    if (typeof src[k] !== "number") continue;
    // Peaks are peaks. Summing them would produce a number that never happened.
    if (PEAKS.has(k)) dst[k] = Math.max(dst[k], src[k]);
    else dst[k] += src[k];
  }
  for (const name of BAGS) {
    const s = src[name];
    if (!s) continue;
    for (const key of Object.keys(s)) dst[name][key] = (dst[name][key] || 0) + s[key];
  }
}

// ---------------------------------------------------------------------------
// Histograms
//
// log2 buckets: cheap to compute, cheap to store, and mergeable across hourly
// documents by plain addition - which is what lets p95 be computed over an
// arbitrary window at query time rather than being fixed when the sample was
// written. The cost is resolution: a value is only known to within a factor of
// two, so every percentile this yields is approximate and is labelled as such.
// ---------------------------------------------------------------------------
const BYTE_BUCKETS = 28; //  ~128 MB ceiling
const MS_BUCKETS = 18;   //  ~131 s ceiling

function log2bucket(v, cap) {
  if (!(v > 0)) return 0;
  return Math.min(cap - 1, Math.floor(Math.log2(v + 1)));
}

/** Approximate percentile from a log2 histogram, interpolating inside the
 *  bucket the target lands in. `prefix` is "b" (bytes) or "l" (latency ms). */
function percentileFrom(bagObj, prefix, p) {
  const rows = [];
  let total = 0;
  for (const k of Object.keys(bagObj || {})) {
    if (!k.startsWith(prefix)) continue;
    const i = Number(k.slice(prefix.length));
    if (!Number.isFinite(i)) continue;
    const v = bagObj[k] || 0;
    rows.push([i, v]);
    total += v;
  }
  if (!total) return 0;
  rows.sort((a, b) => a[0] - b[0]);

  const target = total * p;
  let acc = 0;
  for (const [i, v] of rows) {
    acc += v;
    if (acc >= target) {
      const lo = i === 0 ? 0 : 2 ** i - 1;
      const hi = 2 ** (i + 1) - 1;
      const frac = v ? (target - (acc - v)) / v : 0;
      return Math.round(lo + (hi - lo) * frac);
    }
  }
  return 0;
}

/** The histogram itself, as [{ from, to, count }] - for drawing. */
function histogramOf(bagObj, prefix, cap) {
  const out = [];
  for (let i = 0; i < cap; i++) {
    const count = (bagObj || {})[`${prefix}${i}`] || 0;
    out.push({ from: i === 0 ? 0 : 2 ** i - 1, to: 2 ** (i + 1) - 1, count });
  }
  // Trim empty tails so a chart is not 28 columns of nothing.
  let last = out.length - 1;
  while (last > 0 && out[last].count === 0) last--;
  let first = 0;
  while (first < last && out[first].count === 0) first++;
  return out.slice(first, last + 1);
}

// ---------------------------------------------------------------------------
// Route key normalisation
//
// The whole report is worthless if `/api/cms/work-orders/6712ab..` and
// `/api/cms/work-orders/6712cd..` are two rows. Express gives us the matched
// pattern for free once the handler has run; the regex path is the fallback for
// 404s and for routers that answer before setting req.route.
// ---------------------------------------------------------------------------
const ID_LIKE = [
  [/^[0-9a-f]{24}$/i, ":id"],                                   // mongo ObjectId
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, ":uuid"],
  [/^\d+$/, ":n"],
  [/^[A-Za-z0-9_-]{20,}$/, ":token"],                           // drive ids, jwts, firebase uids
];

function normalisePath(p) {
  return (
    "/" +
    String(p)
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        for (const [re, label] of ID_LIKE) if (re.test(seg)) return label;
        return seg;
      })
      .join("/")
  );
}

function routeKey(req) {
  // req.route.path is the pattern ("/:id/items"); baseUrl is where the router
  // was mounted. Together they are exactly the row we want.
  if (req.route?.path && typeof req.route.path === "string") {
    const tail = req.route.path === "/" ? "" : req.route.path;
    const k = `${req.method} ${normalisePath(req.baseUrl || "")}${tail}`.replace(/\/+$/, "");
    return k || `${req.method} /`;
  }
  return `${req.method} ${normalisePath((req.originalUrl || req.url).split("?")[0])}`;
}

/** Who asked. Best-effort - every auth middleware in this codebase stashes the
 *  caller somewhere different, so we probe the known shapes rather than
 *  pretending there is one. */
function consumerKey(req) {
  const u = req.user || req.employee || req.deptUser || req.customer || req.vendor || null;
  const role = u?.role || u?.department || u?.deptSlug;
  if (role) return `role:${role}`;
  if (u) return "role:(authenticated)";
  const origin = req.headers.origin;
  if (origin) return `origin:${origin}`;
  const ua = String(req.headers["user-agent"] || "");
  if (/okhttp|expo|dart|CFNetwork/i.test(ua)) return "client:mobile-app";
  if (/ESP32|arduino/i.test(ua)) return "client:scanner-device";
  return "client:(anonymous)";
}

/** Coarse content-type family. Four buckets is enough to answer "is this
 *  endpoint shipping data or shipping files", which is the only question the
 *  dashboard asks of it. */
function typeFamily(res) {
  const ct = String(res.getHeader("content-type") || "").toLowerCase();
  if (!ct) return "other";
  if (ct.includes("json")) return "json";
  if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("javascript")) return "text";
  if (
    ct.startsWith("image/") || ct.startsWith("video/") || ct.startsWith("audio/") ||
    ct.includes("pdf") || ct.includes("octet-stream") || ct.includes("zip") ||
    ct.includes("spreadsheet") || ct.includes("officedocument")
  ) return "binary";
  return "other";
}

function statusKey(code) {
  if (code >= 500) return "c5xx";
  if (code >= 400) return "c4xx";
  if (code >= 300) return "c3xx";
  return "c2xx";
}

const NOTABLE_STATUS = new Set([304, 401, 403, 404, 429, 500, 502, 503]);

// ---------------------------------------------------------------------------
// Duplicate-response detection
//
// FNV-1a over the serialised JSON body, compared with the last hash seen for
// the same (route, kind of caller). A match means we spent the bytes again on
// something the client already had.
//
// Bounded and lossy by design. It is keyed by caller CLASS, not by session, so
// two people polling the same endpoint out of phase will under-report rather
// than over-report duplicates - the number is a floor on the waste, which is
// the safe direction for a figure someone will act on.
// ---------------------------------------------------------------------------
const lastHash = new Map();

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

function isDuplicate(key, hash) {
  const prev = lastHash.get(key);
  if (lastHash.size > MAX_KEYS * 4) lastHash.clear(); // cheap bound; loses a beat, not correctness
  lastHash.set(key, hash);
  return prev === hash;
}

// ---------------------------------------------------------------------------
// The request meter
// ---------------------------------------------------------------------------
function middleware(req, res, next) {
  const ctx = blank();
  const start = Date.now();

  // Request body bytes - what the client uploaded to us. Not billed by Render
  // (ingress is free) but it is the fastest way to spot a client that is
  // re-uploading the same 8 MB payload on a timer.
  //
  // Read from Content-Length rather than by counting chunks. This middleware
  // sits above express.json so that it can measure post-gzip response bytes,
  // and attaching a 'data' listener here would put the request stream into
  // flowing mode before the body parser has attached its own - risking a
  // silently truncated body on every POST in the system. A header is worth
  // strictly less than a byte count, and this number is not billed anyway.
  ctx.bytesIn = Number(req.headers["content-length"]) || 0;

  // Wire bytes. Wrapping BOTH write and end is the entire point: a piped Drive
  // download never passes a chunk to end().
  const origWrite = res.write;
  const origEnd = res.end;

  res.write = function (chunk, encoding, cb) {
    if (chunk && typeof chunk !== "function") {
      try { ctx.bytesOut += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined); } catch {}
    }
    return origWrite.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    if (chunk && typeof chunk !== "function") {
      try { ctx.bytesOut += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined); } catch {}
    }
    return origEnd.call(this, chunk, encoding, cb);
  };

  // Pre-gzip size and the duplicate hash, both off the one serialisation we
  // are already paying for.
  const origJson = res.json;
  res.json = function (body) {
    try {
      const s = JSON.stringify(body) ?? "";
      ctx.bytesRaw += Buffer.byteLength(s);
      ctx.__hash = fnv1a(s);
    } catch { /* circular - skip */ }
    return origJson.call(this, body);
  };

  res.on("finish", () => {
    ctx.calls = 1;
    ctx.totalMs = Date.now() - start;
    ctx.maxMs = ctx.totalMs;
    ctx.maxBytes = ctx.bytesOut;
    if (res.statusCode >= 400) ctx.errors = 1;

    const key = routeKey(req);
    const who = consumerKey(req);

    bag(ctx, "buckets", `b${log2bucket(ctx.bytesOut, BYTE_BUCKETS)}`);
    bag(ctx, "buckets", `l${log2bucket(ctx.totalMs, MS_BUCKETS)}`);
    bag(ctx, "statuses", statusKey(res.statusCode));
    if (NOTABLE_STATUS.has(res.statusCode)) bag(ctx, "statuses", `c${res.statusCode}`);
    bag(ctx, "types", typeFamily(res), ctx.bytesOut);

    if (ctx.__hash !== undefined && ctx.bytesOut > 0 && isDuplicate(`${key}|${who}`, ctx.__hash)) {
      ctx.dupCalls = 1;
      ctx.dupBytes = ctx.bytesOut;
    }

    mergeInto(cell("route", key), ctx);
    mergeInto(cell("consumer", who), ctx);

    if (process.env.BANDWIDTH_LOG === "1") {
      console.log(
        `[bw] ${key} ${res.statusCode} - ${fmt(ctx.bytesOut)} out` +
        (ctx.bytesRaw ? ` (${fmt(ctx.bytesRaw)} raw)` : "") +
        (ctx.dupCalls ? " DUPLICATE" : "") +
        (ctx.outBytesDown ? ` +${fmt(ctx.outBytesDown)} fetched` : "") +
        ` ${ctx.totalMs}ms`
      );
    }
  });

  als.run(ctx, () => next());
}

function fmt(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)}MB`;
  return `${(n / 1073741824).toFixed(2)}GB`;
}

// ---------------------------------------------------------------------------
// Service-Initiated: every outbound HTTP(S) call this process makes
//
// Patched at the `http`/`https` module level rather than on axios, because the
// outbound traffic is spread across four different clients - axios (Drive
// proxying, biometric devices), googleapis/gaxios (Workspace, Tasks, Gmail),
// firebase-admin (Firestore REST + FCM) and bare fetch. One hook here catches
// all of them; four client-specific hooks would each miss the other three.
//
// Bytes come off the socket's own counters. Attaching a 'data' listener to the
// response would flip it into flowing mode and break every consumer, so this
// reads socket.bytesRead deltas instead - accurate because Node does not
// pipeline requests on a socket by default.
// ---------------------------------------------------------------------------
let outboundInstrumented = false;

function instrumentOutbound() {
  if (outboundInstrumented) return;
  outboundInstrumented = true;

  for (const mod of [http, https]) {
    for (const fn of ["request", "get"]) {
      const orig = mod[fn];
      if (typeof orig !== "function") continue;
      mod[fn] = function (...args) {
        const req = orig.apply(this, args);
        try { meterOutbound(req, hostOf(args)); } catch { /* never break a real request */ }
        return req;
      };
    }
  }
}

function hostOf(args) {
  const a = args[0];
  try {
    if (typeof a === "string") return new URL(a).host;
    if (a instanceof URL) return a.host;
    if (a && typeof a === "object") return a.host || a.hostname || "(unknown)";
  } catch { /* fall through */ }
  return "(unknown)";
}

function meterOutbound(req, host) {
  let sock = null, read0 = 0, written0 = 0, done = false;
  const t0 = Date.now();

  req.on("socket", (s) => { sock = s; read0 = s.bytesRead; written0 = s.bytesWritten; });

  const settle = () => {
    if (done || !sock) return;
    done = true;
    const down = Math.max(0, sock.bytesRead - read0);
    const up = Math.max(0, sock.bytesWritten - written0);
    recordOutbound(host, down, up, Date.now() - t0);
  };

  req.on("response", (res) => { res.on("close", settle); });
  req.on("error", settle);
}

/** Set by cron jobs so background egress is attributed to the job that caused
 *  it rather than smeared across "(unattributed)". */
const bgLabel = new AsyncLocalStorage();

function recordOutbound(host, down, up, ms) {
  const c = cell("outbound", host);
  c.outCalls += 1;
  c.outBytesDown += down;
  c.outBytesUp += up;
  c.calls += 1;
  c.totalMs += ms || 0;
  c.maxMs = Math.max(c.maxMs, ms || 0);
  c.maxBytes = Math.max(c.maxBytes, down);
  const bk = `b${log2bucket(down, BYTE_BUCKETS)}`;
  const lk = `l${log2bucket(ms || 0, MS_BUCKETS)}`;
  c.buckets[bk] = (c.buckets[bk] || 0) + 1;
  c.buckets[lk] = (c.buckets[lk] || 0) + 1;

  // Attribute to whatever caused it: a live request, or a named background job.
  const ctx = als.getStore();
  if (ctx) {
    ctx.outCalls += 1;
    ctx.outBytesDown += down;
    ctx.outBytesUp += up;
  } else {
    const job = bgLabel.getStore() || "(unattributed)";
    const b = cell("route", `JOB ${job}`);
    b.outCalls += 1;
    b.outBytesDown += down;
    b.outBytesUp += up;
  }
}

/** Wrap a cron body so its outbound traffic lands under a readable name. */
function asJob(name, fn) {
  return (...args) => bgLabel.run(name, () => fn(...args));
}

// ---------------------------------------------------------------------------
// Firestore document operations
// ---------------------------------------------------------------------------
function instrumentFirestore(admin, db) {
  // Deliberately NOT the same flag firestoreBandwidth.js uses
  // (`__bandwidthInstrumented`). Both modules are mounted, and both wrap the
  // same Firestore prototypes. Sharing one flag would mean whichever ran
  // second quietly did nothing and reported zero Firestore activity forever -
  // a silent wrong number, which is worse than no number.
  //
  // Double-wrapping is safe: each wrapper awaits the one installed before it
  // and bumps its own AsyncLocalStorage, so the two meters count independently
  // off the same call.
  if (!db || db.__bandwidthTrackerInstrumented) return;
  db.__bandwidthTrackerInstrumented = true;

  const DocumentReference =
    admin.firestore.DocumentReference ||
    Object.getPrototypeOf(db.collection("_").doc("_")).constructor;
  const CollectionReference =
    admin.firestore.CollectionReference || Object.getPrototypeOf(db.collection("_")).constructor;
  const Query = admin.firestore.Query || Object.getPrototypeOf(CollectionReference.prototype).constructor;
  const WriteBatch = admin.firestore.WriteBatch || Object.getPrototypeOf(db.batch()).constructor;

  const origQueryGet = Query.prototype.get;
  Query.prototype.get = async function (...args) {
    const snap = await origQueryGet.apply(this, args);
    bump("fsReads"); bump("fsDocsRead", snap.size);
    return snap;
  };

  const origDocGet = DocumentReference.prototype.get;
  DocumentReference.prototype.get = async function (...args) {
    const snap = await origDocGet.apply(this, args);
    bump("fsReads"); bump("fsDocsRead", 1);
    return snap;
  };

  ["set", "update", "delete"].forEach((m) => {
    const orig = DocumentReference.prototype[m];
    DocumentReference.prototype[m] = async function (...args) {
      const r = await orig.apply(this, args); bump("fsWrites"); return r;
    };
  });
  ["set", "update", "delete"].forEach((m) => {
    const orig = WriteBatch.prototype[m];
    WriteBatch.prototype[m] = function (...args) { bump("fsWrites"); return orig.apply(this, args); };
  });
}

// ---------------------------------------------------------------------------
// MongoDB - estimated, and labelled as such
//
// The driver uses raw TCP so the https hook above is blind to it, but on Atlas
// every document crossing that wire is Service-Initiated egress. Sizing every
// result with JSON.stringify would itself become a CPU cost on hot routes, so
// only 1 in SAMPLE results is measured and the rest are extrapolated from the
// running mean bytes-per-document. Document counts are always exact.
// ---------------------------------------------------------------------------
const SAMPLE = Number(process.env.BANDWIDTH_MONGO_SAMPLE || 25);
const SAMPLE_MAX_DOCS = Number(process.env.BANDWIDTH_MONGO_SAMPLE_MAX_DOCS || 500);
let sampleTick = 0;
let meanDocBytes = 512; // seeded guess, converges after the first samples

function mongoMeter(mongoose) {
  const hooks = ["find", "findOne", "findOneAndUpdate", "aggregate"];
  mongoose.plugin((schema) => {
    schema.post(hooks, function (result) {
      try {
        const docs = Array.isArray(result) ? result.length : result ? 1 : 0;
        bump("mongoOps"); bump("mongoDocs", docs);
        if (!docs) return;
        // Never stringify a huge result set to size it. Some reporting routes
        // return tens of thousands of documents, and turning the meter into a
        // second full serialisation of those would cost more than the number
        // is worth. Above the cap we extrapolate from the running mean.
        if (docs <= SAMPLE_MAX_DOCS && sampleTick++ % SAMPLE === 0) {
          const bytes = Buffer.byteLength(JSON.stringify(result) ?? "");
          meanDocBytes = meanDocBytes * 0.8 + (bytes / docs) * 0.2; // EWMA
          bump("mongoBytesEst", bytes);
        } else {
          bump("mongoBytesEst", Math.round(docs * meanDocBytes));
        }
      } catch { /* estimation must never break a query */ }
    });
  });
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
function attachSocketMeter(io) {
  io.on("connection", (socket) => {
    const room = () => cell("socket", socket.nsp?.name || "/");
    room().calls += 1;
    socket.conn.on("packetCreate", (pkt) => {
      const c = room();
      let n = 2;
      try {
        n = typeof pkt.data === "string" ? Buffer.byteLength(pkt.data)
          : pkt.data ? Buffer.byteLength(JSON.stringify(pkt.data)) : 2;
      } catch { n = 2; }
      c.bytesOut += n;
      // Which event is costing the bytes. socket.io puts the event name first.
      const ev = Array.isArray(pkt.data) && typeof pkt.data[0] === "string" ? pkt.data[0] : null;
      if (ev) {
        const k = `ev:${ev}`.slice(0, 60);
        c.types[k] = (c.types[k] || 0) + n;
      }
    });
    socket.conn.on("packet", (pkt) => {
      let n = 2;
      try { n = pkt.data ? Buffer.byteLength(typeof pkt.data === "string" ? pkt.data : JSON.stringify(pkt.data)) : 2; }
      catch { n = 2; }
      room().bytesIn += n;
    });
  });
}

// ---------------------------------------------------------------------------
// Persistence
//
// In-memory counters answer "what is happening right now" and are erased by
// every deploy - which on Render is several times a week, i.e. exactly often
// enough to never see a monthly total. The flusher folds the live maps into
// hourly buckets in Mongo using $inc, so a restart loses at most one interval
// and two instances behind the load balancer add up instead of overwriting
// each other.
// ---------------------------------------------------------------------------
let flushTimer = null;

function startFlusher(mongoose, intervalMs = 60_000) {
  if (flushTimer) return null;
  const Sample = require("../models/BandwidthSample");

  const flush = async () => {
    if (mongoose.connection.readyState !== 1) return;
    const ops = [];
    const hour = new Date();
    hour.setMinutes(0, 0, 0);

    for (const [scope, map] of Object.entries(scopes)) {
      for (const [key, c] of map.entries()) {
        const inc = {};
        const max = {};
        for (const f of SCALARS) {
          if (!c[f]) continue;
          if (PEAKS.has(f)) max[f] = c[f];
          else inc[f] = c[f];
        }
        for (const name of BAGS) {
          for (const k of Object.keys(c[name])) {
            if (c[name][k]) inc[`${name}.${k}`] = c[name][k];
          }
        }
        if (!Object.keys(inc).length && !Object.keys(max).length) continue;

        const update = { $setOnInsert: { hour, scope, key } };
        if (Object.keys(inc).length) update.$inc = inc;
        if (Object.keys(max).length) update.$max = max;

        ops.push({ updateOne: { filter: { hour, scope, key }, update, upsert: true } });

        // Zero the live cell rather than deleting it: the row stays visible in
        // the "since boot" view and we never double-count on the next flush.
        for (const f of SCALARS) c[f] = 0;
        for (const name of BAGS) c[name] = {};
      }
    }

    if (!ops.length) return;
    try {
      await Sample.bulkWrite(ops, { ordered: false });
    } catch (e) {
      console.error("[bandwidth] flush failed:", e.message);
    }
  };

  flushTimer = setInterval(flush, intervalMs);
  flushTimer.unref?.();
  process.once("SIGTERM", () => { flush().catch(() => {}); });
  return flush;
}

// ---------------------------------------------------------------------------
function snapshot() {
  const out = {};
  for (const [scope, map] of Object.entries(scopes)) {
    out[scope] = [...map.entries()].map(([key, c]) => ({ key, ...c }));
  }
  return { bootedAt, meanDocBytes: Math.round(meanDocBytes), scopes: out };
}

module.exports = {
  middleware,
  instrumentOutbound,
  instrumentFirestore,
  mongoMeter,
  attachSocketMeter,
  startFlusher,
  snapshot,
  asJob,
  fmt,
  percentileFrom,
  histogramOf,
  SCALARS,
  BAGS,
  PEAKS,
  BYTE_BUCKETS,
  MS_BUCKETS,
  _internals: { normalisePath, routeKey, scopes, log2bucket, fnv1a },
};
