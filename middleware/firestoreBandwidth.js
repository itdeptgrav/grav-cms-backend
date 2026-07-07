/**
 * middleware/firestoreBandwidth.js
 *
 * Tracks Firestore read/write operations per API endpoint (route pattern) —
 * not raw bytes. Firestore bills per document read/write/delete, so that's
 * the number that actually tells you which endpoints cost the most.
 *
 * Covers: DocumentReference.get/set/update/delete, Query.get (also covers
 * CollectionReference + .where()/.orderBy() chains since they extend Query),
 * WriteBatch.set/update/delete.
 * Does NOT cover: runTransaction, Realtime Database (separate, byte-billed).
 *
 * ── Wiring (server.js) ──────────────────────────────────────────────────
 *   const { instrumentFirestore, bandwidthMiddleware, bandwidthStatsHandler }
 *     = require("./middleware/firestoreBandwidth");
 *
 *   instrumentFirestore(admin, db);   // once, right after db = admin.firestore()
 *
 *   app.use(bandwidthMiddleware);     // early — before any app.use("/cowork", ...)
 *   app.get("/cowork/admin/bandwidth-stats", bandwidthStatsHandler);
 *
 * ── Test ────────────────────────────────────────────────────────────────
 *   Hit any endpoint normally. Console prints one line per request:
 *     [bw] POST /cowork/task/:taskId/start — 3 reads (7 docs), 2 writes, 412B out, 88ms
 *   Then GET /cowork/admin/bandwidth-stats for running totals per route,
 *   sorted by total documents read (the actual Firestore cost driver).
 * 
 * http://localhost:5000/cowork/admin/bandwidth-stats
 */

const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();
const routeStats = new Map(); // "METHOD /path/pattern" -> aggregate counters

function bump(field, n = 1) {
    const ctx = als.getStore();
    if (ctx) ctx[field] += n;
}

function instrumentFirestore(admin, db) {
    if (db.__bandwidthInstrumented) return;
    db.__bandwidthInstrumented = true;

    // Prefer the SDK's own exported classes; fall back to walking the
    // prototype chain off throwaway (network-free) refs if a version ever
    // doesn't expose them directly.
    const DocumentReference =
        admin.firestore.DocumentReference ||
        Object.getPrototypeOf(db.collection("_").doc("_")).constructor;
    const CollectionReference =
        admin.firestore.CollectionReference ||
        Object.getPrototypeOf(db.collection("_")).constructor;
    const Query =
        admin.firestore.Query ||
        Object.getPrototypeOf(CollectionReference.prototype).constructor;
    const WriteBatch =
        admin.firestore.WriteBatch ||
        Object.getPrototypeOf(db.batch()).constructor;

    // Reads — patching Query.get covers CollectionReference too (it extends Query)
    const origQueryGet = Query.prototype.get;
    Query.prototype.get = async function (...args) {
        const snap = await origQueryGet.apply(this, args);
        bump("reads");
        bump("docsRead", snap.size);
        return snap;
    };

    const origDocGet = DocumentReference.prototype.get;
    DocumentReference.prototype.get = async function (...args) {
        const snap = await origDocGet.apply(this, args);
        bump("reads");
        bump("docsRead", 1);
        return snap;
    };

    // Direct writes — CollectionReference.add() delegates to doc().set()
    // internally, so patching set() alone already captures .add() calls too.
    ["set", "update", "delete"].forEach((method) => {
        const orig = DocumentReference.prototype[method];
        DocumentReference.prototype[method] = async function (...args) {
            const res = await orig.apply(this, args);
            bump("writes");
            return res;
        };
    });

    // Batched writes — separate class, queued synchronously before commit(),
    // so counting here attributes the write to the request that queued it.
    ["set", "update", "delete"].forEach((method) => {
        const orig = WriteBatch.prototype[method];
        WriteBatch.prototype[method] = function (...args) {
            bump("writes");
            return orig.apply(this, args);
        };
    });
}

function bandwidthMiddleware(req, res, next) {
    const ctx = { reads: 0, writes: 0, docsRead: 0 };
    const start = Date.now();

    let bytesOut = 0;
    const origEnd = res.end;
    res.end = function (chunk, ...rest) {
        if (chunk) bytesOut = Buffer.byteLength(chunk);
        return origEnd.call(this, chunk, ...rest);
    };

    res.on("finish", () => {
        const ms = Date.now() - start;
        const routeKey = `${req.method} ${req.baseUrl}${req.route?.path || req.path}`;

        console.log(
            `[bw] ${routeKey} — ${ctx.reads} reads (${ctx.docsRead} docs), ${ctx.writes} writes, ${bytesOut}B out, ${ms}ms`
        );

        const agg =
            routeStats.get(routeKey) ||
            { calls: 0, reads: 0, writes: 0, docsRead: 0, bytesOut: 0, totalMs: 0 };
        agg.calls += 1;
        agg.reads += ctx.reads;
        agg.writes += ctx.writes;
        agg.docsRead += ctx.docsRead;
        agg.bytesOut += bytesOut;
        agg.totalMs += ms;
        routeStats.set(routeKey, agg);
    });

    als.run(ctx, () => next());
}

function bandwidthStatsHandler(req, res) {
    const rows = [...routeStats.entries()]
        .map(([route, s]) => ({
            route,
            calls: s.calls,
            docsReadTotal: s.docsRead,
            docsReadPerCall: +(s.docsRead / s.calls).toFixed(1),
            writesTotal: s.writes,
            avgMs: Math.round(s.totalMs / s.calls),
            bytesOutTotal: s.bytesOut,
        }))
        .sort((a, b) => b.docsReadTotal - a.docsReadTotal);

    res.json({ generatedAt: new Date().toISOString(), routes: rows });
}

module.exports = { instrumentFirestore, bandwidthMiddleware, bandwidthStatsHandler };