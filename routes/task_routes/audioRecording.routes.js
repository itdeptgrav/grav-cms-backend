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
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

// ── Temp storage — chunks land in OS temp dir ─────────────────────────────────
// Path: {tmpDir}/cowork_audio/{meetId}/{employeeId}/chunk_{index}.bin
const TMP_BASE = path.join(os.tmpdir(), "cowork_audio");
fs.mkdirSync(TMP_BASE, { recursive: true });

// ── Path safety — ids from request bodies must never become path segments ─────
// `meetId`, `employeeId` and `guestId` all arrive from callers. `path.join`
// RESOLVES `..` rather than rejecting it, so an id of "../../.." walked out of
// TMP_BASE — and the finalize paths end in a recursive `fs.rmSync`, so an
// escaped path was a delete of somebody else's files, reachable unauthenticated
// through the beacon route. Two layers guard it: `safeSegment` rejects any id
// that is not a single, separator-free token, and `containedPath` proves the
// resolved path still sits under TMP_BASE even if a caller forgets to validate.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
function safeSegment(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(id)}`);
  }
  return id;
}
function containedPath(...segments) {
  const root = path.resolve(TMP_BASE);
  const resolved = path.resolve(path.join(TMP_BASE, ...segments));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Resolved path escapes the temp root: ${resolved}`);
  }
  return resolved;
}

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
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY invalid JSON");
  }
  if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
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
        : process.env.GOOGLE_DRIVE_FOLDER_ID
          ? [process.env.GOOGLE_DRIVE_FOLDER_ID]
          : [];

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
async function uploadFileWithRetry(
  drive,
  finalFileName,
  mimeType,
  meetFolderId,
  chunkFiles,
) {
  const RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    // A FRESH stream every attempt — streams are single-use, and a retry must
    // re-read from disk rather than replay a consumed one. `createMergedStream`
    // reads the chunk files one at a time, so only a single chunk is ever in
    // memory; googleapis pipes this body straight to Drive (it does not buffer
    // a stream — see multipartUpload in googleapis-common), so a recording of
    // any size uploads with flat memory instead of a whole-file Buffer.concat.
    const body = createMergedStream(chunkFiles);
    /**
     * Keep a chunk read fault from crashing the whole server.
     *
     * If a chunk file cannot be read mid-upload — a disk error, or a concurrent
     * finalize clearing the directory — the async generator throws and `body`
     * emits `error`. googleapis pipes the media body WITHOUT ever listening for
     * that (multipartUpload in googleapis-common does `part.body.pipe(...)`
     * only), and Node's `pipe()` does not forward a source error to the
     * destination — so an unhandled `error` here reaches the process as an
     * `uncaughtException` and takes the backend down for everyone. The old
     * in-memory `mergeChunks` never could: it read the chunks synchronously
     * inside the route's try/catch, so a read fault was a clean 500.
     *
     * Listening for the error and ABORTING the request turns the fault back
     * into an ordinary rejection of `drive.files.create` — caught below and, on
     * the employee path, followed by restoring the claimed chunks — rather than
     * a request left hanging on a body that will never finish. gaxios honours
     * `signal`, and a googleapis method's second argument is passed straight
     * through to it as request options.
     */
    const controller = new AbortController();
    body.on("error", (err) => controller.abort(err));
    try {
      return await drive.files.create(
        {
          supportsAllDrives: true,
          requestBody: {
            name: finalFileName,
            mimeType,
            parents: [meetFolderId],
          },
          media: { mimeType, body },
          fields: "id, name, webViewLink, size",
        },
        { signal: controller.signal },
      );
    } catch (e) {
      // Release the file descriptor this attempt opened before a retry builds a
      // fresh stream — a no-op on an already-errored or aborted stream.
      body.destroy();
      lastErr = e;
      const reason = e?.errors?.[0]?.reason || "";
      /**
       * Rate limits and dropped connections are transient too.
       *
       * Everyone's browser finalizes at the same instant — that is what Stop
       * and End for everyone both do — so several uploads hit Drive together
       * and it answers 429, or 403 `userRateLimitExceeded`. Neither was in
       * this list, so the upload failed on the first try and the whole
       * recording fell back to the browser's own slow retry. A socket reset
       * mid-upload was treated the same way.
       */
      const isTransient =
        reason === "transientFailure" ||
        reason === "backendError" ||
        reason === "rateLimitExceeded" ||
        reason === "userRateLimitExceeded" ||
        e?.code === 429 ||
        e?.code === 500 ||
        e?.code === 502 ||
        e?.code === 503 ||
        e?.code === "ECONNRESET" ||
        e?.code === "ETIMEDOUT" ||
        e?.code === "EPIPE";
      console.warn(
        `[Drive] Upload attempt ${attempt}/${RETRIES} failed${isTransient ? " (transient — retrying)" : " (not retryable)"}: ${e.message}`,
      );
      if (!isTransient || attempt === RETRIES) throw e;
      await new Promise((r) => setTimeout(r, attempt * 1000)); // 1s, then 2s
    }
  }
  throw lastErr;
}

