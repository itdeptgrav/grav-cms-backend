/**
 * REFRESH A SANDBOX DESK BUNDLE FROM THE CURRENT PATTERN DATA.
 *
 *   node scripts/refreshSandboxBundle.js <sandboxBundle.json> [--write]
 *
 * The desk replays responses recorded when a work order was sent to cutting. That recording is a moment in time, so
 * a size whose groups were drawn afterwards reaches the cutting table with no groups at all — the pattern is handed
 * over at its base size and nothing tells anybody. This rewrites ONLY the size pattern inside a COPIED bundle from
 * what the database holds today, so the desk can be exercised against the current pattern without waiting for a
 * re-sync, and without touching the operator's own bundle.
 *
 * Atlas is READ ONLY here: find(), then disconnect. The only thing written is the sandbox file named on the command
 * line, and the script refuses to write to the desk's own data directory.
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const TARGET = path.resolve(process.argv[2] || "");
const WRITE = process.argv.includes("--write");
const live = path.join(process.env.APPDATA || "", "Grav CAD", "grav-cad");

if (!TARGET || !fs.existsSync(TARGET)) { console.error(`no such bundle: ${TARGET}`); process.exit(2); }
if (TARGET.toLowerCase().startsWith(path.resolve(live).toLowerCase())) {
  console.error("refusing to rewrite a bundle inside the desk's own data directory — copy it first");
  process.exit(2);
}

/**
 * What every group should end up at for one employee.
 *
 * This is the SAME derivation the cutting-master route does when it answers /cad-data — partKey (with a `__dup__`
 * prefix taken off), the employee's own measurement first, the size's own base measurement as a fallback, and the
 * group's ease carried through. It is duplicated here only because this script talks to the database rather than
 * to a running server; if the route's rule changes, this has to change with it.
 */
