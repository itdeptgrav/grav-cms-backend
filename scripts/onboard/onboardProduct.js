/**
 * PUT A PREPARED MASTER INTO A PRODUCT — what a designer does in the editor, done from a reviewed file.
 *
 *     node scripts/onboard/onboardProduct.js <prepared.json> [--dry-run]
 *     node scripts/onboard/onboardProduct.js --restore <backup.json>
 *
 * The prepared file comes from grav-cad-desktop/tools/onboard/prepare.mjs, which reads the SVG with the editor's own
 * parser and builds every group, allowance and chart row offline, where it can be looked at before anything is
 * written. This script only stores it, the way the routes store it:
 *
 *   - the SVG goes to Google Drive through the same helper the upload route calls (only if the master size has no
 *     file yet — an SVG the designer already uploaded is kept as it is)
 *   - the master size gets the geometry, groups, allowances and chart row the editor-state route would have saved
 *   - every other chart size gets its row; a size that already has a drawing keeps it untouched
 *   - the config records the garment type, the V3 engine and which size is the master
 *   - a product with no measurement fields is given the chart's fields
 *
 * BEFORE ANY OF THAT, the product and its whole pattern config are written to scripts/onboard/backups/, and
 * `--restore` puts them back exactly.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const PatternGradingConfig = require("../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const BACKUPS = path.join(__dirname, "backups");
fs.mkdirSync(BACKUPS, { recursive: true });

const lowerKeys = (row) => Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [String(k).toLowerCase(), v]));

async function restore(file) {
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const item = await StockItem.findById(b.stockItem._id);
  item.measurements = b.stockItem.measurements;
  await item.save();
  if (b.config) {
    await PatternGradingConfig.replaceOne({ _id: b.config._id }, b.config);
  } else {
    await PatternGradingConfig.deleteMany({ stockItemId: b.stockItem._id, _id: { $in: b.createdConfigIds || [] } });
  }
  console.log(`restored ${b.stockItem.reference} from ${file}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (args[0] === "--restore") { await restore(args[1]); await mongoose.disconnect(); return; }

  const rec = JSON.parse(fs.readFileSync(args[0], "utf8"));
  const item = await StockItem.findOne({ reference: rec.productRef });
  if (!item) throw new Error(`no product ${rec.productRef}`);
  let config = await PatternGradingConfig.findOne({ stockItemId: item._id, isActive: true });

  /* ── the backup, before anything else ── */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(BACKUPS, `${rec.productRef}-${stamp}.json`);
  const backup = {
    takenAt: new Date().toISOString(), productRef: rec.productRef,
    stockItem: { _id: item._id, reference: item.reference, measurements: item.measurements },
    config: config ? config.toObject() : null,
  };
  if (!DRY) fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
  console.log(`${rec.productRef} (${item.name})  config ${config ? config._id : "none yet"}  backup -> ${DRY ? "(dry run)" : backupFile}`);

  const master = rec.masterSize;
  const keyField = rec.designatedGroup;                 /* "chest" / "waist": also the size value the rows sort by */
  const fieldOf = (row, f) => row[Object.keys(row).find((k) => k.toLowerCase() === f.toLowerCase())];

  /* ── the SVG: keep the designer's own upload; otherwise upload the file the master was prepared from ── */
  let file = null;
  const existingMaster = config?.sizePatterns?.find((p) => p.sizeName === master);
  if (existingMaster?.svgPublicId) {
    file = { url: existingMaster.svgFileUrl, fileId: existingMaster.svgPublicId, name: existingMaster.originalFilename, bytes: existingMaster.bytes };
    console.log(`  master SVG already uploaded: ${file.name} (${file.fileId}) — kept`);
  } else {
    const svgPath = path.join(path.dirname(args[0]), "..", "work", rec.svgFile);
    const buffer = fs.readFileSync(svgPath);
    if (DRY) {
      file = { url: "(dry run)", fileId: "(dry run)", name: rec.svgFile, bytes: buffer.length };
    } else {
      const { uploadPatternToDrive } = require("../../utils/googleDrivePatternUpload");
      const up = await uploadPatternToDrive(buffer, rec.svgFile, "image/svg+xml", String(item._id), master, item.name);
      file = { url: up.url, fileId: up.fileId, name: rec.svgFile, bytes: buffer.length };
    }
    console.log(`  master SVG uploaded: ${file.name} -> ${file.fileId}`);
  }

  /* ── the config ── */
  if (!config) {
    config = new PatternGradingConfig({ stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference, isActive: true, sizePatterns: [] });
    backup.createdConfigIds = [config._id];
    if (!DRY) fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
  }
  config.garmentType = rec.garmentType;
  config.patternEngineVersion = "V3";
  config.basePatternSize = master;
  config.designatedGroup = keyField;
  config.unitsPerInch = 25.4;
  config.setupCompleted = true;
  const custom = [...(config.customMeasurements || []).map((c) => (c.toObject ? c.toObject() : c))];
  for (const c of rec.customMeasurements) if (!custom.some((x) => x.key === c.key)) custom.push(c);
  config.customMeasurements = custom;
  config.markModified("customMeasurements");

  /* the master size: everything the editor-state route would have saved */
  const mRow = rec.chart[master];
  const mPattern = {
    ...(existingMaster ? (existingMaster.toObject ? existingMaster.toObject() : existingMaster) : {}),
    sizeName: master,
    sizeValue: Number(fieldOf(mRow, keyField)),
    svgFileUrl: file.url, svgPublicId: file.fileId, originalFilename: file.name, bytes: file.bytes,
    basePaths: rec.basePaths,
    unitsPerInch: 25.4,
    keyframeGroups: rec.groups,
    seamEdges: rec.seamEdges,
    foldAxes: [],
    groupsSetupCompleted: true,
    baseMeasurements: lowerKeys(mRow),
  };
  const idx = config.sizePatterns.findIndex((p) => p.sizeName === master);
  if (idx >= 0) config.sizePatterns[idx] = mPattern; else config.sizePatterns.push(mPattern);

  /* every other chart row: added when missing; a chart-only size (no drawing) gets the prepared row; a size with its
     own drawing is never written to — its numbers belong to that drawing */
  for (const [size, row] of Object.entries(rec.chart)) {
    if (size === master) continue;
    const at = config.sizePatterns.findIndex((p) => p.sizeName === size);
    if (at >= 0) {
      const sp = config.sizePatterns[at];
      if (!(sp.basePaths || []).length) {
        sp.baseMeasurements = lowerKeys(row);
        sp.sizeValue = Number(fieldOf(row, keyField));
        console.log(`  chart row updated: ${size}`);
      }
      continue;
    }
    config.sizePatterns.push({
      sizeName: size, sizeValue: Number(fieldOf(row, keyField)), baseMeasurements: lowerKeys(row),
      unitsPerInch: 25.4, keyframeGroups: [], seamEdges: [], foldAxes: [],
    });
    console.log(`  chart row added: ${size}`);
  }
  /* a config this script created is put in size order; one the designer built keeps the order they built it in */
  if (backup.createdConfigIds) config.sizePatterns.sort((a, b) => (Number(a.sizeValue) || 0) - (Number(b.sizeValue) || 0));
  config.markModified("sizePatterns");

  /* ── the product's measurement fields, only when it has none ── */
  if (!(item.measurements || []).length) {
    item.measurements = rec.chartFields;
    console.log(`  product measurement fields set: ${rec.chartFields.join(", ")}`);
  }

  const m = config.sizePatterns.find((p) => p.sizeName === master);
  console.log(`  master ${master}: ${m.basePaths.length} paths, ${m.keyframeGroups.length} groups, ${m.seamEdges.length} allowances, row ${JSON.stringify(m.baseMeasurements)}`);
  console.log(`  sizes now: ${config.sizePatterns.map((p) => `${p.sizeName}(${p.sizeValue ?? "-"}${(p.basePaths || []).length ? ",drawn" : ""})`).join(" ")}`);
  if (DRY) { console.log("  [dry run] nothing written"); await mongoose.disconnect(); return; }
  await item.save();
  await config.save();
  /* read it back: what the routes will serve is what was meant */
  const back = await PatternGradingConfig.findById(config._id).lean();
  const mb = back.sizePatterns.find((p) => p.sizeName === master);
  const lost = rec.groups.filter((g) => !mb.keyframeGroups.some((x) => x.groupId === g.groupId && x.measurementType === g.measurementType && x.multiplier === g.multiplier));
  console.log(`  saved. read back: ${mb.basePaths.length} paths, ${mb.keyframeGroups.length} groups (${lost.length} not as written), ${mb.seamEdges.length} allowances`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
