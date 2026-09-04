// routes/task_routes/coworkQrSignIn.js
//
// "Smart sign-in" — sign in to CoWork on a second device by scanning a QR code
// shown on a device that is already signed in.
//
// ── The security shape, because this is a bearer credential on a screen ─────
//
// A QR code that signs somebody in IS their password for as long as it is
// valid. Anyone who can see the screen — a colleague, a shoulder, a phone
// camera across the room, a screen share nobody meant to leave running — can
// photograph it. That is not a hypothetical; it is the ordinary way this
// feature gets abused, and it is why the CMS's employee QR (a plain
// `https://grav.in/employee/<id>` URL on an ID card) is NOT the format used
// here. That one is an identifier and safe to print. This one is a credential
// and must never be printable.
//
// Four properties carry the weight:
//
//  1. **Short-lived.** Ninety seconds. Long enough to walk a laptop's webcam to
//     a phone, far too short for a photograph to be useful later.
//  2. **Single-use.** Redemption flips the record inside a Firestore
//     transaction, so two devices racing the same code cannot both win. The
//     genuine scanner and a photographer cannot both get in; whoever is second
//     gets nothing.
//  3. **Only a HASH is stored.** The plaintext exists in the QR image and
//     nowhere else — the same reasoning `Cowork/lib/server/tokens.ts` gives for
//     credential tokens. A leaked Firestore export yields no usable codes.
//  4. **It is refreshed while displayed, and revoked when dismissed.** The
//     profile re-issues before expiry so the visible code is never the one that
//     was on screen a minute ago, and closing the panel deletes the outstanding
//     record rather than leaving it live for its remaining seconds.
//
// What this deliberately does NOT do: it does not widen who may sign in. The
// custom token is minted for the SAME `authUid` that presented a valid ID token
// to `/issue`. Only somebody already signed in can create one, and it can only
// ever produce a session for themselves — this is a second door into one
// account, never a door into somebody else's.

const express = require("express");
const router = express.Router();
const crypto = require("crypto");

const { db, auth: firebaseAuth, admin } = require("../../config/firebaseAdmin");
const { verifyCoworkToken } = require("../../Middlewear/coworkAuth");

const QR_CODES = "cowork_qr_signin";

/**
 * Ninety seconds.
 *
 * Chosen against the actual task: unlock the phone, open the profile, hold it
 * up, let a webcam focus. Sixty was tried on paper and is tight enough that a
 * slow camera would routinely expire mid-scan, which trains people to keep
 * re-issuing and defeats the point. Anything approaching five minutes turns a
 * photograph into a working key, which is exactly what this must not be.
 */
const TTL_MS = 90 * 1000;

/**
 * A cap on outstanding codes per account.
 *
 * Without it, a page left open re-issuing every eighty seconds accumulates
 * live records indefinitely, each one a valid credential. Issuing deletes the
 * caller's previous codes first, so exactly one is live per account at a time —
 * which also means "I re-opened the panel" silently invalidates the code that
 * was on the old screen, and that is the behaviour you want.
 */

/** Redemption attempts per IP per window. */
const REDEEM_WINDOW_MS = 60 * 1000;
const REDEEM_MAX_PER_WINDOW = 20;
const redeemHits = new Map();

const sweeper = setInterval(() => {
  const cutoff = Date.now() - REDEEM_WINDOW_MS;
  for (const [ip, hits] of redeemHits) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length) redeemHits.set(ip, live);
    else redeemHits.delete(ip);
  }
}, 5 * 60 * 1000);
if (typeof sweeper.unref === "function") sweeper.unref();

function rateLimited(ip) {
  const now = Date.now();
  const hits = (redeemHits.get(ip) || []).filter((t) => t > now - REDEEM_WINDOW_MS);
  hits.push(now);
  redeemHits.set(ip, hits);
  return hits.length > REDEEM_MAX_PER_WINDOW;
}

