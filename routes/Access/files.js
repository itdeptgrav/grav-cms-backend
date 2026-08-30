"use strict";
/**
 * routes/Access/files.js
 * ───────────────────────────────────────────────────────────────────────────
 * THE COMPANY DRIVE'S BYTES, BEHIND THE SAME DOOR AS /files.
 *
 * The endpoints, and the shape of them is the whole security argument:
 *
 *   GET    /api/files/folders         the tree, bootstrapped on first read
 *   POST   /api/files/folders         make one
 *   PATCH  /api/files/folders/:id     rename / move / star / tag
 *   POST   /api/files/folders/:id/trash | /restore
 *   DELETE /api/files/folders/:id     permanent, and only when empty
 *
 *   GET    /api/files                 the drive's rows, as the UI's nodes
 *   POST   /api/files                 upload → Drive (private) + a Doc_File row
 *   GET    /api/files/:id/preview     → { previewKind, previewUrl, downloadUrl, … }
 *   GET    /api/files/:id/text        a text document, decoded and capped
 *   GET    /api/files/:id/sheet       a workbook, as a capped grid
 *   GET    /api/files/:id/download?t= stream the bytes, gate re-run
 *   PATCH  /api/files/:id             rename / move / star / tag / restrict
 *   POST   /api/files/:id/trash       soft delete
 *   POST   /api/files/:id/restore     undo it
 *   DELETE /api/files/:id             permanent, and only out of the trash
 *
 * ── WHY NOT JUST RETURN THE PROVIDER URL ────────────────────────────────────
 * Because a provider URL is a permanent, un-revocable grant to anyone who
 * ever sees it — a browser history entry, a screenshot, a support ticket. So
 * /preview never returns one. It returns a URL BACK INTO THIS SERVICE
 * carrying a short-lived HMAC token, and /download re-reads the session and
 * the row on every request before a single byte moves. Revoking access takes
 * effect on the next request rather than never.
 *
 * The token is minted by utils/letterDownloadToken.js. It is reused rather
 * than copied so the signing secret lives in exactly one place; the `scope`
 * field is what keeps a letter token from opening a drive file, and this
 * route checks it — see verifyFileToken.
 *
 * ── WHAT "ALLOWED" MEANS TODAY ──────────────────────────────────────────────
 * A valid CMS session, plus: a `restricted` document is refused to everyone
 * except its owner and an admin. That is deliberately a SMALL rule, and it is
 * enforced server-side on both /preview and /download. Per-department ACLs
 * are the next chunk; when they arrive they go in `mayRead` and nothing else
 * moves.
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const multer = require("multer");
/* Already a dependency, and already how this backend reads uploaded
   workbooks — see routes/Accountant_Routes/Acc_bankRecon.js, the HR importer
   and services/tallyParser.service.js. It is also the only one of the two
   spreadsheet libraries here that reads legacy .xls, which exceljs cannot. */
const XLSX = require("xlsx");

const { SECRET, LEGACY_SECRETS, readToken } = require("../../config/jwt");
const { Doc_File, kindOf, previewKindOf } = require("../../models/Files/Doc_File");
const { Doc_Folder, FOLDER_VARIANTS } = require("../../models/Files/Doc_Folder");
const drive = require("../../services/companyDrive.service");
const {
  mintLetterToken,
  verifyLetterToken,
  absoluteUrl,
} = require("../../utils/letterDownloadToken");

const router = express.Router();

/* In memory, then straight to Drive — nothing is written to this server's
   disk, so there is no temp file to leak or to clean up. 25 MB is the ceiling
   a document workspace needs; video belongs somewhere else. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const TOKEN_SCOPE = "file";
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

/** The session, or null. Same verification the other Access routes run. */
function sessionOf(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    for (const legacy of LEGACY_SECRETS) {
      try {
        return jwt.verify(token, legacy);
      } catch {
        /* try the next one */
      }
    }
    return null;
  }
}

/* `what` completes the sentence, because one message cannot serve both:
   "Sign in to open this document" is wrong on a listing, and a listing's
   wording is wrong on a single file. */
function requireSession(req, res, what = "open this document") {
  const user = sessionOf(req);
  if (!user) {
    res.status(401).json({ success: false, message: `Sign in to ${what}.` });
    return null;
  }
  return user;
}

/**
 * May this session read this row?
 *
 * Deliberately one function, called by BOTH /preview and /download. A gate
 * that runs when a link is minted but not when it is used is not a gate.
 */
function mayRead(user, row) {
  if (!row || row.trashed) return false;
  if (!row.restricted) return true;
  if (user?.isAdmin) return true;
  return String(row.ownerId || "") === String(user?.id || "");
}

/** A file token, or null. Checks the scope so a letter token cannot be used. */
function verifyFileToken(token, fileId) {
  const payload = verifyLetterToken(token);
  if (!payload) return null;
  if (payload.s !== TOKEN_SCOPE) return null;
  if (String(payload.d) !== String(fileId)) return null;
  return payload;
}

/* ══ THE TREE ══════════════════════════════════════════════════════════════
 * Folders became real records in the folder-persistence chunk. Everything
 * below is declared BEFORE the document routes on purpose: `/folders` and
 * `/:id` are both one segment, and a reader should not have to reason about
 * Express's matching order to know which one wins.
 */

/**
 * Which set of books this request is about.
 *
 * The caller names it, exactly as every accountant route in this codebase
 * does. That makes it a PARTITION, not a permission — see the note on the
 * model. It is written down here in one function so that when company really
 * does arrive in the session, this is the only line that changes.
 */
function companyOf(req) {
  const raw = req.query?.companyId || req.body?.companyId || req.user?.companyId || null;
  return isId(raw) ? String(raw) : null;
}

/**
 * The scope filter, with the legacy bucket folded in.
 *
 * A row written before `companyId` existed has none, and must stay reachable
 * from every set of books — otherwise turning this feature on would look, to
 * the person using it, exactly like the drive losing every document it had.
 * The same shape routes/Accountant_Routes/Acc_budgets.js settled on.
 */
function companyScope(companyId) {
  if (!companyId) return { $or: [{ companyId: null }, { companyId: { $exists: false } }] };
  return {
    $or: [{ companyId }, { companyId: null }, { companyId: { $exists: false } }],
  };
}

/** A folder this scope may not see is a folder that does not exist. */
function outOfScope(companyId, row) {
  if (!row) return true;
  const rowCompany = row.companyId ? String(row.companyId) : null;
  if (rowCompany === null) return false; // legacy, visible everywhere
  return rowCompany !== companyId;
}

/* The tree every drive starts with. Identical to the scaffold the file
   manager used to rebuild in the browser, moved here so the departments are
   real records people can rename, move and file into — and so an empty one
   survives the night. */
