// test/project-manager/work-order-number-migration.test.js
//
// Chunk 4A.2 corrections. The backfill's policy, exercised against the
// isolated in-memory database — never a live one.
//
// The script itself is administrative and defaults to a dry run. What is tested
// here is the policy that makes it safe to run at all:
//
//   • one definition of "numberless" (string, non-empty after trimming);
//   • whitespace-only records are numberless, NOT duplicate identities;
//   • real duplicate identities block apply;
//   • a canonical target already owned elsewhere blocks apply BEFORE any write;
//   • a concurrent assignment is preserved and reported as skipped, never as
//     written — because the write log IS the rollback list, and a rollback that
//     unsets a number this migration never assigned destroys someone else's
//     work.
"use strict";

const mongoose = require("mongoose");
const { canonicalNumber, NUMBERLESS, report, apply } =
  require("../../scripts/migrations/work-order-number-backfill");

const coll = () => mongoose.connection.collection("workorders");
const oid = () => new mongoose.Types.ObjectId();

/** Insert straight through the driver, bypassing the model invariant. */
const put = (doc) => coll().insertOne({ quantity: 1, ...doc });

/** Silence the script's console output for the duration of one call. */
async function quiet(fn) {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

/* ═══ 1 · CLASSIFICATION ══════════════════════════════════════════════════ */

describe("what counts as numberless", () => {
  test("missing, null, empty and whitespace-only all count", async () => {
    await put({ _id: oid() });                              // missing
    await put({ _id: oid(), workOrderNumber: null });        // null
    await put({ _id: oid(), workOrderNumber: "" });          // empty
    await put({ _id: oid(), workOrderNumber: "   " });       // whitespace
    await put({ _id: oid(), workOrderNumber: "\t\n " });     // other whitespace
    await put({ _id: oid(), workOrderNumber: "WO-REAL-1" }); // a real identity

    const summary = await quiet(() => report(coll()));
    expect(summary.total).toBe(6);
    expect(summary.numberless).toBe(5);
  });

  test("a non-string value is numberless too", async () => {
    await put({ _id: oid(), workOrderNumber: 12345 });
    const summary = await quiet(() => report(coll()));
    expect(summary.numberless).toBe(1);
  });

  test("the selector and the report agree", async () => {
    await put({ _id: oid() });
    await put({ _id: oid(), workOrderNumber: "  " });
    await put({ _id: oid(), workOrderNumber: "WO-REAL-1" });

    const viaSelector = await coll().countDocuments(NUMBERLESS);
    const viaReport = (await quiet(() => report(coll()))).numberless;
    expect(viaSelector).toBe(2);
    expect(viaReport).toBe(2);
  });
});

  test("reporting writes nothing — the dry-run path", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) { const id = oid(); ids.push(id); await put({ _id: id }); }
    await put({ _id: oid(), workOrderNumber: "WO-KEEP" });

    const before = await coll().find({}).sort({ _id: 1 }).toArray();
    await quiet(() => report(coll()));
    const after = await coll().find({}).sort({ _id: 1 }).toArray();

    expect(after).toEqual(before);
    for (const id of ids) {
      expect((await coll().findOne({ _id: id })).workOrderNumber).toBeUndefined();
    }
  });

/* ═══ 2 · DUPLICATES ══════════════════════════════════════════════════════ */

describe("duplicate reporting", () => {
  test("whitespace-only records are not duplicate identities", async () => {
    // The defect: they used to be grouped as one duplicate "  " identity,
    // which both misreported them and blocked their own backfill.
    await put({ _id: oid(), workOrderNumber: "   " });
    await put({ _id: oid(), workOrderNumber: "   " });
    await put({ _id: oid(), workOrderNumber: "" });
    await put({ _id: oid(), workOrderNumber: null });

    const summary = await quiet(() => report(coll()));
    expect(summary.duplicates).toBe(0);
    expect(summary.numberless).toBe(4);
  });

  test("whitespace-only records are still backfilled", async () => {
    const a = oid(), b = oid();
    await put({ _id: a, workOrderNumber: "   " });
    await put({ _id: b, workOrderNumber: "  " });

    await quiet(() => apply(coll()));

    expect((await coll().findOne({ _id: a })).workOrderNumber).toBe(canonicalNumber(a));
    expect((await coll().findOne({ _id: b })).workOrderNumber).toBe(canonicalNumber(b));
  });

  test("real duplicate identities are reported", async () => {
    await put({ _id: oid(), workOrderNumber: "WO-DUP" });
    await put({ _id: oid(), workOrderNumber: "WO-DUP" });
    await put({ _id: oid(), workOrderNumber: "WO-UNIQUE" });

    const summary = await quiet(() => report(coll()));
    expect(summary.duplicates).toBe(1);
  });
});