const hashToken = (plain) => crypto.createHash("sha256").update(plain).digest("hex");

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/qr/issue — authenticated

   Called by the profile's "Share Dashboard" panel, and again by its own
   refresh timer. Returns the PLAINTEXT once; nothing can read it back.
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/qr/issue", verifyCoworkToken, async (req, res) => {
  try {
    const { authUid, employeeId, name } = req.coworkUser;

    /* One live code per account. The previous one dies here rather than
       lingering for its remaining seconds on a screen somebody has walked away
       from. Deleting BEFORE writing the new record means a crash between the
       two leaves zero valid codes, never two. */
    const existing = await db.collection(QR_CODES).where("authUid", "==", authUid).get();
    if (!existing.empty) {
      const batch = db.batch();
      existing.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    /* 32 bytes of CSPRNG. Guessing is not a strategy against this, which is
       what lets the redemption rate limit be about mail-bombing and log noise
       rather than about brute force. */
    const plaintext = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + TTL_MS);

    await db.collection(QR_CODES).doc(hashToken(plaintext)).set({
      authUid,
      employeeId: employeeId || null,
      displayName: name || null,
      expiresAt,
      redeemedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      /* The token, not a URL. The client builds the URL from its OWN origin —
         a base URL configured here would be one more place to get wrong across
         local, tunnel and production, and getting it wrong would produce a QR
         that sends people to a host they cannot reach. */
      token: plaintext,
      expiresAt: expiresAt.toISOString(),
      ttlMs: TTL_MS,
    });
  } catch (err) {
    console.error("[coworkQrSignIn/issue]", err);
    res.status(500).json({ success: false, message: "Could not create a sign-in code." });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/qr/revoke — authenticated

   Closing the panel should not leave a live credential behind. Best-effort by
   design: the TTL is the real guarantee and this is the courtesy on top of it,
   so a failed revoke is not worth an error on screen.
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/qr/revoke", verifyCoworkToken, async (req, res) => {
  try {
    const { authUid } = req.coworkUser;
    const existing = await db.collection(QR_CODES).where("authUid", "==", authUid).get();
    if (!existing.empty) {
      const batch = db.batch();
      existing.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("[coworkQrSignIn/revoke]", err);
    res.status(500).json({ success: false });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   POST /cowork/auth/qr/redeem — PUBLIC, by necessity

   The device redeeming has no session; obtaining one is the point. Everything
   that makes this safe is above: the code is unguessable, expires in ninety
   seconds, and dies on first use.
   ═══════════════════════════════════════════════════════════════════════════ */
router.post("/auth/qr/redeem", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    if (rateLimited(String(ip))) {
      return res
        .status(429)
        .json({ success: false, message: "Too many attempts. Wait a minute and try again." });
    }

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ success: false, message: "That code is not readable." });
    }

    const ref = db.collection(QR_CODES).doc(hashToken(token));

    /* A transaction, and this is the single-use guarantee.
       A read-then-write would let two requests both read "unredeemed" before
       either wrote — which is precisely the photographed-code race this feature
       has to lose safely. Firestore retries the transaction on contention, so
       exactly one caller observes the unredeemed state. */
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      // `.exists` is a property, not a method — see coworkPasswordReset.js.
      if (!snap.exists) return { ok: false, reason: "unknown" };

      const record = snap.data();
      if (record.redeemedAt) return { ok: false, reason: "spent" };
      if (!record.expiresAt || record.expiresAt.toMillis() < Date.now()) {
        return { ok: false, reason: "expired" };
      }

      /* Marked rather than deleted, so a second attempt can be told "already
         used" instead of "never existed". Those are different situations —
         one is a stale screen, the other is a code that was intercepted — and
         a swept-up record loses that distinction. The sweep below clears them
         once they can no longer be confused with anything. */
      tx.update(ref, { redeemedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ok: true, authUid: record.authUid };
    });

    if (!claim.ok) {
      const message =
        claim.reason === "spent"
          ? "That code has already been used. Open Share Dashboard again for a fresh one."
          : claim.reason === "expired"
            ? "That code has expired. Open Share Dashboard again for a fresh one."
            : "That code is not valid. Open Share Dashboard again for a fresh one.";
      return res.status(400).json({ success: false, message });
    }

    /* Resolved again at redemption. A code issued ninety seconds ago by an
       account disabled since must not still open a session — the same
       re-resolve the password reset does, for the same reason. */
    let user;
    try {
      user = await firebaseAuth.getUser(claim.authUid);
    } catch {
      return res.status(400).json({ success: false, message: "That account is no longer available." });
    }
    if (user.disabled) {
      return res.status(403).json({ success: false, message: "That account has been disabled." });
    }

    const customToken = await firebaseAuth.createCustomToken(claim.authUid);

    /* The same handoff `/sso` already consumes — see deptAuth.js's cowork-sso
       route and Cowork's SsoConsumer. Reusing the mechanism means the scanned
       sign-in and the CMS sign-in land in identical sessions, and there is only
       one path to keep correct. */
    return res.json({ success: true, token: customToken });
  } catch (err) {
    console.error("[coworkQrSignIn/redeem]", err);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

/**
 * Clear spent and expired records.
 *
 * They are harmless — neither can be redeemed — but they are a growing list of
 * who signed in and when, kept for no reason. Swept an hour after expiry, which
 * is long enough that "already used" stays answerable for anybody looking at a
 * stale screen.
 */
async function sweepExpiredQrCodes() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const stale = await db.collection(QR_CODES).where("expiresAt", "<", cutoff).limit(200).get();
    if (stale.empty) return;
    const batch = db.batch();
    stale.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (err) {
    console.error("[coworkQrSignIn/sweep]", err.message);
  }
}

module.exports = router;
module.exports.sweepExpiredQrCodes = sweepExpiredQrCodes;
