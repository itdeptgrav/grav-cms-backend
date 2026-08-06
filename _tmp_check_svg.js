require("dotenv").config({ path: "C:/Users/soumy/Desktop/grav-cms-backend/.env" });
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const PatternGradingConfig = require("C:/Users/soumy/Desktop/grav-cms-backend/models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");

  const pgc = await PatternGradingConfig.findOne({ stockItemId: "69bbcb3d1c32e4f8d5b30a46" }).lean();
  if (!pgc) { console.log("not found"); return; }

  for (const sp of pgc.sizePatterns || []) {
    const bp = sp.basePaths;
    const hasBasePaths = Array.isArray(bp) && bp.length > 0;
    let pathCount = null, segCounts = null, totalSegs = null;
    if (hasBasePaths) {
      pathCount = bp.length;
      segCounts = bp.map(p => (p.segs || []).length);
      totalSegs = segCounts.reduce((a,b)=>a+b,0);
    }
    console.log(`${sp.sizeName} (chest=${sp.baseMeasurements?.chest}) — hasBasePaths=${hasBasePaths}, pathCount=${pathCount}, totalSegs=${totalSegs}, segCounts=${JSON.stringify(segCounts)}`);
  }

  // Check keyframeGroups ref1/ref2 consistency across sizes (same pi/si would mean same topology)
  console.log("\n--- ref1/ref2 for ChestFront group per size (if present) ---");
  for (const sp of pgc.sizePatterns || []) {
    const g = (sp.keyframeGroups || []).find(g => (g.groupName||g.name||"").toLowerCase().includes("chestfront"));
    console.log(sp.sizeName, g ? { ref1: g.ref1, ref2: g.ref2, gradingMode: g.gradingMode } : "no ChestFront group on this size");
  }

  await mongoose.disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
