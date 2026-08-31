// routes/Accountant_Routes/Acc_companies.js
// =============================================================================
// TALLY COMPANIES — CRUD + group seeding
// =============================================================================

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const creditTerms = require("../../services/creditTerms.service");
const taxIdentity = require("../../services/taxIdentity.service");
const gstPortal = require("../../services/gstPortal.service");
/* Used by the address merge in PUT /:id to derive a state code from the GSTIN.
   It was referenced there but never imported — a pre-existing ReferenceError
   that only fired when an update carried an `address` or `contact` object, so
   editing any other field worked and editing the address did not. */
const gstState = require("../../services/gstState.util");
const multer = require("multer");
const drive = require("../../services/companyDrive.service");
const {
  mintLetterToken,
  verifyLetterToken,
  absoluteUrl,
} = require("../../utils/letterDownloadToken");
const {
  Acc_Company,
  Acc_Group,
  ACC_DEFAULT_GROUPS,
  ACC_COMPANY_DOC_KINDS,
  ACC_COMPANY_DOC_KIND_VALUES,
  filesOfDoc,
  labelOfDoc,
} = require("../../models/Accountant_model/Acc_MasterModels");

// Company changes, in the accounting change history. The mount-level trail
// already records that something happened here; this adds the before/after, so
// an edit to a GSTIN reads as the old value and the new one rather than "a
// company was updated".
const { recordChange } = require("../../services/changeLog");
const auditCompany = (req, entry) =>
  recordChange(req, {
    departmentSlug: "accounting",
    section: "accounting:companies",
    entity: "company",
    ...entry,
  });

/** The fields on a company worth diffing — identity, tax and the books date. */
const companySnapshot = (c) => ({
  companyName: c?.companyName,
  companyCode: c?.companyCode,
  gstin: c?.gstin,
  pan: c?.pan,
  tan: c?.tan,
  cin: c?.cin,
  stateCode: c?.stateCode,
  booksFrom: c?.booksFrom,
  isPrimary: c?.isPrimary,
  isActive: c?.isActive,
  address: c?.address,
  contact: c?.contact,
});

// `/:id/default-credit-days` self-protects with `accountantAuth` +
// `creditTerms.canEditTerms` below — the SAME permission the party-level
// credit-terms editor and C0-F's backfill apply already require, not
// owner-only. It is excluded from the owner-only gate rather than folded
// into it, because the rest of this router (company CRUD, group reseeding)
// is deliberately more restrictive than this one field.
//
// AUTHENTICATE FIRST. This gate used to read `req.user?.role` with nothing
// mounted above it to put a user there: this router applies `accountantAuth`
// on exactly one route (`/:id/default-credit-days`, further down), so on every
// other write `req.user` was undefined, `isOwner` was false, and the OWNER got
// "Only the owner can add or manage companies." The gate refused everybody,
// which is why it looked like the role was not being read — it was not being
// read, because nothing had resolved it yet.
//
// It is the same trap documented in Middlewear/departmentWriteGuard.js: a
// permission check mounted above a router runs BEFORE that router's own auth.
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.path.endsWith("/default-credit-days")) return next();
  // accountantAuth answers 401/403 itself when the session is missing or the
  // role cannot edit, so reaching the next handler means req.user is populated.
  return accountantAuth(req, res, next);
});

