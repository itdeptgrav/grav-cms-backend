"use strict";

/**
 * faceSignin.js — face recognition for the sign-in page.
 *
 * RECOGNITION ONLY. Nothing here issues a session, sets a cookie, or grants
 * access; the password login in deptAuth.js is untouched and remains the only
 * thing that signs anybody in. This answers one question — "whose face is
 * this?" — and returns the answer for the page to display.
 *
 * The face engine is a Python service on localhost holding the model and the
 * gallery in memory (face_biometric_server.py). This route is a validating
 * proxy in front of it: it checks the payload, keeps the frame out of the
 * database and off the disk, scopes the verification streak to a session, and
 * never widens what the engine concluded.
 *
 * The status worth naming is VERIFIED_BUT_UNLINKED: the face matched a
 * registered folder that no HR employee is linked to. It is deliberately NOT
 * a success — there is nobody to sign in as — and it is a distinct status so
 * a caller cannot mistake it for one by checking `employee_id` alone.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const Employee = require("../../models/Employee");
const { COOKIE_NAME, cookieOptions } = require("../../config/jwt");
const deptAuth = require("./deptAuth");

// Structured, one line per decision. Never the frame, never an embedding —
// a face image in a log file is a biometric leak that outlives the request.
function flog(event, fields) {
  const parts = Object.entries(fields || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "number" ? v : String(v)}`);
  console.log(`[face-signin] ${event} ${parts.join(" ")}`);
}

/**
 * Turn a recognised employee into the SAME session a password login makes.
 *
 * Deliberately not a second kind of session: it reuses deptAuth's own
 * payload shape, signer and cookie, so anything that reads a session — role
 * checks, /verify, the department gate — cannot tell the two apart and
 * cannot drift from one of them. Face is another way to prove who you are,
 * not another kind of user.
 *
 * Every reason to refuse a password login refuses this too: no employee, no
 * department, an inactive one. Recognition alone is not authorisation.
 */
async function createSessionForBiometricId(biometricId, res) {
  // The department fields are not optional extras: resolveEmployeeDepartments
  // reads accessDepartmentId, additionalDepartmentIds and the department
  // label. Selecting only the name fields made every recognised employee look
  // unassigned, and face sign-in refused people who could log in by password.
  const employee = await Employee.findOne({ biometricId: String(biometricId) })
    .select(
      "_id firstName middleName lastName email biometricId " +
      "department accessDepartmentId additionalDepartmentIds",
    )
    .lean();
  if (!employee) {
    return { ok: false, code: "NO_EMPLOYEE", status: 404,
             message: "No employee carries that biometric ID." };
  }

  const allowed = await deptAuth.resolveEmployeeDepartments(employee);
  if (!allowed || !allowed.length) {
    return { ok: false, code: "NO_DEPARTMENT", status: 403,
             message: "Your account is not assigned to a department yet. " +
                      "Ask an administrator to assign you before signing in." };
  }
  const dept = allowed[0];
  if (!dept.isActive) {
    return { ok: false, code: "DEPARTMENT_INACTIVE", status: 403,
             message: `${dept.name} is not currently active.` };
  }

  const name = [employee.firstName, employee.middleName, employee.lastName]
    .filter(Boolean).join(" ").trim();
  const payload = {
    v: 2,
    id: String(employee._id),
    role: dept.legacyRole || dept.slug,
    userType: dept.legacyUserType || dept.slug,
    deptId: String(dept._id),
    deptSlug: dept.slug,
    employeeId: employee.biometricId || "",
    name,
    email: employee.email || "",
    isAdmin: false,
    subject: "employee",
    // Recorded so an audit can tell a face sign-in from a typed password.
    via: "face",
    tv: 0,
  };
  const token = deptAuth.signToken(payload);
  res.cookie(COOKIE_NAME, token, cookieOptions());

  return {
    ok: true,
    token,
    redirectTo: `/${dept.slug}/dashboard`,
    user: {
      id: String(employee._id),
      name,
      email: employee.email || "",
      employeeId: employee.biometricId,
      department: dept.name,
      deptSlug: dept.slug,
    },
  };
}

// One session id signs in once. The camera posts several frames a second and
// every one of them after the third is still VERIFIED, so without this a
// single person would mint a session per frame.
const signedInSessions = new Map();
const SIGNIN_TTL_MS = 10 * 60 * 1000;

// Where the engine is, and how to talk to it, come from one shared config —
// not from this file's own idea of the defaults. See config/faceBiometric.js.
const faceConfig = require("../../config/faceBiometric");
const FACE_SERVICE_URL = faceConfig.FACE_BIOMETRIC_SERVICE_URL;
const FACE_SERVICE_TIMEOUT_MS = Number(
  process.env.FACE_BIOMETRIC_TIMEOUT_MS || 8000,
);

// A webcam frame is a few hundred KB. Anything larger is not one, so it is
// refused here as well as in the engine — this process should not spend
// memory relaying a body the engine will reject anyway.
const MAX_IMAGE_CHARS = 8 * 1024 * 1024; // base64 chars, ~6MB of bytes
const ALLOWED_PREFIXES = [
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/png;base64,",
  "data:image/webp;base64,",
];

