// services/changeRequests.js
//
// The "an editor may change it, but not alone" rule, as one middleware.
//
//   router.post("/", requireApproval("sales", { entity: "customer", action: "create" }), create)
//
// Approvers, owners and platform admins pass straight through and the route
// runs exactly as before. An EDITOR's request is intercepted: nothing reaches
// the route, the write is stored as a pending ChangeRequest, and the caller
// gets 202 with `held: true` so the UI can say "sent for approval" rather than
// "saved". Anyone below editor never gets here — requireDepartmentRole refuses
// them first.
//
// WHY IT FAILS OPEN THE SAME WAY THE ROLE GUARD DOES
// --------------------------------------------------
// A department with no roles assigned yet behaves as it always has. Turning
// approval on as a hard gate would, on the day it shipped, park every save in a
// queue that nobody has permission to clear — because nobody has been made an
// approver yet. So enforcement begins the moment a department has its first
// role, matching requireDepartmentRole exactly. The two must agree; if one
// enforces and the other does not, an editor is either blocked with no queue or
// queued with no approver.

"use strict";

const jwt = require("jsonwebtoken");

const ChangeRequest = require("../models/Access/ChangeRequest");
const { MAX_BODY_BYTES } = ChangeRequest;
const { SECRET } = require("../config/jwt");
const { getRole, listRoles, roleAtLeast } = require("./departmentRoles");

/**
 * The one-shot header that lets a replay past this middleware.
 *
 * It is not a secret and does not need to be: the replay also carries a
 * freshly-minted token for the original requester, and this header only
 * suppresses the SECOND hold. Without it an approved change would be held
 * again on replay — approving would create a new pending request instead of
 * applying the old one, forever.
 */
const REPLAY_HEADER = "x-grav-change-request";

/* ------------------------------------------------------------------ */
/* Who is asking                                                       */
/* ------------------------------------------------------------------ */

function actorFrom(req) {
  const u = req.user || req.admin || req.dept || {};
  return {
    id: String(u.id || u._id || ""),
    email: String(u.email || "").toLowerCase(),
    name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || "",
  };
}

/* ------------------------------------------------------------------ */
/* Holding                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {string} departmentSlug  whose approvers decide this
 * @param {object} opts
 * @param {string}   opts.entity      "customer", "purchase-order", "raw-item"…
 * @param {string}   [opts.action]    create | update | delete | other
 * @param {function} [opts.describe]  (req) => { entityId, entityLabel, summary, changes }
 *                                    Runs BEFORE the write, so it may read the
 *                                    current record to build a real diff.
 */
