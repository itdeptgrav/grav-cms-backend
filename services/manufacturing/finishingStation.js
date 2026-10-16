// services/manufacturing/finishingStation.js
//
// A HAND SCANNER DEVICE AS A REMOTE INPUT TO A FINISHING DASHBOARD.
//
// ── WHY THIS EXISTS (15 Oct 2026, owner) ────────────────────────────────────
// Ironing has three stations and Trimming four. A tablet at each one is
// seven tablets, and the factory already owns ESP32 barcode scanners. So a
// scanner is PAIRED to a stage's dashboard and becomes that dashboard's
// remote input: the operator scans their badge to sign in, scans pieces,
// scans the badge again to sign out — and every piece lands in `finishingscans`
// exactly as a scan made in the browser does, attributed to that operator.
//
// ── THE PAIRING IS TWO TOKENS, AND NO NEW COLLECTION ────────────────────────
// The cluster is at its 500-collection cap (see CLAUDE.md), so nothing here
// may create one. The whole pairing is therefore stateless signatures plus
// fields on `DeviceHeartbeat`, which already holds one document per device:
//
//   PAIR TOKEN   short-lived (10 min), minted when a signed-in person on the
//                stage's Scan page presses "Access this dashboard remotely".
//                It is what the QR code on screen encodes, as `GRAVSTN:<jwt>`.
//                It names the stage, the company and who issued it. Nothing
//                else. A photograph of the screen is worth ten minutes.
//
//   STATION KEY  long-lived (180 d), minted when a device POSTs a pair token
//                with its deviceId. Bound to THAT deviceId, so a key read off
//                one device is useless on another. The device keeps it in NVS
//                and presents it on every call as `X-Station-Key`.
//
// The pair token is a compact HMAC string (see below — it has to fit a QR a
// hand scanner reads at once); the station key is HS256 under a distinct
// `purpose` claim, so it cannot be presented as a user session nor a session
// as a key.
//
// The binding — which stage this device serves, who is signed in on it, the
// last few operator sessions — is written on `DeviceHeartbeat.station`. The
// dashboard reads that; an unpair clears it, and the device learns on its
// next heartbeat that it has been let go.
//
// ── WHO A PIECE IS ATTRIBUTED TO ────────────────────────────────────────────
// A badge carries either `identityId` or `biometricId` (they differ by a
// leading zero for some people — services/barcodeScanner/operators.js tells
// the story). Both are tried, and the FinishingScan's `doneBy` becomes the
// employee's own name and id, with `userId` the Employee _id, the same fields
// the browser path fills from the session. A badge nobody matches still
// records the piece — against the raw badge id, flagged `unknown` — because
// a garment was pressed whether or not HR has finished the roster.
"use strict";

const jwt = require("jsonwebtoken");
const { SECRET } = require("../../config/jwt");
const { stageOf } = require("./finishingStages");

const QR_PREFIX = "GRAVSTN:";
const PAIR_PURPOSE = "finishing-station-pair";
const KEY_PURPOSE = "finishing-station";
const PAIR_TTL_SEC = 10 * 60;
const KEY_TTL_SEC = 180 * 24 * 60 * 60;
/* Three missed heartbeats. The device sends one a minute. */
const ONLINE_WINDOW_MS = 3 * 60 * 1000;
/* The session log is a ring on the heartbeat document, not a collection. */
const SESSION_LOG_KEEP = 40;

const str = (v) => (v == null ? "" : String(v).trim());

/* ── TOKENS ─────────────────────────────────────────────────────────────── */

/* ── THE QR IS SMALL ON PURPOSE ──────────────────────────────────────────────
   A JWT is ~230 characters: a version-10 QR, which a hand scanner reads
   slowly or not at all (the carton label went from a 72-char URL to a bare
   13-char number for exactly this reason, 8 Oct 2026). So the pair token is
   a compact signed string, ~55 characters — a version-3/4 QR:

       GRAVSTN:<stage letter>.<company id, 16 chars>.<expiry, base36 minutes>.<issuer, ≤8>.<HMAC, 16 chars>

   Signed with the CMS's JWT secret (HMAC-SHA256, truncated to 96 bits), so a
   factory-PC server and the hosted one — which share that secret and one
   MongoDB — accept each other's QR. Nothing in it is secret; it is worth ten
   minutes of "become this dashboard's input", and only for a device that can
   reach the server. */
