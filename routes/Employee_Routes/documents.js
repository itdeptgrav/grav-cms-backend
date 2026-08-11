"use strict";
/**
 * routes/Employee_Routes/documents.js
 * ───────────────────────────────────────────────────────────────────────────
 * HR-issued letters — THE EMPLOYEE SIDE ONLY.
 *
 * Mount:
 *   const empDocuments = require("./routes/Employee_Routes/documents");
 *   app.use("/api/employee/documents", empDocuments);
 *
 *   GET   /                — my documents and my requests
 *   GET   /types           — what I may request (six; `warning` is absent)
 *   POST  /requests        — ask HR for a document type
 *   GET   /:id             — one row, same gate as the list
 *   GET   /:id/file        — the download URL for a RELEASED document
 *   PATCH /:id/cancel      — withdraw my own open request
 *
 * ROUTE ORDER IS LOAD-BEARING: /types and /requests are declared BEFORE any
 * /:id route, or Express reads "types" as an id. Same rule as
 * regularization.js:20-21.
 *
 * ─── THE SECURITY REQUIREMENT IS THE FEATURE ───────────────────────────────
 *
 * HR generates a document and it lives on the HR side ONLY. The employee does
 * not see it until they request that type AND HR releases it. So this file has
 * exactly one job beyond CRUD: a generated-but-unreleased row must be
 * unreachable from here, including by guessing an _id.
 *
 * Three mechanics enforce that, and none of them is an `if`:
 *
 *   1. The SUBJECT always comes from the verified token (`req.user.id`). There
 *      is no employeeId parameter on any route in this file, so there is
 *      nothing to tamper with.
 *   2. `released: true` is a QUERY CLAUSE, not a branch, on the one route that
 *      returns a URL. A guessed id for someone else's document, or for an
 *      unreleased one, returns the same undifferentiated 404 — the response
 *      does not distinguish "does not exist" from "exists but is not yours",
 *      so it leaks nothing by wording or by timing.
 *   3. `toEmployeeView` is an ALLOWLIST, never a blocklist. GET
 *      /api/employee/profile (employeeAuth.js:17) uses `.select("-password …")`
 *      — a blocklist — and that is precisely how it ended up shipping HR's
 *      uploaded offer letters to the app. A field added to the schema later
 *      must not silently re-open the same hole here.
 *
 * ─── NO PUSH FIRES FROM THIS FILE ──────────────────────────────────────────
 *
 * Deliberately. `sendExpoPush` resolves recipients from the Employee
 * collection; HR CMS users live in HRDepartment and have no row there, so a
 * notify(hrUser) call would be dropped with a warn. HR learns of a new request
 * from the CMS queue page. Everything employee-directed (released / declined /
 * withdrawn) is pushed from the HR routes via utils/notifyEmployee.js. Do not
 * add a second push path here.
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const EmployeeDocument = require("../../models/HR_Models/EmployeeDocument");
const { streamEmployeeLetter } = require("../../services/employeeLetterDrive.service");
const {
  mintLetterToken,
  verifyLetterToken,
  absoluteUrl,
} = require("../../utils/letterDownloadToken");

// DOC_TYPES is deliberately NOT imported. Every type check in this file runs
// against EMPLOYEE_REQUESTABLE, so a seventh HR-only type added to the model
// later is refused here by default rather than by someone remembering to
// exclude it.
const { EMPLOYEE_REQUESTABLE, TYPE_LABEL, employeeStatusOf } = EmployeeDocument;

const fullName = (emp) =>
  [emp?.firstName, emp?.middleName, emp?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

/**
 * THE GATE. The single function that turns a row into something an employee
 * may see. An ALLOWLIST — see the header.
 *
 * `file` is present ONLY when released === true, and even then it carries no
 * URL: the URL lives in GET /:id/file alone, so a stray console.log(data) on
 * the device cannot carry a live link for every letter the employee owns.
 *
 * Never emitted, at any point, for any reason: `generated`, `file.url`,
 * `file.publicId`, `hrNotes`, `letterMeta`, `history`, the generatedBy /
 * releasedBy / revokedBy trios, or `revokeReason`.
 */
