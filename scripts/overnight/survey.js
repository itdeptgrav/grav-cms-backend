/* READ-ONLY survey: which products could carry the blazer and the pant, and what pattern data each already has. */
require("dotenv").config();
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("DB:", mongoose.connection.name);
  const re = /coat|blazer|jacket|suit|pant|trouser|bandh|waistcoat/i;
  const items = await StockItem.find({ $or: [{ name: re }, { category: re }] })
    .select("name reference category measurements variants createdAt").lean();
  console.log(`\n${items.length} candidate products\n`);
  for (const it of items) {
    const cfg = await PatternGradingConfig.findOne({ stockItemId: it._id }).lean();
    const sps = cfg?.sizePatterns || [];
    const groups = sps.reduce((a, s) => a + (s.keyframeGroups?.length || 0), 0);
    const svgs = sps.filter((s) => s.basePaths?.length || s.svgFileUrl).length;
    const wos = await WorkOrder.countDocuments({ stockItemId: it._id });
    console.log(`${(it.reference || "").padEnd(28)} ${String(it.name).slice(0, 34).padEnd(34)} cat=${String(it.category || "").slice(0, 14).padEnd(14)}`
      + ` meas=[${(it.measurements || []).join(",")}]`.slice(0, 90)
      + ` | sizes=${sps.length} svgs=${svgs} groups=${groups} WOs=${wos}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
