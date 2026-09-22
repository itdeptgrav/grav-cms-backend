require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const STOCK = "69bbcb3d1c32e4f8d5b30a46";
const S = "C:/Users/soumy/AppData/Local/Temp/claude/C--Users-soumy-Desktop-newpatternGradding/9e24f581-6345-43e9-b9c5-6696ecc7b03a/scratchpad/";
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const cfg = await db.collection("patterngradingconfigs")
    .findOne({ stockItemId: new mongoose.Types.ObjectId(STOCK), isActive: true }, { sort: { updatedAt: -1 } });
  fs.writeFileSync(S + "allSizes.json", JSON.stringify(cfg.sizePatterns, null, 1));
  for (const sp of cfg.sizePatterns) {
    const bm = sp.baseMeasurements || {};
    console.log(`${String(sp.sizeName).padEnd(4)} paths=${(sp.basePaths||[]).length} groups=${(sp.keyframeGroups||[]).length}  chest=${bm.Chest} stomach=${bm.Stomach} hem=${bm["Bottom hem"]} len=${bm.Length} sh=${bm.Shoulder} col=${bm.Coller}`);
  }
  await mongoose.disconnect();
})().catch(e=>{console.error(e);process.exit(1);});