const DEFAULT_TREE = [
  { name: "Finance", variant: "finance", children: [
    { name: "Invoices", variant: "finance" },
    { name: "Bank Statements", variant: "finance" },
  ] },
  { name: "Sales", variant: "sales", children: [{ name: "Customer Contracts", variant: "sales" }] },
  { name: "Production", variant: "generic" },
  { name: "Store & Purchase", variant: "store", children: [{ name: "Vendor Quotes", variant: "store" }] },
  { name: "HR", variant: "hr", children: [{ name: "Employee Documents", variant: "hr" }] },
  { name: "Compliance", variant: "compliance", children: [{ name: "License Issuance", variant: "compliance" }] },
  { name: "Budget", variant: "budget", children: [{ name: "FY 2026-27 Support", variant: "budget" }] },
  { name: "Admin", variant: "generic" },
];

/**
 * Create the default tree, once.
 *
 * Guarded by a count rather than a flag, and safe against two tabs racing:
 * the unique index on (companyId, parentId, name) makes the second writer's
 * insert fail rather than duplicate, and a duplicate-key error here means
 * somebody else already did the work.
 */
async function bootstrapTree(companyId) {
  const existing = await Doc_Folder.countDocuments(companyScope(companyId));
  if (existing > 0) return false;

  const make = async (spec, parent) => {
    let row;
    try {
      row = await Doc_Folder.create({
        name: spec.name,
        parentId: parent ? parent._id : null,
        path: parent ? [...parent.path, spec.name] : [spec.name],
        variant: spec.variant,
        companyId,
      });
    } catch (e) {
      if (e?.code !== 11000) throw e;
      row = await Doc_Folder.findOne({
        ...companyScope(companyId),
        parentId: parent ? parent._id : null,
        name: spec.name,
        trashed: false,
      });
      if (!row) return;
    }
    for (const child of spec.children || []) await make(child, row);
  };

  for (const spec of DEFAULT_TREE) await make(spec, null);
  return true;
}

/* A prefix query, written positionally because Mongo cannot prefix-match an
   array directly. `{ "path.0": "Finance", "path.1": "Invoices" }` matches
   that folder AND everything beneath it. `field` differs between the two
   collections only because Doc_File named it first. */
function prefixQuery(field, path) {
  const q = {};
  path.forEach((seg, i) => {
    q[`${field}.${i}`] = seg;
  });
  return q;
}

/**
 * Run `work` atomically where the database allows it.
 *
 * A folder move rewrites three things — the folder, its descendants, and the
 * documents filed under them — and a half-finished move is a drive that has
 * lost track of where its paperwork lives. Atlas and any replica set give us
 * a transaction. A standalone mongod (which is what the test harness runs,
 * and some local installs) does not, and refuses at the first write with code
 * 20 rather than at startSession. So the failure is caught and the work is
 * replayed without a session — nothing was committed, so the replay is clean
 * — and the caller is TOLD which one happened via `atomic` rather than being
 * left to assume the strong one.
 */
let _txnSupport = null;

async function supportsTransactions() {
  if (_txnSupport !== null) return _txnSupport;
  try {
    const info = await mongoose.connection.db.admin().command({ hello: 1 });
    /* A replica set names itself; a sharded cluster answers "isdbgrid".
       Anything else is a standalone mongod, which has no transactions. */
    _txnSupport = !!(info.setName || info.msg === "isdbgrid");
  } catch {
    _txnSupport = false;
  }
  return _txnSupport;
}

async function inTransaction(work) {
  /* ASKED, not attempted. Starting a transaction on a standalone mongod and
     catching the refusal also works, but it leaves a server session behind on
     a connection that then will not close — which showed up as a test run
     that finished in two seconds and hung for five minutes. One `hello`, once
     per process, is cheaper and does not litter. */
  if (!(await supportsTransactions())) return { atomic: false, result: await work(null) };

  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return { atomic: true, result };
  } catch (err) {
    try {
      await session.abortTransaction();
    } catch {
      /* already aborted, or never started */
    }
    const unsupported =
      err?.code === 20 ||
      err?.codeName === "IllegalOperation" ||
      /transaction numbers|replica set|not supported/i.test(err?.message || "");
    if (!unsupported) throw err;
    return { atomic: false, result: await work(null) };
  } finally {
    session.endSession();
  }
}

/** Load + gate a folder. Answers the request itself when it returns null. */
async function loadFolder(req, res, what) {
  const user = requireSession(req, res, what);
  if (!user) return null;

  if (!isId(req.params.id)) {
    res.status(404).json({ success: false, message: "Folder not found." });
    return null;
  }
  const row = await Doc_Folder.findById(req.params.id);
  const companyId = companyOf(req);
  /* Out of scope answers 404, not 403: a 403 on a specific id confirms that
     the folder exists in somebody else's books, which is itself a leak. */
  if (!row || outOfScope(companyId, row)) {
    res.status(404).json({ success: false, message: "Folder not found." });
    return null;
  }
  return { user, row, companyId };
}

/** A folder name has to be a name, not a path. */
function cleanFolderName(value) {
  if (typeof value !== "string") return { error: "A folder name must be text." };
  const name = value.trim();
  if (!name) return { error: "A folder needs a name." };
  if (name.length > 120) return { error: "That folder name is too long." };
  if (/[\\/]/.test(name)) return { error: "A folder name cannot contain / or \\." };
  return { name };
}

/* ══ GET /api/files/folders ════════════════════════════════════════════════ */
router.get("/folders", async (req, res) => {
  const user = requireSession(req, res, "see the company drive");
  if (!user) return;

  try {
    const companyId = companyOf(req);
    const wantTrash = req.query.trash === "1";

    /* Only the live listing bootstraps. Asking for the trash of a drive that
       does not exist yet should not conjure one. */
    let bootstrapped = false;
    if (!wantTrash) bootstrapped = await bootstrapTree(companyId);

    const rows = await Doc_Folder.find({
      ...companyScope(companyId),
      trashed: wantTrash,
    }).sort({ "path.0": 1, name: 1 });

    return res.json({ success: true, folders: rows.map((r) => r.toNode()), bootstrapped });
  } catch (err) {
    console.error("[files] GET /folders:", err?.message);
    return res.status(500).json({ success: false, message: "Could not load the folder tree." });
  }
});

