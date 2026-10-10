// services/sales/salesPeople.js
//
// WHO CAN OWN A LEAD (3 Oct 2026, owner: "the Owner dropdown shows only
// Unassigned").
//
// The lead's Owner list used to read the legacy `salesdepartments`
// collection, which has 0 rows: the Sales team is defined by the access
// register — `department_roles` with departmentSlug "sales" — and signs in
// through the department login (`dept_users`) or the employee login
// (`employees`). So the list is the active Sales role holders, each with the
// identity id they sign in as, so that "assign to me" and "assigned to X"
// compare against `req.user.id`:
//
//   dept_users row by email  →  else employees row by email  →  else the role
//   row's own id (a person granted a role who has not signed in yet).
//
// Legacy `salesdepartments` rows are still merged in by email, so an old
// lead's owner remains selectable.

const mongoose = require("mongoose");

const lc = (s) => String(s || "").trim().toLowerCase();
const fullName = (e) => [e?.firstName, e?.middleName, e?.lastName].filter(Boolean).join(" ").trim();

async function listSalesPeople() {
  const DepartmentRole = mongoose.models.DepartmentRole || require("../../models/Access/DepartmentRole");
  const DeptUser = mongoose.models.DeptUser || require("../../models/Access/DeptUser");
  const Employee = mongoose.models.Employee || require("../../models/Employee");
  const SalesDepartment = mongoose.models.SalesDepartment || require("../../models/SalesDepartment");

  const roles = await DepartmentRole.find({ departmentSlug: "sales", isActive: { $ne: false } }).select("email name role").lean();
  const emails = [...new Set(roles.map((r) => lc(r.email)).filter(Boolean))];
  const [deptUsers, employees, legacy] = await Promise.all([
    emails.length ? DeptUser.find({ email: { $in: emails } }).select("name email isActive").lean() : [],
    emails.length ? Employee.find({ email: { $in: emails } }).select("firstName middleName lastName name email").lean().catch(() => []) : [],
    SalesDepartment.find({}).select("name email role").lean().catch(() => []),
  ]);
  const du = new Map(deptUsers.map((u) => [lc(u.email), u]));
  const em = new Map(employees.map((e) => [lc(e.email), e]));

  const out = new Map();
  for (const r of roles) {
    const email = lc(r.email);
    if (!email || out.has(email)) continue;
    const u = du.get(email), e = em.get(email);
    const id = u?._id || e?._id || r._id;
    const name = (u?.name || fullName(e) || e?.name || r.name || email).trim();
    out.set(email, { _id: String(id), name, email, role: r.role, source: u ? "department" : e ? "employee" : "role" });
  }
  for (const s of legacy) {
    const email = lc(s.email);
    if (email && out.has(email)) continue;
    out.set(email || String(s._id), { _id: String(s._id), name: s.name || email, email, role: s.role || "", source: "legacy" });
  }
  /* one person, one row: a role granted under an old address AND a new one is
     the same salesperson — keep the identity they sign in with */
  const RANK = { department: 3, employee: 2, legacy: 1, role: 0 };
  const byName = new Map();
  for (const p of out.values()) {
    const k = p.name.toLowerCase().replace(/\s+/g, " ");
    const prev = byName.get(k);
    if (!prev || RANK[p.source] > RANK[prev.source]) byName.set(k, p);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSalesPeople };
