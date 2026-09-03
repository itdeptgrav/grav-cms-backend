/**
 * GRAV-CMS-BACKEND/utils/letterDownloadToken.js
 *
 * Short-lived, single-purpose tokens that authorise ONE letter download.
 *
 * WHY A TOKEN AT ALL: employee letters now live in PRIVATE Google Drive and
 * are streamed back through our own route, so there is no public URL to open.
 * But both clients open the file the only way a PDF can be opened — the app
 * hands it to `Linking.openURL`, the CMS to a new browser tab — and neither of
 * those carries an Authorization header. The credential therefore has to be in
 * the URL, which means it has to be worthless a few minutes later.
 *
 * WHY NOT A JWT SIGNED WITH JWT_SECRET: it would verify inside
 * EmployeeAuthMiddlewear, which does nothing but `jwt.verify` and then trusts
 * the payload. A download link pasted into an Authorization header would then
 * be a session. This uses a SEPARATE derived key and a format that is not a
 * JWT at all, so a letter token is structurally incapable of authenticating a
 * request anywhere else in the app.
 *
 * The token is not the authorisation. The download route still re-runs the
 * full gate — ownership for an employee, `released: true` for an employee,
 * HR role for HR — on every single request. This only proves the link was
 * issued by us, recently, for this document and this reader. Withdrawing a
 * letter takes effect immediately even for someone holding a live token.
 */

const crypto = require("crypto");

/** Distinct from JWT_SECRET by construction, derived from it so there is no
    second secret to configure or rotate. */
function key() {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("JWT_SECRET is not set");
  return crypto.createHash("sha256").update(`${base}::employee-letter-download`).digest();
}

const b64u = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) =>
  Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @param docId    the EmployeeDocument _id this link opens, and only this one
 * @param scope    "hr" | "employee" — which gate the download route applies
 * @param subject  the id of the reader the link was minted for
 */
function mintLetterToken({ docId, fileId, scope, subject, ttlMs = DEFAULT_TTL_MS }) {
  const payload = {
    d: String(docId),
    s: String(scope),
    u: String(subject || ""),
    e: Date.now() + ttlMs,
  };
  /* Optional, and only set when the caller names a file. A document that holds
     several files (a front and a back, a ten-page lease) needs a token that
     opens ONE of them — without this, a link to page one opens page ten.
     Omitted when absent so tokens for single-file documents are byte-identical
     to the ones minted before this existed. */
  if (fileId !== undefined && fileId !== null && String(fileId)) {
    payload.f = String(fileId);
  }
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac("sha256", key()).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * @returns the payload, or null. Never throws — a malformed token is simply
 *          not a valid one, and the caller answers 404 either way.
 */
function verifyLetterToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;

    const expected = crypto.createHmac("sha256", key()).update(body).digest();
    const given = unb64u(sig);
    // Length check first: timingSafeEqual throws on a length mismatch.
    if (given.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(given, expected)) return null;

    const payload = JSON.parse(unb64u(body).toString("utf8"));
    if (!payload?.d || !payload?.s) return null;
    if (!Number.isFinite(payload.e) || payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Absolute URL for a download route, honouring a proxy's forwarded headers. */
function absoluteUrl(req, path) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0];
  const host = req.get("host");
  return `${proto}://${host}${path}`;
}

module.exports = { mintLetterToken, verifyLetterToken, absoluteUrl, DEFAULT_TTL_MS };
