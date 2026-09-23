"use strict";
/**
 * Middlewear/hrContract.js — the HR authorisation contract, at the mount.
 *
 * One line per prefix in server.js turns every HR endpoint into an explicitly
 * declared, capability-checked, record-scoped one:
 *
 *   app.use("/api/hr",       hrContract());
 *   app.use("/hr",           hrContract());
 *   app.use("/api/employees",hrContract());
 *   app.use("/api/ceo/hr",   hrContract());
 *   app.use("/api/employee", hrContract());
 *
 * WHY MOUNT-LEVEL, AGAIN
 * ----------------------
 * The same argument Middlewear/departmentWriteGuard.js makes, and for the same
 * reason: HR is ~320 handlers across 36 routers, several of them thousands of
 * lines long. A guard that has to be remembered per handler is a guard with a
 * hole in it, and a permission system with a hole is worse than none because
 * everybody believes it is covered. Here the DECLARATION is per endpoint —
 * services/access/hrRouteContract.js — and the ENFORCEMENT is in one place.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Find the declaration for (method, path). No declaration is a REFUSAL:
 *      an HR route nobody has classified does not get to serve data. The
 *      coverage test turns the same condition into a failing build, so this
 *      branch should only ever be reachable in a working tree.
 *   2. `scope: "public"` passes straight through, before any token work.
 *   3. Seed `req.user` from whichever session the caller holds — the CMS
 *      `auth_token` or the employee app's `employee_token`. Both are signed
 *      with the same secret and the routers behind this run their own auth
 *      afterwards; this only fills a gap, exactly like departmentWriteGuard.
 *   4. Ask services/access/hrAuthorization.js the one question, and answer the
 *      request itself on a refusal.
 *   5. On success, attach `req.hrAuth` — capabilities, the field projection and
 *      the declaration — so a handler that wants to narrow further can, without
 *      re-deriving anything.
 *
 * WHAT A REFUSAL SAYS
 * -------------------
 * A stable code and a sentence that describes the CALLER, never the record.
 * "You do not have permission to perform this action" is returned identically
 * for an employee who does not exist and for one the caller may not see, so
 * these endpoints cannot be used to find out who exists. The scope check
 * deliberately never loads the target for the same reason.
 */

const jwt = require("jsonwebtoken");

const { SECRET, LEGACY_SECRETS, readToken } = require("../config/jwt");
const { findDeclaration, extractParams } = require("../services/access/hrRouteContract");
const {
  authorizeHr,
  resolveHrActor,
  DECISIONS,
} = require("../services/access/hrAuthorization");
const { CAPABILITIES } = require("../services/access/hrCapabilities");
const { classifyEmployeeWrite } = require("../services/access/hrWritePolicy");
const { projectEmployee, projectEmployees, scrubResponse } = require("../services/access/hrFieldPolicy");

/* ── Identity ────────────────────────────────────────────────────────────────*/

function verify(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    for (const legacy of LEGACY_SECRETS) {
      try {
        return jwt.verify(token, legacy);
      } catch {
        /* try the next */
      }
    }
  }
  return null;
}

/**
 * Put the caller on the request if nothing has yet.
 *
 * LOAD-BEARING, and for the same reason as departmentWriteGuard's version: this
 * runs BEFORE the router's own auth middleware, so `req.user` is still empty
 * when the resolver wants an identity. Only ever fills a GAP — an object
 * already there is left exactly as it is, and the router's own middleware
 * assigns its own richer one afterwards.
 *
 * TWO cookies, because HR spans two audiences. The CMS session is `auth_token`
 * and carries a `role`; the employee app's is `employee_token` and carries
 * `{ id, email, type: "employee" }` with no role at all. Both verify against
 * the same secret, and that asymmetry — role present or absent — is real
 * information the resolver uses, so both are read rather than one guessed.
 */
function seedIdentity(req) {
  if (req.user?.id || req.user?.email || req.admin || req.dept?.email) return;

  const cms = verify(readToken(req));
  const app = cms ? null : verify(readToken(req, "employee_token"));
  const decoded = cms || app;
  if (!decoded) return;

  req.user = {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    /* Present on a CMS token, absent on an app token. Read ONLY as a proof of
       which department collection somebody authenticated against — never as a
       capability. See hrAuthorization.js. */
    role: decoded.role,
    employeeId: decoded.employeeId,
    isAdmin: Boolean(decoded.isAdmin),
    deptSlug: decoded.deptSlug || "",
    /* WHICH ACCOUNT COLLECTION THIS TOKEN WAS ISSUED AGAINST.
     *
     * Both CMS token builders write it — routes/login.js as `userModel`, and
     * routes/auth/deptAuth.js as `dept.legacyUserType` — and this middleware
     * used to drop it. Without it the legacy compatibility bridge had to pick a
     * collection from `role`, so a session authenticated against Sales carrying
     * `role: "hr_manager"` was checked against HRDepartment, a collection it had
     * never signed in to. It is read as the token's SUBJECT TYPE, never as a
     * capability. `type` is the employee app's own marker and is carried for the
     * same reason: to refuse it. */
    userType: decoded.userType || "",
    type: decoded.type || "",
    replayOf: decoded.replayOf || null,
    _hrContractSeeded: true,
  };
}

