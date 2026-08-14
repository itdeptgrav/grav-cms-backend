/**
 * GRAV-CMS-BACKEND/services/coworkAttachment.service.js
 *
 * PRIVATE attachment storage for Cowork.
 *
 * **This deliberately does not touch `services/mediaUpload.service.js`.** That
 * service is shared with four non-Cowork features — Overtime, two leave routes
 * and App Version — and it makes every upload public with
 * `drive.permissions.create({ role: "reader", type: "anyone" })`. Changing its
 * permission model to suit Cowork would silently break those four. Cowork does
 * not own it, so Cowork gets its own service and leaves it alone.
 *
 * Modelled on `voucherDriveUpload.service.js`, which is the codebase's existing
 * PRIVATE pattern: no `permissions.create` call anywhere, the Drive FILE ID is
 * what persists rather than a URL, and downloads stream back through an
 * authenticated route so the file never needs an "anyone with link" permission.
 *
 * **Bytes go through the backend**, unlike Cowork's browser-direct
 * `/upload/drive-session` path. That is the whole reason this exists: the
 * backend cannot sniff a file it never receives, and the requirement is that a
 * file's real type is established from its CONTENT rather than from what the
 * client claims. The cost is RAM and bandwidth, bounded by a 50 MB cap — task
 * attachments are references and screenshots, not media libraries.
 *
 * Reuses the same service-account credentials as the rest of the app:
 *   GOOGLE_SERVICE_ACCOUNT_KEY          ← full service-account JSON on one line
 *   GOOGLE_DRIVE_FOLDER_ID              ← optional parent (Shared Drive)
 *   GOOGLE_DRIVE_COWORK_FOLDER_ID       ← optional: pin the Cowork folder
 */

const { google } = require("googleapis");
const { Readable } = require("stream");
const { db } = require("../config/firebaseAdmin");
const admin = require("firebase-admin");

/* The security decisions live next door, dependency-free, so they can be
   tested without a credential. See `coworkAttachmentRules.js`. */
const {
  sniffMimeType,
  safeName,
  ALLOWED,
  MAX_BYTES,
  COLLECTION,
  COWORK_FOLDER_NAME,
} = require("./coworkAttachmentRules");

/**
 * A failure a caller can act on, rather than a bare message.
 *
 * "GOOGLE_SERVICE_ACCOUNT_KEY is not configured" and "you may not see this
 * file" are different problems for different people — one is an operator's, one
 * is the reader's — and a UI cannot tell them apart from prose.
 */
class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

/** Whether private storage can work at all, without attempting anything. */
function storageConfigured() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return false;
  try {
    const j = JSON.parse(raw);
    return !!(j.client_email && j.private_key);
  } catch {
    return false;
  }
}

/** The last real failure, for the health endpoint. Never shown to an end user. */
let _lastError = null;

function getServiceAccountAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new AttachmentError(
      "STORAGE_NOT_CONFIGURED",
      "Attachment storage is not configured on this server.",
    );
  }
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new AttachmentError(
      "STORAGE_NOT_CONFIGURED",
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.",
    );
  }

  /**
   * **The private key's newlines, restored.**
   *
   * The key is a PEM: real line breaks are part of its syntax. Carried inside a
   * one-line env var it is written `\n`, and `JSON.parse` turns those into real
   * newlines — provided nothing escaped them a second time on the way in. A
   * dashboard, a CI secret store or a shell that re-escapes leaves literal
   * backslash-n pairs in the string, and OpenSSL rejects the result with
   * `error:1E08010C:DECODER routines::unsupported` — which surfaces to the
   * person uploading a file as a bare 400 with nothing to act on.
   *
   * Idempotent: a correctly escaped key has already become real newlines by
   * here and contains no `\n` pairs left to replace.
   */
  if (typeof credentials.private_key === "string") {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new AttachmentError(
      "STORAGE_NOT_CONFIGURED",
      "GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email or private_key.",
    );
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

let _folderIdCache = process.env.GOOGLE_DRIVE_COWORK_FOLDER_ID || null;

async function getOrCreateFolder(drive) {
  if (_folderIdCache) return _folderIdCache;
  const parent = process.env.GOOGLE_DRIVE_FOLDER_ID;

  /*
   * **Scoped to the configured parent, and it has to be.**
   *
   * This searched by name across every drive the account can see. It found a
   * `CoWork Attachments` folder sitting in the service account's own My Drive
   * and used it as the parent — where uploads fail with "Service Accounts do
   * not have storage quota", because a service account has none. The
   * configured folder is a Shared Drive, which does.
   *
   * Drive matches `name=` case-insensitively, so a differently-cased folder
   * elsewhere was a match. Restricting the query to `'<parent>' in parents`
   * makes the drive, not the name, decide where files land.
   */
  if (!parent) {
    throw new AttachmentError(
      "STORAGE_NOT_CONFIGURED",
      "GOOGLE_DRIVE_FOLDER_ID is not set, and a service account cannot store files outside a shared drive.",
    );
  }

  try {
    const search = await drive.files.list({
      q:
        `name='${COWORK_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' ` +
        `and '${parent}' in parents and trashed=false`,
      fields: "files(id)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files?.length) {
      _folderIdCache = search.data.files[0].id;
      return _folderIdCache;
    }
  } catch (e) {
    console.warn("[cowork-attachment] folder search failed:", e.message);
  }

  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: COWORK_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parent],
    },
    fields: "id",
  });
  _folderIdCache = folder.data.id;
  return _folderIdCache;
}

