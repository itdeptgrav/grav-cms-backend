/**
 * GRAV-CMS-BACKEND/routes/task_routes/coworkExternalShare.routes.js
 *
 * Sharing a Cowork document, sheet or mindmap with somebody who is NOT an
 * organisation employee — by email, with a role, no Cowork account required.
 *
 * ## Why this is a separate, parallel system rather than a cheap `DocumentMember`
 *
 * An `employeeId` in a document's or mindmap's `members` array is tied to a
 * real `cowork_employees` record, which is tied to a real Firebase Auth user
 * (see `services/cowork.service.js` and `Middlewear/coworkAuth.js`). Handing
 * that out to an external address would be a much bigger grant than "can see
 * this one document" — it is a workspace identity. So external access is its
 * own identity (`cowork_share_guests`), its own credential (a bearer session
 * token, not a Firebase ID token), and its own authorisation surface (a
 * `grants` array naming exactly which targets it may touch), entirely
 * separate from `cowork_employees` / `verifyCoworkToken`.
 *
 * ## What is re-derived, and why
 *
 * Every owner-only action re-reads the STORED document/mindmap record and
 * checks `members` for an `owner` row belonging to the caller — never
 * anything the request merely claims. This is the same discipline
 * `coworkDocs.routes.js`'s `notify-member` route already applies, for the
 * same reason: a caller having reached this route proves nothing about who
 * they are within it.
 *
 * ## The two authentication regimes on this one file
 *
 * `/invite`, `/invites`, `/invites/:id/revoke` require a normal Cowork
 * employee (`verifyCoworkToken` + `verifyEmployeeToken`) — only an owner may
 * invite, list or revoke. `/accept` and `/guest/*` carry NO Firebase auth at
 * all — the caller may have no Cowork account whatsoever — and are instead
 * gated on the guest bearer token this file itself issues and verifies via
 * `services/shareInvite.service.js`. Mixing the two within one file is
 * deliberate: the four owner-side routes and the two guest-side routes are
 * two faces of the same feature, and splitting them into files would still
 * need this same comment explaining why they must never share a middleware
 * stack.
 */

const express = require("express");
const { db } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const shareInvites = require("../../services/shareInvite.service");
const CustomerEmailService = require("../../services/CustomerEmailService");
const { validateNodes } = require("./coworkMindmaps.js");

const router = express.Router();

const DOCUMENTS = "cowork_documents";
const DOCUMENT_BODIES = "cowork_document_bodies";
const MAPS = "cowork_mindmaps";
const BODIES = "cowork_mindmap_bodies";
const EMPLOYEES = "cowork_employees";

/** Matches `LEGACY_ORGANISATION_ID` in the Cowork client. Legacy is
    single-tenant, so this is a constant rather than derived per request. */
const ORGANISATION_ID = "org-legacy-cowork";

const KINDS = ["document", "mindmap"];
const EXTERNAL_ROLES = ["editor", "viewer"];

const COWORK_APP_URL = process.env.COWORK_APP_URL || "https://cowork.grav.in";

/* ── Loading a target, either kind ────────────────────────────────────────── */

function collectionFor(kind) {
  return kind === "mindmap" ? MAPS : DOCUMENTS;
}

/**
 * The stored record for a target, or `null` if it does not exist or is
 * soft-deleted. Deliberately thin: this route family only ever needs
 * `members`/`memberIds` and a display title, never the body, to decide who
 * may invite/list/revoke.
 */
async function loadTarget(kind, id) {
  const snap = await db.collection(collectionFor(kind)).doc(String(id)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.deletedAt) return null;
  const members = Array.isArray(data.members) ? data.members : [];
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : kind === "mindmap"
        ? "Untitled mindmap"
        : data.kind === "sheet"
          ? "Untitled sheet"
          : "Untitled document";
  return { ref: snap.ref, id: snap.id, data, members, title };
}

function isOwner(target, employeeId) {
  return target.members.some(
    (m) => m && m.role === "owner" && String(m.employeeId) === String(employeeId),
  );
}

/* ── Owner-side routes (Firebase-authenticated Cowork employees) ─────────── */

/**
 * Invite an external person.
 *
 * POST /cowork/share/:kind/:id/invite
 * Body: { email, role }   role: "editor" | "viewer" — never "owner".
 */
