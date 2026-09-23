// test/merchandising/costing-boundary.test.js
//
// MERCHANDISING PUBLISHES; COSTING CONSUMES. THE ARROW POINTS ONE WAY.
//
// Merchandising and Sales may publish approved material-selection identities
// for Costing to read. They may not import Central Costing — not a model, not
// a policy, not a calculation engine, not a service. The rule is not stylistic:
// the import that used to exist put a costing policy, a decimal library and a
// calculation engine into the load graph of two services whose whole job is to
// say which fabric was chosen, and it made a Merchandising checkpoint
// impossible to stand up without Costing's files beside it.
//
// Three things are pinned here.
//
//   1  NO EDGE. No Merchandising, PPC, integration or Sales-development file
//      imports Central Costing. The one exception is named, and it is a
//      lazy, guarded require inside the integration seam — the whole point of
//      which is that nothing above it loads Costing to start up.
//
//   2  THE SEAM FAILS SOFT. A deployment without Central Costing answers "no
//      charges configured", which is true, rather than failing to boot.
//
//   3  THE PUBLISHED CONTRACT IS IDENTITY AND PROVENANCE. Only an approved
//      revision is published; it carries stable source and revision
//      references; and it carries nothing Costing owns.
//
// The behavioural half of (3) — what Sales sees at each stage, and the exact
// forbidden-field list — is exercised end to end in
// `preorder-development.route.test.js`. This suite pins the CONTRACT and the
// EDGE, which no behavioural test can see.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");

/** Source with comments blanked — these files EXPLAIN the rule they follow. */
const bare = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every `.js` under a directory, recursively. */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/* Every surface this lane owns. `services/sales` is filtered to the
   Merchandising-facing services: the rest of that directory is the Costing
   lane's and is not this rule's business. */
const SALES_OWNED = new Set([
  "changeNotice.service.js", "developmentRequest.service.js",
  "handoverAuthority.js", "handoverContract.js",
  "merchandisingHandover.service.js", "packagingBom.service.js",
]);

const OWNED = [
  ...walk(path.join(root, "services/merchandising")),
  ...walk(path.join(root, "services/ppc")),
  ...walk(path.join(root, "services/integration")),
  ...walk(path.join(root, "routes/CMS_Routes/Merchandising")),
  ...walk(path.join(root, "routes/CMS_Routes/PPC")),
  ...walk(path.join(root, "models/CMS_Models/Merchandising")),
  ...walk(path.join(root, "models/CMS_Models/PPC")),
  ...walk(path.join(root, "services/sales")).filter((p) => SALES_OWNED.has(path.basename(p))),
  ...walk(path.join(root, "test/merchandising")),
].filter((p) => fs.existsSync(p));

/* The ONE file allowed to name Central Costing, and only through a guarded,
   lazy require. It is the seam that exists so nobody else has to. */
const SEAM = path.join(root, "services/integration/developmentChargeCatalog.service.js");

/* Files this lane does not own that happen to live in its directories.
   Releasing approved demand into procurement is a concurrent lane's feature —
   its service, its models, its routes and its suites. It is excluded from the
   Merchandising checkpoint, and whether IT may import Costing is that lane's
   decision to defend, not this rule's business.

   Matched on the feature, not on the two filenames it had when this was
   written: that lane is actively adding files, and a pattern naming today's
   set would quietly stop covering tomorrow's. */
const NOT_OURS = /demand-release|demandRelease|DemandRelease/;

/* ══ 1 — NO EDGE ══════════════════════════════════════════════════════════ */