async function uploadAudioToDrive(chunkFiles, baseFileName, mimeType, meetId) {
  const drive = getDriveClient();

  // Level 1: fixed parent folder
  const rootFolderId = await getOrCreateFolder(
    drive,
    "CoWork Audio Recording",
    null,
  );
  // Level 2: fixed "meeting" subfolder
  const meetingFolderId = await getOrCreateFolder(
    drive,
    "meeting",
    rootFolderId,
  );
  // Level 3: dynamic per-meeting folder (e.g. "M004")
  const meetFolderId = await getOrCreateFolder(drive, meetId, meetingFolderId);

  // Split baseFileName into name + extension for suffix logic
  const lastDot = baseFileName.lastIndexOf(".");
  const nameOnly = lastDot > 0 ? baseFileName.slice(0, lastDot) : baseFileName;
  const ext = lastDot > 0 ? baseFileName.slice(lastDot + 1) : "webm";

  // Find a filename that doesn't already exist (adds (1), (2)... if needed)
  const finalFileName = await findAvailableFileName(
    drive,
    meetFolderId,
    nameOnly,
    ext,
  );

  const response = await uploadFileWithRetry(
    drive,
    finalFileName,
    mimeType,
    meetFolderId,
    chunkFiles,
  );

  // Make file publicly readable
  await drive.permissions.create({
    fileId: response.data.id,
    supportsAllDrives: true,
    requestBody: { role: "reader", type: "anyone" },
  });

  return {
    fileId: response.data.id,
    fileName: finalFileName, // actual saved name (may have suffix)
    viewUrl: `https://drive.google.com/file/d/${response.data.id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${response.data.id}`,
    webViewLink: response.data.webViewLink,
    size: response.data.size,
  };
}

// ── Helper: get chunk dir for a user ─────────────────────────────────────────
function getChunkDir(meetId, employeeId) {
  return containedPath(safeSegment(meetId), safeSegment(employeeId));
}

// ── Helper: get next chunk index ─────────────────────────────────────────────
function getNextChunkIndex(chunkDir) {
  if (!fs.existsSync(chunkDir)) return 0;
  const files = fs.readdirSync(chunkDir).filter((f) => f.startsWith("chunk_"));
  return files.length;
}

// ── Helpers: the chunk files, their size, and a STREAM over them ──────────────
// Streaming replaces the old `mergeChunks` Buffer.concat, which read every chunk
// into memory and concatenated the whole recording into one Buffer — a 500 MB
// recording became 500 MB of RAM and, with several people finalizing at once,
// an out-of-memory kill. Nothing here reads a chunk's bytes into memory:
// `listChunkFiles` returns the ordered paths (zero-padded names sort correctly),
// `chunkFilesSize` sums their on-disk sizes for the "was anything recorded?"
// check, and `createMergedStream` yields the bytes one chunk at a time.
function listChunkFiles(chunkDir) {
  if (!fs.existsSync(chunkDir)) return [];
  return fs
    .readdirSync(chunkDir)
    .filter((f) => f.startsWith("chunk_"))
    .sort()
    .map((f) => path.join(chunkDir, f));
}

function chunkFilesSize(files) {
  return files.reduce((sum, fp) => sum + fs.statSync(fp).size, 0);
}

// A fresh Readable that streams the chunk files in order — ONE chunk's buffer in
// flight at a time, never the whole recording. Rebuildable, because a stream is
// single-use and an upload retry needs a new one.
function createMergedStream(files) {
  async function* concat() {
    for (const fp of files) {
      for await (const buf of fs.createReadStream(fp)) yield buf;
    }
  }
  return Readable.from(concat());
}

// ── Helper: cleanup temp chunk dir ───────────────────────────────────────────
function cleanupChunkDir(meetId, employeeId) {
  const dir = getChunkDir(meetId, employeeId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── The claim, and why it must never destroy audio ───────────────────────────
//
// `renameSync` is the lock that stops two finalizes merging one recording twice.
// Its FAILURE used to be read as "there is nothing here" — and answered by
// deleting the live chunk directory and replying `skipped`, which a browser
// reads as "nothing to upload" and responds to by dropping the retry marker
// that is the only thing that would ever have sent the audio again.
//
// On Windows that is a whole recording destroyed by a routine flake: a
// directory cannot be renamed while any file inside it holds an open handle, so
// a chunk still landing — or a virus scanner reading the one just written —
// fails the rename with EPERM/EBUSY. The audio was deleted, the browser was
// told everything was fine, and nothing ever retried. Two meeting folders in
// Drive with nothing in them, and an abandoned claim directory still sitting in
// the temp folder, are what that looked like from the outside.
//
// So a claim now has three distinct answers and only one of them means absence:
//   · ENOENT               — genuinely nothing to merge.
//   · EPERM/EBUSY/EACCES   — locked; retried briefly, then reported as HELD.
//   · anything else        — reported as held, never mistaken for absence.
// No path here deletes a chunk. The worst case is that the audio stays exactly
// where the next attempt will look for it.
const CLAIM_MARK = ".merging-";
const CLAIM_LOCK_RETRIES = 5;
const CLAIM_LOCK_DELAY_MS = 120;
/** Past this, a claim belongs to a finalize that died, and is re-adopted. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Move chunk files from one directory into another, keeping their names.
 *
 * Chunks are keyed by index, so a name already present in the destination is
 * the SAME chunk — the copy on disk is kept and the duplicate dropped, which
 * is what makes merging a claim back into a live directory safe.
 */
function moveChunksInto(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(fromDir)) {
    const from = path.join(fromDir, name);
    const to = path.join(toDir, name);
    try {
      if (fs.existsSync(to)) fs.rmSync(from, { force: true });
      else {
        fs.renameSync(from, to);
        moved++;
      }
    } catch {
      /* Leave it where it is — a later claim re-adopts the directory. */
    }
  }
  try {
    if (fs.readdirSync(fromDir).length === 0)
      fs.rmSync(fromDir, { recursive: true, force: true });
  } catch {
    /* Not empty, or gone. Either way there is nothing to clean up here. */
  }
  return moved;
}

/** Claim directories left behind by a finalize that died mid-upload. */
function staleClaims(meetId, employeeId) {
  const meetDir = containedPath(safeSegment(meetId));
  if (!fs.existsSync(meetDir)) return [];
  const prefix = `${safeSegment(employeeId)}${CLAIM_MARK}`;
  const now = Date.now();
  const out = [];
  for (const name of fs.readdirSync(meetDir)) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(meetDir, name);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory() && now - st.mtimeMs > STALE_CLAIM_MS) out.push(full);
    } catch {
      /* Vanished under us — another finalize finished with it. */
    }
  }
  return out;
}

