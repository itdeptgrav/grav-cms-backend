/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkAttachments.js
 *
 * Private Cowork attachments — upload, download, delete.
 *
 * Mounted alongside the existing Cowork task routes and using the SAME auth
 * middleware. It does not replace `mediaUpload.js`: that path is
 * browser-direct-to-Google and makes files public, and it is still serving
 * chat and audio. This is the private path for anything attached to a task,
 * and the two are kept apart deliberately rather than one being bent into the
 * other — see `coworkAttachment.service.js` for why the shared service could
 * not simply be made private.
 *
 * **Every route here is authenticated, including the download.** The existing
 * `/media/view/:fileId` is intentionally open because `<img src>` cannot carry
 * a bearer token; that trade is acceptable only because those files are already
 * public. These files are not, so the download is gated and the client fetches
 * it with credentials rather than pointing an `<img>` at it.
 */

const express = require("express");
const multer = require("multer");
const admin = require("firebase-admin");
const { db } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const svc = require("../../services/coworkAttachment.service");

const router = express.Router();

/* In memory, nothing touches disk. The cap is enforced twice — here, so a
   large body is rejected before it is buffered, and again in the service,
   which is the boundary a non-HTTP caller would cross. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: svc.MAX_BYTES },
});

/**
 * Which task an attachment hangs off, whatever it is attached to.
 *
 * Every entity type Cowork attaches files to is either a task or lives on one,
 * so task visibility is the single question. Resolving to a task id here is
 * what lets the permission check below be one rule rather than one per type.
 */
function taskIdFor(entityType, entityId) {
  switch (String(entityType)) {
    case "task":
    case "rework":
    case "submission":
    case "review":
    case "comment": {
      // Composite ids are `${taskId}#${discriminator}` — a submission is
      // `T634#submission-2`, and each one needs its OWN entityId so that
      // resubmitting after rework does not pool every attempt's files into one
      // list. Split at the FIRST separator: the discriminator may contain more.
      const raw = String(entityId);
      const at = raw.indexOf("#");
      return at === -1 ? raw : raw.slice(0, at);
    }
    default:
      return null;
  }
}

/**
 * May this person see this task at all?
 *
 * Deliberately the SAME set legacy shows a task to — assignee, pending
 * assignee, creator, forwarder, approver, or a CEO — rather than a new rule.
 * A parallel permission model would drift from the one that decides whether
 * the task itself is visible, and the file would then be reachable on a task
 * the person cannot open.
 */
async function mayViewTask(taskId, user) {
  const snap = await db.collection("cowork_tasks").doc(String(taskId)).get();
  if (!snap.exists) return { ok: false, reason: "not_found" };
  const task = snap.data() || {};
  const me = String(user.employeeId);

  if (String(user.role) === "ceo") return { ok: true, task };
  if ((task.assigneeIds || []).map(String).includes(me)) return { ok: true, task };
  if (String(task.pendingAssigneeId || "") === me) return { ok: true, task };
  if (String(task.assignedBy || "") === me) return { ok: true, task };
  if (String(task.originalAssignedBy || "") === me) return { ok: true, task };
  if (String(task.approverId || "") === me) return { ok: true, task };
  if ((task.departmentApprovals || []).some((a) => String(a?.approverId) === me)) {
    return { ok: true, task };
  }
  if ((task.visibleTo || []).map(String).includes(me)) return { ok: true, task };
  return { ok: false, reason: "forbidden" };
}

/* ── Health ──────────────────────────────────────────────────────────────── */

/*
 * Declared BEFORE `/attachments/:id`, or Express matches "health" as an id and
 * the diagnostic returns "Attachment not found" — which is the least useful
 * possible answer to "is storage working".
 *
 * Authenticated: it reports whether a credential is present and whether Drive
 * answers, which is infrastructure detail and not for anonymous callers.
 */
router.get(
  "/attachments/health",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (_req, res) => {
    res.json(await svc.storageHealth());
  },
);

/* ── Upload ──────────────────────────────────────────────────────────────── */

router.post(
  "/attachments",
  verifyCoworkToken,
  verifyEmployeeToken,
  upload.single("file"),
  async (req, res) => {
    try {
      const { entityType, entityId } = req.body;
      const taskId = taskIdFor(entityType, entityId);
      if (!taskId) {
        return res.status(400).json({ error: "entityType and entityId are required." });
      }

      /* Permission BEFORE the file is stored. Validating first and checking
         after would leave orphaned private files written by people with no
         claim on the task. */
      const gate = await mayViewTask(taskId, req.coworkUser);
      if (!gate.ok) {
        return res
          .status(gate.reason === "not_found" ? 404 : 403)
          .json({ error: "You cannot attach files to this task.", code: "PERMISSION_DENIED" });
      }

      const result = await svc.uploadAttachment({
        buffer: req.file?.buffer,
        originalName: req.file?.originalname,
        /* The client's claim, used ONLY to disambiguate ZIP-based Office
           formats and to confirm a text file really is text. It can never
           widen what is accepted. */
        declaredType: req.file?.mimetype,
        uploadedBy: req.coworkUser.employeeId,
        entityType,
        entityId,
      });

      res.status(201).json({ success: true, attachment: result });
    } catch (e) {
      console.error("[cowork/attachments upload]", e.code || "", e.message);
      /* A missing credential is the OPERATOR's problem and is not the caller's
         fault, so it is a 503 and not a 400 — a client that retries a 400 will
         never succeed, and a person told "bad request" will keep changing the
         file. */
      const status = e.code === "STORAGE_NOT_CONFIGURED" ? 503 : 400;
      res.status(status).json({ error: e.message, code: e.code || "UPLOAD_FAILED" });
    }
  },
);

/* ── Download ────────────────────────────────────────────────────────────── */

router.get(
  "/attachments/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const record = await svc.getAttachment(req.params.id);
      if (!record) return res.status(404).json({ error: "Attachment not found." });

      const taskId = taskIdFor(record.entityType, record.entityId);
      if (!taskId) return res.status(403).json({ error: "Not accessible." });

      /* Re-checked on every read, not trusted from upload time: the people who
         can see a task change as it moves, and a link shared onward must not
         outlive the sharer's own access. */
      const gate = await mayViewTask(taskId, req.coworkUser);
      if (!gate.ok) {
        return res
          .status(gate.reason === "not_found" ? 404 : 403)
          .json({ error: "You do not have access to this file.", code: "PERMISSION_DENIED" });
      }

      const { stream, meta } = await svc.streamAttachment(record.storageFileId);
      res.setHeader("Content-Type", record.mimeType || meta.mimeType || "application/octet-stream");
      /* `inline` so images and PDFs can be previewed; the filename is the
         sanitised one, never the client's original string. */
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${svc.safeName(record.originalName)}"`,
      );
      /* PRIVATE, and never cached by a shared proxy — this response is
         specific to one authenticated person. */
      res.setHeader("Cache-Control", "private, no-store");
      stream.pipe(res);
    } catch (e) {
      console.error("[cowork/attachments download]", e.code || "", e.message);
      if (e.code === "STORAGE_NOT_CONFIGURED") {
        return res.status(503).json({
          error: "Attachment storage is not configured on this server.",
          code: "STORAGE_NOT_CONFIGURED",
        });
      }
      res.status(404).json({
        error: "File not found or not accessible.",
        code: "DOWNLOAD_FAILED",
      });
    }
  },
);

/* ── List for one entity ─────────────────────────────────────────────────── */

router.get(
  "/attachments/entity/:entityType/:entityId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      const taskId = taskIdFor(entityType, entityId);
      if (!taskId) return res.status(400).json({ error: "Unknown entity." });

      const gate = await mayViewTask(taskId, req.coworkUser);
      if (!gate.ok) {
        return res
          .status(gate.reason === "not_found" ? 404 : 403)
          .json({ error: "You do not have access to these files.", code: "PERMISSION_DENIED" });
      }

      const files = await svc.listAttachments(entityType, entityId);
      /* Metadata only — no storage id and no URL. The download route is the
         only way to the bytes, so nothing here can become a second one. */
      res.json({
        success: true,
        attachments: files.map((f) => ({
          id: f.id,
          name: f.originalName,
          type: f.mimeType,
          size: f.size,
          uploadedBy: f.uploadedBy,
          uploadedAt: f.uploadedAt?.toDate?.()?.toISOString?.() ?? null,
        })),
      });
    } catch (e) {
      console.error("[cowork/attachments list]", e.code || "", e.message);
      res.status(e.code === "STORAGE_NOT_CONFIGURED" ? 503 : 500).json({
        error: e.message,
        code: e.code || "LIST_FAILED",
      });
    }
  },
);

/* ── Delete ──────────────────────────────────────────────────────────────── */

router.delete(
  "/attachments/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const record = await svc.getAttachment(req.params.id);
      if (!record) return res.status(404).json({ error: "Attachment not found." });

      const taskId = taskIdFor(record.entityType, record.entityId);
      const gate = taskId
        ? await mayViewTask(taskId, req.coworkUser)
        : { ok: false, reason: "forbidden" };
      if (!gate.ok) {
        return res.status(403).json({ error: "You cannot remove this file." });
      }

      /* Narrower than viewing, deliberately: seeing a task is not authority to
         destroy somebody else's evidence on it. The uploader may remove their
         own; the task's creator and a CEO may remove any. */
      const me = String(req.coworkUser.employeeId);
      const isUploader = String(record.uploadedBy) === me;
      const isOwner = String(gate.task.assignedBy || "") === me;
      const isCeo = String(req.coworkUser.role) === "ceo";
      if (!isUploader && !isOwner && !isCeo) {
        return res
          .status(403)
          .json({ error: "Only the person who attached this file can remove it." });
      }

      await svc.deleteAttachment(req.params.id);
      res.json({ success: true });
    } catch (e) {
      console.error("[cowork/attachments delete]", e.message);
      res.status(400).json({ error: e.message });
    }
  },
);

module.exports = router;

/* `admin` is imported for the Firestore sentinel used by the service; kept here
   so a future route needing a server timestamp does not re-import it. */
void admin;