/* ═══ 3 · TARGET COLLISION PRE-CHECK ══════════════════════════════════════ */

describe("canonical target collisions", () => {
  test("a target already owned by another document is detected", async () => {
    const numberless = oid();
    await put({ _id: numberless });
    // A DIFFERENT document already holding the exact string this one wants.
    await put({ _id: oid(), workOrderNumber: canonicalNumber(numberless) });

    const summary = await quiet(() => report(coll()));
    expect(summary.conflicts).toBe(1);
  });

  test("a record already holding its OWN canonical number is not a conflict", async () => {
    const id = oid();
    await put({ _id: id, workOrderNumber: canonicalNumber(id) });
    await put({ _id: oid() });

    const summary = await quiet(() => report(coll()));
    expect(summary.conflicts).toBe(0);
  });

  test("the check runs even when the unique index is absent", async () => {
    // The index is what WOULD catch this. Its absence is the reason the script
    // exists, so the pre-check cannot depend on it.
    const indexes = await coll().indexes();
    expect(indexes.some((i) => i.key?.workOrderNumber === 1 && i.unique)).toBe(false);

    const numberless = oid();
    await put({ _id: numberless });
    await put({ _id: oid(), workOrderNumber: canonicalNumber(numberless) });

    expect((await quiet(() => report(coll()))).conflicts).toBe(1);
  });

  test("the conflicting target and both document ids are reported", async () => {
    const numberless = oid(), owner = oid();
    await put({ _id: numberless });
    await put({ _id: owner, workOrderNumber: canonicalNumber(numberless) });

    const lines = [];
    const log = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await report(coll()); } finally { console.log = log; }

    const line = lines.find((l) => l.includes("CONFLICT"));
    expect(line).toContain(canonicalNumber(numberless));
    expect(line).toContain(String(owner));
    expect(line).toContain(String(numberless));
  });
});

/* ═══ 4 · CONCURRENCY AND THE WRITE LOG ═══════════════════════════════════ */

