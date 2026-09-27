// routes/Accountant_Routes/Acc_team.js
//
// TEAM MANAGEMENT — owner invites sub-accounts and assigns roles.
//
// Routes (all require `orgAuth`):
//   GET    /                — list all users in the org
//   GET    /invites         — list pending invites
//   POST   /invites         — create an invite (owner only)
//   DELETE /invites/:id     — revoke a pending invite (owner only)
//   PATCH  /:userId         — update name; a ROLE change goes through the
//                              canonical access write (GAC-2)
//   POST   /:userId/deactivate — revoke Accounting access (canonical write)
//   POST   /:userId/activate   — restore Accounting access (canonical write)
//
// GAC-2 correction (25 Sep 2026): every change to WHO MAY USE ACCOUNTING, or
// with WHICH ROLE, goes through services/access/accessGrantAdmin.service.js —
// mandatory reason, idempotency key, one transaction, append-only audit event,
// tokenVersion bumps, re-read through the canonical resolver. These routes are
// COMPATIBILITY ADAPTERS with no permission logic of their own:
//   consumer:  grav-cms app/accountant/team/page.js
//   deletion:  when that screen manages Accounting access through Access
//              Control (/api/admin/app-access) — proposed GAC-3.
// POST /invites and DELETE /:userId are RETIRED (410): an invite created a
// second login with its own password, and delete removed an access record
// outside the audited write.
//   POST   /:userId/reset-password — owner forces a new password
//
// Note: this round does not send invitation emails. The owner reads the
// invite URL from the team page UI and shares it via WhatsApp / email
// manually. Adding email is a one-function swap when that's wired up.

const express = require("express");
const router = express.Router();

const {
  Acc_User,
  Acc_Invite,
} = require("../../models/Accountant_model/Acc_OrgModels");

