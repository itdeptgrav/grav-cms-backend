/*  ONE-OFF REPAIR — attach the orphaned company to the GRAV organisation.
 *
 *  DRY RUN BY DEFAULT. It prints what it would do and writes nothing.
 *  Pass --apply to actually write.
 *
 *  It writes exactly ONE field: Acc_Organization.tallyCompanyIds, via the
 *  canonical writer (attachCompaniesToOrganization, $addToSet — idempotent,
 *  refuses a company another organisation already owns).
 *  It creates nothing, deletes nothing, and touches no other document.
 */
const mongoose = require("mongoose");

(async () => {
  const APPLY = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI, {});
  const db = mongoose.connection.db;
  console.log("database:", db.databaseName, APPLY ? "— APPLYING" : "— DRY RUN (no writes)");

  const orgs = await db.collection("acc_organizations").find({}).project({ name: 1, tallyCompanyIds: 1 }).toArray();
  const cos = await db.collection("acc_companies").find({ isActive: true }).project({ companyName: 1, isPrimary: 1 }).toArray();

  if (orgs.length !== 1) {
    console.log(`REFUSING: expected exactly 1 organisation, found ${orgs.length}. Decide by hand.`);
    return mongoose.disconnect();
  }
  const org = orgs[0];
  const owned = new Set((org.tallyCompanyIds || []).map(String));
  const missing = cos.filter((c) => !owned.has(String(c._id)));

  console.log(`\norganisation: ${org.name} (${org._id}) currently owns ${owned.size} company(ies)`);
  console.log(`active companies in the books: ${cos.length}`);
  missing.forEach((c) => console.log(`   WOULD ATTACH -> ${c.companyName} (${c._id})${c.isPrimary ? " [primary]" : ""}`));
  if (!missing.length) { console.log("   nothing to attach — already consistent."); return mongoose.disconnect(); }

  if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); return mongoose.disconnect(); }

  const { attachCompaniesToOrganization } = require("../services/accountantCompanyOwnership.service");
  const result = await attachCompaniesToOrganization({
    organizationId: org._id,
    companyIds: missing.map((c) => c._id),
  });
  console.log("\nresult:", JSON.stringify(result));

  const after = await db.collection("acc_organizations").findOne({ _id: org._id }, { projection: { tallyCompanyIds: 1 } });
  console.log("tallyCompanyIds now:", (after.tallyCompanyIds || []).map(String));
  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
