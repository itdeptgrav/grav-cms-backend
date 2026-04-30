// GRAV-CMS-BACKEND/routes/services/googleDriveService.js
const { google } = require("googleapis");
const { getOAuth2Client } = require("./googleAuthService");

function getDriveClient() {
    return google.drive({ version: "v3", auth: getOAuth2Client() });
}

async function getRecentFiles(maxResults = 20) {
    const drive = getDriveClient();
    const res = await drive.files.list({
        pageSize: maxResults,
        orderBy: "modifiedTime desc",
        fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,owners,shared)",
    });
    return (res.data.files || []).map(formatFile);
}

async function searchFiles(query) {
    const drive = getDriveClient();
    const res = await drive.files.list({
        q: `name contains '${query.replace(/'/g, "\\'")}' and trashed=false`,
        pageSize: 20,
        fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink,owners,shared)",
    });
    return (res.data.files || []).map(formatFile);
}

function formatFile(f) {
    return {
        id: f.id, name: f.name, mimeType: f.mimeType,
        size: f.size ? parseInt(f.size) : null,
        modifiedTime: f.modifiedTime,
        webViewLink: f.webViewLink,
        iconLink: f.iconLink,
        owner: f.owners?.[0]?.displayName || "",
        shared: f.shared || false,
    };
}

module.exports = { getRecentFiles, searchFiles };