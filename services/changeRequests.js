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
const { sectionForPath, sectionLabel } = require("./auditSections");
const { recordChange } = require("./changeLog");

/**
 * The header that names which approved change is being replayed.
 *
 * Without it an approved change would be held again on replay — approving would
 * create a new pending request instead of applying the old one, forever.
 *
 * IT IS NOT, BY ITSELF, PERMISSION TO SKIP THE HOLD.
 *
 * It used to be. `if (req.headers[REPLAY_HEADER]) return next()` trusted a
 * string the caller chooses, so any editor could send their ordinary mutation
 * with `x-grav-change-request: anything` and walk straight past the approval
 * they were subject to — the entire "an editor may change it, but not alone"
 * rule, removed by one header. See `validatedReplayOf` below for what is
 * required now.
 */
const REPLAY_HEADER = "x-grav-change-request";

/**
 * The private, server-side mark that a request IS a genuine approved replay.
 *
 * Set only by `validatedReplayOf` after the signature check, and read by
 * services/changeLog for approval attribution. A property on the request
 * object, not a header: the caller controls headers, body and query, and
 * controls none of this.
 */
const REPLAY_FLAG = "__approvalReplay";

/**
 * The change-request id this request is a validated replay of, or null.
 *
 * Two things must agree, and one of them cannot be forged:
 *
 *   1. the `x-grav-change-request` header — which change is being replayed;
 *   2. the `replayOf` claim inside the caller's VERIFIED JWT.
 *
 * The claim is minted only by `replayToken` below, only inside
 * `applyChangeRequest`, only after an approver has decided, and the token it
 * lives in never leaves this server — it goes out on a loopback fetch and comes
 * straight back. An editor cannot obtain one, cannot mint one without the
 * signing secret, and cannot move one from another change request, because the
 * claim is compared against the header rather than merely being present.
 *
 * The claim is read off `req.user` rather than re-verified here on purpose:
 * whatever put it there — `seedIdentity` at the mount, `EmployeeAuthMiddleware`
 * in the router — got it out of a signature-checked token. Both of those carry
 * it forward specifically so this comparison has something trustworthy to read;
 * if a future middleware rebuilds `req.user` and drops it, this returns null
 * and the request is held rather than let through, which is the safe direction
 * to fail.
 */
function validatedReplayOf(req) {
  const header = req?.headers?.[REPLAY_HEADER];
  if (!header) return null;

  const claim =
    req?.user?.replayOf || req?.admin?.replayOf || req?.dept?.replayOf || null;
  if (!claim) return null;

  return String(claim) === String(header) ? String(header) : null;
}

/**
 * True when this request has been proven to be a server-generated replay of an
 * approved change. Exported so services/changeLog can ask without repeating the
 * comparison, and so nothing has to read the raw header to find out.
 */
function isApprovalReplay(req) {
  return Boolean(req?.[REPLAY_FLAG]?.changeRequestId);
}

/**
 * The approver, spelled out for the change log on the far side of the replay.
 *
 * Sent as headers rather than folded into the replay token because the token is
 * the REQUESTER's — putting the approver in it would make every downstream
 * `req.user` read ambiguous about which of the two people it refers to, and the
 * routes that stamp `updatedBy` from `req.user` would start recording the wrong
 * name on the record itself.
 *
 * Values are stripped of anything that cannot travel in a header. A name with a
 * newline in it would otherwise be a header-injection bug, and a name is
 * user-supplied.
 */
