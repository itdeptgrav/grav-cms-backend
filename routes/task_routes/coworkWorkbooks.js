/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkWorkbooks.js
 *
 * Cowork spreadsheets — list, open, create, save, rename, share, delete.
 *
 * ## Why this route exists at all
 *
 * Spreadsheets used to be the one workspace surface that did NOT come here.
 * Mindmaps and documents write through this engine to Firestore; workbooks were
 * written by the Cowork app's own Next.js routes into a JSON file on that
 * server's disk (`Cowork/lib/server/workbookStore.ts`, `FileWorkbookStore`).
 * The Cowork app deploys to Vercel, whose filesystem is ephemeral: every deploy
 * and every cold start began with an empty file. A sheet somebody built on
 * Monday was gone by the next release, and the app reported "Saved" the whole
 * time. This route is the fix — the same database, the same identity, the same
 * membership shape the other two surfaces already use.
 *
 * ## Where it is stored, and why in pieces
 *
 * A Firestore document holds at most 1,048,487 bytes. A workbook is the one
 * workspace object that routinely exceeds that — a few thousand rows of text is
 * enough — so it is stored as several documents, keyed so that one read of the
 * record names every other piece and they can be fetched in a single `getAll`:
 *
 *   cowork_workbooks/{id}                       the record: title, members,
 *                                               revision, timestamps, and the
 *                                               shape + hashes of every part
 *   cowork_workbook_parts/{id}__styles          the shared style table
 *   cowork_workbook_parts/{id}__sheet__{sid}    one sheet, minus its cells
 *   cowork_workbook_parts/{id}__cells__{sid}__{k}
 *                                               the k-th chunk of that sheet's
 *                                               cells, byte-budgeted
 *
 * ## Why only changed parts are written
 *
 * Autosave sends the whole workbook a second after every burst of typing. If
 * every save rewrote every part, one edited cell in a 40-sheet workbook would
 * cost forty-odd document writes, on every keystroke pause, for every editor.
 * So the record carries a content hash per part, the save computes the new
 * hashes, and only parts whose hash moved are written. Editing one cell costs
 * the record, that sheet, and that chunk: three writes.
 *
 * Chunking is deterministic — cells are sorted by row then column before they
 * are split — so an unchanged sheet produces byte-identical chunks and hashes on
 * every save, which is what makes the comparison mean anything.
 *
 * ## Concurrency
 *
 * `revision` is the optimistic-concurrency token the Cowork client already
 * speaks: a save carries the revision it loaded, and is refused with 409 and the
 * current revision if the stored one has moved on. The check and every write
 * happen inside one transaction, so a losing save leaves no half-written parts
 * behind for the winner's readers to find.
 *
 * ## Membership, and what a stranger is told
 *
 * A workbook you cannot reach answers 404, never 403 — the same rule as
 * mindmaps. A 403 on an id confirms the id exists.
 */

const express = require("express");
const crypto = require("crypto");
const { db, admin } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

const router = express.Router();

const BOOKS = "cowork_workbooks";
const PARTS = "cowork_workbook_parts";
/* Named checkpoints of a workbook: a copy of its parts under the version's
   own ids, and a record naming who made it and when. Restoring writes the
   copy back as a new revision, so nothing is ever overwritten in place. */
const VERSIONS = "cowork_workbook_versions";
const VERSION_PARTS = "cowork_workbook_version_parts";
const MAX_VERSIONS = 30;

/** Matches `LEGACY_ORGANISATION_ID` in the Cowork client. See coworkMindmaps.js. */
const ORGANISATION_ID = "org-legacy-cowork";

/* ── Limits ────────────────────────────────────────────────────────────────── */

const MAX_TITLE = 200;
const MAX_SHEETS = 200;
/**
 * Bytes of serialised cells per chunk document. Well under the 1MB ceiling so
 * that field names, the hash, and Firestore's own overhead never tip one over,
 * and small enough that a single edited chunk is a modest write.
 */
const CHUNK_BYTES = 480_000;
/** A hard cap on cells per chunk regardless of bytes, for read parallelism. */
const CHUNK_CELLS = 6000;
/**
 * Parts per workbook. A transaction is one request, and this keeps the largest
 * possible save comfortably inside Firestore's per-request size limit while
 * still allowing a workbook of several million cells.
 */
const MAX_PARTS = 450;
/** A single sheet's non-cell metadata (merges, validations, comments…). */
const MAX_SHEET_META_BYTES = 900_000;
const MAX_STYLES_BYTES = 900_000;

