"use strict";
/**
 * Middlewear/ceoSessionBridge.js — the CEO stays the CEO after opening Accounting.
 *
 * The CMS keeps ONE token in the browser (localStorage "acc_token", sent as
 * `Authorization: Bearer`). Opening Accounting trades it for an ORGANISATION
 * session (sync-legacy), and from then on every request from that browser
 * carries the accounting session. Most routes identify the person by email and
 * cope. The eleven CEO routers do not: each checks `decoded.role` is "ceo" /
 * "admin", and an accounting session's role is the Accounting role
 * ("approver", "owner"…). So in Chrome — where the cross-origin cookie is not
 * sent and the header is all there is — the CEO dashboard answered "CEO access
 * required" to the CEO after any visit to Accounting (found by
 * scripts/pageSweep.js, 7 Oct 2026).
 *
 * Mounted on /api/ceo, before every CEO router: when the Bearer token is a
 * VERIFIED, ACTIVE, UNREVOKED accounting session whose email belongs to an
 * active department login that is the CEO's or a platform administrator's,
 * the header is replaced with that login's own CEO session. It is the same
 * person either way, so nothing is granted that their CEO login does not
 * already hold; anything else passes through untouched for the routers' own
 * guards to judge.
 */

const jwt = require("jsonwebtoken");
const { SECRET } = require("../config/jwt");

module.exports = async function ceoSessionBridge(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!/^Bearer\s+/i.test(header)) return next();
    let decoded;
    try {
      decoded = jwt.verify(header.replace(/^Bearer\s+/i, "").trim(), SECRET);
    } catch {
      return next();
    }
    /* Only an accounting organisation session needs bridging. */
    if (!decoded?.organizationId || !decoded.email || ["ceo", "admin"].includes(decoded.role)) return next();

    const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");
    const acc = await Acc_User.findById(decoded.id).select("email isActive tokenVersion").lean();
    if (!acc || acc.isActive === false || (acc.tokenVersion || 0) !== (decoded.tokenVersion || 0)) return next();

    const DeptUser = require("../models/Access/DeptUser");
    const AccessDepartment = require("../models/Access/AccessDepartment");
    const email = String(acc.email).toLowerCase().trim();
    const login = await DeptUser.findOne({ email, isActive: { $ne: false } }).lean();
    if (!login) return next();
    const dept = login.departmentId ? await AccessDepartment.findById(login.departmentId).lean() : null;
    const isCeo = login.isAdmin === true || dept?.slug === "ceo" || dept?.legacyRole === "ceo";
    if (!isCeo) return next();

    const { buildTokenPayload, signToken } = require("../routes/auth/deptAuth");
    req.headers.authorization = `Bearer ${signToken(buildTokenPayload(login, dept))}`;
    return next();
  } catch (err) {
    /* A bridge that fails must never block: the routers judge the original. */
    console.warn("[ceoSessionBridge]", err?.message || err);
    return next();
  }
};
