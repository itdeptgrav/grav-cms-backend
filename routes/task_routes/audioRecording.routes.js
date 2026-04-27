/**
 * grav-backend/routes/task_routes/audioRecording.routes.js
 *
 * REGISTER in server.js:
 *   const audioRecordingRoutes = require("./routes/task_routes/audioRecording.routes");
 *   app.use("/cowork", audioRecordingRoutes(io));
 *
 * ENDPOINTS:
 *   POST /cowork/audio/chunk          → receive audio chunk from browser
 *   POST /cowork/audio/finalize       → merge chunks → Drive → Firebase
 *   GET  /cowork/audio/status/:meetId → get recording status for a meeting
 *
 * FLOW:
 *   1. CEO/TL clicks Start → frontend emits socket "recording_start"
 *   2. All browsers start MediaRecorder, send chunks every 30s here
 *   3. CEO/TL clicks Stop → frontend emits socket "recording_stop"
 *   4. Each browser calls /audio/finalize → backend merges chunks → Drive → Firebase
 *   5. Temp chunk files are deleted
 * 
 * 

 */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Readable } = require("stream");
const { google } = require("googleapis");
const { db, admin } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");

// ── Temp storage — chunks land in OS temp dir ─────────────────────────────────
// Path: {tmpDir}/cowork_audio/{meetId}/{employeeId}/chunk_{index}.bin
const TMP_BASE = path.join(os.tmpdir(), "cowork_audio");
fs.mkdirSync(TMP_BASE, { recursive: true });

// ── Multer — memory storage for incoming audio chunks ─────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per chunk (30sec audio ≈ 500KB)
});

// ── Google Drive service account auth (same as existing mediaUpload.service) ──
function getDriveClient() {
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set in .env");
    let key;
    try { key = JSON.parse(keyJson); } catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY invalid JSON"); }
    if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, "\n");

    const auth = new google.auth.GoogleAuth({
        credentials: { client_email: key.client_email, private_key: key.private_key },
        scopes: ["https://www.googleapis.com/auth/drive"],
    });
    return google.drive({ version: "v3", auth });
}

// ── In-memory folder ID cache ─────────────────────────────────────────────────
// Key: "folderName::parentId" → Value: Google Drive folder ID
// Prevents duplicate folders when multiple employees finalize at the same time
const folderCache = new Map();

// ── Helper: get or create a folder — with cache + mutex per key ───────────────
const folderLocks = new Map(); // prevents two simultaneous creates for same folder

async function getOrCreateFolder(drive, folderName, parentId) {
    const cacheKey = `${folderName}::${parentId || "root"}`;

    // Return cached ID immediately if we already have it
    if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);

    // If another async call is already creating this same folder, wait for it
    if (folderLocks.has(cacheKey)) return folderLocks.get(cacheKey);

    // Create a promise that resolves to the folder ID
    const createPromise = (async () => {
        try {
            // Search Drive for existing folder with this name under this parent
            let query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
            if (parentId) query += ` and '${parentId}' in parents`;

            const search = await drive.files.list({
                q: query,
                fields: "files(id, name)",
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
            });

            if (search.data.files.length > 0) {
                const id = search.data.files[0].id;
                folderCache.set(cacheKey, id);
                return id;
            }

            // Not found — create it
            const parentsList = parentId
                ? [parentId]
                : (process.env.GOOGLE_DRIVE_FOLDER_ID ? [process.env.GOOGLE_DRIVE_FOLDER_ID] : []);

            const folder = await drive.files.create({
                requestBody: {
                    name: folderName,
                    mimeType: "application/vnd.google-apps.folder",
                    parents: parentsList,
                },
                fields: "id",
                supportsAllDrives: true,
            });

            const id = folder.data.id;
            folderCache.set(cacheKey, id);
            return id;
        } finally {
            folderLocks.delete(cacheKey);
        }
    })();

    folderLocks.set(cacheKey, createPromise);
    return createPromise;
}