function toEmployeeView(row) {
  const released = Boolean(row.released);
  return {
    _id: String(row._id),
    type: row.type,
    otherTypeLabel: row.otherTypeLabel || "",
    title: row.title || "",
    status: employeeStatusOf(row), // available|withdrawn|requested|declined|cancelled
    requestedAt: row.requestedAt || null,
    requestReason: row.requestReason || "",
    declineReason: row.declineReason || "",
    releasedAt: released ? row.releasedAt : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(released
      ? {
          file: {
            fileName: row.file?.fileName || "",
            mimeType: row.file?.mimeType || "application/pdf",
            bytes: row.file?.bytes || 0,
          },
        }
      : {}),
  };
}

/**
 * The visibility filter, written once so the list and the single-row read
 * cannot drift apart.
 *
 * WHY THIS CANNOT LEAK: a generated-but-unreleased row has `released: false`
 * and — unless the employee themselves asked for it — `requestStatus: "none"`
 * and `revokedAt: null`. It matches no branch. There is deliberately no branch
 * keyed on `generated`; the word does not appear in this file's queries at
 * all.
 *
 * Even when the employee HAS asked and the adoption step (POST /requests, step
 * 4) re-pointed a hidden HR row at their request, that row matches branch 2
 * only — and toEmployeeView emits no `generated` and no file URL, so the
 * employee learns they have a pending request and nothing more.
 */
const visibleTo = (employeeId) => ({
  employeeId,
  $or: [
    { released: true },
    { requestStatus: { $in: ["requested", "declined", "cancelled"] } },
    // One I once had, that HR has since withdrawn.
    { revokedAt: { $ne: null }, requestStatus: "fulfilled" },
  ],
});

const badId = (id) => !mongoose.isValidObjectId(id);

// ═══════════════════════════════════════════════════════════════════════════
//  STATIC PATHS — declared BEFORE /:id so they are never read as ids
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /types — what an employee may ask for.
 *
 * Served from the model's own constants so the app, the CMS and the schema
 * cannot drift on labels. `warning` is absent and must stay absent: nobody
 * requests their own warning letter.
 */
router.get("/types", AllEmployeeAppMiddleware, (_req, res) => {
  return res.json({
    success: true,
    data: EMPLOYEE_REQUESTABLE.map((value) => ({
      value,
      label: TYPE_LABEL[value] || value,
    })),
  });
});

/**
 * POST /requests — ask HR for a document type.
 *
 * The one genuinely subtle handler in this file, because of step 4.
 */
