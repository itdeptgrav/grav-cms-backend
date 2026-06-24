/**
 * GRAV-CMS-BACKEND/services/voucherDriveUpload.service.js
 *
 * PRIVATE Google Drive storage for accountant voucher attachments
 * (purchase + payment bill photos / PDFs).
 *
 * This is a SEPARATE, self-contained service — it deliberately does NOT touch
 * services/mediaUpload.service.js (which is shared with the CoWork module and
 * makes its uploads PUBLIC). Files uploaded here are kept PRIVATE: there is no
 * drive.permissions.create({ type: "anyone" }) call. Downloads are streamed
 * back through our own authenticated backend route, so the Drive file never
 * needs an "anyone with link" permission.
 *
 * Reuses the same service-account credentials as the rest of the app:
 *   GOOGLE_SERVICE_ACCOUNT_KEY        ← full service-account JSON on one line
 *   GOOGLE_DRIVE_FOLDER_ID            ← optional parent folder (Shared Drive)
 *   GOOGLE_DRIVE_VOUCHER_FOLDER_ID    ← optional: pin a specific folder for
 *                                       voucher attachments (skips name search)
 *
 * NOTE ON STORAGE: the returned `fileUrl` carries the Drive FILE ID (not a web
 * URL). The voucher schema's `attachments[].fileUrl` field is what persists,
 * and the download route looks the file up by that id. This lets us store and
 * fetch private files without adding any new field to the voucher model.
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Service Account auth (never expires) ─────────────────────────────────────
function getServiceAccountAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env");

  let key;
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message,
    );
  }

  // dotenv stores the private key with literal "\n"; convert to real newlines.
  if (key.private_key) {
    key.private_key = key.private_key.replace(/\\n/g, "\n");
  }

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

// ── Folder resolution ────────────────────────────────────────────────────────
const VOUCHER_FOLDER_NAME = "Voucher Attachments";
let _voucherFolderIdCache = null;

// Find (or create) the dedicated folder for voucher attachments.
// Priority: explicit env override → search by name → create under the
// GOOGLE_DRIVE_FOLDER_ID parent (or Drive root if that's unset).
async function getOrCreateDriveFolder(drive, folderName) {
  if (process.env.GOOGLE_DRIVE_VOUCHER_FOLDER_ID) {
    return process.env.GOOGLE_DRIVE_VOUCHER_FOLDER_ID;
  }

  const safeName = String(folderName).replace(/'/g, "\\'");
  try {
    const search = await drive.files.list({
      q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files && search.data.files.length > 0) {
      return search.data.files[0].id;
    }
  } catch (e) {
    console.warn("[voucher-drive] folder search failed:", e.message);
  }

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  return folder.data.id;
}

// ── Upload — PRIVATE (no anyone-with-link permission) ────────────────────────
// Returns metadata stored on the voucher's `attachments` array. `fileUrl`
// carries the Drive file id (see note at top of file).
async function uploadVoucherAttachment(
  buffer,
  { fileName = "attachment", mimeType = "application/octet-stream" } = {},
) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });

  if (!_voucherFolderIdCache) {
    _voucherFolderIdCache = await getOrCreateDriveFolder(
      drive,
      VOUCHER_FOLDER_NAME,
    );
  }

  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      mimeType,
      parents: _voucherFolderIdCache ? [_voucherFolderIdCache] : [],
    },
    media: { mimeType, body: readable },
    fields: "id, name, mimeType, size",
  });

  // IMPORTANT: no drive.permissions.create() here — the file stays PRIVATE.

  const fileId = response.data.id;
  return {
    fileId,
    fileName: response.data.name || fileName,
    fileType: response.data.mimeType || mimeType,
    mimeType: response.data.mimeType || mimeType,
    size: response.data.size ? Number(response.data.size) : buffer.length,
    // The voucher schema persists `fileUrl`; we carry the Drive file id here so
    // the download route can fetch the private file without a new model field.
    fileUrl: fileId,
  };
}

// ── Stream a private file back through our backend ───────────────────────────
// Returns { stream, meta:{ name, mimeType, size } }.
async function streamVoucherAttachment(fileId) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true,
  });

  const resp = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );

  return {
    stream: resp.data,
    meta: {
      name: meta.data.name,
      mimeType: meta.data.mimeType,
      size: meta.data.size ? Number(meta.data.size) : undefined,
    },
  };
}

// ── Delete (best-effort) — handy if you later add a "remove attachment from a
// saved voucher" action. Safe to leave unused.
async function deleteVoucherAttachment(fileId) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });
  await drive.files.delete({ fileId, supportsAllDrives: true });
  return true;
}

module.exports = {
  uploadVoucherAttachment,
  streamVoucherAttachment,
  deleteVoucherAttachment,
};
