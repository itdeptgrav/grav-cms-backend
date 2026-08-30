"use strict";

/**
 * FaceRegistration_section.js — face registration status, read-only.
 *
 * The face engine is a Python process on the punch-in machine. It owns the
 * photos, the quality gate and the folder -> employee mapping, and it takes
 * seconds to load a model. None of that belongs in this API process, so it
 * is not imported, shelled out to, or reimplemented here.
 *
 * Instead the engine writes a snapshot:
 *
 *     python face_biometric.py --status-json <FACE_BIOMETRIC_STATUS_FILE>
 *
 * and this serves it. A snapshot is honest about being one — every response
 * carries generatedAt and ageSeconds, so a page can say how fresh it is
 * rather than implying it is live.
 *
 * Read-only by construction. Nothing here writes a snapshot, edits a
 * mapping, touches a photo, or records attendance.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

// Uploads are forwarded to the face engine, which owns REGISTERED_PEOPLE.
// Giving this process a second write path into that directory would mean two
// codebases enforcing the same filename and traversal rules, and eventually
// only one of them doing it correctly.
const faceConfig = require("../../config/faceBiometric");
const FACE_SERVICE_URL = faceConfig.FACE_BIOMETRIC_SERVICE_URL;
const FACE_SERVICE_TIMEOUT_MS = Number(
  process.env.FACE_BIOMETRIC_UPLOAD_TIMEOUT_MS || 60000,
);

const ALLOWED_IMAGE_PREFIXES = [
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/png;base64,",
  "data:image/webp;base64,",
];
const MAX_FILES_PER_UPLOAD = 20;
const MAX_CHARS_PER_FILE = 16 * 1024 * 1024; // base64 chars, ~12MB

async function callEngine(path, body, timeoutMs = FACE_SERVICE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    return {
      status: 0,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function engineUnavailable(res, detail) {
  return faceConfig.serviceUnavailable(res, detail);
}

// Where the punch-in machine drops its snapshot. Configured, never guessed:
// the engine lives on removable media whose path is machine-specific.
// Only the fallback for when the engine is down; the live engine is the
// normal source. Path comes from the shared config, not from this file.
const STATUS_FILE = faceConfig.FACE_BIOMETRIC_STATUS_FILE;

/**
 * The registration picture, live from the face engine.
 *
 * The engine holds the photos, so it can answer this at any moment. Reading
 * a file instead meant the page showed whatever state somebody last
 * remembered to export — and, when nobody had, showed "unavailable" while a
 * perfectly healthy engine was running two ports away.
 *
 * The file is kept only as a fallback for when the engine is down, so an
 * exported snapshot can still say something rather than nothing.
 */
async function loadSnapshot() {
  const r = await callEngine("/register/snapshot", {}, 20000);
  if (r.status === 200 && r.json && r.json.ok === true && r.json.snapshot) {
    return { ok: true, snap: r.json.snapshot, ageSeconds: 0, live: true };
  }
  const file = readSnapshotFile();
  if (file.ok) return { ...file, live: false };
  return {
    ok: false,
    reason: "face_service_unreachable",
    message:
      `The face service is not running at ${FACE_SERVICE_URL}. Start it ` +
      `from the backend with \`${faceConfig.START_COMMAND}\`.`,
    serviceUrl: FACE_SERVICE_URL,
    startCommand: faceConfig.START_COMMAND,
    path: file.path,
    engineError: r.error || `engine HTTP ${r.status}`,
  };
}

function readSnapshotFile() {
  if (!fs.existsSync(STATUS_FILE)) {
    return {
      ok: false,
      reason: "no_snapshot",
      message:
        "No exported snapshot on disk (this is only the fallback; the " +
        "live face service is the normal source).",
      path: STATUS_FILE,
    };
  }
  try {
    const raw = fs.readFileSync(STATUS_FILE, "utf8");
    const snap = JSON.parse(raw);
    if (!snap || !Array.isArray(snap.people)) {
      return { ok: false, reason: "malformed", path: STATUS_FILE };
    }
    const generatedAt = snap.generated_at ? new Date(snap.generated_at) : null;
    return {
      ok: true,
      snap,
      generatedAt,
      ageSeconds: generatedAt
        ? Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 1000))
        : null,
      path: STATUS_FILE,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      message: `${err.name}: ${err.message}`,
      path: STATUS_FILE,
    };
  }
}