/**
 * Take exclusive hold of one participant's chunks.
 *
 * → { dir }    the claim; merge from here.
 * → { empty }  there is genuinely nothing to merge.
 * → { held }   somebody else has it, or it is locked. RETRYABLE — never to be
 *              reported to a browser as "no audio", because that is what makes
 *              it throw away the marker that would have retried.
 */
async function claimChunks(meetId, employeeId) {
  const live = getChunkDir(meetId, employeeId);

  /* Re-adopt anything a dead finalize walked off with, so a retry rescues that
     audio instead of stepping over it for ever. */
  for (const abandoned of staleClaims(meetId, employeeId)) {
    const n = moveChunksInto(abandoned, live);
    if (n > 0)
      console.warn(
        `[AudioFinalize] re-adopted ${n} chunk(s) from an abandoned claim: ${path.basename(abandoned)}`,
      );
  }

  for (let attempt = 1; attempt <= CLAIM_LOCK_RETRIES; attempt++) {
    const dir = `${live}${CLAIM_MARK}${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      /* Deliberately NOT guarded by `existsSync`: the throw IS the lock. */
      fs.renameSync(live, dir);
      return { dir };
    } catch (e) {
      if (e.code === "ENOENT") return { empty: true };
      const locked =
        e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES";
      if (!locked) {
        console.error(
          `[AudioFinalize] claim failed for ${employeeId} (${e.code}): ${e.message}`,
        );
        return { held: true, reason: e.code || "unknown" };
      }
      if (attempt < CLAIM_LOCK_RETRIES)
        await waitMs(CLAIM_LOCK_DELAY_MS * attempt);
    }
  }
  console.warn(
    `[AudioFinalize] ${employeeId}'s chunks are locked — left for the retry`,
  );
  return { held: true, reason: "locked" };
}

