"use strict";
/**
 * routes/HrRoutes/EmployeeDocuments_section.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HR side of employee-issued letters (appointment, offer, warning, experience,
 * relieving, salary certificate, other).
 *
 * Mount:
 *   app.use("/api/hr/documents", require("./routes/HrRoutes/EmployeeDocuments_section"));
 *
 * WITH the /api prefix. The bare `/hr/attendance/**` family is the attendance
 * module's historical exception and must not be copied here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RELEASE GATE — the point of the whole feature
 * ═══════════════════════════════════════════════════════════════════════════
 * Two INDEPENDENT booleans live on every row:
 *
 *   generated : the file exists on the HR side
 *   released  : the employee may see it
 *
 * They are never collapsed into one enum. HR may generate a letter and sit on
 * it forever; until someone here calls PATCH /:id/release, that row appears in
 * NO employee-facing response — not in a list, not by guessing an id. The
 * employee-facing projection lives in routes/Employee_Routes/documents.js and
 * is an allowlist; nothing in this file ever widens it.
 *
 * Invariants this file enforces:
 *   1. released === true  ⇒  generated === true   (else 400 NOT_GENERATED)
 *   2. release is reachable only from requestStatus ∈ {"none","requested"}
 *   3. `revoked` is NOT a stored boolean — a row is revoked iff
 *      released === false && revokedAt != null. Releasing clears the revoke*
 *      fields, so `released` stays the single truth for visibility.
 *   4. DELETE only while released === false && releaseCount === 0. Once
 *      something has been released it is a record, not a draft.
 *
 * Every mutation appends to `history` with who / when / which role, so a
 * release is auditable back to the HR user and to the request it answered.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  STORAGE — PRIVATE Google Drive, uploaded BY THE BACKEND
 * ═══════════════════════════════════════════════════════════════════════════
 * multer memoryStorage → services/employeeLetterDrive.service.js.
 *
 * The browser NEVER uploads and posts back a URL. If it did, a client could
 * inject an arbitrary URL into a record the employee is told to trust.
 *
 * WHY DRIVE AND NOT CLOUDINARY (this replaced Cloudinary; both reasons matter):
 *
 *   1. Cloudinary is not configured on this deployment. There is no
 *      CLOUDINARY_* triple in .env, so every upload rejected and Generate
 *      failed with a bare "Could not save the document".
 *
 *   2. A Cloudinary secure_url is PUBLIC AND PERMANENT, which made the release
 *      gate a DISCOVERY gate: an unreleased letter's URL appeared in no
 *      response and a revoked one disappeared, but anyone who had captured the
 *      URL kept it forever. Drive files here are private — no permission is
 *      ever granted to anyone — and every read is streamed through
 *      GET /:id/download, which re-runs the gate on each request. Revocation
 *      is now real rather than cosmetic.
 *
 * Rows written before the switch carry `file.storage === "cloudinary"` and a
 * public `file.url`. Read paths handle both; write paths only produce "drive".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENDPOINTS  (all behind EmployeeAuthMiddlewear — the CMS cookie/Bearer auth)
 * ═══════════════════════════════════════════════════════════════════════════
 *   GET    /requests              the queue: employee asks, newest first
 *   GET    /                      the library: every row, including hidden ones
 *   GET    /types                 all seven types + labels (CMS picker source)
 *   GET    /prefill/:employeeId   merge fields for the letter body
 *   GET    /:id                   one full row, with history
 *   GET    /:id/link              mint a short-lived URL that opens the PDF
 *   POST   /                      generate/upload for an employee (multipart)
 *   POST   /:id/file              attach or replace the PDF (multipart)
 *   PATCH  /:id/release           make it visible to the employee
 *   PATCH  /:id/revoke            take it back
 *   PATCH  /:id/decline           refuse a request
 *   DELETE /:id                   only while never released
 *
 * Plus ONE route that is deliberately OUTSIDE the auth middleware, declared
 * above it near the top of the file:
 *   GET    /:id/download?t=…      stream the private PDF; the signed token
 *                                 from /:id/link is the credential, because a
 *                                 browser opening a PDF sends no header
 *
 * ROUTE ORDER IS LOAD-BEARING: /requests, /types and /prefill/:employeeId are
 * declared BEFORE /:id, or Express reads "types" as an id.
 */

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Employee = require("../../models/Employee");
const { decryptEmployeeDoc } = require("../../utils/salaryEncryption");
const { cloudinary } = require("../../utils/cloudinary"); // legacy rows only
const {
  uploadEmployeeLetter,
  streamEmployeeLetter,
  deleteEmployeeLetter,
} = require("../../services/employeeLetterDrive.service");
const {
  mintLetterToken,
  verifyLetterToken,
  absoluteUrl,
} = require("../../utils/letterDownloadToken");