/* ══ POST /api/files/folders ═══════════════════════════════════════════════ */
router.post("/folders", async (req, res) => {
  const user = requireSession(req, res, "make a folder");
  if (!user) return;

  try {
    const { name, error } = cleanFolderName(req.body?.name);
    if (error) return res.status(400).json({ success: false, message: error });

    const companyId = companyOf(req);
    const rawParent = req.body?.parentId || null;

    let parent = null;
    if (rawParent) {
      if (!isId(rawParent)) {
        return res.status(400).json({ success: false, message: "That parent folder is not a folder." });
      }
      parent = await Doc_Folder.findById(rawParent);
      if (!parent || parent.trashed || outOfScope(companyId, parent)) {
        return res.status(404).json({ success: false, message: "That parent folder was not found." });
      }
    }

    const variant = FOLDER_VARIANTS.includes(req.body?.variant) ? req.body.variant : "generic";

    const row = await Doc_Folder.create({
      name,
      parentId: parent ? parent._id : null,
      path: parent ? [...parent.path, name] : [name],
      variant,
      companyId,
      ownerId: isId(user.id) ? user.id : null,
      ownerName: user.name || user.email || "",
      createdBy: isId(user.id) ? user.id : null,
    });

    return res.status(201).json({ success: true, folder: row.toNode() });
  } catch (err) {
    if (err?.code === 11000) {
      /* The unique index doing its job. Said as the thing the person did,
         not as a database constraint. */
      return res
        .status(409)
        .json({ success: false, message: "There is already a folder with that name here." });
    }
    console.error("[files] POST /folders:", err?.message);
    return res.status(500).json({ success: false, message: "Could not make that folder." });
  }
});

/* ══ PATCH /api/files/folders/:id ══════════════════════════════════════════
 * Rename, move, star, tag.
 *
 * ── WHY A MOVE IS THREE WRITES, NOT ONE ────────────────────────────────────
 * `path` is denormalised onto every descendant folder and every document
 * filed beneath them, which is what makes reading the drive cheap. The bill
 * comes due here: moving "Finance" means every path that began with
 * ["Finance"] now begins with something else. A rename is the same operation
 * — the folder stays where it is and its name changes, which rewrites exactly
 * the same set of paths — so the two share one code path rather than drifting
 * apart the first time somebody fixes a bug in only one of them.
 */
router.patch("/folders/:id", async (req, res) => {
  try {
    const found = await loadFolder(req, res, "edit this folder");
    if (!found) return;
    const { user, row, companyId } = found;

    if (row.trashed) {
      return res
        .status(409)
        .json({ success: false, message: "Restore this folder before editing it." });
    }

    const body = req.body || {};
    for (const key of ["path", "companyId", "ownerId", "createdBy", "_id", "id"]) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        return res.status(400).json({ success: false, message: `${key} cannot be changed.` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "trashed")) {
      return res
        .status(400)
        .json({ success: false, message: "Use /trash and /restore to change whether a folder is in the trash." });
    }

    /* The cheap fields first, so a star does not pay for the move machinery. */
    const simple = {};
    if (body.starred !== undefined) {
      if (typeof body.starred !== "boolean") {
        return res.status(400).json({ success: false, message: "starred must be true or false." });
      }
      simple.starred = body.starred;
    }
    if (body.variant !== undefined) {
      if (!FOLDER_VARIANTS.includes(body.variant)) {
        return res.status(400).json({ success: false, message: "That is not a folder style." });
      }
      simple.variant = body.variant;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 12) {
        return res.status(400).json({ success: false, message: "tags must be a short list." });
      }
      const tags = [];
      for (const tag of body.tags) {
        if (typeof tag !== "string") {
          return res.status(400).json({ success: false, message: "tags must be a list of words." });
        }
        const clean = tag.trim();
        if (!clean) continue;
        if (clean.length > 40 || !/^[\w][\w .&/+-]*$/.test(clean)) {
          return res.status(400).json({ success: false, message: `"${clean}" is not a usable tag.` });
        }
        if (!tags.includes(clean)) tags.push(clean);
      }
      simple.tags = tags;
    }

    /* Now the two that move paths. */
    let nextName = row.name;
    if (body.name !== undefined) {
      const { name, error } = cleanFolderName(body.name);
      if (error) return res.status(400).json({ success: false, message: error });
      nextName = name;
    }

    let nextParentId = row.parentId;
    let reparenting = false;
    if (body.parentId !== undefined) {
      reparenting = true;
      const raw = body.parentId;
      if (raw === null || raw === "") {
        nextParentId = null;
      } else {
        if (!isId(raw)) {
          return res.status(400).json({ success: false, message: "That destination is not a folder." });
        }
        if (String(raw) === String(row._id)) {
          return res.status(400).json({ success: false, message: "A folder cannot be moved into itself." });
        }
        const dest = await Doc_Folder.findById(raw);
        if (!dest || dest.trashed || outOfScope(companyId, dest)) {
          return res.status(404).json({ success: false, message: "That destination folder was not found." });
        }
        /* The check that keeps the tree a tree. Moving a folder inside its
           own descendant detaches the whole branch from the root: it would
           still exist, point at itself in a loop, and never appear in any
           listing again. */
        const destPath = dest.path || [];
        const ownPath = row.path || [];
        const isDescendant =
          destPath.length >= ownPath.length &&
          ownPath.every((seg, i) => destPath[i] === seg);
        if (isDescendant) {
          return res
            .status(400)
            .json({ success: false, message: "A folder cannot be moved inside itself." });
        }
        nextParentId = dest._id;
      }
    }

    const nameChanged = nextName !== row.name;
    const parentChanged = reparenting && String(nextParentId || "") !== String(row.parentId || "");

    if (!nameChanged && !parentChanged) {
      if (!Object.keys(simple).length) {
        return res.status(400).json({
          success: false,
          message: "Nothing to change. Editable fields: name, parentId, variant, tags, starred.",
        });
      }
      Object.assign(row, simple);
      await row.save();
      return res.json({ success: true, folder: row.toNode(), atomic: true, moved: 0 });
    }

    const oldPath = [...(row.path || [])];
    let parentPath = [];
    if (nextParentId) {
      const parent = await Doc_Folder.findById(nextParentId);
      parentPath = parent?.path || [];
    }
    const newPath = [...parentPath, nextName];

    let movedFolders = 0;
    let movedFiles = 0;

    const { atomic } = await inTransaction(async (session) => {
      const opts = session ? { session } : {};

      /* Descendants: the prefix, minus the folder itself — which is what the
         `$exists` on the next position means. */
      const descendants = await Doc_Folder.find(
        {
          ...prefixQuery("path", oldPath),
          [`path.${oldPath.length}`]: { $exists: true },
        },
        null,
        opts,
      );
      const folderOps = descendants.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { path: [...newPath, ...d.path.slice(oldPath.length)] } },
        },
      }));
      if (folderOps.length) await Doc_Folder.bulkWrite(folderOps, opts);
      movedFolders = folderOps.length;

      /* Documents filed at this folder or anywhere below it. Trashed ones
         included: a document that comes back out of the trash must come back
         to where its folder is NOW, not where it was when it was deleted. */
      const docs = await Doc_File.find(prefixQuery("folderPath", oldPath), null, opts);
      const fileOps = docs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { folderPath: [...newPath, ...d.folderPath.slice(oldPath.length)] } },
        },
      }));
      if (fileOps.length) await Doc_File.bulkWrite(fileOps, opts);
      movedFiles = fileOps.length;

      await Doc_Folder.updateOne(
        { _id: row._id },
        { $set: { ...simple, name: nextName, parentId: nextParentId, path: newPath } },
        opts,
      );
    });

    const fresh = await Doc_Folder.findById(row._id);
    return res.json({
      success: true,
      folder: fresh.toNode(),
      /* Reported rather than assumed. On a standalone mongod this says false,
         and the caller knows the rewrite was a sequence, not an instant. */
      atomic,
      moved: movedFolders + movedFiles,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, message: "There is already a folder with that name there." });
    }
    console.error("[files] PATCH /folders/:id:", err?.message);
    return res.status(500).json({ success: false, message: "Could not save that folder." });
  }
});

