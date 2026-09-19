/**
 * services/firmwareStorage.js
 *
 * PUTS THE SCANNER FIRMWARE SOMEWHERE THE SCANNERS CAN ACTUALLY READ IT.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * The .bin used to be served off this server's own disk, by this server. That
 * works right up until something sits between the scanner and the disk. It does:
 * api.grav.in is a Cloudflare Tunnel, and cloudflared re-streams every response
 * on its way to the edge. A re-streamed response arrives `Transfer-Encoding:
 * chunked` with no Content-Length.
 *
 * That is fatal for exactly one call. The scanner reads the length UP FRONT to
 * size the flash write (`Update.begin(cl)`), and then reads the raw socket — so
 * on a chunked response it would be writing chunk framing into flash. Its guard
 * catches that and shows "Wrong file / No size sent", which is correct, and
 * which means no device behind the tunnel can ever update. Caching it at the
 * edge does not help: Cloudflare serves the cached copy chunked too (measured —
 * cf-cache-status: HIT, still no length). Nor does HTTP/1.0, nor Range.
 *
 * Google Cloud Storage answers a plain GET with 200, a real Content-Length and
 * no redirect — which is all the scanner needs — and it does it regardless of
 * which of our servers the device happens to be talking to. That last part is
 * the real win: the binary stops being tied to one machine's disk.
 *
 * ─── Why content-addressed paths ─────────────────────────────────────────────
 * Version numbers get reused here; the same 5.6.4 has been uploaded more than
 * once. If the object path were just the version, a re-upload would overwrite
 * it and every CDN and client cache in between could keep serving the old bytes
 * under a URL that looks correct. The path carries a hash of the file instead,
 * so different bytes are a different object at a different URL. Nothing can go
 * stale, and the previous build stays downloadable for a rollback.
 *
 * ─── Failure is not fatal ────────────────────────────────────────────────────
 * Every function here returns null rather than throwing. An upload that cannot
 * reach Google must still succeed locally — the file is on disk either way, and
 * the old server-served URL still works for anything on the same network. This
 * adds a better path; it does not become a new way for uploads to fail.
 */

const crypto = require("crypto");

const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || "";

/** Short, stable identifier for a specific set of bytes. */
function fingerprint(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 12);
}

/** Object path for a build. Content-addressed — see the note above. */
function objectPathFor(version, buffer) {
  const safeVersion = String(version).replace(/[^A-Za-z0-9._-]/g, "_");
  return `firmware/${safeVersion}/${fingerprint(buffer)}/app.bin`;
}

/**
 * Upload a firmware image and return a URL any scanner can GET.
 *
 * @returns {Promise<string|null>} public URL, or null if storage is unavailable
 */
async function uploadFirmware(version, buffer) {
  if (!BUCKET_NAME) {
    console.warn("[FirmwareStorage] FIREBASE_STORAGE_BUCKET not set — skipping upload");
    return null;
  }
  try {
    const { admin } = require("../config/firebaseAdmin");
    const bucket = admin.storage().bucket(BUCKET_NAME);
    const objectPath = objectPathFor(version, buffer);
    const file = bucket.file(objectPath);

    await file.save(buffer, {
      resumable: false,
      contentType: "application/octet-stream",
      metadata: {
        /* Immutable is honest here: the path contains a hash of these exact
           bytes, so this object can never legitimately change. */
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    /* The scanner has no credentials and cannot follow a redirect, so the
       object has to be readable by an anonymous plain GET. If the bucket
       forbids per-object ACLs (uniform access with public prevention on), this
       throws and we fall back to a signed URL below. */
    try {
      await file.makePublic();
      const url = `https://storage.googleapis.com/${BUCKET_NAME}/${objectPath}`;
      console.log(`[FirmwareStorage] uploaded ${version} -> ${url}`);
      return url;
    } catch (aclErr) {
      console.warn(
        `[FirmwareStorage] makePublic failed (${aclErr.message}) — trying a signed URL`
      );
      const [signed] = await file.getSignedUrl({
        action: "read",
        // Far enough out that a build stays installable for its whole life.
        expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
      });
      console.log(`[FirmwareStorage] uploaded ${version} -> signed URL`);
      return signed;
    }
  } catch (err) {
    console.error("[FirmwareStorage] upload failed:", err.message);
    return null;
  }
}

module.exports = { uploadFirmware, objectPathFor, fingerprint };