router.post(
  "/share/:kind/:id/invite",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { kind, id } = req.params;
      if (!KINDS.includes(kind))
        return res.status(400).json({ error: "kind must be document or mindmap." });

      const { email, role } = req.body || {};
      if (!EXTERNAL_ROLES.includes(role))
        return res
          .status(400)
          .json({ error: `role must be one of: ${EXTERNAL_ROLES.join(", ")}.` });

      const normEmail = shareInvites.normaliseEmail(email);
      if (!normEmail || !normEmail.includes("@"))
        return res.status(400).json({ error: "A valid email address is required." });

      const me = String(req.coworkUser.employeeId);
      const target = await loadTarget(kind, id);
      // Not found and not owner answer identically — a distinguishable error
      // would confirm an id to somebody with no access to it, matching the
      // discipline `notify-member` already applies.
      if (!target || !isOwner(target, me))
        return res.status(404).json({ error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` });

      // An external invite must never double as a back door into the employee
      // directory: somebody who already has a Cowork identity is added through
      // the normal internal "Add somebody" flow, which grants through
      // `members`/`memberIds` rather than through a guest session.
      const employeeSnap = await db
        .collection(EMPLOYEES)
        .where("email", "==", normEmail)
        .limit(1)
        .get();
      if (!employeeSnap.empty)
        return res.status(400).json({
          error:
            "This email belongs to an existing Cowork employee. Use \"Add somebody\" to share with them directly instead of an external invite.",
        });

      const { record, plaintext } = await shareInvites.createInvite({
        organisationId: target.data.organisationId || ORGANISATION_ID,
        targetKind: kind,
        targetId: String(id),
        email: normEmail,
        role,
        invitedByEmployeeId: me,
        invitedByName: req.coworkUser.name || "A Cowork teammate",
      });

      const acceptUrl = `${COWORK_APP_URL}/share/invite/${encodeURIComponent(plaintext)}`;
      try {
        await CustomerEmailService.sendShareInviteEmail({
          toEmail: normEmail,
          toName: normEmail.split("@")[0],
          inviterName: req.coworkUser.name || "A Cowork teammate",
          targetKind: kind,
          targetTitle: target.title,
          role,
          acceptUrl,
        });
      } catch (mailErr) {
        // The invite row is real and the link works even if the email did not
        // send — logged rather than failing the request, since the owner can
        // still hand the link over another way once told delivery failed.
        console.error("[coworkExternalShare] invite email failed:", mailErr.message);
      }

      res.status(201).json({
        invite: {
          id: record.id,
          targetKind: record.targetKind,
          targetId: record.targetId,
          email: record.email,
          role: record.role,
          status: record.status,
          invitedByName: record.invitedByName,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          acceptedAt: record.acceptedAt,
        },
      });
    } catch (err) {
      console.error("Error in POST /share/:kind/:id/invite:", err);
      res.status(500).json({ error: "Could not send invite: " + err.message });
    }
  },
);

/**
 * List invites for a target — pending, accepted and revoked. Owner-only, for
 * `ShareMenu` to render alongside internal members.
 *
 * GET /cowork/share/:kind/:id/invites
 */
router.get(
  "/share/:kind/:id/invites",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { kind, id } = req.params;
      if (!KINDS.includes(kind))
        return res.status(400).json({ error: "kind must be document or mindmap." });

      const me = String(req.coworkUser.employeeId);
      const target = await loadTarget(kind, id);
      if (!target || !isOwner(target, me))
        return res.status(404).json({ error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` });

      const rows = await shareInvites.listInvitesForTarget(kind, id);
      res.json({
        invites: rows.map((r) => ({
          id: r.id,
          targetKind: r.targetKind,
          targetId: r.targetId,
          email: r.email,
          role: r.role,
          status: r.status,
          invitedByName: r.invitedByName,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          acceptedAt: r.acceptedAt,
        })),
      });
    } catch (err) {
      console.error("Error in GET /share/:kind/:id/invites:", err);
      res.status(500).json({ error: "Could not list invites: " + err.message });
    }
  },
);

/**
 * Revoke an invite (pending or already accepted). Owner-only.
 *
 * POST /cowork/share/:kind/:id/invites/:inviteId/revoke
 */