// ── Helper: validate a guest session is real and still tied to this meeting ──
async function validateGuestSession(meetId, guestSessionId) {
  if (!meetId || !guestSessionId) return null;
  const doc = await db
    .collection("cowork_guest_sessions")
    .doc(guestSessionId)
    .get();
  if (!doc.exists) return null;
  const session = doc.data();
  if (session.meetId !== meetId || session.active !== true) return null;
  return session;
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
  const existingNames = new Set(
    list.data.files.map((f) => f.name.toLowerCase()),
  );

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

        if (!req.file)
          return res.status(400).json({ error: "No chunk data received" });
        if (!meetId) return res.status(400).json({ error: "meetId required" });

        // Save chunk to disk
        const chunkDir = getChunkDir(meetId, employeeId);
        fs.mkdirSync(chunkDir, { recursive: true });

        // Zero-pad index — use Number() to avoid "0" being falsy with ||
        const numericIndex =
          chunkIndex !== undefined && chunkIndex !== null && chunkIndex !== ""
            ? Number(chunkIndex)
            : getNextChunkIndex(chunkDir);
        const idx = String(numericIndex).padStart(4, "0");
        const ext = mimeType?.includes("mp4")
          ? "mp4"
          : mimeType?.includes("ogg")
            ? "ogg"
            : "webm";
        const fname = `chunk_${idx}.${ext}`;
        fs.writeFileSync(path.join(chunkDir, fname), req.file.buffer);

        console.log(
          `[AudioChunk] meetId=${meetId} emp=${employeeId} chunk=${idx} size=${req.file.size}B`,
        );
        res.json({ success: true, chunkIndex: idx });
      } catch (e) {
        console.error("[AudioChunk] Error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
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
      /* Declared out here so the `catch` can put the audio back. A `const`
         inside the `try` is not visible to its sibling `catch`, which would
         make the restore below dead code — and a failed finalize would then
         leave the recording under a name nothing ever looks for. */
      let claimedDir = null;
      try {
        const { meetId, firstName, mimeType: clientMimeType } = req.body;
        const { employeeId, name } = req.coworkUser;

        if (!meetId) return res.status(400).json({ error: "meetId required" });

        /**
         * **Claim the directory before merging it.**
         *
         * Finalize can arrive from three places at once for one recording: the
         * page-hide keepalive as a tab closes, the browser's own drain replaying
         * the IndexedDB marker afterwards, and the room unmounting. Each of them
         * merged whatever was in the directory and wrote its own Drive file, and
         * the directory is only cleared on SUCCESS — so two that overlapped both
         * merged the same audio and the folder ended up holding the same voice
         * two and three times. Seen on M058: three files for one person, five
         * seconds apart.
         *
         * `renameSync` is the whole lock. It is atomic on every filesystem this
         * runs on, and it fails when the source is gone — so the first caller
         * takes the audio and everybody after it finds nothing and is answered
         * `skipped`, which is exactly what "somebody already finalized this"
         * should look like.
         */
        const claim = await claimChunks(meetId, employeeId);

        if (claim.empty) {
          console.log(
            `[AudioFinalize] nothing to merge for ${employeeId} — already finalized, or never recorded`,
          );
          return res.json({
            success: true,
            skipped: true,
            message: "Already finalized, or no audio captured",
          });
        }

        if (claim.held) {
          /**
           * **Held is not empty, and the difference is a recording.**
           *
           * Another finalize is merging this audio, or the directory is
           * momentarily locked. Answered as `skipped`, as it used to be, the
           * browser concludes there was nothing to upload and deletes the
           * marker that drives its retry — so a failure in that other finalize
           * became permanent, silently. Answered as a retryable error, the
           * marker survives and the drain tries again a minute later.
           */
          return res.status(409).json({
            success: false,
            pending: true,
            reason: claim.reason,
            error:
              "This recording is already being saved. It will finish or retry on its own.",
          });
        }

        const chunkDir = claim.dir;
        claimedDir = chunkDir;

        const chunkFiles = listChunkFiles(chunkDir);
        const totalBytes = chunkFilesSize(chunkFiles);

        if (!chunkFiles.length || totalBytes === 0) {
          // No audio was recorded for this user (e.g. joined but never unmuted)
          fs.rmSync(chunkDir, { recursive: true, force: true });
          cleanupChunkDir(meetId, employeeId);
          return res.json({
            success: true,
            skipped: true,
            message: "No audio captured for this participant",
          });
        }

        // Determine MIME type and extension
        const mimeType = clientMimeType || "audio/webm";
        const ext = mimeType.includes("mp4")
          ? "mp4"
          : mimeType.includes("ogg")
            ? "ogg"
            : "webm";

        // File name: {employeeId}_{firstName}_audio_{meetingId}.{ext}
        // uploadAudioToDrive handles (1),(2)... suffix if file already exists
        // Use sanitized full name — avoids collision between participants with same first name
        const safeName =
          (firstName || name || "user")
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 20) || employeeId;
        const baseFileName = `${safeName}_audio_${meetId}.${ext}`;
        console.log(
          `[AudioFinalize] Streaming ${totalBytes} bytes for ${employeeId} → ${baseFileName}`,
        );

        // Upload to Google Drive — returns actual fileName (may have (1) suffix)
        const driveResult = await uploadAudioToDrive(
          chunkFiles,
          baseFileName,
          mimeType,
          meetId,
        );
        const actualFileName = driveResult.fileName;

        // Save metadata to Firebase
        // ALWAYS use a unique doc ID so no recording segment ever gets
        // overwritten — covers: rejoins in a new tab, stop-then-restart
        // within the same session, multiple host recordings in the same
        // meeting, etc. The driveFileId field is itself unique, so we
        // prefer that in the docId when available.
        const isRejoin =
          req.body.isRejoin === true || req.body.isRejoin === "true";
        const docId = `${meetId}_${employeeId}_${Date.now()}`;

        const firestoreData = {
          meetId,
          employeeId,
          employeeName: name || firstName || "Unknown",
          firstName: (firstName || name || "").split(" ")[0],
          fileName: actualFileName,
          mimeType,
          fileSize: totalBytes,
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

        /**
         * **Past this line the recording is SAVED, and nothing may undo it.**
         *
         * The row is written, so tidying up is housekeeping — but it used to
         * sit inside the route's own `try`, so a `rmSync` refused by Windows
         * (an open handle on a chunk, the same flake that breaks the rename)
         * threw AFTER a successful upload. The catch then answered 500 and
         * handed the chunks back, and the browser's retry uploaded the very
         * same audio again: that is how one person ends up with two and three
         * files in a meeting folder.
         *
         * Clearing `claimedDir` first is the other half — it stops the restore
         * path putting back audio that is already in Drive.
         */
        claimedDir = null;
        try {
          /* The claimed copy, and the live directory in case a late chunk
             landed while this was uploading. Both, because the claim renamed
             the audio out of the way rather than deleting it. */
          fs.rmSync(chunkDir, { recursive: true, force: true });
          cleanupChunkDir(meetId, employeeId);
        } catch (cleanupError) {
          /* Left on disk, and that is the harmless outcome: the next claim for
             this participant re-adopts it as a stale claim and finds the same
             chunks, while the recording itself is already safely in Drive. */
          console.warn(
            `[AudioFinalize] could not clear ${employeeId}'s temp chunks: ${cleanupError.message}`,
          );
        }

        console.log(
          `[AudioFinalize] ✅ ${actualFileName} uploaded to Drive: ${driveResult.viewUrl}`,
        );

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
          fileSize: totalBytes,
          isRejoin,
        });
      } catch (e) {
        /**
         * **Put the audio back where the retry will look for it.**
         *
         * The claim above renamed the chunk directory aside so a concurrent
         * finalize could not merge the same audio twice. If THIS one then fails
         * — Drive refusing, a network fault — the recording is sitting under a
         * name nothing else knows, and the browser's own retry would find an
         * empty directory and conclude there was nothing to upload. The claim
         * would have turned a temporary failure into a lost recording.
         *
         * So the failure path gives it back. Merging into an existing live
         * directory is safe: chunks are keyed by index, so a chunk that arrived
         * meanwhile keeps its own name.
         */
        try {
          const live = getChunkDir(meetId, employeeId);
          /* `chunkDir` is this call's own unique claim — the only directory it
             is entitled to give back. Guessing a fixed name here would either
             miss it or, worse, hand back a directory another finalize is
             actively merging. */
          if (claimedDir && fs.existsSync(claimedDir)) {
            /**
             * **Merged back, not merely renamed.**
             *
             * This required that the live directory did NOT exist — so a single
             * late chunk arriving during the upload recreated it, the rename
             * was skipped, and the whole claimed recording was orphaned under a
             * name nothing ever looks for. One of those was sitting in the temp
             * directory when this was found. Chunks are keyed by index, so
             * merging is exactly as safe as the comment always said it was.
             */
            const moved = moveChunksInto(claimedDir, live);
            console.warn(
              `[AudioFinalize] restored ${moved} chunk(s) for ${employeeId} after a failed finalize`,
            );
          }
        } catch (restoreError) {
          console.error(
            "[AudioFinalize] could not restore chunks:",
            restoreError.message,
          );
        }
        console.error("[AudioFinalize] Error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // BACKUP RECORDINGS — a second copy of somebody else's voice, kept by the
  // host's browser and uploaded ONLY when that person's own file never arrived.
  //
  // Why this exists: a participant's audio is written to their own browser's
  // disk before it is uploaded, so a dropped connection never loses it. But if
  // that person never opens Cowork again — laptop gone, left the company,
  // browser cleared — nothing ever sends it, and after seven days it expires.
  // The host hears them over WebRTC anyway, so the host's browser can hold a
  // copy against exactly that case.
  //
  // It is a SECOND-GENERATION copy: already compressed by their browser, sent
  // over the network, and decoded. Lower quality than their own recording, and
  // whatever their connection lost is baked into it permanently. So it is never
  // preferred — only used where the alternative is nothing at all.
  //
  // Three routes, and the ORDER matters: claim, then chunk, then finalize.
  // Nothing reaches Drive until `backup-claim` has said the original is missing
  // AND handed this caller the exclusive right to supply it.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Where a backup's chunks live — never the directory the real one uses. */
  function getBackupChunkDir(meetId, forEmployeeId) {
    return containedPath(
      safeSegment(meetId),
      `backup__${safeSegment(forEmployeeId)}`,
    );
  }

  /** Their own recording, if it landed. A backup row never counts as one. */
  async function realRecordingExists(meetId, forEmployeeId) {
    const own = await db
      .collection("meeting_audio_recordings")
      .where("meetId", "==", meetId)
      .where("employeeId", "==", forEmployeeId)
      .limit(5)
      .get();
    return own.docs.some((d) => d.data().isBackup !== true);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /cowork/audio/backup-claim
  // Body: { meetId, forEmployeeId }
  // → { needed: false }                 their own recording arrived; discard
  // → { needed: true, claimed: true }   upload yours
  // → { needed: true, claimed: false }  somebody else is already uploading
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/audio/backup-claim",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
      try {
        const { meetId, forEmployeeId } = req.body;
        const { employeeId: claimedBy } = req.coworkUser;
        if (!meetId || !forEmployeeId)
          return res
            .status(400)
            .json({ error: "meetId and forEmployeeId required" });

        /* Checked first, so the common case costs one query and writes
           nothing at all. A backup exists to cover the absence of the real
           recording, so its presence ends the matter. */
        if (await realRecordingExists(meetId, forEmployeeId))
          return res.json({ needed: false });

        /**
         * **The lock, and why it is a transaction.**
         *
         * In a five-person meeting every participant may hold a backup of the
         * same voice. Without this they would all see "their file is missing"
         * at the same moment and all upload, and the meeting would end with
         * five identical recordings of one person. The transaction makes the
         * claim atomic: exactly one caller is told `claimed: true`.
         *
         * A claim goes stale after ten minutes, so a host who claims and then
         * shuts their laptop does not lock the recording out forever.
         */
        const claimRef = db
          .collection("meeting_audio_backup_claims")
          .doc(`${meetId}__${forEmployeeId}`);
        const STALE_MS = 10 * 60 * 1000;

        const claimed = await db.runTransaction(async (tx) => {
          const snap = await tx.get(claimRef);
          const now = Date.now();
          if (snap.exists) {
            const d = snap.data();
            const age = now - (d.claimedAtMs ?? 0);
            if (d.claimedBy !== claimedBy && age < STALE_MS) return false;
          }
          tx.set(claimRef, {
            meetId,
            forEmployeeId,
            claimedBy,
            claimedAtMs: now,
            claimedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });

        console.log(
          `[AudioBackup] claim meet=${meetId} for=${forEmployeeId} by=${claimedBy} -> ${claimed}`,
        );
        res.json({ needed: true, claimed });
      } catch (e) {
        console.error("[AudioBackup] claim error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /cowork/audio/backup-chunk — the shape of /audio/chunk, except the
  // audio belongs to `forEmployeeId` and is kept in its own directory.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/audio/backup-chunk",
    verifyCoworkToken,
    verifyEmployeeToken,
    upload.single("chunk"),
    async (req, res) => {
      try {
        const { meetId, forEmployeeId, chunkIndex, mimeType } = req.body;
        if (!req.file)
          return res.status(400).json({ error: "No chunk data received" });
        if (!meetId || !forEmployeeId)
          return res
            .status(400)
            .json({ error: "meetId and forEmployeeId required" });

        const chunkDir = getBackupChunkDir(meetId, forEmployeeId);
        fs.mkdirSync(chunkDir, { recursive: true });

        const numericIndex =
          chunkIndex !== undefined && chunkIndex !== null && chunkIndex !== ""
            ? Number(chunkIndex)
            : getNextChunkIndex(chunkDir);
        const idx = String(numericIndex).padStart(4, "0");
        const ext = mimeType?.includes("mp4")
          ? "mp4"
          : mimeType?.includes("ogg")
            ? "ogg"
            : "webm";
        fs.writeFileSync(
          path.join(chunkDir, `chunk_${idx}.${ext}`),
          req.file.buffer,
        );

        console.log(
          `[AudioBackup] chunk meet=${meetId} for=${forEmployeeId} idx=${idx} size=${req.file.size}B`,
        );
        res.json({ success: true, chunkIndex: idx });
      } catch (e) {
        console.error("[AudioBackup] chunk error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /cowork/audio/backup-finalize
  // Body: { meetId, forEmployeeId, forName, mimeType }
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/audio/backup-finalize",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
      try {
        const {
          meetId,
          forEmployeeId,
          forName,
          mimeType: clientMime,
        } = req.body;
        const { employeeId: recordedBy, name: recordedByName } = req.coworkUser;
        if (!meetId || !forEmployeeId)
          return res
            .status(400)
            .json({ error: "meetId and forEmployeeId required" });

        const chunkDir = getBackupChunkDir(meetId, forEmployeeId);
        const chunkFiles = listChunkFiles(chunkDir);
        const totalBytes = chunkFilesSize(chunkFiles);
        if (!chunkFiles.length || totalBytes === 0) {
          fs.rmSync(chunkDir, { recursive: true, force: true });
          return res.json({
            success: true,
            skipped: true,
            message: "No backup audio captured",
          });
        }

        /* Checked AGAIN, immediately before writing. The claim was taken when
           the meeting ended; their own upload may have completed in the minutes
           since — a slow connection finishing, or the drain on another page
           catching up. Uploading now would put the same voice in the folder
           twice, which is the one outcome this feature must never cause. */
        if (await realRecordingExists(meetId, forEmployeeId)) {
          fs.rmSync(chunkDir, { recursive: true, force: true });
          console.log(
            `[AudioBackup] their own file arrived first — discarding backup for ${forEmployeeId}`,
          );
          return res.json({
            success: true,
            skipped: true,
            message: "Their own recording arrived; backup discarded",
          });
        }

        const mimeType = clientMime || "audio/webm";
        const ext = mimeType.includes("mp4")
          ? "mp4"
          : mimeType.includes("ogg")
            ? "ogg"
            : "webm";
        const safeName =
          (forName || forEmployeeId)
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 20) || forEmployeeId;
        /* Named so nobody mistakes it for the real thing in the Drive folder. */
        const baseFileName = `${safeName}_audio_${meetId}_backup.${ext}`;

        const driveResult = await uploadAudioToDrive(
          chunkFiles,
          baseFileName,
          mimeType,
          meetId,
        );

        await db
          .collection("meeting_audio_recordings")
          .doc(`${meetId}_${forEmployeeId}_backup_${Date.now()}`)
          .set({
            meetId,
            employeeId: forEmployeeId,
            employeeName: forName || forEmployeeId,
            firstName: (forName || "").split(" ")[0],
            fileName: driveResult.fileName,
            mimeType,
            fileSize: totalBytes,
            driveFileId: driveResult.fileId,
            driveViewUrl: driveResult.viewUrl,
            driveDownloadUrl: driveResult.downloadUrl,
            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: "uploaded",
            isRejoin: false,
            /* The three fields that keep it honest wherever it is read: what it
               is, who captured it, and under whose name. */
            isBackup: true,
            recordedBy,
            recordedByName: recordedByName || recordedBy,
          });

        fs.rmSync(chunkDir, { recursive: true, force: true });
        console.log(
          `[AudioBackup] ✅ ${driveResult.fileName} (backup for ${forEmployeeId}, recorded by ${recordedBy})`,
        );

        res.json({
          success: true,
          isBackup: true,
          fileName: driveResult.fileName,
          driveViewUrl: driveResult.viewUrl,
          driveFileId: driveResult.fileId,
          fileSize: totalBytes,
        });
      } catch (e) {
        console.error("[AudioBackup] finalize error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /cowork/audio/guest-chunk — NO Firebase auth, validated by
  // guestSessionId instead. Same 30s cadence as /audio/chunk.
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/audio/guest-chunk",
    upload.single("chunk"),
    async (req, res) => {
      try {
        const { meetId, guestSessionId, chunkIndex, mimeType } = req.body;
        if (!req.file)
          return res.status(400).json({ error: "No chunk data received" });
        if (!meetId || !guestSessionId)
          return res
            .status(400)
            .json({ error: "meetId and guestSessionId required" });

        const session = await validateGuestSession(meetId, guestSessionId);
        if (!session)
          return res
            .status(403)
            .json({ error: "Invalid or expired guest session." });

        const guestId = session.guestId;
        const chunkDir = getChunkDir(meetId, guestId);
        fs.mkdirSync(chunkDir, { recursive: true });

        const numericIndex =
          chunkIndex !== undefined && chunkIndex !== null && chunkIndex !== ""
            ? Number(chunkIndex)
            : getNextChunkIndex(chunkDir);
        const idx = String(numericIndex).padStart(4, "0");
        const ext = mimeType?.includes("mp4")
          ? "mp4"
          : mimeType?.includes("ogg")
            ? "ogg"
            : "webm";
        fs.writeFileSync(
          path.join(chunkDir, `chunk_${idx}.${ext}`),
          req.file.buffer,
        );

        console.log(
          `[GuestAudioChunk] meetId=${meetId} guest=${guestId} chunk=${idx}`,
        );
        res.json({ success: true, chunkIndex: idx });
      } catch (e) {
        console.error("[GuestAudioChunk] Error:", e.message);
        res.status(500).json({ error: e.message });
      }
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /cowork/audio/guest-finalize — writes into the SAME
  // meeting_audio_recordings collection meetingSummary.routes.js already
  // reads by meetId — no change needed there for guest voice to show up.
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/audio/guest-finalize", async (req, res) => {
    try {
      const {
        meetId,
        guestSessionId,
        mimeType: clientMimeType,
        speechIntervals,
      } = req.body;
      if (!meetId || !guestSessionId)
        return res
          .status(400)
          .json({ error: "meetId and guestSessionId required" });

      const session = await validateGuestSession(meetId, guestSessionId);
      if (!session)
        return res
          .status(403)
          .json({ error: "Invalid or expired guest session." });

      const guestId = session.guestId;
      const guestName = session.guestName || "Guest";

      const chunkDir = getChunkDir(meetId, guestId);
      const chunkFiles = listChunkFiles(chunkDir);
      const totalBytes = chunkFilesSize(chunkFiles);

      if (!chunkFiles.length || totalBytes === 0) {
        cleanupChunkDir(meetId, guestId);
        return res.json({
          success: true,
          skipped: true,
          message: "No audio captured for this guest",
        });
      }

      const mimeType = clientMimeType || "audio/webm";
      const ext = mimeType.includes("mp4")
        ? "mp4"
        : mimeType.includes("ogg")
          ? "ogg"
          : "webm";
      const safeName =
        guestName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20) || guestId;
      const baseFileName = `${safeName}_audio_${meetId}.${ext}`;

      const driveResult = await uploadAudioToDrive(
        chunkFiles,
        baseFileName,
        mimeType,
        meetId,
      );
      const docId = `${meetId}_${guestId}_${Date.now()}`;

      await db
        .collection("meeting_audio_recordings")
        .doc(docId)
        .set({
          meetId,
          employeeId: guestId,
          employeeName: guestName,
          firstName: guestName.split(" ")[0],
          fileName: driveResult.fileName,
          mimeType,
          fileSize: totalBytes,
          driveFileId: driveResult.fileId,
          driveViewUrl: driveResult.viewUrl,
          driveDownloadUrl: driveResult.downloadUrl,
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: "uploaded",
          isRejoin: false,
          isGuest: true,
          speechIntervals: Array.isArray(speechIntervals)
            ? speechIntervals
            : [],
        });

      cleanupChunkDir(meetId, guestId);
      console.log(`[GuestAudioFinalize] ✅ ${driveResult.fileName}`);

      if (io) {
        io.to(`meeting_${meetId}`).emit("audio_upload_complete", {
          employeeId: guestId,
          employeeName: guestName,
          fileName: driveResult.fileName,
          driveViewUrl: driveResult.viewUrl,
        });
      }

      res.json({
        success: true,
        fileName: driveResult.fileName,
        driveViewUrl: driveResult.viewUrl,
        driveDownloadUrl: driveResult.downloadUrl,
        driveFileId: driveResult.fileId,
        fileSize: totalBytes,
      });
    } catch (e) {
      console.error("[GuestAudioFinalize] Error:", e.stack || e.message);
      res.status(500).json({ error: e.message });
    }
  });

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

        const recordings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        res.json({ success: true, recordings });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
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
        const mimeType =
          req.query.mimeType || req.body?.mimeType || "audio/webm";
        const bodyToken = req.body?.token; // token sent in FormData body (beacon can't set headers)

        // Validate token from body
        let employeeId;
        try {
          const { auth } = require("../../config/firebaseAdmin");
          const decoded = await auth.verifyIdToken(bodyToken);
          // Look up employeeId from Firestore
          const { db } = require("../../config/firebaseAdmin");
          const snap = await db
            .collection("cowork_employees")
            .where("authUid", "==", decoded.uid)
            .limit(1)
            .get();
          if (snap.empty) throw new Error("Employee not found");
          employeeId = snap.docs[0].data().employeeId;
        } catch (authErr) {
          console.warn(
            "[BeaconChunk] Token validation failed:",
            authErr.message,
          );
          return res.status(200).json({ success: false }); // always 200 for beacon
        }

        if (!meetId || !employeeId) {
          return res.status(200).json({ error: "meetId required" });
        }

        const audioBuffer =
          req.file?.buffer || (Buffer.isBuffer(req.body) ? req.body : null);
        if (audioBuffer && audioBuffer.length > 100) {
          const chunkDir = getChunkDir(meetId, employeeId);
          fs.mkdirSync(chunkDir, { recursive: true });
          const idx = String(getNextChunkIndex(chunkDir)).padStart(4, "0");
          const ext = mimeType.includes("mp4")
            ? "mp4"
            : mimeType.includes("ogg")
              ? "ogg"
              : "webm";
          fs.writeFileSync(
            path.join(chunkDir, `chunk_${idx}.${ext}`),
            audioBuffer,
          );
          console.log(
            `[BeaconChunk] ✅ Saved emergency chunk for ${employeeId} in ${meetId}`,
          );
        }
        res.status(200).json({ success: true });
      } catch (e) {
        console.error("[BeaconChunk] Error:", e.message);
        res.status(200).json({ success: false });
      }
    },
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

          // Find all employee chunk dirs for this meeting. `safeSegment(meetId)`
          // runs HERE, before the directory is read or touched — this route has
          // no auth token (sendBeacon cannot set headers), so an unvalidated
          // `meetId` of "../../.." would otherwise walk out of TMP_BASE and, via
          // cleanupChunkDir's recursive rmSync, delete somebody else's files.
          const meetTmpDir = containedPath(safeSegment(meetId));
          if (!fs.existsSync(meetTmpDir)) return;

          const employeeDirs = fs.readdirSync(meetTmpDir);
          console.log(
            `[BeaconFinalize] Emergency finalize for meetId=${meetId}, employees=${employeeDirs.join(",")}`,
          );

          for (const empId of employeeDirs) {
            // Skip transient claim dirs (`<id>.merging-…`) and anything else
            // that is not a plain id — a name with a separator would throw in
            // getChunkDir and abort the whole sweep.
            if (!SAFE_ID.test(empId)) continue;
            const chunkDir = getChunkDir(meetId, empId);
            const chunkFiles = listChunkFiles(chunkDir);
            const totalBytes = chunkFilesSize(chunkFiles);
            if (!chunkFiles.length || totalBytes < 100) {
              cleanupChunkDir(meetId, empId);
              continue;
            }

            const ext = (mimeType || "audio/webm").includes("mp4")
              ? "mp4"
              : (mimeType || "").includes("ogg")
                ? "ogg"
                : "webm";
            const safeName = (firstName || empId)
              .split(" ")[0]
              .replace(/[^a-zA-Z0-9]/g, "");
            const fileName = `${empId}_${safeName}_audio_${meetId}.${ext}`;

            try {
              const driveResult = await uploadAudioToDrive(
                chunkFiles,
                fileName,
                mimeType || "audio/webm",
                meetId,
              );

              await db
                .collection("meeting_audio_recordings")
                .doc(`${meetId}_${empId}`)
                .set({
                  meetId,
                  employeeId: empId,
                  fileName,
                  mimeType: mimeType || "audio/webm",
                  fileSize: totalBytes,
                  driveFileId: driveResult.fileId,
                  driveViewUrl: driveResult.viewUrl,
                  driveDownloadUrl: driveResult.downloadUrl,
                  uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                  status: "uploaded_emergency",
                  emergency: true,
                });

              cleanupChunkDir(meetId, empId);
              console.log(
                `[BeaconFinalize] ✅ Emergency upload done: ${fileName}`,
              );
            } catch (uploadErr) {
              console.error(
                `[BeaconFinalize] Upload failed for ${empId}:`,
                uploadErr.message,
              );
            }
          }
        } catch (e) {
          console.error("[BeaconFinalize] Background error:", e.message);
        }
      });
    },
  );

  return router;
};