// ── Upload merged audio buffer to Drive ───────────────────────────────────────
// Final structure:
//   CoWork Audio Recording/
//   └── meeting/
//         └── {meetId}/
//               ├── E001_John_audio_M004.webm
//               └── E001_John_audio_M004 (1).webm  ← if rejoined
async function uploadAudioToDrive(buffer, baseFileName, mimeType, meetId) {
    const drive = getDriveClient();

    // Level 1: fixed parent folder
    const rootFolderId = await getOrCreateFolder(drive, "CoWork Audio Recording", null);
    // Level 2: fixed "meeting" subfolder
    const meetingFolderId = await getOrCreateFolder(drive, "meeting", rootFolderId);
    // Level 3: dynamic per-meeting folder (e.g. "M004")
    const meetFolderId = await getOrCreateFolder(drive, meetId, meetingFolderId);

    // Split baseFileName into name + extension for suffix logic
    const lastDot = baseFileName.lastIndexOf(".");
    const nameOnly = lastDot > 0 ? baseFileName.slice(0, lastDot) : baseFileName;
    const ext = lastDot > 0 ? baseFileName.slice(lastDot + 1) : "webm";

    // Find a filename that doesn't already exist (adds (1), (2)... if needed)
    const finalFileName = await findAvailableFileName(drive, meetFolderId, nameOnly, ext);

    const readable = new Readable();
    readable._read = () => { };
    readable.push(buffer);
    readable.push(null);

    const response = await drive.files.create({
        supportsAllDrives: true,
        requestBody: {
            name: finalFileName,
            mimeType,
            parents: [meetFolderId],
        },
        media: { mimeType, body: readable },
        fields: "id, name, webViewLink, size",
    });

    // Make file publicly readable
    await drive.permissions.create({
        fileId: response.data.id,
        supportsAllDrives: true,
        requestBody: { role: "reader", type: "anyone" },
    });

    return {
        fileId: response.data.id,
        fileName: finalFileName,   // actual saved name (may have suffix)
        viewUrl: `https://drive.google.com/file/d/${response.data.id}/view`,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
        webViewLink: response.data.webViewLink,
        size: response.data.size,
    };
}

// ── Helper: get chunk dir for a user ─────────────────────────────────────────
function getChunkDir(meetId, employeeId) {
    return path.join(TMP_BASE, meetId, employeeId);
}

// ── Helper: get next chunk index ─────────────────────────────────────────────
function getNextChunkIndex(chunkDir) {
    if (!fs.existsSync(chunkDir)) return 0;
    const files = fs.readdirSync(chunkDir).filter(f => f.startsWith("chunk_"));
    return files.length;
}

// ── Helper: merge all chunks into one Buffer ──────────────────────────────────
function mergeChunks(chunkDir) {
    if (!fs.existsSync(chunkDir)) return null;
    const files = fs.readdirSync(chunkDir)
        .filter(f => f.startsWith("chunk_"))
        .sort(); // chunk_000, chunk_001, ... natural sort works for zero-padded

    if (files.length === 0) return null;

    const buffers = files.map(f => fs.readFileSync(path.join(chunkDir, f)));
    return Buffer.concat(buffers);
}

