/**
 * A NEW PRODUCT FOR A NEW DRAWING, MADE THE WAY THE WEBSITE'S "CLONE" MAKES ONE.
 *
 *     node scripts/onboard/createProduct.js <fromReference> "<New name>" [--ref PROD-XXX-YYY-NNN] [--dry-run]
 *
 * Copies an existing product (its category, unit, attributes, variants, measurement fields, operations) under a new
 * name and reference, exactly as POST /stock-items/:id/clone does, with no pattern config: the pattern is stored on it
 * afterwards by onboardProduct.js. Writes a record of what it created to scripts/onboard/backups/ so `--delete <file>`
 * can take it away again.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const refArg = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : null;
const BACKUPS = path.join(__dirname, "backups");
fs.mkdirSync(BACKUPS, { recursive: true });

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (args[0] === "--delete") {
    const rec = JSON.parse(fs.readFileSync(args[1], "utf8"));
    const r = await StockItem.deleteOne({ _id: rec.createdId, reference: rec.reference });
    console.log(`deleted ${rec.reference}: ${r.deletedCount}`);
    await mongoose.disconnect(); return;
  }
  const [fromRef, newName] = args.filter((a) => !a.startsWith("--") && a !== refArg);
  const original = await StockItem.findOne({ reference: fromRef });
  if (!original) throw new Error(`no product ${fromRef}`);
  const nameCode = newName.trim().split(" ").map((w) => w.substring(0, 3).toUpperCase()).join("");
  const categoryCode = (original.category || "CAT").substring(0, 3).toUpperCase();
  const reference = (refArg || `PROD-${categoryCode}-${nameCode}-${Math.floor(Math.random() * 900 + 100)}`).toUpperCase();
  if (await StockItem.findOne({ reference })) throw new Error(`${reference} already exists`);
  if (await StockItem.findOne({ name: newName })) throw new Error(`a product named "${newName}" already exists`);
  const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");
  const doc = {
    name: newName, additionalNames: [], reference, productType: original.productType,
    category: original.category, unit: original.unit, hsnCode: original.hsnCode,
    genderCategory: original.genderCategory || "", internalNotes: `Pattern: second blazer drawing (jacket.svg). Made from ${fromRef}.`,
    baseSalesPrice: original.baseSalesPrice, baseCost: original.baseCost,
    attributes: original.attributes, measurements: original.measurements,
    numberOfPanels: original.numberOfPanels,
    variants: original.variants.map((v, i) => ({
      sku: `${reference}-V${String(i + 1).padStart(3, "0")}`, attributes: v.attributes, quantityOnHand: 0,
      minStock: v.minStock, maxStock: v.maxStock, cost: v.cost, salesPrice: v.salesPrice,
      barcode: `${barcode}-${String(i + 1).padStart(3, "0")}`, images: v.images, rawItems: v.rawItems, status: v.status,
    })),
    operations: original.operations, miscellaneousCosts: original.miscellaneousCosts, images: original.images,
    createdBy: original.createdBy,
  };
  console.log(`${DRY ? "[dry run] would create" : "creating"} "${newName}" ${reference} (category ${doc.category}, ${doc.variants.length} variants, measurements ${(doc.measurements || []).join(", ")}) from ${fromRef}`);
  if (DRY) { await mongoose.disconnect(); return; }
  const item = new StockItem(doc);
  await item.save();
  const recFile = path.join(BACKUPS, `${reference}-created-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(recFile, JSON.stringify({ createdId: item._id, reference, name: newName, from: fromRef }, null, 1));
  console.log(`created ${reference} (${item._id}); record ${recFile}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
