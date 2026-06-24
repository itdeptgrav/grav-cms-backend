// services/accountantBackup.service.js
//
// Disaster-recovery backups for the accountant module.
//
// WHAT IT DOES
//   • Dumps every `acc_*` collection in the database to a single gzipped
//     EJSON file and uploads it to a dedicated Google Drive folder
//     ("GRAV Accounts Backups", or GOOGLE_DRIVE_BACKUP_FOLDER_ID).
//   • Lists / downloads those files straight from Drive (works even when the
//     database has been wiped — restore does not depend on any DB rows).
//   • Restores a backup back into MongoDB in one of two modes:
//       - "merge"    : upsert by _id. Recovers deleted rows and reverts
//                      changed rows to the backup state. Never deletes rows
//                      that exist now but weren't in the backup. (SAFE)
//       - "replace"  : per collection, wipe then reinsert exactly the backup.
//                      Restores the precise backup state, dropping anything
//                      newer. (DESTRUCTIVE — caller gates this.)
//   • Always takes a "pre-restore" safety snapshot before restoring.
//
// WHY EJSON
//   Plain JSON loses ObjectId and Date types. MongoDB Extended JSON (via the
//   `bson` package that ships with mongoose) round-trips them exactly, so a
//   restored document is byte-for-byte the original — every number, every id,
//   every reference intact.
//
// AUTH
//   Reuses the same service account as the rest of the app
//   (GOOGLE_SERVICE_ACCOUNT_KEY). No per-user OAuth, no token expiry.
//
// SCOPE NOTE
//   This dumps the ENTIRE accountant dataset (all `acc_*` collections), which
//   is correct for a single-business deployment that owns its database. If
//   this app is ever resold to multiple independent businesses sharing one
//   database, backup/restore would need per-tenant scoping.

const mongoose = require("mongoose");
const zlib = require("zlib");
const { google } = require("googleapis");
const { Readable } = require("stream");

// EJSON (Extended JSON) preserves ObjectId/Date/Decimal128 exactly on restore.
// It ships with mongoose's bundled bson, but HOW it's exposed varies by version
// and npm can nest the `bson` package so a bare require("bson") fails. Resolve
// it defensively and lazily so module load never breaks the route mount — if it
// genuinely can't be found, only an actual backup/restore call errors (with a
// clear message), not the whole Settings tab.
let _ejson = null;
function getEJSON() {
  if (_ejson) return _ejson;
  const tries = [
    () => require("bson").EJSON,
    () => require("mongoose").mongo.BSON.EJSON,
    () => require("mongodb").BSON.EJSON,
  ];
  for (const t of tries) {
    try {
      const e = t();
      if (e && typeof e.stringify === "function") {
        _ejson = e;
        return _ejson;
      }
    } catch (_e) {
      /* try the next source */
    }
  }
  throw new Error(
    "Could not load EJSON (bson) — it normally ships with mongoose. Ensure mongoose is installed.",
  );
}

const {
  Acc_BackupConfig,
  Acc_BackupRecord,
} = require("../models/Accountant_model/Acc_BackupModels");

const BACKUP_FOLDER_NAME = "GRAV Accounts Backups";

// ─────────────────────────────────────────────────────────────────────────
// Service-account Drive auth (same pattern as voucherDriveUpload.service.js)
// ─────────────────────────────────────────────────────────────────────────
function getServiceAccountAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set in .env");
  }
  let key;
  try {
    key = JSON.parse(keyJson);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: " + e.message,
    );
  }
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

// ─────────────────────────────────────────────────────────────────────────
// OAuth — the USER's own Google account (Connect button flow)
// ─────────────────────────────────────────────────────────────────────────
// drive.file = the app can only see/manage files IT created (the backups),
// never the rest of the user's Drive. userinfo.email = just to show which
// account is connected.
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
];

function getOAuth2Client() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!id || !secret || !redirect) {
    throw new Error(
      "Google sign-in isn't set up on the server yet. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI.",
    );
  }
  return new google.auth.OAuth2(id, secret, redirect);
}