const crypto = require("crypto");
const STAGE_LETTER = Object.freeze({ embroidery: "E", printing: "P", washing: "W", trimming: "T", ironing: "I" });
const LETTER_STAGE = Object.freeze(Object.fromEntries(Object.entries(STAGE_LETTER).map(([k, v]) => [v, k])));
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hexToB64u = (hex) => b64u(Buffer.from(hex, "hex"));
const b64uToHex = (s) => { try { return Buffer.from(s, "base64url").toString("hex"); } catch { return ""; } };
const signPayload = (payload) => b64u(crypto.createHmac("sha256", String(SECRET)).update(`${PAIR_PURPOSE}:${payload}`).digest().subarray(0, 12));
const safeTag = (v) => str(v).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8);

/** The QR's payload for one stage, issued by one person. */
function mintPairToken({ stage, companyId, issuedBy, now = Date.now() }) {
  const cid = str(companyId).toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(cid)) throw new Error("companyId must be a 24-hex ObjectId");
  const letter = STAGE_LETTER[stage.slug];
  if (!letter) throw new Error(`no stage letter for ${stage.slug}`);
  const expMin = Math.floor((now + PAIR_TTL_SEC * 1000) / 60000);
  const by = safeTag(issuedBy?.employeeId) || safeTag(issuedBy?.name) || "cms";
  const payload = `${letter}.${hexToB64u(cid)}.${expMin.toString(36)}.${by}`;
  const token = `${payload}.${signPayload(payload)}`;
  return { token, text: QR_PREFIX + token, expiresAt: new Date(expMin * 60000) };
}

/** Reads a pair token (with or without the QR prefix). Returns null when it is not one, or expired. */
function readPairToken(raw, now = Date.now()) {
  let t = str(raw);
  if (t.toUpperCase().startsWith(QR_PREFIX)) t = t.slice(QR_PREFIX.length);
  const parts = t.split(".");
  if (parts.length !== 5) return null;
  const [letter, cidB64, expB36, by, sig] = parts;
  const payload = `${letter}.${cidB64}.${expB36}.${by}`;
  const expect = signPayload(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  const stage = stageOf(LETTER_STAGE[letter]);
  const cid = b64uToHex(cidB64);
  const expMin = parseInt(expB36, 36);
  if (!stage || !/^[0-9a-f]{24}$/.test(cid) || !Number.isFinite(expMin)) return null;
  if (expMin * 60000 < now) return null;
  return { stage, companyId: cid, issuedBy: { userId: "", name: by }, exp: expMin * 60 };
}

/** The device's standing credential. */
function mintStationKey({ deviceId, stage, companyId }) {
  const payload = { p: KEY_PURPOSE, d: str(deviceId).toUpperCase(), s: stage.slug, c: str(companyId) };
  const token = jwt.sign(payload, SECRET, { expiresIn: KEY_TTL_SEC });
  const { exp } = jwt.decode(token);
  return { key: token, expiresAt: new Date(exp * 1000) };
}

/** `{ deviceId, stage, companyId }` or null. */
function readStationKey(raw) {
  const t = str(raw);
  if (!t) return null;
  try {
    const d = jwt.verify(t, SECRET);
    if (d?.p !== KEY_PURPOSE) return null;
    const stage = stageOf(d.s);
    if (!stage || !d.d || !d.c) return null;
    return { deviceId: d.d, stage, companyId: d.c, exp: d.exp };
  } catch {
    return null;
  }
}

/* ── BARCODES THE DEVICE READS ───────────────────────────────────────────── */

const isPieceBarcode = (s) => /^WO-/i.test(str(s));
/* Badges: GR045, GR0045. The firmware uses the same rule. */
const isBadge = (s) => /^GR[0-9A-Z]{2,}$/i.test(str(s));

/* ── OPERATORS ───────────────────────────────────────────────────────────── */

/**
 * Resolve badge ids to people, both badge forms at once, in one query.
 * @returns Map<badgeUpper, { userId, name, employeeId, email, known }>
 */
async function resolveOperators(Employee, badgeIds) {
  const ids = [...new Set((badgeIds || []).map((b) => str(b).toUpperCase()).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  let rows = [];
  try {
    rows = await Employee.find(
      { $or: [{ identityId: { $in: ids } }, { biometricId: { $in: ids } }] },
      { identityId: 1, biometricId: 1, firstName: 1, middleName: 1, lastName: 1, email: 1 },
    ).lean();
  } catch (err) {
    console.error("[finishing-station] operator lookup failed:", err.message);
  }
  const byBadge = new Map();
  for (const e of rows) {
    const name = [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim();
    const person = {
      userId: String(e._id),
      name: name || str(e.identityId || e.biometricId),
      employeeId: str(e.identityId || e.biometricId),
      email: str(e.email).toLowerCase(),
      known: true,
    };
    /* identityId wins where the two collide: it is the CMS's own key. */
    if (e.biometricId && !byBadge.has(str(e.biometricId).toUpperCase())) byBadge.set(str(e.biometricId).toUpperCase(), person);
    if (e.identityId) byBadge.set(str(e.identityId).toUpperCase(), person);
  }
  for (const id of ids) {
    out.set(id, byBadge.get(id) || { userId: "", name: id, employeeId: id, email: "", known: false });
  }
  return out;
}

/** The `doneBy` a device scan writes — the same shape the session path writes. */
const doneByFor = (person, badge) => ({
  userId: person?.userId || "",
  name: person?.name || str(badge),
  employeeId: person?.employeeId || str(badge).toUpperCase(),
  email: person?.email || "",
  role: person?.known ? "operator" : "operator (not in CMS)",
});

/* ── THE STATION RECORD ON THE HEARTBEAT DOCUMENT ────────────────────────── */

/** Is this heartbeat recent enough to call the device online? */
const isOnline = (lastHeartbeatAt, now = Date.now()) =>
  Boolean(lastHeartbeatAt) && now - new Date(lastHeartbeatAt).getTime() <= ONLINE_WINDOW_MS;

/**
 * Apply a signin / signout to a station subdocument, in place. Returns what
 * changed so the caller can say it. Idempotent on a retried event: a signin
 * for the operator already signed in is a no-op, as is a signout for nobody.
 */
function applyOperatorEvent(station, { type, badge, person, at }) {
  const badgeUp = str(badge).toUpperCase();
  const when = at instanceof Date ? at : new Date(at || Date.now());
  station.sessionLog = Array.isArray(station.sessionLog) ? station.sessionLog : [];
  const current = station.operator?.badge ? station.operator : null;

  const closeCurrent = (endAt) => {
    if (!current) return;
    const open = [...station.sessionLog].reverse().find((s) => s.badge === current.badge && !s.signedOutAt);
    if (open) open.signedOutAt = endAt;
    station.operator = null;
  };

  if (type === "signin") {
    if (current && current.badge === badgeUp) return { changed: false };
    if (current) closeCurrent(when); // a second person takes over: the first is out
    station.operator = { badge: badgeUp, name: person?.name || badgeUp, userId: person?.userId || "", known: Boolean(person?.known), signedInAt: when };
    station.sessionLog.push({ badge: badgeUp, name: person?.name || badgeUp, userId: person?.userId || "", signedInAt: when, signedOutAt: null });
    if (station.sessionLog.length > SESSION_LOG_KEEP) station.sessionLog.splice(0, station.sessionLog.length - SESSION_LOG_KEEP);
    return { changed: true };
  }
  if (type === "signout") {
    if (!current) return { changed: false };
    if (badgeUp && current.badge !== badgeUp) return { changed: false };
    closeCurrent(when);
    return { changed: true };
  }
  return { changed: false };
}

module.exports = {
  QR_PREFIX, PAIR_TTL_SEC, KEY_TTL_SEC, ONLINE_WINDOW_MS, SESSION_LOG_KEEP,
  mintPairToken, readPairToken, mintStationKey, readStationKey,
  isPieceBarcode, isBadge, resolveOperators, doneByFor, isOnline, applyOperatorEvent, str,
};