router.post(
  "/share/:kind/:id/invites/:inviteId/revoke",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { kind, id, inviteId } = req.params;
      if (!KINDS.includes(kind))
        return res.status(400).json({ error: "kind must be document or mindmap." });

      const me = String(req.coworkUser.employeeId);
      const target = await loadTarget(kind, id);
      if (!target || !isOwner(target, me))
        return res.status(404).json({ error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` });

      const result = await shareInvites.revokeInvite({
        inviteId,
        revokedByEmployeeId: me,
      });
      if (result.error) return res.status(404).json({ error: result.error });
      if (
        result.invite.targetKind !== kind ||
        result.invite.targetId !== String(id)
      )
        return res.status(404).json({ error: "Invite not found." });

      res.json({ ok: true });
    } catch (err) {
      console.error("Error in POST /share/:kind/:id/invites/:inviteId/revoke:", err);
      res.status(500).json({ error: "Could not revoke invite: " + err.message });
    }
  },
);

/* ── Guest-side routes (NO Firebase auth — the caller may have no account) ─ */

/**
 * Redeem an invite token. No employee auth: this person may never have had a
 * Cowork account at all.
 *
 * POST /cowork/share/accept
 * Body: { token }
 */
router.post("/share/accept", async (req, res) => {
  try {
    const token = req.body && req.body.token;
    if (!token || typeof token !== "string")
      return res.status(400).json({ error: "token is required." });

    const result = await shareInvites.acceptInvite(token);
    if (result.error) return res.status(400).json({ error: result.error });

    const target = await loadTarget(result.targetKind, result.targetId);
    res.json({
      guestSessionToken: result.guestSessionToken,
      targetKind: result.targetKind,
      targetId: result.targetId,
      role: result.role,
      title: target ? target.title : null,
    });
  } catch (err) {
    console.error("Error in POST /share/accept:", err);
    res.status(500).json({ error: "Could not accept invite: " + err.message });
  }
});

/** Resolve the guest bearer token in `Authorization: Bearer <token>` (or
    `X-Guest-Token`, kept as a fallback for a client that cannot set
    `Authorization` on a same-origin request without conflicting with a
    Firebase header). Returns `{ error, status }` or `{ guest, grant }`. */
async function resolveGuest(req, kind, id) {
  const header = req.headers.authorization;
  const token =
    (header && header.startsWith("Bearer ") && header.slice(7)) ||
    req.headers["x-guest-token"];
  if (!token) return { status: 401, error: "Missing guest session token." };

  const guest = await shareInvites.findLiveGuestBySessionToken(token);
  if (!guest) return { status: 401, error: "This guest session is invalid or has expired." };

  const grant = shareInvites.grantForTarget(guest, kind, id);
  // No grant and no such target answer identically: a guest session is not a
  // credential for discovering what exists, only for what it was explicitly
  // handed.
  if (!grant) return { status: 404, error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` };

  return { guest, grant };
}

/**
 * Read a target's content as a guest. Same response shape the employee-facing
 * read already returns, so the frontend viewer can reuse existing renderers.
 *
 * GET /cowork/share/guest/:kind/:id
 */
router.get("/share/guest/:kind/:id", async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!KINDS.includes(kind))
      return res.status(400).json({ error: "kind must be document or mindmap." });

    const resolved = await resolveGuest(req, kind, id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const target = await loadTarget(kind, id);
    if (!target) return res.status(404).json({ error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` });

    await db.collection("cowork_share_guests").doc(resolved.guest.id).update({
      lastSeenAt: new Date().toISOString(),
    });

    if (kind === "mindmap") {
      const bodySnap = await db.collection(BODIES).doc(target.id).get();
      const raw = bodySnap.exists ? bodySnap.data() || {} : {};
      return res.json({
        title: target.title,
        role: resolved.grant.role,
        nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
      });
    }

    const bodySnap = await db.collection(DOCUMENT_BODIES).doc(target.id).get();
    const raw = bodySnap.exists ? bodySnap.data() || {} : {};
    res.json({
      title: target.title,
      role: resolved.grant.role,
      html: typeof raw.html === "string" ? raw.html : "",
      cells: typeof raw.cells === "string" ? raw.cells : null,
    });
  } catch (err) {
    console.error("Error in GET /share/guest/:kind/:id:", err);
    res.status(500).json({ error: "Could not open this: " + err.message });
  }
});

/**
 * Write a target's content as a guest. Requires the grant's role to be
 * `editor` — a viewer grant is refused here exactly as a viewer member is
 * refused on the employee-facing write.
 *
 * PUT /cowork/share/guest/:kind/:id
 * Body (document/sheet): { html?, cells? }
 * Body (mindmap):        { nodes }
 */
router.put("/share/guest/:kind/:id", async (req, res) => {
  try {
    const { kind, id } = req.params;
    if (!KINDS.includes(kind))
      return res.status(400).json({ error: "kind must be document or mindmap." });

    const resolved = await resolveGuest(req, kind, id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    if (resolved.grant.role !== "editor")
      return res.status(403).json({ error: "You can view this but not change it." });

    const target = await loadTarget(kind, id);
    if (!target) return res.status(404).json({ error: `${kind === "mindmap" ? "Mindmap" : "Document"} not found.` });

    const now = new Date().toISOString();

    if (kind === "mindmap") {
      // The exact validator an employee's own save runs through — a guest
      // write is checked exactly as strictly, because a malformed tree fails
      // to draw at all for every member of the map, guest-authored or not.
      const checked = validateNodes(req.body && req.body.nodes);
      if (checked.error) return res.status(400).json({ error: checked.error });

      await db
        .collection(BODIES)
        .doc(target.id)
        .set({ mindmapId: target.id, nodes: checked.nodes, updatedAt: now });
      await db.collection(MAPS).doc(target.id).update({
        updatedAt: now,
        nodeCount: checked.nodes.length,
        lastEditedByGuestId: resolved.guest.id,
      });
      return res.json({ ok: true, nodes: checked.nodes });
    }

    const { html, cells } = req.body || {};
    const patch = { updatedAt: now };
    if (html !== undefined) patch.html = typeof html === "string" ? html : "";
    if (cells !== undefined) patch.cells = typeof cells === "string" ? cells : null;
    await db.collection(DOCUMENT_BODIES).doc(target.id).set(patch, { merge: true });
    await db.collection(DOCUMENTS).doc(target.id).update({
      updatedAt: now,
      lastEditedByGuestId: resolved.guest.id,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in PUT /share/guest/:kind/:id:", err);
    res.status(500).json({ error: "Could not save: " + err.message });
  }
});

module.exports = router;
