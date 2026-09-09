/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkWorkbooks.js
 *
 * Cowork sheets — list, open, create, rename, delete, save, share, version.
 *
 * ## Why this file exists
 *
 * The Cowork client was migrated to call `/cowork/workbooks…` and this route was
 * never written, so every one of those calls answered 404. The symptom on the
 * screen was "0 sheets" under "Couldn't load your sheets" — a listing that had
 * not failed to READ anything, because there was nothing to read from. Sheets
 * have been unusable since that migration.
 *
 * Before it, the Cowork app stored workbooks on its own Next.js server's disk
 * (`lib/server/workbookStore.ts`, a JSON file). That server is redeployed
 * routinely and its disk does not survive it: a sheet built on Monday was gone
 * by the next release while the client still said "Saved". This route is the
 * other half of the fix that observation started — the client half shipped, and
 * this did not.
 *
 * ## Where it is stored
 *
 * Firestore, beside every other Cowork collection, split exactly the way
 * `coworkMindmaps` splits a map from its cards and for the same reason — a list
 * of thirty sheets must not read thirty grids to draw a table of names, and
 * Firestore bills per document read:
 *
 *  · `cowork_workbooks`          — the record: title, owner, shares, revision.
 *  · `cowork_workbook_bodies`    — the serialized grid, keyed by the record id.
 *  · `cowork_workbook_versions`  — named and automatic snapshots.
 *
 * ## Ownership, shares, and what a stranger is told
 *
 * A workbook has ONE owner and a list of grants. `access` is stamped per
 * request and describes the caller — never another person's standing — because
 * the client renders "shared with you" from it and a cached value would tell
 * the wrong person they could edit.
 *
 * A workbook you have no grant on answers 404, never 403, in line with
 * `coworkMindmaps`: a 403 on an id confirms the id is real, which the person
 * asking has not earned. The one deliberate exception is `/shares`, which
 * answers 403 to a non-owner who can otherwise open the workbook — they already
 * know it exists, and "you are not the owner" is the honest reason they cannot
 * see who else holds it.
 */

const express = require("express");
const { db } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

const router = express.Router();

const BOOKS = "cowork_workbooks";
const BODIES = "cowork_workbook_bodies";
const VERSIONS = "cowork_workbook_versions";

/** Matches `LEGACY_ORGANISATION_ID` in the Cowork client — see coworkMindmaps. */
const ORGANISATION_ID = "org-legacy-cowork";

const MAX_TITLE = 200;
const MAX_LABEL = 120;

/**
 * Serialised workbook bytes.
 *
 * A Firestore document cannot exceed 1,048,487 bytes. Refusing at 900KB leaves
 * room for the surrounding fields and — more usefully — refuses while the
 * person can still be told what is too big, rather than letting Firestore
 * reject the write with a message about bytes.
 *
 * **This is the ceiling on one sheet's grid**, and it is the known limit of
 * this implementation. A workbook that outgrows it needs the body split across
 * documents, one per sheet, which is a change to this file and to nothing
 * above it — the record, the revision and every route below stay as they are.
 * Until somebody actually hits it, a clear refusal beats a partial write.
 */
const MAX_BODY_BYTES = 900_000;

/**
 * Automatic snapshots kept per workbook.
 *
 * The client takes these on a timer, so without a cap they grow without end and
 * every one of them is a full copy of the grid. Named versions are never
 * pruned: somebody chose to keep those, and a "Before the Q3 rewrite" snapshot
 * disappearing because thirty autosaves happened afterwards is the one loss
 * this feature exists to prevent.
 */
const MAX_AUTO_VERSIONS = 20;

/** Roles a grant may carry, weakest first. Ownership is separate and outranks
    all of them — see `accessFor`. */
const ROLES = ["viewer", "commenter", "editor"];

