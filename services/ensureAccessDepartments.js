// services/ensureAccessDepartments.js
//
// Make sure access_departments and dept_users exist, on whatever database the
// server happens to be pointed at.
//
// Runs once at boot so switching from a local database to production needs no
// manual migration step. It is the same logic as
// scripts/migrations/001-seed-access-departments.js, reduced to the part that
// is safe to run unattended on every start.
//
// STRICTLY ADDITIVE — THIS IS THE WHOLE POINT
// -------------------------------------------
// It only ever inserts. It never updates a department an administrator has
// edited, never deletes anything, never touches a password, and never
// reactivates something switched off on purpose. If the collections are already
// populated it does nothing at all and returns immediately.
//
// That matters because the production database still has the twelve original
// department logins in their own collections, and those must keep working
// exactly as they are until a deliberate cutover. Nothing here modifies them:
// dept_users rows are created ALONGSIDE, reusing the same _id, so the legacy
// login path and the new one address the same identity.

"use strict";

const AccessDepartment = require("../models/Access/AccessDepartment");
const DeptUser = require("../models/Access/DeptUser");

/** key, slug, display name, and the legacy collection it mirrors. */
const DEPARTMENTS = [
  { key: "hr", slug: "hr", name: "Human Resources", sortOrder: 10,
    legacyModel: "HRDepartment", legacyCollection: "hrdepartments",
    legacyUserType: "hr", dashboardPath: "/hr/dashboard",
    description: "Employees, payroll, attendance and leave." },
  { key: "ceo", slug: "ceo", name: "Executive Office", sortOrder: 20,
    legacyModel: "CEODepartment", legacyCollection: "ceodepartments",
    legacyUserType: "ceo", dashboardPath: "/ceo/dashboard",
    description: "Company-wide reporting and oversight." },
  { key: "project_manager", slug: "project-manager", name: "Project Manager", sortOrder: 30,
    legacyModel: "ProjectManager", legacyCollection: "projectmanagers",
    legacyUserType: "project_manager", dashboardPath: "/project-manager/dashboard",
    description: "Production planning, work orders and scheduling." },
  { key: "sales", slug: "sales", name: "Sales", sortOrder: 40,
    legacyModel: "SalesDepartment", legacyCollection: "salesdepartments",
    legacyUserType: "sales", dashboardPath: "/sales/dashboard",
    description: "Customer requests, quotations and orders." },
  { key: "accountant", slug: "accountant", name: "Accounting", sortOrder: 50,
    legacyModel: "Acc_Department", legacyCollection: "acc_departments",
    legacyUserType: "accountant", dashboardPath: "/accountant/",
    description: "Ledgers, vouchers and financial reporting." },
  { key: "store", slug: "store", name: "Store & Purchase", sortOrder: 60,
    legacyModel: "StoreDepartment", legacyCollection: "storedepartments",
    legacyUserType: "store", dashboardPath: "/store/dashboard/overview",
    description: "Raw materials, stock and purchasing." },
  { key: "mpc", slug: "mpc-measurement", name: "MPC Measurement", sortOrder: 70,
    legacyModel: "MpcMeasurement", legacyCollection: "mpcmeasurements",
    legacyUserType: "mpc-measurement", dashboardPath: "/mpc-measurement/dashboard",
    description: "Measurement collection and sizing." },
  { key: "cutting", slug: "cutting-master", name: "Cutting Master", sortOrder: 80,
    legacyModel: "CuttingMasterDepartment", legacyCollection: "cuttingmasterdepartments",
    legacyUserType: "cutting-master", dashboardPath: "/cutting-master/dashboard",
    description: "Fabric cutting and marker planning." },
  { key: "embroidery", slug: "embroidery", name: "Embroidery", sortOrder: 90,
    legacyModel: "EmbroideryDepartment", legacyCollection: "embroiderydepartments",
    legacyUserType: "embroidery", dashboardPath: "/embroidery/dashboard/overview",
    description: "Embroidery motifs and production." },
  { key: "prod_supervisor", slug: "production-supervisor", name: "Production Supervisor", sortOrder: 100,
    legacyModel: "ProductionSupervisorDepartment", legacyCollection: "productionsupervisordepartments",
    legacyUserType: "production-supervisor", dashboardPath: "/production-supervisor/dashboard",
    description: "Shop-floor supervision and progress." },
  { key: "qc", slug: "qc", name: "Quality Control", sortOrder: 110,
    legacyModel: "QCDepartment", legacyCollection: "qcdepartments",
    legacyUserType: "qc", dashboardPath: "/qc/dashboard",
    description: "Inspection and quality gates." },
  { key: "packaging", slug: "packaging-dispatch", name: "Packaging & Dispatch", sortOrder: 120,
    legacyModel: "PackagingDispatchDepartment", legacyCollection: "packagingdispatchdepartments",
    legacyUserType: "packaging-dispatch", dashboardPath: "/packaging-dispatch/dashboard",
    description: "Packing, dispatch and delivery." },
];

