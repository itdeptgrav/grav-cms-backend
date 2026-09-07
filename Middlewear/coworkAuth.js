// middlewear/coworkAuth.js

const { auth, db, admin } = require("../config/firebaseAdmin");

// ── In-memory cache (5 min TTL) ──────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function _getCached(uid) {
  const entry = _cache.get(uid);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(uid); return null; }
  return entry.data;
}

function _setCache(uid, data) {
  _cache.set(uid, { data, expiresAt: Date.now() + CACHE_TTL });
}

function invalidateEmployeeCache(uid) {
  if (uid) _cache.delete(uid);
  else _cache.clear();
}

/**
 * Who this Firebase ID token belongs to, as a Cowork employee.
 *
 * **Extracted from `verifyCoworkToken` so SOCKETS can use it too.** Every
 * meeting Socket.IO handler used to trust a client-supplied identity — the
 * emitter said who it was in the payload and the server relayed it — so any
 * connected client could start, pause or irreversibly stop any meeting's
 * recording. Closing that needs the same resolution the HTTP routes do, and
 * the resolution was welded inside an Express middleware.
 *
 * Throws on an unusable token. Callers decide what a failure means: an HTTP
 * route answers 401, and the socket handshake leaves the connection anonymous
 * (the CMS frontend shares this server and never sends a token).
 */
async function resolveCoworkUser(idToken) {
  const decoded = await auth.verifyIdToken(idToken);

  // ── Cache hit — skip Firestore entirely ───────────────────────────────────
  const cached = _getCached(decoded.uid);
  if (cached) return { authUid: decoded.uid, ...cached };

  // ── Cache miss — fetch from Firestore once ────────────────────────────────
  let snap = await db.collection("cowork_employees").where("authUid", "==", decoded.uid).limit(1).get();

  if (snap.empty && decoded.email) {
    snap = await db.collection("cowork_employees").where("email", "==", decoded.email).limit(1).get();
  }

  if (snap.empty) {
    const user = await auth.getUser(decoded.uid);
    const claims = user.customClaims || {};
    if (claims.role === "ceo") {
      const ceoData = {
        employeeId: "E000", authUid: decoded.uid,
        name: user.displayName || "CEO", email: decoded.email || "",
        mobile: "", city: "", department: "Management",
        role: "ceo", profilePicUrl: null, fcmTokens: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await db.collection("cowork_employees").doc("E000").set(ceoData, { merge: true });
      const ceoUser = { employeeId: "E000", role: "ceo", name: ceoData.name, employeeData: ceoData };
      _setCache(decoded.uid, ceoUser);
      return { authUid: decoded.uid, ...ceoUser };
    }
    const err = new Error("Employee not found in Firestore. Ask your CEO.");
    err.status = 403;
    throw err;
  }

  const data = snap.docs[0].data();
  if (!data.authUid) await snap.docs[0].ref.update({ authUid: decoded.uid });

  const empUser = { employeeId: data.employeeId, role: data.role, name: data.name, employeeData: data };
  _setCache(decoded.uid, empUser);
  return { authUid: decoded.uid, ...empUser };
}

async function verifyCoworkToken(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing token" });

    req.coworkUser = await resolveCoworkUser(header.split("Bearer ")[1]);
    next();
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    res.status(401).json({ error: "Auth error: " + err.message });
  }
}

const verifyCeoToken = (req, res, next) => req.coworkUser?.role === "ceo" ? next() : res.status(403).json({ error: "CEO only" });
const verifyCeoOrTL = (req, res, next) => ["ceo", "tl"].includes(req.coworkUser?.role) ? next() : res.status(403).json({ error: "CEO or TL only" });
const verifyEmployeeToken = (req, res, next) => req.coworkUser ? next() : res.status(401).json({ error: "Unauthorized" });

module.exports = { verifyCoworkToken, verifyCeoToken, verifyCeoOrTL, verifyEmployeeToken, invalidateEmployeeCache, resolveCoworkUser };