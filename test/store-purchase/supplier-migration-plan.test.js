// test/store-purchase/supplier-migration-plan.test.js
//
// What the supplier index migration DECIDES, without a database.
//
// The defect these pin was in the decision, not the driver: the script created
// indexes one at a time, so it could create the first, find the second blocked,
// and then print "Nothing was created." An operator acting on that sentence
// would have been wrong about the state of their database.
"use strict";

const { planIndexWork, INDEXES } = require("../../scripts/migrations/store-purchase-supplier-indexes.js");

const dupGroup = (companyId, value) => ({ _id: { companyId, value }, count: 2, ids: ["a", "b"], names: ["X", "Y"] });

describe("the migration plan", () => {
  test("a clean preview creates nothing and says what it would create", () => {
    const plan = planIndexWork({ indexes: INDEXES, present: [], duplicates: {}, flags: {} });
    expect(plan.mode).toBe("preview");
    expect(plan.writes).toBe(false);
    expect(plan.willCreate).toEqual(INDEXES.map((i) => i.name));
  });

  test("a clean apply creates every missing index", () => {
    const plan = planIndexWork({ indexes: INDEXES, present: [], duplicates: {}, flags: { apply: true } });
    expect(plan.mode).toBe("apply");
    expect(plan.writes).toBe(true);
    expect(plan.willCreate).toHaveLength(INDEXES.length);
  });

  test("a blocker on ONE index stops the whole run, not just that one", () => {
    /* The bug: the first index was created, then the second was found blocked,
       and the run reported creating nothing. */
    const plan = planIndexWork({
      indexes: INDEXES,
      present: [],
      duplicates: { gstNormalised: [dupGroup("c1", "29ABCDE1234F1Z5")] },
      flags: { apply: true },
    });
    expect(plan.mode).toBe("blocked");
    expect(plan.writes).toBe(false);
    expect(plan.willCreate).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0].identity).toBe("gstNormalised");
  });

  test("partial pre-existing state creates only what is missing", () => {
    const plan = planIndexWork({
      indexes: INDEXES,
      present: [INDEXES[0].name],
      duplicates: {},
      flags: { apply: true },
    });
    expect(plan.willCreate).toEqual([INDEXES[1].name]);
  });

  test("everything already present is a no-op, not a write", () => {
    const plan = planIndexWork({
      indexes: INDEXES, present: INDEXES.map((i) => i.name), duplicates: {}, flags: { apply: true },
    });
    expect(plan.willCreate).toEqual([]);
    expect(plan.writes).toBe(false);
  });

  test("rollback previews and applies under the same two-flag rule as creation", () => {
    const preview = planIndexWork({
      indexes: INDEXES, present: INDEXES.map((i) => i.name), duplicates: {}, flags: { rollback: true },
    });
    expect(preview.mode).toBe("rollback-preview");
    expect(preview.writes).toBe(false);
    expect(preview.willDrop).toHaveLength(INDEXES.length);

    const applied = planIndexWork({
      indexes: INDEXES, present: INDEXES.map((i) => i.name), duplicates: {},
      flags: { rollback: true, apply: true },
    });
    expect(applied.mode).toBe("rollback-apply");
    expect(applied.writes).toBe(true);
  });

  test("duplicates never block a rollback", () => {
    /* Dropping an index cannot fail because the data disagrees with it. */
    const plan = planIndexWork({
      indexes: INDEXES, present: INDEXES.map((i) => i.name),
      duplicates: { supplierCode: [dupGroup("c1", "SUP-1")] },
      flags: { rollback: true, apply: true },
    });
    expect(plan.mode).toBe("rollback-apply");
    expect(plan.blockers).toEqual([]);
  });
});

