"use strict";

const mongoose = require("mongoose");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const ChangeLog = require("../../models/Access/ChangeLog");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");

const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;
const emailOf = (value) => String(value || "").trim().toLowerCase();
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const ENABLED_DEPARTMENTS = new Set(["ppc"]);

async function verifiedPerson(email) {
  const [login, employee] = await Promise.all([
    DeptUser.findOne({ email, isActive: true }).select("_id name email").lean(),
    Employee.findOne({ email, isActive: { $ne: false }, status: { $ne: "inactive" } })
      .select("_id firstName lastName email").lean(),
  ]);
  if (!login && !employee) {
    throw problem(404, "PERSON_NOT_FOUND", "No active CMS login or employee has that email.");
  }
  return { employee, name: login?.name || [employee?.firstName, employee?.lastName].filter(Boolean).join(" ") || email };
}

const scopedFor = (row, companyId) => (row?.companyGrants || [])
  .find((g) => String(g.companyId) === String(companyId));

/** Called after company membership has been proven by the PPC route. */
async function roleForCompany({ companyId, email, actorId }) {
  const mail = emailOf(email);
  if (!mail || !mongoose.isValidObjectId(companyId)) return null;
  const row = await DepartmentRole.findOne({ departmentSlug: "ppc", email: mail })
    .select("role isActive companyGrants").lean();
  const scoped = scopedFor(row, companyId);
  if (scoped) return scoped.isActive ? scoped.role : null;

  // A global role is a compatibility bridge for precisely one company. It
  // never becomes a cross-product with two memberships. A revoked scoped
  // entry above is a tombstone and cannot fall back to the old global role.
  const or = [{ email: mail }];
  if (actorId && mongoose.isValidObjectId(actorId)) or.push({ employeeRef: actorId });
  const memberships = await SpCompanyMembership.find({ isActive: true, $or: or })
    .select("companyId").lean();
  const companies = new Set(memberships.map((m) => String(m.companyId)));
  if (companies.size !== 1 || !companies.has(String(companyId))) return null;
  return row?.isActive ? row.role : null;
}

async function list() {
  const [companies, rows] = await Promise.all([
    companyModel().find({}).select("_id companyName").sort({ companyName: 1 }).lean(),
    DepartmentRole.find({ departmentSlug: "ppc" })
      .select("email role isActive companyGrants updatedAt").sort({ email: 1 }).lean(),
  ]);
  const grants = rows.flatMap((row) => (row.companyGrants || []).map((g) => ({
    companyId: String(g.companyId), email: row.email, role: g.role,
    isActive: g.isActive, updatedAt: row.updatedAt,
  })));
  const legacyRoles = rows.filter((r) => r.isActive);
  const legacyEmails = legacyRoles.map((r) => r.email);
  const legacyMemberships = legacyEmails.length
    ? await SpCompanyMembership.find({ isActive: true, email: { $in: legacyEmails } })
      .select("email companyId").lean()
    : [];
  const byEmail = new Map();
  for (const membership of legacyMemberships) {
    const mail = emailOf(membership.email);
    if (!byEmail.has(mail)) byEmail.set(mail, new Set());
    byEmail.get(mail).add(String(membership.companyId));
  }
  return {
    companies: companies.map((c) => ({ companyId: String(c._id), name: c.companyName })),
    grants,
    legacy: legacyRoles.map((r) => {
      const memberships = byEmail.get(emailOf(r.email)) || new Set();
      const companyId = memberships.size === 1 ? [...memberships][0] : null;
      const scoped = companyId && scopedFor(r, companyId);
      return {
        email: r.email, role: r.role, companyId,
        state: companyId && !scoped ? "SINGLE_COMPANY_COMPATIBILITY" : "REVIEW_REQUIRED",
      };
    }).filter((r) => r.state === "SINGLE_COMPANY_COMPATIBILITY"
      || !grants.some((g) => g.email === r.email)),
  };
}

