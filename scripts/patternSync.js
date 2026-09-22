/**
 * PATTERN SYNC — is what the CAD authored what the database holds and the website will show?
 *
 *   node scripts/patternSync.js                                  every size of the default product
 *   node scripts/patternSync.js "Executive to Managers Shirt" XS,M
 *   node scripts/patternSync.js "…" XS --verbose                 every group, not just the problems
 *
 * Answers in seconds what used to take an afternoon of comparing screenshots: for each measurement it prints the
 * canonical stored value, the value recomputed from the geometry through the SHARED pattern-core, the binding that
 * was authored, and whether they agree. A disagreement is reported, never corrected — the stored value is what the
 * authoring application measured, and a consumer that quietly substitutes its own answer is how the CAD and the
 * website came to disagree in the first place.
 *
 * READ-ONLY. Opens the connection, reads, closes. No save, no update, no index build.
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const PRODUCT = process.argv[2] || "Executive to Managers Shirt";
const SIZES = (process.argv[3] && !process.argv[3].startsWith("--")) ? process.argv[3].split(",") : null;
const VERBOSE = process.argv.includes("--verbose");

const CORE = "file:///" + path.resolve(
  "C:/Users/soumy/Desktop/grav-cad-desktop/packages/pattern-core/index.js"
).replace(/\\/g, "/");

const f = (v, n = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : "—");
const pad = (s, n) => String(s ?? "—").padEnd(n);
const RED = (s) => `\u001b[31m${s}\u001b[0m`;
const GREEN = (s) => `\u001b[32m${s}\u001b[0m`;
const DIM = (s) => `\u001b[2m${s}\u001b[0m`;
const YELLOW = (s) => `[33m${s}[0m`;

(async () => {
  const core = await import(CORE);
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  require("../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js");
  const Model = mongoose.model(mongoose.modelNames().find((n) => /PatternGrading/i.test(n)));

  const docs = await Model.find({}).lean();
  const doc = docs.find((d) => String(d.stockItemName || "") === PRODUCT)
    || docs.find((d) => JSON.stringify(d).includes(PRODUCT));
  if (!doc) { console.error(`no pattern-grading document for "${PRODUCT}"`); await mongoose.disconnect(); process.exit(2); }

  const sizes = (doc.sizePatterns || []).filter((s) => !SIZES || SIZES.includes(s.sizeName));
  console.log("\nPATTERN SYNC");
  console.log("=".repeat(96));
  console.log(`Product:          ${doc.stockItemName}   (${doc.stockItemReference || "no reference"})`);
  console.log(`Contract version: pattern-core ${core.CONTRACT_VERSION}`);
  console.log(`Sizes:            ${(doc.sizePatterns || []).map((s) => s.sizeName).join(", ")}`);
  console.log("=".repeat(96));

  let problems = 0;
  for (const sp of sizes) {
    const v = core.verifySize(sp);
    const conns = (sp.basePaths || []).filter((p) => p.isConnector).length;
    console.log(`\nSIZE ${sp.sizeName}`);
    console.log("-".repeat(96));
    console.log(`  drawing        ${sp.originalFilename || "—"}   ${sp.bytes ?? "—"} bytes`);
    console.log(`  svgRevision    ${sp.svgRevision ?? DIM("not stored")}        svgChecksum  ${sp.svgChecksum ?? DIM("not stored")}`);
    console.log(`  contract       ${sp.contractVersion ?? DIM("not stored")}`);
    console.log(`  geometry       ${(sp.basePaths || []).length} paths (${conns} connectors), ${sp.unitsPerInch || 25.4} units/inch`);
    console.log(`  groups         ${(sp.keyframeGroups || []).length}`);
    const c = v.counts;
    console.log(`  status         ${GREEN((c.ok || 0) + " ok")}   ${(c.mismatch || 0) ? RED((c.mismatch) + " MISMATCH") : "0 mismatch"}`
      + `   ${(c.adrift || 0) ? RED((c.adrift) + " ADRIFT") : "0 adrift"}`
      + `   ${(c.unauthored || 0) ? YELLOW((c.unauthored) + " unauthored") : "0 unauthored"}   ${c.ungeometried || 0} no-geometry`);

    const rows = VERBOSE ? v.rows : v.rows.filter((r) => !r.ok);
    if (rows.length) {
      console.log("\n  " + pad("measurement", 30) + pad("stored", 10) + pad("recomputed", 12) + pad("binding", 17) + "status");
      console.log("  " + "-".repeat(84));
      for (const r of rows) {
        const status = r.ok ? GREEN("ok")
          : r.status === "adrift" ? RED(`ADRIFT  stored ${f(r.stored)}" vs geometry ${f(r.recomputed)}"`)
            : r.status === "unauthored" ? YELLOW("unauthored — no meaning recorded")
            : r.status === "ungeometried" ? RED("no geometry")
              : RED(`MISMATCH  ${f(r.diff)}"`);
        console.log("  " + pad(r.name, 30) + pad(f(r.stored), 10) + pad(f(r.recomputed), 12)
          + pad(r.binding || DIM("none"), r.binding ? 17 : 25) + status);
      }
    }
    /* the full report, for anything that actually disagrees rather than merely being unauthored */
    for (const r of v.rows.filter((x) => x.status === "mismatch" || x.status === "adrift")) {
      problems++;
      console.log("\n" + core.mismatchReport(doc.stockItemName, sp.sizeName, r, {
        revision: sp.svgRevision, checksum: sp.svgChecksum,
      }).split("\n").map((l) => "  " + l).join("\n"));
    }
  }

  console.log("\n" + "=".repeat(96));
  console.log(problems ? RED(`${problems} group(s) where the stored value and the geometry already disagree`) : GREEN("no value disagreements"));
  console.log("A group shown as UNAUTHORED still has no measurementType stored: its value is whatever the geometry");
  console.log("suggested, not what anyone declared. Those are what the migration exists to fix.\n");

  await mongoose.disconnect();
  process.exit(problems ? 1 : 0);
})().catch(async (e) => {
  console.error("pattern sync failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(2);
});
