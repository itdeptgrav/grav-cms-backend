// scripts/cleanup_dangling_assignments.js
//
// Removes Customer.assignedStockItems rows whose StockItem no longer exists.
//
// WHY THESE EXIST. Until 26 Aug 2026 `DELETE /api/cms/stock-items/:id` deleted
// the product and left every customer assignment pointing at it. Mongoose
// `populate` resolves a dangling reference to `null` rather than leaving the
// raw ObjectId, so those rows reached the UI as products with no id: nameless,
// impossible to add to an order, and — where a customer had more than one —
// colliding on a `null` React key, which is the "Encountered two children with
// the same key, `null`" error in components/sales/SizeWiseBulkOrderSlider.js.
//
// The delete route now unassigns on the way out and both read routes filter
// what is left, so this script is a ONE-OFF for the historic rows. It is
// idempotent — safe to re-run, and a no-op once clean.
//
// Run from grav-backend/ so it picks up .env:
//   node -r dotenv/config scripts/cleanup_dangling_assignments.js          (report only)
//   node -r dotenv/config scripts/cleanup_dangling_assignments.js --apply  (write)
//
// TOUCHES THE LIVE DATABASE. It only ever $pulls assignment rows whose
// referenced StockItem is confirmed absent; it never deletes a customer, a
// stock item, or an assignment whose product still exists.

require("dotenv/config");
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Customer = require("../models/Customer_Models/Customer");
  const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");

  const customers = await Customer.find({ "assignedStockItems.0": { $exists: true } })
    .select("name customerId assignedStockItems")
    .lean();

  let totalDangling = 0;
  let customersTouched = 0;

  for (const c of customers) {
    const rows = c.assignedStockItems || [];
    const ids = rows.map((a) => a.stockItemId).filter(Boolean);
    const alive = new Set(
      (await StockItem.find({ _id: { $in: ids } }).select("_id").lean()).map((s) => String(s._id)),
    );
    // Both shapes count as dangling: a row with no id at all, and one whose
    // id no longer resolves to a product.
    const dangling = rows.filter((a) => !a.stockItemId || !alive.has(String(a.stockItemId)));
    if (!dangling.length) continue;

    totalDangling += dangling.length;
    customersTouched += 1;
    console.log(`${c.name} (${c.customerId || c._id}) — ${dangling.length} of ${rows.length} dangling:`);
    for (const d of dangling) {
      console.log(`    ${d.stockItemId || "(no id)"}  "${d.stockItemName || ""}"  ${d.stockItemReference || ""}`);
    }

    if (APPLY) {
      const keep = rows.filter((a) => a.stockItemId && alive.has(String(a.stockItemId)));
      await Customer.updateOne({ _id: c._id }, { $set: { assignedStockItems: keep } });
      console.log(`    -> kept ${keep.length}`);
    }
  }

  console.log(
    `\n${totalDangling} dangling assignment(s) across ${customersTouched} customer(s) ` +
    `(of ${customers.length} with assignments).`,
  );
  if (!APPLY && totalDangling) console.log("Report only — re-run with --apply to remove them.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
