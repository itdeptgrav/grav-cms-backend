// Middlewear/AccountantAuthMiddleware.js
//
// COMPATIBILITY FAÇADE over AccountantOrgAuthMiddleware. (Lane A, Chunk 2)
//
// ─── WHAT THIS FILE USED TO BE ────────────────────────────────────────────────
// Its own authentication system. It read a JWT from any of four cookies or the
// Bearer header, verified the signature, and then answered from the CLAIMS:
// a token saying `role: "accountant"` or `role: "admin"` was handed canEdit,
// canPostDirectly, canApprove, canManageTeam and canManageSettings by
// `legacyRolePermissions`, with no database anywhere in the decision. Every
// department login in this CMS issues a token, and the accounting department's
// own login issues exactly those two role names — so the 39 route files behind
// this middleware (vouchers, invoices, journals, reports, settings, parties,
// banking, expenses, payroll) trusted a string in a cookie.
//
// Nothing here checked whether the user still existed, was still active, still
// belonged to an organisation, or had been logged out of all devices. Chunk 1
// closed that door on the `orgAuth` routes; this closes it on the rest.
//
// ─── WHAT IT IS NOW ───────────────────────────────────────────────────────────
// A thin translation layer. Every export resolves through `orgAuth`, which is
// the single place that:
//   • selects the right credential when several are present,
//   • confirms the Acc_User against the database (exists, active, token version
//     current, organisation matches),
//   • confirms the organisation is active,
//   • derives permissions from the STORED role, never from the token,
//   • refuses legacy CMS sessions with ACCOUNTING_SESSION_UPGRADE_REQUIRED.
//
// The 39 route files import the same names and are not edited. What changed is
// what those names do.
//
// ─── THE ALLOW-LIST TRANSLATION ───────────────────────────────────────────────
// Those routes are gated by `makeAuth(["accountant","admin"])` — a role-NAME
// allow-list. No organisation token can ever contain "accountant" or "admin";
// they carry owner / approver / editor / viewer. Comparing names would refuse
// every legitimate user, and accepting the four new names wholesale would let a
// viewer post vouchers on all 39, because fine-grained `requirePermission`
// guards exist on only a handful of them.
//
// So the allow-list is read for what it MEANT and answered from the role's
// CAPABILITIES:
//
//   makeAuth(["admin"])            → manage settings → canManageSettings
//   makeAuth(["accountant", ...])  → the module gate → canView to look,
//                                                      canEdit to change
//
// Method-based, because these routes never had a read/write split of their own
// — one middleware sits in front of both the GET that lists credit notes and
// the POST that issues one. Deriving it from the HTTP verb is what makes
// "Viewer · read-only" true across all 39 without editing any of them.
//
// ─── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
// • No `jwt.verify`. There is exactly one token verifier in Accounting now, and
//   it lives in AccountantOrgAuthMiddleware. `test/accountant/
//   accounting-auth-inventory.test.js` fails if a second one reappears.
// • No `legacyRolePermissions` — that WAS the legacy grant.
// • No `verifyToken` export — it was an independent verification path, and
//   nothing imported it.
// • No company scoping. `orgAuth` attaches a trustworthy `req.organization`;
//   turning that into per-route company enforcement is Lane A Chunk 3, and
//   bolting `requireCompanyAccess` onto 39 routes blind would refuse legitimate
//   traffic on routes that name a company in ways this layer cannot see.
//
// DEV BYPASS: `ACCOUNTANT_AUTH_BYPASS=true` is still honoured, but by `orgAuth`
// — one bypass in one place. It injects an owner-equivalent dev session rather
// than this file's old fake admin. NEVER set it in production.

const mongoose = require("mongoose");

const {
  orgAuth,
  requireCompanyScope,
  scopeCompanyIfPresent,
} = require("./AccountantOrgAuthMiddleware");

/* ------------------------------------------------------------------ */
/* Token extraction — delegated                                        */
/* ------------------------------------------------------------------ */
//
// Re-exported so older imports keep resolving, and delegated so there is one
// implementation of "where might a token be". Extraction is not authorisation:
// this returns a string and decides nothing.

const {
  extractToken,
} = require("./AccountantOrgAuthMiddleware");

/* ------------------------------------------------------------------ */
/* Role → capability tables                                            */
/* ------------------------------------------------------------------ */

const NEW_ROLES = ["owner", "approver", "editor", "viewer"];

