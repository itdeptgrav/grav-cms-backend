"use strict";
/**
 * services/access/hrOperator.js — "may this request act as HR?", answered once.
 *
 * About twenty HR handlers still carried their own check from before the HR
 * contract existed:
 *
 *     if (user.role !== "hr_manager") return 403 "Permission denied"
 *
 * By the time a handler runs, Middlewear/hrContract.js has ALREADY authorised
 * the request against that route's declared capabilities and scope. The old
 * string check added nothing for HR staff — every HR session carries
 * `role: "hr_manager"`, a viewer's included — and it refused exactly the people
 * the contract had let through on other grounds: the CEO and platform
 * administrators (role "ceo" / "platform_admin"), who were told "Permission
 * denied" on payroll, payslips, employee history and department managers
 * (found by scripts/accessProbe.js, 6 Oct 2026).
 *
 * This answers the same question from the contract's own verdict, so the
 * handler and the guard can no longer disagree:
 *
 *   • the contract authorised this request for an actor with HR application
 *     access, or a platform administrator → yes;
 *   • a request the contract never saw (a router mounted somewhere unguarded)
 *     falls back to the old claim, so nothing that worked before stops working.
 *
 * It is never a way IN: a request the contract refused has already been
 * answered 401/403 before any handler runs.
 */

/**
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function isHrOperator(req) {
  const auth = req?.hrAuth;
  if (auth && !auth.public && !auth.denied && auth.actor) {
    return Boolean(auth.actor.hasHrApplicationAccess || auth.actor.isPlatformAdmin);
  }
  /* Not behind the contract: keep the legacy behaviour rather than change a
     route's meaning silently. */
  return req?.user?.role === "hr_manager";
}

module.exports = { isHrOperator };
