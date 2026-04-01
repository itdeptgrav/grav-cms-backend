// fix-propagation.js
// 1. Fixes UPI 25.4 → 72
// 2. Removes ALL propagated keyframes (kf-prop-*) so they re-create
//    with correct position-based node mapping
// Run: node fix-propagation.js

require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Set MONGODB_URI in .env"); process.exit(1); }

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log("Connected\n");

    const col = mongoose.connection.collection("patterngradingconfigs");
    const configs = await col.find({ "sizePatterns.0": { $exists: true } }).toArray();

    let upiFixed = 0, kfsRemoved = 0;

    for (const config of configs) {
        let modified = false;
        for (const sp of config.sizePatterns) {
            if (sp.unitsPerInch && Math.abs(sp.unitsPerInch - 25.4) < 0.01) {
                sp.unitsPerInch = 72;
                upiFixed++;
                modified = true;
            }
            if (sp.keyframeGroups) {
                for (const grp of sp.keyframeGroups) {
                    if (!grp.keyframes?.length) continue;
                    const before = grp.keyframes.length;
                    grp.keyframes = grp.keyframes.filter(kf => !String(kf.id || kf.clientId || "").startsWith("kf-prop-"));
                    const removed = before - grp.keyframes.length;
                    if (removed > 0) { kfsRemoved += removed; modified = true; }
                }
            }
        }
        if (modified) {
            await col.updateOne({ _id: config._id }, { $set: { sizePatterns: config.sizePatterns } });
        }
    }

    console.log(`Fixed ${upiFixed} UPI, removed ${kfsRemoved} propagated KFs`);
    console.log("Now open 3XS in the designer and Ctrl+S to re-propagate correctly.\n");
    await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });