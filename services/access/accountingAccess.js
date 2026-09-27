"use strict";
/**
 * services/access/accountingAccess.js — who may reach the accountant module's
 * data through the central GRAV assistant.
 *
 * Mirrors resolveHrAccess. Access is granted to a verified privileged CMS role
 * (CEO / admin) or to someone who is an accountant-module user (matched by email
 * against acc_users / accountantdepartments). The decision comes from the
 * account, never the page. Accounting data is sensitive, so this is deliberately
 * NOT open to every authenticated employee.
 */

const mongoose = require("mongoose");
const DeptUser = require("../../models/Access/DeptUser");

const ACC_ROLES = new Map([
  ["ceo", "ceo"],
  ["admin", "admin"],
  ["super_admin", "admin"],
  ["superadmin", "admin"],
  ["accountant", "accountant"],
]);

async function resolveAccountingAccess(user) {
  if (!user) return { allowed: false, via: null };

  const role = user.role ? String(user.role).toLowerCase().trim() : "";
  const privilegedVia = ACC_ROLES.get(role) || null;

  // Resolve the accounting scope at the same time as access. The assistant's
  // general reporting capability must never fall back to "the first company"
  // or accept an organisation/company id from model output. These ids come
  // only from the verified Accounting role row and its active organisation.
  // Older callers read only `allowed`/`via`; the additional fields are a
  // backwards-compatible tightening for scoped assistant reads.
  const email = user.email ? String(user.email).toLowerCase().trim() : "";
  if (email) {
    try {
      const { Acc_User, Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");
      const accUser = await Acc_User.findOne({ email, isActive: true })
        .select("_id organizationId role email")
        .lean();
      if (accUser) {
        const organization = await Acc_Organization.findOne({
          _id: accUser.organizationId,
          isActive: true,
        }).select("_id tallyCompanyIds").lean();
        if (organization) {
          return {
            allowed: true,
            via: privilegedVia || "accountant",
            accountingUserId: String(accUser._id),
            organizationId: String(organization._id),
            companyIds: (organization.tallyCompanyIds || []).map(String),
            accountingRole: accUser.role,
          };
        }
      }
    } catch {
      // Existing privileged/read-only paths remain available below. A scoped
      // report will fail closed when the scope is absent.
    }
  }

  if (privilegedVia) return { allowed: true, via: privilegedVia };

  // Platform administrator — the authoritative signal (the CEO account is an
  // isAdmin DeptUser whose JWT role can be anything). HR access already honoured
  // this; accounting must too, or the owner/CEO gets no financials.
  const adminOr = [];
  if (user.email) adminOr.push({ email: String(user.email).toLowerCase().trim() });
  if (user.id) adminOr.push({ employeeRef: user.id });
  if (user.employeeId) adminOr.push({ employeeId: user.employeeId });
  if (adminOr.length) {
    try {
      const admin = await DeptUser.findOne({ isAdmin: true, isActive: true, $or: adminOr }).select("_id").lean();
      if (admin) return { allowed: true, via: "admin" };
    } catch {
      /* fall through */
    }
  }

  // Otherwise: an accountant-module user, matched by email (case-insensitive).
  if (email) {
    try {
      const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      for (const c of ["acc_users", "accountant_users", "accountantdepartments", "acc_departments"]) {
        const hit = await mongoose.connection.db
          .collection(c)
          .findOne({ email: rx, isActive: { $ne: false } });
        if (hit) return { allowed: true, via: "accountant" };
      }
    } catch {
      /* fall through to denied */
    }
  }
  return { allowed: false, via: null };
}

module.exports = { resolveAccountingAccess };
