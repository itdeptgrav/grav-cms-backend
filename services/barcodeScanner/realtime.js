// services/barcodeScanner/realtime.js
//
// Socket.IO push for the production-supervisor dashboard.
//
// The standalone barcode server created its OWN Socket.IO server here. Merged
// into the CMS backend there is already one — with the same `join-workorder` /
// `leave-workorder` rooms the floor pages use — so this module no longer
// listens for anything. It only emits, through the io instance server.js
// registers with `app.set("io", io)`.
//
// Event names are the ones useProductionSocket already handles, unchanged:
//
//   tracking-data-updated      broadcast — something changed, refetch
//   workorder-scan-update      room `workorder-<id>`
//   operator-status-update     broadcast — sign in / sign out
//
// TWO CADENCES, ON PURPOSE
//   · A scan emits immediately, so a tile flashes within a second of the
//     barcode being read. That is the "feels live" path.
//   · The rollup emits after each recompute, so the numbers behind the tiles
//     settle to their accurate values.
// Emitting only on the rollup would make the floor feel dead for up to a
// minute; emitting only on scan would show counts that never reconcile.
//
// Nothing here is required for correctness. If no dashboard is connected, or
// Socket.IO fails entirely, scans still land in Mongo and the rollup still
// runs — the dashboard just falls back to its polling interval.

let io = null;

/**
 * Hand this module the server's existing Socket.IO instance. Called once from
 * server.js, right after `app.set("io", io)`.
 */
function attach(existingIo) {
  io = existingIo || null;
  return io;
}

function clientCount() {
  return io ? io.engine.clientsCount : 0;
}

/**
 * A batch of events was just ingested.
 *
 * Called from the ingest path, which is the hot one — 50 devices, one call per
 * scan. So this stays a fire-and-forget broadcast of a SUMMARY, never the
 * documents themselves: the dashboard refetches through the normal endpoints,
 * which are indexed and cached. Pushing full payloads here would put the
 * ingest path on the critical path of every connected browser.
 */
function emitScans(events) {
  if (!io || !events || events.length === 0) return;

  const scans = events.filter((e) => e.type === "scan");
  const signInOut = events.filter(
    (e) => e.type === "signin" || e.type === "signout"
  );

  if (scans.length > 0) {
    io.emit("tracking-data-updated", {
      reason: "scan",
      count: scans.length,
      machineIds: [...new Set(scans.map((e) => String(e.machineId)))],
      at: new Date().toISOString(),
    });

    // Per-work-order rooms, for anyone watching a single WO.
    const byWorkOrder = new Map();
    for (const e of scans) {
      if (!e.workOrderKey) continue;
      byWorkOrder.set(e.workOrderKey, (byWorkOrder.get(e.workOrderKey) || 0) + 1);
    }
    for (const [key, count] of byWorkOrder) {
      io.to(`workorder-${key}`).emit("workorder-scan-update", {
        workOrderShortId: key,
        count,
        at: new Date().toISOString(),
      });
    }
  }

  if (signInOut.length > 0) {
    io.emit("operator-status-update", {
      changes: signInOut.map((e) => ({
        type: e.type,
        operatorId: e.operatorId,
        machineId: String(e.machineId),
      })),
      at: new Date().toISOString(),
    });
  }
}

/** The rollup finished — the derived numbers are now accurate. */
function emitRollup(result) {
  if (!io || !result || result.skipped) return;
  io.emit("tracking-data-updated", {
    reason: "rollup",
    machines: result.machines,
    operators: result.operators,
    pieces: result.pieces,
    at: new Date().toISOString(),
  });
}

module.exports = { attach, emitScans, emitRollup, clientCount };