const EmployeeDocument = require("../../models/HR_Models/EmployeeDocument");
const DOC_TYPES = EmployeeDocument.DOC_TYPES || [
  "appointment",
  "offer",
  "warning",
  "experience",
  "relieving",
  "salary_certificate",
  "other",
];
const TYPE_LABEL = EmployeeDocument.TYPE_LABEL || {};

// Push wrappers (§F). Required defensively: they are added to
// utils/notifyEmployee.js by the notifications change, and a missing wrapper
// must degrade to "no push" rather than crash the server at require time.
// Every call below is fire-and-forget — a push failure never fails the
// mutation that triggered it.
let notifyDocumentReleased = () => {};
let notifyDocumentDeclined = () => {};
let notifyDocumentRevoked = () => {};
try {
  const n = require("../../utils/notifyEmployee");
  if (typeof n.notifyDocumentReleased === "function")
    notifyDocumentReleased = n.notifyDocumentReleased;
  if (typeof n.notifyDocumentDeclined === "function")
    notifyDocumentDeclined = n.notifyDocumentDeclined;
  if (typeof n.notifyDocumentRevoked === "function")
    notifyDocumentRevoked = n.notifyDocumentRevoked;
} catch (e) {
  console.warn("[HR-DOCUMENTS] notifyEmployee unavailable:", e.message);
}

const safeNotify = (fn, ...args) => {
  try {
    fn(...args);
  } catch (e) {
    console.warn("[HR-DOCUMENTS] notification failed:", e?.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Upload middleware — copied from routes/Employee_Routes/leaveRoutes.js:36-51,
//  narrowed to PDF only. A letter the company issues is a PDF; a JPEG of a
//  letter is not a letter.
// ─────────────────────────────────────────────────────────────────────────────
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only a PDF can be issued as a letter."));
  },
}).single("document");