describe("the index definitions themselves", () => {
  test("every partial filter excludes legacy rows AND blank identities", () => {
    /* The filter was `{identity: {$gt: ""}}` alone while the comments claimed
       legacy records fell outside it. Two legacy suppliers sharing a code
       would have collided with each other — a uniqueness rule enforced across
       records that belong to nobody. */
    INDEXES.forEach((idx) => {
      const f = idx.options.partialFilterExpression;
      expect(f.companyId).toEqual({ $type: "objectId" });
      expect(f[idx.identity]).toEqual({ $gt: "" });
    });
  });

  test("both indexes are unique and company-scoped", () => {
    INDEXES.forEach((idx) => {
      expect(idx.options.unique).toBe(true);
      expect(Object.keys(idx.key)[0]).toBe("companyId");
    });
  });
});

/* ══ DEFINITION, NOT JUST NAME ═════════════════════════════════════════════ */

const { sameIndexDefinition, deriveNormalised } = require("../../scripts/migrations/store-purchase-supplier-indexes.js");

describe("an index is verified by what it is, not what it is called", () => {
  const wanted = INDEXES[0];

  test("a matching definition is recognised", () => {
    expect(sameIndexDefinition({
      name: wanted.name, key: wanted.key, unique: true,
      partialFilterExpression: wanted.options.partialFilterExpression,
    }, wanted)).toBe(true);
  });

  test("the same name with a different partial filter is NOT present", () => {
    /* Exactly the drift this repairs: the schema declared one filter and the
       migration another under one generated name. Trusting the name leaves
       the stale definition in place for good. */
    expect(sameIndexDefinition({
      name: wanted.name, key: wanted.key, unique: true,
      partialFilterExpression: { supplierCode: { $gt: "" } },   // no companyId
    }, wanted)).toBe(false);
  });

  test("reversed key order is a different index", () => {
    expect(sameIndexDefinition({
      name: wanted.name, key: { supplierCode: 1, companyId: 1 }, unique: true,
      partialFilterExpression: wanted.options.partialFilterExpression,
    }, wanted)).toBe(false);
  });

  test("a non-unique index of the same shape is not the one we mean", () => {
    expect(sameIndexDefinition({
      name: wanted.name, key: wanted.key, unique: false,
      partialFilterExpression: wanted.options.partialFilterExpression,
    }, wanted)).toBe(false);
  });

  test("a conflicting definition blocks the run rather than being skipped", () => {
    const plan = planIndexWork({
      indexes: INDEXES,
      present: INDEXES.map((i) => i.name),
      definitions: {
        [INDEXES[0].name]: {
          name: INDEXES[0].name, key: INDEXES[0].key, unique: true,
          partialFilterExpression: { supplierCode: { $gt: "" } },
        },
      },
      duplicates: {}, flags: { apply: true },
    });
    expect(plan.mode).toBe("conflict");
    expect(plan.writes).toBe(false);
    expect(plan.blockers[0].reason).toBe("DEFINITION_DIFFERS");
  });
});

describe("normalised keys are derived exactly as the model derives them", () => {
  test("whitespace and case are squashed, deterministically", () => {
    expect(deriveNormalised(" 29 abcde 1234 f1z5 ")).toBe("29ABCDE1234F1Z5");
    expect(deriveNormalised("29ABCDE1234F1Z5")).toBe("29ABCDE1234F1Z5");
    expect(deriveNormalised("")).toBe("");
    expect(deriveNormalised(null)).toBe("");
    expect(deriveNormalised(undefined)).toBe("");
  });

  test("it matches the model's own hook, so the preview predicts the index", async () => {
    /* If these ever diverge, the preview reports collisions the index will
       not hit, and misses ones it will. Saved through the real hook rather
       than reimplementing it here. */
    const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
    const doc = await Vendor.create({
      companyName: `Derive ${Date.now()}`, gstNumber: " 29 abcde 1234 f1z5 ",
    });
    const stored = await Vendor.findById(doc._id).lean();
    expect(deriveNormalised(stored.gstNumber)).toBe(stored.gstNormalised);
    expect(stored.gstNormalised).toBe("29ABCDE1234F1Z5");
  });
});