function headerSafe(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function APPROVER_HEADERS(cr) {
  const by = cr.decidedBy || {};
  return {
    "x-grav-approver-id": headerSafe(by.id),
    "x-grav-approver-name": headerSafe(by.name),
    "x-grav-approver-email": headerSafe(by.email),
    "x-grav-decision-note": headerSafe(cr.decisionNote),
  };
}

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
/* The submission and the decision, in the history                     */
/* ------------------------------------------------------------------ */

/**
 * The three moments of a held change, as history entries.
 *
 * The APPLY is logged by the route itself when the replay reaches it, carrying
 * the approver from the headers — that entry is the change. These two are the
 * bracket around it: the ask, and the decision. Both are needed because the
 * only path that produces no route entry at all is the one that matters most to
 * an editor — a rejection — and a history that is silent about rejected work
 * cannot answer "what happened to the change I submitted on Tuesday".
 *
 * `changes` on the request is a list of {field,label,from,to} written by an
 * optional describe() hook, which is close enough to the log's own field shape
 * to pass straight through when it exists.
 */
function fieldsFromRequest(cr) {
  if (!Array.isArray(cr.changes)) return [];
  return cr.changes
    .filter((c) => c && (c.field || c.path))
    .map((c) => ({
      path: String(c.path || c.field),
      label: c.label || "",
      from: c.from,
      to: c.to,
      kind: "changed",
    }));
}

async function recordSubmission(req, cr) {
  return recordChange(req, {
    departmentSlug: cr.departmentSlug,
    section: cr.section,
    entity: cr.entity,
    entityId: cr.entityId,
    entityLabel: cr.entityLabel,
    action: "other",
    origin: "approval",
    fields: fieldsFromRequest(cr),
    summary:
      `Sent ${cr.action === "create" ? "a new" : "a change to"} ` +
      `${cr.entity}${cr.entityLabel ? ` “${cr.entityLabel}”` : ""} for approval` +
      `${cr.summary ? ` — ${cr.summary}` : ""}. Not applied yet.`,
  });
}

/**
 * The decision. Written for approve, reject and a failed apply alike: an
 * approval whose replay failed is the case where the queue says one thing and
 * the record says another, and it is exactly the case somebody will need to
 * look up later.
 */
async function recordDecision(req, cr, { applied, error }) {
  const who = cr.decidedBy?.name || cr.decidedBy?.email || "an approver";
  const what = `${cr.entity}${cr.entityLabel ? ` “${cr.entityLabel}”` : ""}`;
  const asked = cr.requestedBy?.name || cr.requestedBy?.email || "an editor";

  let summary;
  if (cr.status === "rejected") {
    summary = `Rejected ${asked}’s change to ${what}. Nothing was applied.`;
  } else if (applied) {
    summary = `Approved ${asked}’s change to ${what} — applied.`;
  } else {
    summary = `Approved ${asked}’s change to ${what}, but it could not be applied: ${error || "unknown error"}.`;
  }
  if (cr.decisionNote) summary += ` Note: ${cr.decisionNote}`;

  return recordChange(req, {
    departmentSlug: cr.departmentSlug,
    section: cr.section,
    entity: cr.entity,
    entityId: cr.entityId,
    entityLabel: cr.entityLabel,
    action: cr.status === "rejected" ? "reject" : "approve",
    origin: "approval",
    fields: fieldsFromRequest(cr),
    summary: `${summary} (decided by ${who})`,
  });
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
      // it through is the whole point of approving it — but only once the
      // signed `replayOf` claim agrees with the header. A header on its own is
      // a caller's assertion, not a decision.
      //
      // A mismatched or missing claim does NOT refuse the request. It simply
      // is not a replay, so it carries on down the ordinary role-and-approval
      // path below and an editor is held at 202 exactly as they would be
      // without the header at all.
      const replayOf = validatedReplayOf(req);
      if (replayOf) {
        req[REPLAY_FLAG] = { changeRequestId: replayOf };
        return next();
      }

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

      const resolved = sectionForPath(req.originalUrl || req.url || "");
      const section = req.auditSection || described.section || resolved?.section || "";

      // The mount-level guard passes one entity name for a whole department,
      // which reads as "a change to hr record" in the queue. A name resolved
      // from the path says "leave" or "payroll-run" instead, which is the
      // difference between an approver knowing what they are approving and
      // having to open the request to find out.
      const entityName = req.auditEntity || resolved?.entity || entity;

      const cr = await ChangeRequest.create({
        departmentSlug: slug,
        section,
        sectionLabel: section ? sectionLabel(section) : "",
        entity: entityName,
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

      // The page's history has to show the submission, not only the outcome.
      // A change that is submitted and then rejected never reaches a route and
      // would otherwise leave no trace at all — the editor would see their work
      // disappear with nothing anywhere saying it had ever been asked for.
      // `action: "other"` deliberately: nothing was created, updated or deleted.
      await recordSubmission(req, cr).catch(() => {});

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
        // WHO APPROVED IT, carried to the route so its change-log entry can say
        // so. The replay runs as the REQUESTER (see replayToken), which is what
        // keeps authorship honest — but it also means the approver is invisible
        // to everything downstream unless it is passed explicitly. Without
        // these, an approved change is indistinguishable in the history from
        // one the editor was allowed to make alone, which is the single fact
        // the approval workflow exists to establish. services/changeLog reads
        // them, so every route that logs gets this without knowing about it.
        ...APPROVER_HEADERS(cr),
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
async function decideChangeRequest({ id, decision, note, actor, req }) {
  // The decision is logged as the APPROVER, which is a different person from
  // the one the applied change is logged as. When the caller has a request it
  // is used directly; otherwise a stand-in carries the actor so the entry still
  // has a name on it rather than being filed as anonymous.
  const decisionReq = req || { user: actor, method: "POST", originalUrl: "" };
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
    await recordDecision(decisionReq, cr, { applied: false }).catch(() => {});
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
  await recordDecision(decisionReq, cr, { applied: result.ok, error: cr.applyError }).catch(() => {});

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
  REPLAY_FLAG,
  validatedReplayOf,
  isApprovalReplay,
  requireApproval,
  applyChangeRequest,
  decideChangeRequest,
  actorFrom,
};
