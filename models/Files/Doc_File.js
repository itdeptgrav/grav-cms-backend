"use strict";
/**
 * models/Files/Doc_File.js
 * ───────────────────────────────────────────────────────────────────────────
 * ONE DOCUMENT IN THE COMPANY DRIVE.
 *
 * The first file record in this codebase that belongs to NOTHING ELSE. Every
 * other stored file here is a sub-document of the thing it supports — a
 * letter on EmployeeDocument, an attachment on a voucher — which is right for
 * those and wrong for a drive: a drive's whole premise is that a document can
 * exist because the company keeps documents, and be pointed AT a voucher
 * later rather than being born inside one.
 *
 * ── THE BYTES ARE NEVER PUBLIC ──────────────────────────────────────────────
 * `driveFileId` is a private Google Drive object uploaded by the service
 * account, with NO permissions granted to anyone. There is deliberately no
 * `url` column: the moment a provider URL is stored, it leaks — anyone who
 * ever sees it keeps it, forever, with no gate in front. Reads go through
 * GET /api/files/:id/download, which re-checks the session on every request
 * and streams. This is the same posture routes/HrRoutes/EmployeeDocuments
 * arrived at, and for the same reason.
 *
 * ── `folderPath`, NOT A PARENT ID ───────────────────────────────────────────
 * The drive's TREE is still the frontend's in-memory mock, so there are no
 * server-side folder rows to point a parentId at. A path of names is what can
 * honestly be stored today, it survives the tree becoming real (a migration
 * reads it), and it is what a listing endpoint would group by anyway.
 *
 * Collection: doc_files
 */

const mongoose = require("mongoose");

/** What the UI draws, derived once at write time from the mime type. */
const FILE_KINDS = ["pdf", "doc", "sheet", "image", "video", "other"];

const docFileSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 260 },
    mimeType: { type: String, default: "application/octet-stream" },
    fileKind: { type: String, enum: FILE_KINDS, default: "other" },
    bytes: { type: Number, default: 0 },

    /* Only one value today. An enum rather than a boolean because the HR
       model needed a second one within a year of shipping, and widening an
       enum is cheaper than replacing a flag. */
    storage: { type: String, enum: ["drive"], default: "drive" },
    driveFileId: { type: String, default: "", index: true },

    /* Where it sits in the drive, as names: ["Finance", "Invoices"]. */
    folderPath: { type: [String], default: [] },

    /* Who filed it. `ownerName` is denormalised so a listing does not have to
       join Employee for a caption — the id stays authoritative. */
    /* Which set of books this document belongs to. Added with Doc_Folder,
       and added HERE too rather than only there: folders scoped to a company
       holding documents scoped to nobody would be a tree whose branches and
       leaves disagree about who can see them. Null is the legacy bucket — see
       the note in Doc_Folder — so nothing filed before this field existed
       goes missing. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null, index: true },

    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    ownerName: { type: String, default: "", trim: true },
    department: { type: String, default: "", trim: true },

    /* Visible in listings, refused on read. Enforced in the route, never in
       the client — see routes/Access/files.js. */
    restricted: { type: Boolean, default: false },
    sharedWith: { type: String, default: "", trim: true },

    tags: { type: [String], default: [] },

    /* Per-document, not per-person. A "starred by me" list needs a join
       table, and inventing one before anybody has asked for shared starring
       would be a schema nobody wanted. Company-wide is the honest reading of
       one boolean, and it is what the UI already draws. */
    starred: { type: Boolean, default: false },

    /* Soft delete, so Trash in the UI means the same thing on the server. */
    trashed: { type: Boolean, default: false, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  },
  { timestamps: true, collection: "doc_files" },
);

/* The two reads the app actually makes: a folder's contents, and everything a
   department filed. Both exclude trash, which is why `trashed` leads. */
docFileSchema.index({ trashed: 1, folderPath: 1, name: 1 });
docFileSchema.index({ trashed: 1, department: 1, updatedAt: -1 });

/** Mime → the kind the UI draws. One place, so a .xlsx cannot be a PDF here
 *  and a sheet three screens away. */