/* ══ POST /api/files/folders/:id/trash | /restore ══════════════════════════
 * The folder only. Its contents keep their own `trashed` flag and their own
 * paths, so restoring the folder brings the drive back exactly as it was —
 * and trashing one does not quietly bury a hundred documents that would then
 * each have to be found individually to get back.
 */
router.post("/folders/:id/trash", async (req, res) => {
  try {
    const found = await loadFolder(req, res, "move this folder to the trash");
    if (!found) return;
    const { row } = found;

    if (!row.trashed) {
      row.trashed = true;
      await row.save();
    }
    return res.json({ success: true, folder: row.toNode() });
  } catch (err) {
    console.error("[files] POST /folders/:id/trash:", err?.message);
    return res.status(500).json({ success: false, message: "Could not move that folder to the trash." });
  }
});

router.post("/folders/:id/restore", async (req, res) => {
  try {
    const found = await loadFolder(req, res, "restore this folder");
    if (!found) return;
    const { row } = found;

    if (row.trashed) {
      row.trashed = false;
      try {
        await row.save();
      } catch (e) {
        if (e?.code !== 11000) throw e;
        /* Somebody made a new folder with this name in the same place while
           this one was in the trash. Restoring would break the promise that a
           path names one folder, so it is refused with the fix rather than
           landing a silent duplicate. */
        return res.status(409).json({
          success: false,
          message: "A folder with this name already exists there. Rename one of them first.",
        });
      }
    }
    return res.json({ success: true, folder: row.toNode() });
  } catch (err) {
    console.error("[files] POST /folders/:id/restore:", err?.message);
    return res.status(500).json({ success: false, message: "Could not restore that folder." });
  }
});

/* ══ DELETE /api/files/folders/:id ═════════════════════════════════════════
 * Permanent, and deliberately narrow.
 *
 * Trash first, same as a document. Then: EMPTY, or nothing happens. There is
 * no recursive delete here, and that is a decision rather than an omission —
 * a single request that destroys an unknown number of signed contracts is the
 * one operation in this module nobody can undo, and the drive is not asking
 * for it yet. Emptying a folder document by document is slower and is a thing
 * people can see themselves doing.
 */
router.delete("/folders/:id", async (req, res) => {
  try {
    const found = await loadFolder(req, res, "delete this folder");
    if (!found) return;
    const { row } = found;

    if (!row.trashed) {
      return res.status(409).json({
        success: false,
        message: "Move this folder to the trash before deleting it permanently.",
      });
    }

    const childFolders = await Doc_Folder.countDocuments({ parentId: row._id });
    /* Documents anywhere beneath it, trashed ones included — a document in
       the trash still has bytes on Drive and a row that would be orphaned. */
    const docs = await Doc_File.countDocuments(prefixQuery("folderPath", row.path || []));

    if (childFolders > 0 || docs > 0) {
      const parts = [];
      if (childFolders) parts.push(`${childFolders} folder${childFolders === 1 ? "" : "s"}`);
      if (docs) parts.push(`${docs} document${docs === 1 ? "" : "s"}`);
      return res.status(409).json({
        success: false,
        message: `This folder still holds ${parts.join(" and ")}. Empty it first.`,
        contains: { folders: childFolders, files: docs },
      });
    }

    await row.deleteOne();
    return res.json({ success: true, id: String(row._id) });
  } catch (err) {
    console.error("[files] DELETE /folders/:id:", err?.message);
    return res.status(500).json({ success: false, message: "Could not delete that folder." });
  }
});

/* ══ GET /api/files ════════════════════════════════════════════════════════
 * The drive's documents, as the frontend's node shape.
 *
 * ── RESTRICTED ROWS ARE LISTED, NOT HIDDEN ─────────────────────────────────
 * Deliberately. A document you may not open is still a fact about the drive —
 * hiding it makes a folder look empty and sends people asking why their file
 * "disappeared". The row appears with `restricted: true` and the UI marks it;
 * /preview and /download are where the refusal happens. Concealment and
 * access control are different jobs and only one of them is this endpoint's.
 */
router.get("/", async (req, res) => {
  const user = requireSession(req, res, "see the company drive");
  if (!user) return;

  try {
    /* Scoped the same way the folder tree is. Without this a folder could
       belong to one set of books while the documents inside it belonged to
       everyone — a tree whose branches and leaves disagree. */
    const q = { ...companyScope(companyOf(req)), trashed: req.query.trash === "1" };

    if (req.query.tag) q.tags = String(req.query.tag);
    if (req.query.shared === "1") q.sharedWith = { $nin: ["", null] };

    /* An exact path match, so "Finance / Invoices" does not also return
       everything filed one level up. Sent as JSON because a folder name may
       legitimately contain a comma. */
    if (req.query.folderPath) {
      try {
        const raw = req.query.folderPath;
        const path = Array.isArray(raw) ? raw : JSON.parse(raw);
        if (Array.isArray(path)) q.folderPath = path.map(String);
      } catch {
        return res.status(400).json({ success: false, message: "folderPath must be a JSON array." });
      }
    }

    /* A screen, not an export. `truncated` says so out loud rather than
       letting a capped list read as the whole drive. */
    const LIMIT = 500;
    const rows = await Doc_File.find(q).sort({ updatedAt: -1 }).limit(LIMIT + 1);
    const truncated = rows.length > LIMIT;

    return res.json({
      success: true,
      files: rows.slice(0, LIMIT).map((r) => r.toNode()),
      truncated,
    });
  } catch (err) {
    console.error("[files] GET /:", err?.message);
    return res.status(500).json({ success: false, message: "Could not load documents." });
  }
});

/* ══ POST /api/files ═══════════════════════════════════════════════════════
 * Upload. `folderPath` is the app's tree, sent as JSON, because the tree is
 * still the frontend's — see the model's note.
 */
