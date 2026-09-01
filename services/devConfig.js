// services/devConfig.js
//
// Typed, cached access to the tunables the developer side can change live.
//
//   const { getSetting } = require("./devConfig");
//   const threshold = await getSetting("anomaly.flipflop.minChanges");
//
// THE CATALOGUE LIVES HERE, THE VALUES LIVE IN MONGO
// --------------------------------------------------
// DEFINITIONS is the complete list of keys that exist: type, default, label,
// group, and — for the ones that gate behaviour — what turning them changes.
// The UI renders from this catalogue and may only set values for keys in it;
// getSetting() falls back to the default when no row exists, so a fresh
// database behaves exactly like the code said it would before this file
// existed. Adding a tunable is one entry here, no migration.
//
// CACHED FOR 30s PER PROCESS
// --------------------------
// Settings are read on hot paths (the anomaly scanner, the error watcher). A
// Mongo read per check would make the monitoring the load. Thirty seconds
// means a change from the UI takes effect within half a minute everywhere —
// "instantly" on a human scale — without the store being on any request path.

"use strict";

const SystemSetting = require("../models/DevOps/SystemSetting");

/* eslint-disable key-spacing */
const DEFINITIONS = [
  /* ── Anomaly detection ─────────────────────────────────────────────── */
  { key: "anomaly.enabled", type: "boolean", default: true,
    group: "Anomaly detection", label: "Run the anomaly scan",
    description: "Master switch for the periodic scan over the change log. Alerts stop being raised while off; nothing is deleted." },
  { key: "anomaly.scanIntervalMinutes", type: "number", default: 15, min: 5, max: 240,
    group: "Anomaly detection", label: "Scan every (minutes)",
    description: "How often the change log is scanned. Applied on the next tick." },
  { key: "anomaly.flipflop.minChanges", perDepartment: true, type: "number", default: 3, min: 2, max: 20,
    group: "Anomaly detection", label: "Flip-flop: changes to the same field",
    description: "A field on one record changed this many times inside the window is flagged — the date-of-joining problem." },
  { key: "anomaly.flipflop.windowDays", perDepartment: true, type: "number", default: 14, min: 1, max: 90,
    group: "Anomaly detection", label: "Flip-flop: window (days)" },
  { key: "anomaly.sensitiveFields", perDepartment: true, type: "string",
    default: "salary,dateOfJoining,doj,bankAccount,accountNumber,ifsc,pan,gstin,aadhaar,email,password,role",
    group: "Anomaly detection", label: "Sensitive field names",
    description: "Comma-separated. A change whose field path contains one of these words is held to the stricter thresholds and flagged at higher severity." },
  { key: "anomaly.afterHours.enabled", perDepartment: true, type: "boolean", default: true,
    group: "Anomaly detection", label: "Flag after-hours edits" },
  { key: "anomaly.afterHours.startHour", perDepartment: true, type: "number", default: 7, min: 0, max: 23,
    group: "Anomaly detection", label: "Working day starts (IST hour)" },
  { key: "anomaly.afterHours.endHour", perDepartment: true, type: "number", default: 22, min: 1, max: 24,
    group: "Anomaly detection", label: "Working day ends (IST hour)" },
  { key: "anomaly.burst.maxWrites", perDepartment: true, type: "number", default: 40, min: 5, max: 500,
    group: "Anomaly detection", label: "Burst: writes by one person",
    description: "More writes than this by one account inside the burst window is flagged. Bulk imports are exempt (origin=import)." },
  { key: "anomaly.burst.windowMinutes", perDepartment: true, type: "number", default: 10, min: 1, max: 120,
    group: "Anomaly detection", label: "Burst: window (minutes)" },
  { key: "anomaly.deleteSpree.maxDeletes", perDepartment: true, type: "number", default: 5, min: 2, max: 100,
    group: "Anomaly detection", label: "Delete spree: deletes by one person" },
  { key: "anomaly.deleteSpree.windowMinutes", perDepartment: true, type: "number", default: 30, min: 1, max: 240,
    group: "Anomaly detection", label: "Delete spree: window (minutes)" },

  /* ── Server errors ─────────────────────────────────────────────────── */
  { key: "errors.watchEnabled", type: "boolean", default: true,
    group: "Server errors", label: "Record 5xx responses as alerts" },
  { key: "errors.notifyThreshold", type: "number", default: 3, min: 1, max: 100,
    group: "Server errors", label: "Notify after N occurrences",
    description: "A route must 500 this many times before developers are pushed to — one blip is a row in the feed, a pattern is a notification." },

  /* ── Notifications ─────────────────────────────────────────────────── */
  { key: "notify.pushEnabled", type: "boolean", default: true,
    group: "Notifications", label: "Push alerts to developers",
    description: "Sends to the registered browsers of everyone holding a role in the developer department." },
  { key: "notify.minSeverity", type: "string", default: "warn", enum: ["info", "warn", "critical"],
    group: "Notifications", label: "Minimum severity to push" },

  /* ── Operational controls ──────────────────────────────────────────── */
  /* These CHANGE BEHAVIOUR, not just observation — the "stop coding for every
     little thing" set. Each is enforced by Middlewear/opsControls.js, live
     within the 30s cache. Deliberately absent: anything that would turn off
     AUDITING — a kill-switch for the record of what happened is the one
     tunable this screen must never offer. */
  { key: "ops.freezeWrites.departments", type: "string", default: "", minRole: "approver",
    group: "Operational controls", label: "Freeze writes in departments",
    description: "Comma-separated slugs (hr, accounting, sales, store). Every write in a listed department answers 503 with a clear message; reading keeps working. For migrations, incidents, or stopping a runaway user NOW." },
  { key: "ops.afterHoursBlock.departments", type: "string", default: "", minRole: "approver",
    group: "Operational controls", label: "Block after-hours writes in",
    description: "Comma-separated slugs. Writes outside the working window (the after-hours hours above) are refused rather than merely flagged. Empty = observe only." },
  { key: "ops.freezeMessage", type: "string",
    default: "This area is temporarily read-only for maintenance. Nothing you had saved is lost.",
    group: "Operational controls", label: "Freeze message",
    description: "What a frozen department's users are told." },

  { key: "ops.extraOrigins", type: "string", default: "", minRole: "approver",
    group: "Operational controls", label: "Extra allowed origins (CORS)",
    description: "Comma-separated origins (https://host or http://host:port) allowed IN ADDITION to the ones in code — for preview deployments and LAN testing. This list can only add origins, never remove the built-in ones. Live within 30s.",
    validate: (v) => {
      const { isValidOrigin } = require("./allowedOrigins");
      const bad = String(v || "").split(",").map((x) => x.trim()).filter(Boolean).filter((o) => !isValidOrigin(o));
      if (bad.length) throw new Error(`Not valid origins (scheme://host[:port], no paths or wildcards): ${bad.join(", ")}`);
    } },

  /* ── Feature flags ─────────────────────────────────────────────────── */
  /* Each flag gates something REAL in the frontends, read from the public
     /api/feature-flags endpoint through lib/featureFlags. A flag nothing
     reads is a lie on a settings page — add the consumer with the key. */
  { key: "flag.voiceAssistant", type: "boolean", default: true,
    group: "Feature flags", label: "Global voice assistant",
    description: "The GRAV assistant overlay on every page (always-on mic + local model). Turn OFF to unmount it everywhere — the first suspect when tabs freeze." },
  { key: "flag.employeeExtraFields", type: "boolean", default: true,
    group: "Feature flags", label: "Employee extra fields",
    description: "The administrator-configured fields on employee records (Forms). OFF hides them from view/edit; stored values and server-side validation of submitted data remain." },

  /* ── Announcement ──────────────────────────────────────────────────── */
  { key: "notice.text", type: "string", default: "",
    group: "Announcement", label: "Banner text",
    description: "Shown as a strip above every dashboard (all departments) while non-empty. Clear it to take it down. Live within ~60s." },
  { key: "notice.tone", type: "string", default: "info", enum: ["info", "warn", "critical"],
    group: "Announcement", label: "Banner tone" },

  /* ── Housekeeping ──────────────────────────────────────────────────── */
  { key: "alerts.retentionDays", type: "number", default: 45, min: 3, max: 365,
    group: "Housekeeping", label: "Keep resolved alerts (days)",
    description: "Resolved alerts older than this are purged by the scan. Open and acknowledged alerts are never purged." },

  /* ── Jobs ──────────────────────────────────────────────────────────── */
  { key: "jobs.checkEnabled", type: "boolean", default: true,
    group: "Background jobs", label: "Alert on overdue jobs" },
];
/* eslint-enable key-spacing */

