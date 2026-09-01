// Middlewear/errorWatch.js
//
// Every 5xx the server sends becomes (part of) a DevAlert.
//
// The failure this catches is the one users report as "it didn't work" and
// nobody can reproduce: by the time a developer hears about it, the console
// scrollback is gone and the log line — if there was one — is buried. This
// records the route, the status and when, fingerprinted per route+status so a
// route failing all afternoon is ONE row counting up, and pushes to the
// developers only once the count crosses the threshold in settings — one blip
// is a row in the feed, a pattern is a notification.
//
// OBSERVATION ONLY. It hooks res "finish", changes no response, and every one
// of its own failures is swallowed — monitoring that can 500 a request it was
// watching has inverted its purpose. The path is normalised (ids → :id) so a
// thousand /api/employees/<24-hex> failures share one fingerprint instead of
// creating a thousand alerts that are each "seen once".

"use strict";

/** /api/employees/68df.../photo → /api/employees/:id/photo */
function normalisePath(url) {
  return String(url || "")
    .split("?")[0]
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{24}$/i.test(seg) || /^\d+$/.test(seg) || /^(GR|E)\d{3,}$/i.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

module.exports = function errorWatch(req, res, next) {
  res.on("finish", () => {
    try {
      if (res.statusCode < 500) return;

      // Required lazily and executed after the response is gone — nothing in
      // here can slow or break the request that triggered it.
      setImmediate(async () => {
        try {
          const { getSetting } = require("../services/devConfig");
          if (!(await getSetting("errors.watchEnabled"))) return;

          const route = normalisePath(req.originalUrl || req.url);
          const { upsertAlert } = require("../services/anomalyScan");
          const DevAlert = require("../models/DevOps/DevAlert");

          const fingerprint = `server-error:${req.method}:${route}:${res.statusCode}`;

          // The notify threshold: create silently, push once the count says
          // this is a pattern. upsertAlert pushes on CREATE, so the first
          // occurrence is recorded info-severity (below the default push
          // floor) and promoted to critical at the threshold — the promotion
          // path re-notifies via severity, handled here explicitly.
          const existing = await DevAlert.findOne({ fingerprint }).select("count severity status").lean();
          const threshold = await getSetting("errors.notifyThreshold");
          const nextCount = (existing?.count || 0) + 1;

          const r = await upsertAlert({
            kind: "server-error",
            fingerprint,
            severity: nextCount >= threshold ? "critical" : "info",
            title: `${req.method} ${route} answered ${res.statusCode} (${nextCount}×)`,
            detail:
              nextCount >= threshold
                ? `This route has failed ${nextCount} times. The change history around the same moments may say what the callers were doing.`
                : "First occurrences are recorded quietly; developers are notified when it repeats.",
            evidence: [{ at: new Date(), method: req.method, path: route, status: res.statusCode }],
          });

          // Crossing the threshold on an EXISTING row: upsertAlert bumped the
          // severity but by design does not re-push repeats — this crossing is
          // the one repeat that is news.
          if (!r.isNew && nextCount === threshold && existing?.status !== "resolved") {
            const { notifyDevelopers } = require("../services/anomalyScan");
            await notifyDevelopers(r.alert).catch(() => {});
          }
        } catch {
          /* monitoring never becomes the problem */
        }
      });
    } catch {
      /* ditto */
    }
  });
  next();
};

module.exports.normalisePath = normalisePath;