router.post("/", upload.single("file"), async (req, res) => {
  const user = requireSession(req, res, "upload a document");
  if (!user) return;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file was sent." });
    }

    let folderPath = [];
    try {
      const raw = req.body?.folderPath;
      if (raw) folderPath = Array.isArray(raw) ? raw : JSON.parse(raw);
    } catch {
      folderPath = [];
    }

    const name = req.file.originalname || "Untitled";
    const stored = await drive.uploadCompanyFile(req.file.buffer, {
      fileName: name,
      mimeType: req.file.mimetype || "application/octet-stream",
      folderPath,
    });

    const row = await Doc_File.create({
      name,
      mimeType: stored.mimeType,
      fileKind: kindOf(stored.mimeType, name),
      bytes: stored.bytes,
      storage: "drive",
      driveFileId: stored.driveFileId,
      folderPath: Array.isArray(folderPath) ? folderPath.filter(Boolean).map(String) : [],
      companyId: companyOf(req),
      ownerId: isId(user.id) ? user.id : null,
      ownerName: user.name || user.email || "",
      department: String(req.body?.department || user.deptSlug || ""),
      createdBy: isId(user.id) ? user.id : null,
    });

    return res.status(201).json({ success: true, file: row.toNode() });
  } catch (err) {
    console.error("[files] POST /:", err?.message);
    return res.status(500).json({ success: false, message: "Could not store the document." });
  }
});

/* ══ GET /api/files/:id/preview ════════════════════════════════════════════
 * What the viewer asks for. Never a provider URL.
 */