/* ── Denial audit ────────────────────────────────────────────────────────────
 *
 * Refusals are recorded so "who tried to open payroll" is answerable, and are
 * recorded WITHOUT the thing they were refused. The declaration's PATH TEMPLATE
 * is logged rather than the request URL, so an employee id, a payroll item id
 * or a document id never reaches the log — the roadmap's "access-denial audit
 * without leaking the protected record", literally.
 *
 * No request body, no query string, no field values, and nothing from
 * hrFieldPolicy.NEVER_EXPOSE can appear because none of it is read here.
 */
function logDenial(req, declaration, result) {
  const actor = result.actor || {};
  console.warn(
    "[hr-auth] denied " +
      JSON.stringify({
        code: result.decision,
        method: req.method,
        route: declaration ? declaration.path : "(undeclared)",
        capability: result.capability || null,
        actor: {
          id: actor.employeeRef || (req.user && req.user.id) || null,
          template: actor.template || null,
          via: actor.via || null,
          hrApplicationAccess: Boolean(actor.hasHrApplicationAccess),
        },
      }),
  );
}

/* ── The guard ───────────────────────────────────────────────────────────────*/

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enforce=true]  false only for a diagnostic mount that
 *   wants `req.hrAuth` populated without refusing anything. Never used by
 *   server.js — a flag that turns the contract off in production would be the
 *   hole this file exists to close.
 */