router.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.path.endsWith("/default-credit-days")) return next();

  // Managing companies is the `canManageSettings` capability, which is what the
  // role system already calls this — owner only, by its own definition. Reading
  // the capability rather than comparing the role name means a future role that
  // is allowed to manage settings works without editing this line, and it keeps
  // the accountant module's two role vocabularies (legacy names, new
  // capabilities) from having to agree here.
  const u = req.user || {};
  const allowed =
    u.permissions?.canManageSettings === true || u.isLegacy || u.isDev;

  if (!allowed) {
    return res.status(403).json({
      success: false,
      code: "INSUFFICIENT_ROLE",
      role: u.role || null,
      message:
        `Only the owner can add or manage companies.` +
        (u.role ? ` You are signed in as ${u.role}.` : ""),
    });
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper — seed Tally's 28 reserved groups for a brand-new company
// ─────────────────────────────────────────────────────────────────────────────
async function seedDefaultGroups(companyId, createdBy) {
  // Two-pass insert: first pass creates all primary groups (parent=null),
  // second pass creates the children referencing the parent ObjectIds.
  const byName = new Map();

  // Pass 1: primaries
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => !x.parent)) {
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: null,
      parentName: null,
      isPrimary: true,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 1,
      fullPath: g.name,
      createdBy,
    });
    byName.set(g.name, doc);
  }

  // Pass 2: children
  for (const g of ACC_DEFAULT_GROUPS.filter((x) => x.parent)) {
    const parent = byName.get(g.parent);
    if (!parent) continue;
    const doc = await Acc_Group.create({
      companyId,
      name: g.name,
      parent: parent._id,
      parentName: parent.name,
      isPrimary: false,
      isReserved: g.isReserved || false,
      nature: g.nature,
      level: 2,
      fullPath: `${parent.name} > ${g.name}`,
      createdBy,
    });
    byName.set(g.name, doc);
  }

  return byName.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/tally/companies
// ─────────────────────────────────────────────────────────────────────────────
/* ══ STATUTORY DOCUMENTS ═══════════════════════════════════════════════════
 * The certificates behind the identifiers: GST registration, PAN card,
 * certificate of incorporation.
 *
 * ── NOTHING NEW WAS BUILT FOR STORAGE ──────────────────────────────────────
 * These reuse services/companyDrive.service.js — the same private Drive
 * upload and authenticated stream the /files drive uses — and the same signed
 * token helper as employee letters. That matters more than it looks: a third
 * copy of "put bytes on Drive" would be a third place for the rule that the
 * object is never made public to be got wrong, and it only has to be got
 * wrong once.
 *
 * `folderPath` folds into the stored Drive name (see that service's note), so
 * these land as "Statutory / <company> / <file>" in a flat Drive folder an
 * admin can actually read by eye.
 */
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  /* A certificate is a scan, not a video. The COUNT limit is what makes a
     twenty-page lease possible without making a hundred-file drop possible. */
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
});

/* Accepts both shapes: `file` (one, what the old client sent) and `files`
   (several, front/back or a multi-page scan). Declaring both means the older
   client keeps working through the same handler rather than through a second
   one that would drift from it. */
const uploadDocFiles = uploadDoc.fields([
  { name: "file", maxCount: 1 },
  { name: "files", maxCount: 20 },
]);

/** Everything multer collected, in the order it was sent. */
function incomingFiles(req) {
  const f = req.files || {};
  return [...(f.file || []), ...(f.files || [])];
}

/**
 * A caption for file N of a document.
 *
 * The client may send one caption per file (`captions[]`), or none at all. When
 * it sends none the files still need telling apart, so they are numbered from
 * what is already on the document — appending two pages to a three-page
 * certificate gives "Page 4" and "Page 5", not "Page 1" and "Page 2".
 */
function captionFor(req, index, existingCount) {
  const raw = req.body?.captions;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const given = String(list[index] ?? "").trim();
  if (given) return given.slice(0, 80);
  return `Page ${existingCount + index + 1}`;
}

const DOC_TOKEN_SCOPE = "company-doc";

/** A token for one company document, or null. Scope-checked so a letter token
 *  or a drive-file token cannot open one of these. */
function verifyDocToken(token, docId, fileId) {
  const payload = verifyLetterToken(token);
  if (!payload) return null;
  if (payload.s !== DOC_TOKEN_SCOPE) return null;
  if (String(payload.d) !== String(docId)) return null;
  /* A document now holds several files, so a token for one of them must not
     open another. Tokens minted before this carry no `f` and are accepted for
     the document's first file only — which is the only file they could ever
     have meant. */
  if (fileId !== undefined && payload.f !== undefined && String(payload.f) !== String(fileId)) {
    return null;
  }
  return payload;
}

/** The file a request is asking for: the named one, else the document's first. */
function pickFile(doc, fileId) {
  const files = filesOfDoc(doc);
  if (!files.length) return null;
  if (!fileId) return files[0];
  return files.find((f) => String(f._id) === String(fileId)) || null;
}

