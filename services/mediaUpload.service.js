/**
 * GRAV-CMS-BACKEND/services/mediaUpload.service.js
 *
 * Handles:
 *  - Image upload → Cloudinary (via stream, no temp files)
 *  - PDF upload   → Google Drive (using refresh token from .env)
 *  - Voice note   → Cloudinary (audio/webm or audio/mp4)
 *
 * Required env vars:
 *   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
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

// ── Google OAuth2 client ──────────────────────────────────
function getGoogleAuthClient() {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    return oauth2Client;
}

// ── Upload image/voice to Cloudinary ─────────────────────
async function uploadToCloudinary(buffer, { folder = "cowork", resourceType = "auto", originalName = "" } = {}) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: resourceType,
                use_filename: true,
                unique_filename: true,
            },
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

// ── Upload PDF to Google Drive ────────────────────────────
async function uploadToGoogleDrive(buffer, { fileName = "document.pdf", mimeType = "application/pdf", folderId } = {}) {
    try {
        const auth = getGoogleAuthClient();
        const drive = google.drive({ version: "v3", auth });

        // Find or create CoWork folder
        let targetFolderId = folderId;
        if (!targetFolderId) {
            targetFolderId = await getOrCreateCoworkFolder(drive);
        }

        const readable = new Readable();
        readable._read = () => { };
        readable.push(buffer);
        readable.push(null);

        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                mimeType,
                parents: targetFolderId ? [targetFolderId] : [],
            },
            media: {
                mimeType,
                body: readable,
            },
            fields: "id, name, webViewLink, webContentLink, mimeType, size",
        });

        // Make file publicly readable (view link)
        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: "reader",
                type: "anyone",
            },
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
    } catch (error) {
        console.error("Google Drive upload error:", error.message);
        throw new Error("PDF upload to Google Drive failed: " + error.message);
    }
}

// ── Get or create CoWork folder in Drive ─────────────────
async function getOrCreateCoworkFolder(drive) {
    try {
        const search = await drive.files.list({
            q: "name='CoWork Attachments' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: "files(id, name)",
        });

        if (search.data.files.length > 0) {
            return search.data.files[0].id;
        }

        const folder = await drive.files.create({
            requestBody: {
                name: "CoWork Attachments",
                mimeType: "application/vnd.google-apps.folder",
            },
            fields: "id",
        });

        return folder.data.id;
    } catch (e) {
        console.error("Error creating Drive folder:", e.message);
        return null;
    }
}

module.exports = {
    uploadToCloudinary,
    uploadToGoogleDrive,
    getGoogleAuthClient,
};