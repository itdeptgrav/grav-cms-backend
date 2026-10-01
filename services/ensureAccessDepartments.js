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
  // Merchandising — internal coordination of a confirmed requirement, worked
  // from a Style. No legacy collection of its own (no legacy merchandiser
  // logins exist), so it only registers the department + onboarding tile; a
  // platform admin can open it today.
  //
  // ── THE DESCRIPTION USED TO NAME THREE OTHER APPS' RECORDS ──────────────
  // "Purchase orders & PI, customers, and products & BOM" described the pages
  // Merchandising had BORROWED from Sales and Store, not the work it owns.
  // Purchase orders and customers are Sales'; the downstream product record is
  // Inventory's. It is corrected below, and because this seeder is and stays
  // strictly additive, existing databases are moved by the one-off migration
  // scripts/migrations/merchandising-department-description.js — never by a
  // restart, which would also overwrite an administrator's own wording.
  { key: "merchandiser", slug: "merchandiser", name: "Merchandising", sortOrder: 45,
    legacyModel: null, legacyCollection: "merchandiserdepartments",
    legacyUserType: "merchandiser", dashboardPath: "/merchandiser/dashboard",
    description: "Style execution, component selection and development coordination." },
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
  /* The developer side. No legacy collection — nobody ever signed in to a
     "developers" module — so like Merchandising it only registers the
     department, which is exactly what makes it appear in CEO → Access Control
     and therefore GRANTABLE from there. That grant is the whole access model:
     routes/DevOps/developer.js checks DepartmentRole("developer"). */
  { key: "developer", slug: "developer", name: "Developer", sortOrder: 125,
    legacyModel: null, legacyCollection: "developerdepartments",
    legacyUserType: "developer", dashboardPath: "/developer",
    description: "Cross-department history, anomaly alerts, live settings and system health." },
  /* Industrial Engineering. A department application in its own right
     (ADR-003) — it owns operation standards, style bulletins, SAM, method
     studies, machine and skill requirements, line balance and capacity
     standards. PPC owns scheduling; Production owns execution, and Production
     Manager and Production Supervisor stay ROLES inside Production rather than
     becoming a second name for this.

     No legacy collection — nobody ever signed in to an "industrial
     engineering" module — so like Merchandising and Developer it only
     registers the department, which is what makes it appear in
     CEO → Access Control and therefore GRANTABLE from there. That grant is the
     whole access model: every /api/cms/ie endpoint checks
     DepartmentRole("ie"), and the frontend shell is gated on the same slug.

     Sorted at 47, between Merchandising (45) and Accounting (50): IE sits with
     the make-side departments rather than at the end of the list. */
  { key: "ie", slug: "ie", name: "Industrial Engineering", sortOrder: 47,
    legacyModel: null, legacyCollection: "iedepartments",
    legacyUserType: "ie", dashboardPath: "/industrial-engineering/orders",
    description: "Operation standards, style bulletins, SAM, line balance and capacity standards." },
  /* PPC owns planning decisions and capacity booking, separate from IE's
     engineering standards and Production's execution. This row only makes
     the existing PPC grant and Order Book landing available in Access Control;
     it creates no role grant or production authority. */
  { key: "ppc", slug: "ppc", name: "Production Planning & Control", sortOrder: 48,
    legacyModel: null, legacyCollection: "ppcdepartments",
    legacyUserType: "ppc", dashboardPath: "/ppc",
    description: "Confirmed-order planning, engineering release receipts and capacity booking." },
  /* Trimming and Ironing (24 Sep 2026): the two finishing stages between
     sewing and packing, each its own portal with its own people. No legacy
     collection — nobody ever signed in to them before this — so, like
     Merchandising and IE, this registers the department and nothing else.
     People reach them through a DepartmentRole grant or an employee's
     department assignment, exactly as any other department. Their config
     (names, labels, paths) is services/manufacturing/finishingStages.js. */
  { key: "printing", slug: "printing", name: "Printing", sortOrder: 93,
    legacyModel: null, legacyCollection: null,
    legacyUserType: "printing", dashboardPath: "/printing/dashboard",
    description: "Screen and transfer printing, piece by piece." },
  { key: "washing", slug: "washing", name: "Washing", sortOrder: 94,
    legacyModel: null, legacyCollection: null,
    legacyUserType: "washing", dashboardPath: "/washing/dashboard",
    description: "Garment washing and drying, piece by piece." },
  { key: "trimming", slug: "trimming", name: "Trimming", sortOrder: 95,
    legacyModel: null, legacyCollection: null,
    legacyUserType: "trimming", dashboardPath: "/trimming/dashboard",
    description: "Thread trimming and finishing checks, piece by piece." },
  { key: "ironing", slug: "ironing", name: "Ironing", sortOrder: 96,
    legacyModel: null, legacyCollection: null,
    legacyUserType: "ironing", dashboardPath: "/ironing/dashboard",
    description: "Pressing and folding, piece by piece." },
  { key: "packaging", slug: "packaging-dispatch", name: "Packaging & Dispatch", sortOrder: 120,
    legacyModel: "PackagingDispatchDepartment", legacyCollection: "packagingdispatchdepartments",
    legacyUserType: "packaging-dispatch", dashboardPath: "/packaging-dispatch/dashboard",
    description: "Packing, dispatch and delivery." },
  /* Marketing. A department application in its own right, and deliberately NOT
     a second door into Sales: `Middlewear/MarketingAuthMiddlewear.js` is a
     separate allowlist over the same token precisely so the marketing team does
     not inherit the Sales customer master.

     No legacy collection — nobody ever signed in to a "marketing" module — so
     like Merchandising, Developer and IE this registers the department and
     nothing else. That registration is what makes the app appear in
     CEO → Access Control and therefore GRANTABLE: without a row here the
     `/marketing` shell and every `/api/cms/marketing` endpoint are correct and
     unreachable by everyone except a platform administrator.

     Sorted at 44, immediately before Merchandising: Marketing's work precedes
     the order in the life of a garment, and it belongs beside Sales (40) rather
     than at the end of the make-side list.

     Registration ONLY. Nothing here grants a Mautic credential, a consent
     record or a handover — those are Lane A's services, and this file does not
     import one. */
  { key: "marketing", slug: "marketing", name: "Marketing", sortOrder: 44,
    legacyModel: null, legacyCollection: "marketingdepartments",
    legacyUserType: "marketing", dashboardPath: "/marketing",
    description: "Campaign state, consent and synchronisation health, and Prospect handovers to Sales." },
  /* ── BOARD — ITS OWN APPLICATION, ITS OWN GRANT ──────────────────────────
     The Board app existed before this row did, and its authority read the
     `ceo` grant because that was the only board-level boundary the repository
     had. The two are not one thing: Executive Office is company-wide reporting
     and oversight; the Board sets the policies a costing is calculated under.
     Coupling them meant a person had to be given the Executive Office before
     the Board role selector would even appear, and revoking one silently moved
     the other.

     No legacy collection: there have never been Board logins to mirror. It is
     a grant an administrator makes in Access Control and nothing else.

     ── AND NOT ON THE PUBLIC GRID ──────────────────────────────────────
     `showOnOnboarding: false`, the only seeded row that says so. `/onboarding`
     is an unauthenticated page that invites somebody to pick the department
     they work in and sign in; Board is not a department anybody works in. It is
     an internal application granted, per person, by an administrator, and then
     only usable with an explicit Board ROLE on top — see
     `services/board/boardAccess.js`.

     Hiding it there is not protection and is not claimed to be: `/board` is a
     route anyone may type, and the server refuses them per request. It is about
     not inviting the company at large to ask for a seat on the Board.

     It stays fully visible in Access Control, which reads the department list
     through the authenticated admin route and does not filter on this flag. */
  { key: "board", slug: "board", name: "Board", sortOrder: 21,
    legacyModel: null, legacyCollection: null, showOnOnboarding: false,
    legacyUserType: "board", dashboardPath: "/board/dashboard/policies/financing",
    description: "Company policy: the rules every costing is calculated under." },
];

