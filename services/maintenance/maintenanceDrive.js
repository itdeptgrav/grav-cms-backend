// services/maintenance/maintenanceDrive.js
//
// PHOTOS AND DOCUMENTS OF MAINTENANCE JOBS — on Google Drive, PRIVATE.
//
// The posture of services/companyDrive.service.js (and the employee-letters
// service before it), on purpose:
//   1. NO `drive.permissions.create()`. A file is readable by the service
//      account and nobody else — never "anyone with the link".
//   2. Reads are STREAMED back through Maintenance's own signed-in route, so the
//      access check runs on every view, not once when a link was made.
//
// Why the backend and not the CMS's /api/upload-to-drive (3 Oct 2026): that
// route needs the service account in grav-cms's own env (it was not there, so
// every upload answered "Invalid service account configuration"), it shares
// every file publicly, it has no sign-in check, and Next's middleware cuts a
// matched request body at ~10 MiB. Here the credentials are the backend's
// (GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_DRIVE_FOLDER_ID), already used by the
// company drive, letters and cowork attachments.
//
// Its own folder, "Maintenance" (or GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID): a
// cached folder id shared between two features is how one of them starts
// writing into the other's folder.
"use strict";

const { google } = require("googleapis");
const { Readable } = require("stream");

const FOLDER_NAME = "Maintenance";
const MAX_BYTES = 25 * 1024 * 1024;
/* Things nobody needs to attach to a repair, and that a click should never run. */
const BLOCKED = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|sh|jar|apk|dll)$/i;

class DriveNotConfigured extends Error {}

function auth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new DriveNotConfigured("Google Drive is not configured on the server (GOOGLE_SERVICE_ACCOUNT_KEY).");
  let key;
  try { key = JSON.parse(keyJson); } catch { throw new DriveNotConfigured("The server's GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON."); }
  return new google.auth.GoogleAuth({
    credentials: { client_email: key.client_email, private_key: String(key.private_key || "").replace(/\\n/g, "\n") },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

let client = null;
const drive = () => (client ||= google.drive({ version: "v3", auth: auth() }));

let folderId = null;
async function folder() {
  if (folderId) return folderId;
  if (process.env.GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID) return (folderId = process.env.GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID);
  const parent = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const q = [`name = '${FOLDER_NAME}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false", parent ? `'${parent}' in parents` : null]
    .filter(Boolean).join(" and ");
  const found = await drive().files.list({ q, fields: "files(id)", pageSize: 1, supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (found.data.files?.length) return (folderId = found.data.files[0].id);
  const made = await drive().files.create({
    supportsAllDrives: true,
    requestBody: { name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder", parents: parent ? [parent] : [] },
    fields: "id",
  });
  return (folderId = made.data.id);
}

/** Why a file cannot be attached, or "" when it can. */
function fileProblem({ name, size }) {
  if (BLOCKED.test(String(name || ""))) return `${name} is a program file and cannot be attached.`;
  if (!(size > 0)) return `${name || "That file"} is empty.`;
  if (size > MAX_BYTES) return `${name} is over 25 MB. Attach a smaller copy.`;
  return "";
}

/** Upload one file, privately. `{ fileId, name, mimeType, size }`. */
async function uploadFile(buffer, { name, mimeType }) {
  const body = new Readable({ read() {} });
  body.push(buffer);
  body.push(null);
  const res = await drive().files.create({
    supportsAllDrives: true,
    requestBody: { name, mimeType, parents: [await folder()] },
    media: { mimeType, body },
    fields: "id, name, mimeType, size",
  });
  // No drive.permissions.create(): the file stays private.
  return { fileId: res.data.id, name: res.data.name || name, mimeType: res.data.mimeType || mimeType, size: res.data.size ? Number(res.data.size) : buffer.length };
}

/** Stream one file back. `{ stream, meta: { name, mimeType, size } }`. */
async function streamFile(fileId) {
  const meta = await drive().files.get({ fileId, fields: "id, name, mimeType, size", supportsAllDrives: true });
  const resp = await drive().files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  return { stream: resp.data, meta: { name: meta.data.name, mimeType: meta.data.mimeType, size: meta.data.size ? Number(meta.data.size) : undefined } };
}

module.exports = { MAX_BYTES, fileProblem, uploadFile, streamFile, DriveNotConfigured };