function clamp(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * The stored record, normalised.
 *
 * Every field is defaulted, because a document written by an older shape of
 * this route (or by hand, during an incident) must still list rather than throw
 * on a missing array.
 */
function readRecord(id, raw) {
  const shares = Array.isArray(raw.shares)
    ? raw.shares
        .filter((s) => s && (typeof s.principalId === "string" || typeof s.principalId === "number"))
        .map((s) => ({
          principalId: String(s.principalId),
          role: ROLES.includes(s.role) ? s.role : "viewer",
        }))
    : [];
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "Untitled sheet",
    ownerId: raw.ownerId != null ? String(raw.ownerId) : "",
    shares,
    /* Denormalised so the listing can be one `array-contains` query rather than
       a read of every workbook in the organisation. Kept in step by every write
       that touches `shares` or `ownerId`; nothing else may set it. */
    memberIds: Array.isArray(raw.memberIds) ? raw.memberIds.map(String) : [],
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    deletedAt: raw.deletedAt || null,
  };
}

/** Owner, or the granted role, or null where this person has no standing. */
function accessFor(record, employeeId) {
  const me = String(employeeId);
  if (record.ownerId === me) return "owner";
  const grant = record.shares.find((s) => s.principalId === me);
  return grant ? grant.role : null;
}

function mayEdit(access) {
  return access === "owner" || access === "editor";
}

/** Rename, delete, and change who holds it. The owner alone. */
function mayManage(access) {
  return access === "owner";
}

/**
 * What the client is told about a workbook in a listing.
 *
 * `shares` only where the caller OWNS it. Somebody a sheet was shared with can
 * see that it is shared with them; who ELSE holds it is the owner's business,
 * and the client's collaborators panel reads this field back directly.
 */
function summary(record, access) {
  return {
    id: record.id,
    title: record.title,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ownerId: record.ownerId,
    access,
    ...(access === "owner" ? { shares: record.shares } : {}),
  };
}

/**
 * The record, if this person may see it. Null covers both "no such workbook"
 * and "not yours" — see the header for why those are one answer.
 */
async function readableRecord(id, employeeId) {
  const snap = await db.collection(BOOKS).doc(String(id)).get();
  if (!snap.exists) return null;
  const record = readRecord(snap.id, snap.data() || {});
  if (record.deletedAt) return null;
  if (!accessFor(record, employeeId)) return null;
  return record;
}

/**
 * A serialized workbook, checked far enough that a malformed body is a 400
 * rather than a document nothing can open.
 *
 * Deliberately shallow: this route does not model cells, and a validator that
 * tried to would have to be revised in lockstep with the spreadsheet engine.
 * What it does guarantee is the shape the client's own loader assumes — two
 * arrays — so a body that would throw on open is refused at the door.
 */
function validateBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { error: "A workbook body must be an object." };
  if (!Array.isArray(data.sheets))
    return { error: "A workbook body must carry a list of sheets." };
  if (!Array.isArray(data.styles))
    return { error: "A workbook body must carry its style table." };

  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > MAX_BODY_BYTES)
    return {
      error:
        `This sheet is too large to save (${Math.round(bytes / 1024)}KB of ` +
        `${Math.round(MAX_BODY_BYTES / 1024)}KB). Splitting it across more than ` +
        `one sheet is the usual fix.`,
    };
  return { data };
}

/** The grant list as it is stored, with the owner never among it. */
function normaliseShares(raw, ownerId) {
  if (!Array.isArray(raw)) return { error: "Shares must be a list." };
  const byPrincipal = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object")
      return { error: "Each share needs a person and a role." };
    const principalId = String(entry.principalId ?? "").trim();
    if (!principalId) return { error: "Each share needs a person." };
    if (!ROLES.includes(entry.role))
      return { error: `"${entry.role}" is not a role a sheet can be shared at.` };
    /* The owner already has more than any grant could give, and storing one
       would let a later "remove everybody" write lock them out of their own
       workbook. Dropped rather than refused: the sharing panel lists people,
       and naming yourself in it is a mistake, not an error worth a red line. */
    if (principalId === String(ownerId)) continue;
    byPrincipal.set(principalId, { principalId, role: entry.role });
  }
  return { shares: [...byPrincipal.values()] };
}

