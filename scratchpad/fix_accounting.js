/*  ACCOUNTING REPAIR — two fixes, both through the canonical audited services.
 *
 *    1. Attach the orphaned company to the GRAV organisation
 *       (attachCompaniesToOrganization — the ONLY writer of tallyCompanyIds).
 *    2. Grant ceo@grav.in an Accounting role
 *       (changeAppAccess — the same path the Access Control screen uses, so the
 *        Acc_User row, the audit event and the cache invalidation all happen).
 *
 *  DRY RUN BY DEFAULT.  --apply writes.  --role=<viewer|editor|approver|owner>
 *  chooses the CEO's Accounting role (default approver, which does NOT demote
 *  the current Owner; "owner" would demote SOUMYA to approver).
 *  Nothing is deleted. Both steps are idempotent.
 */
const mongoose = require("mongoose");

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=")[1] : d;
};

(async () => {
  const APPLY = process.argv.includes("--apply");
  const ROLE = arg("role", "approver");
  const CEO = "ceo@grav.in";
  await mongoose.connect(process.env.MONGODB_URI, {});
  const db = mongoose.connection.db;
  console.log(`database: ${db.databaseName} — ${APPLY ? "APPLYING" : "DRY RUN (no writes)"}\n`);

  /* ── 1. company → organisation ─────────────────────────────────────── */
  const orgs = await db.collection("acc_organizations").find({}).project({ name: 1, tallyCompanyIds: 1 }).toArray();
  if (orgs.length !== 1) { console.log(`REFUSING step 1: expected 1 organisation, found ${orgs.length}.`); }
  else {
    const org = orgs[0];
    const owned = new Set((org.tallyCompanyIds || []).map(String));
    const cos = await db.collection("acc_companies").find({ isActive: true }).project({ companyName: 1, isPrimary: 1 }).toArray();
    const missing = cos.filter((c) => !owned.has(String(c._id)));
    console.log(`[1] organisation ${org.name} owns ${owned.size} of ${cos.length} active company(ies)`);
    missing.forEach((c) => console.log(`      attach -> ${c.companyName} (${c._id})${c.isPrimary ? " [primary]" : ""}`));
    if (!missing.length) console.log("      nothing to attach — already consistent.");
    else if (APPLY) {
      const { attachCompaniesToOrganization } = require("../services/accountantCompanyOwnership.service");
      const r = await attachCompaniesToOrganization({ organizationId: org._id, companyIds: missing.map((c) => c._id) });
      console.log("      result:", JSON.stringify(r));
    }
  }

  /* ── 2. Accounting role for the CEO ────────────────────────────────── */
  const existing = await db.collection("acc_users").findOne({ email: CEO }, { projection: { role: 1, isActive: 1 } });
  console.log(`\n[2] ${CEO} acc_users row: ${existing ? `role=${existing.role} active=${existing.isActive}` : "NONE — cannot sign in to Accounting"}`);
  if (existing) console.log(`      already granted — leaving it alone.`);
  else {
    console.log(`      grant -> Accounting "${ROLE}"`);
    if (APPLY) try {
      const svc = require("../services/access/accessGrantAdmin.service");
      // The actor must be a platform admin or the Accounting Owner. SOUMYA is
      // the Accounting Owner, so the grant is made on their authority.
      const actor = await svc.canonicalActorForEmail("soumyapraharaj.grav@gmail.com");
      const out = await svc.changeAppAccess({
        actor,
        body: {
          email: CEO,
          // The application KEY is "accountant" (accessGrantAdmin.service.js
          // `const ACCOUNTING = "accountant"`), matching the access_departments
          // slug. "accounting" is the display name and is NOT accepted — it
          // fails authorise() as an unknown application.
          application: "accountant",
          role: ROLE,
          reason: "Restoring Accounting access for the CEO; the account held no Accounting role so sign-in was refused.",
          idempotencyKey: `ceo-accountant-restore-${ROLE}-20261001b`,
        },
      });
      console.log("      result:", JSON.stringify(out?.outcome || out));
    } catch (e) {
      /* The first run sent application "accounting" and was refused here, but
         the failure aborted the whole script after step 1 had already written —
         so it looked like it had worked. Report and carry on to the verify
         block instead, so the outcome is never ambiguous again. */
      console.log(`      *** GRANT REFUSED: ${e.code || ""} ${e.message}`);
      if (e.details) console.log("      details:", JSON.stringify(e.details));
    }
  }

  /* ── verify ────────────────────────────────────────────────────────── */
  if (APPLY) {
    const org = await db.collection("acc_organizations").findOne({}, { projection: { tallyCompanyIds: 1 } });
    const ceo = await db.collection("acc_users").findOne({ email: CEO }, { projection: { role: 1, isActive: 1, organizationId: 1 } });
    console.log("\n=== AFTER ===");
    console.log("tallyCompanyIds:", (org.tallyCompanyIds || []).map(String));
    console.log("ceo@grav.in    :", ceo ? JSON.stringify({ role: ceo.role, isActive: ceo.isActive, org: String(ceo.organizationId) }) : "still none");
  } else console.log("\nDry run. Re-run with --apply to write.");

  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