function requireApproval(departmentSlug, opts = {}) {
  const slug = String(departmentSlug || "").toLowerCase();
  const { entity = "record", action = "update", describe } = opts;

  return async (req, res, next) => {
    try {
      // A replay of an already-approved request. It has been decided; letting
      // it through is the whole point of approving it.
      if (req.headers[REPLAY_HEADER]) return next();

      const actor = actorFrom(req);
      if (!actor.email) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }

      // Platform admins are not part of any department's approval chain.
      if (req.user?.isAdmin || req.admin) return next();

      // Same migration rule as requireDepartmentRole — see the header note.
      const assigned = await listRoles(slug);
      if (assigned.length === 0) return next();

      const role = req.departmentRole || (await getRole(slug, actor.email));

      // Approver and above commit directly. Below editor should never have
      // reached this middleware, but if it is mounted without the role guard,
      // refuse rather than quietly queue a change from someone with no role.
      if (roleAtLeast(role, "approver")) return next();
      if (!roleAtLeast(role, "editor")) {
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_DEPARTMENT_ROLE",
          message: "This action needs editor access.",
        });
      }

      /* ---- hold it ------------------------------------------------- */

      const body = req.body ?? {};
      const size = Buffer.byteLength(JSON.stringify(body) || "");
      if (size > MAX_BODY_BYTES) {
        // Refused rather than truncated: a replay of a shortened body would
        // apply something different from what was submitted.
        return res.status(413).json({
          success: false,
          code: "CHANGE_TOO_LARGE",
          message:
            "This change is too large to send for approval. Ask an approver to make it directly.",
        });
      }

      let described = {};
      if (typeof describe === "function") {
        try {
          described = (await describe(req)) || {};
        } catch (err) {
          // A description is a courtesy for the approver. Losing it must not
          // lose the change itself.
          console.error(`[change-requests] describe() failed for ${entity}:`, err.message);
        }
      }

      const cr = await ChangeRequest.create({
        departmentSlug: slug,
        entity,
        entityId: String(described.entityId || req.params?.id || ""),
        entityLabel: described.entityLabel || "",
        action,
        summary: described.summary || "",
        changes: Array.isArray(described.changes) ? described.changes : [],
        intent: {
          method: req.method,
          // originalUrl carries the mount prefix and the query string, which is
          // what makes the replay hit the same route with the same filters.
          path: req.originalUrl,
          body,
          contentType: req.headers["content-type"] || "application/json",
        },
        requestedBy: actor,
        status: "pending",
      });

      // 202, not 200: the request was accepted, the change has NOT happened.
      // A UI that treats this as success and closes the form having told the
      // user "saved" is the failure mode this status code exists to prevent.
      return res.status(202).json({
        success: true,
        held: true,
        code: "PENDING_APPROVAL",
        message: "Sent for approval. It takes effect once an approver accepts it.",
        changeRequest: {
          id: String(cr._id),
          entity: cr.entity,
          entityLabel: cr.entityLabel,
          action: cr.action,
          summary: cr.summary,
          createdAt: cr.createdAt,
        },
      });
    } catch (err) {
      console.error("[change-requests] hold failed:", err.message);
      // Fail CLOSED. If the change cannot be queued, it must not fall through
      // to the route — that would apply an editor's change with no approval at
      // all, which is the exact thing this guards.
      return res.status(500).json({
        success: false,
        message: "Your change could not be sent for approval. Nothing was saved.",
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

/**
 * The address of this server, for the loopback replay.
 *
 * 127.0.0.1 explicitly rather than "localhost": on Windows that name resolves
 * to ::1 first, and a server bound only to IPv4 refuses the connection with an
 * error that looks nothing like the actual cause.
 */
function selfOrigin() {
  const port = process.env.PORT || 5000;
  return process.env.INTERNAL_API_ORIGIN || `http://127.0.0.1:${port}`;
}

/**
 * A short-lived token for the person who asked for the change.
 *
 * The replay runs AS THE REQUESTER, not as the approver. That keeps every
 * ownership and authorship field on the underlying record honest — the person
 * who filled the form is the person recorded as having made the change, which
 * is what the approver believed they were approving. It also means a route that
 * scopes by the caller's identity behaves as it did when the form was
 * submitted.
 */
function replayToken(cr) {
  return jwt.sign(
    {
      v: 2,
      id: cr.requestedBy?.id || "",
      email: cr.requestedBy?.email || "",
      name: cr.requestedBy?.name || "",
      deptSlug: cr.departmentSlug,
      role: cr.departmentSlug,
      userType: cr.departmentSlug,
      // Marks this as a replay for anything downstream that wants to know.
      replayOf: String(cr._id),
    },
    SECRET,
    { expiresIn: "2m" },
  );
}

/**
 * Replay an approved change against this server's own API.
 *
 * Returns { ok, status, body }. Never throws: a failed apply has to be recorded
 * on the request so the approver can see that their approval did not land,
 * rather than disappearing into a log.
 */
async function applyChangeRequest(cr) {
  const path = String(cr.intent?.path || "");
  if (!path.startsWith("/")) {
    return { ok: false, status: 0, body: { message: "The stored request has no valid path." } };
  }

  const token = replayToken(cr);
  const url = `${selfOrigin()}${path}`;

  try {
    const res = await fetch(url, {
      method: cr.intent.method || "POST",
      headers: {
        "Content-Type": cr.intent.contentType || "application/json",
        Authorization: `Bearer ${token}`,
        Cookie: `auth_token=${token}`,
        [REPLAY_HEADER]: String(cr._id),
      },
      body: ["GET", "HEAD"].includes(cr.intent.method)
        ? undefined
        : JSON.stringify(cr.intent.body ?? {}),
    });

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { message: err.message } };
  }
}

/**
 * Approve or reject, and apply on approval.
 *
 * The status is written from the RESULT, not from the intention: an approval
 * whose replay failed is stored as "failed" with the reason, so the queue never
 * shows a green tick for a change that never happened.
 */
async function decideChangeRequest({ id, decision, note, actor }) {
  const cr = await ChangeRequest.findById(id);
  if (!cr) return { ok: false, code: 404, message: "That request no longer exists." };
  if (cr.status !== "pending") {
    return {
      ok: false,
      code: 409,
      message: `This request has already been ${cr.status}.`,
    };
  }

  cr.decidedBy = actor;
  cr.decidedAt = new Date();
  cr.decisionNote = String(note || "");

  if (decision === "reject") {
    cr.status = "rejected";
    await cr.save();
    return { ok: true, request: cr };
  }

  const result = await applyChangeRequest(cr);

  if (result.ok) {
    cr.status = "approved";
    cr.appliedAt = new Date();
    cr.applyError = "";
  } else {
    cr.status = "failed";
    cr.applyError =
      (result.body && (result.body.message || result.body.error)) ||
      `The change could not be applied (HTTP ${result.status}).`;
  }

  await cr.save();

  return {
    ok: result.ok,
    request: cr,
    // Handed back so the approver sees the underlying route's own words rather
    // than a generic failure.
    detail: result.body,
    message: result.ok ? "Approved and applied." : cr.applyError,
  };
}

module.exports = {
  REPLAY_HEADER,
  requireApproval,
  applyChangeRequest,
  decideChangeRequest,
  actorFrom,
};
