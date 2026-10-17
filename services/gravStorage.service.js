"use strict";

/*
 * GRAV STORAGE — the private object store used by Studio design deliveries.
 *
 * This service is intentionally small: callers own the business record and
 * access decision; this module owns only the server-to-server upload. The
 * browser and GRAV Studio must never receive this key.
 */

const crypto = require("crypto");

const STORAGE_URL = () => String(process.env.GRAV_STORAGE_URL || "").replace(/\/+$/, "");
const STORAGE_KEY = () => String(process.env.GRAV_STORAGE_API_KEY || "").trim();

function configured() {
  return Boolean(STORAGE_URL() && STORAGE_KEY());
}

function unavailable() {
  const error = new Error("GRAV_STORAGE_UNAVAILABLE");
  error.code = "GRAV_STORAGE_UNAVAILABLE";
  return error;
}

function storageError(status, body) {
  let message = "Grav Storage rejected the file.";
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.error || parsed?.message || message;
  } catch (_) { /* a proxy error may be HTML */ }
  const error = new Error(message);
  error.code = "GRAV_STORAGE_ERROR";
  error.status = status;
  return error;
}

function fileFromResponse(payload) {
  const data = payload?.data || payload || {};
  const file = data.file || data;
  const fileId = file.fileId || file.id;
  if (!fileId) {
    const error = new Error("Grav Storage did not return a file id.");
    error.code = "GRAV_STORAGE_INVALID_RESPONSE";
    throw error;
  }
  return {
    storageFileId: String(fileId),
    bytes: Number(file.bytes ?? file.size ?? 0) || 0,
    sha256: String(file.sha256 || ""),
  };
}

/**
 * Upload one already-validated Studio part. The CMS retains the purpose and
 * style relation in MongoDB; Grav Storage receives only private bytes.
 */
async function uploadBuffer(buffer, { fileName, mimeType }) {
  if (!configured()) throw unavailable();
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error("A Studio asset has no bytes.");
    error.code = "STUDIO_ASSET_EMPTY";
    throw error;
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), fileName);

  const response = await fetch(`${STORAGE_URL()}/api/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STORAGE_KEY()}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) throw storageError(response.status, body);

  const stored = fileFromResponse(JSON.parse(body));
  return {
    ...stored,
    fileName: String(fileName || "asset"),
    mimeType: String(mimeType || "application/octet-stream"),
    bytes: stored.bytes || buffer.length,
    sha256: stored.sha256 || crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function readFile(storageFileId, { range } = {}) {
  if (!configured()) throw unavailable();
  const headers = { Authorization: `Bearer ${STORAGE_KEY()}` };
  if (range) headers.Range = range;
  const response = await fetch(`${STORAGE_URL()}/api/v1/files/${encodeURIComponent(storageFileId)}`, { headers });
  if (!response.ok) throw storageError(response.status, await response.text());
  return response;
}

module.exports = { configured, uploadBuffer, readFile };