/* GET /document-kinds — the catalogue the form is built from.

   Declared BEFORE `GET /:id`, or Express matches "document-kinds" as a company
   id. Served rather than duplicated on the client because the enum that
   validates an upload and the list that offers it have to be the same list —
   a label-only copy in the form is how a dropdown offers a kind the schema
   then rejects. */
router.get("/document-kinds", (_req, res) => {
  res.json({ success: true, kinds: ACC_COMPANY_DOC_KINDS });
});

/* POST /:id/documents — attach one or more files.

   Two jobs in one route, chosen by whether `docId` is present:
     absent  → create a document and put the files in it
     present → append the files to that document (the back of an Aadhaar, or
               pages 4 and 5 of a lease)

   Appending is a POST to the collection rather than a PATCH on the document
   because what is being created IS a file; the document it lands in is the
   destination, not the subject. */
router.post("/:id/documents", uploadDocFiles, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }
    const company = await Acc_Company.findById(req.params.id);
    if (!company) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }

    const incoming = incomingFiles(req);
    if (!incoming.length) {
      return res.status(400).json({ success: false, message: "No file was sent." });
    }

    const kind = ACC_COMPANY_DOC_KIND_VALUES.includes(req.body?.kind)
      ? req.body.kind
      : "other";
    const label = String(req.body?.label || "").trim().slice(0, 160);

    /* Appending to an existing document, or starting a new one. */
    let doc = req.body?.docId ? company.documents.id(req.body.docId) : null;
    const isNew = !doc;
    if (isNew) {
      company.documents.push({
        kind,
        label,
        note: String(req.body?.note || "").slice(0, 300),
        uploadedBy: mongoose.Types.ObjectId.isValid(req.user?.id) ? req.user.id : null,
        uploadedByName: req.user?.name || req.user?.email || "",
        uploadedAt: new Date(),
        files: [],
      });
      doc = company.documents[company.documents.length - 1];
    } else if (label) {
      doc.label = label;
    }

    /* A pre-existing single-file row gets its legacy file promoted into the
       array the first time something is appended to it, so the two eras never
       coexist on one document and every reader sees one list. */
    if (!doc.files?.length && doc.driveFileId) {
      doc.files.push({
        driveFileId: doc.driveFileId,
        name: doc.name,
        mimeType: doc.mimeType,
        bytes: doc.bytes,
        caption: "Page 1",
        uploadedBy: doc.uploadedBy,
        uploadedByName: doc.uploadedByName,
        uploadedAt: doc.uploadedAt,
      });
    }

    const before = doc.files.length;
    for (let i = 0; i < incoming.length; i += 1) {
      const f = incoming[i];
      const name = String(f.originalname || "Document").slice(0, 260);
      const stored = await drive.uploadCompanyFile(f.buffer, {
        fileName: name,
        mimeType: f.mimetype || "application/octet-stream",
        folderPath: ["Statutory", company.companyName || "Company"],
      });
      doc.files.push({
        driveFileId: stored.driveFileId,
        name,
        mimeType: stored.mimeType,
        bytes: stored.bytes,
        caption: captionFor(req, i, before),
        uploadedBy: mongoose.Types.ObjectId.isValid(req.user?.id) ? req.user.id : null,
        uploadedByName: req.user?.name || req.user?.email || "",
        uploadedAt: new Date(),
      });
    }

    await company.save();

    await auditCompany(req, {
      entityId: String(company._id),
      entityLabel: company.companyName,
      action: "update",
      summary:
        `${isNew ? "Attached" : "Added"} ${incoming.length} file(s) ` +
        `${isNew ? "as" : "to"} “${labelOfDoc(doc)}”` +
        ` — the document now has ${doc.files.length} file(s) on file.`,
    });

    return res.status(201).json({ success: true, document: publicDoc(doc) });
  } catch (err) {
    console.error("[companies] POST /:id/documents:", err?.message);
    return res.status(500).json({ success: false, message: "Could not store that document." });
  }
});

/* DELETE /:id/documents/:docId/files/:fileId — remove ONE page or side.

   Separate from deleting the document: losing the back of an Aadhaar because
   you meant to replace it is a different mistake from losing the Aadhaar. When
   the last file goes the document goes with it — an empty document is a row
   that says a proof is on file when none is. */