const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

const CACHE_TTL_MS = 30 * 1000;
let _cache = null; // Map(key -> value)
let _cachedAt = 0;

async function loadAll() {
  const rows = await SystemSetting.find({}).select("key value").lean();
  _cache = new Map(rows.map((r) => [r.key, r.value]));
  _cachedAt = Date.now();
  return _cache;
}

/** Drop the cache — called by setSetting so this process sees its own write. */
function invalidate() {
  _cache = null;
  _cachedAt = 0;
}

/**
 * The storage key for a per-department override. "@" cannot appear in a
 * catalogue key, so composites can never shadow a real definition.
 */
const compositeKey = (key, dept) => `${key}@${String(dept).toLowerCase().trim()}`;

/**
 * The current value of one key, resolved department-first.
 *
 * With `department`: the department's override wins, then the global value,
 * then the default — so a department is EXACTLY the global behaviour until
 * somebody deliberately makes it different, and clearing the override returns
 * it there. Keys not marked perDepartment ignore the department entirely
 * rather than silently accepting overrides that nothing reads.
 *
 * Unknown keys throw rather than returning undefined — a typo in a caller
 * should fail its harness, not silently disable a rule forever.
 */
async function getSetting(key, { department } = {}) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting "${key}" — add it to devConfig DEFINITIONS`);
  if (!_cache || Date.now() - _cachedAt > CACHE_TTL_MS) {
    try {
      await loadAll();
    } catch (err) {
      // Mongo hiccup: the default is the safe answer, and the next read retries.
      console.warn("[dev-config] falling back to defaults:", err.message);
      return def.default;
    }
  }
  if (department && def.perDepartment) {
    const ck = compositeKey(key, department);
    if (_cache.has(ck)) return _cache.get(ck);
  }
  return _cache.has(key) ? _cache.get(key) : def.default;
}

/** Coerce + bound a raw value against its definition. Throws on nonsense. */
function coerce(def, raw) {
  if (def.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "false") return raw === "true";
    throw new Error(`"${def.key}" wants true or false`);
  }
  if (def.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`"${def.key}" wants a number`);
    if (def.min !== undefined && n < def.min) throw new Error(`"${def.key}" must be at least ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new Error(`"${def.key}" must be at most ${def.max}`);
    return n;
  }
  const s = String(raw ?? "");
  if (def.enum && !def.enum.includes(s)) {
    throw new Error(`"${def.key}" must be one of: ${def.enum.join(", ")}`);
  }
  if (typeof def.validate === "function") def.validate(s);
  return s;
}

