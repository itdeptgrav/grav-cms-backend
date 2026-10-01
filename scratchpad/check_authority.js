const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {});
  const svc = require("../services/access/accessGrantAdmin.service");
  const { resolveAppAccess, isVerifiedPlatformAdmin } = require("../services/access/appAccess.service");

  for (const who of ["soumyapraharaj.grav@gmail.com", "ceo@grav.in"]) {
    try {
      const actor = await svc.canonicalActorForEmail(who);
      const acc = await resolveAppAccess(actor, "accountant", { requireCatalogueEntry: true });
      const admin = await isVerifiedPlatformAdmin(actor);
      console.log(`${who}\n   subject=${actor.subject} allowed=${acc.allowed} role=${acc.role} denial=${acc.denialCode||"-"} platformAdmin=${admin}`);
      console.log(`   => may grant Accounting? ${(acc.allowed && acc.role === "owner") ? "YES" : "NO"}`);
    } catch (e) { console.log(`${who}\n   ERR ${e.code||""} ${e.message}`); }
  }
  await mongoose.disconnect();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
