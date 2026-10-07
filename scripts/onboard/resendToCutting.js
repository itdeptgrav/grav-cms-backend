/**
 * SEND A PRODUCT'S TEST WORK ORDERS TO CUTTING AGAIN — what pressing "Send to cutting" on the web does.
 *
 *     node scripts/onboard/resendToCutting.js scripts/onboard/manifests/<productRef>.json [...]
 *
 * The desk pulls only work orders sent or changed since its last pull, and changing a product's pattern config does
 * not change its work orders. After a master is re-uploaded this marks them sent again, so the desk's next pull
 * carries the new pattern. Touches only the work orders named in the manifest.
 */
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  for (const file of process.argv.slice(2)) {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    const ids = m.workOrders.map((w) => w.id);
    const r = await WorkOrder.updateMany({ _id: { $in: ids } }, { $set: { sentToCutting: true, sentToCuttingAt: new Date() } });
    console.log(`${m.productRef}: ${r.modifiedCount} work order(s) sent to cutting again`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
