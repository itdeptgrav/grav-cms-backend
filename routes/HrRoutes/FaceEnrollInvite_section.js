"use strict";

/**
 * FaceEnrollInvite_section.js — self-service face registration by link.
 *
 * THE PROBLEM THIS SOLVES: /hr/face-registration/upload/:employeeId is behind
 * EmployeeAuthMiddlewear, so registering a face meant an HR user driving it
 * from an HR machine, one employee at a time. This lets HR hand out a link
 * instead and the employee register from the phone already in their pocket.
 *
 * THE PUBLIC HALF OF THIS FILE IS UNAUTHENTICATED BY DESIGN. The employee is
 * not signed in — that is the whole point, they may not have a password yet.
 * The token IS the authorisation, so everything downstream of it is bounded:
 *
 *   · the token is 32 random bytes, stored only as sha256
 *   · it names the employee — the browser never gets to say who it is, so a
 *     token cannot be pointed at somebody else's gallery
 *   · it expires, it is revocable, and it stops working once completed
 *   · uploads through it are capped per invite AND rate-limited per IP
 *   · it can do exactly one thing: add photos to one gallery. It cannot read
 *     the roster, cannot read back a photo, cannot sign anybody in.
 *
 * Photos are forwarded to the same engine endpoint the HR path uses, with the
 * employee resolved from the invite row. Nothing here writes to
 * REGISTERED_PEOPLE — see the note at the top of FaceRegistration_section.js.
 *
 * Mounted at /hr/face-enroll.
 */

const express = require("express");
const router = express.Router();

const Employee = require("../../models/Employee");
const FaceEnrollInvite = require("../../models/HR_Models/FaceEnrollInvite");
const { hashToken, generateToken } = FaceEnrollInvite;
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const FacePhoto = require("../../models/HR_Models/FacePhoto");
const faceDrive = require("../../services/faceGalleryDrive.service");
const faceConfig = require("../../config/faceBiometric");
const FACE_SERVICE_URL = faceConfig.FACE_BIOMETRIC_SERVICE_URL;
const FACE_SERVICE_TIMEOUT_MS = Number(
  process.env.FACE_BIOMETRIC_UPLOAD_TIMEOUT_MS || 60000,
);

/* Kept identical to FaceRegistration_section.js on purpose: two upload paths
   into one gallery must agree on what an acceptable photo is, or the rule
   that holds is whichever path the operator happened to use. */
const ALLOWED_IMAGE_PREFIXES = [
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/png;base64,",
  "data:image/webp;base64,",
];
const MAX_FILES_PER_UPLOAD = 20;
const MAX_CHARS_PER_FILE = 16 * 1024 * 1024; // base64 chars, ~12MB

/* Bounds on one invite. Enrolment is ~6-10 good photos; these are generous
   enough that nobody hits them honestly and tight enough that a leaked link
   is not an open upload endpoint. */
const INVITE_TTL_MS = Number(
  process.env.FACE_ENROLL_TTL_MS || 48 * 60 * 60 * 1000,
);
const MAX_UPLOADS_PER_INVITE = Number(process.env.FACE_ENROLL_MAX_UPLOADS || 15);
/* The gallery itself is capped at 6 in the engine, which is the rule that
   actually holds. This is the looser per-link bound on attempts, so a few
   retakes are possible without the link running out before the gallery is
   full. */
const MAX_PHOTOS_PER_INVITE = Number(process.env.FACE_ENROLL_MAX_PHOTOS || 20);

/** How long the employee's phone waits for the end-of-enrolment recompute.
    See the note at the call site: the work continues past this. */
const FACE_ENROLL_FINALISE_TIMEOUT_MS = Number(
  process.env.FACE_ENROLL_FINALISE_TIMEOUT_MS || 20000,
);

/** How many accepted photos the page asks for before it says the employee is
    done. Advisory only — the engine readiness verdict is the real gate. */
const TARGET_PHOTOS = Number(process.env.FACE_ENROLL_TARGET_PHOTOS || 6);