const PLATFORM_ADMIN = {
  key: "platform_admin",
  slug: "platform-admin",
  name: "Platform Administration",
  description: "Manage departments, access and users.",
  dashboardPath: "/ceo/dashboard/access",
  showOnOnboarding: false,
  sortOrder: 0,
  legacyRole: "platform_admin",
  legacyUserType: "platform_admin",
};

/** The role literal most rows in a collection carry — never assumed. */
function dominantRole(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.role) continue;
    counts.set(r.role, (counts.get(r.role) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [role, n] of counts) if (n > bestN) { bestN = n; best = role; }
  return best;
}

async function ensureAccessDepartments(connection) {
  try {
    let departmentsCreated = 0;
    let usersCreated = 0;

    for (const dept of DEPARTMENTS) {
      // Read straight off the collection, not through a model: a model would
      // apply schema defaults, and StoreDepartment defaults `role` to
      // "production_manager" while the real rows say "store_manager". Freezing
      // a default instead of the stored value would break authorization for
      // every store user, permanently and silently.
      let rows = [];
      try {
        rows = await connection.collection(dept.legacyCollection).find({}).toArray();
      } catch {
        // Collection absent on this database — nothing to mirror.
      }

      const legacyRole = dominantRole(rows) || dept.slug;

      // $setOnInsert only. An administrator's rename, icon or ordering is never
      // overwritten by a restart.
      const result = await AccessDepartment.updateOne(
        { key: dept.key },
        {
          $setOnInsert: {
            slug: dept.slug,
            name: dept.name,
            description: dept.description,
            dashboardPath: dept.dashboardPath,
            showOnOnboarding: true,
            sortOrder: dept.sortOrder,
            isSystem: true,
            isActive: true,
            legacyModel: dept.legacyModel,
            legacyCollection: dept.legacyCollection,
            legacyRole,
            legacyUserType: dept.legacyUserType,
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount) departmentsCreated++;

      const saved = await AccessDepartment.findOne({ key: dept.key }).select("_id").lean();
      if (!saved) continue;

      // Mirror each legacy account into dept_users under THE SAME _id, so the
      // 117 ObjectId references elsewhere keep resolving to the same identity.
      for (const row of rows) {
        const email = String(row.email || "").toLowerCase().trim();
        if (!email) continue;

        // Skip if this email is already taken by a different row — the unique
        // index would reject it, and guessing which one wins is a business
        // decision, not a boot task.
        const clash = await DeptUser.findOne({ email }).select("_id").lean();
        if (clash && String(clash._id) !== String(row._id)) continue;

        const bcryptOk = DeptUser.looksLikeBcrypt(row.password);

        const res = await DeptUser.updateOne(
          { _id: row._id },
          {
            $setOnInsert: {
              email,
              name: row.name || email,
              employeeId: row.employeeId || undefined,
              phone: row.phone || undefined,
              isActive: row.isActive !== false,
              departmentId: saved._id,
              legacyModel: dept.legacyModel,
              legacyRole: row.role || legacyRole,
              passwordHash: bcryptOk
                ? row.password
                : await DeptUser.unusablePasswordHash(),
              mustChangePassword: !bcryptOk,
              tokenVersion: 0,
              isAdmin: false,
            },
          },
          { upsert: true },
        );
        if (res.upsertedCount) usersCreated++;
      }
    }

    await AccessDepartment.updateOne(
      { key: PLATFORM_ADMIN.key },
      { $setOnInsert: { ...PLATFORM_ADMIN, isSystem: true, isActive: true } },
      { upsert: true },
    );

    if (departmentsCreated || usersCreated) {
      console.log(
        `[access] Prepared this database: ${departmentsCreated} department(s) and ` +
          `${usersCreated} login(s) registered. Existing accounts were not modified.`,
      );
    }
  } catch (err) {
    // Never take the server down over this. The legacy login path still works
    // without these collections — that is the whole point of the dual read.
    console.error("[access] Could not prepare access tables:", err.message);
  }
}

module.exports = { ensureAccessDepartments };