function membersOf(ownerId, shares) {
  return [...new Set([String(ownerId), ...shares.map((s) => s.principalId)])];
}

function versionOf(id, raw) {
  return {
    id,
    label: typeof raw.label === "string" ? raw.label : "",
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    createdById: raw.createdById != null ? String(raw.createdById) : "",
    createdByName: typeof raw.createdByName === "string" ? raw.createdByName : "",
    auto: raw.auto === true,
  };
}

/* ── Routes ─────────────────────────────────────────────────────────────────
 *
 * Mounted under `/cowork`, so these are `/cowork/workbooks…`. Every one is
 * authenticated; there is no public read.
 */

/** The list — records only, never bodies. */
router.get(
  "/workbooks",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const snap = await db
        .collection(BOOKS)
        .where("memberIds", "array-contains", me)
        .get();
      const workbooks = snap.docs
        .map((d) => readRecord(d.id, d.data() || {}))
        .filter((w) => !w.deletedAt)
        .map((w) => summary(w, accessFor(w, me)))
        /* Newest activity first. Sorted here rather than with `orderBy` so the
           query needs no composite index alongside the `array-contains`. */
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json({ workbooks });
    } catch (err) {
      res.status(500).json({ error: "Could not list sheets: " + err.message });
    }
  },
);

/** One workbook, with its grid. The only read that touches a body. */
router.get(
  "/workbooks/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      const body = await db.collection(BODIES).doc(record.id).get();
      const raw = body.exists ? body.data() || {} : {};
      res.json({
        id: record.id,
        title: record.title,
        revision: record.revision,
        access: accessFor(record, me),
        /* An absent body is an empty workbook rather than an error: the record
           is real and openable, and the client seeds a blank grid. */
        data: raw.data ?? { version: 1, activeSheetId: "", styles: [], sheets: [] },
      });
    } catch (err) {
      res.status(500).json({ error: "Could not open the sheet: " + err.message });
    }
  },
);

/** Create one. The creator owns it. */
router.post(
  "/workbooks",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const now = new Date().toISOString();
      const title =
        clamp(req.body && req.body.title, MAX_TITLE).trim() || "Untitled sheet";

      const checked = validateBody(req.body && req.body.data);
      if (checked.error) return res.status(400).json({ error: checked.error });

      const ref = db.collection(BOOKS).doc();
      const record = {
        organisationId: ORGANISATION_ID,
        title,
        ownerId: me,
        shares: [],
        memberIds: [me],
        /* Starts at 1, not 0: the client sends the revision it read back as
           `baseRevision`, and a workbook that has been saved once must not
           share a revision with one that never has. */
        revision: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await ref.set(record);
      await db
        .collection(BODIES)
        .doc(ref.id)
        .set({ workbookId: ref.id, data: checked.data, updatedAt: now });

      res.status(201).json({ id: ref.id, title, revision: 1 });
    } catch (err) {
      res.status(500).json({ error: "Could not create the sheet: " + err.message });
    }
  },
);

/**
 * Save the grid.
 *
 * Optimistic concurrency: the client sends the revision it loaded, and a save
 * against a stale one is refused with the revision actually stored so the
 * client can say what happened rather than silently overwriting somebody. Run
 * in a transaction because the check and the bump must not be separable — two
 * tabs saving at once would otherwise both read 4, both write 5, and one edit
 * would vanish with no conflict reported.
 */