function isNewRole(role) {
  return NEW_ROLES.includes(role);
}

// Kept as an exported helper because it is a pure, useful description of the
// role model. Note that `orgAuth` computes the permissions it attaches from the
// STORED role — this is not what gates anything.
function newRolePermissions(role) {
  const p = {
    canView: true,
    canEdit: false,
    canPostDirectly: false,
    canApprove: false,
    canManageTeam: false,
    canManageSettings: false,
  };
  if (role === "owner") {
    p.canEdit =
      p.canPostDirectly =
      p.canApprove =
      p.canManageTeam =
      p.canManageSettings =
        true;
  } else if (role === "approver") {
    p.canEdit = p.canPostDirectly = p.canApprove = true;
  } else if (role === "editor") {
    p.canEdit = true;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Allow-list → capability                                             */
/* ------------------------------------------------------------------ */

/**
 * Translate a legacy role-name allow-list into the capability it was asking for.
 * Never compares a new role name against an old one — the two vocabularies
 * share no words, so a name comparison here can only ever be wrong.
 */
function requiredCapability(allowedRoles, method) {
  // adminOnly — "admin" without "accountant" beside it.
  if (allowedRoles.includes("admin") && !allowedRoles.includes("accountant")) {
    return "canManageSettings";
  }
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return safe ? "canView" : "canEdit";
}

const CAPABILITY_REFUSAL = {
  canView: "You do not have access to the accounting module.",
  canEdit: "Your accounting role is read-only, so this change was not saved.",
  canManageSettings: "Only the accounting owner can change this.",
};

/* ------------------------------------------------------------------ */
/* makeAuth — the façade                                               */
/* ------------------------------------------------------------------ */

/**
 * Build a middleware that authenticates through `orgAuth` and then enforces the
 * capability the legacy allow-list was standing in for.
 *
 * `orgAuth` writes its own response and calls the continuation ONLY when the
 * request carries a database-confirmed organisation session — so everything
 * below the continuation can assume `req.user` and `req.organization` are real.
 * A legacy CMS session never gets that far: `orgAuth` answers it with
 * 401 ACCOUNTING_SESSION_UPGRADE_REQUIRED, the same refusal the rest of
 * Accounting gives it.
 */
function makeAuth(allowedRoles = []) {
  return function accountantCompatAuth(req, res, next) {
    return orgAuth(req, res, (err) => {
      if (err) return next(err);

      // Belt and braces. `orgAuth` does not attach a legacy identity outside
      // the two bootstrap endpoints, but this middleware is the thing standing
      // in front of the ledger — it states its own precondition rather than
      // inheriting one.
      if (!req.user || req.user.isLegacy || req.user.isBootstrapOnly) {
        return res.status(401).json({
          success: false,
          code: "ACCOUNTING_SESSION_UPGRADE_REQUIRED",
          requiresUpgrade: true,
          upgradeEndpoint: "/api/accountant/auth/sync-legacy",
          message:
            "Your accounting session needs to be upgraded before you can use this.",
        });
      }

      const capability = requiredCapability(allowedRoles, req.method);
      if (!req.user.permissions?.[capability]) {
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_ROLE",
          role: req.user.role,
          requires: capability,
          message: CAPABILITY_REFUSAL[capability],
        });
      }

      // ── Compatibility fields ────────────────────────────────────────────
      // Several routes stamp `req.accountantId` onto records they write
      // (approvals, reviews, imports). It has always meant "the id of the
      // accounting user making this request", so it is the confirmed
      // Acc_User._id — not a claim off a token.
      req.accountantId = req.user.id;
      // Was set by the old middleware; now always true, since a legacy token
      // can no longer reach any route.
      req.user.isNewSystem = true;

      next();
    });
  };
}

/* ------------------------------------------------------------------ */
/* requireCapability — for endpoints the METHOD misdescribes           */
/* ------------------------------------------------------------------ */

/**
 * Demand a capability regardless of the HTTP verb, for routes whose verb lies
 * about what they do.
 *
 * `makeAuth` derives the capability from the method, which is right for the
 * overwhelming majority of these routes and is what let all 39 be migrated
 * without editing them. It is wrong for a GET that WRITES — and Accounting has
 * several, because a "resolve the sales ledger" endpoint auto-creates the
 * ledger when it is missing. Read as a verb, that is a GET; read as an effect,
 * it creates an accounting object, and a Viewer must not be able to cause it.
 *
 * Mount this AFTER the auth middleware on the specific route, so the URL and
 * the method stay exactly as they are and only the permission tightens:
 *
 *     router.get("/sales-ledgers", auth, requireCapability("canEdit"), handler)
 *
 * The refusal is the same `INSUFFICIENT_ROLE` shape `makeAuth` produces, so
 * callers need no new branch to handle it.
 */
