/* READ-ONLY: what the two likely targets already carry, so nothing real is overwritten. */
require("dotenv").config();
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  for (const ref of ["PROD-BOT-EXETOMANTRO-1815", "PROD-BLA-FROOFFBLA-733", "PROD-OUT-BANGALCOA-7049"]) {
    const it = await StockItem.findOne({ reference: ref }).lean();
    if (!it) { console.log(ref, "not found"); continue; }
    console.log(`\n=== ${ref}  ${it.name}  id=${it._id}  category=${it.category}`);
    console.log("  measurements:", JSON.stringify(it.measurements), " variants:", (it.variants || []).length,
      " sizes:", (it.variants || []).map((v) => (v.attributes || []).map((a) => a.value).join("/")).join(", ").slice(0, 160));
    const cfg = await PatternGradingConfig.findOne({ stockItemId: it._id }).lean();
    if (cfg) {
      console.log(`  config: designatedGroup=${cfg.designatedGroup} setupCompleted=${cfg.setupCompleted} svgFile=${cfg.svgFileName || cfg.originalFilename || "-"}`);
      for (const sp of cfg.sizePatterns || []) {
        const paths = sp.basePaths || [];
        const xs = [], ys = [];
        for (const p of paths) for (const s of p.segs || []) if (Number.isFinite(s.x)) { xs.push(s.x); ys.push(s.y); }
        const ext = xs.length ? `${((Math.max(...xs) - Math.min(...xs)) / (sp.unitsPerInch || 72)).toFixed(1)}x${((Math.max(...ys) - Math.min(...ys)) / (sp.unitsPerInch || 72)).toFixed(1)}in` : "-";
        console.log(`  size ${String(sp.sizeName).padEnd(4)} file=${String(sp.originalFilename || "-").slice(0, 34).padEnd(34)} paths=${String(paths.length).padStart(3)} upi=${sp.unitsPerInch} extent=${ext}`
          + ` groups=${(sp.keyframeGroups || []).length} seams=${(sp.seamEdges || []).length} base=${JSON.stringify(sp.baseMeasurements || {}).slice(0, 80)}`);
      }
      const m = (cfg.sizePatterns || []).find((s) => s.sizeName === "M");
      if (m) console.log("  M group names:", (m.keyframeGroups || []).map((g) => g.groupName || g.name).join(" | ").slice(0, 400));
    } else console.log("  config: none");
    const wos = await WorkOrder.find({ stockItemId: it._id }).select("workOrderNumber status customerName quantity createdAt").lean();
    for (const w of wos) console.log(`  WO ${w.workOrderNumber} status=${w.status} qty=${w.quantity} customer=${w.customerName} created=${w.createdAt?.toISOString?.().slice(0, 10)}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