function hrContract(opts = {}) {
  const enforce = opts.enforce !== false;

  return async function hrContractGuard(req, res, next) {
    let declaration = null;
    try {
      const fullPath = (req.baseUrl || "") + (req.path || "");
      declaration = findDeclaration(req.method, fullPath);

      if (!declaration) {
        /* Fail closed. An HR path with no declaration is either a route nobody
           classified — which the coverage test refuses to let ship — or a path
           that matches no route at all, in which case refusing is also the
           right answer and tells an enumerator nothing. */
        if (!enforce) return next();
        console.warn(
          `[hr-auth] no authorisation declaration for ${req.method} ${fullPath} — refusing. ` +
            "Add it to services/access/hrRouteContract.js.",
        );
        return res.status(403).json({
          success: false,
          code: "HR_ROUTE_NOT_DECLARED",
          message: "You do not have permission to perform this action.",
        });
      }

      if (declaration.scope === "public") {
        req.hrAuth = { declaration, public: true };
        return next();
      }

      seedIdentity(req);

      /* The path's own ids, read from the declaration's pattern. `req.params` is
         empty here — nothing has matched a route yet — so without this the
         self-scope check would see a request that names nobody and permit
         /api/employee/payslip/<somebody-else>. */
      req.hrParams = extractParams(declaration, fullPath);

      const result = await authorizeHr({
        user: req.user,
        capabilities: declaration.capabilities,
        scope: declaration.scope,
        selfParams: declaration.selfParams,
        managerScope: declaration.managerScope,
        req,
      });

      if (!result.allowed) {
        logDenial(req, declaration, result);
        if (!enforce) {
          req.hrAuth = { declaration, denied: result.decision };
          return next();
        }
        return res.status(result.status).json({
          success: false,
          code: result.decision,
          message: result.message,
          ...(result.decision === DECISIONS.MISSING_CAPABILITY && result.capability
            ? { requiredCapability: result.capability }
            : {}),
        });
      }

      const capabilitiesHeld = result.actor.capabilities;

      /* ── The second, field-sensitive check ────────────────────────────────
       *
       * A declaration authorises a ROUTE; some routes carry several different
       * operations in one body. `writePolicy: "employee"` says so, and the
       * fields decide what else is needed — a salary in the payload demands
       * `compensation.write`, a transfer demands `employment.change`, an
       * access-department grant is refused at any HR role because it is Access
       * Control's to give.
       *
       * Runs BEFORE the handler, so a payload mixing an allowed change with a
       * refused one is refused whole and nothing is partially written. */
      if (declaration.writePolicy === "employee") {
        const source = declaration.writeFieldsFrom
          ? req.body?.[declaration.writeFieldsFrom]
          : req.body;
        const verdict = classifyEmployeeWrite(source);

        if (verdict.forbidden.length) {
          logDenial(req, declaration, {
            decision: "HR_FIELD_NOT_WRITABLE",
            actor: result.actor,
            capability: null,
          });
          return res.status(403).json({
            success: false,
            code: "HR_FIELD_NOT_WRITABLE",
            message: "One or more fields in this request cannot be changed here.",
            /* The field NAMES are the caller's own request echoed back, so this
               discloses nothing about the record — and without them a client
               cannot tell which of thirty fields to drop. */
            fields: verdict.forbidden,
          });
        }

        const extra = verdict.capabilities.filter((c) => !capabilitiesHeld.has(c));
        if (extra.length) {
          logDenial(req, declaration, {
            decision: DECISIONS.MISSING_CAPABILITY,
            actor: result.actor,
            capability: extra[0],
          });
          return res.status(result.status === 200 ? 403 : result.status).json({
            success: false,
            code: DECISIONS.MISSING_CAPABILITY,
            message: "You do not have permission to perform this action.",
            requiredCapability: extra[0],
            fields: verdict.byCapability[extra[0]] || [],
          });
        }
      }

      /* Everything a handler needs to narrow further, already derived.
         `project` is the field allowlist bound to THIS caller — a route that
         returns an employee should pass it through rather than picking fields
         itself, because the allowlist is the thing that gets updated when
         Employee grows a new sensitive column. */
      const capabilities = capabilitiesHeld;
      req.hrAuth = {
        declaration,
        actor: result.actor,
        capabilities,
        has: (cap) => capabilities.has(cap),
        fields: result.fields,
        /* Pass to `.select()` so a value the caller may not read is never
           loaded, decrypted or held in memory in the first place. */
        exclude: result.fields.exclude,
        project: (doc, o = {}) =>
          Array.isArray(doc)
            ? projectEmployees(doc, capabilities, o)
            : projectEmployee(doc, capabilities, o),
        compatibility: result.actor.compatibility,
      };

      /* ── The floor under the projection ───────────────────────────────────
       *
       * `req.hrAuth.project` is the allowlist a handler SHOULD use. This is what
       * happens when it does not: every permitted response is walked on the way
       * out and the protected leaves this caller has no capability for are
       * removed. Twenty HR routers select their own fields today, and a
       * capability gate that lets the right person through still has to answer
       * for what the handler behind it decided to serialize.
       *
       * Installed AFTER middleware/conditionalGet's wrapper, which is why the
       * guard is mounted below it in server.js: the last wrapper installed is
       * the first one called, so the ETag is computed over the SCRUBBED bytes.
       * The other way round, two callers with different capabilities would
       * share an ETag and a 304 could hand one of them the other's body.
       */
      const selfScope = declaration.scope === "self";
      /* By NAME, never by capability. Every route in the password-management
         family holds `security.credentials.manage`; only the one that generates
         a one-time password has any business returning it, and a list, a
         lookup, a sync or a bulk reset does not. */
      const allowCredentialDelivery = declaration.credentialDelivery === true;
      const sendJson = res.json.bind(res);
      res.json = function hrScrubbedJson(body) {
        try {
          return sendJson(scrubResponse(body, capabilities, { self: selfScope, allowCredentialDelivery }));
        } catch (err) {
          /* A scrub that throws must not cost the response — but it must not
             silently hand over the unscrubbed body either. */
          console.error("[hr-auth] response scrub failed:", err.message);
          return res.status(500).end();
        }
      };

      return next();
    } catch (err) {
      /* Fail CLOSED. A resolver that cannot reach the access records cannot
         prove anybody may read HR, and answering "sure" while the database is
         unreachable is how an outage becomes a disclosure. */
      console.error("[hr-auth] guard failed:", err.message);
      if (!enforce) return next();
      return res.status(503).json({
        success: false,
        code: "HR_AUTHORISATION_UNAVAILABLE",
        message: "Could not check your access. Try again.",
      });
    }
  };
}

/**
 * Route-level helper for the rare case a handler needs a SECOND, narrower
 * check — a field the mount-level declaration cannot see, such as "this body
 * changes salary, so it needs compensation.write as well".
 *
 * Deliberately thin. If a route reaches for this to compare a role string, the
 * declaration is wrong and belongs in the registry instead.
 */
function requireHrCapability(...capabilities) {
  return async function hrCapabilityGuard(req, res, next) {
    const actor = req.hrAuth?.actor || (await resolveHrActor(req.user));
    const result = await authorizeHr({
      user: req.user,
      actor,
      capabilities,
      scope: "hr",
      req,
    });
    if (result.allowed) return next();
    logDenial(req, req.hrAuth?.declaration || null, result);
    return res.status(result.status).json({
      success: false,
      code: result.decision,
      message: result.message,
    });
  };
}

module.exports = hrContract;
module.exports.hrContract = hrContract;
module.exports.requireHrCapability = requireHrCapability;
module.exports.seedIdentity = seedIdentity;
