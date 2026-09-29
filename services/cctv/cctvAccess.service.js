// services/cctv/cctvAccess.service.js
//
// THE ONE ANSWER TO "WHAT MAY THIS PERSON DO IN CCTV?"
//
//   resolveCctvAccess(actor)
//     -> { allowed, admin, denialCode, message, person: { email, name },
//          cameras: [{ key, live, audio, playback }] }
//
// The CCTV site (cctv.grav.in, a separate Python app) asks this through
// GET /api/cctv/internal/access on every sign-in and again every few seconds
// while somebody watches, so a change here reaches an open viewer within
// moments. It never decides from a token claim: the identity is re-read from
// the database exactly as every other access check does
// (services/access/appAccess.service.js → verifiedIdentity).
//
// ── PRECEDENCE (decided 28 Sep 2026) ──────────────────────────────────────
//   1. A database-verified PLATFORM ADMINISTRATOR: every camera, live, sound
//      and playback, and the CCTV camera settings. No per-camera setup.
//   2. CCTV cameras are given to PEOPLE (employee sign-ins). A shared
//      department login that is not an administrator gets none — every viewer
//      is a named person in the audit.
//   3. THE DEPARTMENT GATE: the person must hold (primary or additional) an
//      active department whose "CCTV camera access" toggle (cctvEnabled) is on.
//      Switching a department's toggle off closes CCTV for everyone in it.
//   4. THE PERSON'S CAMERAS: the `cctv` grant row (DepartmentRole, slug fixed
//      in code — there is no CCTV department) lists each camera and whether
//      they may watch it live, hear it, and play its recordings back. No row,
//      or an empty one, is NO cameras — never every camera.
//
// Failure is never access: a lookup error is ACCESS_CHECK_UNAVAILABLE.
"use strict";

const CCTV_APP = "cctv";

/** The CCTV app's stable camera key: "<nvr>:<channel>" — see grav-cctv camera_settings.py. */
const CAMERA_KEY = /^nvr[0-9]{1,2}:[0-9]{1,3}$/;
const MAX_CAMERAS = 256;

const DENIAL = Object.freeze({
  CCTV_PEOPLE_ONLY: "CCTV_PEOPLE_ONLY",
  CCTV_NOT_ENABLED: "CCTV_NOT_ENABLED",
  ACCESS_CHECK_UNAVAILABLE: "ACCESS_CHECK_UNAVAILABLE",
});

const MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Sign in to the GRAV CMS first.",
  IDENTITY_NOT_FOUND: "Your account could not be found. Sign in to the GRAV CMS again.",
  IDENTITY_INACTIVE: "Your account is deactivated.",
  SESSION_REVOKED: "Your session was signed out. Sign in to the GRAV CMS again.",
  AMBIGUOUS_IDENTITY: "Your email belongs to more than one account. Ask an administrator to merge them.",
  CCTV_PEOPLE_ONLY: "CCTV cameras are given to named people. Sign in with your own work email, not a shared department login.",
  CCTV_NOT_ENABLED: "CCTV is not enabled for your department. Ask an administrator to enable it in Access Control.",
  ACCESS_CHECK_UNAVAILABLE: "Your CCTV access could not be checked just now. Try again in a moment.",
});

/**
 * One camera entry as the grant stores it, or null when it grants nothing.
 * Sound needs a picture: audio without live or playback is dropped with the
 * entry. Unknown keys are the caller's problem — see normaliseCameraList.
 */
function normaliseCamera(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? "").trim().toLowerCase();
  const live = raw.live === true;
  const playback = raw.playback === true;
  if (!live && !playback) return null;
  return { key, live, audio: raw.audio === true, playback };
}

/**
 * Validate and normalise a requested camera list. Duplicates are merged (any
 * permission on either copy wins); entries granting nothing are dropped; the
 * result is sorted by key so equal grants compare equal.
 * @returns {{ cameras: Array, invalid: string[] }}
 */
function normaliseCameraList(list) {
  const invalid = [];
  const byKey = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const key = String(raw?.key ?? "").trim().toLowerCase();
    if (!CAMERA_KEY.test(key)) { invalid.push(String(raw?.key ?? "")); continue; }
    const cam = normaliseCamera(raw);
    if (!cam) continue;
    const prev = byKey.get(key);
    byKey.set(key, prev
      ? { key, live: prev.live || cam.live, audio: prev.audio || cam.audio, playback: prev.playback || cam.playback }
      : cam);
  }
  const cameras = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { cameras, invalid, tooMany: cameras.length > MAX_CAMERAS };
}

/** A stored row's cameras, read defensively (a hand-edited row cannot widen access). */
function camerasOfRow(row) {
  if (!row || row.isActive === false) return [];
  return normaliseCameraList(row.cctvCameras || []).cameras;
}

const deny = (denialCode, person = null) => ({
  allowed: false, admin: false, denialCode, message: MESSAGES[denialCode] || MESSAGES.ACCESS_CHECK_UNAVAILABLE,
  person, cameras: [],
});

/**
 * @param {object} actorLike  { id, subject, tv, email } — a CMS session's
 *   identifiers (req.user) or the claims of a CCTV sign-in. Authority is
 *   always re-read; nothing here is trusted beyond "which identity".
 */
async function resolveCctvAccess(actorLike) {
  const { verifiedIdentity, actorFrom } = require("../access/appAccess.service");
  const actor = actorFrom(actorLike);
  try {
    const identity = await verifiedIdentity(actor);
    if (!identity.ok) return deny(identity.code);

    const email = identity.emails[0] || actor.email || "";
    const person = { email, name: await personName(identity) };

    if (identity.isPlatformAdmin) {
      return { allowed: true, admin: true, denialCode: null, message: "", person, cameras: [] };
    }
    if (identity.kind !== "employee") return deny(DENIAL.CCTV_PEOPLE_ONLY, person);

    const AccessDepartment = require("../../models/Access/AccessDepartment");
    const gate = await AccessDepartment.exists({
      _id: { $in: identity.assignedDeptIds }, isActive: true, cctvEnabled: true,
    });
    if (!gate) return deny(DENIAL.CCTV_NOT_ENABLED, person);

    const DepartmentRole = require("../../models/Access/DepartmentRole");
    const rows = await DepartmentRole.find({ departmentSlug: CCTV_APP, email: { $in: identity.emails }, isActive: true })
      .select("email cctvCameras isActive").lean();
    // A person known by two addresses holding two rows: the union, as roleFor
    // takes the strongest role across addresses.
    const cameras = normaliseCameraList(rows.flatMap((r) => camerasOfRow(r))).cameras;
    return { allowed: true, admin: false, denialCode: null, message: "", person, cameras };
  } catch (err) {
    console.error("[cctvAccess] access check failed:", err?.message || err);
    return deny(DENIAL.ACCESS_CHECK_UNAVAILABLE);
  }
}

async function personName(identity) {
  const r = identity.record || {};
  if (r.name) return String(r.name);
  if (r.firstName || r.lastName) return `${r.firstName || ""} ${r.lastName || ""}`.trim();
  if (identity.kind === "employee" && r._id) {
    try {
      const Employee = require("../../models/Employee");
      const e = await Employee.findById(r._id).select("firstName lastName").lean();
      if (e) return `${e.firstName || ""} ${e.lastName || ""}`.trim();
    } catch { /* the email still names them */ }
  }
  return "";
}

module.exports = {
  CCTV_APP,
  CAMERA_KEY,
  MAX_CAMERAS,
  DENIAL,
  MESSAGES,
  resolveCctvAccess,
  normaliseCameraList,
  camerasOfRow,
};