/**
 * Set one value. Only catalogued keys; typed and bounded.
 * @returns {{key, value, previous}}
 */
async function setSetting(key, rawValue, actor = {}, { department, inherit } = {}) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting "${key}"`);
  if (department && !def.perDepartment) {
    throw new Error(`"${key}" is a global setting — it has no per-department value`);
  }

  const storeKey = department ? compositeKey(key, department) : key;

  // `inherit` removes a department's override so the global value applies
  // again — deletion, not writing the global value in, so a later global
  // change flows through.
  if (inherit) {
    if (!department) throw new Error("Only a department override can be set back to inherit");
    const gone = await SystemSetting.findOneAndDelete({ key: storeKey });
    invalidate();
    return { key, department, inherited: true, previous: gone ? gone.value : undefined };
  }

  const value = coerce(def, rawValue);

  const existing = await SystemSetting.findOne({ key: storeKey });
  const previous = existing ? existing.value : def.default;

  await SystemSetting.findOneAndUpdate(
    { key: storeKey },
    {
      $set: {
        value,
        updatedByEmail: String(actor.email || "").toLowerCase(),
        updatedByName: actor.name || "",
      },
      $push: {
        history: {
          $each: [{ at: new Date(), byEmail: actor.email || "", byName: actor.name || "", from: previous, to: value }],
          $position: 0,
          $slice: 20,
        },
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  invalidate();
  return { key, value, previous, department: department || undefined };
}

/**
 * The whole catalogue with current values, grouped for the settings page.
 *
 * With `department`: only the perDepartment keys, each showing the value that
 * department actually GETS, whether it is its own override or inherited from
 * global — `overridden` says which, so the page can offer "back to inherit".
 */
async function listSettings({ department } = {}) {
  let stored = new Map();
  try {
    stored = await loadAll();
  } catch {
    /* defaults render; the page still works */
  }
  const rows = await SystemSetting.find({})
    .select("key updatedByEmail updatedByName updatedAt history")
    .lean();
  const meta = new Map(rows.map((r) => [r.key, r]));

  const defs = department ? DEFINITIONS.filter((d) => d.perDepartment) : DEFINITIONS;

  return defs.map((d) => {
    const ck = department ? compositeKey(d.key, department) : d.key;
    const overridden = department ? stored.has(ck) : false;
    const readKey = overridden ? ck : d.key;
    const m = meta.get(readKey);
    return {
      key: d.key,
      type: d.type,
      group: d.group,
      label: d.label,
      description: d.description || "",
      min: d.min,
      max: d.max,
      enum: d.enum,
      default: d.default,
      perDepartment: Boolean(d.perDepartment),
      minRole: d.minRole || "editor",
      department: department || undefined,
      overridden,
      globalValue: stored.has(d.key) ? stored.get(d.key) : d.default,
      value: stored.has(readKey) ? stored.get(readKey) : stored.has(d.key) ? stored.get(d.key) : d.default,
      isDefault: !stored.has(readKey) && !stored.has(d.key),
      updatedBy: m?.updatedByName || m?.updatedByEmail || "",
      updatedAt: m?.updatedAt || null,
      history: m?.history || [],
    };
  });
}

/** The sensitive-field list as lowercased words, ready for matching. */
async function sensitiveWords(department) {
  const raw = await getSetting("anomaly.sensitiveFields", { department });
  return String(raw || "")
    .split(",")
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** A comma-separated slug setting, as a lowercased Set. */
async function slugSet(key) {
  const raw = await getSetting(key);
  return new Set(
    String(raw || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  );
}

module.exports = {
  DEFINITIONS,
  slugSet,
  getSetting,
  setSetting,
  listSettings,
  sensitiveWords,
  invalidate,
};
