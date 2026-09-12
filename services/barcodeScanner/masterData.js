// services/barcodeScanner/masterData.js
//
// Machines, operators, operations and work orders — the master data every
// scanner dashboard joins its scans against.
//
// This used to live in the standalone barcode server (barcode/lib/masterData.js),
// where it had already been cut down from a version that opened a SECOND
// connection to a hosted Atlas cluster and carried a 5-minute TTL, a 20-second
// fallback TTL, a local-mirror fallback and a DNS workaround — all of it
// machinery for reading master data across the internet from the factory PC.
//
// Merged into the CMS backend (11 Sep 2026) there is not even a second process:
// these are the CMS's own collections, on the CMS's own connection. Nothing is
// mirrored and nothing can go stale.
//
// The short cache is the only thing kept, and only because a wall-mounted
// dashboard polls every 15 seconds and re-reading ~560 documents each time —
// per open browser — is pure waste.

const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee = require("../../models/Employee");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { displayWorkOrderNumber } = require("../manufacturing/workOrderNumber");

const TTL_MS = Number(process.env.MASTER_TTL_MS || 10 * 1000);

let cache = null;
let cachedAt = 0;
let lastError = null;

/**
 * A barcode carries the LAST 8 HEX of the WorkOrder _id (WO-359e7172-009).
 *
 * WorkOrder has no shortId field of its own — it only ever existed because the
 * old sync script computed one on the way down to the factory PC. Deriving it
 * here keeps barcode lookups working without denormalising a field back into
 * the CMS's own collection.
 */
const shortIdOf = (doc) => String(doc._id).slice(-8);

async function load() {
  const [machines, operators, operations, workOrdersRaw] = await Promise.all([
    Machine.find(
      {},
      { name: 1, serialNumber: 1, type: 1, status: 1, location: 1 }
    ).lean(),
    Employee.find(
      { status: "active" },
      { identityId: 1, biometricId: 1, firstName: 1, lastName: 1 }
    ).lean(),
    Operation.find(
      { operationCode: { $nin: [null, ""] } },
      { operationCode: 1, name: 1, totalSam: 1, durationSeconds: 1, machineType: 1 }
    ).lean(),
    WorkOrder.find(
      {},
      {
        /* Stored on NEW work orders only: the model's pre("validate") hook is
           guarded on isNew, so all 143 pre-existing rows have it empty and the
           backfill migration has not been run. displayWorkOrderNumber() below
           fills the gap with the WO-<short id> form the barcodes already use,
           and yields to the stored value if the migration is ever applied. */
        workOrderNumber: 1,
        stockItemName: 1,
        stockItemReference: 1,
        customerName: 1,
        quantity: 1,
        status: 1,
        stockItemId: 1,
      }
    ).lean(),
  ]);

  const workOrders = workOrdersRaw.map((w) => ({
    ...w,
    shortId: shortIdOf(w),
    workOrderNumber: displayWorkOrderNumber(w),
  }));
  return { machines, operators, operations, workOrders };
}

/**
 * @param {boolean} force bypass the cache (a manual refresh)
 * @returns {Promise<{machines,operators,operations,workOrders,source,fetchedAt}>}
 */
async function getMasterData({ force = false } = {}) {
  if (cache && !force && Date.now() - cachedAt < TTL_MS) {
    return { ...cache, source: "db", fetchedAt: new Date(cachedAt), cached: true };
  }
  try {
    cache = await load();
    cachedAt = Date.now();
    lastError = null;
    return { ...cache, source: "db", fetchedAt: new Date(cachedAt), cached: false };
  } catch (err) {
    lastError = err.message;
    // Mongo being down is a real outage, not a degraded-but-working state.
    // Serve the last good read if there is one so a wall screen does not blank
    // out mid-shift, and say plainly that it is stale.
    if (cache) {
      return {
        ...cache,
        source: "db-stale",
        fetchedAt: new Date(cachedAt),
        cached: true,
        error: err.message,
      };
    }
    return {
      machines: [],
      operators: [],
      operations: [],
      workOrders: [],
      source: "unavailable",
      fetchedAt: null,
      error: err.message,
    };
  }
}

// ─── Lookups built from one read ──────────────────────────────────────────────

/** Operators badge in with EITHER id — see ./operators.js for the full note. */
function operatorNameResolver(master) {
  const byId = new Map();
  for (const e of master.operators || []) {
    const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
    if (!name) continue;
    if (e.biometricId && !byId.has(e.biometricId)) byId.set(e.biometricId, name);
    if (e.identityId) byId.set(e.identityId, name);
  }
  return (id) => byId.get(id) || id || "";
}

function machineMap(master) {
  return new Map((master.machines || []).map((m) => [String(m._id), m]));
}

function workOrderMap(master) {
  return new Map((master.workOrders || []).map((w) => [w.shortId, w]));
}

/** operationCode -> target seconds per piece. durationSeconds wins; SAM is the fallback. */
function operationTargets(master) {
  const map = new Map();
  for (const op of master.operations || []) {
    const seconds =
      Number(op.durationSeconds) > 0
        ? Number(op.durationSeconds)
        : Number(op.totalSam) > 0
        ? Number(op.totalSam) * 60
        : null;
    if (seconds) map.set(String(op.operationCode).trim(), seconds);
  }
  return map;
}

function health() {
  return {
    source: "db",
    lastReadAt: cachedAt ? new Date(cachedAt) : null,
    cacheAgeMs: cachedAt ? Date.now() - cachedAt : null,
    ttlMs: TTL_MS,
    lastError,
  };
}

/** Drop the cache — used after a master-data import so screens pick it up now. */
function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = {
  getMasterData,
  operatorNameResolver,
  machineMap,
  workOrderMap,
  operationTargets,
  health,
  invalidate,
};