const ROLES = new Set(["viewer", "commenter", "editor"]);

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
const clamp = (v, max) => str(v).slice(0, max);
const now = () => new Date().toISOString();
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Ids match what the Cowork client generated before, so nothing downstream
    has to learn a new shape. */
const newId = () => `wb-${crypto.randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
const ID_SHAPE = /^wb-[a-z0-9]+$/i;

const partId = {
  styles: (id) => `${id}__styles`,
  sheet: (id, sid) => `${id}__sheet__${sid}`,
  cells: (id, sid, k) => `${id}__cells__${sid}__${k}`,
};

/**
 * A stored record, in the shape the Cowork client's `WorkbookSummary` expects.
 *
 * `shares` is stripped for anyone but the owner by the caller — a person a
 * workbook was shared with does not learn who else holds it.
 */
function readRecord(id, raw) {
  const shares = Array.isArray(raw.shares)
    ? raw.shares
        .filter((s) => s && typeof s.principalId === "string" && ROLES.has(s.role))
        .map((s) => ({ principalId: s.principalId, role: s.role }))
    : [];
  const ownerId = str(raw.ownerId);
  const createdAt = str(raw.createdAt);
  return {
    organisationId: str(raw.organisationId, ORGANISATION_ID),
    id,
    title: str(raw.title).trim() || "Untitled workbook",
    ownerId,
    shares,
    memberIds: [...new Set([ownerId, ...shares.map((s) => s.principalId)].filter(Boolean))],
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
    deletedAt: typeof raw.deletedAt === "string" ? raw.deletedAt : null,
    /* The shape of the stored parts — what a load has to fetch. */
    layout: raw.layout && typeof raw.layout === "object" ? raw.layout : null,
  };
}

function standingOn(record, employeeId) {
  const me = String(employeeId);
  if (record.ownerId === me) return "owner";
  const grant = record.shares.find((s) => s.principalId === me);
  return grant ? grant.role : null;
}

const canWrite = (access) => access === "owner" || access === "editor";

/** The record, if this person may see it; null for "no such" AND "not yours". */
async function readableRecord(id, employeeId) {
  if (!ID_SHAPE.test(String(id))) return null;
  const snap = await db.collection(BOOKS).doc(String(id)).get();
  if (!snap.exists) return null;
  const record = readRecord(snap.id, snap.data() || {});
  if (record.deletedAt) return null;
  const access = standingOn(record, employeeId);
  if (!access) return null;
  return { record, access };
}

function summaryFor(record, access) {
  const out = {
    id: record.id,
    title: record.title,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ownerId: record.ownerId,
    access,
  };
  if (access === "owner") out.shares = record.shares;
  return out;
}

/* ── Validating what was sent ──────────────────────────────────────────────── */

/**
 * A minimal shape check on the serialised workbook — the same the Cowork
 * routes made. The engine does not interpret cells; it stores them.
 */
function isSerializedWorkbook(v) {
  return (
    v &&
    typeof v === "object" &&
    Array.isArray(v.sheets) &&
    Array.isArray(v.styles) &&
    typeof v.activeSheetId === "string"
  );
}

/** `"AB12"` → `[12, 28]`, for a deterministic sort. Unparseable refs sort last. */
function rowCol(ref) {
  const m = /^([A-Z]+)(\d+)$/i.exec(String(ref || ""));
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]), col];
}

/**
 * Split one sheet's cells into byte-budgeted chunks, deterministically.
 *
 * Returns `{ chunks, hashes }` or `{ error }`. Sorting first is what makes the
 * output a function of the content alone — the client emits cells in object
 * key order, which an edit can reorder without changing a single value.
 */
function chunkCells(cells) {
  const sorted = cells
    .filter((c) => c && typeof c.ref === "string")
    .map((c) => {
      const out = { ref: c.ref };
      if (typeof c.value === "string" && c.value !== "") out.value = c.value;
      if (Number.isFinite(c.style) && c.style !== 0) out.style = Number(c.style);
      return out;
    })
    .sort((a, b) => {
      const [ra, ca] = rowCol(a.ref);
      const [rb, cb] = rowCol(b.ref);
      return ra - rb || ca - cb || a.ref.localeCompare(b.ref);
    });

  const chunks = [];
  let current = [];
  let currentBytes = 2; // the brackets
  for (const cell of sorted) {
    const size = bytesOf(cell) + 1;
    if (size > CHUNK_BYTES)
      return {
        error: `The cell ${cell.ref} holds more than ${Math.round(CHUNK_BYTES / 1024)}KB of text and cannot be stored.`,
      };
    if (current.length && (currentBytes + size > CHUNK_BYTES || current.length >= CHUNK_CELLS)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(cell);
    currentBytes += size;
  }
  if (current.length || chunks.length === 0) chunks.push(current);

  return { chunks, hashes: chunks.map((c) => sha1(JSON.stringify(c))) };
}

/**
 * Take a serialised workbook apart into the documents it will be stored as.
 *
 * Returns `{ layout, parts }` or `{ error }`:
 *  · `layout` is what the record keeps — enough to name every part on a load
 *    and to compare hashes on the next save.
 *  · `parts` is a Map of part id → document body, ready to write.
 */
function explode(id, data) {
  if (!isSerializedWorkbook(data)) return { error: "Missing or invalid workbook data." };
  if (data.sheets.length === 0) return { error: "A workbook needs at least one sheet." };
  if (data.sheets.length > MAX_SHEETS)
    return { error: `A workbook can hold ${MAX_SHEETS} sheets. This one has ${data.sheets.length}.` };

  const parts = new Map();

  /* Named ranges ride in the styles part: both are small, workbook-wide and
     change rarely, so one part (and one hash) covers them. */
  const names = Array.isArray(data.names) ? data.names.slice(0, 500) : [];
  const pivots = Array.isArray(data.pivots) ? data.pivots.slice(0, 100) : [];
  const stylesBody = { styles: data.styles, ...(names.length ? { names } : {}), ...(pivots.length ? { pivots } : {}) };
  if (bytesOf(stylesBody) > MAX_STYLES_BYTES)
    return { error: "This workbook's style table is too large to store." };
  const stylesHash = sha1(JSON.stringify(stylesBody));
  parts.set(partId.styles(id), { ...stylesBody, hash: stylesHash });

  const sheets = [];
  const seen = new Set();
  for (const sheet of data.sheets) {
    if (!sheet || typeof sheet !== "object" || typeof sheet.id !== "string" || !sheet.id)
      return { error: "Every sheet needs an id." };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sheet.id))
      return { error: `The sheet id "${sheet.id}" is not one that can be stored.` };
    if (seen.has(sheet.id)) return { error: `Two sheets share the id "${sheet.id}".` };
    seen.add(sheet.id);

    const { cells = [], ...meta } = sheet;
    if (!Array.isArray(cells)) return { error: `The sheet "${sheet.name || sheet.id}" has unreadable cells.` };

    if (bytesOf(meta) > MAX_SHEET_META_BYTES)
      return {
        error: `The sheet "${sheet.name || sheet.id}" carries too much formatting, validation or comment data to store.`,
      };

    const split = chunkCells(cells);
    if (split.error) return { error: split.error };

    const metaHash = sha1(JSON.stringify(meta));
    parts.set(partId.sheet(id, sheet.id), { sheet: meta, hash: metaHash });
    split.chunks.forEach((chunk, k) => {
      parts.set(partId.cells(id, sheet.id, k), { cells: chunk, hash: split.hashes[k] });
    });

    sheets.push({
      id: sheet.id,
      metaHash,
      chunkHashes: split.hashes,
    });
  }

  if (parts.size > MAX_PARTS)
    return {
      error:
        "This workbook is too large to store in one piece. Split it into more than one workbook, or remove sheets that are no longer needed.",
    };

  return {
    layout: {
      version: 1,
      activeSheetId: str(data.activeSheetId),
      stylesHash,
      sheets,
    },
    parts,
  };
}

/** Every part id a stored layout names. */
function partIdsOf(id, layout) {
  const ids = [];
  if (!layout) return ids;
  ids.push(partId.styles(id));
  for (const s of layout.sheets || []) {
    ids.push(partId.sheet(id, s.id));
    (s.chunkHashes || []).forEach((_, k) => ids.push(partId.cells(id, s.id, k)));
  }
  return ids;
}

/** The hash a stored layout holds for a part id, or null. */
function storedHashes(id, layout) {
  const map = new Map();
  if (!layout) return map;
  map.set(partId.styles(id), layout.stylesHash);
  for (const s of layout.sheets || []) {
    map.set(partId.sheet(id, s.id), s.metaHash);
    (s.chunkHashes || []).forEach((h, k) => map.set(partId.cells(id, s.id, k), h));
  }
  return map;
}

/**
 * Reassemble a workbook from its parts.
 *
 * One `getAll` for everything — Firestore fetches the batch in a single round
 * trip. A missing part is an error rather than an empty sheet: showing a blank
 * sheet over one that has data, and then saving it, is how data gets lost
 * twice.
 */
async function assemble(id, layout, refOf) {
  const ids = partIdsOf(id, layout);
  if (ids.length === 0) return { error: "This workbook has no stored content." };
  const refs = ids.map((p) => (refOf ? refOf(p) : db.collection(PARTS).doc(p)));
  const snaps = await db.getAll(...refs);
  /* Keyed by the PART id, whichever collection the document came from. */
  const byId = new Map(snaps.map((s, i) => [ids[i], s.exists ? s.data() : null]));

  const stylesDoc = byId.get(partId.styles(id));
  if (!stylesDoc) return { error: "This workbook's style table is missing." };

  const sheets = [];
  for (const s of layout.sheets || []) {
    const meta = byId.get(partId.sheet(id, s.id));
    if (!meta || !meta.sheet) return { error: `The sheet "${s.id}" is missing from storage.` };
    const cells = [];
    for (let k = 0; k < (s.chunkHashes || []).length; k++) {
      const chunk = byId.get(partId.cells(id, s.id, k));
      if (!chunk || !Array.isArray(chunk.cells))
        return { error: `Part of the sheet "${meta.sheet.name || s.id}" is missing from storage.` };
      for (const c of chunk.cells) cells.push(c);
    }
    sheets.push({ ...meta.sheet, id: s.id, cells });
  }

  return {
    data: {
      version: 1,
      activeSheetId: layout.activeSheetId || (sheets[0] && sheets[0].id) || "",
      styles: Array.isArray(stylesDoc.styles) ? stylesDoc.styles : [],
      sheets,
      ...(Array.isArray(stylesDoc.names) && stylesDoc.names.length ? { names: stylesDoc.names } : {}),
      ...(Array.isArray(stylesDoc.pivots) && stylesDoc.pivots.length ? { pivots: stylesDoc.pivots } : {}),
    },
  };
}

/**
 * Write a workbook's parts and record inside one transaction, touching only
 * what changed.
 *
 * `expectRevision` is null on create. On save it must equal the stored
 * revision or the transaction throws a conflict carrying the current one.
 */
class Conflict extends Error {
  constructor(currentRevision) {
    super("The workbook was changed elsewhere.");
    this.currentRevision = currentRevision;
  }
}

async function commitWorkbook({ id, exploded, recordPatch, expectRevision }) {
  const bookRef = db.collection(BOOKS).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(bookRef);
    const existing = snap.exists ? readRecord(snap.id, snap.data() || {}) : null;

    if (expectRevision !== null) {
      if (!existing || existing.deletedAt) return { gone: true };
      if (existing.revision !== expectRevision) throw new Conflict(existing.revision);
    }

    const before = storedHashes(id, existing ? existing.layout : null);
    let written = 0;
    for (const [pid, body] of exploded.parts) {
      if (before.get(pid) === body.hash) continue;
      tx.set(db.collection(PARTS).doc(pid), { ...body, workbookId: id, updatedAt: now() });
      written += 1;
    }
    /* Parts the new layout no longer names — a deleted sheet, a sheet that
       shrank to fewer chunks. Removed rather than orphaned, so storage does not
       grow with every sheet somebody ever deleted. */
    for (const pid of before.keys()) {
      if (!exploded.parts.has(pid)) tx.delete(db.collection(PARTS).doc(pid));
    }

    const stamp = now();
    const revision = existing ? existing.revision + 1 : 1;
    const record = {
      organisationId: ORGANISATION_ID,
      ...(existing
        ? {
            title: existing.title,
            ownerId: existing.ownerId,
            shares: existing.shares,
            memberIds: existing.memberIds,
            createdAt: existing.createdAt,
            deletedAt: null,
          }
        : {}),
      ...recordPatch,
      layout: exploded.layout,
      revision,
      updatedAt: stamp,
    };
    if (!existing) record.createdAt = stamp;
    tx.set(bookRef, record, { merge: false });
    return { revision, updatedAt: stamp, written };
  });
}

/* ── Routes ─────────────────────────────────────────────────────────────────
 *
 * Mounted under `/cowork`, so these are `/cowork/workbooks…`. Every one is
 * authenticated; there is no public read.
 */

/** The list: records only, never content. */
router.get("/workbooks", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const me = String(req.coworkUser.employeeId);
    const snap = await db.collection(BOOKS).where("memberIds", "array-contains", me).get();
    const workbooks = snap.docs
      .map((d) => readRecord(d.id, d.data() || {}))
      .filter((r) => !r.deletedAt)
      .map((r) => summaryFor(r, standingOn(r, me)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ workbooks });
  } catch (err) {
    res.status(500).json({ error: "Could not list workbooks: " + err.message });
  }
});

/** Create one. The creator owns it. */
router.post("/workbooks", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const me = String(req.coworkUser.employeeId);
    const title = clamp(req.body && req.body.title, MAX_TITLE).trim() || "Untitled workbook";
    const id = newId();
    const exploded = explode(id, req.body && req.body.data);
    if (exploded.error) return res.status(400).json({ error: exploded.error });

    const result = await commitWorkbook({
      id,
      exploded,
      expectRevision: null,
      recordPatch: { title, ownerId: me, shares: [], memberIds: [me], deletedAt: null },
    });
    res.status(201).json({ id, title, revision: result.revision, updatedAt: result.updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Could not create workbook: " + err.message });
  }
});

/** One workbook, reassembled. The only read that touches content. */
router.get("/workbooks/:id", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    const { record, access } = found;
    const built = await assemble(record.id, record.layout);
    if (built.error) return res.status(500).json({ error: built.error });
    res.json({
      id: record.id,
      title: record.title,
      revision: record.revision,
      access,
      data: built.data,
    });
  } catch (err) {
    res.status(500).json({ error: "Could not open workbook: " + err.message });
  }
});

/** Save content. Editors and the owner. */
router.put("/workbooks/:id", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (!canWrite(found.access))
      return res.status(403).json({ error: "You have read-only access to this workbook." });

    const exploded = explode(found.record.id, req.body && req.body.data);
    if (exploded.error) return res.status(400).json({ error: exploded.error });

    const baseRevision = Number.isFinite(req.body && req.body.baseRevision)
      ? Number(req.body.baseRevision)
      : found.record.revision;

    const result = await commitWorkbook({
      id: found.record.id,
      exploded,
      expectRevision: baseRevision,
      recordPatch: { lastEditedById: String(req.coworkUser.employeeId) },
    });
    if (result.gone) return res.status(404).json({ error: "Workbook not found." });
    res.json({ revision: result.revision, updatedAt: result.updatedAt, partsWritten: result.written });
  } catch (err) {
    if (err instanceof Conflict)
      return res
        .status(409)
        .json({ error: "The workbook was changed elsewhere.", currentRevision: err.currentRevision });
    res.status(500).json({ error: "Could not save workbook: " + err.message });
  }
});

/** Rename. Editors and the owner — the title is how everybody finds it. */
router.patch("/workbooks/:id", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (!canWrite(found.access))
      return res.status(403).json({ error: "You have read-only access to this workbook." });
    const title = clamp(req.body && req.body.title, MAX_TITLE).trim();
    if (!title) return res.status(400).json({ error: "A title is required." });
    const updatedAt = now();
    await db.collection(BOOKS).doc(found.record.id).update({ title, updatedAt });
    res.json({ title, updatedAt });
  } catch (err) {
    res.status(500).json({ error: "Could not rename workbook: " + err.message });
  }
});

/**
 * Delete. Owner only.
 *
 * A soft delete on the record, and the parts removed outright: the record is
 * what a list reads and what a restore would need; the parts are the bulk and
 * are what storage bills for.
 */
router.delete("/workbooks/:id", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (found.access !== "owner")
      return res.status(403).json({ error: "Only the workbook's owner can delete it." });

    const ids = partIdsOf(found.record.id, found.record.layout);
    /* Batched in slices, because a workbook can hold up to MAX_PARTS parts. */
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      ids.slice(i, i + 400).forEach((pid) => batch.delete(db.collection(PARTS).doc(pid)));
      await batch.commit();
    }
    await db
      .collection(BOOKS)
      .doc(found.record.id)
      .update({ deletedAt: now(), updatedAt: now(), layout: null, memberIds: [] });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: "Could not delete workbook: " + err.message });
  }
});

/** Who it is shared with. Owner only. */
/* ── Version history ─────────────────────────────────────────────────────── */

function versionPartRef(versionId, partIdValue) {
  return db.collection(VERSION_PARTS).doc(`${versionId}__${partIdValue}`);
}

function readVersion(id, raw) {
  return {
    id,
    label: typeof raw.label === "string" ? raw.label : "",
    revision: Number.isFinite(raw.revision) ? Number(raw.revision) : 0,
    createdAt: str(raw.createdAt),
    createdById: str(raw.createdById),
    createdByName: str(raw.createdByName),
    auto: raw.auto === true,
  };
}

/** Every version of a workbook, newest first. Anyone who can read it may look. */
router.get("/workbooks/:id/versions", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    const snap = await db.collection(VERSIONS).where("workbookId", "==", found.record.id).get();
    const versions = snap.docs
      .map((d) => readVersion(d.id, d.data() || {}))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, MAX_VERSIONS);
    res.json({ versions });
  } catch (err) {
    res.status(500).json({ error: "Could not list versions: " + err.message });
  }
});

/**
 * Save the workbook as it is stored now under a name. The parts are copied
 * rather than referenced, because the live parts are overwritten on every
 * save. Beyond MAX_VERSIONS the oldest is removed with its parts.
 */
router.post("/workbooks/:id/versions", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (!canWrite(found.access)) return res.status(403).json({ error: "You have read-only access to this workbook." });
    const { record } = found;
    if (!record.layout) return res.status(400).json({ error: "This workbook has nothing stored to keep yet." });

    const label = String((req.body && req.body.label) || "").trim().slice(0, 80);
    const auto = !!(req.body && req.body.auto);
    const ids = partIdsOf(record.id, record.layout);
    const snaps = await db.getAll(...ids.map((p) => db.collection(PARTS).doc(p)));
    const versionRef = db.collection(VERSIONS).doc();
    const stamp = now();
    const batch = db.batch();
    snaps.forEach((s, i) => {
      if (!s.exists) return;
      batch.set(versionPartRef(versionRef.id, ids[i]), { ...s.data(), versionId: versionRef.id, workbookId: record.id });
    });
    batch.set(versionRef, {
      workbookId: record.id,
      organisationId: ORGANISATION_ID,
      label: label || (auto ? "Automatic" : "Version"),
      auto,
      revision: record.revision,
      layout: record.layout,
      createdAt: stamp,
      createdById: String(req.coworkUser.employeeId),
      createdByName: String(req.coworkUser.name || ""),
    });
    await batch.commit();

    /* Trim the oldest beyond the cap, parts and all. */
    const all = await db.collection(VERSIONS).where("workbookId", "==", record.id).get();
    const ordered = all.docs.map((d) => ({ id: d.id, createdAt: str((d.data() || {}).createdAt), layout: (d.data() || {}).layout }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const extra = ordered.slice(MAX_VERSIONS);
    for (const v of extra) {
      const trim = db.batch();
      for (const p of partIdsOf(record.id, v.layout)) trim.delete(versionPartRef(v.id, p));
      trim.delete(db.collection(VERSIONS).doc(v.id));
      await trim.commit();
    }

    res.json({ version: readVersion(versionRef.id, { label: label || (auto ? "Automatic" : "Version"), auto, revision: record.revision, createdAt: stamp, createdById: String(req.coworkUser.employeeId), createdByName: String(req.coworkUser.name || "") }) });
  } catch (err) {
    res.status(500).json({ error: "Could not save a version: " + err.message });
  }
});

/** The content of one version — what a preview or a restore reads. */
router.get("/workbooks/:id/versions/:vid", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    const vs = await db.collection(VERSIONS).doc(req.params.vid).get();
    const v = vs.exists ? vs.data() : null;
    if (!v || v.workbookId !== found.record.id) return res.status(404).json({ error: "Version not found." });
    const assembled = await assemble(found.record.id, v.layout, (p) => versionPartRef(vs.id, p));
    if (assembled.error) return res.status(500).json({ error: assembled.error });
    res.json({ version: readVersion(vs.id, v), data: assembled.data });
  } catch (err) {
    res.status(500).json({ error: "Could not read the version: " + err.message });
  }
});

/**
 * Restore: the version's content becomes the workbook's NEXT revision. The
 * state being replaced is kept first as its own version, so a restore is
 * never a way to lose what was there.
 */
router.post("/workbooks/:id/versions/:vid/restore", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (!canWrite(found.access)) return res.status(403).json({ error: "You have read-only access to this workbook." });
    const vs = await db.collection(VERSIONS).doc(req.params.vid).get();
    const v = vs.exists ? vs.data() : null;
    if (!v || v.workbookId !== found.record.id) return res.status(404).json({ error: "Version not found." });
    const assembled = await assemble(found.record.id, v.layout, (p) => versionPartRef(vs.id, p));
    if (assembled.error) return res.status(500).json({ error: assembled.error });

    /* Keep what is being replaced. */
    if (found.record.layout) {
      const ids = partIdsOf(found.record.id, found.record.layout);
      const snaps = await db.getAll(...ids.map((p) => db.collection(PARTS).doc(p)));
      const keepRef = db.collection(VERSIONS).doc();
      const batch = db.batch();
      snaps.forEach((s, i) => {
        if (s.exists) batch.set(versionPartRef(keepRef.id, ids[i]), { ...s.data(), versionId: keepRef.id, workbookId: found.record.id });
      });
      batch.set(keepRef, {
        workbookId: found.record.id,
        organisationId: ORGANISATION_ID,
        label: "Before restore",
        auto: true,
        revision: found.record.revision,
        layout: found.record.layout,
        createdAt: now(),
        createdById: String(req.coworkUser.employeeId),
        createdByName: String(req.coworkUser.name || ""),
      });
      await batch.commit();
    }

    const exploded = explode(found.record.id, assembled.data);
    if (exploded.error) return res.status(400).json({ error: exploded.error });
    const result = await commitWorkbook({
      id: found.record.id,
      exploded,
      expectRevision: found.record.revision,
      recordPatch: { lastEditedById: String(req.coworkUser.employeeId) },
    });
    if (result.gone) return res.status(404).json({ error: "Workbook not found." });
    res.json({ revision: result.revision, data: assembled.data });
  } catch (err) {
    if (err instanceof Conflict) return res.status(409).json({ error: "The workbook was changed elsewhere.", currentRevision: err.currentRevision });
    res.status(500).json({ error: "Could not restore the version: " + err.message });
  }
});

router.delete("/workbooks/:id/versions/:vid", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (!canWrite(found.access)) return res.status(403).json({ error: "You have read-only access to this workbook." });
    const vs = await db.collection(VERSIONS).doc(req.params.vid).get();
    const v = vs.exists ? vs.data() : null;
    if (!v || v.workbookId !== found.record.id) return res.status(404).json({ error: "Version not found." });
    const batch = db.batch();
    for (const p of partIdsOf(found.record.id, v.layout)) batch.delete(versionPartRef(vs.id, p));
    batch.delete(vs.ref);
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Could not delete the version: " + err.message });
  }
});

router.get("/workbooks/:id/shares", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (found.access !== "owner")
      return res.status(403).json({ error: "Only the workbook's owner can see who it is shared with." });
    res.json({ shares: found.record.shares });
  } catch (err) {
    res.status(500).json({ error: "Could not read shares: " + err.message });
  }
});

/** Replace the share list. Owner only; the owner is never listed. */
router.put("/workbooks/:id/shares", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
  try {
    const found = await readableRecord(req.params.id, req.coworkUser.employeeId);
    if (!found) return res.status(404).json({ error: "Workbook not found." });
    if (found.access !== "owner")
      return res.status(403).json({ error: "Only the workbook's owner can change who it is shared with." });

    const input = Array.isArray(req.body && req.body.shares) ? req.body.shares : [];
    const byPrincipal = new Map();
    for (const g of input) {
      if (!g || typeof g.principalId !== "string" || !g.principalId) continue;
      if (g.principalId === found.record.ownerId) continue;
      /* Own-property check, so "constructor" and friends cannot pass as roles. */
      if (!ROLES.has(g.role)) continue;
      byPrincipal.set(g.principalId, { principalId: g.principalId, role: g.role });
    }
    const shares = [...byPrincipal.values()];
    const memberIds = [...new Set([found.record.ownerId, ...shares.map((s) => s.principalId)])];
    await db
      .collection(BOOKS)
      .doc(found.record.id)
      .update({ shares, memberIds, updatedAt: now() });
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ error: "Could not update shares: " + err.message });
  }
});

module.exports = router;
/* Exported for tests: the storage arithmetic is where a bug would lose data. */
module.exports._internals = { chunkCells, explode, partIdsOf, storedHashes, rowCol };