// ── Helper: cleanup temp chunk dir ───────────────────────────────────────────
function cleanupChunkDir(meetId, employeeId) {
    const dir = getChunkDir(meetId, employeeId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── Find available filename in Drive folder (adds (1), (2)... if exists) ──────
// Checks: filename.ext → filename (1).ext → filename (2).ext → ...
async function findAvailableFileName(drive, meetFolderId, baseName, ext) {
    // List all files in the meeting folder once
    const list = await drive.files.list({
        q: `'${meetFolderId}' in parents and trashed=false`,
        fields: "files(id, name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    const existingNames = new Set(list.data.files.map(f => f.name.toLowerCase()));

    // Try base name first
    const base = `${baseName}.${ext}`;
    if (!existingNames.has(base.toLowerCase())) return base;

    // Try (1), (2), (3)... until we find one that doesn't exist
    for (let i = 1; i <= 99; i++) {
        const candidate = `${baseName} (${i}).${ext}`;
        if (!existingNames.has(candidate.toLowerCase())) return candidate;
    }

    // Fallback: timestamp suffix (should never reach here)
    return `${baseName}_${Date.now()}.${ext}`;
}

// ── Route factory (needs io for socket emissions) ────────────────────────────
module.exports = function (io) {
    const router = express.Router();

    // ─────────────────────────────────────────────────────────────────────────
    // POST /cowork/audio/chunk
    // Called every 30 seconds by each browser during recording.
    // Body (multipart): chunk (audio blob), meetId, employeeId, chunkIndex, mimeType
    // ─────────────────────────────────────────────────────────────────────────
    router.post(
        "/audio/chunk",
        verifyCoworkToken,
        verifyEmployeeToken,
        upload.single("chunk"),
        async (req, res) => {
            try {
                const { meetId, chunkIndex, mimeType } = req.body;
                const { employeeId } = req.coworkUser;

                if (!req.file) return res.status(400).json({ error: "No chunk data received" });
                if (!meetId) return res.status(400).json({ error: "meetId required" });

                // Save chunk to disk
                const chunkDir = getChunkDir(meetId, employeeId);
                fs.mkdirSync(chunkDir, { recursive: true });

                // Zero-pad index — use Number() to avoid "0" being falsy with ||
                const numericIndex = (chunkIndex !== undefined && chunkIndex !== null && chunkIndex !== "")
                    ? Number(chunkIndex)
                    : getNextChunkIndex(chunkDir);
                const idx = String(numericIndex).padStart(4, "0");
                const ext = mimeType?.includes("mp4") ? "mp4" : mimeType?.includes("ogg") ? "ogg" : "webm";
                const fname = `chunk_${idx}.${ext}`;
                fs.writeFileSync(path.join(chunkDir, fname), req.file.buffer);

                console.log(`[AudioChunk] meetId=${meetId} emp=${employeeId} chunk=${idx} size=${req.file.size}B`);
                res.json({ success: true, chunkIndex: idx });
            } catch (e) {
                console.error("[AudioChunk] Error:", e.message);
                res.status(500).json({ error: e.message });
            }
        }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /cowork/audio/finalize
    // Called once per user when recording stops (after CEO/TL stop confirmation).
    // Merges all chunks → uploads to Drive → saves to Firebase → cleans up temp.
    // Body: { meetId, employeeId, firstName, mimeType }
    // ─────────────────────────────────────────────────────────────────────────
    router.post(
        "/audio/finalize",
        verifyCoworkToken,
        verifyEmployeeToken,
        async (req, res) => {
            try {
                const { meetId, firstName, mimeType: clientMimeType } = req.body;
                const { employeeId, name } = req.coworkUser;

                if (!meetId) return res.status(400).json({ error: "meetId required" });

                const chunkDir = getChunkDir(meetId, employeeId);
                const merged = mergeChunks(chunkDir);

                if (!merged || merged.length === 0) {
                    // No audio was recorded for this user (e.g. joined but never unmuted)
                    cleanupChunkDir(meetId, employeeId);
                    return res.json({
                        success: true,
                        skipped: true,
                        message: "No audio captured for this participant",
                    });
                }

                // Determine MIME type and extension
                const mimeType = clientMimeType || "audio/webm";
                const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";

                // File name: {employeeId}_{firstName}_audio_{meetingId}.{ext}
                // uploadAudioToDrive handles (1),(2)... suffix if file already exists
                // Use sanitized full name — avoids collision between participants with same first name
                const safeName = (firstName || name || "user").replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || employeeId;
                const baseFileName = `${employeeId}_${safeName}_audio_${meetId}.${ext}`;

                console.log(`[AudioFinalize] Merging ${merged.length} bytes for ${employeeId} → ${baseFileName}`);

                // Upload to Google Drive — returns actual fileName (may have (1) suffix)
                const driveResult = await uploadAudioToDrive(merged, baseFileName, mimeType, meetId);
                const actualFileName = driveResult.fileName;

                // Save metadata to Firebase
                // ALWAYS use a unique doc ID so no recording segment ever gets
                // overwritten — covers: rejoins in a new tab, stop-then-restart
                // within the same session, multiple host recordings in the same
                // meeting, etc. The driveFileId field is itself unique, so we
                // prefer that in the docId when available.
                const isRejoin = req.body.isRejoin === true || req.body.isRejoin === "true";
                const docId = `${meetId}_${employeeId}_${Date.now()}`;

                const firestoreData = {
                    meetId,
                    employeeId,
                    employeeName: name || firstName || "Unknown",
                    firstName: (firstName || name || "").split(" ")[0],
                    fileName: actualFileName,
                    mimeType,
                    fileSize: merged.length,
                    driveFileId: driveResult.fileId,
                    driveViewUrl: driveResult.viewUrl,
                    driveDownloadUrl: driveResult.downloadUrl,
                    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: "uploaded",
                    isRejoin,
                };

                await db
                    .collection("meeting_audio_recordings")
                    .doc(docId)
                    .set(firestoreData);

                // Cleanup temp chunks
                cleanupChunkDir(meetId, employeeId);

                console.log(`[AudioFinalize] ✅ ${actualFileName} uploaded to Drive: ${driveResult.viewUrl}`);

                // Emit to meeting room so others know this person's audio is done
                if (io) {
                    io.to(`meeting_${meetId}`).emit("audio_upload_complete", {
                        employeeId,
                        employeeName: name,
                        fileName: actualFileName,
                        driveViewUrl: driveResult.viewUrl,
                    });
                }

                res.json({
                    success: true,
                    fileName: actualFileName,
                    driveViewUrl: driveResult.viewUrl,
                    driveDownloadUrl: driveResult.downloadUrl,
                    driveFileId: driveResult.fileId,
                    fileSize: merged.length,
                    isRejoin,
                });

            } catch (e) {
                console.error("[AudioFinalize] Error:", e.message);
                res.status(500).json({ error: e.message });
            }
        }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /cowork/audio/recordings/:meetId
    // Get all uploaded audio recordings for a meeting from Firebase.
    // ─────────────────────────────────────────────────────────────────────────
    router.get(
        "/audio/recordings/:meetId",
        verifyCoworkToken,
        verifyEmployeeToken,
        async (req, res) => {
            try {
                const { meetId } = req.params;
                const snap = await db
                    .collection("meeting_audio_recordings")
                    .where("meetId", "==", meetId)
                    .get();

                const recordings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                res.json({ success: true, recordings });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /cowork/audio/beacon-chunk
    // Called by navigator.sendBeacon on page unload (no auth header possible).
    // Receives raw audio blob + meetId + employeeId from query params.
    // Uses multer memory storage — raw body is the audio blob.
    // ─────────────────────────────────────────────────────────────────────────
    router.post(
        "/audio/beacon-chunk",
        upload.single("chunk"),
        async (req, res) => {
            try {
                const meetId = req.query.meetId || req.body?.meetId;
                const mimeType = req.query.mimeType || req.body?.mimeType || "audio/webm";
                const bodyToken = req.body?.token; // token sent in FormData body (beacon can't set headers)

                // Validate token from body
                let employeeId;
                try {
                    const { auth } = require("../../config/firebaseAdmin");
                    const decoded = await auth.verifyIdToken(bodyToken);
                    // Look up employeeId from Firestore
                    const { db } = require("../../config/firebaseAdmin");
                    const snap = await db.collection("cowork_employees")
                        .where("authUid", "==", decoded.uid).limit(1).get();
                    if (snap.empty) throw new Error("Employee not found");
                    employeeId = snap.docs[0].data().employeeId;
                } catch (authErr) {
                    console.warn("[BeaconChunk] Token validation failed:", authErr.message);
                    return res.status(200).json({ success: false }); // always 200 for beacon
                }

                if (!meetId || !employeeId) {
                    return res.status(200).json({ error: "meetId required" });
                }

                const audioBuffer = req.file?.buffer || (Buffer.isBuffer(req.body) ? req.body : null);
                if (audioBuffer && audioBuffer.length > 100) {
                    const chunkDir = getChunkDir(meetId, employeeId);
                    fs.mkdirSync(chunkDir, { recursive: true });
                    const idx = String(getNextChunkIndex(chunkDir)).padStart(4, "0");
                    const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
                    fs.writeFileSync(path.join(chunkDir, `chunk_${idx}.${ext}`), audioBuffer);
                    console.log(`[BeaconChunk] ✅ Saved emergency chunk for ${employeeId} in ${meetId}`);
                }
                res.status(200).json({ success: true });
            } catch (e) {
                console.error("[BeaconChunk] Error:", e.message);
                res.status(200).json({ success: false });
            }
        }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /cowork/audio/beacon-finalize
    // Called by navigator.sendBeacon on page unload.
    // Body is a JSON blob: { meetId, firstName, mimeType, emergency }
    // No auth token — uses employeeId from the chunk directory structure.
    // ─────────────────────────────────────────────────────────────────────────
    router.post(
        "/audio/beacon-finalize",
        express.raw({ type: "application/json", limit: "1mb" }),
        async (req, res) => {
            // Respond immediately — sendBeacon doesn't wait for response
            res.status(200).json({ success: true });

            // Process in background after responding
            setImmediate(async () => {
                try {
                    let body;
                    try {
                        body = JSON.parse(req.body.toString());
                    } catch (_) {
                        console.error("[BeaconFinalize] Could not parse body");
                        return;
                    }

                    const { meetId, firstName, mimeType, employeeId: bodyEmpId } = body;
                    if (!meetId) return;

                    // Find all employee chunk dirs for this meeting
                    const meetTmpDir = path.join(TMP_BASE, meetId);
                    if (!fs.existsSync(meetTmpDir)) return;

                    const employeeDirs = fs.readdirSync(meetTmpDir);
                    console.log(`[BeaconFinalize] Emergency finalize for meetId=${meetId}, employees=${employeeDirs.join(",")}`);

                    for (const empId of employeeDirs) {
                        const chunkDir = getChunkDir(meetId, empId);
                        const merged = mergeChunks(chunkDir);
                        if (!merged || merged.length < 100) {
                            cleanupChunkDir(meetId, empId);
                            continue;
                        }

                        const ext = (mimeType || "audio/webm").includes("mp4") ? "mp4"
                            : (mimeType || "").includes("ogg") ? "ogg" : "webm";
                        const safeName = (firstName || empId).split(" ")[0].replace(/[^a-zA-Z0-9]/g, "");
                        const fileName = `${empId}_${safeName}_audio_${meetId}.${ext}`;

                        try {
                            const driveResult = await uploadAudioToDrive(merged, fileName, mimeType || "audio/webm", meetId);

                            await db.collection("meeting_audio_recordings")
                                .doc(`${meetId}_${empId}`)
                                .set({
                                    meetId,
                                    employeeId: empId,
                                    fileName,
                                    mimeType: mimeType || "audio/webm",
                                    fileSize: merged.length,
                                    driveFileId: driveResult.fileId,
                                    driveViewUrl: driveResult.viewUrl,
                                    driveDownloadUrl: driveResult.downloadUrl,
                                    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                                    status: "uploaded_emergency",
                                    emergency: true,
                                });

                            cleanupChunkDir(meetId, empId);
                            console.log(`[BeaconFinalize] ✅ Emergency upload done: ${fileName}`);
                        } catch (uploadErr) {
                            console.error(`[BeaconFinalize] Upload failed for ${empId}:`, uploadErr.message);
                        }
                    }
                } catch (e) {
                    console.error("[BeaconFinalize] Background error:", e.message);
                }
            });
        }
    );

    return router;
};