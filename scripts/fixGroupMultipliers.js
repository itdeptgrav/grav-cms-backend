/**
 * MAKE EACH GROUP'S MULTIPLIER TELL THE TRUTH
 * ===========================================
 * A group's `multiplier` says how many times this piece's span makes up the
 * whole garment measurement. A half front is a quarter of the body girth, so
 * its chest group is x4 — and for a chest that is exactly right.
 *
 * It is NOT right for a neck hole. x4 says the back neck arc is the same length
 * as the front's. It is not: a back neck is shallow and a front neck is scooped.
 * On this shirt the front arc is 4.4987" and the collar is 15", so the front is
 * 30% of the neck, not 25%. Left at x4 the group reported an 18" neck for a 15"
 * collar, and the three inches had to be papered over with an "ease" that was
 * really just the wrong multiplier.
 *
 *     multiplier = what the size chart declares / what the master measures
 *
 * Both numbers come from the designer's own saved pattern. Nothing is chosen.
 *
 * Only groups whose `partKey` has a chart entry can be checked; a group whose
 * multiplier already agrees with the chart is left exactly as it is.
 *
 *   node scripts/fixGroupMultipliers.js --stock <id>            (dry run)
 *   node scripts/fixGroupMultipliers.js --stock <id> --apply
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { pathToFileURL } = require("node:url");

const UPI = 25.4;
const DEFAULT_STOCK = "69bbcb3d1c32e4f8d5b30a46"; // Executive to Managers Shirt
const MEASURE_MODULE = "C:/Users/soumy/Desktop/grav-cms/lib/patternMeasure.js";

/* A multiplier only moves when the chart and the geometry disagree by more than
   this. Below it the difference is drafting tolerance, not a wrong multiplier. */
const MEANINGFUL_INCHES = 0.25;

function parseArgs(argv) {
  const args = { stock: DEFAULT_STOCK, apply: false, only: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--stock") args.stock = argv[++i];
    /* --only BackShoulder,BackNeck : touch just these groups. A group whose
       chart mismatch is the DESIGN (a back drawn narrower than the front)
       must keep its multiplier, so the choice is made by name, not by number. */
    else if (argv[i] === "--only") args.only = new Set(String(argv[++i]).split(",").map((x) => x.trim()));
  }
  return args;
}

function declaredFor(baseMeasurements, partKey) {
  const bm = baseMeasurements || {};
  /* A `__dup__` group is a second reading of the same chart entry (the
     back's chest is still the chest); a `__custom__` one has no entry. */
  const key = String(partKey || "").replace(/^__dup__/, "");
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
  console.log(`Mode    : ${args.apply ? "APPLY" : "dry run — nothing will be written"}\n`);

  let changed = 0;
  for (const sp of config.sizePatterns || []) {
    const groups = sp.keyframeGroups || [];
    if (!groups.length) continue;
    console.log(sp.sizeName);
    const next = groups.map((g) => ({ ...g }));

    for (const g of next) {
      const declared = declaredFor(sp.baseMeasurements, g.partKey);
      const mult = Math.max(0.01, Number(g.multiplier) || 1);
      const raw = measureGroupInches(sp.basePaths || [], g, UPI) / mult;
      const name = String(g.groupName || g.name).padEnd(15);

      if (args.only && !args.only.has(String(g.groupName || g.name))) {
        console.log(`  ${name} not in --only, left at x${mult}`);
        continue;
      }
      if (declared === null || !Number.isFinite(raw) || raw <= 0) {
        console.log(`  ${name} no chart entry for "${g.partKey}" — left at x${mult}`);
        continue;
      }
      const reports = raw * mult;
      if (Math.abs(reports - declared) <= MEANINGFUL_INCHES) {
        console.log(
          `  ${name} x${String(mult).padEnd(6)} reports ${reports.toFixed(3)}"  `
          + `chart ${declared.toFixed(3)}"  — agrees, left alone`,
        );
        continue;
      }
      const wanted = Number((declared / raw).toFixed(4));
      console.log(
        `  ${name} x${String(mult).padEnd(6)} reports ${reports.toFixed(3)}"  `
        + `chart ${declared.toFixed(3)}"  ->  x${wanted}  (reports `
        + `${(raw * wanted).toFixed(3)}")   <== changed`,
      );
      g.multiplier = wanted;
      changed += 1;
    }

    /*
     * `baseFullInches` is what this group measures on the master, so it has to
     * be recomputed whenever the multiplier changes — the engine reads it to
     * work out how far a request is from the master, and a stale one would put
     * every grade out by the amount the multiplier moved.
     */
    for (const g of next) {
      if (args.only && !args.only.has(String(g.groupName || g.name))) continue;
      const fresh = measureGroupInches(sp.basePaths || [], g, UPI);
      if (!Number.isFinite(fresh)) continue;
      const rounded = Number(fresh.toFixed(4));
      if (Math.abs(rounded - (Number(g.baseFullInches) || 0)) > 0.0005) {
        console.log(
          `  ${String(g.groupName || g.name).padEnd(15)} base `
          + `${Number(g.baseFullInches || 0).toFixed(3)}" -> ${rounded.toFixed(3)}"`,
        );
        g.baseFullInches = rounded;
        if (Math.abs(Number(g.targetFullInches) || 0) > 0) g.targetFullInches = rounded;
      }
    }

    if (args.apply) {
      await db.collection("patterngradingconfigs").updateOne(
        { _id: config._id, "sizePatterns.sizeName": sp.sizeName },
        { $set: { "sizePatterns.$.keyframeGroups": next } },
      );
    }
  }

  console.log(
    `\n${changed} multiplier${changed === 1 ? "" : "s"} `
    + `${args.apply ? "updated" : "would change"}.`,
  );
  if (!args.apply) console.log("Re-run with --apply to write them.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
