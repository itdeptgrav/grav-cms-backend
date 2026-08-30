// routes/Access/changeRequests.js
//
// The approval queue. Mounted at /api/change-requests.
//
// Who may see and decide what:
//   - anyone with a role in the department may LIST it, because an editor needs
//     to see that their own change is still waiting and why it was refused;
//   - only approver and above may DECIDE, enforced here on the server. The
//     buttons are hidden from an editor in the UI, which is a courtesy, not a
//     gate.
//
// There is deliberately no "edit a pending request" route. A change that has
// been altered after submission is a different change, and approving it would
// mean approving something nobody reviewed. Withdraw and resubmit instead.

"use strict";

const express = require("express");
const router = express.Router();

const ChangeRequest = require("../../models/Access/ChangeRequest");
const { getRole, listRoles, roleAtLeast } = require("../../services/departmentRoles");
const { decideChangeRequest, actorFrom } = require("../../services/changeRequests");
const { recordChange } = require("../../services/changeLog");

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

const jwt = require("jsonwebtoken");
const { SECRET, LEGACY_SECRETS, readToken } = require("../../config/jwt");

/**
 * Resolve the caller from the CMS session.
 *
 * This router is mounted outside any department's own middleware — the queue
 * spans departments — so it reads the token itself rather than depending on
 * whichever guard happens to be in front of it.
 */
