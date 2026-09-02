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
const mongoose = require("mongoose");

const ChangeRequest = require("../models/Access/ChangeRequest");
const { MAX_BODY_BYTES } = ChangeRequest;
const { SECRET } = require("../config/jwt");
const { getRole, getEffectiveRole, listRoles, roleAtLeast } = require("./departmentRoles");
const { sectionForPath, sectionLabel } = require("./auditSections");
const { decideApproval } = require("./approvalPolicy");
const { recordChange } = require("./changeLog");

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
    /* Captured because the replay has to run as this person, and the routes it
       replays into check the role. See the note on actorSchema. */
    role: String(u.role || ""),
    userType: String(u.userType || ""),
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
    /* Leads with the outcome, not the intention. "Approved …, but it could not
       be applied" reads as a success with a caveat, and next to a green badge
       people took it for one. What happened is that nothing changed. */
    summary =
      `NOT applied — ${asked}’s change to ${what} was approved but failed: ` +
      `${error || "unknown error"}. The record is unchanged.`;
  }
  if (cr.decisionNote) summary += ` Note: ${cr.decisionNote}`;

  return recordChange(req, {
    departmentSlug: cr.departmentSlug,
    section: cr.section,
    entity: cr.entity,
    entityId: cr.entityId,
    entityLabel: cr.entityLabel,
    /* Three outcomes, three actions. Filing a failed apply as "approve" is what
       put a green Approved badge on a change that never happened. */
    action: cr.status === "rejected" ? "reject" : applied ? "approve" : "fail",
    origin: "approval",
    fields: fieldsFromRequest(cr),
    summary: `${summary} (decided by ${who})`,
  });
}

/* ------------------------------------------------------------------ */
/* Holding                                                             */
/* ------------------------------------------------------------------ */

/**
 * Push a notification about this request, without ever letting it matter.
 *
 * Deliberately not awaited by any caller and deliberately not throwing: a
 * change request that is queued, approved or rejected is already correct and
 * durable at the point this runs. A notification is how somebody FINDS OUT,
 * which is worth a lot and is worth nothing compared to the decision itself.
 *
 * Required lazily so that services/departmentApprovalNotifications — and the
 * Firebase admin SDK behind it — is not pulled in at boot by every module that
 * imports this one.
 */