// ── debounce / rate limit ───────────────────────────────────────────────
// The page captures a few frames a second by design, so this is not meant to
// be restrictive — it exists so a stuck client or a script cannot turn the
// sign-in page into a way to run the face model flat out. In-memory and
// per-session, which is the right granularity: one person at one browser.
const MIN_INTERVAL_MS = Number(process.env.FACE_MIN_INTERVAL_MS || 120);
const MAX_PER_MINUTE = Number(process.env.FACE_MAX_PER_MINUTE || 240);
const buckets = new Map();
const BUCKET_TTL_MS = 5 * 60 * 1000;

function rateLimit(sessionId, now) {
  for (const [k, b] of buckets) {
    if (now - b.last > BUCKET_TTL_MS) buckets.delete(k);
  }
  let b = buckets.get(sessionId);
  if (!b) {
    b = { last: 0, windowStart: now, count: 0 };
    buckets.set(sessionId, b);
  }
  if (now - b.windowStart > 60000) {
    b.windowStart = now;
    b.count = 0;
  }
  if (now - b.last < MIN_INTERVAL_MS) {
    return { ok: false, reason: "too_fast", retryAfterMs: MIN_INTERVAL_MS };
  }
  if (b.count >= MAX_PER_MINUTE) {
    return { ok: false, reason: "rate_limited", retryAfterMs: 60000 };
  }
  b.last = now;
  b.count += 1;
  return { ok: true };
}

function validSessionId(sid) {
  return (
    typeof sid === "string" &&
    sid.length >= 8 &&
    sid.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(sid)
  );
}

async function callEngine(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FACE_SERVICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${FACE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── POST /api/auth/face/session ─────────────────────────────────────────
// A verification streak belongs to one browser. The id is minted here, not
// accepted from the client, so one page cannot adopt another's streak by
// guessing or reusing its id.
router.post("/session", (req, res) => {
  return res.status(200).json({
    success: true,
    sessionId: crypto.randomBytes(24).toString("base64url"),
  });
});

// ── GET /api/auth/face/health ───────────────────────────────────────────
// Is face sign-in available at all? The page asks this before offering the
// option, so it can say "unavailable" rather than failing on first capture.
router.get("/health", async (req, res) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${FACE_SERVICE_URL}/health`, { signal: ctrl.signal });
    const j = await r.json();
    return res.status(200).json({
      success: true,
      available: Boolean(j.ok) && (j.gallery_size || 0) > 0,
      employeesEnrolled: j.gallery_size || 0,
      framesRequired: j.frames_required,
      windowSec: j.window_sec,
      debugFrames: Boolean(j.debug_frames),
    });
  } catch (err) {
    // Not an error: the page asks this to decide whether to OFFER face
    // sign-in at all. It answers with what to do about it.
    return res.status(200).json({
      success: true,
      available: false,
      reason: "face_service_unreachable",
      serviceUrl: FACE_SERVICE_URL,
      startCommand: faceConfig.START_COMMAND,
      message:
        `The face service is not running at ${FACE_SERVICE_URL}. Start it ` +
        `from the backend with \`${faceConfig.START_COMMAND}\`.`,
    });
  } finally {
    clearTimeout(timer);
  }
});