function kindOf(mimeType = "", fileName = "") {
  const m = String(mimeType).toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  if (m.includes("spreadsheet") || m.includes("excel") || m === "text/csv") return "sheet";
  if (m.includes("word") || m.includes("document")) return "doc";

  /* Some browsers send an empty type for a drag-and-drop; the extension is
     the only thing left to go on, and it is better than calling a PDF
     "other". */
  const ext = String(fileName).split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) return "image";
  if (["mp4", "mov", "webm"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["xlsx", "xls", "csv"].includes(ext)) return "sheet";
  if (["doc", "docx"].includes(ext)) return "doc";
  return "other";
}

/* ── WHAT THE VIEWER CAN ACTUALLY RENDER ───────────────────────────────────
 * `fileKind` answers "which icon"; this answers "which viewer", and they are
 * not the same question. A .tiff is an image by every reasonable definition
 * and no browser will draw it in an <img>; a .docx is a "doc" and there is
 * nothing to render it with. Conflating the two is how a viewer ends up
 * showing a broken-image glyph and calling it a preview.
 *
 * So this is an ALLOWLIST of what a browser genuinely renders, and everything
 * else is "unsupported" — which is a real answer the UI can present well,
 * not a failure.
 */
const BROWSER_IMAGES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  /* Safe in an <img>, where scripts inside it never run. It is NOT safe served
     inline in a tab, which is why the download route refuses to do that —
     see the disposition note in routes/Access/files.js. */
  "image/svg+xml",
]);

/* Spreadsheets, rendered as an in-app grid rather than framed. CSV lives here
   rather than with the text formats: it is a table, people read it as a
   table, and giving it its own renderer meant two grids to keep in step. The
   text path still owns .txt/.md/.json, where the raw characters ARE the
   content. */
const SHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12", // .xlsm
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "text/csv",
  "application/csv",
]);

/* Read as text and escaped by React. `text/html` belongs here for the same
   reason: shown as source it is harmless, and the alternative is calling a
   file the browser could display "unsupported". */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/tab-separated-values",
  "text/html",
  "text/xml",
  "application/xml",
  "application/json",
  "application/x-ndjson",
  "text/yaml",
  "application/yaml",
]);

/** image | pdf | sheet | text | unsupported — the viewer's mode, server-side. */
function previewKindOf(mimeType = "", fileName = "") {
  const m = String(mimeType).toLowerCase().split(";")[0].trim();
  if (BROWSER_IMAGES.has(m)) return "image";
  if (m === "application/pdf") return "pdf";
  /* Before the text check, because a .csv answers to both and the grid is
     the better answer. */
  if (SHEET_MIMES.has(m)) return "sheet";
  if (TEXT_MIMES.has(m)) return "text";

  /* Only when the type tells us nothing. A file that DID declare its type and
     is not on either list above is genuinely unsupported, and letting the
     extension overrule it is how an image/tiff named ".png" reaches an <img>
     and draws a broken glyph. */
  const generic = !m || m === "application/octet-stream" || m === "binary/octet-stream";
  if (!generic) return "unsupported";

  const ext = String(fileName).split(".").pop().toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["xlsx", "xls", "xlsm", "csv"].includes(ext)) return "sheet";
  if (["txt", "tsv", "md", "json", "xml", "yml", "yaml", "log"].includes(ext)) return "text";
  return "unsupported";
}

/** The shape /files' frontend store consumes. `storage` is what switches the
 *  viewer's preview chain from "session blob only" to "ask the server". */
docFileSchema.methods.toNode = function toNode() {
  return {
    id: String(this._id),
    kind: "file",
    name: this.name,
    fileKind: this.fileKind,
    size: this.bytes,
    mimeType: this.mimeType,
    storage: this.storage,
    folderPath: this.folderPath,
    owner: this.ownerName || "—",
    department: this.department || "",
    companyId: this.companyId ? String(this.companyId) : null,
    restricted: this.restricted,
    starred: this.starred,
    sharedWith: this.sharedWith || null,
    tags: this.tags || [],
    trashed: this.trashed,
    modified: this.updatedAt,
    activity: [{ when: this.createdAt, who: this.ownerName || "—", what: "Uploaded" }],
  };
};

const Doc_File = mongoose.models.Doc_File || mongoose.model("Doc_File", docFileSchema);

module.exports = { Doc_File, kindOf, previewKindOf, FILE_KINDS };
