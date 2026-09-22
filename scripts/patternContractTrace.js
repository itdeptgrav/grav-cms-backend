/**
 * PHASE 0 — READ-ONLY end-to-end trace of the real pattern contract.
 *
 * Connects to the project's own database through the project's own Mongoose model, reads the real size patterns for
 * one product, and prints every field that the Desktop authors and the Website consumes — then measures every group
 * three ways so the exact point of divergence is visible:
 *
 *   stored      what the Desktop saved as the group's value (baseFullInches)
 *   declared    what the shared measuring code returns when the group's own binding is honoured
 *   auto        what the old "auto" rule returns, which is what the Website did before the binding was ported
 *
 * WRITES NOTHING. No save(), no updateOne(), no index build. It opens the connection, reads, and closes.
 */
const path = require("path");
require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const PRODUCT = process.argv[2] || "Executive to Managers Shirt";
const SIZES = (process.argv[3] || "XS,M").split(",");

const f = (v, n = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : String(v ?? "—"));
const pad = (s, n) => String(s ?? "—").padEnd(n);

(async () => {
  const measure = await import(
    "file:///" + path.resolve("C:/Users/soumy/Desktop/grav-cad-desktop/renderer/src/cad/patternMeasure.js").replace(/\\/g, "/")
  );
  const binding = await import(
    "file:///" + path.resolve("C:/Users/soumy/Desktop/grav-cad-desktop/renderer/src/grading/measurementBinding.js").replace(/\\/g, "/")
  );

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log("connected (read-only use)\n");

  require("../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js");
  const names = mongoose.modelNames();
  const Model = mongoose.model(names.find((n) => /PatternGrading/i.test(n)) || names[0]);
  console.log("model:", Model.modelName, "| collection:", Model.collection.name, "\n");

  /* find the product's config without assuming the field name */
  const all = await Model.find({}).lean();
  console.log("pattern-grading documents in the collection:", all.length);
  const doc = all.find((d) => JSON.stringify(d).includes(PRODUCT))
    || all.find((d) => (d.sizePatterns || []).length);
  if (!doc) { console.log("no document matched", PRODUCT); await mongoose.disconnect(); return; }

  console.log("document _id:", String(doc._id));
  for (const k of Object.keys(doc)) {
    if (["sizePatterns", "__v", "_id"].includes(k)) continue;
    const v = doc[k];
    if (v && typeof v === "object") continue;
    console.log("  ", pad(k, 28), String(v).slice(0, 80));
  }
  console.log("  ", pad("sizePatterns", 28), (doc.sizePatterns || []).map((s) => s.sizeName).join(", "));
  console.log();

  for (const size of SIZES) {
    const sp = (doc.sizePatterns || []).find((s) => String(s.sizeName) === size);
    console.log("=".repeat(110));
    console.log("SIZE", size);
    console.log("=".repeat(110));
    if (!sp) { console.log("  not present\n"); continue; }

    console.log("-- size-pattern scalar fields as stored --");
    for (const k of Object.keys(sp)) {
      const v = sp[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const n = Array.isArray(v) ? `[${v.length}]` : "{…}";
        console.log("  ", pad(k, 28), n);
        continue;
      }
      console.log("  ", pad(k, 28), String(v).slice(0, 90));
    }
    console.log("   baseMeasurements:", JSON.stringify(sp.baseMeasurements || {}));

    const paths = sp.basePaths || [];
    const upi = sp.unitsPerInch || 25.4;
    const pieces = paths.filter((p) => !p.isConnector);
    const conns = paths.filter((p) => p.isConnector);
    console.log(`   basePaths: ${paths.length} (${pieces.length} pieces, ${conns.length} connectors), unitsPerInch ${upi}`);
    conns.forEach((c, i) => {
      console.log(`     connector ${i}: from p${c.connectorFrom?.pi}s${c.connectorFrom?.si} -> p${c.connectorTo?.pi}s${c.connectorTo?.si}`);
    });

    const groups = sp.keyframeGroups || [];
    console.log(`\n-- ${groups.length} groups, measured three ways --\n`);
    console.log("  " + pad("name", 24) + pad("refs", 11) + pad("mult", 7) + pad("STORED", 9) + pad("AUTO", 9)
      + pad("measMode", 10) + pad("CLASSIFIED", 11) + pad("storedMode", 9) + pad("binding", 15) + "=stored?");
    console.log("  " + "-".repeat(118));

    const rows = [];
    for (const g of groups) {
      const mult = Number(g.multiplier) || 1;
      const refs = g.ref1 && g.ref2 ? `${g.ref1.pathIdx}:${g.ref1.segIdx}>${g.ref2.pathIdx}:${g.ref2.segIdx}` : "—";
      let declared = NaN, auto = NaN, classified = NaN, cls = null;
      try {
        const args = measure.groupMeasureArgs(g);
        declared = measure.shortestMeasurement(paths, upi, g.ref1, g.ref2, args.mode, args.traversal).dist / upi * mult;
        auto = measure.shortestMeasurement(paths, upi, g.ref1, g.ref2, "auto").dist / upi * mult;
        /* what classifyBinding decides, and whether that binding reproduces the stored value */
        cls = binding.classifyBinding(paths, g, upi);
        if (cls) {
          const cg = { ...g, measurementType: cls.measurementType, boundaryTraversal: cls.boundaryTraversal };
          const ca = measure.groupMeasureArgs(cg);
          classified = measure.shortestMeasurement(paths, upi, g.ref1, g.ref2, ca.mode, ca.traversal).dist / upi * mult;
        }
      } catch (e) { /* geometry missing */ }
      const stored = Number(g.baseFullInches);
      rows.push({ g, stored, declared, auto, classified, cls, mult, refs });
      const ok = Number.isFinite(stored) && Number.isFinite(classified) && Math.abs(stored - classified) <= 0.02;
      console.log("  " + pad(g.groupName || g.name, 24) + pad(refs, 11) + pad(mult, 7)
        + pad(f(stored), 9) + pad(f(auto), 9) + pad(f(declared), 10) + pad(f(classified), 11)
        + pad(g.measureMode || "—", 9) + pad(cls ? cls.measurementType : "UNCLASSIFIED", 15) + (ok ? "OK" : "**"));
    }

    /* the point of the exercise: where does the authored value stop agreeing? */
    const TOL = 0.02;
    const bad = rows.filter((r) => Number.isFinite(r.stored) && Number.isFinite(r.auto) && Math.abs(r.stored - r.auto) > TOL);
    const okDeclared = rows.filter((r) => Number.isFinite(r.stored) && Number.isFinite(r.declared) && Math.abs(r.stored - r.declared) <= TOL);
    console.log(`\n  groups whose STORED value disagrees with AUTO (what the website used to do): ${bad.length}`);
    for (const r of bad) {
      console.log(`    ${pad(r.g.groupName || r.g.name, 26)} stored ${f(r.stored)}  auto ${f(r.auto)}  diff ${f(r.stored - r.auto)}`);
    }
    console.log(`  groups whose STORED value agrees with DECLARED: ${okDeclared.length} of ${rows.length}`);

    /* which fields the Desktop can send that are not in the stored document at all */
    const seen = new Set();
    groups.forEach((g) => Object.keys(g).forEach((k) => seen.add(k)));
    console.log("\n  keys actually present on stored groups:", [...seen].sort().join(", "));
    console.log();
  }

  await mongoose.disconnect();
  console.log("disconnected");
})().catch(async (e) => {
  console.error("TRACE FAILED:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