router.post("/requests", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employeeId = req.user?.id;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const type = String(req.body?.type || "").trim();
    const otherTypeLabel = String(req.body?.otherTypeLabel || "").trim();
    const reason = String(req.body?.reason || "").trim();

    // ── 1. Type gate ──────────────────────────────────────────────────────
    // "warning" gets its own message: it IS a real type, it simply is not the
    // employee's to ask for. A bare "Pick which document you need" would read
    // as a bug to someone who just picked one.
    if (type === "warning") {
      return res.status(400).json({
        success: false,
        code: "NOT_REQUESTABLE",
        message: "That letter is issued by HR, not requested.",
      });
    }
    if (!EMPLOYEE_REQUESTABLE.includes(type)) {
      return res.status(400).json({
        success: false,
        code: "BAD_TYPE",
        message: "Pick which document you need.",
      });
    }

    // ── 2. "other" needs a label, or the HR queue gets a row saying "Other" ─
    if (type === "other" && !otherTypeLabel) {
      return res.status(400).json({
        success: false,
        code: "LABEL_REQUIRED",
        message: "Say which document you need.",
      });
    }

    if (reason.length > 500) {
      return res.status(400).json({
        success: false,
        code: "REASON_TOO_LONG",
        message: "Keep the reason under 500 characters.",
      });
    }

    const emp = await Employee.findById(employeeId)
      .select("firstName middleName lastName biometricId department designation")
      .lean();
    if (!emp) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }
    const employeeName = fullName(emp);

    // ── 3. Reject a duplicate open ask ────────────────────────────────────
    const open = await EmployeeDocument.findOne({
      employeeId,
      type,
      requestStatus: "requested",
    }).lean();
    if (open) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_REQUESTED",
        message: "You already have a request open for that.",
      });
    }

    // ── 4. ADOPT an existing hidden document, if there is one ─────────────
    //
    // This is the whole "HR already made it" case, and it is handled WITHOUT
    // creating a second row and WITHOUT telling the employee anything. HR then
    // sees a request against a row that already has a file and can release it
    // in one action.
    //
    // The employee's response is the same either way: "Requested". The
    // projection carries no `generated` and no `file`, so there is no way to
    // probe whether a document already exists by watching what comes back.
    const existing = await EmployeeDocument.findOne({
      employeeId,
      type,
      released: false,
      generated: true,
      requestStatus: { $in: ["none", "cancelled", "declined"] },
    }).sort({ createdAt: -1 });

    if (existing) {
      existing.requestStatus = "requested";
      existing.requestedAt = new Date();
      existing.requestReason = reason;
      // Clear the previous terminal state — this is a fresh ask against the
      // same document, and a stale declineReason would render under it in the
      // app.
      existing.declinedAt = null;
      existing.declineReason = "";
      existing.declinedBy = null;
      existing.declinedByName = "";
      existing.cancelledAt = null;
      if (type === "other" && otherTypeLabel) {
        existing.otherTypeLabel = otherTypeLabel;
      }
      existing.history.push({
        action: "requested",
        byRole: "employee",
        byId: employeeId,
        byName: employeeName,
        note: reason,
      });
      await existing.save();

      return res
        .status(201)
        .json({ success: true, data: toEmployeeView(existing) });
    }

    // ── 5. Otherwise, a bare request row: no file, nothing generated ──────
    const doc = await EmployeeDocument.create({
      employeeId,
      biometricId: String(emp.biometricId || "").toUpperCase(),
      employeeName,
      department: emp.department || "",
      designation: emp.designation || "",
      type,
      otherTypeLabel: type === "other" ? otherTypeLabel : "",
      title: type === "other" ? otherTypeLabel : TYPE_LABEL[type] || "",
      requestStatus: "requested",
      requestedAt: new Date(),
      requestReason: reason,
      generated: false,
      released: false,
      history: [
        {
          action: "requested",
          byRole: "employee",
          byId: employeeId,
          byName: employeeName,
          note: reason,
        },
      ],
    });

    // No push. HR is not push-reachable (see the header); the CMS queue is the
    // mechanism by which HR finds out.
    return res.status(201).json({ success: true, data: toEmployeeView(doc) });
  } catch (err) {
    // The unique partial index on { employeeId, type } where
    // requestStatus === "requested" is the third line of defence behind the
    // app's validation and step 3. Two taps in flight at once land here.
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        code: "ALREADY_REQUESTED",
        message: "You already have a request open for that.",
      });
    }
    console.error("[employee/documents POST /requests]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not send your request" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  READ
// ═══════════════════════════════════════════════════════════════════════════

/** GET / — my released documents plus the rows I asked about, newest first. */
router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const employeeId = req.user?.id;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const rows = await EmployeeDocument.find(visibleTo(employeeId))
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ success: true, data: rows.map(toEmployeeView) });
  } catch (err) {
    console.error("[employee/documents GET]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load your documents" });
  }
});

/**
 * GET /:id/file — the download URL for a RELEASED document.
 *
 * Returns JSON, NOT a redirect and NOT a binary: apiFetch (App
 * src/context/AuthContext.js) reads the body as text and JSON.parses it, so a
 * 302 or a PDF body throws "Server returned non-JSON response" on the device.
 *
 * The URL is fetched at press time rather than held in the list payload, so
 * the release state is re-checked here: a document HR withdrew a second ago
 * 404s instead of opening.
 *
 * Declared before /:id only for readability — the two cannot collide.
 */
router.get("/:id/file", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (badId(req.params.id)) {
      return res
        .status(404)
        .json({ success: false, message: "Document not available" });
    }

    // Three clauses, all in the QUERY. `released: true` is not an if().
    const row = await EmployeeDocument.findOne({
      _id: req.params.id,
      employeeId: req.user.id, // the subject comes from the token, never a param
      released: true, // ← the gate
    }).lean();

    // One undifferentiated 404 for "no such row", "not yours" and "not
    // released". Distinguishing them would turn this into an oracle for
    // whether HR has quietly written you a warning letter.
    if (!row || !(row.file?.driveFileId || row.file?.url)) {
      return res
        .status(404)
        .json({ success: false, message: "Document not available" });
    }

    // Letters live in PRIVATE Drive: there is no URL to hand out. Mint a
    // signed, ~10-minute, this-document-only link instead. The app opens it
    // with Linking.openURL, which sends no Authorization header — which is
    // exactly why the credential has to travel in the URL and expire fast.
    //
    // Legacy Cloudinary rows still carry a real public URL; return it as-is.
    const fileUrl = row.file.driveFileId
      ? absoluteUrl(
          req,
          `/api/employee/documents/${row._id}/download?t=${encodeURIComponent(
            mintLetterToken({ docId: row._id, scope: "employee", subject: req.user.id }),
          )}`,
        )
      : row.file.url;

    return res.json({
      success: true,
      data: {
        fileUrl,
        fileName: row.file.fileName || `${row.title || row.type}.pdf`,
        mimeType: row.file.mimeType || "application/pdf",
        bytes: row.file.bytes || 0,
        releasedAt: row.releasedAt,
      },
    });
  } catch (err) {
    console.error("[employee/documents GET /:id/file]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not open that document" });
  }
});