/** multer errors are plain Errors, not HTTP — turn them into a 400 with the message. */
const withUpload = (req, res, next) => {
  uploadMiddleware(req, res, (err) => {
    if (err)
      return res.status(400).json({ success: false, message: err.message });
    next();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The HR surface genuinely is HR — it gets the full row, `file.url` included. */
function toHrView(row) {
  return row;
}

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fullNameOf = (emp) =>
  [emp?.firstName, emp?.middleName, emp?.lastName].filter(Boolean).join(" ").trim();

const clampPage = (v) => Math.max(1, parseInt(v, 10) || 1);
const clampLimit = (v, d = 25) => Math.min(100, Math.max(1, parseInt(v, 10) || d));

const badRequest = (res, code, message) =>
  res.status(400).json({ success: false, code, message });

/** The actor, for history rows and the *By/*ByName pairs. */
const actor = (req) => ({
  id: isId(req.user?.id) ? req.user.id : null,
  name: req.user?.name || req.user?.email || "",
});

/**
 * letterMeta arrives as a JSON string on a multipart body. Parse it defensively
 * and keep only the fields the schema declares — a parse failure is a 400
 * BAD_META, never a 500, and an unexpected key never reaches the document.
 */
const META_KEYS = [
  "referenceNo",
  "issueDate",
  "effectiveDate",
  "lastWorkingDay",
  "resignationDate",
  "noticePeriodDays",
  "annualCTC",
  "signatoryName",
  "signatoryDesignation",
  "remarks",
  // Appointment letters only. The schema enum rejects anything else, so an
  // unexpected value is a 400 from Mongoose rather than a mislabelled record.
  "variant",
];

/** The letter types whose body prints a salary figure. See GET /prefill. */
const SALARY_LETTER_TYPES = new Set([
  "salary_certificate",
  "appointment",
  "offer",
]);

function parseLetterMeta(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, meta: null };
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return { ok: false };
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false };
  const meta = {};
  for (const k of META_KEYS) if (obj[k] !== undefined) meta[k] = obj[k];
  return { ok: true, meta };
}

/**
 * Read the subject's denormalised fields. Stored on the row at write time,
 * exactly as RegularizationRequest does, so the queue renders without an N+1
 * populate and an audit row survives an employee rename.
 */
async function subjectFields(employeeId) {
  const emp = await Employee.findById(employeeId)
    .select("firstName middleName lastName biometricId department designation")
    .lean();
  if (!emp) return null;
  return {
    employeeId: emp._id,
    biometricId: emp.biometricId || "",
    employeeName: fullNameOf(emp),
    department: emp.department || "",
    designation: emp.designation || "",
  };
}

/** Upload a PDF buffer and return the `file` sub-document. */
async function uploadLetter(file, type) {
  const up = await uploadEmployeeLetter(file.buffer, {
    fileName: file.originalname || `${TYPE_LABEL[type] || type}.pdf`,
    mimeType: file.mimetype || "application/pdf",
    subfolder: TYPE_LABEL[type] || type,
  });
  if (!up?.driveFileId) throw new Error("Upload failed");
  return {
    ...up,
    bytes: file.size || up.bytes || 0,
  };
}

/** Does this row actually have bytes behind it, on either storage backend? */
const hasFile = (file) => !!(file?.driveFileId || file?.url);

/**
 * Destroy the stored bytes, warn-only, on whichever backend holds them.
 *
 * An orphaned file is far better than a failed replacement, so a failure here
 * only warns and the database write proceeds.
 */
async function destroyStored(file) {
  if (!file) return;
  try {
    if (file.driveFileId) {
      await deleteEmployeeLetter(file.driveFileId);
      return;
    }
    // Legacy Cloudinary rows. resource_type MUST be "raw" — utils/cloudinary
    // `deleteImage` defaults to "image" and silently no-ops on these.
    if (file.publicId) {
      await cloudinary.uploader.destroy(file.publicId, { resource_type: "raw" });
    }
  } catch (e) {
    console.warn("[HR-DOCUMENTS] stored-file destroy failed:", file.driveFileId || file.publicId, e?.message);
  }
}

/**
 * §C.5's gate, in one place so the release route and POST?releaseNow=true can
 * never drift apart. Returns a { code, message } to 400 with, or null to go.
 */
function releaseBlocker(row) {
  if (!row.generated || !hasFile(row.file))
    return {
      code: "NOT_GENERATED",
      message: "Generate or upload the document before releasing it.",
    };
  if (row.released) return { code: "ALREADY_RELEASED", message: "Already released." };
  if (["declined", "cancelled"].includes(row.requestStatus))
    return {
      code: "INVALID_TRANSITION",
      message: `Cannot release — the request was ${row.requestStatus}.`,
    };
  return null;
}

/**
 * The release mutation. Records WHO released, WHEN, and — via
 * requestStatus → "fulfilled" plus the history entry — WHICH request it
 * answered. Caller must have run releaseBlocker() first.
 *
 * Returns true if this release fulfilled an open employee request.
 */
function applyRelease(row, who, note) {
  const fulfilledRequest = row.requestStatus === "requested";
  row.released = true;
  row.releasedAt = new Date();
  row.releasedBy = who.id;
  row.releasedByName = who.name;
  row.releaseCount = (row.releaseCount || 0) + 1;
  if (fulfilledRequest) row.requestStatus = "fulfilled";
  // A re-release after a revoke wipes the revoke trail from the live fields;
  // the history entries keep the record of both.
  row.revokedAt = null;
  row.revokedBy = null;
  row.revokedByName = "";
  row.revokeReason = "";
  row.history.push({
    action: "released",
    at: new Date(),
    byId: who.id,
    byName: who.name,
    byRole: "hr",
    note: note || "",
  });
  return fulfilledRequest;
}

/**
 * For a page of rows, fetch the OTHER documents of the same type for the same
 * employees — one query for the whole page, grouped in memory, never per row.
 * Lets the CMS tell case (a) "we already have this, one click releases it"
 * from case (b) "nothing exists, go generate one".
 */
async function attachOtherExisting(rows) {
  if (!rows.length) return rows;
  const employeeIds = [...new Set(rows.map((r) => String(r.employeeId)))];
  const types = [...new Set(rows.map((r) => r.type))];
  const siblings = await EmployeeDocument.find({
    employeeId: { $in: employeeIds },
    type: { $in: types },
  })
    .select("employeeId type generated released releasedAt revokedAt createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const byKey = new Map();
  for (const s of siblings) {
    const k = `${String(s.employeeId)}::${s.type}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
  }
  return rows.map((r) => ({
    ...r,
    otherExisting: (byKey.get(`${String(r.employeeId)}::${r.type}`) || [])
      .filter((s) => String(s._id) !== String(r._id))
      .map((s) => ({
        _id: s._id,
        generated: !!s.generated,
        released: !!s.released,
        releasedAt: s.releasedAt || null,
        revokedAt: s.revokedAt || null,
        createdAt: s.createdAt,
      })),
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/hr/documents/:id/download?t=… — stream the private PDF
//
//  Deliberately NOT behind EmployeeAuthMiddlewear: it is opened by the browser
//  as a top-level navigation, which carries no Authorization header. The
//  signed token from /:id/link is the credential, it is scoped to this one
//  document, and it expires. The row is re-read on every request, so a letter
//  deleted a second ago is already gone.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:id/download", async (req, res) => {
  try {
    const claim = verifyLetterToken(req.query.t);
    // One undifferentiated 404 for every failure mode, exactly as the employee
    // route does: a bad token must not report whether the document exists.
    if (!claim || claim.s !== "hr" || String(claim.d) !== String(req.params.id)) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }

    const row = await EmployeeDocument.findById(req.params.id).select("file title type").lean();
    if (!row || !row.file?.driveFileId) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }

    const { stream, meta } = await streamEmployeeLetter(row.file.driveFileId);
    res.setHeader("Content-Type", row.file.mimeType || meta.mimeType || "application/pdf");
    // `inline` so it opens in the browser's PDF viewer rather than downloading
    // — HR is checking the letter, not filing it.
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(row.file.fileName || "letter.pdf")}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    stream.on("error", (e) => {
      console.error("[HR-DOCUMENTS] drive stream error:", e?.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /:id/download:", err);
    if (!res.headersSent) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }
    return res.destroy();
  }
});

router.use(EmployeeAuthMiddleware);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SECOND HALF OF THE RELEASE GATE — reject an EMPLOYEE APP token.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EmployeeAuthMiddlewear only calls jwt.verify(token, JWT_SECRET). The mobile
 * app's token (routes/Employee_Routes/login.js:140) is signed with the SAME
 * secret, so it VERIFIES here — it simply decodes to `{ id, email, type:
 * "employee" }` with no `role`. Presented as `Authorization: Bearer <app
 * token>`, it would otherwise walk straight into GET /api/hr/documents and read
 * the entire library: every generated-but-unreleased letter, `file.url`
 * included. That is precisely the disclosure the whole feature exists to
 * prevent, and it would be reachable by any employee with a phone.
 *
 * A CMS token (routes/login.js:123) always carries `role` (`hr_manager`,
 * `ceo`, …); the app token never does. That single asymmetry is the check.
 *
 * This is a PRE-EXISTING property of every /api/hr/** router, not something
 * this feature introduced — but this router is the one that returns hidden
 * documents, so it does not get to inherit the weakness. Fixing it globally in
 * EmployeeAuthMiddlewear is the right follow-up; doing it there in this change
 * would silently alter ~200 mounted routes at once.
 */
router.use((req, res, next) => {
  if (!req.user?.role || typeof req.user.role !== "string") {
    return res.status(403).json({
      success: false,
      code: "NOT_HR",
      message: "This area is for HR.",
    });
  }
  next();
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.1  GET /api/hr/documents/requests — the queue
// ═════════════════════════════════════════════════════════════════════════════
router.get("/requests", async (req, res) => {
  try {
    const {
      status = "requested",
      type,
      department,
      q,
      page: pageRaw,
      limit: limitRaw,
    } = req.query;

    const page = clampPage(pageRaw);
    const limit = clampLimit(limitRaw, 25);

    const filter = {};
    if (status === "all") {
      // Every row that carries an employee ask of any kind.
      filter.requestStatus = { $ne: "none" };
    } else if (["requested", "declined", "cancelled", "fulfilled"].includes(status)) {
      filter.requestStatus = status;
    } else {
      filter.requestStatus = "requested";
    }
    if (type && DOC_TYPES.includes(type)) filter.type = type;
    if (department) filter.department = department;
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      filter.$or = [{ employeeName: rx }, { biometricId: rx }];
    }

    const [total, rowsRaw, requested, awaitingGeneration, readyToRelease] =
      await Promise.all([
        EmployeeDocument.countDocuments(filter),
        EmployeeDocument.find(filter)
          .sort({ requestedAt: -1, createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        EmployeeDocument.countDocuments({ requestStatus: "requested" }),
        // Case (b): they asked, nothing exists yet.
        EmployeeDocument.countDocuments({
          requestStatus: "requested",
          generated: false,
        }),
        // Case (a): they asked, HR already has it — ONE CLICK finishes the job.
        EmployeeDocument.countDocuments({
          requestStatus: "requested",
          generated: true,
          released: false,
        }),
      ]);

    const data = await attachOtherExisting(rowsRaw);

    return res.json({
      success: true,
      data: data.map(toHrView),
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
      counts: { requested, awaitingGeneration, readyToRelease },
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /requests:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load document requests" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.7  GET /api/hr/documents/types — all seven, `warning` INCLUDED
//
//  The CMS reads this so its picker and the model cannot drift. The employee
//  app reads GET /api/employee/documents/types instead, which omits `warning`
//  — nobody asks HR to warn them.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/types", (_req, res) => {
  return res.json({
    success: true,
    data: DOC_TYPES.map((value) => ({ value, label: TYPE_LABEL[value] || value })),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.7  GET /api/hr/documents/prefill/:employeeId?type=…
//
//  Merge fields for the letter body. THE ONE AND ONLY place salary is
//  decrypted for this feature, and only when the letter is a salary
//  certificate. Never write ciphertext (or plaintext salary) back into
//  letterMeta beyond the single `annualCTC` string HR confirms.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/prefill/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!isId(employeeId))
      return badRequest(res, "BAD_ID", "Invalid employee id");

    const type = String(req.query.type || "");

    const emp = await Employee.findById(employeeId).lean();
    if (!emp)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const dec = decryptEmployeeDoc(emp);

    // The father's name, assembled the same way fullNameOf() assembles the
    // employee's. Falls through to the spouse for a married woman, because the
    // appointment letters are addressed "W/o- <husband>" in exactly that case.
    const fatherName = [emp.fatherFirstName, emp.fatherMiddleName, emp.fatherLastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    const isMarriedWoman =
      String(emp.gender || "").toLowerCase() === "female" &&
      String(emp.maritalStatus || "").toLowerCase().startsWith("married");

    const data = {
      employeeId: String(emp._id),
      fullName: fullNameOf(emp),
      firstName: emp.firstName || "",
      title: emp.title || "",
      biometricId: emp.biometricId || "",
      designation: emp.designation || "",
      jobTitle: emp.jobTitle || "",
      department: emp.department || "",
      dateOfJoining: emp.dateOfJoining || null,
      confirmationDate: emp.confirmationDate || null,
      employmentType: emp.employmentType || "",
      workLocation: emp.workLocation || "",

      // Needed to address an appointment letter: the honorific (Mr./Ms.) and
      // the S/o · D/o · W/o relation are both derived from these two fields.
      // HR can override the result in the form — a widowed or separated
      // employee is not reliably inferable from a marital-status string.
      gender: emp.gender || "",
      maritalStatus: emp.maritalStatus || "",
      guardianName: (isMarriedWoman && emp.spouseName) || fatherName || "",

      // Permanent as well as current: a worker's letter is normally addressed
      // to the village address, which is the permanent one.
      address: {
        current: emp.address?.current || null,
        permanent: emp.address?.permanent || null,
      },
      documents: {
        panNumber: emp.documents?.panNumber || "",
        uanNumber: emp.documents?.uanNumber || "",
        pfNumber: emp.documents?.pfNumber || "",
      },
      primaryManager: emp.primaryManager || null,
    };

    // Salary is AES-256-GCM encrypted at rest (utils/salaryEncryption.js) and
    // is decrypted here for the letter types that PRINT a salary figure, and
    // for no others:
    //   salary_certificate — the figure is the whole certificate
    //   appointment        — Annexure I is a full monthly breakdown
    //   offer              — states the cost to company
    // A warning or relieving letter never sees it. Widening this list means
    // deciding that the letter genuinely needs the number on the page.
    if (SALARY_LETTER_TYPES.has(type)) data.salary = dec?.salary || null;

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /prefill:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load employee details" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.2  GET /api/hr/documents — the library
//
//  EVERY row, including generated-and-never-released. This is the HR surface;
//  the hidden rows are exactly what HR needs to see.
// ═════════════════════════════════════════════════════════════════════════════
const STATE_FILTERS = {
  generated_unreleased: { generated: true, released: false, revokedAt: null },
  released: { released: true },
  revoked: { released: false, revokedAt: { $ne: null } },
  awaiting_generation: { generated: false, requestStatus: "requested" },
};

router.get("/", async (req, res) => {
  try {
    const {
      employeeId,
      type,
      department,
      state = "all",
      q,
      page: pageRaw,
      limit: limitRaw,
    } = req.query;

    const page = clampPage(pageRaw);
    const limit = clampLimit(limitRaw, 25);

    const filter = {};
    if (employeeId) {
      if (!isId(employeeId)) return badRequest(res, "BAD_ID", "Invalid employee id");
      filter.employeeId = new mongoose.Types.ObjectId(String(employeeId));
    }
    if (type && DOC_TYPES.includes(type)) filter.type = type;
    if (department) filter.department = department;
    if (q && String(q).trim()) {
      const rx = new RegExp(escapeRegex(String(q).trim()), "i");
      filter.$or = [{ employeeName: rx }, { biometricId: rx }, { title: rx }];
    }
    if (STATE_FILTERS[state]) Object.assign(filter, STATE_FILTERS[state]);

    // The counts drive the four summary tiles, which double as the state
    // filter strip — so they are counted over everything EXCEPT the state
    // clause (otherwise selecting a tile zeroes the other three).
    const countBase = { ...filter };
    for (const k of Object.keys(STATE_FILTERS[state] || {})) delete countBase[k];

    const [total, rows, awaitingGeneration, generatedUnreleased, released, revoked] =
      await Promise.all([
        EmployeeDocument.countDocuments(filter),
        EmployeeDocument.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        EmployeeDocument.countDocuments({
          ...countBase,
          ...STATE_FILTERS.awaiting_generation,
        }),
        EmployeeDocument.countDocuments({
          ...countBase,
          ...STATE_FILTERS.generated_unreleased,
        }),
        EmployeeDocument.countDocuments({ ...countBase, ...STATE_FILTERS.released }),
        EmployeeDocument.countDocuments({ ...countBase, ...STATE_FILTERS.revoked }),
      ]);

    return res.json({
      success: true,
      data: rows.map(toHrView),
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
      // Keyed by the `state` param values so a tile can pass its own key
      // straight back as the filter. camelCase aliases follow for readability.
      counts: {
        awaiting_generation: awaitingGeneration,
        generated_unreleased: generatedUnreleased,
        released,
        revoked,
        awaitingGeneration,
        generatedUnreleased,
      },
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load documents" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.3  POST /api/hr/documents — generate / upload for an employee
//
//  multipart/form-data, file field named `document`.
//
//  THE DEFAULT IS NOT RELEASED. `releaseNow` must be an explicit opt-in; a
//  default of "released" quietly deletes the feature.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/", withUpload, async (req, res) => {
  try {
    const {
      employeeId,
      type,
      otherTypeLabel = "",
      title = "",
      hrNotes = "",
      releaseNow,
      requestId,
    } = req.body || {};

    if (!req.file)
      return badRequest(res, "NO_FILE", "Attach the PDF you want to issue.");
    if (!isId(employeeId))
      return badRequest(res, "BAD_ID", "Pick the employee this letter is for.");
    if (!DOC_TYPES.includes(type))
      return badRequest(res, "BAD_TYPE", "Pick which document this is.");
    if (type === "other" && !String(otherTypeLabel).trim())
      return badRequest(res, "LABEL_REQUIRED", "Say which document this is.");

    const parsed = parseLetterMeta(req.body?.letterMeta);
    if (!parsed.ok)
      return badRequest(res, "BAD_META", "The letter details could not be read.");

    const subject = await subjectFields(employeeId);
    if (!subject)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const who = actor(req);
    const now = new Date();
    const resolvedTitle =
      String(title).trim() ||
      (type === "other"
        ? String(otherTypeLabel).trim()
        : TYPE_LABEL[type] || type);

    let row;
    let replacing = "";

    if (requestId) {
      // Generating AGAINST an existing request row — the queue drawer's
      // one-call path. Same effect as POST /:id/file; it exists so the CMS
      // does not have to create-then-attach.
      if (!isId(requestId)) return badRequest(res, "BAD_ID", "Invalid request id");
      row = await EmployeeDocument.findById(requestId);
      if (!row)
        return res.status(404).json({ success: false, message: "Request not found" });
      if (String(row.employeeId) !== String(employeeId))
        return badRequest(
          res,
          "MISMATCH",
          "That request belongs to a different employee.",
        );
      if (row.generated)
        return badRequest(
          res,
          "ALREADY_GENERATED",
          "That request already has a document. Replace the file instead.",
        );
      if (String(title).trim()) row.title = resolvedTitle;
      if (String(otherTypeLabel).trim()) row.otherTypeLabel = String(otherTypeLabel).trim();
    } else {
      row = new EmployeeDocument({
        ...subject,
        type,
        otherTypeLabel: type === "other" ? String(otherTypeLabel).trim() : "",
        title: resolvedTitle,
        requestStatus: "none",
      });
    }

    const uploaded = await uploadLetter(req.file, row.type || type);
    if (row.generated && hasFile(row.file)) replacing = { ...row.file };
    row.file = uploaded;
    row.generated = true;
    row.generatedAt = now;
    row.generatedBy = who.id;
    row.generatedByName = who.name;
    if (String(hrNotes).trim()) row.hrNotes = String(hrNotes).trim();
    if (parsed.meta) row.letterMeta = { ...(row.letterMeta || {}), ...parsed.meta };
    row.history.push({
      action: "generated",
      at: now,
      byId: who.id,
      byName: who.name,
      byRole: "hr",
      note: requestId ? "Generated against an employee request" : "",
    });

    // The release is opt-in and separate, even inside this one call.
    let released = false;
    let fulfilledRequest = false;
    if (String(releaseNow) === "true") {
      const blocker = releaseBlocker(row);
      if (!blocker) {
        fulfilledRequest = applyRelease(row, who, "Released on generation");
        released = true;
      }
    }

    await row.save();
    if (replacing) destroyStored(replacing);
    // Fires ONCE, never twice, even though two mutations happened.
    if (released) safeNotify(notifyDocumentReleased, row);

    return res.status(201).json({
      success: true,
      data: toHrView(row.toObject()),
      released,
      fulfilledRequest,
      message: released
        ? "Generated and released to the employee."
        : "Generated. The employee cannot see it until you release it.",
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] POST /:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not save the document" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.4  POST /api/hr/documents/:id/file — attach or replace the PDF
//
//  DOES NOT CHANGE `released`. Replacing the file of an already-released
//  document keeps it released, at the new URL.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/:id/file", withUpload, async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");
    if (!req.file) return badRequest(res, "NO_FILE", "Attach the PDF.");

    const row = await EmployeeDocument.findById(req.params.id);
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });

    const who = actor(req);
    const now = new Date();
    const wasGenerated = !!row.generated;
    const oldFile = hasFile(row.file) ? { ...row.file } : null;

    row.file = await uploadLetter(req.file, row.type);
    if (!wasGenerated) {
      row.generated = true;
      row.generatedAt = now;
      row.generatedBy = who.id;
      row.generatedByName = who.name;
    }
    row.history.push({
      action: wasGenerated ? "file_replaced" : "generated",
      at: now,
      byId: who.id,
      byName: who.name,
      byRole: "hr",
      note: "",
    });

    await row.save();
    // Warn-only, and only after the new file is safely saved.
    if (wasGenerated && oldFile) destroyStored(oldFile);

    return res.json({
      success: true,
      data: toHrView(row.toObject()),
      message: wasGenerated ? "File replaced." : "File attached.",
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] POST /:id/file:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not attach the file" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.5  PATCH /api/hr/documents/:id/release — make it visible
//
//  The gate. Records who released it, when, and against which request
//  (requestStatus → "fulfilled", plus a history entry naming the HR user).
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/:id/release", async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");

    const row = await EmployeeDocument.findById(req.params.id);
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });

    const blocker = releaseBlocker(row);
    if (blocker) return badRequest(res, blocker.code, blocker.message);

    const note = String(req.body?.note || "").trim();
    const fulfilledRequest = applyRelease(row, actor(req), note);
    await row.save();

    safeNotify(notifyDocumentReleased, row);

    return res.json({
      success: true,
      data: toHrView(row.toObject()),
      released: true,
      fulfilledRequest,
      message: "Released to the employee.",
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] PATCH /:id/release:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not release the document" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.6  PATCH /api/hr/documents/:id/revoke — take it back
//
//  requestStatus stays "fulfilled": the ask WAS answered, and the answer was
//  later withdrawn. That is what makes employeeStatus() read "withdrawn"
//  rather than reverting to "requested".
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/:id/revoke", async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");

    const reason = String(req.body?.reason || "").trim();
    if (!reason)
      return badRequest(res, "REASON_REQUIRED", "Say why you are withdrawing it.");

    const row = await EmployeeDocument.findById(req.params.id);
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });
    if (!row.released)
      return badRequest(res, "NOT_RELEASED", "That document is not released.");

    const who = actor(req);
    const now = new Date();
    row.released = false;
    row.revokedAt = now;
    row.revokedBy = who.id;
    row.revokedByName = who.name;
    row.revokeReason = reason;
    row.history.push({
      action: "revoked",
      at: now,
      byId: who.id,
      byName: who.name,
      byRole: "hr",
      note: reason,
    });

    await row.save();
    safeNotify(notifyDocumentRevoked, row);

    return res.json({
      success: true,
      data: toHrView(row.toObject()),
      released: false,
      message: "Withdrawn from the employee.",
      // The honest caveat, surfaced so the CMS can show it. See the header:
      // the gate is a discovery gate, not a cryptographic one.
      warning:
        "The employee can no longer find or open this document in the app. A link they already saved may still work.",
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] PATCH /:id/revoke:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not withdraw the document" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  PATCH /api/hr/documents/:id/decline — refuse an employee request
//
//  Terminal for the ask. Does NOT touch `generated`, `file` or `released` —
//  declining a request that adopted a hidden document leaves that document
//  exactly where it was: hidden.
// ═════════════════════════════════════════════════════════════════════════════
router.patch("/:id/decline", async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");

    const row = await EmployeeDocument.findById(req.params.id);
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });
    if (row.requestStatus !== "requested")
      return badRequest(
        res,
        "INVALID_TRANSITION",
        row.requestStatus === "none"
          ? "There is no request to decline."
          : `Cannot decline — the request is already ${row.requestStatus}.`,
      );

    // Optional. The employee's row shows the reason only when there is one —
    // an absent reason renders no line, never "No reason given."
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    const who = actor(req);
    const now = new Date();

    row.requestStatus = "declined";
    row.declinedAt = now;
    row.declinedBy = who.id;
    row.declinedByName = who.name;
    row.declineReason = reason;
    row.history.push({
      action: "declined",
      at: now,
      byId: who.id,
      byName: who.name,
      byRole: "hr",
      note: reason,
    });

    await row.save();
    safeNotify(notifyDocumentDeclined, row, reason);

    return res.json({
      success: true,
      data: toHrView(row.toObject()),
      released: false,
      message: "Request declined.",
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] PATCH /:id/decline:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not decline the request" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.7  DELETE /api/hr/documents/:id
//
//  Only while it has NEVER been released. Once something has been released it
//  is a record — revoke it instead.
// ═════════════════════════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");

    const row = await EmployeeDocument.findById(req.params.id);
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });
    if (row.released || (row.releaseCount || 0) > 0)
      return badRequest(
        res,
        "IMMUTABLE",
        "A document that has been released cannot be deleted.",
      );

    const stored = hasFile(row.file) ? { ...row.file } : null;
    await EmployeeDocument.deleteOne({ _id: row._id });
    if (stored) destroyStored(stored);

    return res.json({ success: true, message: "Document deleted." });
  } catch (err) {
    console.error("[HR-DOCUMENTS] DELETE /:id:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not delete the document" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/hr/documents/:id/link — a short-lived URL that opens the PDF
//
//  The file is private in Drive, so there is nothing to link to directly. HR's
//  browser cannot send its Bearer header on a plain <a href> either (and in
//  dev the cookie is cross-origin, so it is not sent at all — see the repo
//  CLAUDE.md). This mints a signed, ~10-minute, single-document URL instead.
//
//  Authenticated normally: only an HR session can mint a link. HR may open a
//  letter that has NOT been released — that is the whole point of the library.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:id/link", async (req, res) => {
  try {
    if (!isId(req.params.id))
      return badRequest(res, "BAD_ID", "Invalid document id");

    const row = await EmployeeDocument.findById(req.params.id)
      .select("file title type")
      .lean();
    if (!row || !hasFile(row.file))
      return res
        .status(404)
        .json({ success: false, message: "No file on this document" });

    // Legacy Cloudinary rows keep working: their URL is already public, and
    // there is nothing to stream.
    if (!row.file.driveFileId && row.file.url) {
      return res.json({ success: true, data: { url: row.file.url, legacy: true } });
    }

    const token = mintLetterToken({
      docId: row._id,
      scope: "hr",
      subject: req.user?.id,
    });
    return res.json({
      success: true,
      data: {
        url: absoluteUrl(req, `/api/hr/documents/${row._id}/download?t=${encodeURIComponent(token)}`),
        legacy: false,
      },
    });
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /:id/link:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not prepare the download" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  §C.7  GET /api/hr/documents/:id — one full row, with history
//
//  LAST. Every literal path above must be declared before this or Express
//  reads it as an id.
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return badRequest(res, "BAD_ID", "Invalid document id");

    const row = await EmployeeDocument.findById(req.params.id).lean();
    if (!row)
      return res.status(404).json({ success: false, message: "Document not found" });

    return res.json({ success: true, data: toHrView(row) });
  } catch (err) {
    console.error("[HR-DOCUMENTS] GET /:id:", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load the document" });
  }
});

module.exports = router;
