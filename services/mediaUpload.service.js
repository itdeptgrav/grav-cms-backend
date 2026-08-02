/**
 * GRAV-CMS-BACKEND/services/mediaUpload.service.js
 *
 * PDF upload now uses a SERVICE ACCOUNT — tokens never expire.
 * No more invalid_grant errors.
 *
 * Required env vars:
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   GOOGLE_SERVICE_ACCOUNT_KEY   ← full JSON on one line
 *   GOOGLE_DRIVE_FOLDER_ID       ← optional, folder ID from Drive URL
 */

const cloudinary = require("cloudinary").v2;
const { google } = require("googleapis");
const { Readable } = require("stream");

// ── Cloudinary config ─────────────────────────────────────
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Service Account auth (never expires) ─────────────────
function getServiceAccountAuth() {
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env");

    let key;
    try {
        key = JSON.parse(keyJson);
    } catch (e) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message);
    }

    // Fix: dotenv reads \n as literal backslash-n in the private key.
    // We must convert them to real newline characters for the RSA key to work.
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

// ── Upload image/voice to Cloudinary ─────────────────────
async function uploadToCloudinary(buffer, { folder = "cowork", resourceType = "auto", originalName = "" } = {}) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder, resource_type: resourceType, use_filename: true, unique_filename: true },
            (error, result) => {
                if (error) return reject(new Error("Cloudinary upload failed: " + error.message));
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id,
                    type: resourceType,
                    format: result.format,
                    bytes: result.bytes,
                    originalName,
                });
            }
        );
        const readable = new Readable();
        readable._read = () => { };
        readable.push(buffer);
        readable.push(null);
        readable.pipe(uploadStream);
    });
}

// ── Upload PDF to Google Drive (service account + Shared Drive) ──
async function uploadToGoogleDrive(buffer, { fileName = "document.pdf", mimeType = "application/pdf" } = {}) {
    const auth = getServiceAccountAuth();
    const drive = google.drive({ version: "v3", auth });

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;

    const readable = new Readable();
    readable._read = () => { };
    readable.push(buffer);
    readable.push(null);

    const response = await drive.files.create({
        supportsAllDrives: true,          // ← required for Shared Drive
        requestBody: {
            name: fileName,
            mimeType,
            parents: folderId ? [folderId] : [],
        },
        media: { mimeType, body: readable },
        fields: "id, name, webViewLink, webContentLink, mimeType, size",
    });

    // Make publicly readable
    await drive.permissions.create({
        fileId: response.data.id,
        supportsAllDrives: true,          // ← required for Shared Drive
        requestBody: { role: "reader", type: "anyone" },
    });

    return {
        fileId: response.data.id,
        fileName: response.data.name,
        url: response.data.webViewLink,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
        viewUrl: `https://drive.google.com/file/d/${response.data.id}/view`,
        embedUrl: `https://drive.google.com/file/d/${response.data.id}/preview`,
        mimeType: response.data.mimeType,
        size: response.data.size,
    };
}

// ── Get or create CoWork Attachments folder ───────────────
async function getOrCreateCoworkFolder(drive) {
    try {
        const search = await drive.files.list({
            q: "name='CoWork Attachments' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: "files(id, name)",
        });
        if (search.data.files.length > 0) return search.data.files[0].id;

        const folder = await drive.files.create({
            requestBody: {
                name: "CoWork Attachments",
                mimeType: "application/vnd.google-apps.folder",
            },
            fields: "id",
        });
        return folder.data.id;
    } catch (e) {
        console.error("Error finding/creating Drive folder:", e.message);
        return null;
    }
}

async function createResumableSession({ fileName, mimeType, fileSize, origin }) {
    const auth = getServiceAccountAuth();
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Could not get service account access token");

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;

    const res = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": mimeType || "application/octet-stream",
                "X-Upload-Content-Length": String(fileSize),
                ...(origin ? { Origin: origin } : {}),
            },
            body: JSON.stringify({
                name: fileName,
                mimeType: mimeType || "application/octet-stream",
                parents: folderId ? [folderId] : [],
            }),
        }
    );

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Drive session create failed (${res.status}): ${txt}`);
    }
    const sessionUrl = res.headers.get("location");
    if (!sessionUrl) throw new Error("Drive did not return a session URL");
    return sessionUrl;
}

// One Drive API call instead of two — the mimeType comes off the media
// response's own Content-Type header, so a proxied image view no longer
// spends double the quota it needs. That matters here specifically: this
// route has no auth guard (an <img> can't send one) and is the fallback for
// every Drive image on the site, so it is the one path a quota squeeze shows
// up on first as an intermittent broken image that reloads fine a moment
// later.
async function getDriveFileStream(fileId) {
    const auth = getServiceAccountAuth();
    const drive = google.drive({ version: "v3", auth });

    const fetchStream = async () => {
        const stream = await drive.files.get(
            { fileId, alt: "media", supportsAllDrives: true },
            { responseType: "stream" }
        );
        const mimeType = stream.headers?.["content-type"] || "application/octet-stream";
        return { data: stream.data, mimeType };
    };

    try {
        return await fetchStream();
    } catch (e) {
        // A single retry for a transient Drive error only — rate limit or a
        // server hiccup on Google's side, not a real 404/403 on the file.
        const status = e?.code || e?.response?.status;
        if (status === 429 || status === 500 || status === 503) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return await fetchStream();
        }
        throw e;
    }
}

async function finalizeDriveFile(fileId) {
    const auth = getServiceAccountAuth();
    const drive = google.drive({ version: "v3", auth });

    await drive.permissions.create({
        fileId,
        supportsAllDrives: true,
        requestBody: { role: "reader", type: "anyone" },
    });

    const meta = await drive.files.get({
        fileId,
        supportsAllDrives: true,
        fields: "id, name, mimeType, size, webViewLink",
    });

    const isImage = (meta.data.mimeType || "").startsWith("image/");
    const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`;

    return {
        fileId,
        fileName: meta.data.name,
        mimeType: meta.data.mimeType,
        size: meta.data.size,
        // Primary render URL — Drive's own thumbnail endpoint (more reliable than lh3).
        // Frontend should still onError-fallback to proxyUrl for guaranteed display.
        url: isImage ? thumbUrl : meta.data.webViewLink,
        imageUrl: thumbUrl,
        thumbnailUrl: thumbUrl,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
        viewUrl: `https://drive.google.com/file/d/${fileId}/view`,
        embedUrl: `https://drive.google.com/file/d/${fileId}/preview`,
    };
}

module.exports = { uploadToCloudinary, uploadToGoogleDrive, createResumableSession, finalizeDriveFile, getDriveFileStream };