function notify(cr, event) {
  try {
    const { notifyChangeRequest } = require("./departmentApprovalNotifications.service");
    Promise.resolve(notifyChangeRequest(cr, event)).catch(() => {});
  } catch (err) {
    console.warn("[change-requests] notification skipped:", err.message);
  }
}

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

      /* The same resolution the role guard uses. Looking up only the token's
         email meant an approver whose grant sits on another of their addresses
         was read as an editor — and every change they made was held for an
         approval that only they could have given. */
      const role = req.departmentRole || (await getEffectiveRole(slug, req));

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

      /* DOES THIS ACTUALLY NEED AN APPROVER?
         Held everything, this queue filled with spelling corrections and phone
         numbers, and the changes that matter arrived looking exactly as
         important as the ones that did not. An editor's routine correction now
         commits straight away and is recorded in the change history like any
         other edit; money, access, identity and anything payroll or attendance
         reads still stops here.

         Decided AFTER describe() because the decision is made on the fields
         that actually moved, not on the route or the shape of the body. See
         services/approvalPolicy.js for the classification and why a field
         nobody has classified waits. */
      const verdict = decideApproval({
        path: req.originalUrl || req.url || "",
        method: req.method,
        changes: described.changes,
      });
      if (!verdict.hold) {
        /* Left for the route's own logging and for auditTrail: this is now an
           ordinary write, and it should read as one in the history. Recorded
           on the request so a route that wants to say "committed directly,
           no approval needed" can. */
        req.approvalWaived = verdict.reason;
        return next();
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

      // Tell the owner and approvers there is something waiting. NOT awaited:
      // a queued change is already safe, and making the editor wait on FCM —
      // or fail because of it — would trade the thing that matters for the
      // thing that does not.
      notify(cr, "held");

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
 * The role the replay must run with.
 *
 * ── WHY THIS IS NOT JUST THE DEPARTMENT SLUG ────────────────────────────────
 * It used to be. The token carried `role: cr.departmentSlug` — "hr" — and the
 * routes being replayed into check the LOGIN role, which for HR is
 * "hr_manager". So `PUT /api/employees/:id` refused every replay with
 * "Permission denied", and an owner approving an employee edit watched their
 * approval fail no matter what they did. The slug was never a role; it only
 * looked like one for departments where the two strings happen to match.
 *
 * Three sources, most trustworthy first:
 *   1. What the requester actually held when they submitted. Stored on the
 *      request since this bug was found, and correct even if their role
 *      changes while the request waits.
 *   2. For requests held BEFORE that — the ones already sitting in the queue —
 *      the same collection `routes/login.js` reads the role from. Resolved by
 *      email through the department registry, so it is the real role rather
 *      than a guess.
 *   3. The slug, as it was. Reached only when the requester can no longer be
 *      found at all, and it will fail the same way it always did — but by then
 *      the approver has a specific error saying so, rather than silence.
 */
async function requesterIdentity(cr) {
  const stored = cr.requestedBy || {};
  if (stored.role) {
    return { role: stored.role, userType: stored.userType || cr.departmentSlug };
  }

  try {
    const { DEPARTMENTS } = require("./ensureAccessDepartments");
    const dept = DEPARTMENTS.find((d) => d.slug === cr.departmentSlug || d.key === cr.departmentSlug);
    if (dept?.legacyCollection && stored.email) {
      const doc = await mongoose.connection.db
        .collection(dept.legacyCollection)
        .findOne({ email: String(stored.email).toLowerCase() }, { projection: { role: 1 } });
      if (doc?.role) {
        return { role: doc.role, userType: dept.legacyUserType || cr.departmentSlug };
      }
    }
  } catch {
    // Fall through to the slug — never let resolution failure throw away the
    // approval; the replay's own error is the more useful one to report.
  }

  return { role: cr.departmentSlug, userType: cr.departmentSlug };
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
function replayToken(cr, identity) {
  return jwt.sign(
    {
      v: 2,
      id: cr.requestedBy?.id || "",
      email: cr.requestedBy?.email || "",
      name: cr.requestedBy?.name || "",
      deptSlug: cr.departmentSlug,
      role: identity.role,
      userType: identity.userType,
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

  const identity = await requesterIdentity(cr);
  const token = replayToken(cr, identity);
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

  /* CLAIM IT ATOMICALLY, rather than read-then-check-then-write.
     The replay is an HTTP round trip, so between "it is pending" and "it is
     approved" there is a window wide enough for a second approver — or a
     double-clicked button — to slip through and apply the same change twice.
     The status guard inside the update is what closes that: exactly one caller
     can move a request out of a decidable state.

     `failed` is decidable. A failed request was approved by a person and simply
     did not land; the fix is usually a permission or a stale field, and once
     that is sorted the approver's answer is still yes. Refusing to reconsider
     it — which is what "already been failed" did — left the queue with rows
     nobody could ever resolve. */
  /* A claim that was never released — the process restarted mid-replay, say —
     must not strand the request forever. The replay token lives two minutes, so
     anything still "applying" after five is not in flight any more and may be
     claimed again. */
  const staleClaim = new Date(Date.now() - 5 * 60 * 1000);
  const cr = await ChangeRequest.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { status: { $in: ["pending", "failed"] } },
        { status: "applying", decidedAt: { $lt: staleClaim } },
      ],
    },
    {
      $set: {
        status: decision === "reject" ? "rejected" : "applying",
        decidedBy: actor,
        decidedAt: new Date(),
        decisionNote: String(note || ""),
        /* Cleared on retry so a stale message from the previous attempt cannot
           be mistaken for the outcome of this one. */
        applyError: "",
      },
    },
    { new: true },
  );

  if (!cr) {
    const existing = await ChangeRequest.findById(id).select("status").lean();
    if (!existing) return { ok: false, code: 404, message: "That request no longer exists." };
    if (existing.status === "applying") {
      return {
        ok: false,
        code: 409,
        message: "Someone is applying this right now — give it a moment and refresh.",
      };
    }
    return {
      ok: false,
      code: 409,
      message: `This request has already been ${existing.status}.`,
    };
  }

  if (decision === "reject") {
    await recordDecision(decisionReq, cr, { applied: false }).catch(() => {});
    notify(cr, "rejected");
    return { ok: true, request: cr };
  }

  /* The claim is held from here until the status is written below. Any throw
     in between would strand the request as "applying", so the replay is
     wrapped: applyChangeRequest is written not to throw, and this makes that
     a guarantee rather than a convention. */
  let result;
  try {
    result = await applyChangeRequest(cr);
  } catch (err) {
    result = { ok: false, status: 0, body: { message: err?.message || "The replay threw." } };
  }

  if (result.ok) {
    cr.status = "approved";
    cr.appliedAt = new Date();
    cr.applyError = "";
  } else {
    cr.status = "failed";
    cr.applyError =
      (result.body && (result.body.message || result.body.error)) ||
      `The change could not be applied (HTTP ${result.status}).`;
    /* Says WHOSE permission was refused. "Permission denied" alone sent an
       owner looking at their own rights, when the replay runs as the editor
       and it was the editor's role the route turned away. */
    if (result.status === 403 || result.status === 401) {
      const who = cr.requestedBy?.name || cr.requestedBy?.email || "the editor";
      cr.applyError =
        `${cr.applyError} — the change is replayed as ${who}, and that account ` +
        `was refused by the route. Approving again will retry it.`;
    }
  }

  await cr.save();
  await recordDecision(decisionReq, cr, { applied: result.ok, error: cr.applyError }).catch(() => {});

  // Only a change that actually landed is reported as approved. A `failed`
  // request has been approved by a person but applied by nothing, and telling
  // the editor it went through would be the one lie this whole queue exists to
  // prevent — they will see it in the Failed tab instead.
  if (cr.status === "approved") notify(cr, "approved");

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
