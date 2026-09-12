/**
 * GRAV-CMS-BACKEND/services/faceGalleryDrive.service.js
 *
 * PRIVATE Google Drive BACKUP of face registration photos.
 *
 * READ THIS BEFORE CHANGING WHERE FACE PHOTOS LIVE.
 *
 * The photos cannot MOVE to Drive. The recognition engine reads every
 * registration photo off local disk to build its gallery — at boot, and again
 * whenever the gallery changes — and it is a Python process on the punch-in
 * machine, not on this API host. Making Drive the primary store would mean
 * downloading the whole gallery before anybody could sign in, and again on
 * every restart. The local folder stays the working copy because recognition
 * requires it to be local.
 *
 * So this is a MIRROR, taken at upload time, which is the only moment this
 * process ever holds the bytes: both upload paths (HR from the desk, and the
 * employee's phone through /hr/face-enroll) post base64 through here on their
 * way to the engine. That gives durability the USB volume does not — a dead
 * machine or a lost stick no longer loses the registrations — while leaving
 * recognition exactly as fast as it is now.
 *
 * PRIVATE, and deliberately so. There is no drive.permissions.create() call
 * below. These are biometric photographs of employees; a shareable link to one
 * is a permanent liability, and no feature here needs a URL. Nothing serves
 * these files back to a browser — HR thumbnails still come from the engine's
 * local copy. This is a backup, not a CDN.
 *
 * BEST EFFORT BY CONSTRUCTION. Every function here swallows its own failures
 * and reports them in the return value. A Drive outage, an unset service
 * account or a quota error must never stop somebody registering their face:
 * the registration that matters is the one on the punch-in machine.
 *
 * Modelled on services/employeeLetterDrive.service.js, and a separate file for
 * the same reason that one is: services/mediaUpload.service.js makes uploads
 * PUBLIC, and one wrong import here would publish everybody's face.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_KEY        service-account JSON on one line
 *   GOOGLE_DRIVE_FOLDER_ID            optional parent (Shared Drive)
 *   GOOGLE_DRIVE_FACE_FOLDER_ID       optional: pin the face-backup folder
 *   FACE_DRIVE_BACKUP=0               turn the mirror off entirely
 */

const { google } = require("googleapis");
const { Readable } = require("stream");

const FOLDER_NAME = "Face Registrations";
let _folderIdCache = null;

/** Off by an explicit 0, and off when there is no service account to use. */
function backupEnabled() {
  if (String(process.env.FACE_DRIVE_BACKUP || "").trim() === "0") return false;
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
}

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

/**
 * Find (or create) the backup folder. Same priority as the letters service:
 * explicit env override, then search by name, then create.
 */
async function getOrCreateFolder(drive) {
  if (process.env.GOOGLE_DRIVE_FACE_FOLDER_ID) {
    return process.env.GOOGLE_DRIVE_FACE_FOLDER_ID;
  }
  const safeName = FOLDER_NAME.replace(/'/g, "\\'");
  try {
    const search = await drive.files.list({
      q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files?.length) return search.data.files[0].id;
  } catch (e) {
    console.warn("[face-drive] folder search failed:", e.message);
  }
  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  return folder.data.id;
}

const DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i;

/** Bytes and mime type out of the data URL both upload paths already carry. */
function decodeDataUrl(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl || ""));
  if (!m) return null;
  try {
    return { mimeType: m[1].toLowerCase(), buffer: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

/**
 * Mirror one employee's uploaded photos to Drive.
 *
 * @param files    [{ filename, data }] exactly as posted to the engine
 * @param employeeId  biometric id, folded into the file name
 * @param employeeName  for a human reading the Drive folder
 * @returns [{ filename, driveFileId, bytes }] for the ones that made it
 *
 * NEVER THROWS. The caller has already saved the photo where recognition
 * needs it; a failure here is a missing backup, not a failed registration.
 */
async function backupFacePhotos(files, { employeeId, employeeName = "" } = {}) {
  if (!backupEnabled() || !Array.isArray(files) || files.length === 0) return [];

  let drive;
  try {
    drive = google.drive({ version: "v3", auth: getServiceAccountAuth() });
    if (!_folderIdCache) _folderIdCache = await getOrCreateFolder(drive);
  } catch (e) {
    console.warn("[face-drive] backup unavailable:", e.message);
    return [];
  }

  const saved = [];
  for (const f of files) {
    const decoded = decodeDataUrl(f && f.data);
    if (!decoded) continue;
    /* One flat folder, the hierarchy folded into the name — the convention the
       other Drive services use, and it keeps the folder searchable by id. */
    const name = [employeeId, employeeName, f.filename || "photo.jpg"]
      .filter(Boolean)
      .join(" - ");
    try {
      const readable = new Readable();
      readable._read = () => {};
      readable.push(decoded.buffer);
      readable.push(null);
      const res = await drive.files.create({
        supportsAllDrives: true,
        requestBody: {
          name,
          mimeType: decoded.mimeType,
          parents: _folderIdCache ? [_folderIdCache] : [],
        },
        media: { mimeType: decoded.mimeType, body: readable },
        fields: "id, size",
      });
      // IMPORTANT: no drive.permissions.create() — the file stays PRIVATE.
      saved.push({
        filename: f.filename || "photo.jpg",
        driveFileId: res.data.id,
        bytes: res.data.size ? Number(res.data.size) : decoded.buffer.length,
      });
    } catch (e) {
      console.warn(`[face-drive] backup failed for ${name}:`, e.message);
    }
  }
  return saved;
}

/**
 * Move one backed-up photo to the Drive trash.
 *
 * Trashed, not deleted: archiving a registration photo on the punch-in machine
 * moves it to _archive/ rather than removing it, for the same reason — if the
 * gallery gets worse afterwards, the way back has to still exist.
 */
async function trashFacePhoto(driveFileId) {
  if (!backupEnabled() || !driveFileId) return false;
  try {
    const drive = google.drive({ version: "v3", auth: getServiceAccountAuth() });
    await drive.files.update({
      fileId: driveFileId,
      supportsAllDrives: true,
      requestBody: { trashed: true },
    });
    return true;
  } catch (e) {
    console.warn("[face-drive] trash failed:", e.message);
    return false;
  }
}

module.exports = {
  backupEnabled,
  backupFacePhotos,
  trashFacePhoto,
};
