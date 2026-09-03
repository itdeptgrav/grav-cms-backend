// Middlewear/opsControls.js
//
// The developer side's two RESTRICTIONS, enforced on every request.
//
//   ops.freezeWrites.departments     "hr, accounting" → every write in those
//                                    departments answers 503; reads untouched.
//                                    For a migration, an incident, or stopping
//                                    a runaway user in the next thirty seconds
//                                    instead of the next deploy.
//   ops.afterHoursBlock.departments  writes outside the working window are
//                                    REFUSED (403) rather than merely flagged
//                                    by the anomaly scan.
//
// Both lists are live settings — the whole point is that turning them on is a
// dropdown on /developer/settings, not a commit. Both fail OPEN on any error:
// an ops control that can take the system down when Mongo hiccups has become
// the incident it exists to manage.
//
// WHAT IS NEVER BLOCKED, even when listed: sign-in (locking everyone out of
// the door removes the people who could fix it), the admin and developer APIs
// (the freeze must be liftable from the very screen that set it), and
// read-shaped POSTs (a frozen department can still search and export).

"use strict";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Which URL prefixes belong to which department slug.
 *
 * Static and conservative: a slug not listed here simply cannot be frozen,
 * which is the safe failure. Kept in step with the mounts in server.js by
 * verifyDeveloperSide's coverage of the ones that matter.
 */
const DEPARTMENT_PREFIXES = {
  hr: ["/api/hr", "/hr/", "/api/employees"],
  accounting: ["/api/accountant"],
  sales: ["/api/cms/sales", "/api/cms/crm"],
  store: ["/api/cms/store", "/api/cms/inventory"],
  "project-manager": ["/api/cms/pm", "/api/cms/manufacturing"],
  qc: ["/api/cms/qc"],
};

const NEVER_BLOCKED = ["/api/auth", "/api/dev", "/api/admin", "/login", "/api/accountant/auth"];

/** Fragments that make a POST a read — borrowed from the write guard. */
let READ_SHAPED = null;
function readShaped(path) {
  if (!READ_SHAPED) READ_SHAPED = require("./departmentWriteGuard").READ_SHAPED;
  const p = String(path).toLowerCase().split("?")[0];
  return READ_SHAPED.some((frag) => p.includes(frag));
}

function slugOf(path) {
  const p = String(path).toLowerCase();
  for (const [slug, prefixes] of Object.entries(DEPARTMENT_PREFIXES)) {
    if (prefixes.some((pre) => p.startsWith(pre))) return slug;
  }
  return null;
}

/**
 * The decision, separated from Express so the harness can drive it with a
 * pinned clock and fake settings.
 *
 * @returns {null | {status, code, message}}
 */
async function decide({ method, path, now = new Date() }, settings) {
  if (READ_METHODS.has(method)) return null;
  const low = String(path).toLowerCase();
  if (NEVER_BLOCKED.some((pre) => low.startsWith(pre))) return null;
  if (readShaped(path)) return null;

  const slug = slugOf(path);
  if (!slug) return null;

  if (settings.frozen.has(slug)) {
    return {
      status: 503,
      code: "DEPARTMENT_FROZEN",
      message: settings.freezeMessage,
    };
  }

  if (settings.afterHoursBlocked.has(slug)) {
    // IST, the codebase's own convention.
    const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
    const hour = ist.getUTCHours();
    if (hour < settings.startHour || hour >= settings.endHour) {
      return {
        status: 403,
        code: "AFTER_HOURS",
        message:
          `Changes here are only accepted between ${settings.startHour}:00 and ` +
          `${settings.endHour}:00 IST. Reading still works; your edit was not saved.`,
      };
    }
  }
  return null;
}

async function loadSettings() {
  const { getSetting, slugSet } = require("../services/devConfig");
  return {
    frozen: await slugSet("ops.freezeWrites.departments"),
    afterHoursBlocked: await slugSet("ops.afterHoursBlock.departments"),
    freezeMessage: await getSetting("ops.freezeMessage"),
    startHour: await getSetting("anomaly.afterHours.startHour"),
    endHour: await getSetting("anomaly.afterHours.endHour"),
  };
}

module.exports = async function opsControls(req, res, next) {
  try {
    // The common case exits before touching settings at all.
    if (READ_METHODS.has(req.method)) return next();

    const settings = await loadSettings();
    if (settings.frozen.size === 0 && settings.afterHoursBlocked.size === 0) return next();

    const verdict = await decide(
      { method: req.method, path: req.originalUrl || req.url },
      settings,
    );
    if (!verdict) return next();
    res.status(verdict.status).json({ success: false, code: verdict.code, message: verdict.message });
  } catch (err) {
    // Fail open — see the header.
    console.warn("[ops-controls]", err.message);
    next();
  }
};

module.exports.decide = decide;
module.exports.loadSettings = loadSettings;
module.exports.DEPARTMENT_PREFIXES = DEPARTMENT_PREFIXES;
