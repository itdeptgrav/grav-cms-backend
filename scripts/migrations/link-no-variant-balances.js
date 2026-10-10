// scripts/migrations/link-no-variant-balances.js
//
// LINK "NO VARIANT" SHELF ROWS TO THE ITEM'S ONLY VARIANT (3 Oct 2026, owner).
//
// Stock put on a shelf before a variant was chosen sits at item grain
// (`variantId: null`) in `location_balances` and `location_movements`. The
// map's shelf panel then prints "No variant" — and, where the same item was
// later put away under its variant, the same product twice on one shelf
// (e.g. "Lock Pin — No variant 7965" above "Lock Pin — Default 500").
//
// For every item that has EXACTLY ONE variant, this script:
//   · sets the variant on each null-variant balance row (location rows and
//     the assigned-total sentinel alike); where a row for that variant already
//     exists at the same place, it ADDS the on-hand into it and removes the
//     null row, so nothing is lost and nothing is doubled;
//   · sets the variant on each null-variant movement row, so the derived
//     sticker-grain figures and the item/variant histories agree.
// An item with NO variants is left alone (it truly has none). An item with
// SEVERAL variants is REPORTED and left alone: nobody can tell which one.
//
//   node -r dotenv/config scripts/migrations/link-no-variant-balances.js          # dry run
//   node -r dotenv/config scripts/migrations/link-no-variant-balances.js --apply  # write
//
// Run it against the database the CMS actually reads (MONGODB_URI in .env).

require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const balances = db.collection("location_balances");
  const movements = db.collection("location_movements");

  const nullRows = await balances.find({ variantId: null }).toArray();
  const itemIds = [...new Set(nullRows.map((r) => String(r.itemId)))].map((s) => new mongoose.Types.ObjectId(s));
  const items = await db.collection("rawitems").find({ _id: { $in: itemIds } }, { projection: { name: 1, "variants._id": 1, "variants.combination": 1 } }).toArray();
  const byItem = new Map(items.map((i) => [String(i._id), i]));

  const out = { linked: 0, merged: 0, movements: 0, noVariant: 0, several: new Set(), missing: 0 };

  for (const row of nullRows) {
    const it = byItem.get(String(row.itemId));
    if (!it) { out.missing += 1; continue; }
    const variants = it.variants || [];
    if (variants.length === 0) { out.noVariant += 1; continue; }
    if (variants.length > 1) { out.several.add(`${it.name} (${variants.length} variants)`); continue; }
    const variantId = variants[0]._id;
    const where = { companyId: row.companyId, itemId: row.itemId, variantId, warehouseId: row.warehouseId ?? null, locationId: row.locationId ?? null };
    const existing = await balances.findOne(where);
    const place = row.locationId ? String(row.locationId) : "assigned-total";
    if (existing) {
      out.merged += 1;
      console.log(`${APPLY ? "MERGE" : "would merge"}  ${it.name} @ ${place}: ${r4(row.onHand)} into ${r4(existing.onHand)} → ${r4(existing.onHand + row.onHand)}`);
      if (APPLY) {
        await balances.updateOne({ _id: existing._id }, { $set: { onHand: r4(existing.onHand + row.onHand) } });
        await balances.deleteOne({ _id: row._id });
      }
    } else {
      out.linked += 1;
      console.log(`${APPLY ? "LINK " : "would link "} ${it.name} @ ${place}: ${r4(row.onHand)} → variant "${variants[0].combination.join(" · ")}"`);
      if (APPLY) await balances.updateOne({ _id: row._id }, { $set: { variantId } });
    }
  }

  /* movements: the same rule, so every derived figure keys the same way */
  const nullMoves = await movements.find({ variantId: null }).toArray();
  const moveItemIds = [...new Set(nullMoves.map((m) => String(m.itemId)))].filter((s) => !byItem.has(s)).map((s) => new mongoose.Types.ObjectId(s));
  if (moveItemIds.length) for (const i of await db.collection("rawitems").find({ _id: { $in: moveItemIds } }, { projection: { name: 1, "variants._id": 1, "variants.combination": 1 } }).toArray()) byItem.set(String(i._id), i);
  for (const m of nullMoves) {
    const it = byItem.get(String(m.itemId));
    const variants = it?.variants || [];
    if (variants.length !== 1) { if (variants.length > 1) out.several.add(`${it.name} (${variants.length} variants)`); continue; }
    out.movements += 1;
    if (APPLY) await movements.updateOne({ _id: m._id }, { $set: { variantId: variants[0]._id } });
  }

  console.log(`\n${APPLY ? "Applied" : "Dry run"} — balance rows linked: ${out.linked}, merged into an existing variant row: ${out.merged}, movement rows linked: ${out.movements}, items with no variant (left): ${out.noVariant}, unknown items: ${out.missing}`);
  if (out.several.size) console.log("Left alone — several variants, cannot choose:\n  " + [...out.several].join("\n  "));
  if (!APPLY) console.log("\nNothing was written. Re-run with --apply to write.");
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
