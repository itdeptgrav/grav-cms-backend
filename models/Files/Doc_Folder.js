"use strict";
/**
 * models/Files/Doc_Folder.js
 * ───────────────────────────────────────────────────────────────────────────
 * ONE FOLDER IN THE COMPANY DRIVE.
 *
 * Until now the drive's tree was scaffolding in the browser: a fixed list of
 * departments rebuilt on every page load. It worked because a folder holding
 * documents could be reconstructed from those documents' `folderPath` — and
 * it failed the moment somebody made an EMPTY folder, which had nothing to be
 * reconstructed from and quietly vanished overnight. A drive whose folders
 * evaporate is not a drive.
 *
 * ── TWO REPRESENTATIONS OF THE SAME PLACE, ON PURPOSE ──────────────────────
 * `parentId` is the tree's authority — it is what makes a move one write, and
 * what makes "the children of X" a real query.
 *
 * `path` is the same location written as NAMES, INCLUDING this folder's own:
 * ["Finance", "Invoices"]. It is denormalised, and it earns that:
 *
 *   1. It is the bridge to Doc_File, which files documents by path because it
 *      predates this model and because a path survives the tree being rebuilt.
 *      Without it, listing a folder's documents would mean walking parents on
 *      every request.
 *   2. It makes a subtree addressable. Mongo cannot prefix-match an array,
 *      but it CAN match `path.0`, `path.1`, … position by position, which is
 *      exactly a prefix query — so moving a folder finds its descendants and
 *      their documents without a recursive walk and without a second key
 *      column to keep in step.
 *
 * The cost is that a move must rewrite every descendant's `path`. That is the
 * one operation where this shape is expensive, it is rare, and routes/Access/
 * files.js does it inside a transaction where the database offers one.
 *
 * ── THE ROOT IS NOT A ROW ──────────────────────────────────────────────────
 * "Company Drive" is the drive itself, not a folder inside it. A top-level
 * folder has `parentId: null`. The client draws the root; the server never
 * stores it, so it cannot be renamed, trashed, or moved into itself.
 *
 * ── `companyId` PARTITIONS BOOKS; IT DOES NOT AUTHENTICATE ─────────────────
 * Said plainly because the difference matters: the caller NAMES its own
 * company (`?companyId=`, exactly as every accountant route here does), so
 * this separates one company's filing from another's — it is not a wall
 * between two adversaries. A null company is the legacy bucket and stays
 * visible everywhere, which is what keeps documents filed before this model
 * existed from disappearing.
 *
 * Collection: doc_folders
 */

const mongoose = require("mongoose");

/* The icon vocabulary the file manager already draws. Stored rather than
   re-derived from the name, because "Finance" is a department today and a
   folder somebody renamed tomorrow, and the icon should not silently change
   colour when they do. */
const FOLDER_VARIANTS = ["generic", "finance", "sales", "store", "hr", "compliance", "budget"];

const docFolderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /* null means top level — a child of the drive itself. */
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Doc_Folder", default: null, index: true },

    /* Ancestors AND self, as names. See the note above. */
    path: { type: [String], default: [] },

    variant: { type: String, enum: FOLDER_VARIANTS, default: "generic" },

    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", default: null, index: true },

    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    ownerName: { type: String, default: "", trim: true },

    tags: { type: [String], default: [] },

    /* The UI stars folders as well as documents. Without a column here it
       would be the empty-folder bug again, one field smaller. */
    starred: { type: Boolean, default: false },

    trashed: { type: Boolean, default: false, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  },
  { timestamps: true, collection: "doc_folders" },
);

/* The listing: every live folder in one company, in one query. */
docFolderSchema.index({ companyId: 1, trashed: 1, "path.0": 1 });

/* Two folders with the same name in the same place would make `folderPath`
   ambiguous — a document filed under "Finance / Invoices" could not say WHICH
   Invoices. Partial, so the trash may hold as many same-named folders as
   somebody cares to delete. */
docFolderSchema.index(
  { companyId: 1, parentId: 1, name: 1 },
  { unique: true, partialFilterExpression: { trashed: false } },
);

/** The node shape the file manager renders. `parentId` is null for a top-level
 *  folder; the client maps that onto its own root id, which the server does
 *  not know about and should not. */
docFolderSchema.methods.toNode = function toNode() {
  return {
    id: String(this._id),
    kind: "folder",
    name: this.name,
    parentId: this.parentId ? String(this.parentId) : null,
    path: this.path,
    variant: this.variant,
    tags: this.tags || [],
    owner: this.ownerName || "—",
    starred: this.starred,
    trashed: this.trashed,
    modified: this.updatedAt,
    /* What tells the client this folder has a row behind it, and so may be
       renamed, moved and trashed on the server rather than only on screen. */
    persisted: true,
  };
};

const Doc_Folder =
  mongoose.models.Doc_Folder || mongoose.model("Doc_Folder", docFolderSchema);

module.exports = { Doc_Folder, FOLDER_VARIANTS };
