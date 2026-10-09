/**
 * PUT A PRODUCT'S PATTERN WHERE IT BELONGS — from reviewed files, with a backup before every write.
 *
 *     node scripts/onboard/patternSetup.js apply-size <productRef> <sizeName> <sizePattern.json> [--dry-run]
 *         Replace ONE size's drawing and groups (and allowances, when the file has them) with a prepared record
 *         (e.g. the trouser's thigh and knee lines from grav-cad-desktop/tools/onboard/trouserLines.mjs). Everything
 *         else on the size and every other size is kept.
 *
 *     node scripts/onboard/patternSetup.js copy <fromRef> <toRef> [--size-file <sizePattern.json>] [--chart-file <chart.json>] [--dry-run]
 *         Give <toRef> the whole pattern of <fromRef>: every size row (drawing, groups, allowances, chart), the master
 *         size, the units. The target's own config is replaced (backed up first); its product record is not touched
 *         except to give it the measurement fields the pattern reads, when it has none. --size-file then replaces that
 *         size's drawing and groups in the copy (the blazer's M with its loosing).
 *
 *     node scripts/onboard/patternSetup.js remove-config <productRef> [--dry-run]
 *         Take a product's pattern config away (backed up first).
 *
 *     node scripts/onboard/patternSetup.js --restore <backup.json>
 *         Put a product's config back exactly as the backup holds it (or remove the one this script created).
 *
 * Every write first stores the product and its whole pattern config in scripts/onboard/backups/.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const BACKUPS = path.join(__dirname, "backups");
fs.mkdirSync(BACKUPS, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
/* a stored sub-document copied to another config must not carry its old ids */
const fresh = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "_id" || k === "__v" ? undefined : x)));

async function backupOf(item, label) {
  const config = await PatternGradingConfig.findOne({ stockItemId: item._id, isActive: true }).lean();
  const file = path.join(BACKUPS, `${item.reference}-${label}-${stamp()}.json`);
  const b = { takenAt: new Date().toISOString(), productRef: item.reference, stockItem: { _id: item._id, reference: item.reference, name: item.name, measurements: item.measurements }, config };
  if (!DRY) fs.writeFileSync(file, JSON.stringify(b, null, 1));
  console.log(`  backup ${item.reference} (${item.name}) config ${config ? config._id : "none"} -> ${DRY ? "(dry run)" : file}`);
  return { file, config };
}

async function product(ref) {
  const it = await StockItem.findOne({ reference: ref });
  if (!it) throw new Error(`no product ${ref}`);
  return it;
}

const SIZE_FIELDS = ["basePaths", "keyframeGroups", "seamEdges", "foldAxes", "unitsPerInch"];

async function applySize(ref, sizeName, file) {
  const item = await product(ref);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const sp = rec.sizePattern || rec;
  await backupOf(item, `before-apply-${sizeName}`);
  const config = await PatternGradingConfig.findOne({ stockItemId: item._id, isActive: true });
  if (!config) throw new Error(`${ref} has no pattern config`);
  const row = config.sizePatterns.find((p) => p.sizeName === sizeName);
  if (!row) throw new Error(`${ref} has no size ${sizeName}`);
  const changes = [];
  for (const f of SIZE_FIELDS) {
    if (sp[f] === undefined) continue;
    changes.push(`${f}: ${Array.isArray(row[f]) ? row[f].length : row[f]} -> ${Array.isArray(sp[f]) ? sp[f].length : sp[f]}`);
    row[f] = fresh(sp[f]);
  }
  config.markModified("sizePatterns");
  console.log(`  ${ref} ${sizeName}: ${changes.join(", ")}`);
  if (DRY) return;
  await config.save();
  /* read it back: what the routes will serve */
  const back = await PatternGradingConfig.findOne({ stockItemId: item._id, isActive: true }).lean();
  const r2 = back.sizePatterns.find((p) => p.sizeName === sizeName);
  console.log(`  saved. read back: ${r2.basePaths.length} paths, ${r2.keyframeGroups.length} groups, ${(r2.seamEdges || []).length} allowances, ${r2.keyframeGroups.filter((g) => g.loosingEnabled).length} with loosing`);
}

