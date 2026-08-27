"use strict";
/**
 * services/companyDrive.service.js
 * ───────────────────────────────────────────────────────────────────────────
 * THE COMPANY DRIVE'S BYTES, ON GOOGLE DRIVE, PRIVATE.
 *
 * The same service-account posture as services/employeeLetterDrive.service.js
 * — deliberately, because that file already learned the two lessons that
 * matter and there is no reason for a second opinion in one codebase:
 *
 *   1. NO `drive.permissions.create()`. The uploaded object is readable by
 *      the service account and nobody else. A file that is "private but
 *      anyone with the link can read" is a public file with extra steps.
 *   2. Reads are STREAMED back through our own authenticated route, so the
 *      permission check runs on every request rather than once, at the moment
 *      a link was minted.
 *
 * Its folder helper is not reused: letters live in "Employee Letters" and
 * these do not, and sharing a cached folder id between two features is how
 * one of them silently starts writing into the other's folder.
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

const FOLDER_NAME = process.env.GOOGLE_DRIVE_FILES_FOLDER_NAME || "Company Drive";

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

function driveClient() {
  return google.drive({ version: "v3", auth: getServiceAccountAuth() });
}

/* Resolved once per process. A miss costs two API calls and the answer never
   changes within a deployment. */
let _folderIdCache = null;

async function getOrCreateFolder(drive) {
  if (process.env.GOOGLE_DRIVE_FILES_FOLDER_ID) {
    return process.env.GOOGLE_DRIVE_FILES_FOLDER_ID;
  }

  const parent = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const q = [
    `name = '${FOLDER_NAME.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    parent ? `'${parent}' in parents` : null,
  ]
    .filter(Boolean)
    .join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (found.data.files?.length) return found.data.files[0].id;

  const made = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: parent ? [parent] : [],
    },
    fields: "id",
  });
  return made.data.id;
}

/**
 * Put a document in the drive.
 *
 * `folderPath` is folded into the stored NAME rather than nesting real Drive
 * folders: the drive's tree is still the app's, not Drive's, and mirroring it
 * would mean two hierarchies to keep in step. This keeps the Drive folder
 * flat and searchable by hand, which is what an admin actually needs from it.
 */
async function uploadCompanyFile(buffer, { fileName, mimeType, folderPath = [] } = {}) {
  const drive = driveClient();
  if (!_folderIdCache) _folderIdCache = await getOrCreateFolder(drive);

  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);

  const prefix = folderPath.filter(Boolean).join(" / ");
  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: prefix ? `${prefix} / ${fileName}` : fileName,
      mimeType,
      parents: _folderIdCache ? [_folderIdCache] : [],
    },
    media: { mimeType, body: readable },
    fields: "id, name, mimeType, size",
  });

  // IMPORTANT: no drive.permissions.create() — the object stays PRIVATE.

  return {
    driveFileId: res.data.id,
    mimeType: res.data.mimeType || mimeType,
    bytes: res.data.size ? Number(res.data.size) : buffer.length,
  };
}

/** Stream a private document back through our own authenticated route. */
async function streamCompanyFile(driveFileId) {
  const drive = driveClient();

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
 * An orphaned Drive object is far better than a failed delete that leaves the
 * row pointing at bytes the user believes are gone — same posture as the
 * letters service.
 */
async function deleteCompanyFile(driveFileId) {
  if (!driveFileId) return false;
  try {
    await driveClient().files.delete({ fileId: driveFileId, supportsAllDrives: true });
    return true;
  } catch (e) {
    console.warn("[company-drive] delete failed:", e?.message);
    return false;
  }
}

module.exports = { uploadCompanyFile, streamCompanyFile, deleteCompanyFile };
