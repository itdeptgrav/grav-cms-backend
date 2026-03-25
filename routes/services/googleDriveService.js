// GRAV-CMS-BACKEND/services/googleDriveService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

// List recent files from Drive
async function getRecentFiles(maxResults = 20) {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    pageSize: maxResults,
    fields: "files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,owners,shared)",
    orderBy: "modifiedTime desc",
    q: "trashed = false",
  });
  return (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size || null,
    webViewLink: f.webViewLink || null,
    iconLink: f.iconLink || null,
    owner: f.owners?.[0]?.displayName || "",
    shared: f.shared || false,
    type: getMimeLabel(f.mimeType),
  }));
}

// Search Drive files
async function searchFiles(query) {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    pageSize: 15,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    q: `name contains '${query}' and trashed = false`,
  });
  return res.data.files || [];
}

function getMimeLabel(mimeType) {
  const map = {
    "application/vnd.google-apps.document": "Doc",
    "application/vnd.google-apps.spreadsheet": "Sheet",
    "application/vnd.google-apps.presentation": "Slides",
    "application/vnd.google-apps.folder": "Folder",
    "application/pdf": "PDF",
    "image/jpeg": "Image",
    "image/png": "Image",
    "video/mp4": "Video",
  };
  return map[mimeType] || "File";
}

module.exports = { getRecentFiles, searchFiles };