/**
 * Shape one snapshot person for the UI. The field names the page reads are
 * fixed here, so a change in the Python snapshot cannot silently rename
 * something the page depends on.
 */
function shapePerson(p) {
  return {
    folder: p.folder,
    employeeId: p.employee_id || null,
    employeeName: p.employee_name || null,
    mongoId: p.mongo_id || null,
    linked: Boolean(p.linked),
    linkedAt: p.linked_at || null,
    imagesFound: p.images_found ?? 0,
    imagesAccepted: p.images_accepted ?? 0,
    imagesRejected: p.images_rejected ?? 0,
    coreAnchors: p.core_anchors ?? 0,
    embeddings: p.embeddings ?? 0,
    readiness: p.readiness || "NOT_READY",
    punchable: Boolean(p.punchable),
    blockedBy: p.blocked_by || [],
    warnings: p.warnings || [],
    retakeReasons: p.retake_reasons || [],
    nearestOther: p.nearest_other || null,
    nearestOtherDist: p.nearest_other_dist ?? null,
  };
}

// ── GET /hr/face-registration/health ────────────────────────────────────
// Is the engine up, and if not, exactly what to run. Deliberately NOT
// behind auth: an operator diagnosing a dead service should not have to be
// signed in to be told it is dead, and the answer contains no employee data.
router.get("/health", async (req, res) => {
  const h = await faceConfig.engineHealth();
  return res.status(200).json({
    success: true,
    running: h.running,
    serviceUrl: faceConfig.FACE_BIOMETRIC_SERVICE_URL,
    startCommand: faceConfig.START_COMMAND,
    ...(h.running
      ? {
          model: h.model,
          employeesEnrolled: h.gallery_size || 0,
          framesRequired: h.frames_required,
          loadedAt: h.loaded_at,
          registeredDir: faceConfig.FACE_BIOMETRIC_REGISTERED_DIR,
          peopleMap: faceConfig.FACE_BIOMETRIC_PEOPLE_MAP,
        }
      : { reason: h.reason, detail: h.detail, message: h.message }),
  });
});

// ── GET /hr/face-registration/status ────────────────────────────────────
// The whole picture: every folder, plus the ones nobody is linked to.
router.get("/status", EmployeeAuthMiddlewear, async (req, res) => {
  const r = await loadSnapshot();
  if (!r.ok) {
    return res.status(200).json({
      success: false,
      reason: r.reason,
      message: r.message || "Snapshot unavailable",
      snapshotPath: r.path,
      data: null,
    });
  }
  const people = r.snap.people.map(shapePerson);
  return res.status(200).json({
    success: true,
    data: {
      generatedAt: r.snap.generated_at || null,
      ageSeconds: r.ageSeconds,
      live: Boolean(r.live),
      totals: r.snap.totals || {},
      duplicateEmployeeIds: r.snap.duplicate_employee_ids || {},
      unlinkedFolders: r.snap.unlinked_folders || [],
      mapError: r.snap.map_error || null,
      people,
    },
  });
});