// Platform administration is NOT a department.
//
// It used to be seeded as one, with a dashboardPath of /ceo/dashboard/access —
// the same console the Executive Office tile opens. That gave the product two
// admin identities for one place: an extra row in the department list, an extra
// icon in the rail, and a second thing to keep in step.
//
// Administrator is a property of a PERSON, not a place: the `isAdmin` flag on
// the account, which requirePlatformAdmin re-reads from the database on every
// request. Access Control lives inside the Executive Office, where it always
// did. Rows already created in a live database are left exactly where they are
// — this seeder is additive and never deletes — but nothing new is created and
// the API filters the slug out of the department list.
const PLATFORM_ADMIN_SLUG = "platform-admin";

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
      // A department with no legacy collection has no logins to mirror — Board
      // has never had any. Asked for by name, `connection.collection(null)`
      // registers a null-named collection on the connection, which then breaks
      // anything that walks `connection.collections` (the test harness's own
      // clean-up, for one).
      if (dept.legacyCollection) {
        try {
          rows = await connection.collection(dept.legacyCollection).find({}).toArray();
        } catch {
          // Collection absent on this database — nothing to mirror.
        }
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
            /* Every department is on the onboarding grid unless its own entry
               says otherwise. Board is the one that does: it is an internal,
               role-controlled application, not a login somebody chooses off a
               public page. Still `$setOnInsert`, so an administrator's later
               decision either way survives every restart. */
            showOnOnboarding: dept.showOnOnboarding !== false,
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

/* DEPARTMENTS is the canonical map of department → the collection its logins
   actually live in. Exported because Access Control needs the same list to show
   and remove those logins, and a second copy would be a second answer to
   "where does hr@grav.in live". */
module.exports = { ensureAccessDepartments, DEPARTMENTS };
