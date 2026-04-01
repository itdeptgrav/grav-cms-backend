const { google } = require("googleapis");
const stream = require("stream");

// ── Auth (OAuth2) ────────────────────────────────────────────────
let _driveClient = null;
let _oauth2Client = null;

function getOAuth2Client() {
  if (_oauth2Client) return _oauth2Client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Drive OAuth2 not configured. " +
      "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and GOOGLE_REFRESH_TOKEN in .env"
    );
  }

  _oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  _oauth2Client.setCredentials({ refresh_token: refreshToken });

  return _oauth2Client;
}

function getDriveClient() {
  if (_driveClient) return _driveClient;
  const auth = getOAuth2Client();
  _driveClient = google.drive({ version: "v3", auth });
  return _driveClient;
}

// ── Folder helpers ───────────────────────────────────────────────
async function findOrCreateFolder(drive, name, parentId) {
  const q = parentId
    ? `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const list = await drive.files.list({
    q,
    fields: "files(id, name)",
    spaces: "drive",
    pageSize: 1,
  });

  if (list.data.files.length > 0) {
    return list.data.files[0].id;
  }

  const meta = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) meta.parents = [parentId];

  const folder = await drive.files.create({
    resource: meta,
    fields: "id",
  });

  try {
    await drive.permissions.create({
      fileId: folder.data.id,
      resource: { role: "reader", type: "anyone" },
    });
  } catch (e) {
    console.warn("Could not set folder permissions:", e.message);
  }

  return folder.data.id;
}

// ── Upload ───────────────────────────────────────────────────────
async function uploadPatternToDrive(fileBuffer, originalFilename, mimeType, stockItemId, sizeName, stockItemName) {
  const drive = getDriveClient();

  const configuredParent = process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || null;
  const parentFolderId = await findOrCreateFolder(drive, "GRAV Patterns", configuredParent);

  const folderName = stockItemName
    ? `${stockItemName} (${stockItemId.slice(-6)})`
    : stockItemId;
  const stockFolderId = await findOrCreateFolder(drive, folderName, parentFolderId);

  const ext = originalFilename.match(/\.(svg|ai|eps)$/i)?.[0] || ".svg";
  const driveFilename = `${sizeName}${ext}`;

  const existingQ = `name='${driveFilename}' and '${stockFolderId}' in parents and trashed=false`;
  const existing = await drive.files.list({
    q: existingQ,
    fields: "files(id)",
    pageSize: 1,
  });

  const bufferStream = new stream.PassThrough();
  bufferStream.end(fileBuffer);

  let fileId;

  if (existing.data.files.length > 0) {
    fileId = existing.data.files[0].id;
    await drive.files.update({
      fileId,
      media: {
        mimeType: mimeType || "image/svg+xml",
        body: bufferStream,
      },
    });
  } else {
    const res = await drive.files.create({
      resource: {
        name: driveFilename,
        parents: [stockFolderId],
      },
      media: {
        mimeType: mimeType || "image/svg+xml",
        body: bufferStream,
      },
      fields: "id",
    });

    fileId = res.data.id;

    try {
      await drive.permissions.create({
        fileId,
        resource: { role: "reader", type: "anyone" },
      });
    } catch (e) {
      console.warn("Could not set file permissions:", e.message);
    }
  }

  // Use Google Drive API's webContentLink for direct download.
  // The alt=media URL works with the API auth but the simpler approach
  // for public files is the export URL with confirm parameter.
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  // Also build the API-based content URL for server-side fetching
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
// Used when basePaths aren't saved yet and we need to get the SVG content
// on the backend to parse and return to the cutting master.
async function fetchFileContentFromDrive(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "text" }
  );
  return res.data;
}

// ── Delete ───────────────────────────────────────────────────────
async function deletePatternFromDrive(fileId) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

// ── Test ─────────────────────────────────────────────────────────
async function testDriveConnection() {
  const drive = getDriveClient();
  try {
    const res = await drive.about.get({ fields: "user" });
    return { ok: true, email: res.data.user?.emailAddress || "connected" };
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("invalid_grant")) {
      throw new Error(
        "Refresh token expired. Re-authorize at https://developers.google.com/oauthplayground and update GOOGLE_REFRESH_TOKEN"
      );
    }
    if (msg.includes("invalid_client")) {
      throw new Error("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is wrong");
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
};