/**
 * Store one file privately and record it.
 *
 * Throws rather than returning an error object, so a caller cannot forget to
 * check — every refusal here is a security decision.
 */
async function uploadAttachment({
  buffer,
  originalName,
  declaredType,
  uploadedBy,
  entityType,
  entityId,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("No file was received.");
  }
  /* No size cap — withdrawn on the owner's instruction. `MAX_BYTES` is null
     now, and the check is guarded rather than deleted so restoring a cap is a
     one-line change in `coworkAttachmentRules.js` and not a re-edit here. */
  if (MAX_BYTES !== null && buffer.length > MAX_BYTES) {
    throw new AttachmentError(
      "FILE_TOO_LARGE",
      `That file is larger than the ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit.`,
    );
  }
  if (!uploadedBy) throw new Error("An attachment needs an uploader.");
  if (!entityType || !entityId) {
    throw new Error("An attachment must belong to something.");
  }

  const mimeType = sniffMimeType(buffer, declaredType);
  if (!mimeType || !ALLOWED.has(mimeType)) {
    throw new AttachmentError(
      "UNSUPPORTED_TYPE",
      "That file type is not allowed. Accepted: PDF, Word, Excel, PowerPoint, PNG, JPG, WEBP, TXT and CSV.",
    );
  }

  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });
  const folderId = await getOrCreateFolder(drive);

  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);

  const name = safeName(originalName);
  let created;
  try {
    created = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name,
        mimeType,
        parents: folderId ? [folderId] : [],
      },
      media: { mimeType, body: readable },
      fields: "id, name, mimeType, size",
    });
  } catch (e) {
    _lastError = { at: new Date().toISOString(), message: e.message };
    throw new AttachmentError("UPLOAD_FAILED", `The file could not be stored: ${e.message}`);
  }

  // IMPORTANT: no drive.permissions.create() — the file stays PRIVATE and is
  // only ever reachable through the authenticated download route below.

  const storageFileId = created.data.id;
  const record = {
    storageFileId,
    originalName: name,
    mimeType,
    size: buffer.length,
    uploadedBy: String(uploadedBy),
    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    entityType: String(entityType),
    entityId: String(entityId),
  };
  const ref = await db.collection(COLLECTION).add(record);

  /* Deliberately no URL. The id is the handle; a URL in the response would be
     copied into some document and become a second, unguarded way in. */
  return {
    id: ref.id,
    name,
    type: mimeType,
    size: buffer.length,
  };
}

/** One attachment record, or null. */
async function getAttachment(id) {
  const snap = await db.collection(COLLECTION).doc(String(id)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/** Everything attached to one entity, oldest first. */
async function listAttachments(entityType, entityId) {
  const snap = await db
    .collection(COLLECTION)
    .where("entityType", "==", String(entityType))
    .where("entityId", "==", String(entityId))
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.uploadedAt?._seconds || 0) - (b.uploadedAt?._seconds || 0));
}

/** Stream a private file back. Returns `{ stream, meta }`. */
async function streamAttachment(storageFileId) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });
  const meta = await drive.files.get({
    fileId: storageFileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true,
  });
  const stream = await drive.files.get(
    { fileId: storageFileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );
  return { stream: stream.data, meta: meta.data };
}

/** Remove the record and the file. The record goes first: an orphaned Drive
 *  file is waste, but an orphaned RECORD is a broken link on somebody's task. */
async function deleteAttachment(id) {
  const record = await getAttachment(id);
  if (!record) return false;
  await db.collection(COLLECTION).doc(String(id)).delete();
  try {
    const auth = getServiceAccountAuth();
    const drive = google.drive({ version: "v3", auth });
    await drive.files.delete({
      fileId: record.storageFileId,
      supportsAllDrives: true,
    });
  } catch (e) {
    console.warn("[cowork-attachment] drive delete failed:", e.message);
  }
  return true;
}

/** Storage health, for an operator. Attempts a real Drive call when configured. */
async function storageHealth() {
  if (!storageConfigured()) {
    return {
      storageConfigured: false,
      driveConnected: false,
      lastError: "GOOGLE_SERVICE_ACCOUNT_KEY is missing or unparseable.",
    };
  }
  try {
    const drive = google.drive({ version: "v3", auth: getServiceAccountAuth() });
    await drive.about.get({ fields: "user" });
    return { storageConfigured: true, driveConnected: true, lastError: _lastError };
  } catch (e) {
    _lastError = { at: new Date().toISOString(), message: e.message };
    return { storageConfigured: true, driveConnected: false, lastError: e.message };
  }
}

module.exports = {
  AttachmentError,
  storageConfigured,
  storageHealth,
  uploadAttachment,
  getAttachment,
  listAttachments,
  streamAttachment,
  deleteAttachment,
  sniffMimeType,
  safeName,
  ALLOWED,
  MAX_BYTES,
  COLLECTION,
};