/* ══ THE EXECUTION PATH ACTUALLY USES THE CHECK ════════════════════════════ */

describe("the migration script wires its own verification in", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "scripts", "migrations", "store-purchase-supplier-indexes.js"),
    "utf8",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("it reads the real index documents, not just their names", () => {
    /* `sameIndexDefinition` existed and the execution path never called it:
       it asked `has(idx.name)` and reported "already present", so an index
       with the right name and wrong options passed as valid. */
    expect(code).toMatch(/const definitions = Object\.fromEntries\(existing\.map/);
    expect(code).toMatch(/sameIndexDefinition\(onDisk, idx\)/);
  });

  test("a differing definition blocks before any write", () => {
    expect(code).toMatch(/conflicts\.length/);
    /* The three things a blocked run must not have done. */
    expect(code).toMatch(/Nothing was created, dropped or backfilled/);
  });

  test("the stale no-backfill claim is gone", () => {
    /* The header said it never backfills; under --apply it does. */
    expect(src).not.toMatch(/It never backfills `gstNormalised`/);
    expect(src).toMatch(/it DOES backfill `gstNormalised`/);
  });

  test("preview is still the default and writes nothing", () => {
    expect(code).toMatch(/const apply = process\.argv\.includes\("--apply"\)/);
    const plan = planIndexWork({ indexes: INDEXES, present: [], duplicates: {}, flags: {} });
    expect(plan.writes).toBe(false);
  });
});

/* ══ CANONICAL COMPARISON AND TRUTHFUL REPORTING ═══════════════════════════ */

describe("index comparison is exact where it matters and tolerant where it does not", () => {
  const wanted = INDEXES[1];   // the gstNormalised index

  test("a partial filter written in a different key order still matches", () => {
    /* The server may return the filter's fields in any order. Comparing raw
       JSON made an identical filter look different and blocked a migration
       that had nothing wrong with it. */
    const reordered = {
      name: wanted.name, key: wanted.key, unique: true,
      partialFilterExpression: {
        gstNormalised: { $gt: "" },
        companyId: { $type: "objectId" },
      },
    };
    expect(sameIndexDefinition(reordered, wanted)).toBe(true);
  });

  test("but a genuinely different filter still does not match", () => {
    expect(sameIndexDefinition({
      name: wanted.name, key: wanted.key, unique: true,
      partialFilterExpression: { gstNormalised: { $gt: "" } },
    }, wanted)).toBe(false);
  });

  test("key order remains significant", () => {
    expect(sameIndexDefinition({
      name: wanted.name, key: { gstNormalised: 1, companyId: 1 }, unique: true,
      partialFilterExpression: wanted.options.partialFilterExpression,
    }, wanted)).toBe(false);
  });
});

describe("the script reports what it actually wrote", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "scripts", "migrations", "store-purchase-supplier-indexes.js"),
    "utf8",
  );

  test("execution consumes the planner rather than reasoning again", () => {
    /* Two implementations that merely agree today are one refactor away from
       disagreeing, and only one of them is under test. */
    expect(src).toMatch(/const decision = planIndexWork\(\{/);
  });

  test("a partial backfill reports its exact completed count", () => {
    expect(src).toMatch(/BACKFILL FAILED after \$\{backfilled\} of \$\{needsBackfill\.length\}/);
    expect(src).toMatch(/Re-running is safe/);
  });

  test("a later index failure still admits the backfill happened", () => {
    /* "Nothing was created or backfilled" after writing to N records is a
       sentence an operator would act on, and it would be false. */
    expect(src).toMatch(/The \$\{backfilled\} gstNormalised backfill\(s\) also REMAIN/);
  });

  test("the blocked paths remain write-free", () => {
    expect(src).toMatch(/No index was created or changed/);
    expect(src).toMatch(/Nothing was created, dropped or backfilled/);
  });
});