async function change({ companyId, departmentSlug, email, role, reason, actor }) {
  const mail = emailOf(email);
  const slug = String(departmentSlug || "").trim().toLowerCase();
  const why = String(reason || "").trim();
  if (!ENABLED_DEPARTMENTS.has(slug)) {
    throw problem(400, "APP_NOT_CUT_OVER", "Company-scoped administration is not enabled for that app yet.");
  }
  if (!mongoose.isValidObjectId(companyId) || !mail || !why || why.length > 500) {
    throw problem(400, "INVALID_GRANT", "Choose a company and person, and give a reason of at most 500 characters.");
  }
  if (role !== null && !DepartmentRole.ROLE_KEYS.includes(role)) {
    throw problem(400, "INVALID_ROLE", "Choose viewer, editor, approver or owner.");
  }
  if (!actor?._id || !actor?.email) {
    throw problem(403, "ADMIN_REQUIRED", "An active access administrator is required.");
  }
  const [company, person] = await Promise.all([
    companyModel().findById(companyId).select("_id").lean(), verifiedPerson(mail),
  ]);
  if (!company) throw problem(404, "COMPANY_NOT_FOUND", "Company not found.");

  const session = await mongoose.startSession();
  try {
    let outcome;
    await session.withTransaction(async () => {
      // Serialise all grants for this company through one EXISTING document.
      // Snapshot transactions alone permit two different emails to both pass
      // an owner check (write skew). Updating the same company row forces one
      // of those transactions to retry/fail without adding a collection.
      await companyModel().collection.updateOne(
        { _id: company._id }, { $inc: { companyAccessRevision: 1 } }, { session },
      );
      let row = await DepartmentRole.findOne({ departmentSlug: slug, email: mail }).session(session);
      const scoped = scopedFor(row, company._id);
      let previous = scoped?.isActive ? scoped.role : null;
      const previousSource = scoped ? "company" : "legacy-or-none";
      if (!scoped && row?.isActive) {
        const identityOr = [{ email: mail }];
        if (person.employee) identityOr.push({ employeeRef: person.employee._id });
        const allMemberships = await SpCompanyMembership.find({
          isActive: true, $or: identityOr,
        }).select("companyId").session(session).lean();
        const companyIds = new Set(allMemberships.map((m) => String(m.companyId)));
        if (companyIds.size === 1 && companyIds.has(String(company._id))) previous = row.role;
      }

      if (role) {
        const member = await SpCompanyMembership.findOne({
          companyId: company._id,
          $or: [{ email: mail }, ...(person.employee ? [{ employeeRef: person.employee._id }] : [])],
        }).session(session);
        if (!member?.isActive) {
          const otherLegacy = await DepartmentRole.find({
            email: mail, isActive: true, departmentSlug: { $ne: slug },
          }).select("departmentSlug").session(session).lean();
          if (otherLegacy.length) {
            throw problem(409, "LEGACY_ROLES_REQUIRE_REVIEW",
              `This membership would also activate legacy roles in ${otherLegacy.map((r) => r.departmentSlug).join(", ")}. Review and migrate those roles first.`);
          }
        }
        if (member) {
          if (!member.isActive) {
            member.isActive = true;
            member.grantedBy = actor._id;
            member.grantedByName = actor.name || actor.email;
            member.grantedAt = new Date();
            member.note = why;
            await member.save({ session });
          }
        } else {
          await SpCompanyMembership.create([{
            companyId: company._id, email: mail,
            ...(person.employee ? { employeeRef: person.employee._id } : {}),
            personName: person.name, grantedBy: actor._id,
            grantedByName: actor.name || actor.email, note: why,
          }], { session });
        }
      }

      if (role === "owner") {
        const incumbent = await DepartmentRole.findOne({
          departmentSlug: slug, email: { $ne: mail },
          companyGrants: { $elemMatch: {
            companyId: company._id, role: "owner", isActive: true,
          } },
        }).session(session).lean();
        if (incumbent) throw problem(409, "OWNER_EXISTS", "This company already has a PPC owner. Change that grant first.");
      }

      if (!row) {
        row = new DepartmentRole({
          departmentSlug: slug, email: mail, name: person.name,
          role: "viewer", isActive: false, companyGrants: [],
        });
      }
      const current = scopedFor(row, company._id);
      if (current) {
        current.role = role || current.role;
        current.isActive = Boolean(role);
        current.reason = why;
        if (role) {
          current.grantedBy = actor._id;
          current.grantedAt = new Date();
          current.revokedBy = undefined;
          current.revokedAt = undefined;
        } else {
          current.revokedBy = actor._id;
          current.revokedAt = new Date();
        }
      } else {
        row.companyGrants.push({
          companyId: company._id, role: role || "viewer", isActive: Boolean(role),
          reason: why, grantedBy: actor._id, grantedAt: new Date(),
          ...(role ? {} : { revokedBy: actor._id, revokedAt: new Date() }),
        });
      }
      await row.save({ session });

      if (!scoped || previous !== role) {
        await ChangeLog.create([{
          departmentSlug: slug, section: "access:company", entity: "company-access",
          entityId: `${mail}:${company._id}`, entityLabel: mail,
          action: role ? (previous ? "update" : "create") : "delete",
          summary: `${mail}: ${previous || "none"} (${previousSource}) → ${role || "none"} (company) in company ${company._id}. ${why}`,
          before: { companyId: String(company._id), role: previous, source: previousSource },
          after: { companyId: String(company._id), role, source: "company" },
          actorId: actor._id, actorName: actor.name || "", actorEmail: actor.email,
          origin: "direct", critical: true,
        }], { session });
      }
      outcome = { companyId: String(company._id), email: mail, departmentSlug: slug, role };
    });
    return outcome;
  } finally {
    await session.endSession();
  }
}

module.exports = { roleForCompany, list, change, ENABLED_DEPARTMENTS };
