/* READ-ONLY: is there a sales user to attribute test orders to, and did the failed run leave anything behind? */
require("dotenv").config();
const mongoose = require("mongoose");
const SalesDepartment = require("../../models/SalesDepartment");
const Customer = require("../../models/Customer_Models/Customer");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("sales users:", await SalesDepartment.countDocuments(), "collection:", SalesDepartment.collection.name);
  const any = await mongoose.connection.db.collection(SalesDepartment.collection.name).find({}).limit(3).project({ name: 1, email: 1 }).toArray();
  console.log(any);
  const colls = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).filter((n) => /sales/i.test(n));
  console.log("sales-ish collections:", colls);
  for (const c of colls) console.log(c, await mongoose.connection.db.collection(c).countDocuments());
  console.log("test orgs:", (await Customer.find({ email: /^cadtest\./ }).select("email").lean()).map((c) => c.email));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