router.put(
  "/workbooks/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayEdit(accessFor(record, me)))
        return res.status(403).json({ error: "This sheet is read-only for you." });

      const checked = validateBody(req.body && req.body.data);
      if (checked.error) return res.status(400).json({ error: checked.error });

      const base = Number(req.body && req.body.baseRevision);
      if (!Number.isFinite(base))
        return res.status(400).json({ error: "A save must say which revision it started from." });

      const now = new Date().toISOString();
      const bookRef = db.collection(BOOKS).doc(record.id);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(bookRef);
        if (!snap.exists) return { missing: true };
        const current = readRecord(snap.id, snap.data() || {});
        if (current.deletedAt) return { missing: true };
        if (current.revision !== base)
          return { conflict: true, currentRevision: current.revision };

        const revision = current.revision + 1;
        tx.update(bookRef, { revision, updatedAt: now, lastEditedById: me });
        tx.set(db.collection(BODIES).doc(record.id), {
          workbookId: record.id,
          data: checked.data,
          updatedAt: now,
        });
        return { revision };
      });

      if (result.missing) return res.status(404).json({ error: "Sheet not found." });
      if (result.conflict)
        return res.status(409).json({
          error: "This sheet changed somewhere else while you were editing it.",
          currentRevision: result.currentRevision,
        });
      res.json({ revision: result.revision, updatedAt: now });
    } catch (err) {
      res.status(500).json({ error: "Could not save the sheet: " + err.message });
    }
  },
);

/** Rename. The owner alone — the title is how everybody else finds it. */
router.patch(
  "/workbooks/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayManage(accessFor(record, me)))
        return res.status(403).json({ error: "Only the owner can rename this sheet." });

      const title = clamp(req.body && req.body.title, MAX_TITLE).trim();
      if (!title) return res.status(400).json({ error: "A sheet needs a name." });

      await db
        .collection(BOOKS)
        .doc(record.id)
        .update({ title, updatedAt: new Date().toISOString() });
      res.json({ title });
    } catch (err) {
      res.status(500).json({ error: "Could not rename the sheet: " + err.message });
    }
  },
);

/**
 * Delete.
 *
 * Soft, exactly as a mindmap is: the record is stamped and drops out of every
 * listing, and the body is left where it is. A sheet is somebody's work, and a
 * mis-click that destroys it permanently is not a recoverable mistake.
 */
router.delete(
  "/workbooks/:id",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayManage(accessFor(record, me)))
        return res.status(403).json({ error: "Only the owner can delete this sheet." });

      await db
        .collection(BOOKS)
        .doc(record.id)
        .update({ deletedAt: new Date().toISOString() });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: "Could not delete the sheet: " + err.message });
    }
  },
);

/* ── Sharing ────────────────────────────────────────────────────────────── */

router.get(
  "/workbooks/:id/shares",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      /* 403 rather than 404 here — see the header. They can already open it. */
      if (!mayManage(accessFor(record, me)))
        return res.status(403).json({ error: "Only the owner can see who this is shared with." });
      res.json({ shares: record.shares });
    } catch (err) {
      res.status(500).json({ error: "Could not read the sharing list: " + err.message });
    }
  },
);

/** Replace the whole grant list. `[]` makes the workbook private again. */
router.put(
  "/workbooks/:id/shares",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayManage(accessFor(record, me)))
        return res.status(403).json({ error: "Only the owner can share this sheet." });

      const checked = normaliseShares(req.body && req.body.shares, record.ownerId);
      if (checked.error) return res.status(400).json({ error: checked.error });

      await db.collection(BOOKS).doc(record.id).update({
        shares: checked.shares,
        memberIds: membersOf(record.ownerId, checked.shares),
        updatedAt: new Date().toISOString(),
      });
      res.json({ shares: checked.shares });
    } catch (err) {
      res.status(500).json({ error: "Could not update sharing: " + err.message });
    }
  },
);

/* ── Version history ────────────────────────────────────────────────────── */

router.get(
  "/workbooks/:id/versions",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });

      const snap = await db
        .collection(VERSIONS)
        .where("workbookId", "==", record.id)
        .get();
      const versions = snap.docs
        .map((d) => versionOf(d.id, d.data() || {}))
        /* Newest first, sorted here so no composite index is needed. */
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.json({ versions });
    } catch (err) {
      res.status(500).json({ error: "Could not list versions: " + err.message });
    }
  },
);

