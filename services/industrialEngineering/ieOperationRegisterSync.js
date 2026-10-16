// services/industrialEngineering/ieOperationRegisterSync.js
//
// THE IE LIBRARY HOLDS THE FACTORY'S OPERATIONS (15 Oct 2026, owner).
//
// The owner: operations "are showing in the stock item operations tab, but on
// the IE side it's not showing - fix that section completely, as per the
// concept". The factory has ONE list of operations: the global register
// (`Operation` - stock items, the scanners' Ops QR, QC and costing all read
// it). IE's company library (`IeOperation`) was a second, empty list beside
// it, and the bulletin's operation picker and the line templates read only
// the library - so IE could pick nothing the factory actually does.
//
// This keeps the library in step with the register, one way, register first:
//
//   - every register operation has exactly one library row in the company,
//     linked by `legacyOperationId`;
//   - a new register operation gets a library row; a renamed or re-typed one
//     has its row updated; one deleted from the register has its row RETIRED
//     (never deleted - a bulletin may name it);
//   - library rows created in the library alone (no link) are left untouched.
//
// THE CODE RULE. The library allows one ACTIVE code per company (a unique
// index); the register does not, and 15 of its codes appear twice. The first
// register row keeps the code; any later one takes `<code>-<last 4 of its id>`
// with the register's code kept as an alias, so a search for "TS011" still
// finds both. A register row with no code takes `OP-<last 6 of its id>`.
//
// Run before every library read, at most once per company every
// SYNC_INTERVAL_MS, and concurrent callers share one run.

"use strict";

const mongoose = require("mongoose");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");

const { LIMITS, normaliseCode, displayCode } = IeOperation;
const SYNC_INTERVAL_MS = Number(process.env.IE_OPERATION_SYNC_MS || 15000);
const SYNCED_BY = "Operation register";

const lastRun = new Map(); // companyId -> ms
const running = new Map(); // companyId -> Promise

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const suffixOf = (id, n) => String(id).slice(-n).toUpperCase();

/** The code a register row wants, before collisions are settled. */
function wantedCode(op) {
  const c = displayCode(op.operationCode || "");
  return c ? c.slice(0, LIMITS.CODE) : `OP-${suffixOf(op._id, 6)}`;
}

async function runSync(companyId) {
  const [register, mirrored] = await Promise.all([
    Operation.find({}).select("_id name operationCode machineType createdAt").sort({ createdAt: 1, _id: 1 }).lean(),
    IeOperation.find({ companyId })
      .select("_id code codeNormalised name machineType aliases status legacyOperationId").lean(),
  ]);

  const byLegacy = new Map();
  const activeCodeHolder = new Map(); // codeNormalised -> library _id (string)
  for (const row of mirrored) {
    if (row.legacyOperationId) byLegacy.set(String(row.legacyOperationId), row);
    if (row.status === "ACTIVE") activeCodeHolder.set(row.codeNormalised, String(row._id));
  }

  const now = new Date();
  const creates = [];
  const updates = [];
  const seen = new Set();

  for (const op of register) {
    const key = String(op._id);
    seen.add(key);
    const existing = byLegacy.get(key);
    const want = wantedCode(op);
    const name = clip(op.name, LIMITS.NAME) || want;
    const machineType = clip(op.machineType, LIMITS.MACHINE_TYPE);

    // Settle the code: the register's own, unless another ACTIVE row holds it.
    const holder = activeCodeHolder.get(normaliseCode(want));
    const mine = Boolean(existing) && holder === String(existing._id);
    const free = !holder || mine;
    const code = free ? want : `${want}-${suffixOf(op._id, 4)}`.slice(0, LIMITS.CODE);
    const aliases = code !== want && op.operationCode ? [clip(op.operationCode, LIMITS.ALIAS)] : [];

    if (!existing) {
      creates.push({
        companyId, code, name, machineType, aliases, status: "ACTIVE", revision: 1,
        legacyOperationId: op._id, createdByName: SYNCED_BY, updatedByName: SYNCED_BY,
      });
      activeCodeHolder.set(normaliseCode(code), `new:${key}`);
      continue;
    }

    const set = {};
    if (existing.status !== "ACTIVE" && free) {
      set.status = "ACTIVE";
      set.statusChangedAt = now;
      set.statusChangedByName = SYNCED_BY;
    }
    if (existing.name !== name) set.name = name;
    if ((existing.machineType || "") !== machineType) set.machineType = machineType;
    // Re-code only when the register's own code changed and it is free here.
    if (free && normaliseCode(existing.code) !== normaliseCode(want)) {
      set.code = want;
      set.codeNormalised = normaliseCode(want);
      activeCodeHolder.delete(existing.codeNormalised);
      activeCodeHolder.set(set.codeNormalised, String(existing._id));
    }
    if (Object.keys(set).length) {
      updates.push({
        updateOne: {
          filter: { _id: existing._id, companyId },
          update: { $set: { ...set, updatedByName: SYNCED_BY }, $inc: { revision: 1 } },
        },
      });
    }
  }

  // Gone from the register -> retired here, never deleted.
  for (const row of mirrored) {
    if (!row.legacyOperationId || row.status !== "ACTIVE") continue;
    if (seen.has(String(row.legacyOperationId))) continue;
    updates.push({
      updateOne: {
        filter: { _id: row._id, companyId, status: "ACTIVE" },
        update: {
          $set: {
            status: "RETIRED", statusChangedAt: now,
            statusChangedByName: `${SYNCED_BY} (deleted there)`, updatedByName: SYNCED_BY,
          },
          $inc: { revision: 1 },
        },
      },
    });
  }

  let created = 0;
  if (creates.length) {
    // insertMany does not run the schema's pre-validate hook, so the
    // normalised code is set here, the same way that hook would.
    const docs = creates.map((d) => ({
      ...d, code: displayCode(d.code), codeNormalised: normaliseCode(d.code), createdAt: now, updatedAt: now,
    }));
    try {
      const out = await IeOperation.insertMany(docs, { ordered: false });
      created = out.length;
    } catch (err) {
      // A code taken meanwhile by a row created in the library: the rest went in;
      // the next run retries the remainder.
      created = err?.insertedDocs?.length || 0;
      console.warn("[ieOperationRegisterSync] some rows were not inserted:", err.message);
    }
  }
  if (updates.length) {
    await IeOperation.bulkWrite(updates, { ordered: false })
      .catch((e) => console.warn("[ieOperationRegisterSync] update:", e.message));
  }
  return { register: register.length, created, updated: updates.length };
}

/**
 * Bring this company's library in step with the register. Cheap when nothing
 * changed; skipped when it ran for this company within SYNC_INTERVAL_MS
 * unless `force`. Never throws: a failed sync leaves the library as it was.
 */
async function syncLibraryFromRegister(companyId, { force = false } = {}) {
  if (!companyId) return null;
  const key = String(companyId);
  if (running.has(key)) return running.get(key);
  if (!force && Date.now() - (lastRun.get(key) || 0) < SYNC_INTERVAL_MS) return null;
  const id = mongoose.Types.ObjectId.isValid(key) ? new mongoose.Types.ObjectId(key) : companyId;
  const p = runSync(id)
    .then((r) => { lastRun.set(key, Date.now()); return r; })
    .catch((e) => { console.warn("[ieOperationRegisterSync] failed:", e.message); return null; })
    .finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

module.exports = { syncLibraryFromRegister, wantedCode };
