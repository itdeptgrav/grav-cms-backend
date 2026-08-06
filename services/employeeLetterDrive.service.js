/**
 * GRAV-CMS-BACKEND/services/employeeLetterDrive.service.js
 *
 * PRIVATE Google Drive storage for HR-issued employee letters (appointment,
 * offer, warning, experience, relieving, salary certificate).
 *
 * WHY THIS EXISTS AT ALL, rather than utils/cloudinary.js:
 *
 *   1. Cloudinary is not configured on this deployment — there is no
 *      CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET in .env, so every
 *      uploadFileBuffer() call rejected and the whole Generate action failed
 *      with a bare "Could not save the document". GOOGLE_SERVICE_ACCOUNT_KEY
 *      and GOOGLE_DRIVE_FOLDER_ID are both set and already in use.
 *
 *   2. Cloudinary's secure_url is PUBLIC AND PERMANENT. That made the release
 *      gate a discovery gate only: anyone who once held the URL kept it after
 *      the letter was withdrawn. These files are private — there is no
 *      drive.permissions.create({ type: "anyone" }) call anywhere below — and
 *      every read is streamed through our own route, which re-checks the gate
 *      on each request. Withdrawing a letter now actually withdraws it.
 *
 * Modelled directly on services/voucherDriveUpload.service.js, which does the
 * same thing for accountant voucher attachments. It is deliberately a separate
 * file rather than a shared one: services/mediaUpload.service.js makes its
 * uploads PUBLIC for the CoWork module, and one accidental import of the wrong
 * helper would quietly publish everybody's warning letters.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_KEY          service-account JSON on one line
 *   GOOGLE_DRIVE_FOLDER_ID              optional parent (Shared Drive)
 *   GOOGLE_DRIVE_LETTERS_FOLDER_ID      optional: pin the letters folder
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Service-account auth (never expires) ─────────────────────────────────────
function getServiceAccountAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env");

  let key;
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message);
  }

  // dotenv stores the private key with literal "\n"; convert to real newlines.
  if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: key.private_key },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

const LETTERS_FOLDER_NAME = "Employee Letters";
let _lettersFolderIdCache = null;

/**
 * Find (or create) the letters folder.
 * Priority: explicit env override → search by name → create under
 * GOOGLE_DRIVE_FOLDER_ID (or the Drive root when that is unset).
 */
async function getOrCreateLettersFolder(drive) {
  if (process.env.GOOGLE_DRIVE_LETTERS_FOLDER_ID) {
    return process.env.GOOGLE_DRIVE_LETTERS_FOLDER_ID;
  }

  const safeName = LETTERS_FOLDER_NAME.replace(/'/g, "\\'");
  try {
    const search = await drive.files.list({
      q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files?.length) return search.data.files[0].id;
  } catch (e) {
    console.warn("[letter-drive] folder search failed:", e.message);
  }

  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: LETTERS_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  return folder.data.id;
}

/**
 * Upload a letter PDF. PRIVATE — no permissions are granted to anyone.
 * Returns the sub-document stored on EmployeeDocument.file.
 */
async function uploadEmployeeLetter(
  buffer,
  { fileName = "letter.pdf", mimeType = "application/pdf", subfolder = "" } = {},
) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });

  if (!_lettersFolderIdCache) {
    _lettersFolderIdCache = await getOrCreateLettersFolder(drive);
  }

  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);

  const response = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      // The letter type is folded into the name rather than nesting a folder
      // per type: one flat folder stays searchable in the Drive UI, and HR
      // does look these up by hand.
      name: subfolder ? `${subfolder} - ${fileName}` : fileName,
      mimeType,
      parents: _lettersFolderIdCache ? [_lettersFolderIdCache] : [],
    },
    media: { mimeType, body: readable },
    fields: "id, name, mimeType, size",
  });

  // IMPORTANT: no drive.permissions.create() — the file stays PRIVATE.

  return {
    driveFileId: response.data.id,
    storage: "drive",
    url: "", // no public URL exists, and none should
    publicId: "",
    fileName: response.data.name || fileName,
    mimeType: response.data.mimeType || mimeType,
    bytes: response.data.size ? Number(response.data.size) : buffer.length,
    resourceType: "raw",
  };
}

/** Stream a private letter back through our own authenticated route. */
async function streamEmployeeLetter(driveFileId) {
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });

  const meta = await drive.files.get({
    fileId: driveFileId,
    fields: "id, name, mimeType, size",
    supportsAllDrives: true,
  });

  const resp = await drive.files.get(
    { fileId: driveFileId, alt: "media", supportsAllDrives: true },
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

/**
 * Delete, best-effort.
 * An orphaned Drive file is far better than a failed replacement, so callers
 * warn rather than throw — same posture as the Cloudinary path it replaces.
 */
async function deleteEmployeeLetter(driveFileId) {
  if (!driveFileId) return false;
  const auth = getServiceAccountAuth();
  const drive = google.drive({ version: "v3", auth });
  await drive.files.delete({ fileId: driveFileId, supportsAllDrives: true });
  return true;
}

module.exports = {
  uploadEmployeeLetter,
  streamEmployeeLetter,
  deleteEmployeeLetter,
};