router.delete("/:id/documents/:docId/files/:fileId", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id);
    const doc = company && company.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, message: "Document not found." });

    const file = doc.files?.id?.(req.params.fileId);
    /* A legacy single-file row has no `files` entry to remove — the file IS the
       document, so removing it removes the document. */
    const legacyTarget =
      !file && String(req.params.fileId) === String(doc._id) && doc.driveFileId;
    if (!file && !legacyTarget) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    const driveFileId = file ? file.driveFileId : doc.driveFileId;
    const label = labelOfDoc(doc);
    const caption = file?.caption || "";

    if (file) file.deleteOne();
    else doc.driveFileId = "";

    const emptied = filesOfDoc(doc).length === 0;
    if (emptied) doc.deleteOne();
    await company.save();

    if (driveFileId) {
      drive.deleteCompanyFile(driveFileId).catch(() => {});
    }

    await auditCompany(req, {
      entityId: String(company._id),
      entityLabel: company.companyName,
      action: "update",
      summary:
        `Removed ${caption ? `“${caption}” from ` : "a file from "}“${label}”. ` +
        (emptied
          ? "That was its last file, so the document was removed with it."
          : `${filesOfDoc(doc).length} file(s) remain on it.`),
    });

    return res.json({ success: true, removedDocument: emptied });
  } catch (err) {
    console.error("[companies] DELETE document file:", err?.message);
    return res.status(500).json({ success: false, message: "Could not remove that file." });
  }
});

/** What a document looks like to the client. `driveFileId` is NOT in it —
 *  the provider's id is not the client's business and leaking it invites
 *  somebody to build a URL out of it. */
function publicDoc(d) {
  const files = filesOfDoc(d);
  return {
    id: String(d._id),
    kind: d.kind,
    /* What to print. Resolved here rather than on the client so a custom label
       and a catalogue label arrive already reconciled — the client should not
       have to know which of the two won. */
    label: labelOfDoc(d),
    customLabel: d.label || "",
    note: d.note || "",
    uploadedByName: d.uploadedByName || "—",
    uploadedAt: d.uploadedAt,

    files: files.map((f) => ({
      id: String(f._id),
      name: f.name,
      mimeType: f.mimeType,
      bytes: f.bytes,
      caption: f.caption || "",
      uploadedByName: f.uploadedByName || "—",
      uploadedAt: f.uploadedAt,
    })),
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + (f.bytes || 0), 0),

    /* The first file's shape, kept at the top level so a client written against
       the single-file API keeps rendering something sensible instead of a blank
       row. New clients read `files`. */
    name: files[0]?.name || d.name,
    mimeType: files[0]?.mimeType || d.mimeType,
    bytes: files[0]?.bytes || d.bytes,
  };
}

/* GET /:id/documents — what is on file, and what is missing. */
router.get("/:id/documents", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id).select("documents companyName");
    if (!company) {
      return res.status(404).json({ success: false, message: "Company not found." });
    }
    return res.json({
      success: true,
      documents: (company.documents || []).map(publicDoc),
    });
  } catch (err) {
    console.error("[companies] GET /:id/documents:", err?.message);
    return res.status(500).json({ success: false, message: "Could not load documents." });
  }
});

/* GET /:id/documents/:docId/link — a short-lived URL back into this service. */
router.get("/:id/documents/:docId/link", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id).select("documents");
    const doc = company && company.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, message: "Document not found." });

    /* `?fileId=` picks a page or a side; without it the document's first file
       is meant, which is what every existing caller means. */
    const file = pickFile(doc, req.query.fileId);
    if (!file) {
      return res.status(404).json({ success: false, message: "That file is not on this document." });
    }

    const token = mintLetterToken({
      docId: doc._id,
      fileId: file._id,
      scope: DOC_TOKEN_SCOPE,
      subject: req.user?.id,
    });
    /* The name rides in the path so a framed PDF is titled with the document
       rather than with the word "download" — the same fix the drive viewer
       needed. */
    const slug = encodeURIComponent(file.name || "document");
    const qs =
      `?t=${encodeURIComponent(token)}` +
      (req.query.fileId ? `&fileId=${encodeURIComponent(String(file._id))}` : "");
    const url = absoluteUrl(
      req,
      `/api/accountant/tally/companies/${company._id}/documents/${doc._id}/download/${slug}${qs}`,
    );
    return res.json({ success: true, url, document: publicDoc(doc) });
  } catch (err) {
    console.error("[companies] GET document link:", err?.message);
    return res.status(500).json({ success: false, message: "Could not prepare that document." });
  }
});