function groupTargets(sp, measurements) {
  const map = {};
  for (const m of measurements) {
    const v = parseFloat(m.value) || 0;
    map[m.measurementName] = v;
    map[String(m.measurementName).toLowerCase()] = v;
  }
  return (sp.keyframeGroups || []).map((group) => {
    const pKey = group.partKey;
    const clean = pKey?.startsWith("__dup__") ? pKey.slice(7) : pKey;
    const empVal = clean ? (map[clean] ?? map[String(clean).toLowerCase()] ?? null) : null;

    let fallback = null;
    if (empVal === null && clean && sp.baseMeasurements) {
      const bm = sp.baseMeasurements;
      const raw = bm[clean] ?? bm[String(clean).toLowerCase()]
        ?? bm[clean.charAt(0).toUpperCase() + clean.slice(1)] ?? null;
      if (raw !== null && raw !== undefined && raw !== "") fallback = parseFloat(raw);
    }
    const eff = empVal !== null ? empVal : fallback;

    const kfValues = (group.keyframes || []).map((k) => k.targetFullInches).filter((v) => v != null && !isNaN(v));
    const hasKeyframes = kfValues.length > 0;
    const baseVal = group.baseFullInches || 0;
    const mode = String(group.gradingMode || "").toLowerCase();
    const isRule = mode === "rule" || (mode !== "keyframe" && !!group.ruleProfile?.enabled && !hasKeyframes);
    const isParametric = mode === "parametric" || (!isRule && !hasKeyframes && mode !== "keyframe");

    return {
      groupClientId: group.groupId || group.clientId,
      groupName: group.groupName || group.name,
      partKey: pKey,
      assignedSize: group.assignedSize || sp.sizeName,
      multiplier: group.multiplier || 1,
      baseFullInches: baseVal,
      targetFullInches: eff !== null ? eff : baseVal,
      hasEmployeeData: eff !== null,
      employeeValue: eff,
      usedFallback: empVal === null && fallback !== null,
      fallbackSource: empVal === null && fallback !== null ? `Size ${sp.sizeName} default` : null,
      measurementOffset: Number(group.measurementOffset) || 0,
      hasKeyframes,
      keyframeCount: kfValues.length,
      gradingMode: isParametric ? "parametric" : isRule ? "rule" : "keyframe",
      gradingMin: hasKeyframes ? Math.min(baseVal, ...kfValues) : baseVal,
      gradingMax: hasKeyframes ? Math.max(baseVal, ...kfValues) : baseVal,
      gradingApplicable: true,
      gradingWarning: null,
    };
  });
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  require("../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js");
  const Model = mongoose.model(mongoose.modelNames().find((n) => /PatternGrading/i.test(n)));
  const docs = await Model.find({}).lean();
  await mongoose.disconnect();                                   /* nothing further touches the database */

  const bundle = JSON.parse(fs.readFileSync(TARGET, "utf8"));
  const product = bundle.workOrder?.stockItemName;
  const doc = docs.find((d) => String(d.stockItemName || "") === product);
  if (!doc) { console.error(`no pattern-grading document for "${product}"`); process.exit(2); }

  const bySize = new Map((doc.sizePatterns || []).map((s) => [String(s.sizeName), s]));
  console.log(`product: ${doc.stockItemName}`);
  console.log(`sizes in the database: ${[...bySize.entries()].map(([n, s]) => `${n}(${(s.keyframeGroups || []).length}g/${(s.basePaths || []).length}p)`).join("  ")}`);
  console.log("");

  /* the employees' own measurements, from the recording — the numbers the cutting side grades to */
  const empMeasures = new Map();
  for (const [url, res] of Object.entries(bundle.responses || {})) {
    if (!url.includes("/employee-measurements")) continue;
    for (const e of (res.body || res).employeeMeasurements || []) {
      empMeasures.set(String(e.employeeId), e.measurements || []);
    }
  }

  let changed = 0, same = 0, checked = 0;
  const checkFails = [];
  const seen = new Map();
  for (const [url, res] of Object.entries(bundle.responses || {})) {
    if (!url.includes("/cad-data")) continue;
    const body = res.body || res.json || res;
    const sp = body.selectedSizePattern;
    if (!sp?.sizeName) continue;
    const fresh = bySize.get(String(sp.sizeName));
    if (!fresh) continue;

    const before = { g: (sp.keyframeGroups || []).length, p: (sp.basePaths || []).length };
    const after = { g: (fresh.keyframeGroups || []).length, p: (fresh.basePaths || []).length };
    const key = sp.sizeName;
    if (!seen.has(key)) seen.set(key, { before, after, n: 0 });
    seen.get(key).n++;

    if (before.g === after.g && before.p === after.p) {
      /*
       * THIS SIZE IS ALREADY CURRENT, SO IT IS THE PROOF.
       *
       * Its targets were computed by the real server and recorded. Recomputing them here and comparing is the only
       * thing that says the derivation below is the server's derivation and not a plausible-looking imitation —
       * which matters, because the sizes that DO need refreshing have nothing to check them against.
       */
      const mine = groupTargets(fresh, empMeasures.get(String((url.match(/employee\/([^/]+)\/cad-data/) || [])[1])) || []);
      const theirs = body.computedGroupTargets || [];
      for (const t of theirs) {
        const m = mine.find((x) => String(x.groupClientId) === String(t.groupClientId));
        for (const field of ["targetFullInches", "hasEmployeeData", "employeeValue", "measurementOffset", "gradingMode"]) {
          const a = m ? m[field] : undefined;
          if (JSON.stringify(a) !== JSON.stringify(t[field])) {
            checkFails.push(`${sp.sizeName} ${t.groupName} ${field}: server ${JSON.stringify(t[field])} vs recomputed ${JSON.stringify(a)}`);
          }
        }
      }
      checked += theirs.length;
      same++;
      continue;
    }
    changed++;

    /* Only the size pattern is replaced. Everything else in the recorded response is what the server really said. */
    body.selectedSizePattern = JSON.parse(JSON.stringify(fresh));
    body.resolvedPaths = JSON.parse(JSON.stringify(fresh.basePaths || []));
    body.resolvedUpi = (body.resolvedPaths.length ? 25.4 : fresh.unitsPerInch || 25.4);

    const empId = (url.match(/employee\/([^/]+)\/cad-data/) || [])[1];
    body.computedGroupTargets = groupTargets(fresh, empMeasures.get(String(empId)) || []);
  }

  console.log("  " + "size".padEnd(8) + "employees".padStart(10) + "groups before".padStart(15) + "groups now".padStart(12)
    + "paths before".padStart(14) + "paths now".padStart(11));
  for (const [size, v] of [...seen.entries()].sort()) {
    console.log("  " + size.padEnd(8) + String(v.n).padStart(10) + String(v.before.g).padStart(15) + String(v.after.g).padStart(12)
      + String(v.before.p).padStart(14) + String(v.after.p).padStart(11)
      + (v.before.g === v.after.g && v.before.p === v.after.p ? "" : "   refreshed"));
  }
  console.log(`\n${changed} response(s) refreshed, ${same} already current`);

  /* The derivation used for the refreshed sizes, checked against the real server's own answer on the current ones. */
  if (checked) {
    console.log(checkFails.length
      ? `\nSELF-CHECK FAILED: ${checkFails.length} of ${checked} recomputed targets differ from what the server recorded:\n  `
        + [...new Set(checkFails)].slice(0, 20).join("\n  ")
      : `\nself-check: all ${checked} recomputed targets match what the real server recorded for the unchanged sizes`);
    if (checkFails.length) process.exit(3);
  }

  if (!WRITE) { console.log("\nDRY RUN — pass --write to update the sandbox bundle\n"); return; }
  fs.writeFileSync(TARGET, JSON.stringify(bundle));
  console.log(`\nwritten: ${TARGET}\n`);
})().catch(async (e) => {
  console.error("refresh failed:", e.message);
  try { await mongoose.disconnect(); } catch { }
  process.exit(2);
});
