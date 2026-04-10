// googleDrivePatternUpload.js
const { google } = require("googleapis");
const stream = require("stream");

// ── Auth (Service Account) ───────────────────────────────────────
let _driveClient = null;

function getDriveClient() {
  if (_driveClient) return _driveClient;

  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error(
      "Google Drive not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY in .env"
    );
  }

  const key = JSON.parse(keyJson);

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  _driveClient = google.drive({ version: "v3", auth });
  return _driveClient;
}

// ── Folder cache + mutex ─────────────────────────────────────────
// Prevents race conditions where multiple simultaneous uploads all
// create "GRAV Patterns" before any of them finish — resulting in
// 6+ duplicate folders.
//
// Key = "parentId::folderName"  →  Value = folderId (string)
// While a folder is being created, we store a Promise so other callers
// await the same creation instead of starting their own.

const _folderCache = new Map();   // key → folderId (resolved)
const _folderLocks = new Map();   // key → Promise<folderId> (in-flight)

function folderCacheKey(name, parentId) {
  return `${parentId || "root"}::${name}`;
}

// ── Folder helpers ───────────────────────────────────────────────
// Escape single quotes in Drive query strings (name field uses single-quote delimiters)
function escQ(str) {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive, name, parentId) {
  const cacheKey = folderCacheKey(name, parentId);

  // 1. Already resolved — return immediately
  if (_folderCache.has(cacheKey)) {
    return _folderCache.get(cacheKey);
  }

  // 2. Another call is already creating this folder — wait for it
  if (_folderLocks.has(cacheKey)) {
    return _folderLocks.get(cacheKey);
  }

  // 3. We are the first — create a promise that others can await
  const promise = (async () => {
    try {
      const escaped = escQ(name);
      const q = parentId
        ? `name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
        : `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

      const list = await drive.files.list({
        q,
        fields: "files(id, name)",
        spaces: "drive",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1,
      });

      if (list.data.files.length > 0) {
        const id = list.data.files[0].id;
        _folderCache.set(cacheKey, id);
        return id;
      }

      // Create the folder
      const meta = {
        name,
        mimeType: "application/vnd.google-apps.folder",
      };
      if (parentId) meta.parents = [parentId];

      const folder = await drive.files.create({
        resource: meta,
        fields: "id",
        supportsAllDrives: true,
      });

      const folderId = folder.data.id;

      // Make folder publicly readable so SVG URLs work in the browser
      try {
        await drive.permissions.create({
          fileId: folderId,
          supportsAllDrives: true,
          resource: { role: "reader", type: "anyone" },
        });
      } catch (e) {
        console.warn("Could not set folder permissions:", e.message);
      }

      _folderCache.set(cacheKey, folderId);
      return folderId;
    } finally {
      // Release lock whether we succeeded or failed
      _folderLocks.delete(cacheKey);
    }
  })();

  _folderLocks.set(cacheKey, promise);
  return promise;
}

// ── Upload ───────────────────────────────────────────────────────
async function uploadPatternToDrive(fileBuffer, originalFilename, mimeType, stockItemId, sizeName, stockItemName) {
  const drive = getDriveClient();

  // Folder structure: [GOOGLE_DRIVE_FOLDER_ID] / GRAV Patterns / <Product Name (id)> / <size>.svg
  const configuredParent = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
  const gravFolderId = await findOrCreateFolder(drive, "GRAV Patterns", configuredParent);

  const productFolderName = stockItemName
    ? `${stockItemName} (${stockItemId.slice(-6)})`
    : stockItemId;
  const productFolderId = await findOrCreateFolder(drive, productFolderName, gravFolderId);

  const ext = originalFilename.match(/\.(svg|ai|eps)$/i)?.[0] || ".svg";
  const driveFilename = `${sizeName}${ext}`;

  // Check if file already exists (update instead of duplicate)
  const escapedFilename = escQ(driveFilename);
  const existingQ = `name='${escapedFilename}' and '${productFolderId}' in parents and trashed=false`;
  const existing = await drive.files.list({
    q: existingQ,
    fields: "files(id)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  });

  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  let fileId;

  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id;
    await drive.files.update({
      fileId,
      supportsAllDrives: true,
      media: {
        mimeType: mimeType || "image/svg+xml",
        body: bufferStream,
      },
    });
  } else {
    const res = await drive.files.create({
      resource: {
        name: driveFilename,
        parents: [productFolderId],
      },
      media: {
        mimeType: mimeType || "image/svg+xml",
        body: bufferStream,
      },
      fields: "id",
      supportsAllDrives: true,
    });

    fileId = res.data.id;

    // Make file publicly readable
    try {
      await drive.permissions.create({
        fileId,
        supportsAllDrives: true,
        resource: { role: "reader", type: "anyone" },
      });
    } catch (e) {
      console.warn("Could not set file permissions:", e.message);
    }
  }

  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const apiContentUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  return {
    fileId,
    url: directUrl,
    apiContentUrl,
    webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    mimeType: mimeType || "image/svg+xml",
    bytes: fileBuffer.length,
  };
}

// ── Fetch file content from Drive (server-side) ──────────────────
async function fetchFileContentFromDrive(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" }
  );
  return res.data;
}

// ── Delete ───────────────────────────────────────────────────────
async function deletePatternFromDrive(fileId) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

// ── Clear folder cache (useful after deletions or during tests) ──
function clearFolderCache() {
  _folderCache.clear();
  _folderLocks.clear();
}

// ── Test ─────────────────────────────────────────────────────────
async function testDriveConnection() {
  const drive = getDriveClient();
  try {
    const res = await drive.about.get({ fields: "user" });
    return { ok: true, email: res.data.user?.emailAddress || "connected" };
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("invalid_grant") || msg.includes("JWT")) {
      throw new Error(
        "Service account auth failed. Check GOOGLE_SERVICE_ACCOUNT_KEY in .env"
      );
    }
    throw err;
  }
}

module.exports = {
  uploadPatternToDrive,
  deletePatternFromDrive,
  fetchFileContentFromDrive,
  testDriveConnection,
  getDriveClient,
  clearFolderCache,
};