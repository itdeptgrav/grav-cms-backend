const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {});
  const db = mongoose.connection.db;
  const names = (await db.listCollections().toArray()).map(c=>c.name);
  console.log("collections matching role/dept:", names.filter(n=>/role|dept/i.test(n)).join(", "));

  const roles = await db.collection("department_roles").find({}).project({departmentSlug:1,email:1,role:1,isActive:1}).toArray();
  console.log(`\n=== department_roles: ${roles.length} rows ===`);
  const byDept = {};
  roles.forEach(r=>{ (byDept[r.departmentSlug] ||= []).push(`${r.email}:${r.role}${r.isActive===false?"(OFF)":""}`); });
  Object.keys(byDept).sort().forEach(s=>console.log(`  ${s.padEnd(26)} ${byDept[s].join(", ")}`));

  console.log("\n=== acc_users now ===");
  const us = await db.collection("acc_users").find({}).project({email:1,role:1,isActive:1,loginMode:1}).toArray();
  us.forEach(u=>console.log("  ", u.email, "|", u.role, "| active", u.isActive, "| loginMode", u.loginMode===undefined?"(unset)":u.loginMode));

  await mongoose.disconnect();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