/* The bytes. Token AND session, re-checked on every request. */
async function streamCompanyDoc(req, res) {
  try {
    if (!verifyDocToken(req.query.t, req.params.docId, req.query.fileId)) {
      return res.status(404).end();
    }

    const company = await Acc_Company.findById(req.params.id).select("documents");
    const doc = company && company.documents.id(req.params.docId);
    if (!doc) return res.status(404).end();

    const file = pickFile(doc, req.query.fileId);
    if (!file || !file.driveFileId) return res.status(404).end();

    const { stream, meta } = await drive.streamCompanyFile(file.driveFileId);

    const mime = String(meta.mimeType || file.mimeType || "").toLowerCase();
    /* The same inline allowlist the drive settled on: anything that could
       execute is forced to download, because an uploaded .html or .svg served
       inline runs on this origin with this session's cookie. */
    const inlineSafe =
      (mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf";
    res.setHeader("Content-Type", meta.mimeType || file.mimeType || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${req.query.dl === "1" || !inlineSafe ? "attachment" : "inline"}; filename="${encodeURIComponent(file.name || "document").replace(/"/g, "")}"`,
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    if (meta.size) res.setHeader("Content-Length", meta.size);

    stream.on("error", () => {
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    return stream.pipe(res);
  } catch (err) {
    console.error("[companies] document download:", err?.message);
    if (!res.headersSent) return res.status(500).end();
    return res.end();
  }
}
router.get("/:id/documents/:docId/download", streamCompanyDoc);
router.get("/:id/documents/:docId/download/:filename", streamCompanyDoc);

/* DELETE /:id/documents/:docId — row first, then the bytes, best effort. */
router.delete("/:id/documents/:docId", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id);
    const doc = company && company.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, message: "Document not found." });

    /* EVERY file, not just the legacy one. A document now holds several, and
       reading only `driveFileId` here would drop the record while leaving all
       but one of its scans on Drive with nothing pointing at them. */
    const label = labelOfDoc(doc);
    const driveFileIds = filesOfDoc(doc)
      .map((f) => f.driveFileId)
      .filter(Boolean);

    doc.deleteOne();
    await company.save();

    /* Same order and same trade-off as the drive: an orphaned Drive object
       beats a record pointing at bytes the user believes are gone. */
    let driveDeleted = 0;
    for (const id of driveFileIds) {
      try {
        if (await drive.deleteCompanyFile(id)) driveDeleted += 1;
      } catch (e) {
        console.warn("[companies] drive delete failed:", e?.message);
      }
    }

    await auditCompany(req, {
      entityId: String(company._id),
      entityLabel: company.companyName,
      action: "update",
      summary:
        `Removed the document “${label}” and all ${driveFileIds.length} of its file(s).`,
    });

    return res.json({
      success: true,
      id: String(req.params.docId),
      driveDeleted,
      filesRemoved: driveFileIds.length,
    });
  } catch (err) {
    console.error("[companies] DELETE document:", err?.message);
    return res.status(500).json({ success: false, message: "Could not delete that document." });
  }
});

/* ══ POST /api/accountant/tally/companies/verify ═══════════════════════════
 * Check a company's tax identifiers against each other. Reports; never saves.
 *
 * ── WHY IT TAKES A BODY AND NOT AN ID ──────────────────────────────────────
 * Because the useful moment is while somebody is TYPING, before the record
 * exists — a GSTIN whose check digit is wrong should be caught in the form,
 * not discovered next quarter on a filed return. So it verifies whatever is
 * on screen, including a company that has never been saved.
 *
 * ── TWO TIERS, AND ONLY ONE OF THEM IS FREE ────────────────────────────────
 * By DEFAULT this is arithmetic only: formats, check digits, and whether the
 * four identifiers agree with each other. That runs on every keystroke
 * because it costs nothing.
 *
 * `online: true` adds a real lookup against the GST Network through a
 * configured provider — which the form asks for on a BUTTON, never on a
 * keystroke, because every one of those calls is billed. The portal answers
 * the two questions arithmetic never can: does this registration exist, and
 * is it still active. A cancelled GSTIN stays perfectly well-formed forever.
 *
 * The response distinguishes the two: `checkedOffline` is always true,
 * `checkedPortal` only when a register actually answered. A UI that showed
 * "verified with the GST Network" because a lookup was merely ATTEMPTED would
 * be making a claim nobody checked.
 */
