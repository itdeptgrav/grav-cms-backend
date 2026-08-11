/**
 * GRAV-CMS-BACKEND/services/shareInvite.service.js
 *
 * The token primitive behind external (no-account) sharing of Cowork
 * documents, sheets and mindmaps.
 *
 * ## Two purposes, one mechanism
 *
 * An **invite token** says "this email address may accept access to this one
 * document/mindmap, at this role". A **guest session token** says "this
 * bearer is the guest identity that accepted one or more invites". They are
 * the same primitive — a random 256-bit value whose SHA-256 hash is the only
 * thing ever stored — for the same reason the Cowork frontend's own
 * `lib/server/tokens.ts` treats its invite and reset tokens as one mechanism:
 * splitting the hashing/comparison/expiry logic into two copies is two
 * chances to get expiry or single-use wrong. This file is that shape,
 * Firestore-backed rather than JSON-file-backed, because it belongs to a
 * different surface (guest access to a real Cowork record) with its own
 * collections and its own reachable-from-anywhere lifetime.
 *
 * ## Only a hash is stored
 *
 * The plaintext token exists exactly twice: once when it is minted (returned
 * to the caller — an HTTP response, or an email body) and once when it is
 * redeemed (carried back in a request). Firestore never sees it. A leaked
 * database therefore yields no usable tokens, same as a password hash.
 *
 * ## Storage
 *
 *  · `cowork_share_invites` — one row per (target, email) invite.
 *  · `cowork_share_guests`  — one row per external PERSON, keyed by email.
 *    Someone invited to three different things by three different owners
 *    gets one identity and one session, not three.
 *
 * ## Why queries are single-field
 *
 * Every Firestore query below filters on exactly one field server-side and
 * narrows further in JS. Chaining multiple `where(...)` equality clauses on
 * different fields would ask Firestore for a composite index this
 * environment cannot deploy ahead of time, and per-target invite/guest counts
 * are small enough that the JS narrowing costs nothing real.
 */

const crypto = require("crypto");
const { db } = require("../config/firebaseAdmin");

const INVITES = "cowork_share_invites";
const GUESTS = "cowork_share_guests";

/** Seven days — long enough that somebody who does not check email daily
    still has time, short enough that a link is not a standing credential. */
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Ninety days. A guest session is a return-visit convenience, not a login —
    there is no refresh path, so it simply lasts long enough to matter and
    then quietly stops working. */
const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** 32 bytes of CSPRNG, base64url. Long enough that guessing is not a
    strategy, so no rate limit on redemption is load-bearing. */
function genToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(plain) {
  return crypto.createHash("sha256").update(String(plain)).digest("hex");
}

/** Constant-time comparison of two hex hashes, in the same spirit as
    `timingSafeEqual` in the frontend's `lib/server/tokens.ts`. */
function hashesEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Mint an invite for one (targetKind, targetId, email).
 *
 * **Re-inviting supersedes.** Any invite still `pending` for the same target
 * and email is revoked first, so a stale earlier link stops working the
 * moment a fresh one is sent rather than leaving two live tokens for the same
 * grant outstanding.
 */
async function createInvite({
  organisationId,
  targetKind,
  targetId,
  email,
  role,
  invitedByEmployeeId,
  invitedByName,
}) {
  const normEmail = normaliseEmail(email);
  const now = nowIso();

  const existing = await db
    .collection(INVITES)
    .where("targetId", "==", String(targetId))
    .get();
  const stale = existing.docs.filter((d) => {
    const data = d.data();
    return (
      data.targetKind === targetKind &&
      data.email === normEmail &&
      data.status === "pending"
    );
  });
  if (stale.length > 0) {
    const batch = db.batch();
    stale.forEach((d) => batch.update(d.ref, { status: "revoked", revokedAt: now }));
    await batch.commit();
  }

  const plaintext = genToken();
  const ref = db.collection(INVITES).doc();
  const record = {
    id: ref.id,
    organisationId,
    targetKind,
    targetId: String(targetId),
    email: normEmail,
    role,
    status: "pending",
    tokenHash: hashToken(plaintext),
    invitedByEmployeeId,
    invitedByName,
    createdAt: now,
    expiresAt: new Date(Date.now() + INVITE_LIFETIME_MS).toISOString(),
    acceptedAt: null,
    guestId: null,
    revokedAt: null,
    revokedByEmployeeId: null,
  };
  await ref.set(record);
  return { record, plaintext };
}

/**
 * The live invite for this plaintext, or `null`.
 *
 * "Live" means pending and unexpired. An expired-but-still-pending row is
 * cleaned up on the way past (`status: "revoked"`) rather than left to
 * accumulate — the same lazy-cleanup-on-lookup the frontend's own token store
 * uses.
 */
async function findLiveInviteByToken(plaintext) {
  const wanted = hashToken(plaintext);
  const snap = await db.collection(INVITES).where("tokenHash", "==", wanted).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  if (!hashesEqual(data.tokenHash, wanted)) return null;
  if (data.status !== "pending") return null;
  if (!data.expiresAt || data.expiresAt <= nowIso()) {
    await doc.ref.update({ status: "revoked", revokedAt: nowIso() });
    return null;
  }
  return { id: doc.id, ref: doc.ref, ...data };
}

