// routes/Accountant_Routes/Acc_auth.js
//
// AUTHENTICATION for the accountant module.

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = express.Router();

const {
  Acc_Organization,
  Acc_User,
  Acc_Invite,
} = require("../../models/Accountant_model/Acc_OrgModels");

const orgAuthModule = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { orgAuth, signOrgToken, extractToken } = orgAuthModule;

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

const COOKIE_NAME = "accountant_token";
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  maxAge: 24 * 60 * 60 * 1000,
  path: "/",
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

    const user = await Acc_User.findOne({
      email: String(email).toLowerCase(),
    });
    if (!user || !user.isActive) {
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
      token,
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
// POST /push-token — register an FCM web-push device token for the current
// user. The accountant app calls this after the user grants notification
// permission. Stored on Acc_User.fcmTokens; the approval-notification service
// reads it to deliver web push. Idempotent ($addToSet handles re-registration
// and multiple devices).
// ─────────────────────────────────────────────────────────────────────────
router.post("/push-token", orgAuth, async (req, res) => {
  try {
    const token = req.body?.token;
    if (!token || typeof token !== "string") {
      return res
        .status(400)
        .json({ success: false, message: "token is required" });
    }
    // A push token identifies a DEVICE, not a person. If another account
    // previously registered this same token (shared browser, or this device
    // switching logins), detach it from them first — otherwise it sits stale
    // on that account and FCM keeps "accepting" sends to it that never arrive.
    // Then attach it to whoever is logged in on this device now.
    await Acc_User.updateMany(
      { _id: { $ne: req.user.id }, fcmTokens: token },
      { $pull: { fcmTokens: token } },
    );
    await Acc_User.updateOne(
      { _id: req.user.id },
      { $addToSet: { fcmTokens: token } },
    );
    res.json({ success: true });
  } catch (e) {
    console.error("[accountant/auth/push-token]", e);
    res.status(500).json({ success: false, message: "Failed to save token" });
  }
});

// DELETE /push-token — drop a token (sign-out on this device / permission revoked)
router.delete("/push-token", orgAuth, async (req, res) => {
  try {
    const token = req.body?.token;
    if (token) {
      await Acc_User.updateOne(
        { _id: req.user.id },
        { $pull: { fcmTokens: token } },
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error("[accountant/auth/push-token delete]", e);
    res.status(500).json({ success: false, message: "Failed to remove token" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /me  — needs auth
// ─────────────────────────────────────────────────────────────────────────
router.get("/me", orgAuth, async (req, res) => {
  // ── Dev bypass ───────────────────────────────────────────────────────────
  // FIX: added `return` so execution stops here; moved hiddenNavItems
  // reference inside a block where it's safely hard-coded to [] for dev mode.
  if (req.user?.isDev) {
    return res.json({
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
      hiddenNavItems: [], // dev users always see everything
    });
  }

  // ── Legacy token ─────────────────────────────────────────────────────────
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

  // ── Regular org user ─────────────────────────────────────────────────────
  // Re-fetch user to read hiddenNavItems (orgAuth only attaches a thin
  // projection). Cheap — single document lookup, indexed.
  let hiddenNavItems = [];
  try {
    const userDoc = await Acc_User.findById(req.user.id)
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
    // Owners always get an empty list regardless of what's stored in the DB.
    // The PUT /nav-prefs endpoint already blocks writes for owners, but any
    // values stored before that guard was added are silently cleared here.
    hiddenNavItems: req.user?.role === "owner" ? [] : hiddenNavItems,
  });
});

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

    const user = await Acc_User.findById(req.user.id);
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

    const invite = await Acc_Invite.findOne({ token });
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

    const existing = await Acc_User.findOne({
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

    const user = new Acc_User({
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
router.post("/bootstrap", async (req, res) => {
  try {
    const existing = await Acc_Organization.countDocuments({});
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

    const org = await Acc_Organization.create({
      name: organizationName,
      tallyCompanyIds: [],
      settings: {
        requireApprovalForVouchers: true,
        requireApprovalForLedgerEdits: true,
      },
    });

    const user = new Acc_User({
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
router.post("/sync-legacy", async (req, res) => {
  try {
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

    const legacyUserId =
      decoded.id || decoded._id || decoded.userId || decoded.employeeId;
    const legacyEmail = (decoded.email || "").toLowerCase();

    let mongooseRef;
    try {
      mongooseRef = require("mongoose");
    } catch (e) {
      return res
        .status(500)
        .json({ success: false, message: "mongoose not available" });
    }

    let acctDept = null;
    try {
      const Acc_Department =
        mongooseRef.models.Acc_Department ||
        require("../../models/Accountant_model/Acc_Department.js");

      if (
        legacyUserId &&
        mongooseRef.Types.ObjectId.isValid(String(legacyUserId))
      ) {
        acctDept = await Acc_Department.findById(legacyUserId);
      }
      if (!acctDept && legacyEmail) {
        acctDept = await Acc_Department.findOne({ email: legacyEmail });
      }

      if (!acctDept) {
        const allDepts = await Acc_Department.find({})
          .select("_id email name role")
          .lean();
      }
    } catch (e) {
      console.warn("[sync-legacy] Acc_Department lookup failed:", e.message);
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

    const trustedEmail = acctDept.email.toLowerCase();
    const trustedName = acctDept.name || "Accountant Admin";

    const emailRe = new RegExp(
      "^" + trustedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      "i",
    );
    let user = await Acc_User.findOne({ email: emailRe });
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

    let org = await Acc_Organization.findOne({});
    if (!org) {
      const fallbackOrgName = trustedEmail.includes("@")
        ? trustedEmail.split("@")[1].split(".")[0].toUpperCase()
        : "Organization";
      org = await Acc_Organization.create({
        name: fallbackOrgName,
        tallyCompanyIds: [],
        settings: {
          requireApprovalForVouchers: true,
          requireApprovalForLedgerEdits: true,
        },
      });
    }

    try {
      const CompanyModel = mongooseRef.models.Acc_Company;
      if (
        CompanyModel &&
        (!org.tallyCompanyIds || org.tallyCompanyIds.length === 0)
      ) {
        const companies = await CompanyModel.find({}).select("_id").lean();
        if (companies.length > 0) {
          org.tallyCompanyIds = companies.map((c) => c._id);
          await org.save();
        }
      }
    } catch (e) {
      console.warn("[sync-legacy] auto-attach companies skipped:", e.message);
    }

    user = await Acc_User.findOne({
      organizationId: org._id,
      email: emailRe,
    });
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

    try {
      user = new Acc_User({
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
    } catch (insertErr) {
      if (insertErr && insertErr.code === 11000) {
        user = await Acc_User.findOne({
          organizationId: org._id,
          email: emailRe,
        });
        if (!user) {
          throw insertErr;
        }
        user.lastLoginAt = new Date();
        await user.save();
      } else {
        throw insertErr;
      }
    }

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
    console.error(e);
    res
      .status(500)
      .json({ success: false, message: e.message || "Sync failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /debug-token
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
