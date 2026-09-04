// routes/auth/deptAuth.js
//
// Login, verify and logout for department accounts.
//
// Mounted at /api/auth. Replaces the twelve-deep if/else waterfall in
// routes/login.js, which is kept mounted in parallel during the rollout so
// existing sessions and any client still posting to the old path keep working.
//
// THE TRICK THAT MAKES THIS SURVIVABLE
// ------------------------------------
// ~270 places in this codebase compare a role against a string literal —
// `role !== "hr_manager"` in payroll, `ALLOWED_ROLES` in the sales middleware,
// ten copy-pasted `ceoAuth` arrays. If login started issuing tokens whose role
// was a new dynamic slug, every one of those would begin returning 403 with no
// error logged anywhere.
//
// So the token carries BOTH: `role` is the exact legacy literal, frozen at
// migration time from what the database actually contained, and `deptSlug` is
// the new dynamic identity. Existing checks keep passing unchanged; new code
// reads deptSlug. A department created from the admin UI has no legacy literal,
// so its role is its slug — it matches none of the existing allow-lists and is
// denied everywhere by default, which is the correct and safe direction to
// fail.
//
// DUAL READ
// ---------
// Login tries dept_users first, then falls back to the legacy waterfall for one
// release. Verify accepts both v1 (no `v` claim) and v2 tokens. Nobody is
// forced to log in again at cutover.

"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { SECRET, LEGACY_SECRETS, TOKEN_TTL, COOKIE_NAME, cookieOptions } = require("../../config/jwt");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");
const {
  matchesEmployeePassword,
  upgradeEmployeePassword,
} = require("../../utils/employeePassword");

/**
 * Which department an employee may sign in to, or null.
 *
 * `accessDepartmentId` is the explicit grant an administrator makes, and is
 * always authoritative. The name fallback below exists only so the hundreds of
 * employees already carrying a `department` string are not all locked out on
 * the day this ships — it matches on an exact, case-insensitive department
 * name and nothing looser. Anything ambiguous resolves to null, which denies:
 * a guess that lets someone into the wrong dashboard is far worse than an
 * administrator having to make one explicit assignment.
 */
/**
 * EVERY department this employee may sign in to, primary first.
 *
 * Someone can hold more than one grant — a project manager who also needs
 * Store, a supervisor covering QC. The array this returns IS the access
 * decision: login refuses any slug absent from it, and the onboarding page
 * shows exactly these and nothing else.
 *
 * The name fallback at the end applies only when no explicit grant exists at
 * all, so that the employees already carrying a `department` string are not
 * locked out on day one. It matches an exact, case-insensitive department name
 * and only when exactly one matches — anything ambiguous resolves to nothing,
 * because a guess that opens the wrong dashboard is far worse than an
 * administrator making one explicit assignment.
 */
/* The active departments — 21 rows that change when an administrator edits
   Access Control and at no other time — read once every 30 s rather than
   once or twice on EVERY session check. Each read was a cross-region round
   trip on the most-called route on the server. Hydrated documents, because
   the callers use toPublicTile(); nothing mutates them. */
const { memo: _memo } = require("../../services/memo");
function activeDepartments() {
  return _memo("access-departments:active", 30 * 1000, () =>
    AccessDepartment.find({ isActive: true }),
  );
}

async function resolveEmployeeDepartments(employee) {
  const ids = [];
  if (employee.accessDepartmentId) ids.push(employee.accessDepartmentId);
  for (const id of employee.additionalDepartmentIds || []) {
    if (!ids.some((x) => String(x) === String(id))) ids.push(id);
  }

  const active = await activeDepartments();

  if (ids.length) {
    // Preserve the caller's order so the primary stays first.
    const byId = new Map(active.map((d) => [String(d._id), d]));
    return ids.map((id) => byId.get(String(id))).filter(Boolean);
  }

  const label = String(employee.department || "").trim();
  if (!label) return [];

  const wanted = label.toLowerCase();
  const matches = active.filter((d) => String(d.name || "").trim().toLowerCase() === wanted);

  return matches.length === 1 ? matches : [];
}

/* What a session check needs from the employee record: identity, status and
   department pointers. Not the encrypted salary, the documents, the bank
   account or the SOP history — ~17 KB per verify that was loaded and thrown
   away, several times per page. */
const EMPLOYEE_SESSION_PROJECTION =
  "-salary -salaryCustomFields -documents -additionalDocs -bankDetails " +
  "-sopPoints -profilePhoto -photo -personalCustomFields -workCustomFields " +
  "-documentCustomFields -addressCustomFields -password";

/* ------------------------------------------------------------------ */
/* Legacy fallback — deleted at rollout step 8                         */
/* ------------------------------------------------------------------ */

const LEGACY_MODELS = [
  ["hr", "../../models/HRDepartment"],
  ["project_manager", "../../models/ProjectManager"],
  ["sales", "../../models/SalesDepartment"],
  ["mpc-measurement", "../../models/MpcMeasurement"],
  ["cutting-master", "../../models/CuttingMasterDepartment"],
  ["accountant", "../../models/Accountant_model/Acc_Department"],
  ["packaging-dispatch", "../../models/PackagingDispatchDepartment"],
  ["production-supervisor", "../../models/ProductionSupervisorDepartment"],
  ["qc", "../../models/QCDepartment"],
  ["ceo", "../../models/CEODepartment"],
  ["store", "../../models/StoreDepartment"],
  ["embroidery", "../../models/EmbroideryDepartment"],
];

function legacyModel(userType) {
  const entry = LEGACY_MODELS.find(([t]) => t === userType);
  return entry ? require(entry[1]) : null;
}

/**
 * The original hardcoded redirect map, kept verbatim.
 *
 * The whole point of this change is to stop hardcoding these — but the legacy
 * fallback has to work when `access_departments` is EMPTY, which is the case
 * before the migration has been applied and would otherwise be the case if it
 * were ever rolled back. Without this, a successful login returns
 * `redirectTo: "/"`, the browser lands on the marketing homepage, and the user
 * is bounced straight back to the login form — looking exactly like a failed
 * login even though the password was correct.
 *
 * Keyed by the `role` literal, matching the original if-ladder in
 * routes/login.js:145-163. Delete this alongside the fallback at rollout
 * step 8, once every department is a real row.
 */
const LEGACY_REDIRECTS = {
  hr_manager: "/hr/dashboard",
  ceo: "/ceo/dashboard",
  project_manager: "/project-manager/dashboard",
  sales: "/sales/dashboard",
  "mpc-measurement": "/mpc-measurement/dashboard",
  cutting_master: "/cutting-master/dashboard",
  accountant: "/accountant/",
  packaging_dispatch: "/packaging-dispatch/dashboard",
  production_supervisor: "/production-supervisor/dashboard",
  quality_control: "/qc/dashboard",
  store_manager: "/store/dashboard/overview",
  embroidery: "/embroidery/dashboard/overview",
};

