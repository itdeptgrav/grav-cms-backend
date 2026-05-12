// routes/Accountant_Routes/accountantAuthRoutes.js
//
// AUTHENTICATION for the accountant module.
//
// Routes:
//   POST /login            — email + password → cookie + user
//   POST /logout           — clears cookie
//   GET  /me               — returns the current user + org (requires auth)
//   POST /change-password  — current user changes their own password
//   POST /accept-invite    — invitee sets their password using a token
//   POST /bootstrap        — FIRST-RUN ONLY. Creates the first organization
//                            + owner user. Refuses if any org already exists.
//
// All mutations log to console for the first round. Email-sending is a
// no-op stub (the bootstrap and invite flows surface the password/token
// directly so the owner can pass them on).

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = express.Router();

const {
  AccountantOrganization,
  AccountantUser,
  AccountantInvite,
} = require("../../models/Accountant_model/AccountantOrgModels");

const orgAuthModule = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { orgAuth, signOrgToken, extractToken } = orgAuthModule;

// Defensive guard — if AccountantOrgAuthMiddleware.js is missing or out of
// date, Node would otherwise throw an opaque "argument handler must be a
// function" deep inside Express. This check surfaces the real problem.
if (
  typeof orgAuth !== "function" ||
  typeof signOrgToken !== "function" ||
  typeof extractToken !== "function"
) {
  const have = Object.keys(orgAuthModule || {}).join(", ") || "(empty module)";
  throw new Error(
    `[accountantAuthRoutes] AccountantOrgAuthMiddleware.js is missing required exports.\n` +
      `  Expected: orgAuth, signOrgToken, extractToken (all functions).\n` +
      `  Got: ${have}\n` +
      `  Fix: replace backend/Middlewear/AccountantOrgAuthMiddleware.js with the latest version\n` +
      `  from coa-updates/backend/Middlewear/AccountantOrgAuthMiddleware.js, then restart node.`,
  );
}

