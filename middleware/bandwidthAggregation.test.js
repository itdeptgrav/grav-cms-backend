// middleware/bandwidthAggregation.test.js
//
// The parts of the bandwidth meter that are pure arithmetic or pure schema, and
// so can be pinned without a database.
//
// The `$inc` casting test is the one that matters most in practice: the
// histogram, status and content-type counters are Mongoose `Map` fields written
// with dotted update paths (`buckets.b12`). If Mongoose refuses to cast one of
// those, every flush fails - and it fails inside a catch that only logs, so the
// dashboard would sit at zero forever with nothing but one line in the Render
// log to say why. Casting is schema-only, so it can be checked offline.
//
//   npm test

const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");

const bw = require("./bandwidthTracker");
const Sample = require("../models/BandwidthSample");

test("percentiles from log2 histograms", async (t) => {
  await t.test("returns 0 for an empty histogram", () => {
    assert.strictEqual(bw.percentileFrom({}, "b", 0.95), 0);
    assert.strictEqual(bw.percentileFrom(undefined, "b", 0.5), 0);
  });

  await t.test("ignores buckets belonging to the other prefix", () => {
    // b* is size, l* is latency. Mixing them would silently report latency
    // percentiles in bytes.
    const h = { b10: 100, l3: 9999 };
    const p = bw.percentileFrom(h, "b", 0.5);
    assert.ok(p >= 1023 && p <= 2047, `p50 ${p} should sit in bucket 10`);
  });

  await t.test("separates a cheap majority from an expensive tail", () => {
    // 90 calls around 1 KB, 10 calls around 8 MB. The mean is ~800 KB and
    // describes neither group. p50 has to land in the cheap bucket and p99 in
    // the expensive one - that gap is the whole reason histograms are stored
    // rather than averages.
    //
    // The tail has to be more than 1% of calls for p99 to reach it: with a
    // single 8 MB call in 100, the 99th ordered value really is 1 KB, and
    // reporting otherwise would be wrong rather than useful. Reach for
    // `maxBytes` when the question is "how bad did it ever get".
    const h = { b10: 90, b23: 10 };
    const p50 = bw.percentileFrom(h, "b", 0.5);
    const p99 = bw.percentileFrom(h, "b", 0.99);
    assert.ok(p50 >= 1023 && p50 <= 2047, `p50 ${p50}`);
    assert.ok(p99 > 4 * 1024 * 1024, `p99 ${p99} should reach the 8 MB bucket`);
  });

  await t.test("is monotonic across p50 -> p95 -> p99", () => {
    const h = { b8: 50, b12: 30, b16: 15, b20: 5 };
    const [a, b, c] = [0.5, 0.95, 0.99].map((p) => bw.percentileFrom(h, "b", p));
    assert.ok(a <= b && b <= c, `${a} <= ${b} <= ${c}`);
  });
});

test("histogramOf trims empty tails but keeps interior gaps", () => {
  const h = { b5: 3, b9: 1 };
  const out = bw.histogramOf(h, "b", bw.BYTE_BUCKETS);
  assert.strictEqual(out.length, 5, "buckets 5..9 inclusive");
  assert.strictEqual(out[0].count, 3);
  assert.strictEqual(out[4].count, 1);
  // The zeroes between are real observations - dropping them would compress the
  // x-axis and make two very different sizes look adjacent.
  assert.deepStrictEqual(out.slice(1, 4).map((b) => b.count), [0, 0, 0]);
});

test("log2 bucketing is bounded at both ends", () => {
  const { log2bucket } = bw._internals;
  assert.strictEqual(log2bucket(0, bw.BYTE_BUCKETS), 0);
  assert.strictEqual(log2bucket(-5, bw.BYTE_BUCKETS), 0);
  // A 2 GB response must not write a bucket key the schema has no room for.
  assert.strictEqual(log2bucket(2 ** 31, bw.BYTE_BUCKETS), bw.BYTE_BUCKETS - 1);
});

test("duplicate hashing distinguishes changed payloads", () => {
  const { fnv1a } = bw._internals;
  assert.strictEqual(fnv1a('{"a":1}'), fnv1a('{"a":1}'));
  assert.notStrictEqual(fnv1a('{"a":1}'), fnv1a('{"a":2}'));
  // Ordering matters: two lists with the same members but a different order are
  // a real change from the client's point of view.
  assert.notStrictEqual(fnv1a("[1,2]"), fnv1a("[2,1]"));
});

test("the flush update casts against the schema", async (t) => {
  // Exactly the shape startFlusher() builds.
  const update = {
    $setOnInsert: { hour: new Date(), scope: "route", key: "GET /x" },
    $inc: {
      calls: 3,
      bytesOut: 4096,
      dupBytes: 1024,
      "buckets.b12": 2,
      "buckets.l7": 2,
      "statuses.c2xx": 2,
      "statuses.c304": 1,
      "types.json": 4096,
      "types.ev:tracking-data-updated": 12,
    },
    $max: { maxMs: 812, maxBytes: 90210 },
  };

  await t.test("every dotted Map path is accepted", () => {
    const q = Sample.updateOne({ hour: new Date(), scope: "route", key: "GET /x" }, update);
    assert.doesNotThrow(() => q.cast(Sample));
  });

  await t.test("the scope enum still admits all four scopes", () => {
    for (const scope of ["route", "outbound", "consumer", "socket"]) {
      const q = Sample.updateOne({ scope }, { $setOnInsert: { scope } });
      assert.doesNotThrow(() => q.cast(Sample), scope);
    }
  });

  await t.test("peaks are declared, so $max has something to write to", () => {
    for (const f of bw.PEAKS) {
      assert.ok(Sample.schema.path(f), `${f} is missing from the schema`);
    }
  });

  await t.test("every scalar the tracker counts exists on the schema", () => {
    // A counter present in the tracker but absent here would be dropped at
    // flush time under strict mode, and nothing would say so.
    for (const f of bw.SCALARS) {
      assert.ok(Sample.schema.path(f), `${f} is missing from BandwidthSample`);
    }
    for (const f of bw.BAGS) {
      assert.ok(Sample.schema.path(f), `${f} is missing from BandwidthSample`);
    }
  });
});

test.after(() => mongoose.connection.close().catch(() => {}));