/** Redirect by userType, for rows whose `role` is unexpected. */
const LEGACY_REDIRECTS_BY_TYPE = {
  hr: "/hr/dashboard",
  ceo: "/ceo/dashboard",
  project_manager: "/project-manager/dashboard",
  sales: "/sales/dashboard",
  "mpc-measurement": "/mpc-measurement/dashboard",
  "cutting-master": "/cutting-master/dashboard",
  accountant: "/accountant/",
  "packaging-dispatch": "/packaging-dispatch/dashboard",
  "production-supervisor": "/production-supervisor/dashboard",
  qc: "/qc/dashboard",
  store: "/store/dashboard/overview",
  embroidery: "/embroidery/dashboard/overview",
};

/**
 * userType → department slug, for databases where the migration has not run.
 *
 * Without this, a legacy login on an un-migrated database gets `deptSlug: ""`,
 * and DepartmentGuard compares "" against "ceo" and concludes the user is
 * signed in to some other department — so a perfectly valid CEO is told the
 * dashboard is not theirs. The guard is right to insist on a match; the empty
 * value was the bug.
 */
const LEGACY_USERTYPE_TO_SLUG = {
  hr: "hr",
  ceo: "ceo",
  project_manager: "project-manager",
  sales: "sales",
  "mpc-measurement": "mpc-measurement",
  "cutting-master": "cutting-master",
  accountant: "accountant",
  "packaging-dispatch": "packaging-dispatch",
  "production-supervisor": "production-supervisor",
  qc: "qc",
  store: "store",
  embroidery: "embroidery",
};

/** Slug for a session, falling back to the static map when unmigrated. */
function resolveSlug(dept, userType) {
  return dept?.slug || LEGACY_USERTYPE_TO_SLUG[userType] || "";
}

function resolveLegacyRedirect(dept, role, userType) {
  if (dept) return dept.resolveRedirect();
  return (
    LEGACY_REDIRECTS[role] ||
    LEGACY_REDIRECTS_BY_TYPE[userType] ||
    "/"
  );
}

/**
 * The old lookup, as a loop rather than twelve nested else-branches.
 *
 * Used only when an email is absent from dept_users — i.e. an account created
 * after the migration ran, or the migration has not been run yet.
 */
async function findLegacyUser(email) {
  for (const [userType, modelPath] of LEGACY_MODELS) {
    let Model;
    try { Model = require(modelPath); } catch { continue; }

    try {
      const found = await Model.findOne({ email });
      if (found) return { user: found, userType };
    } catch (err) {
      // One unreadable collection must not take the whole login down. This
      // path walks up to twelve collections for an email that is usually just
      // wrong, so a timeout or a missing collection here is a routine event,
      // not an outage — carry on and let the caller reject normally.
      console.error(`[auth] legacy lookup failed for ${userType}: ${err.message}`);
    }
  }
  return { user: null, userType: null };
}

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
}

/**
 * Verify against the current secret, then any historical one.
 *
 * The old code inlined `process.env.JWT_SECRET || "grav_clothing_secret_key"`
 * at 31 sites. Tokens minted under that fallback are still in circulation for
 * up to seven days, so they must keep verifying — but nothing new is ever
 * signed with it.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    for (const legacy of LEGACY_SECRETS) {
      try { return jwt.verify(token, legacy); } catch { /* try the next */ }
    }
    throw err;
  }
}

/**
 * Also issue the accountant module's own session, when signing in there.
 *
 * The accountant module authenticates against `Acc_User` and an
 * `accountant_token` cookie carrying { id, organizationId, role, tokenVersion }.
 * A CMS token cannot satisfy it: its role is "hr_manager" or "accountant", and
 * `AccountantOrgAuthMiddleware` correctly refuses both — which is exactly the
 * "Access denied. Required role: accountant or admin. You are: hr_manager"
 * that appears when someone reaches /accountant from a department sign-in.
 *
 * So when the chosen department is Accounting, mint that module's token too,
 * from the SAME Acc_User row its team page manages. The user arrives with real
 * permissions for their real role — owner, approver, editor or viewer — rather
 * than through the blanket-owner legacy fallback.
 *
 * Returns the accountant role if one was issued, otherwise null.
 */
