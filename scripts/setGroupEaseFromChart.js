/**
 * GIVE EVERY GROUP THE EASE ITS PATTERN ALREADY HAS
 * =================================================
 * A measurement group says which body measurement drives it — `partKey` — but a
 * pattern piece does not measure the body. A neck hole drawn at 18" is driven by
 * a 15" collar; a front panel carries a button placket; a length reference may
 * span only part of the garment.
 *
 * That difference is `measurementOffset`, and the grading engine adds it to
 * whatever the employee measures:
 *
 *     target = employeeValue + measurementOffset
 *
 * Left at zero, a 15 1/2" collar asks an 18" neck hole to come in by two and a
 * half inches. The engine now refuses that rather than flattening the curve into
 * a straight line, but the real fix is the ease, and the pattern already knows
 * it: the designer declared what this size IS in `baseMeasurements`, and the
 * geometry says what it MEASURES. The difference between those two is the ease.
 *
 *     measurementOffset = whatTheGroupMeasures - whatTheChartDeclares
 *
 * Nothing is invented here. Both numbers come from the saved pattern.
 *
 *   node scripts/setGroupEaseFromChart.js --stock <id>            (dry run)
 *   node scripts/setGroupEaseFromChart.js --stock <id> --apply
 *   node scripts/setGroupEaseFromChart.js --stock <id> --reset    (back to zero)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { pathToFileURL } = require("node:url");

const UPI = 25.4;
const DEFAULT_STOCK = "69bbcb3d1c32e4f8d5b30a46"; // Executive to Managers Shirt
const MEASURE_MODULE = "C:/Users/soumy/Desktop/grav-cms/lib/patternMeasure.js";

function parseArgs(argv) {
  const args = { stock: DEFAULT_STOCK, apply: false, reset: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--reset") args.reset = true;
    else if (argv[i] === "--stock") args.stock = argv[++i];
  }
  return args;
}

/** The chart value for a part, however the designer capitalised it. */
function declaredFor(baseMeasurements, partKey) {
  const bm = baseMeasurements || {};
  const key = String(partKey || "");
  if (!key || key.startsWith("__custom__")) return null;
  const v = bm[key]
    ?? bm[key.toLowerCase()]
    ?? bm[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const args = parseArgs(process.argv);
  const { measureGroupInches } = await import(pathToFileURL(MEASURE_MODULE).href);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const stockItemId = new mongoose.Types.ObjectId(args.stock);
  const stockItem = await db.collection("stockitems").findOne({ _id: stockItemId });
  const config = await db.collection("patterngradingconfigs")
    .findOne({ stockItemId, isActive: true }, { sort: { updatedAt: -1 } });
  if (!config) throw new Error(`No active pattern config for stock item ${args.stock}`);

  console.log(`Product : ${stockItem?.name}`);
  console.log(`Mode    : ${args.reset ? "RESET every ease to zero"
    : args.apply ? "APPLY" : "dry run — nothing will be written"}\n`);

  let changed = 0;
  for (const sp of config.sizePatterns || []) {
    const groups = sp.keyframeGroups || [];
    if (!groups.length) continue;
    console.log(`${sp.sizeName}`);
    const next = groups.map((g) => ({ ...g }));

    for (const g of next) {
      const drawn = measureGroupInches(sp.basePaths || [], g, UPI);
      const declared = declaredFor(sp.baseMeasurements, g.partKey);
      const was = Number(g.measurementOffset) || 0;

      if (args.reset) {
        g.measurementOffset = 0;
        console.log(`  ${String(g.groupName || g.name).padEnd(15)} ease ${was.toFixed(3)}" -> 0.000"`);
        if (was !== 0) changed += 1;
        continue;
      }

      if (declared === null || !Number.isFinite(drawn)) {
        console.log(
          `  ${String(g.groupName || g.name).padEnd(15)} `
          + `no chart entry for "${g.partKey}" — left at ${was.toFixed(3)}"`,
        );
        continue;
      }

      const ease = Number((drawn - declared).toFixed(4));
      g.measurementOffset = ease;
      const note = Math.abs(ease - was) > 0.0005 ? "  <== changed" : "";
      console.log(
        `  ${String(g.groupName || g.name).padEnd(15)} `
        + `measures ${drawn.toFixed(3)}"  chart says ${declared.toFixed(3)}"  `
        + `ease ${was.toFixed(3)}" -> ${(ease >= 0 ? "+" : "")}${ease.toFixed(3)}"${note}`,
      );
      if (Math.abs(ease - was) > 0.0005) changed += 1;
    }

    if (args.apply || args.reset) {
      await db.collection("patterngradingconfigs").updateOne(
        { _id: config._id, "sizePatterns.sizeName": sp.sizeName },
        { $set: { "sizePatterns.$.keyframeGroups": next } },
      );
    }
  }

  console.log(
    `\n${changed} group${changed === 1 ? "" : "s"} `
    + `${args.apply || args.reset ? "updated" : "would change"}.`,
  );
  if (!args.apply && !args.reset) console.log("Re-run with --apply to write them.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
