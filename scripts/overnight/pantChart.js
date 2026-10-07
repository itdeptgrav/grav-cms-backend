/* READ-ONLY: every size row of the pant's chart, as stored. */
require("dotenv").config();
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const it = await StockItem.findOne({ reference: "PROD-BOT-EXETOMANTRO-1815" }).lean();
  const cfg = await PatternGradingConfig.findOne({ stockItemId: it._id }).lean();
  for (const sp of cfg.sizePatterns) console.log(sp.sizeName.padEnd(4), sp.sizeValue, JSON.stringify(sp.baseMeasurements || null));
  console.log("variants:", (it.variants || []).map((v) => `${(v.attributes || []).map((a) => a.name + "=" + a.value).join(",")}`).join(" | "));
  console.log("blazer variants:", JSON.stringify((await StockItem.findOne({ reference: "PROD-BLA-FROOFFBLA-733" }).lean()).variants.map((v) => ({ id: v._id, attrs: v.attributes, sku: v.sku }))));
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