function authenticate(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

  const verify = () => {
    try {
      return jwt.verify(token, SECRET);
    } catch (err) {
      for (const legacy of LEGACY_SECRETS) {
        try {
          return jwt.verify(token, legacy);
        } catch {
          /* try the next */
        }
      }
      throw err;
    }
  };

  try {
    const decoded = verify();
    req.user = {
      id: decoded.id,
      email: String(decoded.email || "").toLowerCase(),
      name: decoded.name || "",
      isAdmin: Boolean(decoded.isAdmin),
      deptSlug: decoded.deptSlug || "",
    };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

/** The caller's role in `slug`, with admins treated as owner. */
async function roleFor(req, slug) {
  if (req.user?.isAdmin) return "owner";
  return getRole(slug, req.user.email);
}

/**
 * May the caller look at this department's queue at all?
 *
 * Mirrors requireDepartmentRole's migration rule: a department with no roles
 * assigned has nothing to enforce, so anyone signed in to it may look. A
 * department WITH roles requires one.
 */
async function canRead(req, slug) {
  if (req.user?.isAdmin) return true;
  const assigned = await listRoles(slug);
  if (assigned.length === 0) return Boolean(req.user?.deptSlug === slug);
  return Boolean(await getRole(slug, req.user.email));
}

router.use(authenticate);

/* ------------------------------------------------------------------ */
/* GET /api/change-requests/:slug                                      */
/* ------------------------------------------------------------------ */

router.get("/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!(await canRead(req, slug))) {
      return res.status(403).json({ success: false, message: "Not your department." });
    }

    const { status = "pending", entity, limit = 50 } = req.query;

    const query = { departmentSlug: slug };
    if (status && status !== "all") query.status = status;
    if (entity) query.entity = entity;

    // An editor sees only their OWN requests. Somebody else's pending change is
    // not theirs to read: it can carry pricing, customer terms or personal
    // details that the approver is the intended audience for.
    const role = await roleFor(req, slug);
    if (!roleAtLeast(role, "approver")) query["requestedBy.email"] = req.user.email;

    const rows = await ChangeRequest.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 200))
      .lean();

    // The count the UI badges the nav with — always the department-wide pending
    // total for an approver, and the caller's own for an editor.
    const pendingCount = await ChangeRequest.countDocuments({
      departmentSlug: slug,
      status: "pending",
      ...(roleAtLeast(role, "approver") ? {} : { "requestedBy.email": req.user.email }),
    });

    res.json({
      success: true,
      role: role || null,
      // So the UI can tell the caller's own requests apart from other people's
      // — an approver may withdraw their own rather than approve it.
      viewerEmail: req.user.email,
      canDecide: roleAtLeast(role, "approver"),
      pendingCount,
      requests: rows.map((r) => ({
        id: String(r._id),
        entity: r.entity,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        action: r.action,
        summary: r.summary,
        changes: r.changes || [],
        status: r.status,
        requestedBy: r.requestedBy,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
        applyError: r.applyError,
        createdAt: r.createdAt,
        // The path is shown to an approver so they can tell two similar
        // requests apart. The BODY is not sent: it can hold anything the form
        // held, and the summary/changes are what the decision should rest on.
        path: r.intent?.path || "",
        method: r.intent?.method || "",
      })),
    });
  } catch (err) {
    console.error("[change-requests] list failed:", err.message);
    res.status(500).json({ success: false, message: "Could not load the approval queue." });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/change-requests/:id/decide                                */
/* ------------------------------------------------------------------ */

router.post("/:id/decide", async (req, res) => {
  try {
    const { decision, note } = req.body || {};
    if (!["approve", "reject"].includes(decision)) {
      return res
        .status(400)
        .json({ success: false, message: "Decision must be approve or reject." });
    }

    const cr = await ChangeRequest.findById(req.params.id).lean();
    if (!cr) return res.status(404).json({ success: false, message: "That request no longer exists." });

    const role = await roleFor(req, cr.departmentSlug);
    if (!roleAtLeast(role, "approver")) {
      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_DEPARTMENT_ROLE",
        message: "Only an approver or the owner can decide this.",
      });
    }

    // Nobody approves their own change. This is the entire point of the
    // feature: an editor who could approve their own submission is just an
    // approver with extra steps. An owner acting on someone else's request is
    // unaffected.
    if (
      String(cr.requestedBy?.email || "").toLowerCase() === req.user.email &&
      !req.user.isAdmin
    ) {
      return res.status(403).json({
        success: false,
        code: "SELF_APPROVAL",
        message: "You cannot approve your own change. Ask another approver.",
      });
    }

    // The decision is logged inside decideChangeRequest, not here. It has to
    // be: only the service knows whether an APPROVAL actually applied, and an
    // entry written here would say "approved" for a replay that failed — the
    // one case where the history most needs to disagree with the intention.
    // Passing `req` lets that entry carry the approver and the section.
    const result = await decideChangeRequest({
      id: req.params.id,
      decision,
      note,
      actor: actorFrom(req),
      req,
    });

    if (result.code === 404 || result.code === 409) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    // An approval whose replay failed is NOT a success, and must not be
    // reported as one: the approver would close the queue believing the change
    // had landed.
    res.status(result.ok ? 200 : 502).json({
      success: result.ok,
      message: result.message,
      request: result.request
        ? { id: String(result.request._id), status: result.request.status, applyError: result.request.applyError }
        : null,
    });
  } catch (err) {
    console.error("[change-requests] decide failed:", err.message);
    res.status(500).json({ success: false, message: "Could not record your decision." });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/change-requests/:id/withdraw                              */
/* ------------------------------------------------------------------ */

// The submitter taking their own request back. There is no edit route — see
// the note at the top of this file.
router.post("/:id/withdraw", async (req, res) => {
  try {
    const cr = await ChangeRequest.findById(req.params.id);
    if (!cr) return res.status(404).json({ success: false, message: "That request no longer exists." });
    if (cr.status !== "pending") {
      return res.status(409).json({ success: false, message: `Already ${cr.status}.` });
    }
    if (String(cr.requestedBy?.email || "").toLowerCase() !== req.user.email && !req.user.isAdmin) {
      return res.status(403).json({ success: false, message: "That is not your request." });
    }

    cr.status = "rejected";
    cr.decidedBy = actorFrom(req);
    cr.decidedAt = new Date();
    cr.decisionNote = "Withdrawn by the person who submitted it.";
    await cr.save();

    // Logged for the same reason a rejection is: the request left the queue
    // without ever reaching a route, so nothing else in the system would show
    // that it had existed.
    await recordChange(req, {
      departmentSlug: cr.departmentSlug,
      section: cr.section,
      entity: cr.entity,
      entityId: cr.entityId,
      entityLabel: cr.entityLabel,
      action: "reject",
      origin: "approval",
      summary:
        `Withdrew their own pending change to ${cr.entity}` +
        `${cr.entityLabel ? ` “${cr.entityLabel}”` : ""}. Nothing was applied.`,
    });

    res.json({ success: true, message: "Withdrawn." });
  } catch (err) {
    console.error("[change-requests] withdraw failed:", err.message);
    res.status(500).json({ success: false, message: "Could not withdraw that request." });
  }
});

module.exports = router;