// ── GET /hr/face-registration/status/:employeeId ────────────────────────
// One employee, addressed the way the rest of HR addresses them: by Mongo
// _id. The snapshot is keyed on biometricId, so the employee is looked up
// first and the two are joined here rather than in the browser.
router.get("/status/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  const r = await loadSnapshot();
  if (!r.ok) {
    return res.status(200).json({
      success: false,
      reason: r.reason,
      message: r.message || "Snapshot unavailable",
      snapshotPath: r.path,
      data: null,
    });
  }

  let employee = null;
  try {
    employee = await Employee.findById(req.params.employeeId)
      .select("firstName middleName lastName biometricId identityId")
      .lean();
  } catch (err) {
    employee = null;
  }
  if (!employee) {
    return res
      .status(404)
      .json({ success: false, message: "Employee not found" });
  }

  const bioId = employee.biometricId ? String(employee.biometricId) : null;
  const people = r.snap.people.map(shapePerson);

  // A folder belongs to this employee only if the MAPPING says so. Matching
  // on a name would be a guess, and a guess here credits one person's
  // attendance to another.
  const matches = bioId
    ? people.filter((p) => p.employeeId && String(p.employeeId) === bioId)
    : [];

  const dupes = r.snap.duplicate_employee_ids || {};
  return res.status(200).json({
    success: true,
    data: {
      generatedAt: r.snap.generated_at || null,
      ageSeconds: r.ageSeconds,
      live: Boolean(r.live),
      employee: {
        id: String(employee._id),
        name: [employee.firstName, employee.middleName, employee.lastName]
          .filter(Boolean)
          .join(" ")
          .trim(),
        biometricId: bioId,
      },
      // No biometricId on the HR record means there is nothing a face
      // folder could ever be linked to — a different problem from having
      // one and not having registered.
      hasBiometricId: Boolean(bioId),
      linked: matches.length > 0,
      folders: matches,
      duplicateWarning:
        bioId && dupes[bioId] && dupes[bioId].length > 1
          ? {
              employeeId: bioId,
              folders: dupes[bioId],
              message:
                "More than one face folder is linked to this employee id. " +
                "Two folders of the same person are harmless; two different " +
                "people sharing an id would file one person's attendance " +
                "under the other.",
            }
          : null,
      unlinkedFolders: r.snap.unlinked_folders || [],
    },
  });
});

// ── POST /hr/face-registration/upload/:employeeId ───────────────────────
// HR adds photos to one employee's gallery. The employee is resolved HERE,
// from the HR record, so the folder is chosen by the employee's own
// biometricId rather than by anything the browser claims.
router.post("/upload/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  const files = (req.body && req.body.files) || [];
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ success: false, reason: "no_files" });
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    return res.status(400).json({
      success: false,
      reason: "too_many_files",
      message: `Upload at most ${MAX_FILES_PER_UPLOAD} photos at a time.`,
    });
  }
  for (const f of files) {
    if (!f || typeof f.data !== "string") {
      return res.status(400).json({ success: false, reason: "malformed_file" });
    }
    if (f.data.length > MAX_CHARS_PER_FILE) {
      return res.status(413).json({
        success: false,
        reason: "file_too_large",
        filename: f.filename || null,
      });
    }
    if (!ALLOWED_IMAGE_PREFIXES.some((p) => f.data.startsWith(p))) {
      return res.status(400).json({
        success: false,
        reason: "unsupported_image_type",
        filename: f.filename || null,
        message: "Only JPEG, PNG and WebP photos can be registered.",
      });
    }
  }

  let employee = null;
  try {
    employee = await Employee.findById(req.params.employeeId)
      .select("firstName middleName lastName biometricId email")
      .lean();
  } catch (err) {
    employee = null;
  }
  if (!employee) {
    return res.status(404).json({ success: false, message: "Employee not found" });
  }
  if (!employee.biometricId) {
    // Without it there is nothing to file the photos under, and nothing
    // attendance could later be credited to.
    return res.status(400).json({
      success: false,
      reason: "no_biometric_id",
      message:
        "This employee has no biometric ID. Set one on the Work Details tab " +
        "before registering a face.",
    });
  }

  const name = [employee.firstName, employee.middleName, employee.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  const r = await callEngine("/register/upload", {
    employee_id: String(employee.biometricId),
    employee_name: name || null,
    username: employee.email || null,
    files: files.map((f) => ({
      filename: typeof f.filename === "string" ? f.filename : "photo.jpg",
      data: f.data,
    })),
  });
  if (r.status === 0) return engineUnavailable(res, r.error);
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return res.status(r.status === 413 ? 413 : 400).json({
      success: false,
      reason: (r.json && r.json.error) || "upload_failed",
    });
  }
  return res.status(200).json({
    success: true,
    folder: r.json.folder,
    folderCreated: r.json.folder_created,
    mappingLinked: r.json.mapping_linked,
    saved: r.json.saved || [],
    rejected: r.json.rejected || [],
    status: r.json.status || null,
  });
});