/** Snapshot the grid as it stands. */
router.post(
  "/workbooks/:id/versions",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayEdit(accessFor(record, me)))
        return res.status(403).json({ error: "This sheet is read-only for you." });

      const auto = req.body && req.body.auto === true;
      const now = new Date().toISOString();
      const label =
        clamp(req.body && req.body.label, MAX_LABEL).trim() ||
        (auto ? "Autosave" : `Version ${record.revision}`);

      const body = await db.collection(BODIES).doc(record.id).get();
      const data = body.exists ? (body.data() || {}).data ?? null : null;
      if (!data)
        return res.status(400).json({ error: "There is nothing saved to snapshot yet." });

      const ref = db.collection(VERSIONS).doc();
      const stored = {
        workbookId: record.id,
        label,
        revision: record.revision,
        createdAt: now,
        createdById: me,
        createdByName: req.coworkUser.name || "",
        auto,
        data,
      };
      await ref.set(stored);

      /* Keep the automatic ones bounded. Named versions are never pruned — see
         MAX_AUTO_VERSIONS. Read then delete rather than a batched query with an
         `orderBy`, so this needs no composite index either. */
      if (auto) {
        const mine = await db
          .collection(VERSIONS)
          .where("workbookId", "==", record.id)
          .get();
        const autos = mine.docs
          .filter((d) => (d.data() || {}).auto === true)
          .sort((a, b) =>
            String((b.data() || {}).createdAt).localeCompare(
              String((a.data() || {}).createdAt),
            ),
          );
        await Promise.all(
          autos.slice(MAX_AUTO_VERSIONS).map((d) => d.ref.delete()),
        );
      }

      res.status(201).json({ version: versionOf(ref.id, stored) });
    } catch (err) {
      res.status(500).json({ error: "Could not save a version: " + err.message });
    }
  },
);

/**
 * Restore one.
 *
 * The restore is a NEW revision carrying the old content, not a rewind of the
 * counter. Anybody holding the workbook open has a `baseRevision` that must
 * still be able to conflict; moving the number backwards would make their next
 * save look current and silently undo the restore.
 */
router.post(
  "/workbooks/:id/versions/:versionId/restore",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayEdit(accessFor(record, me)))
        return res.status(403).json({ error: "This sheet is read-only for you." });

      const snap = await db
        .collection(VERSIONS)
        .doc(String(req.params.versionId))
        .get();
      const version = snap.exists ? snap.data() || {} : null;
      if (!version || String(version.workbookId) !== record.id)
        return res.status(404).json({ error: "That version is not on this sheet." });

      const now = new Date().toISOString();
      const revision = record.revision + 1;
      await db
        .collection(BODIES)
        .doc(record.id)
        .set({ workbookId: record.id, data: version.data, updatedAt: now });
      await db
        .collection(BOOKS)
        .doc(record.id)
        .update({ revision, updatedAt: now, lastEditedById: me });

      res.json({ revision, data: version.data });
    } catch (err) {
      res.status(500).json({ error: "Could not restore that version: " + err.message });
    }
  },
);

router.delete(
  "/workbooks/:id/versions/:versionId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const me = String(req.coworkUser.employeeId);
      const record = await readableRecord(req.params.id, me);
      if (!record) return res.status(404).json({ error: "Sheet not found." });
      if (!mayManage(accessFor(record, me)))
        return res.status(403).json({ error: "Only the owner can delete a version." });

      const ref = db.collection(VERSIONS).doc(String(req.params.versionId));
      const snap = await ref.get();
      if (!snap.exists || String((snap.data() || {}).workbookId) !== record.id)
        return res.status(404).json({ error: "That version is not on this sheet." });

      await ref.delete();
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: "Could not delete that version: " + err.message });
    }
  },
);

module.exports = router;
