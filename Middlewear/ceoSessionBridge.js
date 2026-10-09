"use strict";
/**
 * Middlewear/ceoSessionBridge.js — the CEO stays the CEO on /api/ceo.
 *
 * The CMS keeps ONE session per browser (the `auth_token` cookie, and
 * localStorage "acc_token" sent as `Authorization: Bearer`), and it does not
 * stay the CEO's:
 *
 *   • opening a department's pages SWITCHES it into that department — a CEO in
 *     Store carries role "store_manager";
 *   • opening Accounting trades it for an ORGANISATION session, whose role is
 *     the Accounting role ("approver", "owner").
 *
 * The eleven CEO routers each check the token's `role` is "ceo"/"admin" (some
 * reading the cookie first, some the header), so after visiting any department
 * — or with a department open in another tab — the CEO dashboard answered
 * "CEO access required" to the CEO (found by scripts/pageSweep.js, 7 Oct 2026).
 *
 * Mounted on /api/ceo before every CEO router. Each credential presented (the
 * cookie and the Bearer) is verified; if one belongs to a person who is, by the
 * DATABASE, an active platform administrator or a login of the CEO department
 * — reached either as that department login itself, or through a verified,
 * active, unrevoked accounting session for the same email — both the cookie
 * and the header are replaced with that login's own CEO session. It is the same
 * person, so nothing is granted that their CEO login does not hold; anything
 * else passes through untouched for the routers' own guards to judge.
 */

const jwt = require("jsonwebtoken");
const { SECRET } = require("../config/jwt");

function presented(req) {
  const out = [];
  if (req.cookies?.auth_token) out.push(req.cookies.auth_token);
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)auth_token=([^;]+)/);
  if (m) out.push(decodeURIComponent(m[1]));
  const h = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(h)) out.push(h.replace(/^Bearer\s+/i, "").trim());
  return [...new Set(out.filter(Boolean))];
}

async function ceoLoginFor(decoded) {
  const DeptUser = require("../models/Access/DeptUser");
  const AccessDepartment = require("../models/Access/AccessDepartment");
  let login = null;

  if (decoded.organizationId && decoded.email) {
    /* An accounting session: it must itself be live before its email counts. */
    const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");
    const acc = await Acc_User.findById(decoded.id).select("email isActive tokenVersion").lean();
    if (!acc || acc.isActive === false || (acc.tokenVersion || 0) !== (decoded.tokenVersion || 0)) return null;
    login = await DeptUser.findOne({ email: String(acc.email).toLowerCase().trim(), isActive: { $ne: false } }).lean();
  } else if (decoded.subject === "dept_user" && decoded.id) {
    /* The CEO's own department login, switched into another department. */
    login = await DeptUser.findById(decoded.id).lean().catch(() => null);
    if (!login || login.isActive === false || (login.tokenVersion || 0) !== (decoded.tv || 0)) return null;
  }
  if (!login || login.isActive === false) return null;

  const home = login.departmentId ? await AccessDepartment.findById(login.departmentId).lean() : null;
  const isCeo = login.isAdmin === true || home?.slug === "ceo" || home?.legacyRole === "ceo";
  return isCeo ? { login, home } : null;
}

module.exports = async function ceoSessionBridge(req, res, next) {
  try {
    const tokens = presented(req);
    if (!tokens.length) return next();
    const decodedAll = tokens.map((t) => { try { return jwt.verify(t, SECRET); } catch { return null; } }).filter(Boolean);
    /* Already a CEO session everywhere it is read: nothing to do. */
    if (decodedAll.length && decodedAll.every((d) => ["ceo", "admin"].includes(d.role))) return next();

    for (const decoded of decodedAll) {
      if (["ceo", "admin"].includes(decoded.role)) continue;
      const found = await ceoLoginFor(decoded);
      if (!found) continue;
      const { buildTokenPayload, signToken } = require("../routes/auth/deptAuth");
      const ceoToken = signToken(buildTokenPayload(found.login, found.home));
      req.headers.authorization = `Bearer ${ceoToken}`;
      if (req.cookies) req.cookies.auth_token = ceoToken;
      if (req.headers.cookie) req.headers.cookie = req.headers.cookie.replace(/(^|;\s*)auth_token=[^;]+/, `$1auth_token=${ceoToken}`);
      return next();
    }
    return next();
  } catch (err) {
    /* A bridge that fails must never block: the routers judge the original. */
    console.warn("[ceoSessionBridge]", err?.message || err);
    return next();
  }
};