/**
 * GET /:id/download?t=… — stream the private PDF.
 *
 * NO AllEmployeeAppMiddleware, deliberately: this is opened by the OS as a
 * top-level navigation (Linking.openURL), which carries no Authorization
 * header. The signed token minted by /:id/file is the credential.
 *
 * THE TOKEN IS NOT THE GATE. The row is re-read here and the same three
 * clauses run again — id, `employeeId: <the token's subject>`, `released:
 * true`. A letter withdrawn one second ago stops opening immediately, even for
 * someone holding a token minted before the withdrawal. That is the whole
 * reason these files are private in Drive rather than public on a CDN.
 */
router.get("/:id/download", async (req, res) => {
  try {
    const claim = verifyLetterToken(req.query.t);
    if (
      !claim ||
      claim.s !== "employee" ||
      String(claim.d) !== String(req.params.id) ||
      badId(req.params.id) ||
      badId(claim.u)
    ) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }

    // Same query shape as /:id/file. The subject comes from the SIGNED token,
    // never from a parameter the caller can edit.
    const row = await EmployeeDocument.findOne({
      _id: req.params.id,
      employeeId: claim.u,
      released: true, // ← the gate, re-checked on every byte served
    }).lean();

    if (!row || !row.file?.driveFileId) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }

    const { stream, meta } = await streamEmployeeLetter(row.file.driveFileId);
    res.setHeader("Content-Type", row.file.mimeType || meta.mimeType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(row.file.fileName || "letter.pdf")}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    stream.on("error", (e) => {
      console.error("[employee/documents drive stream]", e?.message);
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    return stream.pipe(res);
  } catch (err) {
    console.error("[employee/documents GET /:id/download]", err);
    if (!res.headersSent) {
      return res.status(404).json({ success: false, message: "Document not available" });
    }
    return res.destroy();
  }
});

/** GET /:id — one row, through exactly the same gate as the list. */
router.get("/:id", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (badId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const row = await EmployeeDocument.findOne({
      _id: req.params.id,
      ...visibleTo(req.user.id),
    }).lean();

    if (!row) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    return res.json({ success: true, data: toEmployeeView(row) });
  } catch (err) {
    console.error("[employee/documents GET /:id]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load that document" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  WRITE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PATCH /:id/cancel — the employee withdraws their own open request.
 *
 * Deliberately does NOT touch `generated`, `file` or `released`. Cancelling a
 * request that adopted a hidden HR document leaves that document exactly where
 * it was — on the HR side, invisible.
 */
router.patch("/:id/cancel", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    if (badId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    const row = await EmployeeDocument.findOne({
      _id: req.params.id,
      employeeId: req.user.id,
    });
    if (!row) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    if (row.requestStatus !== "requested") {
      return res.status(400).json({
        success: false,
        code: "INVALID_TRANSITION",
        message: `Cannot cancel — ${row.requestStatus}`,
      });
    }

    const reason = String(req.body?.reason || "").trim().slice(0, 500);

    row.requestStatus = "cancelled";
    row.cancelledAt = new Date();
    row.history.push({
      action: "cancelled",
      byRole: "employee",
      byId: req.user.id,
      byName: row.employeeName || "",
      note: reason,
    });
    await row.save();

    return res.json({
      success: true,
      data: toEmployeeView(row),
      message: "Request cancelled",
    });
  } catch (err) {
    console.error("[employee/documents cancel]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not cancel your request" });
  }
});

module.exports = router;
// Exported for the HR routes and any future caller that must produce an
// employee-safe view of a row. There must only ever be one of these.
module.exports.toEmployeeView = toEmployeeView;