/** Every invite row for one target, newest first — for the owner's share panel. */
async function listInvitesForTarget(targetKind, targetId) {
  const snap = await db
    .collection(INVITES)
    .where("targetId", "==", String(targetId))
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.targetKind === targetKind)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Find-or-create the guest identity for one email within one organisation.
 *
 * Keyed by email, not by invite: somebody invited to three different things
 * by three different owners is one person with one identity and, once they
 * hold a session, one session — not three separate guest rows.
 */
async function findOrCreateGuest({ organisationId, email, displayName }) {
  const normEmail = normaliseEmail(email);
  const snap = await db.collection(GUESTS).where("email", "==", normEmail).get();
  const existing = snap.docs.find((d) => d.data().organisationId === organisationId);
  if (existing) return { id: existing.id, ref: existing.ref, ...existing.data() };

  const ref = db.collection(GUESTS).doc();
  const now = nowIso();
  const record = {
    id: ref.id,
    organisationId,
    email: normEmail,
    displayName: displayName || normEmail.split("@")[0],
    createdAt: now,
    lastSeenAt: now,
    grants: [],
    sessionTokenHash: null,
    sessionExpiresAt: null,
  };
  await ref.set(record);
  return { id: ref.id, ref, ...record };
}

/** The live guest for this bearer session token, or `null`. */
async function findLiveGuestBySessionToken(plaintext) {
  const wanted = hashToken(plaintext);
  const snap = await db
    .collection(GUESTS)
    .where("sessionTokenHash", "==", wanted)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  const data = doc.data();
  if (!hashesEqual(data.sessionTokenHash, wanted)) return null;
  if (!data.sessionExpiresAt || data.sessionExpiresAt <= nowIso()) return null;
  return { id: doc.id, ref: doc.ref, ...data };
}

/**
 * Redeem an invite token: verify it, find-or-create the guest, append the
 * grant, mint a fresh session token, mark the invite accepted.
 *
 * A second acceptance of an already-accepted invite is not reachable through
 * this function — `findLiveInviteByToken` only returns `pending` rows, and
 * this is the only place that flips one to `accepted`.
 */
async function acceptInvite(plaintext) {
  const invite = await findLiveInviteByToken(plaintext);
  if (!invite) {
    return { error: "This invite link is invalid, already used, or has expired." };
  }

  const guest = await findOrCreateGuest({
    organisationId: invite.organisationId,
    email: invite.email,
  });

  const now = nowIso();
  const grants = Array.isArray(guest.grants) ? guest.grants.slice() : [];
  const already = grants.find(
    (g) => g.targetKind === invite.targetKind && g.targetId === invite.targetId,
  );
  if (already) {
    already.role = invite.role;
  } else {
    grants.push({
      targetKind: invite.targetKind,
      targetId: invite.targetId,
      role: invite.role,
      addedAt: now,
      invitedByEmployeeId: invite.invitedByEmployeeId,
    });
  }

  const sessionPlaintext = genToken();
  await guest.ref.update({
    grants,
    lastSeenAt: now,
    sessionTokenHash: hashToken(sessionPlaintext),
    sessionExpiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
  });
  await invite.ref.update({ status: "accepted", acceptedAt: now, guestId: guest.id });

  return {
    guestSessionToken: sessionPlaintext,
    targetKind: invite.targetKind,
    targetId: invite.targetId,
    role: invite.role,
  };
}

/**
 * Revoke an invite. If it was already accepted, the matching grant is pulled
 * from the guest's `grants` array in the same batch — a revoked invite must
 * not leave behind a still-live grant it was the only record of.
 *
 * If `grants` becomes empty the guest row is left alone. There is no
 * "kill this session now" path: the session simply stops resolving to
 * anything once every grant behind it is gone, and expires naturally by its
 * own `sessionExpiresAt` regardless.
 */
async function revokeInvite({ inviteId, revokedByEmployeeId }) {
  const ref = db.collection(INVITES).doc(String(inviteId));
  const snap = await ref.get();
  if (!snap.exists) return { error: "Invite not found." };
  const invite = snap.data();
  const now = nowIso();

  const batch = db.batch();
  batch.update(ref, { status: "revoked", revokedAt: now, revokedByEmployeeId });

  if (invite.guestId) {
    const guestRef = db.collection(GUESTS).doc(invite.guestId);
    const guestSnap = await guestRef.get();
    if (guestSnap.exists) {
      const guest = guestSnap.data();
      const grants = (guest.grants || []).filter(
        (g) => !(g.targetKind === invite.targetKind && g.targetId === invite.targetId),
      );
      batch.update(guestRef, { grants });
    }
  }
  await batch.commit();
  return { ok: true, invite };
}

/** The grant a guest holds for one target, or `null`. */
function grantForTarget(guest, targetKind, targetId) {
  return (
    (guest.grants || []).find(
      (g) => g.targetKind === targetKind && g.targetId === String(targetId),
    ) || null
  );
}

module.exports = {
  normaliseEmail,
  createInvite,
  findLiveInviteByToken,
  listInvitesForTarget,
  findOrCreateGuest,
  findLiveGuestBySessionToken,
  acceptInvite,
  revokeInvite,
  grantForTarget,
  INVITE_LIFETIME_MS,
  SESSION_LIFETIME_MS,
};