router.get("/:id/preview", async (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;

  try {
    if (!isId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    const row = await Doc_File.findById(req.params.id);
    /* 404 for "gone" AND for "not yours to know about" — a 403 on a specific
       id confirms the document exists, which is itself a leak. `restricted`
       is the one case that answers 403, because the row is already visible in
       listings and the reader needs to know why they are being stopped. */
    if (!row || row.trashed || outOfScope(companyOf(req), row)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }
    if (!mayRead(user, row)) {
      return res
        .status(403)
        .json({ success: false, message: "You do not have access to this document." });
    }

    const token = mintLetterToken({
      docId: row._id,
      scope: TOKEN_SCOPE,
      subject: user.id,
    });
    /* ── WHY THE NAME IS IN THE PATH ────────────────────────────────────
     * The browser's built-in PDF viewer titles the document from the last
     * path segment, not from Content-Disposition — so framing
     * `/api/files/<id>/download` displayed the document as "download", in
     * the reader's face, on every PDF. The segment is decorative: the route
     * ignores it, and the id and the token are still what authorise the
     * read. It exists so the viewer has something true to print. */
    const slug = encodeURIComponent(row.name || "document");
    const url = absoluteUrl(
      req,
      `/api/files/${row._id}/download/${slug}?t=${encodeURIComponent(token)}`,
    );

    /* ── THE SERVER DECIDES WHICH VIEWER ────────────────────────────────
     * `previewKind` is the SERVER's opinion about the format, so the client
     * is not the only thing deciding what it is safe to put in a frame — and
     * so "what renders" is one allowlist in one file rather than a guess
     * repeated in every component that shows a document.
     *
     * It replaces a `fileKind === "image" || "pdf"` test that was wrong in
     * both directions: it called a .tiff previewable and had no answer at all
     * for a .csv. */
    const previewKind = previewKindOf(row.mimeType, row.name);
    const canPreview = previewKind !== "unsupported";

    return res.json({
      success: true,
      file: row.toNode(),
      /* Flat copies of the three fields a caller needs to CHOOSE a viewer, so
         deciding how to render does not mean reaching into `file`. Same
         values, one level up. */
      name: row.name,
      mimeType: row.mimeType,
      size: row.bytes,
      previewKind,
      canPreview,
      /* Text is fetched as JSON from /text, not framed — so there is no
         preview URL for it, and offering one would invite an iframe. */
      previewUrl: previewKind === "image" || previewKind === "pdf" ? url : null,
      downloadUrl: url,
    });
  } catch (err) {
    console.error("[files] GET /:id/preview:", err?.message);
    return res.status(500).json({ success: false, message: "Could not prepare the preview." });
  }
});

/* ══ GET /api/files/:id/text ═══════════════════════════════════════════════
 * A text or CSV document, decoded, for the viewer to render as escaped text.
 *
 * ── WHY JSON AND NOT THE STREAM ────────────────────────────────────────────
 * The bytes are already reachable through /download, so this is not a second
 * door — it is the same door with the same lock, returning something the
 * viewer can actually use. Reading /download from JavaScript would mean a
 * cross-origin fetch carrying a signed token in the URL; reading it in a
 * frame would mean rendering a text/html document on this origin. Returning
 * a STRING sidesteps both: React escapes it, nothing executes, and the size
 * can be capped — which bytes streamed into a DOM node cannot be.
 *
 * Refuses anything that is not text. A viewer asking for a 25 MB .xlsx as a
 * string is a bug, and answering it would be a worse one.
 */
const TEXT_PREVIEW_LIMIT = 512 * 1024;

router.get("/:id/text", async (req, res) => {
  const user = requireSession(req, res, "read this document");
  if (!user) return;

  try {
    if (!isId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    const row = await Doc_File.findById(req.params.id);
    if (!row || row.trashed || outOfScope(companyOf(req), row)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }
    if (!mayRead(user, row)) {
      return res
        .status(403)
        .json({ success: false, message: "You do not have access to this document." });
    }

    const previewKind = previewKindOf(row.mimeType, row.name);
    if (previewKind !== "text") {
      return res
        .status(415)
        .json({ success: false, message: "This document is not text.", previewKind });
    }

    const { stream } = await drive.streamCompanyFile(row.driveFileId);

    /* Capped as it arrives, not after. Buffering a whole file to then throw
       most of it away is how one large upload becomes a memory spike. */
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    await new Promise((resolve, reject) => {
      stream.on("data", (chunk) => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > TEXT_PREVIEW_LIMIT) {
          truncated = true;
          chunks.push(chunk.slice(0, chunk.length - (bytes - TEXT_PREVIEW_LIMIT)));
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });

    const text = Buffer.concat(chunks).toString("utf8");
    /* A file that claims to be text and is not would otherwise arrive as a
       screenful of replacement characters. A NUL byte is the cheap, reliable
       tell, and saying so beats rendering the mess. */
    if (text.includes("\u0000")) {
      return res.status(415).json({
        success: false,
        message: "This document is not readable as text.",
        previewKind: "unsupported",
      });
    }

    return res.json({
      success: true,
      text,
      truncated,
      bytes: row.bytes,
      mimeType: row.mimeType,
      name: row.name,
    });
  } catch (err) {
    console.error("[files] GET /:id/text:", err?.message);
    return res.status(500).json({ success: false, message: "Could not read that document." });
  }
});

/* ══ GET /api/files/:id/sheet ══════════════════════════════════════════════
 * A workbook — .xlsx, .xls or .csv — as a small grid of strings.
 *
 * ── WHY THE SERVER PARSES IT ───────────────────────────────────────────────
 * The alternative is shipping a spreadsheet parser to the browser and handing
 * it the raw bytes, which means a megabyte of JavaScript on a page that
 * mostly shows PDFs, and a cross-origin fetch of a signed URL to feed it.
 * Parsing here means the client receives strings it can only render, the cap
 * is enforced where it cannot be bypassed, and nothing about the workbook
 * format reaches the browser at all.
 *
 * NOTHING IS STORED. The buffer is read, the corner that fits the cap is
 * copied out, and both are garbage when the response ends. A parsed sheet is
 * a view of a document, not a second copy of it.
 *
 * ── THE CAPS ARE THE POINT ─────────────────────────────────────────────────
 * A preview, not an export. Cells are read one at a time out of the declared
 * range rather than through `sheet_to_json`, which materialises the WHOLE
 * sheet before anything can be trimmed — a 200,000-row workbook would be
 * parsed in full to show a hundred rows. Reading cells directly also keeps
 * this away from the prototype-pollution path that sheet_to_json is known
 * for on this version of the library.
 */
const SHEET_MAX_ROWS = 100;
const SHEET_MAX_COLS = 30;
const SHEET_MAX_TABS = 12;
/* Parsing needs the whole file in memory, unlike the streamed text preview.
   Upload allows 25 MB; a workbook past this is offered as a download. */
const SHEET_MAX_BYTES = 8 * 1024 * 1024;

router.get("/:id/sheet", async (req, res) => {
  const user = requireSession(req, res, "read this document");
  if (!user) return;

  try {
    if (!isId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    const row = await Doc_File.findById(req.params.id);
    if (!row || row.trashed || outOfScope(companyOf(req), row)) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }
    if (!mayRead(user, row)) {
      return res
        .status(403)
        .json({ success: false, message: "You do not have access to this document." });
    }

    const previewKind = previewKindOf(row.mimeType, row.name);
    if (previewKind !== "sheet") {
      return res
        .status(415)
        .json({ success: false, message: "This document is not a spreadsheet.", previewKind });
    }

    if (row.bytes > SHEET_MAX_BYTES) {
      return res.status(413).json({
        success: false,
        message: "This workbook is too large to preview. Download it to open in Excel.",
      });
    }

    const { stream } = await drive.streamCompanyFile(row.driveFileId);
    const chunks = [];
    let bytes = 0;
    let overflowed = false;
    await new Promise((resolve, reject) => {
      stream.on("data", (chunk) => {
        if (overflowed) return;
        bytes += chunk.length;
        /* `row.bytes` is what Drive reported at upload; this is the real
           thing arriving. Trusting only the first would make the cap a
           suggestion. */
        if (bytes > SHEET_MAX_BYTES) {
          overflowed = true;
          stream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });

    if (overflowed) {
      return res.status(413).json({
        success: false,
        message: "This workbook is too large to preview. Download it to open in Excel.",
      });
    }

    const buf = Buffer.concat(chunks);
    const isCsv = /csv/i.test(row.mimeType || "") || /\.csv$/i.test(row.name || "");

    /* ── IS IT ACTUALLY A WORKBOOK ──────────────────────────────────────
     * The library sniffs its input and falls back to reading anything it
     * does not recognise as CSV — so a corrupt .xlsx does not fail, it
     * "succeeds" as a single cell containing garbage, and the reader is
     * shown one nonsense value where a spreadsheet should be. Checking the
     * container's magic bytes first is what turns that into an honest
     * refusal: .xlsx is a zip, .xls is an OLE compound file. */
    if (!isCsv) {
      const zip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
      const ole =
        buf.length > 8 &&
        buf[0] === 0xd0 &&
        buf[1] === 0xcf &&
        buf[2] === 0x11 &&
        buf[3] === 0xe0;
      if (!zip && !ole) {
        return res.status(422).json({
          success: false,
          message: "This workbook could not be read. It may be corrupt or not really a spreadsheet.",
        });
      }
    }

    let wb;
    try {
      wb = XLSX.read(
        buf,
        isCsv
          ? {
              type: "buffer",
              /* ── A CSV IS ITS TEXT ────────────────────────────────────
               * No cell in a CSV carries a format, so asking for formatted
               * output means asking the library to GUESS one — and it
               * guesses US short dates, turning "2026-08-01" into "8/1/26"
               * on screen. A preview that silently rewrites the document it
               * is previewing is worse than no preview, and worse still for
               * a company that writes its dates the other way round. Raw
               * keeps every field exactly as the file has it. */
              raw: true,
            }
          : {
              type: "buffer",
              cellDates: false,
              /* Formatted text, so a currency cell keeps the format the
                 spreadsheet gave it — here the format is real, not guessed. */
              cellText: true,
              raw: false,
              /* The fallback for a date cell with no explicit format. ISO
                 rather than the library's US default, for the same reason. */
              dateNF: "yyyy-mm-dd",
              /* A preview draws values. Formulas, styles and VBA are weight
                 we would parse and then throw away. */
              bookVBA: false,
              bookDeps: false,
            },
      );
    } catch (e) {
      /* A corrupt or misnamed workbook is a fact about the document, not a
         server fault — and the reader can still download it. */
      console.warn("[files] sheet parse failed:", e?.message);
      return res.status(422).json({
        success: false,
        message: "This workbook could not be read. It may be corrupt or not really a spreadsheet.",
      });
    }

    const names = (wb.SheetNames || []).slice(0, SHEET_MAX_TABS);
    if (!names.length) {
      return res.status(422).json({ success: false, message: "This workbook has no sheets." });
    }

    const sheets = names.map((name) => {
      const ws = wb.Sheets[name];
      const ref = ws && ws["!ref"];
      if (!ref) {
        return { name, rows: [], totalRows: 0, totalCols: 0, truncated: false };
      }

      const range = XLSX.utils.decode_range(ref);
      const totalRows = range.e.r - range.s.r + 1;
      const totalCols = range.e.c - range.s.c + 1;
      const lastRow = Math.min(range.e.r, range.s.r + SHEET_MAX_ROWS - 1);
      const lastCol = Math.min(range.e.c, range.s.c + SHEET_MAX_COLS - 1);

      const rows = [];
      for (let r = range.s.r; r <= lastRow; r++) {
        const line = [];
        for (let c = range.s.c; c <= lastCol; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          /* `.w` is the formatted text the spreadsheet itself shows; `.v` is
             the underlying value, used only when there is no format. */
          line.push(cell ? String(cell.w ?? cell.v ?? "") : "");
        }
        rows.push(line);
      }

      return {
        name,
        rows,
        totalRows,
        totalCols,
        truncated: totalRows > rows.length || totalCols > (rows[0]?.length || 0),
      };
    });

    return res.json({
      success: true,
      sheets,
      /* Said out loud so the viewer can caption it rather than silently
         showing a corner of a workbook as though it were the whole thing. */
      limits: { rows: SHEET_MAX_ROWS, cols: SHEET_MAX_COLS, tabs: SHEET_MAX_TABS },
      tabsTruncated: (wb.SheetNames || []).length > names.length,
      name: row.name,
    });
  } catch (err) {
    console.error("[files] GET /:id/sheet:", err?.message);
    return res.status(500).json({ success: false, message: "Could not read that workbook." });
  }
});

/* ══ GET /api/files/:id/download?t=… ═══════════════════════════════════════
 * The bytes. Token AND session, every time.
 */
async function streamDownload(req, res) {
  try {
    if (!isId(req.params.id)) return res.status(404).end();

    /* Both credentials are required. The token alone would make a copied URL
       a bearer grant for its whole lifetime, which is the thing this design
       exists to avoid; the session alone would let any signed-in person read
       any id by guessing. */
    const payload = verifyFileToken(req.query.t, req.params.id);
    if (!payload) return res.status(404).end();

    const user = sessionOf(req);
    if (!user) return res.status(401).end();

    const row = await Doc_File.findById(req.params.id);
    if (outOfScope(companyOf(req), row)) return res.status(404).end();
    if (!mayRead(user, row)) return res.status(404).end();

    const { stream, meta } = await drive.streamCompanyFile(row.driveFileId);

    res.setHeader("Content-Type", meta.mimeType || row.mimeType || "application/octet-stream");
    /* ── WHAT MAY BE SERVED INLINE ──────────────────────────────────────
     * `inline` so a PDF opens in the frame the viewer already drew rather
     * than downloading behind it — except when the caller asked to download,
     * which the browser cannot force itself: `<a download>` is ignored
     * cross-origin, and the API is on a different origin from the app.
     *
     * AND except for anything that could execute. An uploaded .html or .svg
     * served inline runs its scripts ON THIS ORIGIN, with this session's
     * cookie — stored XSS, uploadable by any signed-in person. So inline is
     * an allowlist of the two things browsers render passively, and
     * everything else downloads. The viewer never framed those formats
     * anyway; this closes the door for anyone reaching /download directly.
     *
     * `nosniff` is the other half: without it a text/plain file whose bytes
     * look like markup can still be sniffed into HTML and executed. */
    const mime = String(meta.mimeType || row.mimeType || "").toLowerCase();
    const inlineSafe =
      (mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf";
    const disposition = req.query.dl === "1" || !inlineSafe ? "attachment" : "inline";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${encodeURIComponent(row.name).replace(/"/g, "")}"`,
    );
    /* Private and short-lived: a shared cache must never hold these bytes,
       and the browser may keep them only as long as the token lives. */
    res.setHeader("Cache-Control", "private, max-age=300");
    if (meta.size) res.setHeader("Content-Length", meta.size);

    stream.on("error", (e) => {
      console.error("[files] drive stream error:", e?.message);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    return stream.pipe(res);
  } catch (err) {
    console.error("[files] GET /:id/download:", err?.message);
    if (!res.headersSent) return res.status(500).end();
    return res.end();
  }
}

/* Two paths, one handler. The second carries a decorative filename segment so
   the browser's PDF viewer has a real title to print instead of "download" —
   see the note where the preview URL is minted. Express 5 dropped array
   paths, hence two registrations rather than one. */
router.get("/:id/download", streamDownload);
router.get("/:id/download/:filename", streamDownload);

/* ══ MUTATION ══════════════════════════════════════════════════════════════
 * Everything below changes a row. They share one gate and one validator, so
 * "what may be edited" is answerable by reading two functions rather than
 * four routes.
 */

/**
 * May this session CHANGE this row?
 *
 * Deliberately NOT `mayRead`: a trashed row must stay writable or nothing
 * could ever restore or delete it. That difference is the whole reason this
 * is a second function rather than a flag on the first.
 */
function mayWrite(user, row) {
  if (!row) return false;
  if (!row.restricted) return true; // see the header: shared drive, no ACLs yet
  if (user?.isAdmin) return true;
  return String(row.ownerId || "") === String(user?.id || "");
}

/* Changing these is not an edit, it is a different document wearing this
   one's row: `driveFileId` would repoint it at somebody else's bytes,
   `bytes`/`mimeType` would make the listing lie about what is stored, and
   `ownerId` would hand over a restricted document's only key. Refused by
   name rather than dropped silently — a caller that thought it was moving a
   file between owners deserves to be told it did not. */
const IMMUTABLE = [
  "driveFileId",
  "ownerId",
  "ownerName",
  "createdBy",
  "storage",
  "bytes",
  "mimeType",
  "fileKind",
  "_id",
  "id",
];

/* `trashed` is absent from BOTH lists on purpose: it has its own two
   endpoints, which say what they do at the call site. A PATCH that could
   also empty the trash is a PATCH nobody reads carefully. */
const EDITABLE = ["name", "folderPath", "starred", "tags", "restricted", "sharedWith"];

const isPlainString = (v) => typeof v === "string";

/**
 * The request body → a $set, or a reason it is not one.
 *
 * Returns { update } or { error }. Never both, and never a partial update
 * alongside an error: half-applying an edit is worse than refusing it.
 */
function buildUpdate(body = {}, { user, row } = {}) {
  for (const key of IMMUTABLE) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return { error: `${key} cannot be changed.` };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "trashed")) {
    return { error: "Use /trash and /restore to change whether a document is in the trash." };
  }

  const update = {};

  if (body.name !== undefined) {
    if (!isPlainString(body.name)) return { error: "name must be text." };
    const name = body.name.trim();
    if (!name) return { error: "A document needs a name." };
    if (name.length > 260) return { error: "That name is too long." };
    /* A path separator in a name is how a listing row starts claiming to be
       a folder, and how an export writes outside its directory. */
    if (/[\\/]/.test(name)) return { error: "A name cannot contain / or \\." };
    update.name = name;
  }

  if (body.folderPath !== undefined) {
    if (!Array.isArray(body.folderPath)) return { error: "folderPath must be a list." };
    if (body.folderPath.length > 12) return { error: "That folder is nested too deep." };
    const path = [];
    for (const seg of body.folderPath) {
      if (!isPlainString(seg)) return { error: "folderPath must be a list of folder names." };
      const clean = seg.trim();
      if (!clean) return { error: "A folder name in the path is empty." };
      if (clean.length > 120) return { error: "A folder name in the path is too long." };
      path.push(clean);
    }
    update.folderPath = path;
  }

  if (body.starred !== undefined) {
    if (typeof body.starred !== "boolean") return { error: "starred must be true or false." };
    update.starred = body.starred;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return { error: "tags must be a list." };
    if (body.tags.length > 12) return { error: "That is too many tags." };
    const tags = [];
    for (const tag of body.tags) {
      if (!isPlainString(tag)) return { error: "tags must be a list of words." };
      const clean = tag.trim();
      if (!clean) continue;
      if (clean.length > 40) return { error: `"${clean.slice(0, 20)}…" is too long for a tag.` };
      /* Simple strings, not a closed vocabulary. A server-side enum would
         have to be kept in step with the client's tag list by hand, and the
         first time they drifted the honest tag would be the one refused.
         The shape is what is enforced; the vocabulary is the UI's. */
      if (!/^[\w][\w .&/+-]*$/.test(clean)) return { error: `"${clean}" is not a usable tag.` };
      if (!tags.includes(clean)) tags.push(clean);
    }
    update.tags = tags;
  }

  if (body.sharedWith !== undefined) {
    if (body.sharedWith !== null && !isPlainString(body.sharedWith)) {
      return { error: "sharedWith must be text." };
    }
    const shared = String(body.sharedWith || "").trim();
    if (shared.length > 200) return { error: "That sharing note is too long." };
    update.sharedWith = shared;
  }

  if (body.restricted !== undefined) {
    if (typeof body.restricted !== "boolean") return { error: "restricted must be true or false." };
    /* The lock is not an ordinary field. Anyone-can-edit plus anyone-can-lock
       means any signed-in person can take a document away from the rest of
       the company, and only its owner could give it back. */
    if (body.restricted !== row?.restricted) {
      const owns = String(row?.ownerId || "") === String(user?.id || "");
      if (!user?.isAdmin && !owns) {
        return { error: "Only the document's owner or an admin can change who may open it." };
      }
    }
    update.restricted = body.restricted;
  }

  if (!Object.keys(update).length) {
    return { error: `Nothing to change. Editable fields: ${EDITABLE.join(", ")}.` };
  }
  return { update };
}

/** Load + gate, shared by all four mutating routes. Returns the row or null,
 *  having already answered the request when it returns null. */
async function loadForWrite(req, res, what) {
  const user = requireSession(req, res, what);
  if (!user) return null;

  if (!isId(req.params.id)) {
    res.status(404).json({ success: false, message: "Document not found." });
    return null;
  }

  const row = await Doc_File.findById(req.params.id);
  if (!row || outOfScope(companyOf(req), row)) {
    res.status(404).json({ success: false, message: "Document not found." });
    return null;
  }
  if (!mayWrite(user, row)) {
    res.status(403).json({ success: false, message: "You do not have access to this document." });
    return null;
  }
  return { user, row };
}

/* ══ PATCH /api/files/:id ══════════════════════════════════════════════════
 * Rename, move, star, tag, share, restrict. One endpoint because they are one
 * operation to the database and one gate to the reader.
 */
router.patch("/:id", async (req, res) => {
  try {
    const found = await loadForWrite(req, res, "edit this document");
    if (!found) return;
    const { user, row } = found;

    /* A row in the trash is not editable, only restorable. The UI offers
       exactly Restore and Delete forever there, and a rename that silently
       succeeded on an invisible document would surface as "my change did not
       save" the moment it was restored. */
    if (row.trashed) {
      return res.status(409).json({
        success: false,
        message: "Restore this document before editing it.",
      });
    }

    const { update, error } = buildUpdate(req.body || {}, { user, row });
    if (error) return res.status(400).json({ success: false, message: error });

    Object.assign(row, update);
    await row.save();

    return res.json({ success: true, file: row.toNode() });
  } catch (err) {
    console.error("[files] PATCH /:id:", err?.message);
    return res.status(500).json({ success: false, message: "Could not save that change." });
  }
});

/* ══ POST /api/files/:id/trash | /restore ══════════════════════════════════
 * Its own pair rather than a PATCH field — see the note on EDITABLE. Both are
 * idempotent: a second click is not an error, it is the same answer.
 */
router.post("/:id/trash", async (req, res) => {
  try {
    const found = await loadForWrite(req, res, "move this document to the trash");
    if (!found) return;
    const { row } = found;

    if (!row.trashed) {
      row.trashed = true;
      await row.save();
    }
    return res.json({ success: true, file: row.toNode() });
  } catch (err) {
    console.error("[files] POST /:id/trash:", err?.message);
    return res.status(500).json({ success: false, message: "Could not move that to the trash." });
  }
});

router.post("/:id/restore", async (req, res) => {
  try {
    const found = await loadForWrite(req, res, "restore this document");
    if (!found) return;
    const { row } = found;

    if (row.trashed) {
      row.trashed = false;
      await row.save();
    }
    /* Restored to its stored `folderPath` — which is why trashing never
       clears it. The UI re-derives the folder from that path. */
    return res.json({ success: true, file: row.toNode() });
  } catch (err) {
    console.error("[files] POST /:id/restore:", err?.message);
    return res.status(500).json({ success: false, message: "Could not restore that document." });
  }
});

/* ══ DELETE /api/files/:id ═════════════════════════════════════════════════
 * Permanent. Row AND bytes.
 *
 * ── ONLY OUT OF THE TRASH ──────────────────────────────────────────────────
 * A live document cannot be destroyed in one call, by anyone. Trash first is
 * a UI convention that only means something if the server holds it too;
 * otherwise a mis-wired button, or a caller that never saw the UI, deletes a
 * signed contract with one request and no undo.
 *
 * ── ROW FIRST, THEN THE BYTES ──────────────────────────────────────────────
 * Deliberate order, and the failure it chooses is deliberate too. Drive-first
 * risks the bad half: bytes gone, row still listed, every open from now on a
 * 502 on a document the drive still claims to hold. Row-first risks an
 * orphaned Drive object nobody can reach — invisible, unreachable through
 * this app, and reclaimable by an admin sweeping the folder. The service
 * already takes the same view (see its deleteCompanyFile note), so both
 * layers fail the same way. `driveDeleted: false` in the response is how that
 * outcome is reported rather than hidden.
 */
router.delete("/:id", async (req, res) => {
  try {
    const found = await loadForWrite(req, res, "delete this document");
    if (!found) return;
    const { row } = found;

    if (!row.trashed) {
      return res.status(409).json({
        success: false,
        message: "Move this document to the trash before deleting it permanently.",
      });
    }

    const driveFileId = row.driveFileId;
    await row.deleteOne();

    let driveDeleted = false;
    try {
      driveDeleted = await drive.deleteCompanyFile(driveFileId);
    } catch (e) {
      /* Already best-effort inside the service; this catch is for the case
         where the service itself is misconfigured. The row is gone either
         way, which is what the caller asked for. */
      console.warn("[files] drive delete failed:", e?.message);
    }

    return res.json({ success: true, id: String(req.params.id), driveDeleted });
  } catch (err) {
    console.error("[files] DELETE /:id:", err?.message);
    return res.status(500).json({ success: false, message: "Could not delete that document." });
  }
});

module.exports = router;

