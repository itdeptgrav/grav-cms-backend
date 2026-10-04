// services/maintenance/maintenanceStorage.js
//
// IS THE DATABASE READY FOR MAINTENANCE — and the one step that makes it so.
//
// Two things must exist before Maintenance may write, and both are database
// protections rather than code:
//
//   1. the unique `maintenanceTag.code` index on `machines` — without it two
//      machines could, in a race, be issued one code;
//   2. the `maintenance_orders` collection WITH its unique `orderNumber` and
//      `idempotencyKey` indexes — without them two orders could share a number
//      and a retried "create" could land twice.
//
// Mongoose would build neither in production (autoIndex is off there), and it
// must not create the collection implicitly: the Atlas cluster is at its
// 500-collection cap, and an insert that silently created it would do so
// without the unique indexes. So:
//
//   · the tag index is built here, once per process, before the first tag is
//     issued (an index on an existing collection costs no collection slot);
//   · the orders collection is created only by `ensureOrderStorage`, called
//     from scripts/migrations/machine-maintenance-storage.js (and the tests),
//     never on a request. A request only ASKS whether it exists.
//
// ── THE V1 REPORTS ──────────────────────────────────────────────────────────
// `machine_maintenance_records` held the first version's breakdown reports.
// Orders replaced them (3 Oct 2026); the reports stay readable in history and
// nothing writes new ones. That collection is NEVER created here — a database
// that does not have it (Atlas) never needs it — only its missing indexes are
// added where it already exists.
"use strict";

const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const MaintenanceOrder = require("../../models/CMS_Models/Maintenance/MaintenanceOrder");
const MachineMaintenanceRecord = require("../../models/CMS_Models/Maintenance/MachineMaintenanceRecord");
const { tagIndexSpec } = require("../../models/CMS_Models/Inventory/Configurations/machineMaintenanceTag.schema");

const ORDERS = { name: MaintenanceOrder.COLLECTION, indexes: MaintenanceOrder.ORDER_INDEXES };
const LEGACY = { name: MachineMaintenanceRecord.COLLECTION, indexes: MachineMaintenanceRecord.RECORD_INDEXES };

/* A positive answer is kept for the life of the process — storage, once made,
   does not unmake itself. A negative one is asked again after this long, so
   running the migration takes effect without a restart. */
const NOT_READY_RECHECK_MS = 15 * 1000;

let tagIndexReady = false;
let ordersReady = false;
let ordersCheckedAt = 0;
/* The check in progress. Callers that arrive while it runs wait for ITS
   answer: a second caller once saw "checked just now" and answered "not
   ready" before the first had finished. */
let ordersInFlight = null;

function dbOf() {
  return Machine.db.db;
}

/** Builds the unique tag index on `machines` if it is missing. Idempotent. */
async function ensureTagIndex() {
  if (tagIndexReady) return;
  await Machine.collection.createIndex(...tagIndexSpec());
  tagIndexReady = true;
}

/** What one collection looks like now. Reads only. */
async function inspect(spec, db = dbOf()) {
  const exists = (await db.listCollections({ name: spec.name }, { nameOnly: true }).toArray()).length > 0;
  const all = spec.indexes.map((i) => i.options.name);
  const required = spec.indexes.filter((i) => i.required).map((i) => i.options.name);
  if (!exists) return { exists: false, missingIndexes: all, missingRequired: required };
  const present = new Set((await db.collection(spec.name).indexes()).map((i) => i.name));
  return { exists: true, missingIndexes: all.filter((n) => !present.has(n)), missingRequired: required.filter((n) => !present.has(n)) };
}

/** Adds an existing collection's missing indexes (and creates it when `create`). */
async function ensure(spec, { create, db }) {
  const before = await inspect(spec, db);
  const done = { collection: spec.name, createdCollection: false, createdIndexes: [] };
  if (!before.exists) {
    if (!create) return { ...done, state: before };
    await db.createCollection(spec.name);
    done.createdCollection = true;
  }
  const present = new Set((await db.collection(spec.name).indexes()).map((i) => i.name));
  for (const { key, options } of spec.indexes) {
    if (present.has(options.name)) continue;
    await db.collection(spec.name).createIndex({ ...key }, { ...options });
    done.createdIndexes.push(options.name);
  }
  return { ...done, state: await inspect(spec, db) };
}

const inspectOrderStorage = (db = dbOf()) => inspect(ORDERS, db);
const inspectLegacyStorage = (db = dbOf()) => inspect(LEGACY, db);

/** May an order be written? Cached: see NOT_READY_RECHECK_MS. */
async function orderStorageReady() {
  if (ordersReady) return true;
  if (ordersInFlight) return ordersInFlight;
  if (Date.now() - ordersCheckedAt < NOT_READY_RECHECK_MS) return false;
  ordersInFlight = (async () => {
    try {
      const state = await inspectOrderStorage();
      ordersReady = state.exists && state.missingRequired.length === 0;
      return ordersReady;
    } finally {
      ordersCheckedAt = Date.now();
      ordersInFlight = null;
    }
  })();
  return ordersInFlight;
}

/** The ONLY code that creates the orders collection. Returns what it did. */
async function ensureOrderStorage({ create = true, db = dbOf() } = {}) {
  const out = await ensure(ORDERS, { create, db });
  if (out.state.exists && out.state.missingRequired.length === 0) ordersReady = true;
  return out;
}

/** Indexes for the V1 reports where that collection exists. Never creates it. */
function ensureLegacyIndexes({ db = dbOf() } = {}) {
  return ensure(LEGACY, { create: false, db });
}

/** Test seam: forget what this process learned. */
function resetStorageCache() {
  tagIndexReady = false;
  ordersReady = false;
  ordersCheckedAt = 0;
  ordersInFlight = null;
}

module.exports = {
  ORDERS_COLLECTION: ORDERS.name,
  LEGACY_COLLECTION: LEGACY.name,
  ensureTagIndex,
  inspectOrderStorage,
  inspectLegacyStorage,
  orderStorageReady,
  ensureOrderStorage,
  ensureLegacyIndexes,
  resetStorageCache,
};