function buildAuthUrl(state) {
  return getOAuth2Client().generateAuthUrl({
    access_type: "offline", // needed to receive a refresh token
    prompt: "consent", // force a refresh token even on re-connect
    scope: OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

async function exchangeCodeForTokens(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let email = "";
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email || "";
  } catch (_e) {
    /* email is best-effort, not required */
  }
  return { tokens, email };
}

async function revokeGoogleToken(refreshToken) {
  if (!refreshToken) return;
  try {
    await getOAuth2Client().revokeToken(refreshToken);
  } catch (_e) {
    /* best-effort — the user may have already revoked it */
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Pick the right authenticated Drive client based on configured mode.
// "oauth" (+ a stored refresh token) → the user's own Drive.
// otherwise → the server's service account.
// ─────────────────────────────────────────────────────────────────────────
async function getAuthedDrive() {
  const cfg = await Acc_BackupConfig.getSingleton();
  if (cfg.driveMode === "oauth" && cfg.googleRefreshToken) {
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: cfg.googleRefreshToken });
    return {
      drive: google.drive({ version: "v3", auth: client }),
      mode: "oauth",
    };
  }
  return {
    drive: google.drive({ version: "v3", auth: getServiceAccountAuth() }),
    mode: "service",
  };
}

// Folder id is cached per mode (the service-account folder and the user's
// own-Drive folder are different places).
const _folderCache = { service: null, oauth: null };

async function getOrCreateBackupFolder(drive, mode) {
  // An explicit env folder only applies to the service-account destination.
  if (mode === "service" && process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID) {
    return process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;
  }
  if (_folderCache[mode]) return _folderCache[mode];

  const safeName = BACKUP_FOLDER_NAME.replace(/'/g, "\\'");
  try {
    const search = await drive.files.list({
      q: `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (search.data.files && search.data.files.length > 0) {
      _folderCache[mode] = search.data.files[0].id;
      return _folderCache[mode];
    }
  } catch (e) {
    console.warn("[backup] folder search failed:", e.message);
  }

  // For oauth (user's own Drive) the folder is created in their root; for the
  // service account it goes under the optional shared-drive parent.
  const parentId =
    mode === "service" ? process.env.GOOGLE_DRIVE_FOLDER_ID || null : null;
  const folder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  _folderCache[mode] = folder.data.id;
  return _folderCache[mode];
}

// ─────────────────────────────────────────────────────────────────────────
// Dump — read every acc_* collection into a gzipped EJSON buffer
// ─────────────────────────────────────────────────────────────────────────
// These meta collections are NOT business data and would carry the Google
// refresh token into a backup file — exclude them from dumps and restores.
const EXCLUDED_COLLECTIONS = new Set([
  "acc_backup_config",
  "acc_backup_records",
]);

async function listAccCollections() {
  const all = await mongoose.connection.db.listCollections().toArray();
  return all
    .filter(
      (c) =>
        c.type === "collection" &&
        /^acc_/i.test(c.name) &&
        !EXCLUDED_COLLECTIONS.has(c.name.toLowerCase()),
    )
    .map((c) => c.name)
    .sort();
}

async function buildBackupBuffer() {
  const db = mongoose.connection.db;
  const names = await listAccCollections();

  const payload = {
    meta: {
      format: "grav-accountant-backup",
      version: 1,
      createdAt: new Date(),
      collectionsCount: names.length,
    },
    collections: {},
  };

  const summary = [];
  let totalDocs = 0;

  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    payload.collections[name] = docs;
    summary.push({ name, count: docs.length });
    totalDocs += docs.length;
  }
  payload.meta.totalDocs = totalDocs;

  // Canonical EJSON preserves ObjectId/Date/Decimal128 exactly on restore.
  const ejson = getEJSON().stringify(payload, { relaxed: false });
  const gz = zlib.gzipSync(Buffer.from(ejson, "utf8"));

  return { buffer: gz, summary, totalDocs };
}

function backupFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate(),
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `grav-accounts-backup-${stamp}.json.gz`;
}

async function uploadBackup(buffer, fileName) {
  const { drive, mode } = await getAuthedDrive();
  const folderId = await getOrCreateBackupFolder(drive, mode);

  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);

  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      mimeType: "application/gzip",
      parents: folderId ? [folderId] : [],
    },
    media: { mimeType: "application/gzip", body: readable },
    fields: "id, name, size",
  });
  return res.data; // { id, name, size }
}

async function downloadBackupBuffer(fileId) {
  const { drive } = await getAuthedDrive();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data);
}

async function listDriveBackups() {
  const { drive, mode } = await getAuthedDrive();
  const folderId = await getOrCreateBackupFolder(drive, mode);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name, size, createdTime)",
    orderBy: "createdTime desc",
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).map((f) => ({
    fileId: f.id,
    name: f.name,
    sizeBytes: f.size ? Number(f.size) : 0,
    createdTime: f.createdTime,
  }));
}

async function deleteDriveFile(fileId) {
  const { drive } = await getAuthedDrive();
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
    return true;
  } catch (e) {
    console.warn("[backup] delete failed for", fileId, e.message);
    return false;
  }
}

// Drive stream for the download route (so large files don't sit in memory).
async function streamDriveFile(fileId) {
  const { drive } = await getAuthedDrive();
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, size, mimeType",
    supportsAllDrives: true,
  });
  const resp = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );
  return {
    stream: resp.data,
    meta: {
      name: meta.data.name,
      mimeType: meta.data.mimeType || "application/gzip",
      size: meta.data.size ? Number(meta.data.size) : undefined,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Retention — keep the newest N backups, prune the rest (Drive + records)
// ─────────────────────────────────────────────────────────────────────────
async function pruneOldBackups(retentionCount) {
  if (!retentionCount || retentionCount <= 0) return;
  try {
    const files = await listDriveBackups(); // newest first
    const stale = files.slice(retentionCount);
    for (const f of stale) {
      await deleteDriveFile(f.fileId);
      await Acc_BackupRecord.deleteMany({ fileId: f.fileId });
    }
  } catch (e) {
    console.warn("[backup] prune failed:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// runBackup — the full happy path: dump → upload → record → prune
// ─────────────────────────────────────────────────────────────────────────
async function runBackup({
  trigger = "manual",
  byName = "",
  prune = true,
} = {}) {
  const cfg = await Acc_BackupConfig.getSingleton();
  try {
    const { buffer, summary, totalDocs } = await buildBackupBuffer();
    const fileName = backupFileName();
    const uploaded = await uploadBackup(buffer, fileName);

    const record = await Acc_BackupRecord.create({
      fileId: uploaded.id,
      fileName: uploaded.name || fileName,
      sizeBytes: uploaded.size ? Number(uploaded.size) : buffer.length,
      totalDocs,
      collections: summary,
      trigger,
      status: "success",
      createdByName: byName,
    });

    cfg.lastRunAt = new Date();
    cfg.lastStatus = "success";
    cfg.lastError = "";
    cfg.lastFileId = uploaded.id;
    await cfg.save();

    if (prune) await pruneOldBackups(cfg.retentionCount);

    return record;
  } catch (e) {
    try {
      await Acc_BackupRecord.create({
        trigger,
        status: "failed",
        error: e.message,
        createdByName: byName,
      });
      cfg.lastRunAt = new Date();
      cfg.lastStatus = "failed";
      cfg.lastError = e.message;
      await cfg.save();
    } catch (_inner) {
      /* swallow — original error is what matters */
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Restore
// ─────────────────────────────────────────────────────────────────────────
function parseBackupBuffer(buffer) {
  let raw = buffer;
  // Gunzip if it looks gzipped (magic bytes 0x1f 0x8b); tolerate plain too.
  if (
    buffer &&
    buffer.length >= 2 &&
    buffer[0] === 0x1f &&
    buffer[1] === 0x8b
  ) {
    raw = zlib.gunzipSync(buffer);
  }
  const obj = getEJSON().parse(raw.toString("utf8"), { relaxed: false });
  if (!obj || !obj.collections || typeof obj.collections !== "object") {
    throw new Error("This file is not a valid GRAV accounts backup.");
  }
  return obj;
}

async function restoreFromBuffer(buffer, { mode = "merge" } = {}) {
  const obj = parseBackupBuffer(buffer);
  const db = mongoose.connection.db;
  const result = { mode, collections: [], totalWritten: 0 };

  for (const [name, docs] of Object.entries(obj.collections)) {
    if (!Array.isArray(docs)) continue;
    const coll = db.collection(name);

    if (mode === "replace") {
      await coll.deleteMany({});
    }

    let written = 0;
    if (docs.length) {
      // Chunk to keep bulkWrite payloads reasonable.
      const CHUNK = 500;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const slice = docs.slice(i, i + CHUNK);
        const ops = slice.map((doc) => ({
          replaceOne: {
            filter: { _id: doc._id },
            replacement: doc,
            upsert: true,
          },
        }));
        const res = await coll.bulkWrite(ops, { ordered: false });
        written +=
          (res.upsertedCount || 0) +
          (res.modifiedCount || 0) +
          (res.insertedCount || 0);
      }
    }

    result.collections.push({ name, docs: docs.length, written });
    result.totalWritten += written;
  }

  return result;
}

async function restoreFromDrive(fileId, { mode = "merge" } = {}) {
  const buffer = await downloadBackupBuffer(fileId);
  return restoreFromBuffer(buffer, { mode });
}

// Connection test — proves the active account can reach Drive.
async function testDriveConnection() {
  const { drive, mode } = await getAuthedDrive();
  const res = await drive.about.get({ fields: "user" });
  return {
    ok: true,
    mode,
    email: res.data.user?.emailAddress || "connected",
  };
}

module.exports = {
  listAccCollections,
  buildBackupBuffer,
  runBackup,
  listDriveBackups,
  streamDriveFile,
  downloadBackupBuffer,
  restoreFromBuffer,
  restoreFromDrive,
  deleteDriveFile,
  testDriveConnection,
  // OAuth (user's own Google account)
  buildAuthUrl,
  exchangeCodeForTokens,
  revokeGoogleToken,
};
