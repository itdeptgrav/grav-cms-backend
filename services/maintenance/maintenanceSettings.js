// services/maintenance/maintenanceSettings.js
//
// MAINTENANCE SETTINGS — which Item Master types Maintenance may see.
//
// ── WHERE IT LIVES ──────────────────────────────────────────────────────────
// One row in `system_settings` (models/DevOps/SystemSetting.js), key
// `maintenance.visibleItemTypes`, value = the list of types. That is the CMS's
// existing store for a value somebody changes without a deploy: it records who
// changed it and keeps the last twenty values on the row. A collection of its
// own was not an option — the Atlas cluster is at its 500-collection cap.
//
// The key is deliberately NOT in services/devConfig.js DEFINITIONS: that
// catalogue is the developer side's tunables, rendered on /developer/settings.
// This is a department's business setting, edited by Maintenance's owner on
// Maintenance → Settings. devConfig reads only the keys it defines, so this row
// is invisible to it.
//
// ── ASSET IS ALWAYS IN ──────────────────────────────────────────────────────
// Machines and equipment are assets; Maintenance must always see them. So
// `normaliseVisibleTypes` puts "Asset" first in EVERY list it returns — on
// read and on write — and no request can take it out. The screen shows it as
// "Required"; the server is what makes that true.
//
// ── TYPES ARE FREE TEXT, AS IN THE STORE ────────────────────────────────────
// `RawItem.productType` is free text: the Store offers seven names
// (MATERIAL_TYPES in the CMS) and "Add Manually" for any other. So a saved
// type is any trimmed name up to 80 characters, compared without case. One
// extra choice, `NOT_CLASSIFIED`, stands for items with no type at all
// (owner, 3 Oct 2026: "whatever can choose") — 297 of 309 items had none.
"use strict";

const SystemSetting = require("../../models/DevOps/SystemSetting");

const KEY = "maintenance.visibleItemTypes";
const REQUIRED_TYPE = "Asset";
const NOT_CLASSIFIED = "__not_classified__";
const MAX_TYPES = 50;
const MAX_LENGTH = 80;
const HISTORY_KEEP = 20;

/** Asset first, then each distinct type once (case-insensitive), in order. */
function normaliseVisibleTypes(input) {
  const out = [REQUIRED_TYPE];
  const seen = new Set([REQUIRED_TYPE.toLowerCase()]);
  for (const raw of Array.isArray(input) ? input : []) {
    const type = String(raw ?? "").trim().slice(0, MAX_LENGTH);
    if (!type) continue;
    const k = type.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(type);
    if (out.length >= MAX_TYPES) break;
  }
  return out;
}

async function readRow() {
  return SystemSetting.findOne({ key: KEY }).lean();
}

/** The types Maintenance may see now. Never empty; always contains Asset. */
async function getVisibleItemTypes() {
  const row = await readRow();
  return normaliseVisibleTypes(row?.value);
}

/** What the settings screen needs to say who changed it last. */
async function settingsMeta() {
  const row = await readRow();
  return {
    visibleItemTypes: normaliseVisibleTypes(row?.value),
    saved: Boolean(row),
    updatedAt: row?.updatedAt || null,
    updatedByName: row?.updatedByName || "",
  };
}

/** Saves the list (Asset forced in) and keeps the previous value on the row. */
async function setVisibleItemTypes(input, user = {}) {
  const next = normaliseVisibleTypes(input);
  const row = await readRow();
  const previous = row ? normaliseVisibleTypes(row.value) : null;
  const byEmail = String(user.email || "").toLowerCase();
  const byName = String(user.name || "");
  await SystemSetting.updateOne(
    { key: KEY },
    {
      $set: { value: next, updatedByEmail: byEmail, updatedByName: byName },
      $push: { history: { $each: [{ at: new Date(), byEmail, byName, from: previous, to: next }], $position: 0, $slice: HISTORY_KEEP } },
    },
    { upsert: true },
  );
  return next;
}

module.exports = {
  KEY,
  REQUIRED_TYPE,
  NOT_CLASSIFIED,
  normaliseVisibleTypes,
  getVisibleItemTypes,
  settingsMeta,
  setVisibleItemTypes,
};