async function attachAccountantSession(res, dept, email, issuedAt = null) {
  if (!dept || dept.slug !== "accountant") return null;

  try {
    const { findAccountantUser } = require("../../services/accountantAccess");
    const accUser = await findAccountantUser(email);

    // "Sign out of all devices", honoured here too.
    //
    // That action bumps tokenVersion and stamps sessionsRevokedAt. Minting a
    // module token from a CMS session older than that stamp would hand the
    // revoked device a brand-new, valid accounting session on its next page
    // load — so the other devices would never actually log out. Signing in
    // again produces a newer CMS token, which passes.
    if (
      accUser?.sessionsRevokedAt &&
      issuedAt &&
      issuedAt * 1000 < new Date(accUser.sessionsRevokedAt).getTime()
    ) {
      res.clearCookie("accountant_token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      });
      return null;
    }

    if (!accUser || !accUser.isActive) {
      console.warn(
        `[auth] "${email}" signed in to Accounting but has no active accountant ` +
          `role. Assign one in Access Control, or they will be refused inside ` +
          `the accounting module.`,
      );
      return null;
    }

    const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
    const accToken = signOrgToken(accUser);

    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("accountant_token", accToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return { role: accUser.role, token: accToken };
  } catch (err) {
    // Never fail the CMS login because the accounting bridge did.
    console.error("[auth] could not attach accountant session:", err.message);
    return null;
  }
}

/**
 * @param adoptDeptRole  Take the role from `dept` rather than from the user's
 *   own frozen legacy literal. Used when an administrator opens a department
 *   other than their own: carrying "ceo" into the Sales dashboard would make
 *   every role check there read the wrong answer. Only ever set for an admin,
 *   and only for a department the server has just re-verified.
 */
function buildTokenPayload(user, dept, { adoptDeptRole = false } = {}) {
  return {
    v: 2,
    id: String(user._id),
    // Frozen legacy literal — this is what every existing role check reads.
    role: (adoptDeptRole ? null : user.legacyRole) ||
      dept?.legacyRole || dept?.slug || "",
    userType: dept?.legacyUserType || dept?.slug || "",
    // The new, dynamic identity. `dept` is always present on this path (a
    // DeptUser cannot exist without one), so the static fallback is only a
    // guard against a dangling departmentId.
    deptId: dept ? String(dept._id) : null,
    deptSlug: resolveSlug(dept, dept?.legacyUserType),
    employeeId: user.employeeId || "",
    name: user.name || "",
    email: user.email || "",
    isAdmin: Boolean(user.isAdmin),
    tv: user.tokenVersion || 0,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/auth/login                                                */
/* ------------------------------------------------------------------ */

router.post("/login", async (req, res) => {
  try {
    const { email, password, slug } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const normalisedEmail = String(email).toLowerCase().trim();

    // Deliberately identical for every failure below. Distinguishing "no such
    // user" from "wrong password" from "deactivated" tells an attacker which
    // addresses are real.
    const reject = () =>
      res.status(401).json({ success: false, message: "Invalid email or password" });

    /* ---- department account --------------------------------------- */
    //
    // ONE EMAIL CAN NAME TWO DIFFERENT ACCOUNTS.
    //
    // dept_users.email and Employee.email are separately unique, so the same
    // address can exist as both a department login and an employee record —
    // they are different identities with independent access grants.
    //
    // This block used to `return reject()` the moment the department account
    // was inactive or its password did not match, which meant a disabled
    // department login permanently shadowed a perfectly valid employee account
    // sharing that address. The employee was told "invalid email or password"
    // for credentials that were entirely correct.
    //
    // Now each candidate identity is TRIED IN TURN, and the request is only
    // refused once every one of them has failed.
    const user = await DeptUser.findOne({ email: normalisedEmail });
    let deptUserFailed = null;   // remembered so lockout is only counted once

    if (user) {
      if (user.isLocked()) {
        return res.status(429).json({
          success: false,
          message: "Too many failed attempts. Try again in a few minutes.",
        });
      }

      const dept = await AccessDepartment.findById(user.departmentId);
      const usable = user.isActive && dept && dept.isActive;
      const passwordOk = usable ? await user.verifyPassword(password) : false;

      if (!usable) {
        // Fall through to the employee path rather than rejecting outright.
        deptUserFailed = "inactive";
      } else if (!passwordOk) {
        deptUserFailed = "password";
      } else if (slug && dept.slug !== slug) {
        // Authenticated, but picked the wrong tile. That IS a definitive
        // answer — no other identity is going to change it.
        return reject();
      } else {
        await user.registerSuccessfulLogin(req.ip);

        const payload = buildTokenPayload(user, dept);
        const token = signToken(payload);
        res.cookie(COOKIE_NAME, token, cookieOptions());

        // Accounting also needs its own module session — see
        // attachAccountantSession. No issuedAt: the CMS token was minted a
        // line ago, so it is by definition newer than any revocation stamp.
        // Signing in again is exactly how you come back after "sign out of all
        // devices".
        const accSession = await attachAccountantSession(res, dept, user.email);

        return res.status(200).json({
          success: true,
          message: "Login successful",
          redirectTo: dept.resolveRedirect(),
          token,
          userType: payload.userType,
          mustChangePassword: user.mustChangePassword,
          department: {
            slug: dept.slug,
            name: dept.name,
            iconUrl: dept.iconUrl || "",
            dashboardPath: dept.dashboardPath,
          },
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: payload.role,
            department: dept.name,
            employeeId: user.employeeId || "",
            isAdmin: user.isAdmin,
          },
        });
      }

      if (deptUserFailed) {
        console.warn(
          `[auth] "${normalisedEmail}" has a department login that could not be ` +
          `used (${deptUserFailed}); trying the employee record with the same address.`,
        );
      }
    }

    /* ---- employee accounts ---------------------------------------- */
    // Employees sign in with the credentials already on their HR record. What
    // they may REACH is decided here, on the server, from accessDepartmentId —
    // never from anything the browser sent. A tile greyed out in the UI is a
    // courtesy; this is the actual gate, and it holds even if someone re-enables
    // the control in devtools or posts to /api/auth/login directly.
    // NO PROJECTION — deliberately.
    //
    // This used to be .select("+password firstName lastName …"). Mixing a
    // `+field` into an otherwise INCLUSIVE projection makes mongoose drop that
    // field entirely: the document came back with password === undefined, every
    // comparison failed, and the user was told "invalid email or password" for
    // a password that was demonstrably correct. `password` is not select:false
    // on this schema, so the `+` bought nothing and cost everything.
    //
    // One document per login attempt; the bytes saved were never worth it.
    const employee = await Employee.findOne({ email: normalisedEmail });

    if (employee) {
      if (employee.isActive === false || employee.status === "inactive") return reject();

      // Every way an employee credential can legitimately be valid — bcrypt,
      // legacy plaintext, and the two derived defaults. Checking only bcrypt
      // told people their correct password was wrong while the employee app
      // accepted the very same string.
      const match = await matchesEmployeePassword(employee, password);
      if (!match.ok) return reject();

      // Convert a legacy or derived password to a real hash on first use, so
      // these paths drain away instead of living forever.
      if (match.needsUpgrade) {
        await upgradeEmployeePassword(Employee, employee._id, password);
        console.log(
          `[auth] upgraded ${normalisedEmail} from ${match.via} to a bcrypt hash`,
        );
      }

      const allowed = await resolveEmployeeDepartments(employee);

      // Which one they end up in: the tile they picked if they picked one,
      // otherwise their primary. The slug is validated against `allowed`
      // below — the browser never gets to choose a department for them.
      const dept = slug
        ? allowed.find((d) => d.slug === slug) || null
        : allowed[0] || null;

      if (!allowed.length) {
        // Authenticated, but deliberately given nowhere to go. Distinct from a
        // credential failure because it is actionable — and it leaks nothing,
        // since they have already proven who they are.
        return res.status(403).json({
          success: false,
          code: "NO_DEPARTMENT",
          message:
            "Your account is not assigned to a department yet. " +
            "Ask an administrator to assign you before signing in.",
        });
      }

      // A slug that is not in `allowed` resolves to null here. This is the
      // gate: it holds whether the request came from the portal, from devtools,
      // or from curl.
      if (!dept) {
        return res.status(403).json({
          success: false,
          code: "WRONG_DEPARTMENT",
          message:
            allowed.length === 1
              ? `You are assigned to ${allowed[0].name}. Choose that department to sign in.`
              : `You do not have access to that department. Yours: ${allowed
                  .map((d) => d.name)
                  .join(", ")}.`,
        });
      }

      if (!dept.isActive) {
        return res.status(403).json({
          success: false,
          code: "DEPARTMENT_INACTIVE",
          message: `${dept.name} is not currently active.`,
        });
      }

      const payload = {
        v: 2,
        id: String(employee._id),
        // The department's own role, so the dashboard it lands on actually
        // works. NOTE: this gives an employee the same reach as the shared
        // department login they would otherwise have used — no worse than
        // today, where that password is passed around, but worth knowing.
        role: dept.legacyRole || dept.slug,
        userType: dept.legacyUserType || dept.slug,
        deptId: String(dept._id),
        deptSlug: dept.slug,
        employeeId: employee.biometricId || "",
        name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
        email: employee.email || "",
        isAdmin: false,
        // Marks the subject as an Employee document rather than a DeptUser, so
        // /verify looks it up in the right collection.
        subject: "employee",
        tv: 0,
      };

      const token = signToken(payload);
      res.cookie(COOKIE_NAME, token, cookieOptions());

      const accSession = await attachAccountantSession(res, dept, employee.email);

      return res.status(200).json({
        success: true,
        message: "Login successful",
        // With no tile chosen and more than one department available, send
        // them to the picker rather than deciding for them. Choosing a tile
        // (slug set) always goes straight to that dashboard.
        redirectTo:
          !slug && allowed.length > 1 ? "/onboarding" : dept.resolveRedirect(),
        token,
        userType: payload.userType,
        // Every department this person may open, so the portal can show the
        // real set instead of asking again.
        departments: allowed.map((d) => d.toPublicTile()),
        // Present only when signing in to Accounting: which of owner /
        // approver / editor / viewer they hold there, plus that module's own
        // token. The accountant client sends localStorage.acc_token as a Bearer
        // header, and storing the CMS token there is what made the sidebar read
        // "HR_MANAGER" — the header outranked the accountant_token cookie.
        accountantRole: accSession?.role || null,
        accountantToken: accSession?.token || null,
        department: {
          slug: dept.slug,
          name: dept.name,
          iconUrl: dept.iconUrl || "",
          dashboardPath: dept.dashboardPath,
        },
        user: {
          id: employee._id,
          name: payload.name,
          email: employee.email,
          role: payload.role,
          department: dept.name,
          employeeId: employee.biometricId || "",
          isAdmin: false,
        },
      });
    }

    /* ---- accounting-only users ------------------------------------ */
    //
    // An external accountant, an auditor, a bookkeeper — someone who needs the
    // accounting module but is not on the payroll and has no Employee record.
    // They exist ONLY as an Acc_User, so without this they could be created in
    // Access Control and then find no way to sign in.
    const accOnly = await (async () => {
      try {
        const { findAccountantUser } = require("../../services/accountantAccess");
        return await findAccountantUser(normalisedEmail);
      } catch { return null; }
    })();

    if (accOnly && accOnly.isActive) {
      const ok = await accOnly.checkPassword(password);
      if (ok) {
        const dept = await AccessDepartment.findOne({ slug: "accountant", isActive: true });
        if (!dept) {
          return res.status(403).json({
            success: false,
            code: "DEPARTMENT_INACTIVE",
            message: "Accounting is not currently active.",
          });
        }
        if (slug && slug !== "accountant") {
          return res.status(403).json({
            success: false,
            code: "WRONG_DEPARTMENT",
            message: "You have access to Accounting only.",
          });
        }

        const payload = {
          v: 2,
          id: String(accOnly._id),
          role: dept.legacyRole || "accountant",
          userType: dept.legacyUserType || "accountant",
          deptId: String(dept._id),
          deptSlug: dept.slug,
          employeeId: "",
          name: accOnly.name || "",
          email: accOnly.email,
          isAdmin: false,
          subject: "accountant",
          tv: accOnly.tokenVersion || 0,
        };

        const token = signToken(payload);
        res.cookie(COOKIE_NAME, token, cookieOptions());
        const accSession = await attachAccountantSession(res, dept, accOnly.email);

        return res.status(200).json({
          success: true,
          message: "Login successful",
          redirectTo: dept.resolveRedirect(),
          token,
          userType: payload.userType,
          departments: [dept.toPublicTile()],
          accountantRole: accSession?.role || accOnly.role,
          // Without this the browser stores the CMS token under acc_token, and
          // that Bearer header outranks the accountant_token cookie — which is
          // exactly what made an Owner's sidebar read the wrong role.
          accountantToken: accSession?.token || null,
          department: {
            slug: dept.slug,
            name: dept.name,
            iconUrl: dept.iconUrl || "",
            dashboardPath: dept.dashboardPath,
          },
          user: {
            id: accOnly._id,
            name: accOnly.name,
            email: accOnly.email,
            role: payload.role,
            department: dept.name,
            employeeId: "",
            isAdmin: false,
          },
        });
      }
    }

    /* ---- legacy fallback (removed at rollout step 8) --------------- */
    const { user: legacyUser, userType } = await findLegacyUser(normalisedEmail);

    if (!legacyUser || legacyUser.isActive === false) {
      // Every identity has now been tried. Only count the failed attempt
      // against the department account here — doing it earlier would lock out
      // a department login because somebody's employee password was wrong.
      if (user && deptUserFailed === "password") {
        await user.registerFailedLogin();
      }
      return reject();
    }

    const legacyOk = await bcrypt.compare(String(password), legacyUser.password || "");
    if (!legacyOk) return reject();

    console.warn(
      `[auth] "${normalisedEmail}" authenticated through the LEGACY fallback ` +
      `(${userType}). They are absent from dept_users — re-run the migration ` +
      `before removing the fallback or this account will lose access.`,
    );

    const dept = await AccessDepartment.findOne({ legacyUserType: userType });

    const payload = {
      v: 2,
      id: String(legacyUser._id),
      role: legacyUser.role || "",
      userType,
      deptId: dept ? String(dept._id) : null,
      deptSlug: resolveSlug(dept, userType),
      employeeId: legacyUser.employeeId || "",
      name: legacyUser.name || "",
      email: legacyUser.email || "",
      isAdmin: false,
      tv: 0,
    };

    const token = signToken(payload);
    res.cookie(COOKIE_NAME, token, cookieOptions());

    return res.status(200).json({
      success: true,
      message: "Login successful",
      // Never bare "/" — see resolveLegacyRedirect. A correct password that
      // lands on the homepage is indistinguishable from a rejected one.
      redirectTo: resolveLegacyRedirect(dept, legacyUser.role, userType),
      token,
      userType,
      user: {
        id: legacyUser._id,
        name: legacyUser.name,
        email: legacyUser.email,
        role: legacyUser.role,
        department: legacyUser.department,
        employeeId: legacyUser.employeeId,
      },
    });
  } catch (error) {
    console.error("[auth] login error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/verify                                               */
/* ------------------------------------------------------------------ */

router.post("/verify", async (req, res) => {
  try {
    const token =
      req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    const decoded = verifyToken(token);

    /* ---- v2, accounting-only subject ------------------------------ */
    // An Acc_User with no employee record. Re-read every time so revoking the
    // role or deactivating them takes effect on the next request.
    if (decoded.v === 2 && decoded.subject === "accountant") {
      const { findAccountantUser } = require("../../services/accountantAccess");
      const accUser = await findAccountantUser(decoded.email);

      if (!accUser || !accUser.isActive) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      // A role change or a password reset bumps tokenVersion. Without this the
      // CMS half of their session would outlive both — the accounting module
      // would refuse them while the portal still showed them signed in.
      if ((decoded.tv || 0) !== (accUser.tokenVersion || 0)) {
        return res.status(401).json({
          success: false,
          code: "SESSION_STALE",
          message: "Your access changed. Please sign in again.",
        });
      }

      const dept = await AccessDepartment.findOne({ slug: "accountant", isActive: true });
      if (!dept) {
        return res.status(403).json({
          success: false,
          code: "NO_DEPARTMENT",
          message: "The Accounting department is not active.",
        });
      }

      // Same reason as the employee branch: refreshed on every verify so an
      // expired module token can never silently demote them to the CMS role.
      const accSession = await attachAccountantSession(
        res, dept, accUser.email, decoded.iat,
      );

      return res.status(200).json({
        success: true,
        user: {
          id: accUser._id,
          name: accUser.name,
          email: accUser.email,
          role: dept.legacyRole || "accountant",
          accountantRole: accUser.role,
          deptRole: accUser.role,
          employeeId: "",
          department: dept.name,
          deptSlug: dept.slug,
          userType: dept.legacyUserType || "accountant",
          isAdmin: false,
          subject: "accountant",
        },
        department: dept.toPublicTile(),
        departments: [dept.toPublicTile()],
        accountantRole: accSession?.role || accUser.role,
        accountantToken: accSession?.token || null,
      });
    }

    /* ---- v2, employee subject ------------------------------------- */
    // Re-resolved from the database every time, never trusted from the token.
    // Un-assigning someone in the admin UI has to take their access away on
    // their very next request — not whenever their week-long token expires.
    if (decoded.v === 2 && decoded.subject === "employee") {
      const employee = await Employee.findById(decoded.id).select(EMPLOYEE_SESSION_PROJECTION);

      if (!employee || employee.isActive === false || employee.status === "inactive") {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const allowed = await resolveEmployeeDepartments(employee);

      if (!allowed.length) {
        return res.status(403).json({
          success: false,
          code: "NO_DEPARTMENT",
          message: "Your department assignment has been removed.",
        });
      }

      // The session names a department they may still open — checked against
      // the CURRENT grant, not the one baked into the token. Revoking one of
      // several departments takes effect on the next request.
      const dept = allowed.find((d) => String(d._id) === String(decoded.deptId));

      if (!dept) {
        return res.status(403).json({
          success: false,
          code: "DEPARTMENT_CHANGED",
          message: "Your access to that department has changed. Please sign in again.",
        });
      }

      // Re-mint the module session on every verify, not only at login.
      //
      // The accountant_token used to be issued once, at sign-in or at a
      // department switch. If it expired, or if the session was already in
      // Accounting so no switch ever ran, the module fell back to the CMS
      // token — whose role is the DEPARTMENT role, "accountant". That is why an
      // Owner's sidebar read ACCOUNTANT. Minting it here means every page load
      // of the module carries the person's real accounting role.
      /* Two independent lookups, one round trip's worth of waiting instead
         of two. Each is a cross-region query on the most-called route. */
      const [accSession, deptRole] = await Promise.all([
        attachAccountantSession(res, dept, employee.email, decoded.iat),
        require("../../services/departmentRoles").getRole(dept.slug, employee.email),
      ]);

      return res.status(200).json({
        success: true,
        user: {
          id: employee._id,
          name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
          email: employee.email,
          role: dept.legacyRole || dept.slug,
          deptRole,
          employeeId: employee.biometricId || "",
          department: dept.name,
          deptSlug: dept.slug,
          userType: dept.legacyUserType || dept.slug,
          isAdmin: false,
          subject: "employee",
        },
        department: dept.toPublicTile(),
        // Everything this person may open, so the portal can offer a switch
        // without asking for the password again.
        departments: allowed.map((d) => d.toPublicTile()),
        accountantRole: accSession?.role || null,
        // null when they are not in Accounting, or hold it with no role — the
        // browser MUST clear its stored token in that case rather than fall
        // back to the CMS one.
        accountantToken: accSession?.token || null,
      });
    }

    /* ---- v2, department account ----------------------------------- */
    if (decoded.v === 2 && decoded.deptId) {
      const user = await DeptUser.findById(decoded.id);
      if (!user || !user.isActive) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      // Revocation. Deactivating a user or resetting their password bumps
      // tokenVersion, which kills every outstanding session immediately rather
      // than leaving it valid for the remaining days of the token's life.
      if ((user.tokenVersion || 0) !== (decoded.tv || 0)) {
        return res.status(401).json({ success: false, message: "Session expired" });
      }

      // An admin's session may be pointed at a department other than the one
      // their account belongs to (see switch-department). Everyone else is read
      // from their own record, so a hand-edited token cannot move them.
      const dept = user.isAdmin && decoded.deptId
        ? await AccessDepartment.findById(decoded.deptId)
        : await AccessDepartment.findById(user.departmentId);

      if (!dept || !dept.isActive) {
        return res.status(401).json({ success: false, message: "Department is not active" });
      }

      // Accounting needs its module token here too, or an admin who switched
      // into it arrives holding only the CMS token and the module reads their
      // department role instead of their accounting one.
      const accSession = await attachAccountantSession(
        res, dept, user.email, decoded.iat,
      );

      return res.status(200).json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          // Matches what the token carries — an admin viewing another
          // department reports THAT department's role, not their own, or the
          // page and the token would disagree about who is asking.
          role:
            (user.isAdmin && String(dept._id) !== String(user.departmentId)
              ? null
              : user.legacyRole) || dept.legacyRole || dept.slug,
          deptRole: await require("../../services/departmentRoles").getRole(dept.slug, user.email),
          employeeId: user.employeeId || "",
          department: dept.name,
          deptSlug: dept.slug,
          userType: dept.legacyUserType || dept.slug,
          isAdmin: user.isAdmin,
          mustChangePassword: user.mustChangePassword,
        },
        department: dept.toPublicTile(),
        // What this account may open.
        //
        // This was missing entirely, and the portal reads it to decide which
        // tiles are live — so a signed-in department account saw the whole grid
        // greyed out, including the CEO, who can open everything.
        //
        // An administrator gets every active department, which is not a new
        // grant: DepartmentGuard and every /api/admin route already admit an
        // admin anywhere. The grid was simply the one place that did not say so.
        // Administration is not a department — see ensureAccessDepartments.
        // The legacy row may still exist in a live database, so it is filtered
        // here rather than deleted; Access Control lives inside the Executive
        // Office and an admin reaches it there.
        departments: user.isAdmin
          ? (await AccessDepartment.find({
              isActive: true,
              slug: { $ne: "platform-admin" },
            }).sort({ sortOrder: 1, name: 1 }))
              .map((d) => d.toPublicTile())
          : [dept.toPublicTile()],
        accountantRole: accSession?.role || null,
        accountantToken: accSession?.token || null,
      });
    }

    /* ---- v1, still in circulation for the token lifetime ----------- */
    // Includes `store`, which the original switch omitted entirely — store
    // tokens fell through to an HRDepartment lookup and 401'd. Driving this
    // from the table fixes that as a side effect.
    const Model = legacyModel(decoded.userType) || require("../../models/HRDepartment");
    const legacyUser = await Model.findById(decoded.id).select("-password");

    if (!legacyUser || legacyUser.isActive === false) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const dept = await AccessDepartment.findOne({ legacyUserType: decoded.userType });

    return res.status(200).json({
      success: true,
      user: {
        id: legacyUser._id,
        name: legacyUser.name,
        email: legacyUser.email,
        role: legacyUser.role,
        deptRole: dept ? await require("../../services/departmentRoles").getRole(dept.slug, legacyUser.email) : null,
        employeeId: legacyUser.employeeId,
        department: legacyUser.department,
        deptSlug: resolveSlug(dept, userType),
        userType: decoded.userType || "hr",
        isAdmin: false,
      },
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/resolve — which department does this email belong to? */
/* ------------------------------------------------------------------ */

/**
 * Answers "which tile should I be allowed to pick?" AFTER the password has
 * been checked — not before.
 *
 * A tempting shortcut would be to take an email alone and return the matching
 * department so the picker could grey out the rest as you type. That is an
 * unauthenticated oracle: anyone could enumerate staff addresses and learn the
 * org chart. So this requires the password, and is really just a login that
 * reports where the user belongs instead of issuing a session.
 *
 * The UI uses it to show "you are in Sales" and to disable everything else.
 * That remains cosmetic — /login enforces the same rule server-side, so
 * re-enabling a disabled tile in devtools achieves nothing.
 */
router.post("/resolve", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const normalised = String(email).toLowerCase().trim();
    const deny = () =>
      res.status(401).json({ success: false, message: "Invalid email or password" });

    /* department accounts */
    const deptUser = await DeptUser.findOne({ email: normalised });
    if (deptUser) {
      if (!deptUser.isActive || deptUser.isLocked()) return deny();
      if (!(await deptUser.verifyPassword(password))) return deny();

      const dept = await AccessDepartment.findById(deptUser.departmentId);
      return res.json({
        success: true,
        isAdmin: deptUser.isAdmin,
        // An administrator goes to the console, not the department picker.
        adminRedirect: deptUser.isAdmin ? "/ceo/dashboard/access" : null,
        departments: dept && dept.isActive ? [dept.toPublicTile()] : [],
      });
    }

    /* employees */
    // No projection — see the note in /login. A `+field` inside an inclusive
    // projection silently drops it, which is what made correct passwords fail.
    const employee = await Employee.findOne({ email: normalised });
    if (employee) {
      if (employee.isActive === false || employee.status === "inactive") return deny();

      // Same matcher as /login — the two must never disagree about whether a
      // password is valid, or the portal would show a department and then
      // refuse the sign-in.
      const match = await matchesEmployeePassword(employee, password);
      if (!match.ok) return deny();

      const allowed = await resolveEmployeeDepartments(employee);
      return res.json({
        success: true,
        isAdmin: false,
        adminRedirect: null,
        departments: allowed.map((d) => d.toPublicTile()),
        message: allowed.length
          ? undefined
          : "You are not assigned to a department yet. Ask an administrator to assign you.",
      });
    }

    /* accounting-only users */
    // An external bookkeeper or auditor with no HR record. /login accepts them,
    // so /resolve has to as well — the portal calls this FIRST, and without it
    // they were turned away with "invalid email or password" before the sign-in
    // that would have worked was ever attempted.
    const accOnly = await (async () => {
      try {
        const { findAccountantUser } = require("../../services/accountantAccess");
        return await findAccountantUser(normalised);
      } catch { return null; }
    })();

    if (accOnly && accOnly.isActive && (await accOnly.checkPassword(password))) {
      const dept = await AccessDepartment.findOne({ slug: "accountant", isActive: true });
      return res.json({
        success: true,
        isAdmin: false,
        adminRedirect: null,
        departments: dept ? [dept.toPublicTile()] : [],
        message: dept ? undefined : "Accounting is not currently active.",
      });
    }

    return deny();
  } catch (error) {
    console.error("[auth] resolve error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/switch-department                                    */
/* ------------------------------------------------------------------ */

/**
 * Move an existing session to another department the user already holds.
 *
 * Without this, the portal's department picker only NAVIGATED. Someone holding
 * HR and Accounting would click Accounting and arrive still carrying an HR
 * token — role "hr_manager", deptSlug "hr" — so the accounting module refused
 * them with "Required role: accountant or admin. You are: hr_manager", and no
 * accountant_token was ever minted. Choosing a department has to re-issue the
 * session, not just change the URL.
 *
 * No password: the caller already proved who they are. What is re-checked, from
 * the database, is that they still hold the department they are asking for.
 */
router.post("/switch-department", async (req, res) => {
  try {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ success: false, message: "A department is required" });

    const token =
      req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ success: false, message: "Not signed in" });

    let decoded;
    try { decoded = verifyToken(token); }
    catch { return res.status(401).json({ success: false, message: "Session expired" }); }

    const deny = () =>
      res.status(403).json({ success: false, message: "You do not have access to that department." });

    /* ---- employee session ---- */
    if (decoded.subject === "employee") {
      const employee = await Employee.findById(decoded.id).select(EMPLOYEE_SESSION_PROJECTION);
      if (!employee || employee.isActive === false || employee.status === "inactive") {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const allowed = await resolveEmployeeDepartments(employee);
      const dept = allowed.find((d) => d.slug === slug);
      if (!dept) return deny();

      const payload = {
        v: 2,
        id: String(employee._id),
        role: dept.legacyRole || dept.slug,
        userType: dept.legacyUserType || dept.slug,
        deptId: String(dept._id),
        deptSlug: dept.slug,
        employeeId: employee.biometricId || "",
        name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
        email: employee.email || "",
        isAdmin: false,
        subject: "employee",
        tv: 0,
      };

      const fresh = signToken(payload);
      res.cookie(COOKIE_NAME, fresh, cookieOptions());
      const accSession = await attachAccountantSession(
        res, dept, employee.email, decoded.iat,
      );

      return res.json({
        success: true,
        redirectTo: dept.resolveRedirect(),
        department: dept.toPublicTile(),
        token: fresh,
        accountantRole: accSession?.role || null,
        // The module's own token, so the browser can replace whatever is in the
        // acc_token slot. Without it a person switching HR -> Accounting keeps
        // sending their HR token as a Bearer header, and the module reports
        // "You are: hr_manager" no matter what their accounting role says.
        accountantToken: accSession?.token || null,
      });
    }

    /* ---- department account ---- */
    const user = await DeptUser.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const own = await AccessDepartment.findById(user.departmentId);

    // An administrator may open any active department — the route guard and
    // every /api/admin route already admit them anywhere, so refusing here
    // just meant the portal showed a tile that then would not open.
    const dept = user.isAdmin
      ? await AccessDepartment.findOne({ slug, isActive: true })
      : own;

    if (!dept || dept.slug !== slug || !dept.isActive) return deny();

    const adoptDeptRole =
      Boolean(user.isAdmin) && String(dept._id) !== String(user.departmentId);

    const fresh = signToken(buildTokenPayload(user, dept, { adoptDeptRole }));
    res.cookie(COOKIE_NAME, fresh, cookieOptions());
    const accSession = await attachAccountantSession(
      res, dept, user.email, decoded.iat,
    );

    return res.json({
      success: true,
      redirectTo: dept.resolveRedirect(),
      department: dept.toPublicTile(),
      token: fresh,
      accountantRole: accSession?.role || null,
      accountantToken: accSession?.token || null,
    });
  } catch (error) {
    console.error("[auth] switch-department error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/logout                                               */
/* ------------------------------------------------------------------ */

router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];

    // Server-side revocation, not just a cleared cookie. Six dashboard layouts
    // currently "log out" by deleting localStorage, which leaves the token
    // valid for anyone who copied it.
    if (token) {
      try {
        const decoded = verifyToken(token);
        if (decoded?.v === 2 && decoded.id) {
          await DeptUser.updateOne({ _id: decoded.id }, { $inc: { tokenVersion: 1 } });
        }
      } catch { /* an unverifiable token needs no revoking */ }
    }
  } catch (error) {
    console.error("[auth] logout error:", error);
  }

  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });

  // The accounting module's cookie goes with it.
  //
  // The module session is DERIVED from this one — /verify re-mints it on every
  // page load — so leaving it behind would mean signing out of the CMS and
  // still being signed in to Accounting. Options must match the ones it was set
  // with or the browser keeps it.
  res.clearCookie("accountant_token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  });

  res.json({ success: true, message: "Logged out successfully" });
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/change-password — self service                       */
/* ------------------------------------------------------------------ */
//
// Whichever of the three identities the caller signed in as, this changes the
// credential that the SAME branch of /login checks. Anything else would hand
// somebody a password that does not work: an employee whose new password went
// onto a dept_users row would still be authenticated against their HR record
// on the next sign-in, and would be turned away by the password they just set.

router.post("/change-password", async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ success: false, message: "Not authenticated" });

    const decoded = verifyToken(token);
    const { currentPassword, newPassword } = req.body || {};

    if (!newPassword) {
      return res.status(400).json({ success: false, message: "A new password is required" });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: "The new password must be at least 8 characters" });
    }
    if (currentPassword && String(newPassword) === String(currentPassword)) {
      return res.status(400).json({ success: false, message: "The new password must be different from the current one" });
    }

    const wrong = () =>
      res.status(401).json({ success: false, message: "Current password is incorrect" });

    /**
     * Onboarding's self-service card (the common path — the portal everybody
     * already lands on signed in) no longer collects the current password at
     * all: asking someone to re-type the password they used thirty seconds
     * ago to reach this exact screen was the friction being removed. The
     * still-valid session (the token this route already required above) is
     * what stands in for it.
     *
     * That is a real, deliberate trade: whoever holds a valid session token —
     * a stolen one, or a shared machine left signed in — can now change the
     * password without proving they know the old one, where before they
     * could not. Anywhere `currentPassword` IS sent (a caller can still send
     * it), it is still checked, so this only relaxes the check for callers
     * who choose not to ask for it.
     */
    /* ---- employee ------------------------------------------------- */
    if (decoded.subject === "employee") {
      const Employee = require("../../models/Employee");
      const {
        matchesEmployeePassword,
        upgradeEmployeePassword,
      } = require("../../utils/employeePassword");

      const employee = await Employee.findById(decoded.id).select(EMPLOYEE_SESSION_PROJECTION);
      if (!employee) return res.status(401).json({ success: false, message: "Unauthorized" });

      if (currentPassword) {
        // The same matcher login uses, so someone still on a derived default
        // (Firstname@MMDDYYYY, or the phone-based one) can set a real password
        // without an administrator having to reset it for them first.
        const { ok } = await matchesEmployeePassword(employee, currentPassword);
        if (!ok) return wrong();
      }

      // updateOne, not save() — the Employee pre-save hook re-encrypts salary
      // fields, and on a document loaded for this purpose that has repeatedly
      // thrown. The password hook is bypassed too, so hash here.
      //
      // It swallows its own errors and returns false, because at login a failed
      // upgrade must not fail a valid sign-in. Here the write IS the request, so
      // a false result has to be reported rather than answered with "changed".
      const written = await upgradeEmployeePassword(Employee, employee._id, String(newPassword));
      if (!written) {
        return res.status(500).json({
          success: false,
          message: "The password could not be saved. Your old password still works.",
        });
      }

      return res.json({
        success: true,
        message: "Password changed. Use it the next time you sign in.",
      });
    }

    /* ---- accounting-only user ------------------------------------- */
    if (decoded.subject === "accountant") {
      const { findAccountantUser } = require("../../services/accountantAccess");
      const accUser = await findAccountantUser(decoded.email);
      if (!accUser || !accUser.isActive) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      if (currentPassword) {
        const ok = await accUser.checkPassword(currentPassword);
        if (!ok) return wrong();
      }

      await accUser.setPassword(String(newPassword));
      // Every other accounting session for this person dies with the old one.
      accUser.tokenVersion = (accUser.tokenVersion || 0) + 1;
      await accUser.save();

      return res.json({
        success: true,
        message: "Password changed. Please sign in again.",
        reauth: true,
      });
    }

    /* ---- department login ----------------------------------------- */
    const user = await DeptUser.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (currentPassword) {
      const ok = await user.verifyPassword(currentPassword);
      if (!ok) return wrong();
    }

    await user.setPassword(newPassword);   // bumps tokenVersion → other sessions die
    await user.save();

    // The caller's own session was just invalidated along with the rest, so
    // hand them a fresh token rather than bouncing them to the login page.
    const dept = await AccessDepartment.findById(user.departmentId);
    const fresh = signToken(buildTokenPayload(user, dept));
    res.cookie(COOKIE_NAME, fresh, cookieOptions());

    res.json({ success: true, message: "Password changed", token: fresh });
  } catch (error) {
    if (error.message?.includes("at least 8")) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error("[auth] change-password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/auth/cowork-sso — hand off into the standalone CoWork app */
/* ------------------------------------------------------------------ */
//
// CoWork lives on its own origin with its own Firebase-based sign-in
// (grav-cms-38f45, same project as this backend's service account). This
// mints a Firebase custom token for the caller's already-linked CoWork
// account so onboarding can hand the browser off without asking for a
// second password. It does not create anything — see the
// /employees/:id/cowork-account routes in routes/Admin/accessAdmin.js for
// provisioning a CoWork account that does not exist yet.
router.post("/cowork-sso", async (req, res) => {
  try {
    const token =
      req.cookies?.[COOKIE_NAME] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    const decoded = verifyToken(token);
    if (decoded.v !== 2 || decoded.subject !== "employee") {
      return res.status(403).json({
        success: false,
        message: "CoWork sign-in is only available to employee accounts.",
      });
    }

    const employee = await Employee.findById(decoded.id).select(EMPLOYEE_SESSION_PROJECTION);
    if (!employee || employee.isActive === false || employee.status === "inactive") {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // ── WHICH EXTERNAL APP IS BEING OPENED ────────────────────────────────
    //
    // A department is identified as "external" by what it DOES — it has an
    // `externalBaseUrl`, so opening it means handing the browser to another
    // origin — never by an admin having typed an exact name. An admin renaming
    // "CoWork" to "Co-Workspace" (a real case this was debugged against) must
    // not silently break sign-in.
    //
    // There is now more than one such app. Material Requests runs on the same
    // origin as CoWork but is its own department with its own grant, so a
    // person can raise a material request without being given the whole
    // workspace. `findOne` with no slug would pick whichever came back first
    // and check the caller against THAT one's grant, which is the wrong
    // question and, half the time, the wrong answer.
    //
    // So the caller names the tile it is opening. No slug means the request
    // came from a client written before this, and the old behaviour — the one
    // external app there used to be — is exactly right for it.
    const wantedSlug = String(req.body?.slug || "").trim().toLowerCase();
    const coworkDept = await AccessDepartment.findOne({
      isActive: true,
      externalBaseUrl: { $nin: [null, ""] },
      ...(wantedSlug ? { slug: wantedSlug } : {}),
    });
    if (!coworkDept) {
      return res.status(500).json({
        success: false,
        code: "NOT_CONFIGURED",
        message: "CoWork is not configured yet. Ask an administrator to set its app URL on the Access Control page.",
      });
    }

    /* The grant is checked against the department actually being opened, so
       holding Material Requests does not open CoWork and holding CoWork does
       not open Material Requests. Each tile is its own decision. */
    const holdsIt = (await resolveEmployeeDepartments(employee))
      .some((d) => String(d._id) === String(coworkDept._id));
    if (!holdsIt) {
      return res.status(403).json({
        success: false,
        code: "NO_COWORK_ACCESS",
        message: `You do not have ${coworkDept.name} access. Ask an administrator to grant it.`,
      });
    }

    // Resolving the CoWork account: the explicit link first, then email.
    //
    // `employee.coworkEmployeeId` — set by an admin on the access page, or
    // written automatically the first time an email match succeeds — is
    // authoritative and exact. Without it, this used to assume the
    // cowork_employees doc ID equalled biometricId, true only for accounts
    // this app itself created, or that the account's email equalled the
    // CMS login email, true only when nobody registered the two under
    // different addresses. In practice both assumptions break: an account
    // made through the legacy CoWork employee-creation screen keeps
    // whatever ID and email it was given then, which can differ from HR's
    // record for the same person — verified against live data, where one
    // employee's CMS login was pramodbiswal@gmail.com and their CoWork
    // account, existing and fully working, was
    // biswalpramod3.1415@gmail.com under doc id GR0108. Neither lookup
    // found it; the person correctly held CoWork access and correctly had
    // a working account, and was told no account existed. That is why the
    // explicit link is checked first and is the one thing that cannot be
    // fooled by an email mismatch.
    const { db, auth: firebaseAuth } = require("../../config/firebaseAdmin");

    let coworkDoc = null;
    if (employee.coworkEmployeeId) {
      const linked = await db.collection("cowork_employees").doc(employee.coworkEmployeeId).get();
      if (linked.exists) coworkDoc = linked;
    }

    if (!coworkDoc) {
      const email = String(employee.email || "").trim().toLowerCase();
      if (email) {
        const match = await db.collection("cowork_employees").where("email", "==", email).limit(1).get();
        if (!match.empty) {
          coworkDoc = match.docs[0];
          // Found by email this once — persist it, so every future sign-in
          // resolves instantly and stops depending on the two emails still
          // agreeing.
          await Employee.updateOne({ _id: employee._id }, { $set: { coworkEmployeeId: coworkDoc.id } });
        }
      }
    }

    if (!coworkDoc) {
      return res.status(404).json({
        success: false,
        code: "NO_COWORK_ACCOUNT",
        message: "No CoWork account is linked to your CMS account yet. Ask an administrator to link or create one on the Access Control page.",
      });
    }

    const coworkData = coworkDoc.data();
    if (!coworkData.authUid) {
      return res.status(409).json({
        success: false,
        code: "NO_AUTH_UID",
        message: "Your CoWork account is not fully set up. Ask an administrator to fix it.",
      });
    }

    const customToken = await firebaseAuth.createCustomToken(coworkData.authUid);

    res.json({
      success: true,
      token: customToken,
      redirectBaseUrl: coworkDept.externalBaseUrl,
      /* Where inside that app to land. A workspace tile has no path and lands
         on its own home; Material Requests carries "/mrf" and opens straight
         into the app rather than by way of somebody else's dashboard.

         A PATH, never a URL: the destination is always inside the origin above,
         and accepting a full URL here would make this an open redirect. */
      redirectPath:
        coworkDept.dashboardPath && coworkDept.dashboardPath.startsWith("/")
          ? coworkDept.dashboardPath
          : null,
    });
  } catch (error) {
    console.error("[auth] cowork-sso error:", error);
    res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
});

module.exports = router;
module.exports.verifyToken = verifyToken;
module.exports.resolveEmployeeDepartments = resolveEmployeeDepartments;
module.exports.signToken = signToken;
module.exports.buildTokenPayload = buildTokenPayload;
// Exported so a shared permission resolver can decide HR-tool access from the
// SAME department grants used at login — not a second, drifting copy.
module.exports.resolveEmployeeDepartments = resolveEmployeeDepartments;
// Exported so routes/auth/passwordReset.js can resolve the SAME "which of the
// twelve legacy department collections does this email belong to" answer
// /login itself uses, instead of keeping a second copy of that model list that
// could drift out of step as models are migrated off it.
module.exports.findLegacyUser = findLegacyUser;
module.exports.legacyModel = legacyModel;
