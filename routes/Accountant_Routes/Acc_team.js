// routes/Accountant_Routes/Acc_team.js
//
// TEAM MANAGEMENT — owner invites sub-accounts and assigns roles.
//
// Routes (all require `orgAuth`):
//   GET    /                — list all users in the org
//   GET    /invites         — list pending invites
//   POST   /invites         — create an invite (owner only)
//   DELETE /invites/:id     — revoke a pending invite (owner only)
//   PATCH  /:userId         — update name / role (owner only; cannot demote owner)
//   POST   /:userId/deactivate — soft-disable login (owner only)
//   POST   /:userId/activate   — re-enable (owner only)
//   POST   /:userId/reset-password — owner forces a new password
//
// Note: this round does not send invitation emails. The owner reads the
// invite URL from the team page UI and shares it via WhatsApp / email
// manually. Adding email is a one-function swap when that's wired up.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const {
  Acc_User,
  Acc_Invite,
} = require("../../models/Accountant_model/Acc_OrgModels");

const {
  orgAuth,
  requireRole,
} = require("../../Middlewear/AccountantOrgAuthMiddleware");

router.use(orgAuth);

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
router.post("/invites", requireRole("owner"), async (req, res) => {
  try {
    const { name, email, role } = req.body || {};
    if (!name || !email || !role) {
      return res
        .status(400)
        .json({ success: false, message: "name, email, role required" });
    }
    if (!["approver", "editor", "viewer"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "role must be approver, editor, or viewer",
      });
    }

    const lowerEmail = String(email).toLowerCase();

    // Reject if the email is already a user in this org
    const existingUser = await Acc_User.findOne({
      organizationId: req.user.organizationId,
      email: lowerEmail,
    });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists in your organization",
      });
    }

    // Reject if there's already a live (unconsumed, unexpired) invite
    const liveInvite = await Acc_Invite.findOne({
      organizationId: req.user.organizationId,
      email: lowerEmail,
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (liveInvite) {
      return res.status(409).json({
        success: false,
        message: "An active invite already exists for this email",
        invite: liveInvite,
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await Acc_Invite.create({
      organizationId: req.user.organizationId,
      name,
      email: lowerEmail,
      role,
      token,
      expiresAt,
      invitedBy: req.user.id,
    });

    // Compose the accept URL. The invite link must point at the FRONTEND
    // (where /accountant/accept-invite lives), not the backend that
    // generated it. Priority:
    //   1. FRONTEND_URL env var — set this in production
    //   2. The request's Origin header — present whenever a browser
    //      calls this endpoint cross-origin (i.e. always in this app)
    //   3. The Referer header — fallback for clients that strip Origin
    //   4. http://localhost:3000 — last resort for tests/curl from CLI
    function resolveFrontendBase() {
      if (process.env.FRONTEND_URL) {
        return process.env.FRONTEND_URL.replace(/\/+$/, "");
      }
      const origin = req.headers.origin;
      if (origin && /^https?:\/\//.test(origin)) {
        return origin.replace(/\/+$/, "");
      }
      const referer = req.headers.referer;
      if (referer && /^https?:\/\//.test(referer)) {
        try {
          const u = new URL(referer);
          return `${u.protocol}//${u.host}`;
        } catch {
          /* fall through */
        }
      }
      return "http://localhost:3000";
    }
    const frontendBase = resolveFrontendBase();
    const acceptUrl = `${frontendBase}/accountant/accept-invite?token=${token}`;

    res.status(201).json({
      success: true,
      invite,
      acceptUrl,
      message: "Invite created. Share the accept URL with the invitee.",
    });
  } catch (e) {
    console.error("[team] create invite:", e);
    res.status(500).json({
      success: false,
      message: e.message || "Failed to create invite",
    });
  }
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

    if (user.role === "owner" && req.body.role && req.body.role !== "owner") {
      return res.status(400).json({
        success: false,
        message: "Cannot demote the owner. Transfer ownership first.",
      });
    }

    if (req.body.name) user.name = req.body.name;
    if (
      req.body.role &&
      ["approver", "editor", "viewer"].includes(req.body.role)
    ) {
      user.role = req.body.role;
    }
    await user.save();
    res.json({
      success: true,
      user: { ...user.toObject(), passwordHash: undefined },
    });
  } catch (e) {
    console.error("[team] patch user:", e);
    res.status(500).json({ success: false, message: "Failed to update user" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:userId/deactivate  /  /:userId/activate
// ─────────────────────────────────────────────────────────────────────────
router.post("/:userId/deactivate", requireRole("owner"), async (req, res) => {
  try {
    const user = await Acc_User.findOne({
      _id: req.params.userId,
      organizationId: req.user.organizationId,
    });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (user.role === "owner")
      return res
        .status(400)
        .json({ success: false, message: "Cannot deactivate the owner" });
    user.isActive = false;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/:userId/activate", requireRole("owner"), async (req, res) => {
  try {
    const user = await Acc_User.findOne({
      _id: req.params.userId,
      organizationId: req.user.organizationId,
    });
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    user.isActive = true;
    await user.save();
    res.json({ success: true });
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
      await user.setPassword(newPassword);
      await user.save();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

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

    target.hiddenNavItems = cleaned;
    await target.save();

    res.json({
      success: true,
      hiddenNavItems: target.hiddenNavItems,
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
