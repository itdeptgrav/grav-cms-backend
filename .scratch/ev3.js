require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const svc = require("../services/industrialEngineering/ieDevelopment.service");
  const d = await svc.readDevelopment({ companyId: "6a08040a1fecacc9bb7149c2", role: "editor" },
    { styleId: "6ab24e5c2935295bc82db1ad" });
  console.log("=== NW-POLO-26 ===");
  console.log(JSON.stringify({ images: d.evidence.images, documents: d.evidence.documents }, null, 1).slice(0, 1400));
  const db = mongoose.connection.db;
  const st = await db.collection("samplestyles").findOne({ _id: new mongoose.Types.ObjectId("6ab2707f75b77ae4b311600d") }, { projection: { sourceStockItemId: 1 } });
  const pr = st?.sourceStockItemId && await db.collection("stockitems").findOne({ _id: st.sourceStockItemId }, { projection: { name: 1, images: 1 } });
  console.log("\nTEE-SS-01 product:", pr && { name: pr.name, images: (pr.images || []).length });
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
