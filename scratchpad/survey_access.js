const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {});
  const db = mongoose.connection.db;
  console.log("database:", db.databaseName);

  const depts = await db.collection("access_departments").find({}).project({slug:1,name:1,isActive:1}).toArray();
  const roles = await db.collection("departmentroles").find({}).project({departmentSlug:1,email:1,role:1,isActive:1}).toArray()
    .catch(async()=> db.collection("department_roles").find({}).project({departmentSlug:1,email:1,role:1,isActive:1}).toArray());

  console.log(`\n=== DepartmentRole rows: ${roles.length} ===`);
  const byDept = {};
  roles.forEach(r=>{ (byDept[r.departmentSlug] ||= []).push(`${r.email}:${r.role}${r.isActive===false?"(inactive)":""}`); });
  depts.sort((a,b)=>a.slug.localeCompare(b.slug)).forEach(d=>{
    const rs = byDept[d.slug] || [];
    console.log(`  ${d.slug.padEnd(28)} ${String(rs.length).padStart(2)}  ${rs.join(", ") || "— nobody"}`);
  });
  const orphan = Object.keys(byDept).filter(s=>!depts.find(d=>d.slug===s));
  if (orphan.length) console.log("  (slugs with roles but no department row:", orphan.join(", "), ")");

  console.log("\n=== identity stores ===");
  for (const [label, coll] of [["dept_users",'dept_users'],["employees (active)",'employees'],["acc_users",'acc_users']]) {
    const n = coll==='employees'
      ? await db.collection(coll).countDocuments({status:"active"})
      : await db.collection(coll).countDocuments({});
    console.log(`  ${label.padEnd(20)} ${n}`);
  }
  await mongoose.disconnect();
})().catch(e=>{console.error("ERR",e.message);process.exit(1)});