function requireCapability(capability) {
  return function requireAccountingCapability(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        code: "NO_TOKEN",
        message: "Authentication required",
      });
    }
    if (!req.user.permissions?.[capability]) {
      return res.status(403).json({
        success: false,
        code: "INSUFFICIENT_ROLE",
        role: req.user.role,
        requires: capability,
        message:
          CAPABILITY_REFUSAL[capability] ||
          `You don't have permission: ${capability}`,
      });
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Pre-configured middleware                                          */
/* ------------------------------------------------------------------ */

// The module gate: canView to read, canEdit to change.
const accountantAuth = makeAuth(["accountant", "admin"]);

// Reads are open to viewers. Under the capability model this resolves to
// canView on safe methods — and, because the same middleware would sit in front
// of an unsafe method if one were ever added to a router using it, canEdit
// there. Requiring only canView for a write would be a downgrade, not a
// read-only guarantee.
const accountantReadOnlyAuth = makeAuth([
  "accountant",
  "accountant_viewer",
  "admin",
]);

// Owner-only in practice: canManageSettings is granted to no other role.
const adminOnlyAuth = makeAuth(["admin"]);

/* ------------------------------------------------------------------ */
/* Company-scope middleware                                           */
/* ------------------------------------------------------------------ */
//
// This used to validate that a companyId was SUPPLIED and was a well-formed
// ObjectId — and stop there. It never asked whether the caller's organisation
// owned that company, so every route using it accepted any id of the right
// shape, including another organisation's.
//
// It now delegates to `requireCompanyScope`, the single canonical check in
// AccountantOrgAuthMiddleware.js. Routes already mounting `withCompanyScope`
// become ownership-checked without being edited, and there is one
// implementation of "which company may this request touch" rather than two that
// drift apart.
//
// The one visible difference for existing callers: `req.companyId` is still
// set, but a foreign company now gets 403 COMPANY_FORBIDDEN where it used to be
// served, and a malformed id answers 400 COMPANY_SCOPE_INVALID rather than
// "Invalid companyId format".

function withCompanyScope(req, res, next) {
  return requireCompanyScope(req, res, next);
}

/* ------------------------------------------------------------------ */
/* Activity log helper                                                */
/* ------------------------------------------------------------------ */
//
// After the Acc_ rename, the canonical model name is `Acc_ActivityLog`.
// We also probe `ActivityLog` for backwards compat with any old code
// that might still register that name. If neither model is registered,
// this is a silent no-op — activity logging is best-effort.

function logAccountantActivity(action) {
  return async (req, res, next) => {
    try {
      const ActivityLog =
        mongoose.models.Acc_ActivityLog || mongoose.models.ActivityLog || null;

      if (ActivityLog && req.user) {
        ActivityLog.create({
          userId: req.user.id,
          userName: req.user.name,
          action,
          method: req.method,
          path: req.originalUrl,
          ip: req.ip,
          timestamp: new Date(),
        }).catch(() => {});
      }
    } catch {
      /* swallow */
    }
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */
//
// Same surface the 39 route files import, minus two removals that were the
// legacy grant itself and are imported by nothing:
//   • `verifyToken`           — an independent jwt.verify path
//   • `legacyRolePermissions` — role-name string → full accounting rights

module.exports = makeAuth;

module.exports.accountantAuth = accountantAuth;
module.exports.accountantReadOnlyAuth = accountantReadOnlyAuth;
module.exports.adminOnlyAuth = adminOnlyAuth;
module.exports.withCompanyScope = withCompanyScope;
// Re-exported so the 39 route files behind this façade can reach the canonical
// guard through the module they already import.
module.exports.requireCompanyScope = requireCompanyScope;
module.exports.scopeCompanyIfPresent = scopeCompanyIfPresent;
module.exports.logAccountantActivity = logAccountantActivity;
module.exports.makeAuth = makeAuth;
module.exports.extractToken = extractToken;
module.exports.newRolePermissions = newRolePermissions;
module.exports.isNewRole = isNewRole;
module.exports.requiredCapability = requiredCapability;
module.exports.requireCapability = requireCapability;