// ── POST /hr/face-registration/archive/:employeeId ──────────────────────
// Removes one photo from a gallery by MOVING it to _archive/. Nothing here
// deletes: a registration photo is evidence, and if a gallery gets worse
// afterwards the way back has to still exist.
router.post("/archive/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  const { folder, filename } = req.body || {};
  if (!folder || !filename) {
    return res.status(400).json({ success: false, reason: "missing_target" });
  }

  let employee = null;
  try {
    employee = await Employee.findById(req.params.employeeId)
      .select("biometricId")
      .lean();
  } catch (err) {
    employee = null;
  }
  if (!employee || !employee.biometricId) {
    return res.status(404).json({ success: false, message: "Employee not found" });
  }

  // The folder must be one this employee is actually linked to. Otherwise an
  // authenticated HR user could archive somebody else's photos by naming
  // their folder.
  const snap = await loadSnapshot();
  if (snap.ok) {
    const owns = (snap.snap.people || []).some(
      (p) =>
        p.folder === folder &&
        p.employee_id &&
        String(p.employee_id) === String(employee.biometricId),
    );
    if (!owns) {
      return res.status(403).json({
        success: false,
        reason: "folder_not_owned_by_employee",
      });
    }
  }

  const r = await callEngine("/register/archive", {
    folder,
    filename,
    reason: (req.body && req.body.reason) || "archived_by_hr",
  });
  if (r.status === 0) return engineUnavailable(res, r.error);
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return res.status(400).json({
      success: false,
      reason: (r.json && r.json.error) || "archive_failed",
    });
  }
  return res.status(200).json({
    success: true,
    archivedTo: r.json.archived_to,
    filename: r.json.filename,
    status: r.json.status || null,
  });
});

// ── POST /hr/face-registration/recheck ──────────────────────────────────
// Re-read one gallery from disk. Live, unlike /status, which serves a
// snapshot — after an upload the operator needs the current answer.
router.post("/recheck", EmployeeAuthMiddlewear, async (req, res) => {
  const { folder } = req.body || {};
  if (!folder) {
    return res.status(400).json({ success: false, reason: "missing_folder" });
  }
  const r = await callEngine("/register/status", { folder }, 30000);
  if (r.status === 0) return engineUnavailable(res, r.error);
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return res.status(404).json({
      success: false,
      reason: (r.json && r.json.error) || "folder_not_found",
    });
  }
  return res.status(200).json({ success: true, status: r.json.status });
});

// ── POST /hr/face-registration/photo/:employeeId ────────────────────────
// One thumbnail, as a data URL. POST rather than GET because the filename
// travels in the body: putting it in a URL path invites an encoded traversal
// that some proxy normalises differently from the way we check it.
router.post("/photo/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
  const { folder, filename } = req.body || {};
  if (!folder || !filename) {
    return res.status(400).json({ success: false, reason: "missing_target" });
  }

  let employee = null;
  try {
    employee = await Employee.findById(req.params.employeeId)
      .select("biometricId")
      .lean();
  } catch (err) {
    employee = null;
  }
  if (!employee || !employee.biometricId) {
    return res.status(404).json({ success: false, message: "Employee not found" });
  }

  // Same ownership rule as archiving: a photo can only be read through the
  // employee it belongs to, so one HR user cannot browse another gallery by
  // naming its folder.
  const snap = await loadSnapshot();
  if (snap.ok) {
    const owns = (snap.snap.people || []).some(
      (p) =>
        p.folder === folder &&
        p.employee_id &&
        String(p.employee_id) === String(employee.biometricId),
    );
    if (!owns) {
      return res
        .status(403)
        .json({ success: false, reason: "folder_not_owned_by_employee" });
    }
  }

  const r = await callEngine("/register/photo", { folder, filename }, 15000);
  if (r.status === 0) return engineUnavailable(res, r.error);
  if (r.status !== 200 || !r.json || r.json.ok !== true) {
    return res
      .status(404)
      .json({ success: false, reason: (r.json && r.json.error) || "not_found" });
  }
  return res.status(200).json({ success: true, image: r.json.image });
});

module.exports = router;
