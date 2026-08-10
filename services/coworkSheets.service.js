// services/coworkSheets.service.js
//
// Creates and shares a CoWork "workspace sheet" from the CMS side, without
// going through the CoWork app's own UI.
//
// WHY THIS IS SAFE TO DO SERVER-SIDE
// -----------------------------------
// A CoWork sheet is NOT a special record type — it is a `cowork_documents`
// doc with kind:"sheet", plus its cell content in a matching
// `cowork_document_bodies` doc. Both are written directly from the browser
// by CoWork's own client (Cowork/lib/repositories/legacy/index.ts,
// createDocument()) with no server mediation at all — CoWork's own backend
// comment on the notify-member route puts it plainly: "there is no document
// engine here and adding one would invert the write path the whole
// migration is built on." So writing the same two documents here, with the
// Firebase Admin SDK, is not a workaround — it is the exact same operation
// CoWork's own client performs, done from a different caller.
//
// The one thing that is NOT replicated here is live collaboration (Yjs) —
// that only matters once somebody OPENS the sheet for concurrent editing,
// and only degrades to "single writer, still opens, still saves" even then
// (see CoWork's own useCollabSession.ts). Creating the two documents is
// sufficient for the sheet to exist, be listed, and be opened normally.
//
// SCHEMA — kept in exact lockstep with Cowork/lib/domain/documents.ts and
// Cowork/lib/repositories/legacy/index.ts's createDocument()/writeMembers().
// If either changes shape, this must change with it — there is no shared
// package, only convention.
"use strict";

const { db } = require("../config/firebaseAdmin");

const DOCUMENT_COLLECTION = "cowork_documents";
const DOCUMENT_BODY_COLLECTION = "cowork_document_bodies";

// Matches Cowork/lib/auth/roleMap's LEGACY_ORGANISATION_ID — CoWork has no
// real tenant concept, every record belongs to this one synthetic org.
const ORGANISATION_ID = "org-legacy-cowork";

/**
 * The member/role vocabulary a CoWork document actually accepts.
 * Cowork/lib/rules/workspace/sharing.ts's SHARE_ROLES, verbatim.
 */
const SHARE_ROLES = new Set(["owner", "editor", "viewer"]);

/**
 * `members` + the denormalised `memberIds` flat index, built together and
 * always written together — Firestore cannot query inside an array of
 * objects, so `memberIds` (array-contains queried by CoWork's own
 * `listDocuments`) is what makes "documents I'm a member of" answerable at
 * all. Mirrors Cowork/lib/rules/documents/access.ts's writeMembers().
 *
 * @param {{employeeId:string, role:string}[]} entries — creator included.
 */
function buildMembers(entries) {
  const now = new Date().toISOString();
  const seen = new Set();
  const members = [];
  for (const e of entries) {
    const employeeId = String(e.employeeId || "").trim();
    if (!employeeId || seen.has(employeeId)) continue;
    const role = SHARE_ROLES.has(e.role) ? e.role : "editor";
    seen.add(employeeId);
    members.push({ employeeId, role, addedAt: now });
  }
  return { members, memberIds: members.map((m) => m.employeeId) };
}

/**
 * Create a CoWork sheet and share it with the given employees, in one write.
 *
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.creatorEmployeeId — becomes the sheet's owner.
 * @param {{employeeId:string, name?:string, role:string}[]} [p.shareWith] —
 *   additional people, e.g. the sales person assigning it to a merchandiser.
 * @param {import("./sheetTemplates").Workbook} [p.workbook] — pre-filled
 *   cell content; omitted means a blank sheet exactly like CoWork's own
 *   "New sheet" button produces (see blankWorkbook() in grid.ts).
 * @returns {Promise<{documentId:string, members:object[]}>}
 */
async function createSheet({ title, creatorEmployeeId, shareWith = [], workbook = null }) {
  if (!creatorEmployeeId) throw new Error("createSheet requires creatorEmployeeId");

  const ref = db.collection(DOCUMENT_COLLECTION).doc();
  const now = new Date().toISOString();

  const { members, memberIds } = buildMembers([
    { employeeId: creatorEmployeeId, role: "owner" },
    ...shareWith,
  ]);

  const record = {
    organisationId: ORGANISATION_ID,
    id: ref.id,
    kind: "sheet",
    title: title || "Untitled sheet",
    createdById: creatorEmployeeId,
    lastEditedById: null,
    members,
    memberIds,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    driveFileId: null,
    driveSyncedAt: null,
  };

  await ref.set(record);
  await db.collection(DOCUMENT_BODY_COLLECTION).doc(ref.id).set({
    html: "",
    // A freshly-created sheet with no template gets `cells: null`, exactly
    // like CoWork's own createDocument() — the real client materialises
    // blankWorkbook() itself the first time it opens/saves. Only write a
    // real cells string here when a template was actually provided.
    cells: workbook ? JSON.stringify(workbook) : null,
    ydocState: null,
    updatedAt: now,
  });

  return { documentId: ref.id, members };
}

/**
 * Add/replace one-or-more members' roles on an existing sheet (or any
 * cowork_documents record), in one write — the CMS side needs to assign a
 * whole team to a sheet at once, not one round trip per person. Mirrors
 * setDocumentMember()'s member-list mutation, minus the client-side
 * memberChangeRefusal UI check — this is a server action, not a button an
 * arbitrary browser session can click, so the "can't demote the last owner"
 * rule is enforced by the caller deciding who to invite, not by re-deriving
 * it here.
 *
 * @param {string} documentId
 * @param {{employeeId:string, role:string}[]} entries
 * @returns {Promise<object[]>} the sheet's full member list after the write.
 */
async function setMembers(documentId, entries) {
  const valid = (entries || []).filter((e) => e && e.employeeId && SHARE_ROLES.has(e.role));
  if (!valid.length) throw new Error("No valid members to add.");

  const ref = db.collection(DOCUMENT_COLLECTION).doc(documentId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Sheet not found");

  const data = snap.data();
  const current = Array.isArray(data.members) ? data.members : [];
  const incomingIds = new Set(valid.map((e) => e.employeeId));
  const now = new Date().toISOString();
  const next = [
    ...current.filter((m) => !incomingIds.has(m.employeeId)),
    ...valid.map((e) => ({ employeeId: e.employeeId, role: e.role, addedAt: now })),
  ];

  await ref.update({
    members: next,
    memberIds: next.map((m) => m.employeeId),
    updatedAt: now,
  });

  return next;
}

/** Read a sheet's current record — used to render status on the CMS side. */
async function getSheet(documentId) {
  const snap = await db.collection(DOCUMENT_COLLECTION).doc(documentId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Read a sheet's actual cell content, for the CMS's read-only "showcase" view
 * — the CMS never edits a sheet, it just displays what CoWork's own
 * SheetGrid.tsx would show, so it reads the same `cells` JSON string CoWork
 * writes (see Cowork/components/features/workspace/SheetGrid.tsx's save
 * path) and leaves formula evaluation to the caller (HyperFormula, client
 * side, exactly like CoWork does — never evaluated here).
 *
 * @returns {Promise<{workbook: import("./sheetTemplates").Workbook|null, updatedAt: string|null}|null>}
 */
async function getSheetBody(documentId) {
  const snap = await db.collection(DOCUMENT_BODY_COLLECTION).doc(documentId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  let workbook = null;
  if (data.cells) {
    try {
      workbook = JSON.parse(data.cells);
    } catch {
      workbook = null;
    }
  }
  return { workbook, updatedAt: data.updatedAt || null };
}

module.exports = { createSheet, setMembers, getSheet, getSheetBody, SHARE_ROLES };