async function callEngine(path, body, timeoutMs = FACE_SERVICE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FACE_SERVICE_URL}${path}`, {
      method: "POST",
      headers: faceConfig.engineHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 0,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ── per-IP throttle for the public half ────────────────────────────────
   The invite caps bound one link; this bounds someone spraying guessed
   tokens. In-process and therefore per-instance — good enough to make guessing
   pointless against a 32-byte space, and it costs no infrastructure. */
const ipHits = new Map();
const IP_WINDOW_MS = 60 * 1000;
const MAX_PER_IP_PER_MIN = Number(process.env.FACE_ENROLL_MAX_PER_IP || 40);

function throttled(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.start > IP_WINDOW_MS) {
    ipHits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_IP_PER_MIN;
}

/* Unbounded Maps are how a long-running process leaks. */
const sweeper = setInterval(
  () => {
    const cutoff = Date.now() - IP_WINDOW_MS;
    for (const [ip, rec] of ipHits) if (rec.start < cutoff) ipHits.delete(ip);
  },
  5 * 60 * 1000,
);
if (typeof sweeper.unref === "function") sweeper.unref();

/**
 * Resolve a raw token to a live invite, or explain why not.
 *
 * Returns { invite } or { error, status }. The error strings reach the
 * employee, so they name the fix ("ask HR for a new link") rather than the
 * mechanism.
 */
async function resolveInvite(rawToken) {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 20) {
    return { status: 404, error: "invalid_link" };
  }
  const invite = await FaceEnrollInvite.findOne({
    tokenHash: hashToken(rawToken),
  });
  if (!invite) return { status: 404, error: "invalid_link" };
  if (!invite.isActive()) {
    return { status: 410, error: invite.inactiveReason() || "inactive" };
  }
  if (invite.uploadCount >= MAX_UPLOADS_PER_INVITE) {
    return { status: 429, error: "upload_limit_reached" };
  }
  return { invite };
}

/** Full name, the same way every other face route builds it. */
function fullName(e) {
  return [e.firstName, e.middleName, e.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/* The link points at the CMS that serves /face-enroll, not at this API.
   Same resolution order as the accountant invite links in Acc_team.js. */
function resolveFrontendBase(req) {
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/+$/, "");
  }
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, "");
  const referer = req.headers.referer;
  if (referer && /^https?:\/\//.test(referer)) {
    try {
      const u = new URL(referer);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through to the default */
    }
  }
  return "http://localhost:3001";
}

/* ════════════════════════════════════════════════════════════════════════
   HR HALF — authenticated
   ════════════════════════════════════════════════════════════════════════ */

// ── POST /hr/face-enroll/invite/:employeeId ─────────────────────────────
// Mint a link for one employee. Any live invite for that employee is revoked
// first: two working links for one gallery is a loose end nobody tracks, and
// HR pressing the button twice means they lost the first one.
router.post("/invite/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  let employee = null;
  try {
    employee = await Employee.findById(req.params.employeeId)
      .select("firstName middleName lastName biometricId email")
      .lean();
  } catch {
    employee = null;
  }
  if (!employee) {
    return res
      .status(404)
      .json({ success: false, message: "Employee not found" });
  }
  if (!employee.biometricId) {
    return res.status(400).json({
      success: false,
      reason: "no_biometric_id",
      message:
        "This employee has no biometric ID. Set one on the Work Details tab " +
        "before sending a face registration link.",
    });
  }

  const now = new Date();
  await FaceEnrollInvite.updateMany(
    {
      employee: employee._id,
      revokedAt: null,
      completedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { revokedAt: now, revokedByName: req.user?.name || "HR" } },
  );

  const raw = generateToken();
  const invite = await FaceEnrollInvite.create({
    employee: employee._id,
    biometricId: String(employee.biometricId),
    tokenHash: hashToken(raw),
    createdBy: req.user?.id || undefined,
    createdByName: req.user?.name || "",
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  });

  const url = `${resolveFrontendBase(req)}/face-enroll/${raw}`;

  /* The only response that will ever carry the raw token. Nothing logs it. */
  return res.status(201).json({
    success: true,
    url,
    expiresAt: invite.expiresAt,
    employee: { id: String(employee._id), name: fullName(employee) },
    invite: invite.toStatus(now),
  });
});

// ── GET /hr/face-enroll/invite/:employeeId ──────────────────────────────
// The state of the most recent invite, so HR can see whether the employee
// ever opened it. Deliberately cannot return the token — see the model.
router.get("/invite/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  let invite = null;
  try {
    invite = await FaceEnrollInvite.findOne({ employee: req.params.employeeId })
      .sort({ createdAt: -1 })
      .exec();
  } catch {
    invite = null;
  }
  return res.status(200).json({
    success: true,
    invite: invite ? invite.toStatus() : null,
    ttlHours: Math.round(INVITE_TTL_MS / (60 * 60 * 1000)),
  });
});

// ── POST /hr/face-enroll/invite/:employeeId/revoke ──────────────────────
router.post(
  "/invite/:employeeId/revoke",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    const now = new Date();
    const r = await FaceEnrollInvite.updateMany(
      {
        employee: req.params.employeeId,
        revokedAt: null,
        completedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { revokedAt: now, revokedByName: req.user?.name || "HR" } },
    );
    return res.status(200).json({ success: true, revoked: r.modifiedCount || 0 });
  },
);

/* ════════════════════════════════════════════════════════════════════════
   EMPLOYEE HALF — no session, the token is the authorisation
   ════════════════════════════════════════════════════════════════════════ */

// ── GET /hr/face-enroll/session/:token ──────────────────────────────────
// What the enrolment page needs to render itself.
//
// It answers with the employee FIRST NAME and nothing else about them. The
// page has to greet them by name for the employee to trust the link is
// really theirs, but a link that leaks should not also leak a phone number,
// a department or a staff id.
router.get("/session/:token", async (req, res) => {
  if (throttled(req)) {
    return res.status(429).json({ success: false, reason: "rate_limited" });
  }
  const r = await resolveInvite(req.params.token);
  if (r.error) {
    return res.status(r.status).json({ success: false, reason: r.error });
  }

  let employee = null;
  try {
    employee = await Employee.findById(r.invite.employee)
      .select("firstName biometricId")
      .lean();
  } catch {
    employee = null;
  }
  if (!employee) {
    return res.status(404).json({ success: false, reason: "employee_missing" });
  }

  /* If HR changed the biometricId after minting, this invite points at a
     gallery that is no longer this employee's. Refuse rather than file the
     photos under the old id. */
  if (String(employee.biometricId || "") !== String(r.invite.biometricId)) {
    return res.status(409).json({ success: false, reason: "employee_changed" });
  }

  /* engineHealth() reports `running`, not `available`. Reading the wrong key
     here told the phone the engine was up while it was down — and did it
     silently, because a missing key is undefined rather than an error. */
  let engineAvailable = true;
  try {
    const health = await faceConfig.engineHealth();
    if (!health || health.running !== true) engineAvailable = false;
  } catch {
    engineAvailable = false;
  }

  return res.status(200).json({
    success: true,
    firstName: employee.firstName || "there",
    expiresAt: r.invite.expiresAt,
    photosAccepted: r.invite.photosAccepted || 0,
    targetPhotos: TARGET_PHOTOS,
    uploadsRemaining: Math.max(
      0,
      MAX_UPLOADS_PER_INVITE - (r.invite.uploadCount || 0),
    ),
    engineAvailable,
  });
});

// ── POST /hr/face-enroll/session/:token/upload ──────────────────────────
// Photos in, engine verdict out. The employee is resolved from the invite
// row; nothing in the request body names a person.
router.post("/session/:token/upload", async (req, res) => {
  if (throttled(req)) {
    return res.status(429).json({ success: false, reason: "rate_limited" });
  }

  const r = await resolveInvite(req.params.token);
  if (r.error) {
    return res.status(r.status).json({ success: false, reason: r.error });
  }
  const invite = r.invite;

  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ success: false, reason: "no_files" });
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return res.status(400).json({
      success: false,
      reason: "too_many_files",
      message: `Send at most ${MAX_FILES_PER_UPLOAD} photos at a time.`,
    });
  }
  if ((invite.photosAccepted || 0) + files.length > MAX_PHOTOS_PER_INVITE) {
    return res
      .status(429)
      .json({ success: false, reason: "photo_limit_reached" });
  }
  for (const f of files) {
    if (!f || typeof f.data !== "string") {
      return res.status(400).json({ success: false, reason: "malformed_file" });
    }
    if (f.data.length > MAX_CHARS_PER_FILE) {
      return res.status(413).json({ success: false, reason: "file_too_large" });
    }
    if (!ALLOWED_IMAGE_PREFIXES.some((p) => f.data.startsWith(p))) {
      return res.status(400).json({
        success: false,
        reason: "unsupported_image_type",
        message: "Only JPEG, PNG and WebP photos can be registered.",
      });
    }
  }

  let employee = null;
  try {
    employee = await Employee.findById(invite.employee)
      .select("firstName middleName lastName biometricId email")
      .lean();
  } catch {
    employee = null;
  }
  if (!employee) {
    return res.status(404).json({ success: false, reason: "employee_missing" });
  }
  if (String(employee.biometricId || "") !== String(invite.biometricId)) {
    return res.status(409).json({ success: false, reason: "employee_changed" });
  }

  /* Counted before the engine call, not after. A caller that hangs up
     mid-request must still have spent its attempt, or the cap is advisory. */
  invite.uploadCount = (invite.uploadCount || 0) + 1;
  invite.usedAt = invite.usedAt || new Date();
  invite.lastUsedIp = req.ip || "";
  invite.lastUserAgent = String(req.headers["user-agent"] || "").slice(0, 300);
  await invite.save();

  const engine = await callEngine("/register/upload", {
    employee_id: String(employee.biometricId),
    employee_name: fullName(employee) || null,
    username: employee.email || null,
    /* One photo, one embedding. Without this the engine re-embeds the whole
       gallery on every capture — work that grows with both the number of
       photos taken and the number of employees already enrolled, until the
       call outlives its timeout and the phone is told the service is
       unreachable while the engine is busy and perfectly healthy. The full
       recompute happens once, in /complete. */
    quick: true,
    files: files.map((f) => ({
      filename: typeof f.filename === "string" ? f.filename : "photo.jpg",
      data: f.data,
    })),
  });
  if (engine.status === 0) {
    return faceConfig.serviceUnavailable(res, engine.error);
  }
  if (engine.status !== 200 || !engine.json || engine.json.ok !== true) {
    const reason = (engine.json && engine.json.error) || "upload_failed";
    /* The engine reports the cap as `gallery_full:<have>/<max>`. Passed
       through with its numbers intact so the page can say which, rather than
       "upload failed". */
    if (String(reason).startsWith("gallery_full")) {
      const [, counts = ""] = String(reason).split(":");
      const [have, max] = counts.split("/");
      return res.status(409).json({
        success: false,
        reason: "gallery_full",
        photosAccepted: Number(have) || invite.photosAccepted || 0,
        maxPhotos: Number(max) || null,
      });
    }
    return res.status(engine.status === 413 ? 413 : 400).json({
      success: false,
      reason,
    });
  }

  const saved = engine.json.saved || [];
  const rejected = engine.json.rejected || [];

  /* In quick mode the engine judges only the photos just written, and says so
     per file. That is the honest per-capture answer: `saved` means WRITTEN TO
     DISK, and the engine's `rejected` list carries only structural failures
     (undecodable bytes, a bad type, a path escape), so a photo of a wall
     arrives saved and unrejected. Counting saved.length as progress let junk
     fill the quota and told the employee they were finished when the gallery
     held one real face. */
  const verdicts = engine.json.verdicts || [];
  const acceptedNow = Number.isFinite(engine.json.accepted_now)
    ? engine.json.accepted_now
    : verdicts.filter((v) => v.accepted).length;

  invite.folder = invite.folder || engine.json.folder || "";

  /* Mirror to private Drive, after the engine has the photos and never before
     it. The registration that matters is the one on the punch-in machine; this
     is durability on top, and it must not be able to fail the request.
     Deliberately not awaited into the response path — see the service header. */
  backupToDrive(saved, files, employee, "self-enrolment", verdicts).catch(() => {});

  invite.photosAccepted = (invite.photosAccepted || 0) + acceptedNow;
  invite.photosRejected =
    (invite.photosRejected || 0) + (saved.length - acceptedNow) + rejected.length;
  await invite.save();

  /* Why the engine would not use it, if it would not. These come from the
     registration gate and look like `small(42px)` or `yaw=35`; the page turns
     them into something an employee can act on. */
  const declined = verdicts.filter((v) => !v.accepted).map((v) => v.reason);

  return res.status(200).json({
    success: true,
    saved,
    rejected,
    usable: acceptedNow > 0,
    declinedReasons: declined,
    photosAccepted: invite.photosAccepted,
    targetPhotos: TARGET_PHOTOS,
    uploadsRemaining: Math.max(0, MAX_UPLOADS_PER_INVITE - invite.uploadCount),
    /* Readiness is a whole-gallery verdict and is deliberately NOT computed
       per capture — that recompute is what made this too slow to use. The
       page counts accepted photos while shooting; the real verdict arrives
       from /complete. */
    readiness: null,
  });
});

// ── POST /hr/face-enroll/session/:token/complete ────────────────────────
// The employee says they are finished. Two things happen here, and only here:
// the link is retired, and the engine does the expensive whole-gallery work
// ONCE — reloading the sign-in gallery so this person can actually be
// recognised, and reporting whether their photos are good enough.
//
// That recompute used to run after every single capture, which is what made
// enrolment slow enough to time out. Paying it once, at the end, is the same
// cost HR's batch upload has always paid.
router.post("/session/:token/complete", async (req, res) => {
  if (throttled(req)) {
    return res.status(429).json({ success: false, reason: "rate_limited" });
  }
  const r = await resolveInvite(req.params.token);
  if (r.error) {
    /* Completing an already-completed invite is what a double-tap on a slow
       phone looks like. Say ok rather than showing a failure for something
       that did happen. */
    if (r.error === "completed") return res.status(200).json({ success: true });
    return res.status(r.status).json({ success: false, reason: r.error });
  }
  const invite = r.invite;

  /* Retired before the slow call, not after. If finalising times out the
     employee is still finished, and a link that stayed live because the
     engine was busy is a worse outcome than a missing readiness number. */
  invite.completedAt = new Date();
  await invite.save();

  let readiness = null;
  let punchable = false;
  let retakeReasons = [];

  /* `folder` is learned from the first upload. An invite issued before that
     field existed — or one completed without uploading through this route —
     has none, and would silently skip the finalise. The engine names a new
     folder after the employee id, so that is the correct fallback; a wrong
     guess is refused with folder_not_found rather than acted on. */
  const folder = invite.folder || invite.biometricId;

  if (folder) {
    /* BOUNDED, not generous. This is the whole-gallery pass: it costs one
       embedding per registration photo on disk, so it grows with the number
       of employees already enrolled and will eventually take minutes.
       Abandoning the wait does NOT abandon the work — the engine finishes and
       its sign-in gallery is reloaded either way. All the employee loses by
       timing out is the readiness line on the final screen, which is HR's
       number anyway. Waiting instead would mean a phone stuck on a spinner
       for as long as the gallery is large. */
    const engine = await callEngine(
      "/register/finalise",
      { folder },
      FACE_ENROLL_FINALISE_TIMEOUT_MS,
    );
    if (engine.status === 200 && engine.json && engine.json.ok === true) {
      const status = engine.json.status || {};
      readiness = status.readiness || null;
      punchable = Boolean(status.punchable);
      retakeReasons = status.retake_reasons || [];
      if (Number.isFinite(status.images_accepted)) {
        /* The authoritative whole-folder count, which also folds in anything
           HR uploaded separately. The running total was only ever a tally of
           this session's captures. */
        invite.photosAccepted = status.images_accepted;
        await invite.save();
      }
    }
    /* A failure here is not the employee's problem: their photos are saved.
       HR's Biometric tab recomputes readiness on demand anyway. */
  }

  return res.status(200).json({
    success: true,
    photosAccepted: invite.photosAccepted || 0,
    readiness,
    punchable,
    retakeReasons,
  });
});


/**
 * Copy the photos that actually landed to private Drive, and record where.
 *
 * Best effort throughout: the caller does not await this, and nothing it can
 * fail at should reach the employee. `saved` is the engine's own list, so only
 * files that really landed on the punch-in machine are mirrored.
 */
async function backupToDrive(saved, files, employee, source, verdicts = []) {
  try {
    if (!faceDrive.backupEnabled()) return;
    const landed = new Set((saved || []).map((s) => s.filename));
    /* The engine renames on write (a timestamped name); pair its saved names
       back to the bytes we were posted, in order. */
    const pairs = (saved || [])
      .map((s, i) => ({ filename: s.filename, data: files[i] && files[i].data }))
      .filter((p) => p.data && landed.has(p.filename));
    if (!pairs.length) return;

    const stored = await faceDrive.backupFacePhotos(pairs, {
      employeeId: String(employee.biometricId),
      employeeName: fullName(employee),
    });
    if (!stored.length) return;

    /* The engine judged each of these a moment ago and handed back the
       embedding it computed. Keyed by filename so a partial upload cannot
       pair one photo's numbers with another's row. */
    const byName = new Map(
      (verdicts || []).map((v) => [v.filename, v]),
    );

    await FacePhoto.insertMany(
      stored.map((s) => {
        const v = byName.get(s.filename);
        return {
          employee: employee._id,
          biometricId: String(employee.biometricId),
          folder: (saved[0] && saved[0].folder) || "",
          filename: s.filename,
          driveFileId: s.driveFileId,
          bytes: s.bytes,
          source,
          embedding: v && Array.isArray(v.embedding) ? v.embedding : undefined,
          embeddingModel: (v && v.model) || "",
        };
      }),
      { ordered: false },
    );
  } catch (err) {
    console.warn("[face-drive] mirror failed:", err.message);
  }
}

module.exports = router;
