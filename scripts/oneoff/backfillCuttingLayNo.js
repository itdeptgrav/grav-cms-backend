/* Give every cutting season without a lay number its order's number (17 Oct 2026):
   seasons of an order counted 1, 2, 3 … in the order they were created. Writes plan.layNo only. */
require("dotenv").config();
const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const CuttingSeason = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");
  const seasons = await CuttingSeason.find({ deletedAt: null, plan: { $ne: null } }).sort({ createdAt: 1 }).select("_id name plan.layNo plan.lines.moId lays.layNo").lean();
  const seen = new Map();
  let set = 0;
  for (const s of seasons) {
    const mos = [...new Set((s.plan?.lines || []).map((x) => String(x.moId || "")).filter(Boolean))];
    if (!mos.length) continue;
    const n = Math.max(...mos.map((m) => (seen.get(m) || 0) + 1));
    mos.forEach((m) => seen.set(m, n));
    if (String(s.plan?.layNo || "").trim()) continue;
    await CuttingSeason.updateOne({ _id: s._id }, { $set: { "plan.layNo": String(n) } });
    set += 1; console.log(`${s.name} → lay ${n}`);
  }
  console.log(`done: ${set} season(s) numbered`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
