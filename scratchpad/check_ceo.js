const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {});
  const db = mongoose.connection.db;
  console.log("database:", db.databaseName);

  const org = await db.collection("acc_organizations").findOne({}, { projection: { name:1, tallyCompanyIds:1 } });
  console.log("\n[1] org", org.name, "tallyCompanyIds:", (org.tallyCompanyIds||[]).map(String));

  console.log("\n[2] acc_users rows:");
  const us = await db.collection("acc_users").find({}).project({email:1,name:1,role:1,isActive:1,loginMode:1,organizationId:1,passwordHash:1}).toArray();
  us.forEach(u=>console.log("   ", JSON.stringify({
    email:u.email, role:u.role, isActive:u.isActive,
    loginMode: u.loginMode===undefined?"(unset)":u.loginMode,
    org:String(u.organizationId||"(none)"), hasHash: !!u.passwordHash
  })));

  const ceo = us.find(u=>String(u.email).toLowerCase()==="ceo@grav.in");
  console.log("\n[3] ceo@grav.in acc_users row:", ceo ? "EXISTS" : "*** STILL MISSING ***");

  console.log("\n[4] recent access grant events:");
  try {
    const ev = await db.collection("access_grant_events").find({}).sort({_id:-1}).limit(5)
      .project({application:1,email:1,targetEmail:1,role:1,at:1,createdAt:1,outcome:1}).toArray();
    ev.forEach(e=>console.log("   ", JSON.stringify(e)));
  } catch(e){ console.log("   (none/err)", e.message); }

  await mongoose.disconnect();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