router.post("/verify", async (req, res) => {
  try {
    const { companyName, gstin, pan, cin, tan, address, online } = req.body || {};
    const company = { companyName, gstin, pan, cin, tan, address };

    let lookup = null;
    if (online) {
      /* Only worth spending a call on a GSTIN that already passes its own
         check digit — a mistyped number cannot exist in the register, and
         asking anyway bills the company to be told what arithmetic already
         said. */
      const offline = taxIdentity.validateGstin(gstin);
      if (offline.status === "ok") {
        lookup = await gstPortal.lookupGstin(offline.value, { force: !!req.body.force });
      } else if (offline.status !== "empty") {
        lookup = { ok: false, reason: "skipped-malformed" };
      }
    }

    const report = taxIdentity.verifyCompanyIdentity(company, lookup);
    return res.json({
      success: true,
      portalAvailable: gstPortal.isConfigured(),
      portalHint: gstPortal.isConfigured() ? null : gstPortal.configHint(),
      ...report,
    });
  } catch (err) {
    console.error("[companies] POST /verify:", err?.message);
    return res.status(500).json({ success: false, message: "Could not check those details." });
  }
});

router.get("/", async (req, res) => {
  try {
    const companies = await Acc_Company.find({ isActive: true })
      .sort({ isPrimary: -1, createdAt: -1 })
      .lean();

    // Quick stats per company
    const withStats = await Promise.all(
      companies.map(async (c) => {
        const groupCount = await Acc_Group.countDocuments({ companyId: c._id });
        return { ...c, stats: { groupCount } };
      }),
    );

    res.json({ success: true, companies: withStats, count: withStats.length });
  } catch (err) {
    console.error("GET tally companies:", err);
    res
      .status(500)
      .json({ success: false, message: "Error fetching companies" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/tally/companies — create a new company + seed groups
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      companyName,
      companyCode,
      gstin,
      pan,
      cin,
      tan,
      address,
      contact,
      booksFromDate,
      financialYearStart,
      isPrimary,
      isImportedFromTally,
      tallyCompanyGuid,
    } = req.body;

    if (!companyName)
      return res
        .status(400)
        .json({ success: false, message: "companyName is required" });
    if (!booksFromDate)
      return res
        .status(400)
        .json({ success: false, message: "booksFromDate is required" });

    // If marking primary, unset any existing primary
    if (isPrimary) {
      await Acc_Company.updateMany({ isPrimary: true }, { isPrimary: false });
    }

    // Compute current FY string
    const today = new Date();
    const fy =
      today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const fyString = `${fy}-${(fy + 1).toString().slice(2)}`;

    const company = await Acc_Company.create({
      companyName,
      companyCode,
      gstin,
      pan,
      cin,
      tan,
      address,
      contact,
      booksFromDate: new Date(booksFromDate),
      financialYearStart: financialYearStart
        ? new Date(financialYearStart)
        : new Date(fy, 3, 1),
      currentFinancialYear: fyString,
      isPrimary: !!isPrimary,
      isImportedFromTally: !!isImportedFromTally,
      tallyCompanyGuid,
      createdBy: req.user?.id,
    });

    // Seed the 28 default groups
    const seeded = await seedDefaultGroups(company._id, req.user?.id);

    await auditCompany(req, {
      entityId: String(company._id),
      entityLabel: company.companyName,
      action: "create",
      summary:
        `Created company “${company.companyName}”` +
        `${company.gstin ? ` (GSTIN ${company.gstin})` : ""}` +
        `${company.booksFrom ? `, books from ${String(company.booksFrom).slice(0, 10)}` : ""}. ` +
        `${seeded} default chart-of-accounts group(s) were seeded with it.` +
        `${company.isPrimary ? " Marked as the primary company." : ""}`,
      after: companySnapshot(company),
    });

    res.status(201).json({
      success: true,
      message: "Company created and default chart-of-accounts groups seeded.",
      company,
      seededGroups: seeded,
    });
  } catch (err) {
    console.error("POST tally company:", err);
    res.status(500).json({
      success: false,
      message: err.message || "Error creating company",
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accountant/tally/companies/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id).lean();
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });
    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/accountant/tally/companies/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates._id;
    delete updates.createdAt;

    if (updates.isPrimary) {
      await Acc_Company.updateMany(
        { _id: { $ne: req.params.id }, isPrimary: true },
        { isPrimary: false },
      );
    }

    // The `address` sub-document is partial when it comes from the Settings
    // "Company GST" section (it only manages city/state/stateCode/pincode and
    // leaves line1/line2 alone). A raw findByIdAndUpdate would REPLACE the
    // whole sub-doc and wipe the other address fields, so deep-merge it onto
    // the existing record. Also auto-derive stateCode from the GSTIN when the
    // accountant left it blank, so intra/inter-state tax always resolves.
    //
    // Same problem with `contact`: the Organization tab in Settings sends
    // `{ contact: { phone, email, website } }` and another caller might send
    // `{ contact: { phone: "..." } }` alone. Without merging, the partial
    // write would clobber the unspecified fields. Deep-merge contact too.
    if (
      (updates.address && typeof updates.address === "object") ||
      (updates.contact && typeof updates.contact === "object")
    ) {
      const existing = await Acc_Company.findById(req.params.id)
        .select("address contact gstin")
        .lean();

      if (updates.address && typeof updates.address === "object") {
        const prevAddr = (existing && existing.address) || {};
        const mergedAddr = { ...prevAddr, ...updates.address };

        const gstinForDerive =
          updates.gstin != null ? updates.gstin : existing && existing.gstin;
        const resolved = gstState.resolveState({
          gstin: gstinForDerive,
          state: mergedAddr.state,
          stateCode: mergedAddr.stateCode,
        });
        if (!mergedAddr.stateCode && resolved.stateCode)
          mergedAddr.stateCode = resolved.stateCode;
        if (!mergedAddr.state && resolved.state)
          mergedAddr.state = resolved.state;

        updates.address = mergedAddr;
      }

      if (updates.contact && typeof updates.contact === "object") {
        const prevContact = (existing && existing.contact) || {};
        updates.contact = { ...prevContact, ...updates.contact };
      }
    }

    // The whole document, before the write.
    //
    // NOT the `existing` above: that one is declared inside the address/contact
    // branch (so it is out of scope here) and is a three-field projection
    // anyway, which would make every unselected field read as newly added.
    const before = await Acc_Company.findById(req.params.id).lean();

    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true },
    );
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    await auditCompany(req, {
      entityId: String(req.params.id),
      entityLabel: company.companyName,
      action: "update",
      before: companySnapshot(before),
      after: companySnapshot(company),
    });

    res.json({ success: true, company });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/accountant/tally/companies/:id (soft delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true },
    );
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    await auditCompany(req, {
      entityId: String(req.params.id),
      entityLabel: company.companyName,
      action: "delete",
      summary:
        `Deactivated company “${company.companyName}”. The books, vouchers and ` +
        `ledgers under it are kept — only the company is switched off.`,
      before: { isActive: true },
      after: { isActive: false },
    });

    res.json({ success: true, message: "Company deactivated" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/accountant/tally/companies/:id/reseed-groups
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/reseed-groups", async (req, res) => {
  try {
    const company = await Acc_Company.findById(req.params.id);
    if (!company)
      return res
        .status(404)
        .json({ success: false, message: "Company not found" });

    const existing = await Acc_Group.countDocuments({
      companyId: company._id,
      isReserved: true,
    });
    if (existing > 0 && !req.body.force) {
      return res.status(400).json({
        success: false,
        message: `${existing} reserved groups already exist. Pass force=true to reseed.`,
      });
    }

    if (req.body.force) {
      await Acc_Group.deleteMany({ companyId: company._id, isReserved: true });
    }

    const seeded = await seedDefaultGroups(company._id, req.user?.id);
    res.json({
      success: true,
      message: `Seeded ${seeded} default groups`,
      seededGroups: seeded,
    });
  } catch (err) {
    console.error("Reseed groups:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/accountant/tally/companies/:id/default-credit-days
//
// The ONLY writer of `Acc_Company.defaultCreditDays` — a dedicated, narrowly
// scoped endpoint rather than a field smuggled through the broad `PUT /:id`
// above, for the same reason the party-level credit-terms editor
// (Acc_parties.js `PATCH /:ledgerId/credit-terms`) is its own route and not
// a field on a general ledger-update endpoint: a number that will later date
// real obligations deserves its own validated, whitelisted, audited path.
//
//   - Validation reuses `creditTerms.parseCreditDays` — the exact same rule
//     C0-B's party-level editor enforces: "", null, undefined and 0 all mean
//     "cleared" (stored as `null`, never as 0 — `defaultCreditDays` has no
//     schema default to fall back to, so `null` is the only spelling of
//     "unset"); 1..365 stores that number; anything else (negative,
//     fractional, >365, boolean, object, array, non-numeric string) is
//     REJECTED, not coerced.
//   - Whitelist-only body: `defaultCreditDays` is the only accepted key. No
//     `req.body` spreading anywhere in this handler.
//   - `creditTerms.canEditTerms` gates this write — see the router-level
//     comment above for why this route is carved out of the owner-only gate.
//   - Provenance (`defaultCreditDaysUpdatedAt/By/ByName`) is written from the
//     authenticated user and the clock, never trusted from the body.
router.patch("/:id/default-credit-days", accountantAuth, async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid company id." });
    }

    const body = req.body || {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Expected an object body.", code: "INVALID_BODY" });
    }
    const unknown = Object.keys(body).filter((k) => k !== "defaultCreditDays");
    if (unknown.length > 0) {
      return res.status(400).json({
        error: `This endpoint only updates defaultCreditDays. Refused: ${unknown.join(", ")}.`,
        code: "UNSUPPORTED_FIELD",
      });
    }
    if (!Object.prototype.hasOwnProperty.call(body, "defaultCreditDays")) {
      return res.status(400).json({ error: "defaultCreditDays required.", code: "NOTHING_TO_UPDATE" });
    }

    let days;
    try {
      days = creditTerms.parseCreditDays(body.defaultCreditDays);
    } catch (e) {
      if (e instanceof creditTerms.CreditTermsError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    // Scoped by `_id` — for `Acc_Company` itself, the company IS the tenant
    // boundary, so matching `:id` exactly is the whole of "scope by company
    // id" here (there is no separate parent-company field to also check, the
    // way a ledger checks `{ _id, companyId }` together).
    const company = await Acc_Company.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          defaultCreditDays: days, // null when cleared — never 0, there is no schema default to fall back to
          defaultCreditDaysUpdatedAt: new Date(),
          defaultCreditDaysUpdatedBy: req.user?.id || null,
          defaultCreditDaysUpdatedByName: req.user?.name || req.user?.email || null,
        },
      },
      {
        new: true,
        runValidators: true,
        // Belt and braces: only these keys can reach the response, whatever
        // this handler's `$set` might grow to include later.
        fields:
          "_id companyName defaultCreditDays defaultCreditDaysUpdatedAt defaultCreditDaysUpdatedByName",
      },
    ).lean();

    if (!company) {
      return res.status(404).json({ error: "Company not found." });
    }

    res.json({
      ok: true,
      company: {
        _id: company._id,
        companyName: company.companyName,
        defaultCreditDays: company.defaultCreditDays ?? null,
        defaultCreditDaysSet: creditTerms.isTermSet(company.defaultCreditDays),
        defaultCreditDaysUpdatedAt: company.defaultCreditDaysUpdatedAt || null,
        defaultCreditDaysUpdatedByName: company.defaultCreditDaysUpdatedByName || null,
      },
    });
  } catch (e) {
    console.error("[companies/default-credit-days]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