const {
  orgAuth,
  requireRole,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { setAccountantPassword } = require("../../services/accountantAccess");
const { recordChange } = require("../../services/changeLog");

router.use(orgAuth);

/**
 * The one way this router changes Accounting access: the canonical write.
 * The actor is the canonical identity behind the signed-in Accounting session
 * (by email); whether they may do this is decided by changeAppAccess — the
 * Accounting Owner or a platform administrator — not here.
 */
async function canonicalAccountingChange(req, res, { email, role, via }) {
  const {
    changeAppAccess,
    canonicalActorForEmail,
    sendGrantError,
  } = require("../../services/access/accessGrantAdmin.service");
  try {
    const actor = await canonicalActorForEmail(req.user?.email);
    const out = await changeAppAccess({
      actor,
      body: {
        email,
        role,
        reason: req.body?.reason,
        idempotencyKey: req.body?.idempotencyKey,
      },
      headers: req.headers,
      defaults: { application: "accountant" },
      via,
    });
    return res.json({ success: true, ...out });
  } catch (e) {
    return sendGrantError(res, e);
  }
}


// ─────────────────────────────────────────────────────────────────────────
// GET / — list users in the org
// ─────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    if (!req.user.organizationId && !req.user.isLegacy) {
      return res
        .status(403)
        .json({ success: false, message: "No organization context" });
    }

    if (req.user.isLegacy || req.user.isDev) {
      return res.json({
        success: true,
        users: [],
        message: "Legacy/dev session — no team data available",
      });
    }

    const users = await Acc_User.find({
      organizationId: req.user.organizationId,
    })
      .select("-passwordHash")
      .sort({ role: 1, name: 1 })
      .lean();

    res.json({ success: true, users });
  } catch (e) {
    console.error("[team] list:", e);
    res.status(500).json({ success: false, message: "Failed to list users" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /invites — pending invites
// ─────────────────────────────────────────────────────────────────────────
router.get("/invites", async (req, res) => {
  try {
    if (req.user.isLegacy || req.user.isDev) {
      return res.json({ success: true, invites: [] });
    }
    const invites = await Acc_Invite.find({
      organizationId: req.user.organizationId,
      consumedAt: null,
    })
      .sort({ createdAt: -1 })
      .lean();

    // Compute status (expired vs still valid)
    const now = new Date();
    const enriched = invites.map((i) => ({
      ...i,
      isExpired: i.expiresAt < now,
    }));

    res.json({ success: true, invites: enriched });
  } catch (e) {
    console.error("[team] invites:", e);
    res.status(500).json({ success: false, message: "Failed to list invites" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /invites — owner invites a new sub-account
// ─────────────────────────────────────────────────────────────────────────
/* GAC-2 correction: RETIRED. An invite produced a new Acc_User login with
   its own password and a role — a second identity and an unaudited grant.
   Existing invite rows are untouched (DELETE /invites/:id still clears them). */
router.post("/invites", requireRole("owner"), (req, res) => {
  res.status(410).json({
    success: false,
    code: "ACCOUNTING_INVITES_RETIRED",
    message: "Invitations are retired. Grant Accounting to the person's GRAV login in Access Control.",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /invites/:id — revoke pending invite
// ─────────────────────────────────────────────────────────────────────────
router.delete("/invites/:id", requireRole("owner"), async (req, res) => {
  try {
    const invite = await Acc_Invite.findOne({
      _id: req.params.id,
      organizationId: req.user.organizationId,
    });
    if (!invite)
      return res
        .status(404)
        .json({ success: false, message: "Invite not found" });
    if (invite.consumedAt) {
      return res.status(400).json({
        success: false,
        message: "Invite already accepted — revoke the user account instead",
      });
    }
    await invite.deleteOne();
    res.json({ success: true });
  } catch (e) {
    console.error("[team] revoke invite:", e);
    res
      .status(500)
      .json({ success: false, message: "Failed to revoke invite" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /:userId — update user name / role
// ─────────────────────────────────────────────────────────────────────────
router.patch("/:userId", requireRole("owner"), async (req, res) => {
  try {
    const user = await Acc_User.findOne({
      _id: req.params.userId,
      organizationId: req.user.organizationId,
    });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    const body = req.body || {};
    const roleRequested = body.role !== undefined && body.role !== user.role;

    // The name is a label, not access — written directly.
    if (body.name && body.name !== user.name) {
      await Acc_User.updateOne({ _id: user._id }, { $set: { name: String(body.name).trim() } });
    }
    if (!roleRequested) {
      const fresh = await Acc_User.findById(user._id).lean();
      return res.json({ success: true, user: { ...fresh, passwordHash: undefined } });
    }
    // A role change is access: the canonical write, and nothing else.
    return canonicalAccountingChange(req, res, {
      email: user.email,
      role: body.role,
      via: "accountant-team:patch",
    });
  } catch (e) {
    console.error("[team] patch user:", e);
    res.status(500).json({ success: false, message: "Failed to update user" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:userId/deactivate  /  /:userId/activate
// ─────────────────────────────────────────────────────────────────────────
async function teamMember(req) {
  return Acc_User.findOne({
    _id: req.params.userId,
    organizationId: req.user.organizationId,
  }).lean();
}

router.post("/:userId/deactivate", requireRole("owner"), async (req, res) => {
  try {
    const user = await teamMember(req);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    return canonicalAccountingChange(req, res, {
      email: user.email,
      role: null,
      via: "accountant-team:deactivate",
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/:userId/activate", requireRole("owner"), async (req, res) => {
  try {
    const user = await teamMember(req);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    // Restores the role the record last held.
    return canonicalAccountingChange(req, res, {
      email: user.email,
      role: user.role,
      via: "accountant-team:activate",
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:userId/reset-password — owner sets a new password directly
// ─────────────────────────────────────────────────────────────────────────
router.post(
  "/:userId/reset-password",
  requireRole("owner"),
  async (req, res) => {
    try {
      const { newPassword } = req.body || {};
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          message: "newPassword must be at least 8 characters",
        });
      }
      const user = await Acc_User.findOne({
        _id: req.params.userId,
        organizationId: req.user.organizationId,
      });
      if (!user)
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      if (user.role === "owner" && String(user._id) !== String(req.user.id)) {
        return res.status(400).json({
          success: false,
          message: "Owners must reset their own password",
        });
      }

      /* Through the shared service, not `user.setPassword` directly.
         ---------------------------------------------------------------
         Somebody who is both an employee and a team member has TWO doors:
         the CMS login checks Employee.password, the books login checks
         Acc_User.password. Writing only the second one here produced a reset
         that reported success and left the CMS door on the old password.
         The service writes both and says which it touched. */
      const { employeeUpdated } = await setAccountantPassword(
        user.email,
        newPassword,
      );

      await recordChange(req, {
        departmentSlug: "accounting",
        section: "accounting:team",
        entity: "acc-user",
        entityId: String(user._id),
        entityLabel: `${user.name} (${user.email})`,
        action: "update",
        summary:
          `Reset ${user.name}'s password. ` +
          (employeeUpdated
            ? "They are also an employee, so their CMS password was changed to match — " +
              "both sign-in doors now use the new one."
            : "They sign in to the books only.") +
          " Their open sessions were ended. The password itself is not recorded.",
        fields: [
          { path: "password", label: "Password", to: "[reset]", kind: "changed" },
        ],
      });

      res.json({
        success: true,
        employeeUpdated,
        message: employeeUpdated
          ? "Password updated for the books and for their CMS sign-in."
          : "Password updated. Their open sessions were ended.",
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:userId — permanently remove a sub-account from the database
// ─────────────────────────────────────────────────────────────────────────
// Hard delete (not deactivate). The owner cannot be deleted, and you cannot
// delete your own account. Past vouchers/approvals keep the stored name
// snapshot, so the books are unaffected.
/* GAC-2 correction: RETIRED. A hard delete removed an Accounting access
   record outside the audited write. Removing somebody's Accounting access is
   POST /:userId/deactivate (a canonical revoke); the row is kept for history. */
router.delete("/:userId", requireRole("owner"), (req, res) => {
  res.status(410).json({
    success: false,
    code: "ACCOUNTING_DELETE_RETIRED",
    message: "Deleting team members is retired. Remove their Accounting access instead (it keeps the history).",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:userId/nav-prefs — read a user's sidebar visibility (owner only)
// ─────────────────────────────────────────────────────────────────────────
// Returns the hiddenNavItems list for the target user. Used by the Team
// page to populate the "Sidebar access" modal before the admin edits it.
router.get("/:userId/nav-prefs", requireRole("owner"), async (req, res) => {
  try {
    const user = await Acc_User.findOne({
      _id: req.params.userId,
      organizationId: req.user.organizationId,
    })
      .select("name email role hiddenNavItems")
      .lean();
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      hiddenNavItems: user.hiddenNavItems || [],
    });
  } catch (e) {
    console.error("[team/nav-prefs GET]", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:userId/nav-prefs — admin sets a user's sidebar visibility
// ─────────────────────────────────────────────────────────────────────────
// Body: { hiddenNavItems: ["/accountant/reports/...", ...] }
//
// Admin-only. The owner controls who sees what — sub-accounts don't get
// to change their own. Default for every user is [] (sees everything they
// have role-access to). When a path is in this list, the matching sidebar
// item is hidden AND visiting that URL renders a 404 for the user.
//
// Restrictions:
//   - cannot modify another owner's preferences (no owner-on-owner edits)
//   - cannot lock the user out of the dashboard (/accountant) — that
//     would leave them with no landing page on login
router.put("/:userId/nav-prefs", requireRole("owner"), async (req, res) => {
  try {
    const { hiddenNavItems } = req.body || {};
    if (!Array.isArray(hiddenNavItems)) {
      return res.status(400).json({
        success: false,
        message: "hiddenNavItems must be an array of strings",
      });
    }
    // Strict shape check — only strings, only valid-looking paths
    const cleaned = hiddenNavItems
      .filter((x) => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.startsWith("/accountant"))
      // Never allow hiding the dashboard — the user would have nowhere
      // to land after login.
      .filter((x) => x !== "/accountant");

    const target = await Acc_User.findOne({
      _id: req.params.userId,
      organizationId: req.user.organizationId,
    });
    if (!target)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    if (target.role === "owner") {
      return res.status(400).json({
        success: false,
        message:
          "Owners always see the full sidebar. You can't hide items from another owner.",
      });
    }
    // `hiddenNavItems` is now declared on the Acc_User schema, so a plain
    // save() would persist too. This stays as updateOne + `strict: false`
    // because it is the write that cannot regress: if the field is ever
    // dropped from the schema again, strict mode would silently discard a
    // save() — no error, no write, and the response still echoing the
    // in-memory value, which is how this went unnoticed the first time.
    const upd = await Acc_User.updateOne(
      { _id: target._id, organizationId: req.user.organizationId },
      { $set: { hiddenNavItems: cleaned } },
      { strict: false },
    );

    if (!upd.matchedCount) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Read back what actually landed in the database, so the client can
    // never be told a value was saved when it wasn't.
    const saved = await Acc_User.findById(target._id)
      .select("hiddenNavItems")
      .lean();

    res.json({
      success: true,
      hiddenNavItems: saved?.hiddenNavItems || [],
      message: `Sidebar updated for ${target.name}. They'll see the change on next page refresh.`,
    });
  } catch (e) {
    console.error("[team/nav-prefs PUT]", e);
    res.status(500).json({
      success: false,
      message: e.message || "Failed to update sidebar preferences",
    });
  }
});

module.exports = router;