// ── POST /api/auth/face/verify ──────────────────────────────────────────
router.post("/verify", async (req, res) => {
  const { sessionId, image } = req.body || {};

  if (!validSessionId(sessionId)) {
    return res.status(400).json({
      success: false,
      status: "ERROR",
      reason: "invalid_session",
      message: "Start a face sign-in session first.",
    });
  }
  if (typeof image !== "string" || !image) {
    return res.status(400).json({
      success: false,
      status: "ERROR",
      reason: "missing_image",
    });
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return res.status(413).json({
      success: false,
      status: "ERROR",
      reason: "image_too_large",
    });
  }
  if (!ALLOWED_PREFIXES.some((p) => image.startsWith(p))) {
    return res.status(400).json({
      success: false,
      status: "ERROR",
      reason: "unsupported_image_type",
      message: "Send a JPEG, PNG or WebP data URL.",
    });
  }

  // Answered before the rate limiter, and before the engine is troubled at
  // all: a session that has already signed in costs nothing to answer, and
  // the browser will usually have one or two frames still in flight when it
  // stops capturing. Throttling those turned a completed sign-in into a 429.
  const already = signedInSessions.get(sessionId);
  if (already && Date.now() - already.at < SIGNIN_TTL_MS) {
    flog("signin.repeat", { session: sessionId.slice(0, 8),
                            employeeId: already.employeeId });
    return res.status(200).json({
      success: true,
      status: "VERIFIED",
      employeeId: already.employeeId,
      employeeName: already.user?.name || null,
      signedIn: true,
      alreadySignedIn: true,
      redirectTo: already.redirectTo,
      user: already.user,
      framesMatched: null,
      framesRequired: null,
      reason: "already_signed_in",
    });
  }

  const gate = rateLimit(sessionId, Date.now());
  if (!gate.ok) {
    return res.status(429).json({
      success: false,
      status: "ERROR",
      reason: gate.reason,
      retryAfterMs: gate.retryAfterMs,
    });
  }

  const r = await callEngine("/verify", { session_id: sessionId, image });
  if (r.status === 0) {
    return faceConfig.serviceUnavailable(res, r.error);
  }
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return res.status(r.status === 413 ? 413 : 400).json({
      success: false,
      status: "ERROR",
      reason: (r.json && r.json.error) || "engine_error",
    });
  }

  const e = r.json;
  const base = {
    success: true,
    status: e.status,
    employeeId: e.employee_id || null,
    employeeName: e.employee_name || null,
    folder: e.folder || null,
    distance: e.distance ?? null,
    margin: e.margin ?? null,
    framesMatched: e.frames_matched ?? 0,
    framesRequired: e.frames_required ?? null,
    reason: e.reason || null,
  };
  // The frame itself stops here. It is not stored, logged, or forwarded.
  flog("verify", {
    session: sessionId.slice(0, 8),
    status: e.status,
    employeeId: e.employee_id,
    distance: e.distance == null ? null : e.distance.toFixed(4),
    margin: e.margin == null ? null : e.margin.toFixed(4),
    frames: `${e.frames_matched ?? 0}/${e.frames_required ?? "?"}`,
    reason: e.reason,
  });

  if (e.status !== "VERIFIED" || !e.employee_id) {
    return res.status(200).json({ ...base, signedIn: false });
  }

  // Still checked here: a second frame can reach the engine while the first
  // is mid-flight, and only one of them may mint a session.
  const prior = signedInSessions.get(sessionId);
  if (prior && Date.now() - prior.at < SIGNIN_TTL_MS) {
    flog("signin.repeat", { session: sessionId.slice(0, 8),
                            employeeId: prior.employeeId });
    return res.status(200).json({
      ...base, signedIn: true, alreadySignedIn: true,
      redirectTo: prior.redirectTo, user: prior.user,
    });
  }

  let session;
  try {
    session = await createSessionForBiometricId(e.employee_id, res);
  } catch (err) {
    flog("signin.error", { session: sessionId.slice(0, 8),
                           employeeId: e.employee_id, error: err.message });
    return res.status(500).json({ ...base, signedIn: false,
                                  reason: "session_error" });
  }
  if (!session.ok) {
    // Recognised, and still not allowed in. Reported as itself so the page
    // can say why instead of looping on a face that will never succeed.
    flog("signin.refused", { session: sessionId.slice(0, 8),
                             employeeId: e.employee_id, code: session.code });
    return res.status(200).json({
      ...base, signedIn: false, status: "RECOGNISED_NOT_PERMITTED",
      code: session.code, message: session.message,
    });
  }

  for (const [k, v] of signedInSessions) {
    if (Date.now() - v.at > SIGNIN_TTL_MS) signedInSessions.delete(k);
  }
  signedInSessions.set(sessionId, {
    at: Date.now(), employeeId: e.employee_id,
    redirectTo: session.redirectTo, user: session.user,
  });
  flog("signin.ok", { session: sessionId.slice(0, 8),
                      employeeId: e.employee_id, dept: session.user.deptSlug });

  return res.status(200).json({
    ...base, signedIn: true, token: session.token,
    redirectTo: session.redirectTo, user: session.user,
  });
});

// ── GET /api/auth/face/diagnostics ──────────────────────────────────────
// Authenticated proof that the CMS can reach the engine, and what it sees.
// Behind auth because it names how many employees are enrolled and where
// their photos live — useful to an operator, not to the internet.
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
router.get("/diagnostics", EmployeeAuthMiddlewear, async (req, res) => {
  const started = Date.now();
  const health = await faceConfig.engineHealth();
  const reachable = Boolean(health.running);
  return res.status(200).json({
    success: true,
    reachable,
    roundTripMs: Date.now() - started,
    serviceUrl: faceConfig.FACE_BIOMETRIC_SERVICE_URL,
    startCommand: faceConfig.START_COMMAND,
    paths: {
      registeredDir: faceConfig.FACE_BIOMETRIC_REGISTERED_DIR,
      peopleMap: faceConfig.FACE_BIOMETRIC_PEOPLE_MAP,
      serviceDir: faceConfig.SERVICE_DIR,
      python: faceConfig.FACE_PYTHON,
    },
    engine: reachable
      ? {
          model: health.model,
          employeesEnrolled: health.gallery_size || 0,
          enrolled: health.gallery || [],
          framesRequired: health.frames_required,
          windowSec: health.window_sec,
          thresholds: health.thresholds,
          loadedAt: health.loaded_at,
          sessions: health.sessions,
          requests: health.requests,
        }
      : { reason: health.reason, detail: health.detail, message: health.message },
    activeSignedInSessions: signedInSessions.size,
  });
});

// ── POST /api/auth/face/reset ───────────────────────────────────────────
router.post("/reset", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!validSessionId(sessionId)) {
    return res.status(400).json({ success: false, reason: "invalid_session" });
  }
  await callEngine("/reset", { session_id: sessionId });
  signedInSessions.delete(sessionId);
  return res.status(200).json({ success: true });
});

module.exports = router;