describe("no Merchandising-owned file imports Central Costing", () => {
  const offenders = [];
  for (const file of OWNED) {
    if (file === SEAM || NOT_OURS.test(file)) continue;
    const src = bare(fs.readFileSync(file, "utf8"));
    const hits = [
      ...src.matchAll(/require\(\s*["'][^"']*centralCosting\/[^"']*["']\s*\)/g),
      ...src.matchAll(/require\(\s*["'][^"']*Costing\/CostingPolicy["']\s*\)/g),
      ...src.matchAll(/require\(\s*["'][^"']*Costing\/[A-Za-z]+["']\s*\)/g),
    ].map((m) => m[0]);
    if (hits.length) offenders.push(`${path.relative(root, file)}: ${hits[0]}`);
  }

  test("not one of them requires a costing module", () => {
    expect(offenders).toEqual([]);
  });

  test("and the rule covers a real surface, not an empty list", () => {
    /* A scan that found no files would also find no offenders. */
    expect(OWNED.length).toBeGreaterThan(60);
  });
});

describe("the one permitted seam is lazy and guarded", () => {
  const src = fs.readFileSync(SEAM, "utf8");
  const code = bare(src);

  test("it names Costing exactly once", () => {
    expect((code.match(/centralCosting\//g) || []).length).toBe(1);
  });

  test("the require is INSIDE a function, not at module scope", () => {
    /* At module scope it would be the very dependency this file removes. */
    const moduleScope = code.split(/function\s+costingPolicy/)[0];
    expect(moduleScope).not.toMatch(/centralCosting/);
    expect(code).toMatch(/function costingPolicy\(\)[\s\S]*?try\s*\{[\s\S]*?require\(/);
  });

  test("a missing Costing application is an answer, not a crash", () => {
    expect(code).toMatch(/catch\s*\{[\s\S]*?return null;/);
  });
});

/* ══ 2 — THE SEAM FAILS SOFT ══════════════════════════════════════════════ */

describe("Merchandising works when Costing is not deployed", () => {
  const seam = require("../../services/integration/developmentChargeCatalog.service");

  test("an unresolvable company yields an empty catalogue, never null", async () => {
    const out = await seam.catalogueFor("000000000000000000000000");
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });

  test("it reports whether Costing is present rather than pretending", () => {
    expect(typeof seam.costingAvailable()).toBe("boolean");
  });

  test("the styleDevelopment service loads without any costing module", () => {
    /* The load itself is the assertion: before this lane, requiring it pulled
       in a policy, an engine and a decimal library. */
    const mod = require("../../services/merchandising/styleDevelopment.service");
    expect(typeof mod.configuredCharges).toBe("function");
  });

  test("so does the Sales handover producer", () => {
    const mod = require("../../services/sales/merchandisingHandover.service");
    expect(typeof mod.issue).toBe("function");
  });
});

/* ══ 3 — THE PUBLISHED CONTRACT ═══════════════════════════════════════════ */

describe("what Merchandising publishes for Costing to consume", () => {
  const pub = require("../../services/merchandising/developmentPublication.service");
  const {
    BOM_STATE, LIFECYCLE, RECEIPT_STATE,
  } = require("../../models/CMS_Models/Merchandising/Development");

  const file = {
    developmentNumber: "MDV-2026-0001",
    lifecycleStatus: LIFECYCLE.APPROVED,
    releasedToRndAt: null,
  };
  const row = {
    rowRef: "DR-aaaaaaaaaaaa", category: "FABRIC",
    rawItemName: "Navy pique 220gsm", rawItemSku: "PQ-220",
    colourOrShade: "Navy", finish: "Enzyme wash", placement: "Body",
    /* Facts other departments own, present on the source row and expected
       NOT to cross. */
    quantity: 4, consumption: 1.2, rate: 320, supplier: "Mill A",
  };
  const approved = { state: BOM_STATE.APPROVED, revisionNo: 3, rows: [row] };
  const draft = { state: BOM_STATE.DRAFT, revisionNo: 4, rows: [row] };
  const receipt = { state: RECEIPT_STATE.ACCEPTED, decidedBy: { name: "Approver" } };

  test("only an APPROVED revision is published", () => {
    const out = pub.project(file, receipt, [draft]);
    expect(out.approvedRevisionNo).toBeNull();
    expect(out.selectedMaterials).toEqual([]);
    /* A draft is Merchandising still working. Publishing one would let a
       reader quote a fabric nobody has agreed to. */
    expect(out.workingState).toBe(BOM_STATE.DRAFT);
  });

  test("an approved revision is published with its stable references", () => {
    const out = pub.project(file, receipt, [approved]);
    /* The source record and the revision, so a consumer can say exactly what
       it costed against and prove it later. */
    expect(out.developmentNumber).toBe("MDV-2026-0001");
    expect(out.approvedRevisionNo).toBe(3);
    expect(out.selectedMaterials).toHaveLength(1);
  });

  test("a superseded revision is not published as approved", () => {
    const superseded = { ...approved, state: BOM_STATE.SUPERSEDED };
    const out = pub.project(file, receipt, [superseded]);
    expect(out.approvedRevisionNo).toBeNull();
    expect(out.selectedMaterials).toEqual([]);
  });

  test("the newest approved revision wins when there are several", () => {
    const older = { state: BOM_STATE.APPROVED, revisionNo: 1, rows: [row] };
    const out = pub.project(file, receipt, [approved, older]);
    expect(out.approvedRevisionNo).toBe(3);
  });

  test("no field Costing, R&D, Supply Chain or Store owns crosses", () => {
    const [published] = pub.project(file, receipt, [approved]).selectedMaterials;
    for (const forbidden of [
      "quantity", "consumption", "unit", "allowance", "wastage",
      "rate", "unitCost", "totalCost", "price", "amount", "currency",
      "supplier", "supplierId", "purchaseOrder", "stock", "sampleResult",
    ]) {
      expect(published).not.toHaveProperty(forbidden);
    }
  });

  test("and no handle a consumer could act on", () => {
    const out = pub.project(file, receipt, [approved]);
    const [published] = out.selectedMaterials;
    for (const forbidden of ["developmentFileId", "fileId", "id", "_id", "revisionId"]) {
      expect(out).not.toHaveProperty(forbidden);
      expect(published).not.toHaveProperty(forbidden);
    }
    /* Not even the row's own reference: it is Merchandising's addressing, and
       a consumer holding one would be holding a handle on a draft. */
    expect(published).not.toHaveProperty("rowRef");
  });

  test("the payload is identity and provenance, and both are complete", () => {
    const [published] = pub.project(file, receipt, [approved]).selectedMaterials;
    expect(Object.keys(published).sort()).toEqual([
      "appliesTo", "category", "colourOrShade", "finish", "name", "placement", "reference",
    ]);
  });

  test("Costing can consume it without Merchandising knowing how", () => {
    /* The publication module names no consumer and imports nothing of
       Costing's. What Costing does with the contract is Costing's half, and
       this file could not tell you what that is. */
    const src = bare(fs.readFileSync(
      path.join(root, "services/merchandising/developmentPublication.service.js"), "utf8"));
    expect(src).not.toMatch(/centralCosting|CostingPolicy|costing/i);
    /* And it is a read: there is no write anywhere in it. */
    for (const write of [/\.create\(/, /\.save\(/, /findOneAndUpdate/, /updateOne/,
      /deleteOne/, /bulkWrite/, /startSession/]) {
      expect(src).not.toMatch(write);
    }
  });
});

/* ══ 4 — THE ADOPTION LINK SURVIVES ═══════════════════════════════════════ */

describe("the confirmed-order adoption link is unchanged by this correction", () => {
  const adoption = require("../../services/merchandising/developmentAdoption.service");

  test("the resolver and the recorded reference both still exist", () => {
    expect(typeof adoption.resolveDevelopmentFor).toBe("function");
    expect(typeof adoption.preview).toBe("function");
    expect(typeof adoption.adopt).toBe("function");
  });

  test("adoption imports nothing of Costing's either", () => {
    const src = bare(fs.readFileSync(
      path.join(root, "services/merchandising/developmentAdoption.service.js"), "utf8"));
    expect(src).not.toMatch(/centralCosting|CostingPolicy/);
  });

  test("the execution file still carries the reference the link is made of", () => {
    const src = fs.readFileSync(
      path.join(root, "models/CMS_Models/Merchandising/ExecutionFile.js"), "utf8");
    expect(src).toMatch(/developmentReference/);
    expect(src).toMatch(/bomRevisionNo/);
  });
});