// Cookie settings. We use a dedicated cookie name `accountant_token` so it
// doesn't collide with other auth cookies the host CMS might use.
const COOKIE_NAME = "accountant_token";
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 12 * 60 * 60 * 1000, // 12h — matches JWT expiry
};

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...COOKIE_OPTS, maxAge: 0 });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /login
// ─────────────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const user = await AccountantUser.findOne({
      email: String(email).toLowerCase(),
    });
    if (!user || !user.isActive) {
      // Same error for missing + inactive to avoid leaking which emails exist
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    const ok = await user.checkPassword(password);
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signOrgToken(user);
    setAuthCookie(res, token);

    res.json({
      success: true,
      token, // also returned in body for clients that prefer Authorization header
      user: {
        id: user._id,
        organizationId: user.organizationId,
        name: user.name,
        email: user.email,
        role: user.role,
        isOwner: user.role === "owner",
      },
    });
  } catch (e) {
    console.error("[accountant/auth/login]", e);
    res.status(500).json({ success: false, message: "Login failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /logout
// ─────────────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /me  — needs auth
// ─────────────────────────────────────────────────────────────────────────
router.get("/me", orgAuth, async (req, res) => {
  if (req.user?.isDev) {
    return res.json({
      success: true,
      user: {
        id: req.user.id,
        name: "Dev Owner",
        email: "dev@local",
        role: "owner",
        isOwner: true,
        isDev: true,
      },
      organization: null,
      permissions: req.user.permissions,
      hiddenNavItems: [],
    });
  }
  if (req.user?.isLegacy) {
    return res.json({
      success: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role || "owner",
        isLegacy: true,
      },
      organization: null,
      permissions: req.user.permissions,
      hiddenNavItems: [],
      message:
        "Logged in via legacy token. Sub-account features unavailable until you log in via the accountant login.",
    });
  }

  // Re-fetch user to read hiddenNavItems (orgAuth only attaches a thin
  // projection). Cheap — single document lookup, indexed.
  let hiddenNavItems = [];
  try {
    const userDoc = await AccountantUser.findById(req.user.id)
      .select("hiddenNavItems")
      .lean();
    if (userDoc?.hiddenNavItems) hiddenNavItems = userDoc.hiddenNavItems;
  } catch (e) {
    // Non-fatal — just default to empty (nothing hidden)
  }

  res.json({
    success: true,
    user: {
      id: req.user.id,
      organizationId: req.user.organizationId,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      isOwner: req.user.role === "owner",
    },
    organization: req.organization
      ? {
          id: req.organization._id,
          name: req.organization.name,
          tallyCompanyIds: req.organization.tallyCompanyIds,
          settings: req.organization.settings,
        }
      : null,
    permissions: req.user.permissions,
    hiddenNavItems,
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (Removed) PUT /nav-prefs — self-service sidebar customization
// ─────────────────────────────────────────────────────────────────────────
// Sidebar visibility is now controlled by the owner per user, not by users
// themselves. See PUT /api/accountant/team/:userId/nav-prefs in
// teamRoutes.js for the admin-only replacement.

// ─────────────────────────────────────────────────────────────────────────
// POST /change-password — current user changes own password
// ─────────────────────────────────────────────────────────────────────────
router.post("/change-password", orgAuth, async (req, res) => {
  try {
    if (req.user?.isDev || req.user?.isLegacy) {
      return res.status(400).json({
        success: false,
        message: "Not supported for legacy/dev sessions",
      });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Both currentPassword and newPassword required",
      });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters",
      });
    }

    const user = await AccountantUser.findById(req.user.id);
    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    const ok = await user.checkPassword(currentPassword);
    if (!ok)
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });

    await user.setPassword(newPassword);
    await user.save();

    res.json({ success: true, message: "Password updated" });
  } catch (e) {
    console.error("[accountant/auth/change-password]", e);
    res.status(500).json({ success: false, message: "Password change failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /accept-invite — invitee uses a token to set their password
// ─────────────────────────────────────────────────────────────────────────
router.post("/accept-invite", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res
        .status(400)
        .json({ success: false, message: "token and password are required" });
    }
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const invite = await AccountantInvite.findOne({ token });
    if (!invite)
      return res
        .status(404)
        .json({ success: false, message: "Invalid invitation token" });
    if (invite.consumedAt)
      return res
        .status(400)
        .json({ success: false, message: "Invitation has already been used" });
    if (invite.expiresAt < new Date())
      return res
        .status(400)
        .json({ success: false, message: "Invitation has expired" });

    // Check the email isn't already a user for this org
    const existing = await AccountantUser.findOne({
      organizationId: invite.organizationId,
      email: invite.email,
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          "An account with this email already exists in the organization",
      });
    }

    const user = new AccountantUser({
      organizationId: invite.organizationId,
      name: invite.name,
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy,
    });
    await user.setPassword(password);
    await user.save();

    invite.consumedAt = new Date();
    invite.consumedByUserId = user._id;
    await invite.save();

    const jwtToken = signOrgToken(user);
    setAuthCookie(res, jwtToken);

    res.status(201).json({
      success: true,
      token: jwtToken,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (e) {
    console.error("[accountant/auth/accept-invite]", e);
    res
      .status(500)
      .json({ success: false, message: "Failed to accept invite" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /bootstrap — create the FIRST organization + owner user
// ─────────────────────────────────────────────────────────────────────────
// Only allowed when there are zero existing organizations. Returns the
// owner login credentials. Subsequent users come in via invite.
//
// Curl example for initial setup:
//   curl -X POST http://localhost:5000/api/accountant/auth/bootstrap \
//     -H "Content-Type: application/json" \
//     -d '{"organizationName":"GRAV","ownerName":"Owner Name","email":"owner@grav.in","password":"choose-a-strong-one"}'
router.post("/bootstrap", async (req, res) => {
  try {
    const existing = await AccountantOrganization.countDocuments({});
    if (existing > 0) {
      return res.status(403).json({
        success: false,
        message:
          "An organization already exists. Bootstrap is disabled. Use invite flow.",
      });
    }

    const { organizationName, ownerName, email, password } = req.body || {};
    if (!organizationName || !ownerName || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          "organizationName, ownerName, email, and password are required",
      });
    }
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const org = await AccountantOrganization.create({
      name: organizationName,
      tallyCompanyIds: [],
      settings: {
        requireApprovalForVouchers: true,
        requireApprovalForLedgerEdits: true,
      },
    });

    const user = new AccountantUser({
      organizationId: org._id,
      name: ownerName,
      email: String(email).toLowerCase(),
      role: "owner",
    });
    await user.setPassword(password);
    await user.save();

    org.ownerUserId = user._id;
    await org.save();

    res.status(201).json({
      success: true,
      message: "Organization bootstrapped successfully. You can now log in.",
      organizationId: org._id,
      userId: user._id,
      email: user.email,
    });
  } catch (e) {
    console.error("[accountant/auth/bootstrap]", e);
    res
      .status(500)
      .json({ success: false, message: e.message || "Bootstrap failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sync-legacy — auto-bootstrap from a legacy CMS login
// ─────────────────────────────────────────────────────────────────────────
// Background: the main GRAV CMS has its own login page where the user
// `accountant@grav.in` (an Employee/AccountantDepartment record) signs in.
// That issues a legacy JWT with role:"accountant" but no organizationId.
//
// When that user lands on the accountant module's frontend, the
// AuthProvider sees `isLegacy: true` from `/me` and calls this endpoint
// to upgrade the session into the new sub-account world WITHOUT making
// the user log in again.
//
// What this does:
//   1. Verifies the legacy JWT (so we trust the email)
//   2. If there's already an AccountantUser with that email → just sign
//      a new org token, set cookie, done.
//   3. Else: create (or reuse) the AccountantOrganization, create an
//      owner AccountantUser linked to the legacy email, attach any
//      existing TallyCompanies the user has access to, set cookie, done.
//
// The user never types a password. The legacy CMS login already
// authenticated them, and we transitively trust that.

router.post("/sync-legacy", async (req, res) => {
  try {
    // 1. Verify legacy token
    const token = extractToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "No legacy session detected" });
    }

    let decoded;
    try {
      decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "grav_clothing_secret_key",
      );
    } catch (e) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid legacy token" });
    }

    // The legacy JWT shape varies between login routes — try multiple field
    // names. We trust the DB record as the source of truth, not the JWT
    // claims, so we just need to find SOMETHING that identifies the user.
    const legacyUserId =
      decoded.id || decoded._id || decoded.userId || decoded.employeeId;
    const legacyEmail = (decoded.email || "").toLowerCase();

    // Look the user up in the AccountantDepartment collection. This is
    // the source of truth — if a record exists and isActive, they are
    // legitimately a main accountant admin.
    let mongooseRef;
    try {
      mongooseRef = require("mongoose");
    } catch (e) {
      return res
        .status(500)
        .json({ success: false, message: "mongoose not available" });
    }

    // Try to find the AccountantDepartment record by id or email
    let acctDept = null;
    try {
      const AccountantDepartment =
        mongooseRef.models.AccountantDepartment ||
        require("../../models/Accountant_model/AccountantDepartment.js");

      if (
        legacyUserId &&
        mongooseRef.Types.ObjectId.isValid(String(legacyUserId))
      ) {
        acctDept = await AccountantDepartment.findById(legacyUserId);
      }
      if (!acctDept && legacyEmail) {
        acctDept = await AccountantDepartment.findOne({ email: legacyEmail });
      }
    } catch (e) {
      console.warn(
        "[sync-legacy] AccountantDepartment lookup failed:",
        e.message,
      );
    }

    if (!acctDept) {
      return res.status(403).json({
        success: false,
        message:
          "Your account isn't recognised as an accountant in the system. Only main accountant admin accounts can be promoted to organization owner.",
        debug: {
          decodedKeys: Object.keys(decoded),
          decodedRole: decoded.role,
          decodedEmail: decoded.email,
          decodedId: decoded.id || decoded._id || decoded.userId,
        },
      });
    }
    if (!acctDept.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your accountant account is inactive.",
      });
    }

    // We trust the DB record now — use its fields, not the JWT's.
    const trustedEmail = acctDept.email.toLowerCase();
    const trustedName = acctDept.name || "Accountant Admin";

    // 2. Already promoted? Just refresh the cookie.
    let user = await AccountantUser.findOne({ email: trustedEmail });
    if (user) {
      if (!user.isActive) {
        return res.status(403).json({
          success: false,
          message: "Account is inactive — contact your owner.",
        });
      }
      user.lastLoginAt = new Date();
      await user.save();
      const jwtToken = signOrgToken(user);
      setAuthCookie(res, jwtToken);
      return res.json({
        success: true,
        promoted: false,
        message: "Existing account — session refreshed.",
        user: {
          id: user._id,
          organizationId: user.organizationId,
          name: user.name,
          email: user.email,
          role: user.role,
          isOwner: user.role === "owner",
        },
      });
    }

    // 3. Not yet in the new system. Promote them.
    let org = await AccountantOrganization.findOne({});
    if (!org) {
      const fallbackOrgName = trustedEmail.includes("@")
        ? trustedEmail.split("@")[1].split(".")[0].toUpperCase()
        : "Organization";
      org = await AccountantOrganization.create({
        name: fallbackOrgName,
        tallyCompanyIds: [],
        settings: {
          requireApprovalForVouchers: true,
          requireApprovalForLedgerEdits: true,
        },
      });
    }

    // Auto-attach all existing TallyCompanies to this org
    try {
      const TallyCompanyModel = mongooseRef.models.TallyCompany;
      if (
        TallyCompanyModel &&
        (!org.tallyCompanyIds || org.tallyCompanyIds.length === 0)
      ) {
        const companies = await TallyCompanyModel.find({}).select("_id").lean();
        if (companies.length > 0) {
          org.tallyCompanyIds = companies.map((c) => c._id);
          await org.save();
        }
      }
    } catch (e) {
      console.warn(
        "[sync-legacy] auto-attach TallyCompanies skipped:",
        e.message,
      );
    }

    user = new AccountantUser({
      organizationId: org._id,
      name: trustedName,
      email: trustedEmail,
      role: "owner",
    });
    const placeholderPassword = require("crypto")
      .randomBytes(24)
      .toString("hex");
    await user.setPassword(placeholderPassword);
    user.lastLoginAt = new Date();
    await user.save();

    if (!org.ownerUserId) {
      org.ownerUserId = user._id;
      await org.save();
    }

    const jwtToken = signOrgToken(user);
    setAuthCookie(res, jwtToken);

    return res.json({
      success: true,
      promoted: true,
      message: "Legacy account promoted to organization owner.",
      user: {
        id: user._id,
        organizationId: user.organizationId,
        name: user.name,
        email: user.email,
        role: user.role,
        isOwner: true,
      },
      organization: {
        id: org._id,
        name: org.name,
        tallyCompanyIds: org.tallyCompanyIds,
      },
    });
  } catch (e) {
    console.error("[accountant/auth/sync-legacy]", e);
    res
      .status(500)
      .json({ success: false, message: e.message || "Sync failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /debug-token — returns the decoded contents of whatever JWT cookie
// the client is sending. NO secret information — just shows the public
// claims. Used to debug the legacy-token shape during sync-legacy.
// ─────────────────────────────────────────────────────────────────────────
router.get("/debug-token", (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.json({ ok: false, message: "no token in request" });

    let decoded;
    try {
      decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "grav_clothing_secret_key",
      );
    } catch (e) {
      return res.json({
        ok: false,
        message: "invalid token",
        error: e.message,
      });
    }

    return res.json({
      ok: true,
      tokenPresent: true,
      decodedKeys: Object.keys(decoded),
      decoded: {
        id: decoded.id || decoded._id || decoded.userId,
        organizationId: decoded.organizationId || null,
        role: decoded.role || null,
        userType: decoded.userType || null,
        email: decoded.email || null,
        name: decoded.name || null,
        employeeId: decoded.employeeId || null,
        iat: decoded.iat,
        exp: decoded.exp,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
