/* READ-ONLY: the pant's stored groups per size, so I can see what M already carries. */
require("dotenv").config();
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const it = await StockItem.findOne({ reference: process.argv[2] || "PROD-BOT-EXETOMANTRO-1815" }).lean();
  const cfg = await PatternGradingConfig.findOne({ stockItemId: it._id }).lean();
  const top = Object.fromEntries(Object.entries(cfg).filter(([k]) => k !== "sizePatterns"));
  console.log("config top-level:", JSON.stringify(top, null, 0).slice(0, 3000));
  for (const sp of cfg.sizePatterns || []) {
    if (!["M", "L"].includes(sp.sizeName)) continue;
    console.log(`\n--- ${sp.sizeName} keys:`, Object.keys(sp).join(","));
    console.log("  svgFileId", sp.svgFileId, "file", sp.originalFilename, "upi", sp.unitsPerInch, "verification", JSON.stringify(sp.verification || sp.gateStatus || null));
    for (const g of sp.keyframeGroups || []) {
      console.log("  G", JSON.stringify({ name: g.groupName || g.name, part: g.part || g.partKey || g.measurementKey, mult: g.multiplier, mode: g.measureMode, sem: g.semanticId, r1: g.ref1, r2: g.ref2, kind: g.measurementType, off: g.measurementOffset, trav: g.boundaryTraversal, id: g.id || g._id }).slice(0, 600));
    }
    console.log("  connectors:", (sp.connectors || []).length, " seams:", (sp.seamEdges || []).length, " baseMeasurements:", JSON.stringify(sp.baseMeasurements));
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