describe("the write log is exact", () => {
  test("a concurrent assignment is preserved and reported as skipped", async () => {
    // THE DEFECT: every candidate used to be logged as "wrote", including ones
    // whose conditional update matched nothing.
    const raced = oid(), normal = oid();
    await put({ _id: raced });
    await put({ _id: normal });

    // Somebody else numbers `raced` between the read and the write.
    const originalFind = coll().find.bind(coll());
    const c = coll();
    let numbered = false;
    c.find = (...args) => {
      const cursor = originalFind(...args);
      const originalToArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const docs = await originalToArray();
        if (!numbered) {
          numbered = true;
          await c.updateOne({ _id: raced }, { $set: { workOrderNumber: "WO-SOMEONE-ELSE" } });
        }
        return docs;
      };
      return cursor;
    };

    let result;
    try { result = await quiet(() => apply(c)); } finally { c.find = originalFind; }

    // The other writer's value survives untouched.
    expect((await coll().findOne({ _id: raced })).workOrderNumber).toBe("WO-SOMEONE-ELSE");

    // …and it is reported as skipped, NOT as written.
    expect(result.skipped.map(String)).toContain(String(raced));
    expect(result.written.map((w) => String(w.id))).not.toContain(String(raced));
    // The record that was genuinely ours is written.
    expect(result.written.map((w) => String(w.id))).toContain(String(normal));
  });

  test("only successfully modified ids appear in the write log", async () => {
    const a = oid(), b = oid();
    await put({ _id: a });
    await put({ _id: b, workOrderNumber: "WO-ALREADY" });

    const result = await quiet(() => apply(coll()));

    expect(result.written.map((w) => String(w.id))).toEqual([String(a)]);
    expect(result.written[0].number).toBe(canonicalNumber(a));
    // The numbered record was never a candidate at all.
    expect(result.examined).toBe(1);
  });

  test("exact totals are returned for examined, written, skipped and failed", async () => {
    for (let i = 0; i < 3; i++) await put({ _id: oid() });
    const result = await quiet(() => apply(coll()));

    expect(result.examined).toBe(3);
    expect(result.written).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

  test("each candidate is examined exactly once, even when a batch mixes outcomes", async () => {
    /* THE DEFECT: the loop re-selected "the first N numberless records" every
       time. A FAILED record stays numberless, so it reappeared in the next
       query and was examined, logged and counted again — for as long as its
       batch-mates kept succeeding. `examined` and `failed` were wrong for any
       mixed batch. Paging on `_id > lastId` advances past every candidate once. */
    const ids = [oid(), oid(), oid()].sort((a, b) => (String(a) < String(b) ? -1 : 1));
    const [first, second, third] = ids;
    for (const id of ids) await put({ _id: id });

    const c = coll();
    const realFind = c.find.bind(c);
    const realUpdate = c.updateOne.bind(c);

    /* `second` is numbered by somebody else AFTER it has been read into a
       batch but BEFORE its own update runs — the only window in which it is a
       genuine "skipped", rather than simply never being a candidate. */
    let raced = false;
    c.find = (...args) => {
      const cursor = realFind(...args);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = async () => {
        const docs = await toArray();
        if (!raced && docs.some((d) => String(d._id) === String(second))) {
          raced = true;
          await realUpdate({ _id: second }, { $set: { workOrderNumber: "WO-SOMEONE-ELSE" } });
        }
        return docs;
      };
      return cursor;
    };
    // `third` always throws.
    c.updateOne = async (filter, update) => {
      if (String(filter._id) === String(third)) throw new Error("simulated write failure");
      return realUpdate(filter, update);
    };

    let result;
    try {
      // batchSize 1 forces multiple pages — the configuration under which the
      // old loop revisited the failed record.
      result = await quiet(() => apply(c, { batchSize: 1 }));
    } finally {
      c.find = realFind;
      c.updateOne = realUpdate;
    }

    // Exactly one outcome each, and the totals reconcile.
    expect(result.examined).toBe(3);
    expect(result.written.map((w) => String(w.id))).toEqual([String(first)]);
    expect(result.skipped.map(String)).toEqual([String(second)]);
    expect(result.failed.map((f) => String(f.id))).toEqual([String(third)]);
    expect(result.examined).toBe(
      result.written.length + result.skipped.length + result.failed.length);

    // Mutually exclusive, and every candidate appears once across all three.
    const seen = [
      ...result.written.map((w) => String(w.id)),
      ...result.skipped.map(String),
      ...result.failed.map((f) => String(f.id)),
    ];
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(ids.map(String).sort());

    // The failed record was NOT retried during this invocation.
    expect(result.failed).toHaveLength(1);
    // …and its state is untouched, so a later invocation can retry it.
    expect((await coll().findOne({ _id: third })).workOrderNumber).toBeUndefined();
    // The concurrent writer's value survived.
    expect((await coll().findOne({ _id: second })).workOrderNumber).toBe("WO-SOMEONE-ELSE");
  });

  test("a later invocation retries a record that failed earlier", async () => {
    const good = oid(), flaky = oid();
    await put({ _id: good });
    await put({ _id: flaky });

    const c = coll();
    const realUpdate = c.updateOne.bind(c);
    c.updateOne = async (filter, update) => {
      if (String(filter._id) === String(flaky)) throw new Error("transient");
      return realUpdate(filter, update);
    };
    let first;
    try { first = await quiet(() => apply(c, { batchSize: 1 })); }
    finally { c.updateOne = realUpdate; }

    expect(first.failed).toHaveLength(1);
    expect(first.written).toHaveLength(1);

    // Second invocation, no fault injected.
    const second = await quiet(() => apply(coll(), { batchSize: 1 }));
    expect(second.examined).toBe(1);
    expect(second.written.map((w) => String(w.id))).toEqual([String(flaky)]);
    expect((await coll().findOne({ _id: flaky })).workOrderNumber).toBe(canonicalNumber(flaky));
  });

  test("many candidates across many pages are each examined once", async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) { const id = oid(); ids.push(id); await put({ _id: id }); }

    const result = await quiet(() => apply(coll(), { batchSize: 5 }));

    expect(result.examined).toBe(12);
    expect(result.written).toHaveLength(12);
    expect(new Set(result.written.map((w) => String(w.id))).size).toBe(12);
    for (const id of ids) {
      expect((await coll().findOne({ _id: id })).workOrderNumber).toBe(canonicalNumber(id));
    }
  });

/* ═══ 5 · IDEMPOTENCE AND PRESERVATION ════════════════════════════════════ */

describe("restart and preservation", () => {
  test("a rerun after a successful pass writes nothing", async () => {
    for (let i = 0; i < 4; i++) await put({ _id: oid() });

    const first = await quiet(() => apply(coll()));
    expect(first.written).toHaveLength(4);

    const second = await quiet(() => apply(coll()));
    expect(second.examined).toBe(0);
    expect(second.written).toHaveLength(0);
  });

  test("a restart after a partial pass only processes what is still numberless", async () => {
    const done = oid(), todo = oid();
    await put({ _id: done, workOrderNumber: canonicalNumber(done) });   // as if a prior pass wrote it
    await put({ _id: todo });

    const result = await quiet(() => apply(coll()));

    expect(result.examined).toBe(1);
    expect(result.written.map((w) => String(w.id))).toEqual([String(todo)]);
    expect((await coll().findOne({ _id: done })).workOrderNumber).toBe(canonicalNumber(done));
  });

  test("explicitly numbered records stay byte-identical", async () => {
    const kept = [
      "WO-2026-000123", "LEGACY/77", "WO-abcd1234", "  padded-but-real  ",
    ];
    const ids = [];
    for (const n of kept) { const id = oid(); ids.push(id); await put({ _id: id, workOrderNumber: n }); }
    await put({ _id: oid() });

    await quiet(() => apply(coll()));

    for (let i = 0; i < kept.length; i++) {
      expect((await coll().findOne({ _id: ids[i] })).workOrderNumber).toBe(kept[i]);
    }
  });

  test("the script neither creates nor removes the unique index", async () => {
    const before = (await coll().indexes()).map((i) => i.name).sort();
    await put({ _id: oid() });
    await quiet(() => report(coll()));
    await quiet(() => apply(coll()));
    const after = (await coll().indexes()).map((i) => i.name).sort();

    expect(after).toEqual(before);
  });
});

/* ═══ 6 · THE SCRIPT CANNOT RUN BY ACCIDENT ═══════════════════════════════ */

describe("invocation guards", () => {
  const { readFileSync } = require("fs");
  const source = readFileSync(
    require.resolve("../../scripts/migrations/work-order-number-backfill.js"), "utf8");

  test("apply mode requires an explicit --apply flag", () => {
    expect(source).toContain('const APPLY = process.argv.includes("--apply")');
    expect(source).toContain("if (!APPLY)");
    expect(source).toContain("DRY RUN");
  });

  test("a missing MONGODB_URI is refused rather than guessed", () => {
    expect(source).toContain("MONGODB_URI is not set. Refusing to guess a database.");
  });

  test("the quiesced-writer deployment warning is present and cannot vanish silently", () => {
    // Correction 3. The conditional candidate update does NOT close the
    // cross-document target race: it proves only that the CANDIDATE is still
    // numberless, not that another document has not claimed its target since
    // the pre-flight report. Without a unique index nothing prevents that, so
    // the requirement for a quiesced window has to stay visible in the source.
    expect(source).toContain("NEITHER CLOSES THE CROSS-DOCUMENT TARGET RACE");
    expect(source).toContain("QUIESCED");
    expect(source).toMatch(/unique index/i);
    // And it is printed at apply time, where an operator will see it.
    const main = source.slice(source.indexOf("async function main()"));
    expect(main).toContain("QUIESCED-WRITER WINDOW REQUIRED");
    expect(main.indexOf("QUIESCED-WRITER WINDOW REQUIRED")).toBeLessThan(main.indexOf("await apply(coll)"));
  });

  test("the two protections are described as separate, and neither is overclaimed", () => {
    expect(source).toContain("PRE-FLIGHT COLLISION DETECTION");
    expect(source).toContain("PER-CANDIDATE CONCURRENCY GUARD");
    // The post-run re-report is detection, not prevention.
    expect(source).toMatch(/detection and rollback guidance — not prevention/i);
  });

  test("apply is refused before any write when duplicates or conflicts exist", () => {
    // Both checks sit in main() ahead of the apply() call.
    const main = source.slice(source.indexOf("async function main()"));
    const dupIdx = main.indexOf("summary.duplicates > 0");
    const conflictIdx = main.indexOf("summary.conflicts > 0");
    const applyIdx = main.indexOf("await apply(coll)");

    expect(dupIdx).toBeGreaterThan(-1);
    expect(conflictIdx).toBeGreaterThan(-1);
    expect(dupIdx).toBeLessThan(applyIdx);
    expect(conflictIdx).toBeLessThan(applyIdx);
  });
});
