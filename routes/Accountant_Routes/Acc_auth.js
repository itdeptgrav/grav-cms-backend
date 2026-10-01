// routes/Accountant_Routes/Acc_auth.js
//
// AUTHENTICATION for the accountant module.

const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = express.Router();

const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");

/* Company ownership: this router no longer attaches companies at all — the
   sync-legacy auto-promotion that did so is retired (GAC-2 correction). The
   one writer remains services/accountantCompanyOwnership.service.js. */

const orgAuthModule = require("../../Middlewear/AccountantOrgAuthMiddleware");
const {
  orgAuth,
  // The ONLY middleware that accepts a legacy CMS session, and the only place
  // it may be mounted: GET /me (so the frontend can detect the legacy session)
  // and POST /sync-legacy (which upgrades it). It attaches a zero-permission
  // identity — see AccountantOrgAuthMiddleware.js.
  legacyBootstrapAuth,
  ACCOUNTING_SESSION_UPGRADE_REQUIRED,
  signOrgToken,
  extractToken,
} = orgAuthModule;

if (
  typeof orgAuth !== "function" ||
  typeof legacyBootstrapAuth !== "function" ||
  typeof signOrgToken !== "function" ||
  typeof extractToken !== "function"
) {
  const have = Object.keys(orgAuthModule || {}).join(", ") || "(empty module)";
  throw new Error(
    `[accountantAuthRoutes] AccountantOrgAuthMiddleware.js is missing required exports.\n` +
      `  Expected: orgAuth, legacyBootstrapAuth, signOrgToken, extractToken (all functions).\n` +
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

    /* GAC-2 correction — one person, one login. This door opens only for an
       ACCOUNTING-ONLY person: somebody whose canonical identity is this
       Acc_User (no DeptUser, no active Employee). A person with a GRAV login
       signs in there; their Acc_User row is role storage and is refused here
       by that fact — and by loginMode — never by the hash it happens to hold. */
    const { classify } = require("../../services/access/canonicalIdentity.service");
    const identity = await classify(String(email));
    if (identity.kind !== "accountant") {
      return res
        .status(401)
        .json({ success: false, message: "Invalid email or password" });
    }
    const user = await Acc_User.findOne({
      email: String(email).toLowerCase(),
      loginMode: { $ne: "none" },
      isActive: true,
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
// POST /logout-all  — invalidate this user's sessions on EVERY device
// ─────────────────────────────────────────────────────────────────────────
// Bumping tokenVersion makes every JWT previously signed for this user fail
// the version check in orgAuth — including the token on the current device —
// so all sessions are forced to re-login.
router.post("/logout-all", orgAuth, async (req, res) => {
  try {
    // Legacy / dev sessions have no Acc_User row to bump — just clear locally.
    if (req.user?.isLegacy || req.user?.isDev || !req.user?.id) {
      clearAuthCookie(res);
      return res.json({ success: true, message: "Logged out." });
    }
    await Acc_User.findByIdAndUpdate(req.user.id, {
      $inc: { tokenVersion: 1 },
      $set: { sessionsRevokedAt: new Date() },
    });
    clearAuthCookie(res);
    res.json({
      success: true,
      message: "Logged out from all devices.",
    });
  } catch (e) {
    console.error("[accountant/auth/logout-all]", e);
    res.status(500).json({ success: false, message: "Logout failed" });
  }
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
// Mounted on `legacyBootstrapAuth`, not `orgAuth`: a legacy CMS session must
// still be able to identify itself here, because that is exactly how the
// frontend learns it needs to call /sync-legacy. The session it gets carries no
// permissions, so this endpoint tells the caller who they are and nothing else.
router.get("/me", legacyBootstrapAuth, async (req, res) => {
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

  // ── Legacy token — bootstrap identity only ───────────────────────────────
  // Every permission is false and there is no organisation. The response is
  // deliberately explicit: `isLegacy` is what AuthProvider already keys off to
  // POST /sync-legacy, and `code` + `upgradeEndpoint` say so unambiguously for
  // anything else reading this. Nothing in the accounting module is reachable
  // with this session until the upgrade succeeds.
  if (req.user?.isLegacy) {
    return res.json({
      success: true,
      code: ACCOUNTING_SESSION_UPGRADE_REQUIRED,
      requiresUpgrade: true,
      upgradeEndpoint: "/api/accountant/auth/sync-legacy",
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        // No silent promotion to "owner" — an absent role is an absent role.
        role: req.user.role || "legacy",
        isLegacy: true,
      },
      organization: null,
      permissions: req.user.permissions,
      hiddenNavItems: [],
      message:
        "Legacy CMS session detected. It grants no accounting access — " +
        "sync your accounting session to continue, or sign in to the accounting module.",
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
    // A role-only record has no password of its own (GAC-2 correction).
    if (user.loginMode === "none") {
      return res.status(400).json({
        success: false,
        code: "ROLE_ONLY_RECORD",
        message: "You sign in with your GRAV login. Change your password there.",
      });
    }

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
/* GAC-2 correction: RETIRED. Accepting an invite created a new Acc_User
   login with its own password and an Accounting role — a second identity for
   the person and an access grant made outside the canonical write. Accounting
   access is now granted in Access Control to a person's existing GRAV login
   (PUT /api/admin/app-access). The invite rows are kept, untouched. */
router.post("/accept-invite", (req, res) => {
  res.status(410).json({
    success: false,
    code: "ACCOUNTING_INVITES_RETIRED",
    message: "Accounting invitations are no longer used. Ask an administrator to grant you Accounting in Access Control, then sign in with your GRAV login.",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /bootstrap — create the FIRST organization + owner user
// ─────────────────────────────────────────────────────────────────────────
/* GAC-2 correction: RETIRED. Bootstrap created the Accounting organisation
   together with a new password login holding the Owner role — an identity and
   an access grant outside the canonical write. The organisation exists; the
   Accounting Owner is assigned in Access Control. */
router.post("/bootstrap", (req, res) => {
  res.status(410).json({
    success: false,
    code: "ACCOUNTING_BOOTSTRAP_RETIRED",
    message: "Accounting setup is complete. The Accounting Owner is assigned in Access Control.",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /sync-legacy — auto-bootstrap from a legacy CMS login
// ─────────────────────────────────────────────────────────────────────────
// Mounted on `legacyBootstrapAuth` — the same door as /me — rather than
// extracting a token itself. That is what makes the guard below possible: this
// endpoint consumes a LEGACY BOOTSTRAP IDENTITY, and can now tell one from an
// organisation-aware session instead of feeding whatever token came first into
// the lookup below.
//
// Why that mattered: an accountant_token carries the Acc_User's own email, so
// the lookup below would MATCH on it and mint a fresh session. The
// revocation check further down reads `iat` from a CMS token and knows nothing
// about tokenVersion, so a token already revoked by "log out of all devices"
// could have re-minted itself here — the exact thing that check exists to stop.
router.post("/sync-legacy", legacyBootstrapAuth, async (req, res) => {
  try {
    // Already organisation-aware (or a dev session): there is nothing to
    // upgrade, and its token is not a department identity. Answered rather than
    // refused, so a frontend that calls this speculatively just carries on.
    if (!req.user?.isLegacy || !req.legacyBootstrap?.decoded) {
      return res.json({
        success: true,
        promoted: false,
        alreadyUpgraded: true,
        message: "This session is already organisation-aware — nothing to upgrade.",
        user: {
          id: req.user?.id,
          organizationId: req.user?.organizationId || null,
          name: req.user?.name,
          email: req.user?.email,
          role: req.user?.role,
          isOwner: req.user?.role === "owner",
        },
      });
    }

    const decoded = req.legacyBootstrap.decoded;

    /* WHAT PROVES AN ACCOUNTING GRANT (1 Oct 2026).
       ------------------------------------------------------------------
       This used to resolve an `Acc_Department` row first and refuse anyone
       who had none. That collection (`acc_departments`) is EMPTY in the
       live database — the legacy accountant rows were left behind in the
       pre-rename `accountantdepartments`, and only ever covered one
       address. So EVERY person who signed in through the CMS — including
       the Accounting owner — was refused here with "Your account isn't
       recognised as an accountant in the system", kept on the
       zero-permission bootstrap identity, and the module never loaded.

       The department row was only ever the input to the auto-promotion
       branch (it decided WHO could be made an owner). That branch is
       retired — nothing is created here any more — so the lookup now gates
       legitimate users and grants nothing.

       The Acc_User row IS the Accounting grant: it is what Access Control
       writes, it carries the role and the organisation, and a row with
       `loginMode: "none"` is exactly this case — Accounting ROLE STORAGE
       for somebody whose login identity lives elsewhere (see
       services/access/canonicalIdentity.service.js). So that is what is
       read, and no row still means ACCOUNTING_GRANT_REQUIRED.

       The email comes from the bootstrap token, which `legacyBootstrapAuth`
       has already verified against JWT_SECRET — it is this backend's own
       claim about who signed in, not caller-supplied input. */
    const legacyEmail = (decoded.email || "").toLowerCase().trim();
    if (!legacyEmail) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNTING_GRANT_REQUIRED",
        message:
          "Your session carries no email address, so no Accounting role can be matched to it. Sign in again from the main login page.",
      });
    }

    const emailRe = new RegExp(
      "^" + legacyEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
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
      // ── Reject a re-bootstrap after "log out of all devices" ─────────────
      // If this owner hit logout-all, sessionsRevokedAt is set. A CMS token
      // minted BEFORE that moment must not silently re-create an accountant
      // session, or other devices never actually log out. The owner has to
      // sign in again at /login (which issues a fresh CMS token, newer iat).
      if (
        user.sessionsRevokedAt &&
        decoded.iat &&
        decoded.iat * 1000 < new Date(user.sessionsRevokedAt).getTime()
      ) {
        clearAuthCookie(res);
        return res.status(200).json({
          success: false,
          code: "SESSION_REVOKED",
          message:
            "You logged out of all devices. Please sign in again from the main login page.",
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
        // Returned in the body as well as the cookie. lib/api.js stores this
        // and replays it as `Authorization: Bearer`, which is now the only
        // cross-origin fallback there is — falling back to the CMS token buys
        // the bootstrap flow and nothing else.
        token: jwtToken,
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

    /* GAC-2 correction: the auto-promotion that used to follow here is
       RETIRED. It created a new Acc_User holding the Accounting OWNER role for
       any active legacy Accounting department account that had none (and the
       organisation too, and attached every company to it) — an access grant
       made outside the canonical write, with no reason, no audit event and no
       administrator. A legacy account that holds no Accounting role is now
       told to get one through Access Control. Nothing is created. */
    return res.status(403).json({
      success: false,
      code: "ACCOUNTING_GRANT_REQUIRED",
      message: "You have no Accounting role. Ask an administrator to grant Accounting in Access Control.",
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
        require("../../config/jwt").SECRET,
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