async function copy(fromRef, toRef, sizeFile) {
  const from = await product(fromRef), to = await product(toRef);
  const src = await PatternGradingConfig.findOne({ stockItemId: from._id, isActive: true }).lean();
  if (!src) throw new Error(`${fromRef} has no pattern config`);
  const { config: before } = await backupOf(to, "before-copy");
  const rows = fresh(src.sizePatterns);
  if (sizeFile) {
    const rec = JSON.parse(fs.readFileSync(sizeFile, "utf8"));
    const sp = rec.sizePattern || rec;
    const row = rows.find((r) => r.sizeName === sp.sizeName);
    if (!row) throw new Error(`the copy has no size ${sp.sizeName}`);
    for (const f of SIZE_FIELDS) if (sp[f] !== undefined) row[f] = fresh(sp[f]);
    if (sp.baseMeasurements) row.baseMeasurements = fresh(sp.baseMeasurements);
    console.log(`  ${sp.sizeName} taken from ${sizeFile}`);
  }
  /* --chart-file: every size's chart row (and the body size it is sold for) from a reviewed file */
  const chartFile = opt("--chart-file");
  if (chartFile) {
    const chart = JSON.parse(fs.readFileSync(chartFile, "utf8"));
    for (const row of rows) {
      const c = chart[row.sizeName];
      if (!c) continue;
      row.baseMeasurements = Object.fromEntries(Object.entries(c.baseMeasurements || c).map(([k, v]) => [String(k).toLowerCase(), Number(v)]));
      if (Number.isFinite(Number(c.sizeValue))) row.sizeValue = Number(c.sizeValue);
    }
    console.log(`  chart rows taken from ${chartFile}: ${rows.map((r) => `${r.sizeName} ${JSON.stringify(r.baseMeasurements)}`).join("; ")}`);
  }
  /* the whole config, as the source has it (yoke profile, piece roles, saved view and all), under the target's name */
  const { _id: _a, __v: _b, createdAt: _c, updatedAt: _d, stockItemId: _e, stockItemName: _f, stockItemReference: _g, ...rest } = src;
  const doc = {
    ...fresh(rest),
    stockItemId: to._id, stockItemName: to.name, stockItemReference: to.reference,
    sizePatterns: rows, isActive: true,
    patternDescription: `Pattern of ${fromRef} (${from.name}), placed ${new Date().toISOString().slice(0, 10)}`,
  };
  console.log(`  ${fromRef} -> ${toRef}: ${rows.length} size rows (${rows.map((r) => `${r.sizeName}:${(r.keyframeGroups || []).length}g`).join(" ")}), master ${doc.basePatternSize}`);
  if (DRY) return;
  if (before) {
    /* replaced whole, so nothing of the old pattern lingers beside the new one (the backup has all of it) */
    await PatternGradingConfig.replaceOne({ _id: before._id }, { ...doc, _id: before._id, createdAt: before.createdAt, updatedAt: new Date() });
  } else {
    const created = await PatternGradingConfig.create(doc);
    const rec = path.join(BACKUPS, `${to.reference}-created-config-${stamp()}.json`);
    fs.writeFileSync(rec, JSON.stringify({ productRef: to.reference, stockItemId: to._id, createdConfigId: created._id }, null, 1));
  }
  /* a product the pattern reads fields from must carry those fields */
  if (!(to.measurements || []).length && (from.measurements || []).length) {
    to.measurements = from.measurements;
    await to.save();
    console.log(`  ${toRef} given the measurement fields ${from.measurements.join(", ")}`);
  }
  const back = await PatternGradingConfig.findOne({ stockItemId: to._id, isActive: true }).lean();
  console.log(`  saved. read back: ${back.sizePatterns.length} sizes, master ${back.basePatternSize}: ${back.sizePatterns.find((r) => r.sizeName === back.basePatternSize)?.keyframeGroups.length} groups`);
}

async function removeConfig(ref) {
  const item = await product(ref);
  const { config } = await backupOf(item, "before-remove-config");
  if (!config) { console.log("  nothing to remove"); return; }
  if (DRY) return;
  await PatternGradingConfig.deleteOne({ _id: config._id });
  console.log(`  removed config ${config._id}`);
}

async function restore(file) {
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  if (b.config) {
    await PatternGradingConfig.replaceOne({ _id: b.config._id }, b.config, { upsert: true });
    console.log(`restored ${b.productRef} config ${b.config._id}`);
  } else {
    const r = await PatternGradingConfig.deleteMany({ stockItemId: b.stockItem._id });
    console.log(`${b.productRef} had no config before: removed ${r.deletedCount}`);
  }
  if (b.stockItem?.measurements) await StockItem.updateOne({ _id: b.stockItem._id }, { $set: { measurements: b.stockItem.measurements } });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const [cmd, a, b, c] = args.filter((x, i) => !x.startsWith("--") && !(i > 0 && ["--size-file", "--chart-file"].includes(args[i - 1])));
    if (args[0] === "--restore") await restore(args[1]);
    else if (cmd === "apply-size") await applySize(a, b, c);
    else if (cmd === "copy") await copy(a, b, opt("--size-file"));
    else if (cmd === "remove-config") await removeConfig(a);
    else throw new Error("usage: apply-size | copy | remove-config | --restore (see the top of this file)");
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
